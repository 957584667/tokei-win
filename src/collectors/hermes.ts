/**
 * Hermes 采集器：对应 usage.30s.py 的 scan_hermes / _scan_hermes_db / _hermes_db_paths。
 * SQLite: ~/.hermes/state.db 与 ~/.hermes/profiles 下各 profile 的 state.db
 * （TOKEI_HERMES_DIR 可覆盖根目录）。
 *
 * 口径（CALCULATION.md §2 Hermes / §Hermes 成本）：
 * - 字段独立，与 Claude 一致：input/output/cache_read/cache_write/reasoning 直接取列。
 * - 优先读主用量表；0.19(v22) 升级中断会保留 session_model_usage_v21，两张都读，
 *   按 会话+模型+计费端点(provider/base_url/mode)+任务 去重、保留 token 总量更大的行。
 * - 主循环(task 为空)明细存在时不再回退 sessions 汇总；缺失才用汇总行兜底。
 * - 成本优先 actual_cost_usd → estimated_cost_usd → 0（0 时 recalcCosts 按价表估算）。
 * - 会话数只统计 sessions 表可见行。
 * 历史账本已接 ledger_reconcile：库行被清后用 ~/.tokei/ledger.json 的日快照回补。
 */
import * as path from "path";
import { HOME, absoluteProjectPath, expandPath, isDirectory, isFile } from "../core/paths";
import { listDirs } from "../core/fsutil";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey } from "../core/ranges";
import { ledgerReconcile, ledgerTouch } from "../core/ledger";
import { modelIdentityId } from "../core/price";
import {
  HermesRangeOut, ModelUsage, PROJECT_BUCKETS_VERSION, ProjectBucket, addModelUsage,
  addProjectUsage, hermesRange,
} from "../core/model";
import { openReadonly, sqliteSignature } from "./zcode";

const HERMES_SCAN_VERSION = 2;

export interface HermesDay {
  in: number; out: number; cr: number; cw: number; reason: number;
  cost: number; sessions: number; models: Record<string, ModelUsage>; hours: number[];
  projects?: Record<string, ProjectBucket>;
}

export interface HermesScanResult {
  ranges: Record<RangeKey, HermesRangeOut>;
}

function num(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function int(v: unknown): number {
  return Math.max(Math.trunc(num(v)), 0);
}
function tokenTotalOf(row: Record<string, unknown>): number {
  return int(row.input_tokens) + int(row.output_tokens) + int(row.cache_read_tokens)
    + int(row.cache_write_tokens) + int(row.reasoning_tokens);
}

/** 对应 _hermes_db_paths */
export function hermesDbPaths(): string[] {
  const base = expandPath(process.env.TOKEI_HERMES_DIR) || path.join(HOME, ".hermes");
  const paths: string[] = [];
  const main = path.join(base, "state.db");
  if (isFile(main)) paths.push(main);
  const profiles = path.join(base, "profiles");
  if (isDirectory(profiles)) {
    for (const dir of listDirs(profiles)) {
      const db = path.join(dir, "state.db");
      if (isFile(db)) paths.push(db);
    }
  }
  return paths;
}

/** 列缺失时用字面量兜底，对应内层 expr() */
function columnsOf(conn: ReturnType<typeof openReadonly>, table: string): Set<string> {
  const set = new Set<string>();
  try {
    for (const row of conn.prepare(`PRAGMA table_info("${table}")`).all() as Array<Record<string, any>>) {
      set.add(String(row.name));
    }
  } catch { /* 表不存在 */ }
  return set;
}

function pick(cols: Set<string>, alias: string, name: string, fallback = "0"): string {
  return cols.has(name) ? `${alias}."${name}"` : fallback;
}

/** 对应 _scan_hermes_db() */
export function scanHermesDb(dbPath: string): Record<string, HermesDay> {
  const days: Record<string, HermesDay> = {};
  let conn: ReturnType<typeof openReadonly>;
  try {
    conn = openReadonly(dbPath);
  } catch {
    return days;
  }
  try {
    const tables = new Set((conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<Record<string, any>>).map((r) => String(r.name)));
    if (!tables.has("sessions")) return days;

    // 1) sessions 汇总表
    const sessionCols = columnsOf(conn, "sessions");
    const sessionRows = conn.prepare(`
      SELECT s.id AS session_id,
             ${pick(sessionCols, "s", "started_at")} AS started_at,
             ${pick(sessionCols, "s", "model", "''")} AS model,
             ${pick(sessionCols, "s", "cwd", "''")} AS cwd,
             ${pick(sessionCols, "s", "input_tokens")} AS input_tokens,
             ${pick(sessionCols, "s", "output_tokens")} AS output_tokens,
             ${pick(sessionCols, "s", "cache_read_tokens")} AS cache_read_tokens,
             ${pick(sessionCols, "s", "cache_write_tokens")} AS cache_write_tokens,
             ${pick(sessionCols, "s", "reasoning_tokens")} AS reasoning_tokens,
             ${pick(sessionCols, "s", "estimated_cost_usd")} AS estimated_cost_usd,
             ${pick(sessionCols, "s", "actual_cost_usd", "NULL")} AS actual_cost_usd
      FROM sessions s
    `).all() as Array<Record<string, any>>;
    const sessions = new Map<string, Record<string, any>>();
    for (const row of sessionRows) sessions.set(String(row.session_id), row);

    // 2) 明细表：v21（升级中断遗留）先读，新表后读；同键保留更大行
    const usageRows = new Map<string, Record<string, any>>();
    for (const table of ["session_model_usage_v21", "session_model_usage"]) {
      if (!tables.has(table)) continue;
      const cols = columnsOf(conn, table);
      if (!cols.has("session_id")) continue;
      const rows = conn.prepare(`
        SELECT u.session_id AS session_id,
               ${pick(cols, "u", "model", "''")} AS model,
               ${pick(cols, "u", "billing_provider", "''")} AS billing_provider,
               ${pick(cols, "u", "billing_base_url", "''")} AS billing_base_url,
               ${pick(cols, "u", "billing_mode", "''")} AS billing_mode,
               ${pick(cols, "u", "task", "''")} AS task,
               ${pick(cols, "u", "input_tokens")} AS input_tokens,
               ${pick(cols, "u", "output_tokens")} AS output_tokens,
               ${pick(cols, "u", "cache_read_tokens")} AS cache_read_tokens,
               ${pick(cols, "u", "cache_write_tokens")} AS cache_write_tokens,
               ${pick(cols, "u", "reasoning_tokens")} AS reasoning_tokens,
               ${pick(cols, "u", "estimated_cost_usd")} AS estimated_cost_usd,
               ${pick(cols, "u", "actual_cost_usd", "NULL")} AS actual_cost_usd,
               ${pick(cols, "u", "first_seen", "NULL")} AS first_seen,
               ${pick(cols, "u", "last_seen", "NULL")} AS last_seen
        FROM "${table}" u
      `).all() as Array<Record<string, any>>;
      for (const item of rows) {
        const key = ["session_id", "model", "billing_provider", "billing_base_url", "billing_mode", "task"]
          .map((name) => String(item[name] ?? "")).join("\u0000");
        const previous = usageRows.get(key);
        if (previous && tokenTotalOf(previous) > tokenTotalOf(item)) continue;
        usageRows.set(key, item);
      }
    }

    const records: Array<Record<string, any>> = [...usageRows.values()];
    // 主循环明细（task 为空）已覆盖的会话不再回退汇总，避免 v22 双计
    const mainUsageSessions = new Set<string>(
      records.filter((r) => !String(r.task ?? "")).map((r) => String(r.session_id)));
    for (const [sessionId, session] of sessions) {
      if (mainUsageSessions.has(sessionId)) continue;
      records.push({ ...session, task: "", first_seen: session.started_at, last_seen: session.started_at });
    }

    const rowCost = (row: Record<string, any>): number =>
      row.actual_cost_usd !== null && row.actual_cost_usd !== undefined
        ? num(row.actual_cost_usd) : num(row.estimated_cost_usd);

    // 明细行全无成本时，把汇总成本挂到主循环行上（优先同模型）
    const bySession = new Map<string, Array<Record<string, any>>>();
    for (const row of records) {
      const key = String(row.session_id ?? "");
      const list = bySession.get(key) ?? [];
      list.push(row);
      bySession.set(key, list);
    }
    for (const [sessionId, sessionRecords] of bySession) {
      const session = sessions.get(sessionId);
      if (!session || sessionRecords.some((row) => rowCost(row))) continue;
      const fallbackCost = rowCost(session);
      if (!fallbackCost) continue;
      const mainRecords = sessionRecords.filter((row) => !String(row.task ?? ""));
      if (!mainRecords.length) continue;
      const target = mainRecords.find((row) => row.model === session.model) ?? mainRecords[0];
      target.actual_cost_usd = session.actual_cost_usd;
      target.estimated_cost_usd = session.estimated_cost_usd;
    }

    // 会话归属日：sessions.started_at 优先，明细 first/last_seen 兜底
    const sessionFirstSeen = new Map<string, number>();
    for (const row of records) {
      const sessionId = row.session_id;
      if (!sessionId) continue;
      const session = sessions.get(String(sessionId)) ?? {};
      let timestamp = num(session.started_at ?? row.first_seen ?? row.last_seen ?? 0);
      if (timestamp > 100_000_000_000) timestamp /= 1000;
      if (!(timestamp > 0)) continue;
      const key = String(sessionId);
      const prev = sessionFirstSeen.get(key);
      sessionFirstSeen.set(key, prev === undefined ? timestamp : Math.min(prev, timestamp));
    }

    const daySessions = new Map<string, Set<string>>();
    for (const row of records) {
      const sessionId = String(row.session_id ?? "");
      const timestamp = sessionFirstSeen.get(sessionId);
      if (timestamp === undefined) continue;
      const created = new Date(timestamp * 1000);
      if (!Number.isFinite(created.getTime())) continue;
      const dk = dayKey(created);
      const day: HermesDay = (days[dk] ??= { in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, sessions: 0, models: {}, hours: new Array(24).fill(0) });
      const inp = int(row.input_tokens);
      const out = int(row.output_tokens);
      const cr = int(row.cache_read_tokens);
      const cw = int(row.cache_write_tokens);
      const reason = int(row.reasoning_tokens);
      day.in += inp; day.out += out; day.cr += cr; day.cw += cw; day.reason += reason;
      day.cost += rowCost(row);
      // 未知道模型保留原名（modelIdentityId 对未知返回原串）
      addModelUsage(day.models, modelIdentityId(row.model), { inp, out, cr, cw, reason, cost: rowCost(row) });
      day.hours[created.getHours()] += inp + out + cr + cw + reason;
      // 会话数只认 sessions 可见行
      if (sessions.has(sessionId)) {
        const set = daySessions.get(dk) ?? new Set<string>();
        set.add(sessionId);
        daySessions.set(dk, set);
      }
      // 会话的工作目录才算项目，让 Hermes 参与项目足迹
      const workdir = absoluteProjectPath(sessions.get(sessionId)?.cwd);
      if (workdir) {
        const modelId = modelIdentityId(row.model) || "unknown";
        addProjectUsage(day, workdir, inp + out + cr + cw + reason, rowCost(row),
          { [modelId]: inp + out + cr + cw + reason }, sessionId);
      }
    }
    for (const [dk, ids] of daySessions) days[dk].sessions = ids.size;
  } catch {
    // 与 Python 一致：单库损坏不影响其它库
  } finally {
    try { conn.close(); } catch { /* 忽略 */ }
  }
  return days;
}

/** 对应 scan_hermes()（去掉 ledger_reconcile） */
export function scanHermes(bounds: Bounds, cache: Record<string, any>): HermesScanResult {
  ledgerTouch("hermes");
  const fc: Record<string, any> = (cache.hermes ??= {});
  let changed = false;

  const dbPaths = hermesDbPaths();
  const B = Object.fromEntries(RANGE_KEYS.map((k) => [k, {
    in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, sessions: 0, models: {} as Record<string, ModelUsage>,
  }])) as Record<RangeKey, { in: number; out: number; cr: number; cw: number; reason: number; cost: number; sessions: number; models: Record<string, ModelUsage> }>;

  if (!dbPaths.length) {
    if (Object.keys(fc).length) {
      for (const key of Object.keys(fc)) delete fc[key];
      cache._dirty = true;
    }
    return { ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, hermesRange(B[k])])) as Record<RangeKey, HermesRangeOut> };
  }

  const stale = new Set(Object.keys(fc));
  for (const dbPath of dbPaths) {
    stale.delete(dbPath);
    const sig = sqliteSignature(dbPath);
    if (!sig) continue;
    const entry = fc[dbPath];
    if (!entry || entry.sig !== sig || entry.version !== HERMES_SCAN_VERSION
      || entry.projects_version !== PROJECT_BUCKETS_VERSION) {
      fc[dbPath] = {
        sig, days: scanHermesDb(dbPath), version: HERMES_SCAN_VERSION,
        projects_version: PROJECT_BUCKETS_VERSION,
      };
      changed = true;
    }
  }
  for (const key of stale) {
    delete fc[key];
    changed = true;
  }

  // 多库同日合并（live_days，随后交给 ledger_reconcile 做天级高水位）
  const liveDays: Record<string, HermesDay> = {};
  for (const entry of Object.values(fc)) {
    for (const [dk, day] of Object.entries<HermesDay>(entry.days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
      const agg = (liveDays[dk] ??= { in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, sessions: 0, models: {}, hours: new Array(24).fill(0) });
      agg.in += day.in; agg.out += day.out; agg.cr += day.cr; agg.cw += day.cw;
      agg.reason += day.reason ?? 0; agg.cost += day.cost; agg.sessions += day.sessions ?? 0;
      for (const [mn, mv] of Object.entries(day.models ?? {})) {
        addModelUsage(agg.models, mn, { inp: mv.in, out: mv.out, cr: mv.cr, cw: mv.cw, reason: mv.reason, cost: mv.cost, cost_cny: mv.cost_cny });
      }
      (day.hours ?? []).slice(0, 24).forEach((amount, h) => { agg.hours[h] += amount; });
    }
  }

  // 天级高水位对账：库里被清掉的日行用 ~/.tokei/ledger.json 的快照兜底
  for (const [dk, day] of Object.entries(ledgerReconcile("hermes", liveDays) as Record<string, HermesDay>)) {
    for (const rk of classifyDay(dk, bounds)) {
      const b = B[rk];
      b.in += day.in || 0; b.out += day.out || 0; b.cr += day.cr || 0; b.cw += day.cw || 0;
      b.reason += day.reason || 0; b.cost += day.cost || 0; b.sessions += day.sessions || 0;
      for (const [mn, mv] of Object.entries(day.models || {})) {
        addModelUsage(b.models, mn, { inp: mv.in, out: mv.out, cr: mv.cr, cw: mv.cw, reason: mv.reason, cost: mv.cost });
      }
    }
  }

  if (changed) cache._dirty = true;
  return { ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, hermesRange(B[k])])) as Record<RangeKey, HermesRangeOut> };
}

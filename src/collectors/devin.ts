/**
 * Devin CLI 采集器：对应 usage.30s.py 的 scan_devin / _scan_devin_cli_database。
 * SQLite: ~/.local/share/devin/cli/sessions.db 等（TOKEI_DEVIN_CLI_DB 可覆盖）。
 * message_nodes.chat_message 为整条消息 JSON，assistant 的用量在 metadata.metrics。
 *
 * 口径：input_tokens 与两个缓存桶并列（Anthropic 口径），不做相减；
 * 时刻优先消息自带 metadata.created_at，行级 created_at 兜底；
 * 兄弟节点重复（同刻同 metrics 同模型）按 (会话,时刻/节点,模型,四项桶) 去重；
 * 模型缺失用 sessions.model 兜底，再缺记 "devin"。
 * 历史账本已接 ledger_reconcile：库行被清后用 ~/.tokei/ledger.json 的日快照回补；桌面端套餐缓存(quota)是另一路数据，不在本文件。
 */
import * as path from "path";
import { APPDATA, HOME, LOCALAPPDATA, absoluteProjectPath, firstExistingFile, pathCandidates } from "../core/paths";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey, parseTs } from "../core/ranges";
import { ledgerReconcile, ledgerTouch } from "../core/ledger";
import { knownIdOrRaw, pricingId, rawPrice } from "../core/price";
import {
  Bucket, DayStat, PROJECT_BUCKETS_VERSION, ProjectBucket, TokenUsageRangeOut,
  addProjectUsage, addTokenUsage, emptyBuckets, emptyDay, tokenUsageRange,
} from "../core/model";
import { openReadonly, sqliteSignature } from "./zcode";

/** 对应 _DEVIN_COST_VERSION */
export const DEVIN_COST_VERSION = 3;

export interface DevinDay extends DayStat {
  sessions: string[];
  projects?: Record<string, ProjectBucket>;
}

export interface DevinScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
}

function int(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(Math.trunc(n), 0) : 0;
}

/** 对应 _provider_epoch：数字（含数字串）秒/毫秒自适应，其次 ISO 文本 */
export function providerEpoch(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const seconds = value > 100_000_000_000 ? value / 1000 : value;
    return seconds > 0 ? Math.trunc(seconds) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && Number.isFinite(Number(trimmed))) return providerEpoch(Number(trimmed));
    const parsed = parseTs(trimmed);
    return parsed && parsed.epoch > 0 ? Math.trunc(parsed.epoch) : null;
  }
  return null;
}

/** 对应 _devin_cli_db_path */
export function devinCliDbPath(): string | null {
  return firstExistingFile(pathCandidates(
    "TOKEI_DEVIN_CLI_DB",
    path.join(HOME, ".local", "share", "devin", "cli", "sessions.db"),
    path.join(HOME, "Library", "Application Support", "devin", "cli", "sessions.db"),
    path.join(APPDATA, "devin", "cli", "sessions.db"),
    path.join(LOCALAPPDATA, "devin", "cli", "sessions.db"),
  ));
}

/** 对应 _scan_devin_cli_database */
export function scanDevinDatabase(dbPath: string): Record<string, DevinDay> {
  const days: Record<string, DevinDay> = {};
  const seen = new Set<string>();
  let conn: ReturnType<typeof openReadonly>;
  try {
    conn = openReadonly(dbPath);
  } catch {
    return days;
  }
  try {
    const tables = new Set((conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<Record<string, any>>).map((r) => String(r.name)));
    if (!tables.has("message_nodes")) return days;

    // 会话表：模型兜底 + 项目目录（working_directory 让 Devin 参与项目足迹）
    const sessionModels = new Map<string, string>();
    const sessionProjects = new Map<string, string>();
    if (tables.has("sessions")) {
      const cols = new Set((conn.prepare("PRAGMA table_info(sessions)").all() as Array<Record<string, any>>).map((r) => String(r.name)));
      if (cols.has("id")) {
        const modelCol = cols.has("model") ? "model" : "''";
        const dirCol = cols.has("working_directory") ? "working_directory" : "''";
        try {
          for (const row of conn.prepare(`SELECT id, ${modelCol} AS model, ${dirCol} AS workdir FROM sessions`).all() as Array<Record<string, any>>) {
            const sessionId = String(row.id);
            if (typeof row.model === "string" && row.model.trim()) sessionModels.set(sessionId, row.model.trim());
            const project = absoluteProjectPath(row.workdir);
            if (project) sessionProjects.set(sessionId, project);
          }
        } catch { /* 忽略 */ }
      }
    }

    const nodeCols = new Set((conn.prepare("PRAGMA table_info(message_nodes)").all() as Array<Record<string, any>>).map((r) => String(r.name)));
    for (const need of ["session_id", "chat_message", "created_at"]) {
      if (!nodeCols.has(need)) return days;
    }
    const node = nodeCols.has("node_id") ? "node_id" : "rowid";
    const rows = conn.prepare(`
      SELECT session_id, ${node} AS node_id, chat_message, created_at
      FROM message_nodes
      ORDER BY created_at ASC, ${node} ASC
    `).all() as Array<Record<string, any>>;

    for (const row of rows) {
      let root: any;
      try {
        root = JSON.parse(typeof row.chat_message === "string" ? row.chat_message : Buffer.from(row.chat_message).toString("utf8"));
      } catch {
        continue;
      }
      if (!root || typeof root !== "object") continue;
      const metadata = root.metadata;
      if (!metadata || typeof metadata !== "object") continue;
      const metrics = metadata.metrics;
      if (!metrics || typeof metrics !== "object") continue;

      const inputTotal = int(metrics.input_tokens);
      const outputTotal = int(metrics.output_tokens);
      const cacheRead = int(metrics.cache_read_tokens);
      const cacheWrite = int(metrics.cache_creation_tokens);
      if (inputTotal + outputTotal + cacheRead + cacheWrite <= 0) continue;

      // 消息自带微秒落款优先；缺时间戳的行跳过，不用文件时间顶替
      let stampSource = providerEpoch(metadata.created_at);
      let stampKind: unknown = metadata.created_at;
      if (stampSource === null) {
        stampKind = null;
        stampSource = providerEpoch(row.created_at);
      }
      if (stampSource === null || stampSource <= 0) continue;
      const created = new Date(stampSource * 1000);
      if (!Number.isFinite(created.getTime())) continue;

      const rawModel = typeof metadata.generation_model === "string" && metadata.generation_model.trim()
        ? metadata.generation_model.trim()
        : (sessionModels.get(String(row.session_id)) ?? null);

      // 同会话「同刻+同 metrics+同模型」的兄弟节点只计一次；无微秒落款退回按节点计
      const dedupKey = [
        row.session_id,
        stampKind !== null ? String(stampSource) : `node:${row.node_id}`,
        rawModel ?? "", inputTotal, outputTotal, cacheRead, cacheWrite,
      ].join("\u0000");
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const displayModel = rawModel ? (knownIdOrRaw(rawModel) || rawModel) : "devin";
      let cost = 0;
      const priceId = rawModel ? pricingId(rawModel) : null;
      if (priceId) {
        const p = rawPrice(priceId);
        cost = (inputTotal / 1e6) * p.in + (outputTotal / 1e6) * p.out
          + (cacheRead / 1e6) * p.cache_read + (cacheWrite / 1e6) * p.cache_write;
      }

      const dk = dayKey(created);
      const day: DevinDay = (days[dk] ??= Object.assign(emptyDay(), { sessions: [] as string[] }));
      addTokenUsage(day as unknown as Bucket, inputTotal, outputTotal, cacheRead, cacheWrite, 0, cost, displayModel);
      const project = sessionProjects.get(String(row.session_id));
      if (project) {
        const total = inputTotal + outputTotal + cacheRead + cacheWrite;
        addProjectUsage(day, project, total, cost, { [displayModel]: total }, String(row.session_id));
      }
      day.hours[created.getHours()] += inputTotal + outputTotal + cacheRead + cacheWrite;
      const session = String(row.session_id ?? "unknown");
      if (!day.sessions.includes(session)) day.sessions.push(session);
    }
  } catch {
    // 库损坏：返回已读部分
  } finally {
    try { conn.close(); } catch { /* 忽略 */ }
  }
  return days;
}

/** 对应 scan_devin()（去掉 ledger_reconcile） */
export function scanDevin(bounds: Bounds, cache: Record<string, any>): DevinScanResult {
  ledgerTouch("devin");
  const fc: Record<string, any> = (cache.devin ??= {});
  const buckets = emptyBuckets();
  const found = devinCliDbPath();

  if (!found) {
    if (Object.keys(fc).length) {
      for (const key of Object.keys(fc)) delete fc[key];
      cache._dirty = true;
    }
    return result(buckets);
  }

  const dbPath = path.resolve(found);
  const cacheKey = `db:${dbPath}`;
  const sig = sqliteSignature(dbPath);
  let entry = fc[cacheKey];
  if (!entry || entry.sig !== sig || entry.version !== DEVIN_COST_VERSION
    || entry.projects_version !== PROJECT_BUCKETS_VERSION) {
    entry = {
      sig, days: scanDevinDatabase(dbPath), version: DEVIN_COST_VERSION,
      projects_version: PROJECT_BUCKETS_VERSION,
    };
    for (const key of Object.keys(fc)) delete fc[key];
    fc[cacheKey] = entry;
    cache._dirty = true;
  }

  // 天级高水位对账：库里被清掉的日行用账本快照兜底
  const reconciled = ledgerReconcile("devin", entry.days ?? {}) as Record<string, DevinDay>;
  for (const [dk, day] of Object.entries<DevinDay>(reconciled)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
    for (const rk of classifyDay(dk, bounds)) {
      const b = buckets[rk];
      addTokenUsage(b, day.in, day.out, day.cr, day.cw, day.reason, day.cost, null, day.credits, day.cost_cny);
      for (const [mn, mv] of Object.entries(day.models ?? {})) {
        const mm = (b.models[mn] ??= { in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0 });
        mm.in += mv.in; mm.out += mv.out; mm.cr += mv.cr; mm.cw += mv.cw; mm.reason += mv.reason; mm.cost += mv.cost;
      }
      for (const s of day.sessions ?? []) b.sessions.add(s);
    }
  }
  return result(buckets);
}

function result(buckets: ReturnType<typeof emptyBuckets>): DevinScanResult {
  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])])) as Record<RangeKey, TokenUsageRangeOut>,
  };
}

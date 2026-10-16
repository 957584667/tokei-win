/**
 * MiniMax Code 采集器：对应 usage.30s.py 的 scan_minimax / _scan_minimax_database /
 * _minimax_read_turn_models / _minimax_db_path。
 * SQLite: ~/.minimax/v2/sqlite/runtime-state.sqlite（TOKEI_MINIMAX_DB 可覆盖），
 * 表 local_runtime_token_usage 每轮一行；模型名库里是空的，
 * 只在同级 observability/logs/runtime-*.log 的 llm_response_identifiers 行里。
 *
 * 口径（CALCULATION.md §1 MiniMax / §4）：
 * - 四个桶并列直加（input/output/cacheRead/cacheWrite），绝不相减；
 *   reasoning 仅当 raw.totalTokens == 四桶+reasoning 时才计，否则宁少勿重。
 * - 日志按字节偏移增量读；对上限结果按「行号区间」压缩存进缓存(runs)，
 *   日志轮转删除后模型名不丢；尚未落库的 turn 暂存 pending（TTL 2 天）。
 * - 库被重建（最大行号回退）时旧区间失效，runs/through 清零重攒。
 * 历史账本已接 ledger_reconcile；项目桶写在 day.projects 供项目足迹用（不进 payload）；桌面端联网额度是另一路数据。
 */
import * as fs from "fs";
import * as path from "path";
import { HOME, absoluteProjectPath, pathCandidates, firstExistingFile } from "../core/paths";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey } from "../core/ranges";
import { ledgerReconcile, ledgerTouch } from "../core/ledger";
import { knownIdOrRaw, pricingId, rawPrice } from "../core/price";
import {
  Bucket, DayStat, PROJECT_BUCKETS_VERSION, ProjectBucket, TokenUsageRangeOut,
  addProjectUsage, addTokenUsage, emptyBuckets, emptyDay, tokenUsageRange,
} from "../core/model";
import { openReadonly, sqliteSignature } from "./zcode";
import { providerEpoch } from "./devin";

const MINIMAX_SCAN_VERSION = 1;
const MINIMAX_LOG_MARKER = "llm_response_identifiers";
const MINIMAX_PENDING_TTL = 2 * 24 * 3600;

export interface MinimaxDay extends DayStat {
  sessions: string[];
  projects?: Record<string, ProjectBucket>;
}

export interface MinimaxScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
}

interface MinimaxCacheEntry {
  version: number;
  projects_version?: number;
  logs: Record<string, number>;
  pending: Record<string, [string, number]>;
  runs: Array<[number, string | null]>;
  through: number;
  sig?: string;
  days?: Record<string, MinimaxDay>;
}

function int(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(Math.trunc(n), 0) : 0;
}

/** 对应 _minimax_db_path */
export function minimaxDbPath(): string | null {
  return firstExistingFile(pathCandidates(
    "TOKEI_MINIMAX_DB",
    path.join(HOME, ".minimax", "v2", "sqlite", "runtime-state.sqlite"),
  ));
}

/** 对应 _minimax_log_dir：库上两级 + observability/logs */
export function minimaxLogDir(dbPath: string): string {
  return path.join(path.dirname(path.dirname(dbPath)), "observability", "logs");
}

/** 对应 _minimax_read_turn_models：字节偏移增量读，半行留到下轮 */
export function minimaxReadTurnModels(
  logDir: string, offsets: Record<string, number>, pending: Record<string, [string, number]>,
  now = Math.floor(Date.now() / 1000),
): number {
  let names: Set<string>;
  try {
    names = new Set(fs.readdirSync(logDir).filter((n) => n.endsWith(".log")));
  } catch {
    names = new Set();
  }
  for (const name of Object.keys(offsets)) {
    if (!names.has(name)) delete offsets[name];
  }
  let learned = 0;
  for (const name of [...names].sort()) {
    const file = path.join(logDir, name);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    let offset = Number.isInteger(offsets[name]) && offsets[name] >= 0 && offsets[name] <= size ? offsets[name] : 0;
    if (offset === size) {
      offsets[name] = offset;
      continue;
    }
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      const buffer = Buffer.allocUnsafe(1 << 20);
      let carry: Buffer = Buffer.alloc(0);
      for (;;) {
        let read: number;
        try {
          read = fs.readSync(fd, buffer, 0, buffer.length, null);
        } catch {
          break;
        }
        if (read <= 0) break;
        const chunk = Buffer.concat([carry, buffer.subarray(0, read)]);
        let start = 0;
        for (;;) {
          const nl = chunk.indexOf(0x0a, start); // 半行不推进偏移，等下轮补全
          if (nl === -1) {
            carry = chunk.subarray(start);
            break;
          }
          const line = chunk.subarray(start, nl);
          offset += line.length + 1;
          const marker = line.indexOf(MINIMAX_LOG_MARKER);
          if (marker >= 0) {
            const brace = line.indexOf(0x7b, marker);
            if (brace >= 0) {
              try {
                const record = JSON.parse(line.subarray(brace).toString("utf8"));
                if (record && typeof record === "object"
                  && typeof record.turn_id === "string" && record.turn_id
                  && typeof record.model === "string" && record.model.trim()) {
                  pending[record.turn_id] = [record.model.trim(), now];
                  learned += 1;
                }
              } catch { /* 坏行跳过 */ }
            }
          }
          start = nl + 1;
          carry = Buffer.alloc(0);
        }
      }
    } catch {
      continue;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* 忽略 */ }
      }
    }
    offsets[name] = offset;
  }
  return learned;
}

/**
 * 对应 _minimax_project_path：会话的工作目录才算项目；应用自己管的目录（每个会话的
 * 临时 workspace、~/.minimax-agent-cn/projects 这类默认根）不算。
 * Python 跨盘符时 relpath 抛 ValueError 就原样返回，Node 是返回绝对路径，判定同结果。
 */
function minimaxProjectPath(workdir: unknown, isDefault: unknown): string | null {
  if (Number(isDefault)) return null;
  const absolute = absoluteProjectPath(workdir);
  if (!absolute) return null;
  const relative = path.relative(HOME, absolute);
  if (relative && !path.isAbsolute(relative) && relative.split(path.sep)[0].startsWith(".minimax")) return null;
  return absolute;
}

/** 对应 _minimax_run_lookup：行号落在哪个区间头 */
function runLookup(runs: Array<[number, string | null]>, through: number): (rowId: number) => string | null {
  const starts = runs.map(([start]) => start);
  return (rowId: number) => {
    if (rowId > through) return null;
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= rowId) lo = mid + 1;
      else hi = mid;
    }
    const index = lo - 1;
    return index >= 0 ? (runs[index][1] ?? null) : null;
  };
}

export interface MinimaxScanDbResult {
  days: Record<string, MinimaxDay>;
  runs: Array<[number, string | null]>;
  through: number;
  matched: Set<string>;
}

/** 对应 _scan_minimax_database */
export function scanMinimaxDatabase(
  dbPath: string,
  pending: Record<string, [string, number]>,
  runs: Array<[number, string | null]>,
  through: number,
): MinimaxScanDbResult {
  let conn: ReturnType<typeof openReadonly>;
  try {
    conn = openReadonly(dbPath);
  } catch {
    return { days: {}, runs: [], through: 0, matched: new Set() };
  }
  let rows: Array<Record<string, any>> = [];
  const sessionProjects = new Map<string, string>();
  try {
    const tables = new Set((conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<Record<string, any>>).map((r) => String(r.name)));
    if (!tables.has("local_runtime_token_usage")) return { days: {}, runs: [], through: 0, matched: new Set() };
    const cols = new Set((conn.prepare("PRAGMA table_info(local_runtime_token_usage)").all() as Array<Record<string, any>>).map((r) => String(r.name)));
    for (const need of ["id", "session_id", "ts", "input_tokens", "output_tokens"]) {
      if (!cols.has(need)) return { days: {}, runs: [], through: 0, matched: new Set() };
    }
    const column = (name: string) => (cols.has(name) ? name : "NULL");

    // 会话表给出项目目录，让 MiniMax 参与项目足迹
    if (tables.has("local_runtime_sessions")) {
      const sCols = new Set((conn.prepare("PRAGMA table_info(local_runtime_sessions)").all() as Array<Record<string, any>>).map((r) => String(r.name)));
      const workdir = ["project_workspace_dir", "workspace_dir"].find((name) => sCols.has(name));
      if (workdir) {
        const isDefault = sCols.has("is_default_workspace") ? `"is_default_workspace"` : "0";
        try {
          for (const row of conn.prepare(
            `SELECT session_id, "${workdir}" AS workdir, ${isDefault} AS is_default FROM local_runtime_sessions`,
          ).all() as Array<Record<string, any>>) {
            const project = minimaxProjectPath(row.workdir, row.is_default);
            if (project) sessionProjects.set(String(row.session_id), project);
          }
        } catch { /* 忽略 */ }
      }
    }

    rows = conn.prepare(`
      SELECT id, session_id, ${column("turn_id")} AS turn_id, ${column("model")} AS model, ts,
             input_tokens, output_tokens, ${column("reasoning_tokens")} AS reasoning_tokens,
             ${column("cache_read_tokens")} AS cache_read_tokens,
             ${column("cache_write_tokens")} AS cache_write_tokens,
             ${column("raw")} AS raw
      FROM local_runtime_token_usage
      ORDER BY id ASC
    `).all() as Array<Record<string, any>>;
  } catch {
    return { days: {}, runs, through, matched: new Set() };
  } finally {
    try { conn.close(); } catch { /* 忽略 */ }
  }

  // 库被重建：行号从头再来，旧区间不再对应同一批行
  if (rows.length && int(rows[rows.length - 1].id) < through) {
    runs = [];
    through = 0;
  }
  const known = runLookup(runs, through);
  const matched = new Set<string>();
  const evidence: Array<string | null> = [];
  for (const row of rows) {
    let model = typeof row.model === "string" && row.model.trim() ? row.model.trim() : null;
    if (!model && typeof row.turn_id === "string" && pending[row.turn_id]) {
      model = pending[row.turn_id][0];
      matched.add(row.turn_id);
    }
    evidence.push(model ?? known(int(row.id)) ?? null);
  }

  // 会话内众数模型只作展示兜底，不写回 runs，避免猜测被固化成证据
  const sessionCounts = new Map<string, Record<string, number>>();
  rows.forEach((row, i) => {
    const model = evidence[i];
    if (!model) return;
    const counts = sessionCounts.get(String(row.session_id)) ?? {};
    counts[model] = (counts[model] ?? 0) + 1;
    sessionCounts.set(String(row.session_id), counts);
  });

  const days: Record<string, MinimaxDay> = {};
  rows.forEach((row, i) => {
    let model = evidence[i];
    if (!model) {
      const counts = sessionCounts.get(String(row.session_id));
      if (counts) {
        model = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      }
    }
    const inp = int(row.input_tokens);
    const out = int(row.output_tokens);
    const cacheRead = int(row.cache_read_tokens);
    const cacheWrite = int(row.cache_write_tokens);
    let reason = int(row.reasoning_tokens);
    if (reason) {
      let totalTokens = 0;
      try {
        totalTokens = int(JSON.parse(String(row.raw)).totalTokens);
      } catch {
        totalTokens = 0;
      }
      if (totalTokens !== inp + out + cacheRead + cacheWrite + reason) reason = 0;
    }
    const total = inp + out + cacheRead + cacheWrite + reason;
    if (total <= 0) return;
    const stamp = providerEpoch(row.ts);
    if (stamp === null) return;
    const created = new Date(stamp * 1000);
    if (!Number.isFinite(created.getTime())) return;
    const displayModel = model ? (knownIdOrRaw(model) || model) : "minimax";
    let cost = 0;
    const priceId = model ? pricingId(model) : null;
    if (priceId) {
      const p = rawPrice(priceId);
      cost = (inp / 1e6) * p.in + ((out + reason) / 1e6) * p.out
        + (cacheRead / 1e6) * p.cache_read + (cacheWrite / 1e6) * p.cache_write;
    }
    const dk = dayKey(created);
    const day: MinimaxDay = (days[dk] ??= Object.assign(emptyDay(), { sessions: [] as string[] }));
    addTokenUsage(day as unknown as Bucket, inp, out, cacheRead, cacheWrite, reason, cost, displayModel);
    const project = sessionProjects.get(String(row.session_id));
    if (project) addProjectUsage(day, project, total, cost, { [displayModel]: total }, String(row.session_id));
    day.hours[created.getHours()] += total;
    const session = String(row.session_id ?? "unknown");
    if (!day.sessions.includes(session)) day.sessions.push(session);
  });

  const newRuns: Array<[number, string | null]> = [];
  rows.forEach((row, i) => {
    const model = evidence[i];
    if (!newRuns.length || newRuns[newRuns.length - 1][1] !== model) {
      newRuns.push([int(row.id), model]);
    }
  });
  return { days, runs: newRuns, through: rows.length ? int(rows[rows.length - 1].id) : 0, matched };
}

/** 对应 scan_minimax()（去掉 ledger_reconcile） */
export function scanMinimax(bounds: Bounds, cache: Record<string, any>): MinimaxScanResult {
  ledgerTouch("minimax");
  const fc: Record<string, MinimaxCacheEntry> = (cache.minimax ??= {});
  const buckets = emptyBuckets();
  const found = minimaxDbPath();

  if (!found) {
    if (Object.keys(fc).length) {
      for (const key of Object.keys(fc)) delete fc[key];
      cache._dirty = true;
    }
    return result(buckets);
  }

  const dbPath = path.resolve(found);
  const cacheKey = `db:${dbPath}`;
  let entry = fc[cacheKey];
  if (!entry || typeof entry !== "object" || entry.version !== MINIMAX_SCAN_VERSION) {
    // 口径升级只作废计算结果；runs 是从已轮转日志攒下的证据，必须保留
    const previous = entry && typeof entry === "object" ? entry : ({} as MinimaxCacheEntry);
    entry = {
      version: MINIMAX_SCAN_VERSION, projects_version: PROJECT_BUCKETS_VERSION, logs: {}, pending: {},
      runs: previous.runs ?? [], through: previous.through ?? 0,
    };
    for (const key of Object.keys(fc)) delete fc[key];
    fc[cacheKey] = entry;
    cache._dirty = true;
  }

  const offsets = entry.logs;
  const pending = entry.pending;
  const before = JSON.stringify(offsets);
  const learned = minimaxReadTurnModels(minimaxLogDir(dbPath), offsets, pending);
  if (JSON.stringify(offsets) !== before) cache._dirty = true;

  const sig = sqliteSignature(dbPath);
  if (learned || !entry.days || entry.sig !== sig || entry.projects_version !== PROJECT_BUCKETS_VERSION) {
    const { days, runs, through, matched } = scanMinimaxDatabase(dbPath, pending, entry.runs ?? [], entry.through ?? 0);
    const horizon = Math.floor(Date.now() / 1000) - MINIMAX_PENDING_TTL;
    for (const turnId of Object.keys(pending)) {
      const value = pending[turnId];
      if (matched.has(turnId) || !Array.isArray(value) || value.length !== 2 || !Number.isInteger(value[1]) || value[1] < horizon) {
        delete pending[turnId];
      }
    }
    entry.sig = sig;
    entry.days = days;
    entry.projects_version = PROJECT_BUCKETS_VERSION;
    entry.runs = runs;
    entry.through = through;
    cache._dirty = true;
  }

  // 天级高水位对账：库里被清掉的日行用账本快照兜底
  const reconciled = ledgerReconcile("minimax", entry.days ?? {}) as Record<string, MinimaxDay>;
  for (const [dk, day] of Object.entries<MinimaxDay>(reconciled)) {
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

function result(buckets: ReturnType<typeof emptyBuckets>): MinimaxScanResult {
  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])])) as Record<RangeKey, TokenUsageRangeOut>,
  };
}

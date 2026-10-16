/**
 * OpenClaw 采集器：对应 usage.30s.py 的 scan_openclaw 及配套 _openclaw_* 函数。
 * 全局库 ~/.openclaw/state/openclaw.sqlite（task_runs + agent_databases 注册表），
 * 每个 agent 的 openclaw-agent.sqlite 从注册表动态发现；
 * 旧版 agents 下 sessions 目录里的会话 JSONL 继续兼容。
 * OPENCLAW_STATE_DIR / TOKEI_OPENCLAW_DB 可覆盖。
 *
 * 口径（CALCULATION.md §2 OpenClaw）：
 * - 只取 transcript_events.event_json 里 role=assistant 且带 message.usage 的行；
 *   字段 input/output/cacheRead/cacheWrite/reasoningTokens/cost 独立；
 *   reasoningTokens 已含在 output 中，小时热度总量不重复加。
 * - 模型顺序 responseModel → model → session_windows.model；未知保留原名、不借价。
 * - 事件去重：event.id 优先，缺失按原文哈希；同 session 的 SQLite/JSONL 副本取更完整一份。
 * - .trajectory.jsonl、全文索引与非 usage 事件不计。
 * - 任务统计来自 task_runs（date(created_at/1000,'unixepoch','localtime') 分日）。
 * 历史账本已接 ledger_reconcile：会话副本被清后用 ~/.tokei/ledger.json 的逐会话来源快照回补。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { HOME, expandPath, isFile, pathCandidates } from "../core/paths";
import { listDirs, listFiles, forEachLine } from "../core/fsutil";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey, parseTs } from "../core/ranges";
import { exactPricingId, modelIdentityId, rawPrice } from "../core/price";
import { ledgerFileSources, ledgerReconcile, ledgerTouch } from "../core/ledger";
import {
  Bucket, DayStat, addTokenUsage, emptyBuckets, emptyDay, mergeLiveDay, openclawRange,
} from "../core/model";
import { openReadonly, sqliteSignature } from "./zcode";

const OPENCLAW_PARSER_VERSION = 2;
/** 对应 _OPENCLAW_LEDGER_VERSION（8990）：v2 解析口径的日盖章，写进 _ledger_version 让对账偏好新解析器的数字 */
const OPENCLAW_LEDGER_VERSION = 2;

export interface OpenclawScanResult {
  ranges: Record<RangeKey, Record<string, any>>;
}

interface OpenclawUsageRecord {
  date: string; hour: number;
  in: number; out: number; cr: number; cw: number; reason: number;
  cost: number; model: string;
}

interface SessionCopy { days: Record<string, DayStat>; events: number }

/** live_days 的日账：Python 9431 在其上盖 _ledger_version，供 ledgerRecordVersion 判定口径 */
type OpenclawLiveDay = DayStat & { sessions: string[]; _ledger_version?: number };

/** 状态目录：对应 OPENCLAW_STATE_DIR 环境变量 */
export function openclawStateDir(): string {
  return expandPath(process.env.OPENCLAW_STATE_DIR) || path.join(HOME, ".openclaw");
}

/** 对应 _openclaw_db_paths：state 库 + 旧 tasks/runs.sqlite 回退 */
export function openclawDbCandidates(): string[] {
  const state = openclawStateDir();
  return pathCandidates(
    "TOKEI_OPENCLAW_DB",
    path.join(state, "state", "openclaw.sqlite"),
    path.join(state, "tasks", "runs.sqlite"),
  ).filter(isFile);
}

function openclawNumber(value: unknown): number {
  if (typeof value === "boolean") return 0;
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.max(Math.trunc(n), 0) : 0;
}

function openclawCostNumber(value: unknown): number {
  if (typeof value === "boolean") return 0;
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.max(n, 0) : 0;
}

/** OpenClaw 的 reasoningTokens 已含在 output 内 */
export function openclawTokenTotal(usage: { in: number; out: number; cr: number; cw: number }): number {
  return usage.in + usage.out + usage.cr + usage.cw;
}

function openclawDatetime(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const seconds = value > 10_000_000_000 ? value / 1000 : value;
    const d = new Date(seconds * 1000);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === "string") {
    const parsed = parseTs(value);
    return parsed ? parsed.date : null;
  }
  return null;
}

function stableStringify(value: unknown): string {
  // 对应 json.dumps(sort_keys=True, separators=(",",":"))
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** 对应 _openclaw_event_key */
export function openclawEventKey(event: Record<string, any>, rawEvent: string): string {
  const id = event?.id;
  if (typeof id === "string" && id) return `id:${id}`;
  const material = rawEvent || stableStringify(event);
  return "hash:" + crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

/** 对应 _openclaw_usage_record：模型链 responseModel → model → session_windows.model */
export function openclawUsageRecord(
  event: any, createdAt?: unknown, sessionModel?: string,
): OpenclawUsageRecord | null {
  if (!event || typeof event !== "object") return null;
  const message = event.message;
  if (!message || typeof message !== "object" || message.role !== "assistant") return null;
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return null;
  // 落库时间为准：event.timestamp → created_at → message.timestamp
  const occurred = openclawDatetime(event.timestamp) ?? openclawDatetime(createdAt)
    ?? openclawDatetime(message.timestamp);
  if (!occurred) return null;

  const inp = openclawNumber(usage.input);
  const out = openclawNumber(usage.output);
  const cr = openclawNumber(usage.cacheRead);
  const cw = openclawNumber(usage.cacheWrite);
  const reason = openclawNumber(usage.reasoningTokens);

  const rawModel = [message.responseModel, message.model, sessionModel]
    .find((c): c is string => typeof c === "string" && c.trim().length > 0)?.trim() ?? "";
  // 未知模型保留原名；recalcCosts 不含 openclaw —— 不借别的模型价格
  const model = modelIdentityId(rawModel) || rawModel || "unknown";

  let cost = 0;
  const costObj = usage.cost;
  if (costObj && typeof costObj === "object") {
    cost = openclawCostNumber(costObj.total);
    if (cost <= 0) {
      cost = ["input", "output", "cacheRead", "cacheWrite"]
        .reduce((sum, field) => sum + openclawCostNumber(costObj[field]), 0);
    }
  } else {
    cost = openclawCostNumber(costObj);
  }
  const pricingId = exactPricingId(model);
  if (cost <= 0 && pricingId) {
    const p = rawPrice(pricingId);
    cost = (inp / 1e6) * p.in + (out / 1e6) * p.out + (cr / 1e6) * p.cache_read + (cw / 1e6) * p.cache_write;
  }
  return {
    date: dayKey(occurred), hour: occurred.getHours(),
    in: inp, out, cr, cw, reason, cost, model,
  };
}

function addRecord(days: Record<string, DayStat>, record: OpenclawUsageRecord): void {
  const day = (days[record.date] ??= Object.assign(emptyDay(), { sessions: [] as string[] }) as DayStat);
  addTokenUsage(day as unknown as Bucket, record.in, record.out, record.cr, record.cw, record.reason, record.cost, record.model);
  day.hours[record.hour] += openclawTokenTotal(record);
}

/** 对应 _openclaw_task_db_path：第一个带完整 task_runs 的库 */
export function openclawTaskDbPath(): string | null {
  for (const dbPath of openclawDbCandidates()) {
    let conn: ReturnType<typeof openReadonly> | null = null;
    try {
      conn = openReadonly(dbPath);
      const found = conn.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='task_runs'").get();
      if (!found) continue;
      const cols = new Set((conn.prepare("PRAGMA table_info(task_runs)").all() as Array<Record<string, any>>).map((r) => String(r.name)));
      if (cols.has("status") && cols.has("created_at")) return dbPath;
    } catch {
      continue;
    } finally {
      if (conn) { try { conn.close(); } catch { /* 忽略 */ } }
    }
  }
  return null;
}

/** 对应 _scan_openclaw_db：任务数按本地日分组 */
export function scanOpenclawTasks(dbPath: string): Record<string, { tasks: number; completed: number; failed: number }> {
  const out: Record<string, { tasks: number; completed: number; failed: number }> = {};
  const conn = openReadonly(dbPath);
  try {
    const rows = conn.prepare(`
      SELECT date(created_at/1000,'unixepoch','localtime') AS day,
             COUNT(*) AS total,
             SUM(CASE WHEN lower(status) IN ('completed','succeeded','success') THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN lower(status) IN ('failed','error') THEN 1 ELSE 0 END) AS failed
      FROM task_runs WHERE created_at > 0
      GROUP BY day
    `).all() as Array<Record<string, any>>;
    for (const row of rows) {
      if (!row.day) continue;
      out[String(row.day)] = {
        tasks: openclawNumber(row.total),
        completed: openclawNumber(row.completed),
        failed: openclawNumber(row.failed),
      };
    }
  } finally {
    try { conn.close(); } catch { /* 忽略 */ }
  }
  return out;
}

/** 对应 os.path.expandvars(expanduser(...))：只展开 ~ 与变量，绝不绝对化（相对路径要对 state 目录解析） */
function expandRegistryPath(value: string): string {
  let out = value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => process.env[a || b] ?? "")
    .replace(/%([A-Za-z_][A-Za-z0-9_%]*)%/g, (_m, name) => process.env[name] ?? "");
  if (out === "~") out = HOME;
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = path.join(HOME, out.slice(2));
  return out;
}

/** 对应 _openclaw_agent_db_paths：注册表动态发现；ok 区分空注册表与读取失败 */
export function openclawAgentDbPaths(): { ok: boolean; paths: string[] } {
  let readFailed = false;
  for (const registryPath of openclawDbCandidates()) {
    let conn: ReturnType<typeof openReadonly> | null = null;
    try {
      conn = openReadonly(registryPath);
      const found = conn.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='agent_databases'").get();
      if (!found) continue;
      const cols = new Set((conn.prepare("PRAGMA table_info(agent_databases)").all() as Array<Record<string, any>>).map((r) => String(r.name)));
      if (!cols.has("path")) continue;
      const agentsRoot = path.join(openclawStateDir(), "agents");
      const root = path.dirname(fs.realpathSync(agentsRoot));
      const paths: string[] = [];
      const seen = new Set<string>();
      for (const row of conn.prepare("SELECT path FROM agent_databases").all() as Array<Record<string, any>>) {
        const raw = row.path;
        if (typeof raw !== "string" || !raw.trim()) continue;
        const expanded = expandRegistryPath(raw.trim());
        if (!expanded) continue;
        const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
        let real = resolved;
        try { real = fs.realpathSync(resolved); } catch { /* 保留原始路径 */ }
        const key = path.normalize(real).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        paths.push(real);
      }
      return { ok: true, paths };
    } catch {
      readFailed = true;
    } finally {
      if (conn) { try { conn.close(); } catch { /* 忽略 */ } }
    }
  }
  return { ok: !readFailed, paths: [] };
}

/** 对应 _scan_openclaw_agent_db：每个逻辑会话一份完整副本 */
export function scanOpenclawAgentDb(dbPath: string): Record<string, SessionCopy> {
  const conn = openReadonly(dbPath);
  try {
    const tables = new Set((conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<Record<string, any>>).map((r) => String(r.name)));
    if (!tables.has("transcript_events")) throw new Error("missing transcript_events");
    const cols = new Set((conn.prepare("PRAGMA table_info(transcript_events)").all() as Array<Record<string, any>>).map((r) => String(r.name)));
    for (const need of ["session_id", "seq", "event_json", "created_at"]) {
      if (!cols.has(need)) throw new Error("incompatible transcript_events");
    }
    const sessionModels = new Map<string, string>();
    if (tables.has("session_windows")) {
      const windowCols = new Set((conn.prepare("PRAGMA table_info(session_windows)").all() as Array<Record<string, any>>).map((r) => String(r.name)));
      if (windowCols.has("session_id") && windowCols.has("model")) {
        for (const row of conn.prepare("SELECT session_id, model FROM session_windows").all() as Array<Record<string, any>>) {
          sessionModels.set(String(row.session_id), row.model);
        }
      }
    }
    const sessions = new Map<string, SessionCopy>();
    const seenEvents = new Map<string, Set<string>>();
    const rows = conn.prepare(
      "SELECT session_id, seq, event_json, created_at FROM transcript_events ORDER BY session_id, seq",
    ).all() as Array<Record<string, any>>;
    for (const row of rows) {
      let event: any;
      try { event = JSON.parse(String(row.event_json)); } catch { continue; }
      const sessionKey = String(row.session_id);
      const key = openclawEventKey(event, String(row.event_json));
      const seen = seenEvents.get(sessionKey) ?? new Set<string>();
      if (seen.has(key)) continue;
      seen.add(key);
      seenEvents.set(sessionKey, seen);
      const record = openclawUsageRecord(event, row.created_at, sessionModels.get(sessionKey));
      if (!record) continue;
      const session = sessions.get(sessionKey) ?? { days: {}, events: 0 };
      addRecord(session.days, record);
      session.events += 1;
      sessions.set(sessionKey, session);
    }
    return Object.fromEntries(sessions);
  } finally {
    try { conn.close(); } catch { /* 忽略 */ }
  }
}

/** 对应 _scan_openclaw_jsonl：文件名兜底会话 id，type=session 行更新它 */
export function scanOpenclawJsonl(file: string): { sessionId: string; days: Record<string, DayStat>; events: number } {
  let sessionId = path.basename(file, ".jsonl");
  const days: Record<string, DayStat> = {};
  let events = 0;
  const seen = new Set<string>();
  forEachLine(file, (text) => {
    if (!text.includes('"usage"') && !text.includes('"type"')) return;
    let event: any;
    try { event = JSON.parse(text); } catch { return; }
    if (event?.type === "session" && typeof event.id === "string" && event.id) sessionId = event.id;
    const key = openclawEventKey(event, text);
    if (seen.has(key)) return;
    seen.add(key);
    const record = openclawUsageRecord(event);
    if (!record) return;
    addRecord(days, record);
    events += 1;
  });
  return { sessionId, days, events };
}

/** 对应 _openclaw_session_score：token 总量 → 事件数 → SQLite 优先 */
function sessionScore(copy: SessionCopy, source: string): [number, number, number] {
  const tokens = Object.values(copy.days ?? {}).reduce((sum, day) => sum + openclawTokenTotal(day as any), 0);
  return [tokens, Math.trunc(copy.events ?? 0), source === "sqlite" ? 1 : 0];
}

function greaterScore(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** 对应 _openclaw_selected_sessions：同一会话跨源只留更完整的一份 */
export function openclawSelectedSessions(fc: Record<string, any>): Record<string, SessionCopy> {
  const selected = new Map<string, [number, number, number, SessionCopy]>();
  for (const [entryKey, entry] of Object.entries(fc)) {
    if (entryKey.startsWith("_") || !entry || typeof entry !== "object") continue;
    if (entry.parser_version !== OPENCLAW_PARSER_VERSION) continue;
    const source = entry.source;
    let copies: Array<[string, SessionCopy]>;
    if (source === "sqlite") copies = Object.entries<{ days: Record<string, DayStat>; events: number }>(entry.sessions ?? {});
    else if (source === "jsonl") copies = [[String(entry.session_id || entryKey), { days: entry.days ?? {}, events: entry.events ?? 0 }]];
    else continue;
    for (const [sessionId, copy] of copies) {
      if (!copy || typeof copy !== "object") continue;
      const key = String(sessionId);
      const score = sessionScore(copy, source);
      const previous = selected.get(key);
      if (!previous || greaterScore(score, [previous[0], previous[1], previous[2]])) {
        selected.set(key, [score[0], score[1], score[2], copy]);
      }
    }
  }
  return Object.fromEntries([...selected].map(([k, v]) => [k, v[3]]));
}

function emptyResult(buckets: Record<RangeKey, OpenclawBucket>): Record<RangeKey, Record<string, any>> {
  return Object.fromEntries(RANGE_KEYS.map((k) => [k, openclawRange(buckets[k])])) as Record<RangeKey, Record<string, any>>;
}

interface OpenclawBucket extends Bucket {
  tasks: number; completed: number; failed: number;
}

/** 对应 scan_openclaw()（9300-9468） */
export function scanOpenClaw(bounds: Bounds, cache: Record<string, any>): OpenclawScanResult {
  ledgerTouch("openclaw"); // 对应 9302
  const fc: Record<string, any> = (cache.openclaw ??= {});
  let changed = false;

  const buckets = Object.fromEntries(RANGE_KEYS.map((k) => [k, Object.assign(emptyBuckets()[k], { tasks: 0, completed: 0, failed: 0 })])) as Record<RangeKey, OpenclawBucket>;

  // 1) 任务统计（_db 缓存条目）
  const taskDb = openclawTaskDbPath();
  if (taskDb) {
    const sig = sqliteSignature(taskDb);
    const entry = fc._db;
    if (sig && (!entry || entry.path !== taskDb || entry.sig !== sig)) {
      try {
        fc._db = { path: taskDb, sig, days: scanOpenclawTasks(taskDb) };
        changed = true;
      } catch {
        // 读失败保留旧计数
      }
    }
    const active = fc._db?.path === taskDb ? fc._db : null;
    for (const [dk, day] of Object.entries<{ tasks: number; completed: number; failed: number }>(active?.days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
      for (const rk of classifyDay(dk, bounds)) {
        buckets[rk].tasks += day.tasks;
        buckets[rk].completed += day.completed;
        buckets[rk].failed += day.failed;
      }
    }
  } else if (fc._db) {
    delete fc._db;
    changed = true;
  }

  // 2) 动态发现的 agent SQLite
  const { ok: registryOk, paths: agentDbPaths } = openclawAgentDbPaths();
  const activeSqliteKeys = new Set<string>();
  for (const agentDb of agentDbPaths) {
    const entryKey = `sqlite:${agentDb}`;
    activeSqliteKeys.add(entryKey);
    const sig = sqliteSignature(agentDb);
    const entry = fc[entryKey];
    const needsScan = !entry || entry.parser_version !== OPENCLAW_PARSER_VERSION
      || entry.path !== agentDb || entry.sig !== sig;
    if (sig && needsScan) {
      try {
        fc[entryKey] = { source: "sqlite", path: agentDb, sig, parser_version: OPENCLAW_PARSER_VERSION, sessions: scanOpenclawAgentDb(agentDb) };
        changed = true;
      } catch {
        continue;
      }
    }
  }
  if (registryOk) {
    for (const [key, entry] of Object.entries(fc)) {
      if (entry?.source === "sqlite" && !activeSqliteKeys.has(key)) {
        delete fc[key];
        changed = true;
      }
    }
  }

  // 3) 旧版 JSONL（排除 .trajectory.jsonl）
  const jsonlFiles = new Set<string>();
  const agentsDir = path.join(openclawStateDir(), "agents");
  for (const agentDir of listDirs(agentsDir)) {
    for (const f of listFiles(path.join(agentDir, "sessions"))) {
      const name = path.basename(f);
      if (name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl")) jsonlFiles.add(f);
    }
  }
  for (const file of [...jsonlFiles].sort()) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const sig = `${stat.mtimeMs}:${stat.size}`;
    const entry = fc[file];
    if (entry && entry.source === "jsonl" && entry.parser_version === OPENCLAW_PARSER_VERSION && entry.sig === sig) continue;
    try {
      const scanned = scanOpenclawJsonl(file);
      fc[file] = { source: "jsonl", sig, parser_version: OPENCLAW_PARSER_VERSION, session_id: scanned.sessionId, days: scanned.days, events: scanned.events };
      changed = true;
    } catch {
      continue;
    }
  }
  for (const [key, entry] of Object.entries(fc)) {
    if (key.startsWith("_") || !entry || typeof entry !== "object") continue;
    const isJsonl = entry.source === "jsonl" || (!entry.source && key.endsWith(".jsonl"));
    if (isJsonl && !jsonlFiles.has(key)) {
      delete fc[key];
      changed = true;
    }
  }

  // 4) 同会话对账：取更完整副本后合并（对应 9421-9435），再进天级账本对账（9446）
  const selected = openclawSelectedSessions(fc);
  const liveDays: Record<string, OpenclawLiveDay> = {};
  const liveSessions = new Map<string, Set<string>>();
  for (const [sessionId, copy] of Object.entries(selected)) {
    for (const [dk, day] of Object.entries(copy.days)) {
      const agg = (liveDays[dk] ??= Object.assign(emptyDay(), { sessions: [] as string[] }) as OpenclawLiveDay);
      mergeLiveDay(agg, day);
      const set = liveSessions.get(dk) ?? new Set<string>();
      set.add(sessionId);
      liveSessions.set(dk, set);
    }
  }
  // 对应 9430-9431：给每个实时日盖章，让对账偏好本（v2）解析器的数字
  for (const day of Object.values(liveDays)) day._ledger_version = OPENCLAW_LEDGER_VERSION;

  if (JSON.stringify(fc._selected_days ?? null) !== JSON.stringify(liveDays)) {
    fc._selected_days = liveDays;
    changed = true;
  }

  // 会话数只来自现存 session 副本（对应 9437-9444）；账本无法可靠恢复被清日志的归属
  for (const [dk, ids] of liveSessions) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
    for (const rk of classifyDay(dk, bounds)) {
      for (const s of ids) buckets[rk].sessions.add(s);
    }
  }
  // 天级高水位对账（对应 9446-9464 ledger_reconcile("openclaw", live_days,
  // _ledger_file_sources(selected_sessions))）：来源快照取逐会话选中副本而非文件缓存
  const reconciled = ledgerReconcile("openclaw", liveDays, ledgerFileSources(selected)) as Record<string, OpenclawLiveDay>;
  for (const [dk, day] of Object.entries(reconciled)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue; // 对应 9448-9451 的 date.fromisoformat 校验
    for (const rk of classifyDay(dk, bounds)) {
      const b = buckets[rk];
      addTokenUsage(b, day.in, day.out, day.cr, day.cw, day.reason, day.cost, null, day.credits, day.cost_cny);
      for (const [mn, mv] of Object.entries(day.models ?? {})) {
        const mm = (b.models[mn] ??= { in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0 });
        mm.in += mv.in; mm.out += mv.out; mm.cr += mv.cr; mm.cw += mv.cw; mm.reason += mv.reason; mm.cost += mv.cost;
      }
    }
  }

  if (changed) cache._dirty = true;
  return { ranges: emptyResult(buckets) };
}

/**
 * Grok Build 采集器：对应 usage.30s.py 的 scan_grok(7919) / _load_grok_session(4722) /
 * _grok_usage_record(4823) / _grok_usage_cost(4853) / _grok_usage_days(4934) /
 * _scan_grok_billing_from_log(5097) / _normalize_grok_billing(5017) / scan_grok_quota(5229)。
 *
 * 口径（CALCULATION.md §2 Grok Build）：unified.jsonl 里每条**带 token 字段**的
 * shell.turn.inference_done 才是一次模型调用：
 *   in = prompt_tokens - cached_prompt_tokens, cr = cached_prompt_tokens,
 *   out = completion_tokens - reasoning_tokens, reason = reasoning_tokens,
 *   total = 四者之和（in+cr+out+reason）。
 * 旧版 inference_done 没有 token 字段 → 不产生用量记录，只有会话目录里的上下文快照
 * （signals.contextTokensUsed / updates.totalTokens）降级填 cards 的 ctx_used；
 * grokRange 的 tokens 在 usage_calls==0 时才回落到 ctx_used，因此快照永远不进
 * Dashboard / 回顾 / 项目 token 总量。
 *
 * 额度：本里程碑只移植本地日志解析（billing: fetched credits config + 缓存回退）。
 * 实时账单接口 GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 * （Python 的 fetch_grok_live_quota）需要网络，**不在本里程碑内**，所以 source 只会是
 * "log" / "cache"，auth_expired 恒为 false。
 */
import * as fs from "fs";
import * as path from "path";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, parseTs } from "../core/ranges";
import { ledgerReconcile, ledgerTouch } from "../core/ledger";
import { pricingId, rawPrice } from "../core/price";
import { HOME, TOKEI_DIR, expandPath, loadJson, saveJson } from "../core/paths";
import { forEachLine, listDirs, mtimeMs, readTextSafe } from "../core/fsutil";
import { addModelUsage, addTokenUsage, formatTokenModels, grokRange } from "../core/model";

/** 对应 Python 115-117：GROK_HOME 设置后就是唯一根；每次调用现读 env，便于测试先行注入 */
export function grokHome(): string {
  return expandPath(process.env.GROK_HOME) || path.join(HOME, ".grok");
}
export function grokSessionsDir(): string { return path.join(grokHome(), "sessions"); }
export function grokLogPath(): string { return path.join(grokHome(), "logs", "unified.jsonl"); }
const GROK_QUOTA_CACHE = path.join(TOKEI_DIR, "grok_quota_cache.json");
const BILLING_MSG = "billing: fetched credits config";
const QUOTA_LOG_SCAN_BYTES = 2 * 1024 * 1024;
/** 本地缓存放宽到约 1 小时（Python: _GROK_QUOTA_FALLBACK_TTL * 12） */
const QUOTA_CACHE_TTL = 3600;

function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 对应 _grok_usage_record()：只认带 token 字段的 inference_done */
export function grokUsageRecord(o: Record<string, any>): GrokUsageRecord | null {
  if (!o || o.msg !== "shell.turn.inference_done") return null;
  const ctx = o.ctx;
  if (!ctx || typeof ctx !== "object") return null;
  const tokenKeys = ["prompt_tokens", "cached_prompt_tokens", "completion_tokens", "reasoning_tokens"];
  // 旧版日志没有这些字段：这条记录只能当上下文快照，绝不能计用量
  if (!tokenKeys.some((k) => ctx[k] !== undefined)) return null;
  const sid = String(o.sid || "");
  const ts = String(o.ts || "");
  if (!sid || parseTs(ts) === null) return null;
  let prompt: number, cached: number, completion: number, reasoning: number, loopIndex: number, attempts: number;
  try {
    prompt = Math.max(int(ctx.prompt_tokens || 0), 0);
    cached = Math.max(int(ctx.cached_prompt_tokens || 0), 0);
    completion = Math.max(int(ctx.completion_tokens || 0), 0);
    reasoning = Math.max(int(ctx.reasoning_tokens || 0), 0);
    loopIndex = int(ctx.loop_index || 0);
    attempts = int(ctx.attempts || 0);
  } catch {
    return null;
  }
  cached = Math.min(cached, prompt);
  reasoning = Math.min(reasoning, completion);
  return {
    id: `${sid}:${ts}:${loopIndex}:${attempts}:${prompt}:${cached}:${completion}:${reasoning}`,
    ts, sid,
    in: prompt - cached, cr: cached, out: completion - reasoning, reason: reasoning,
  };
}

export interface GrokUsageRecord {
  id: string;
  ts: string;
  sid: string;
  in: number;
  cr: number;
  out: number;
  reason: number;
}

/** 对应 _grok_usage_cost()：逐请求计价；Grok 4.6 满 200K 上下文整单翻倍 */
export function grokUsageCost(record: Pick<GrokUsageRecord, "in" | "cr" | "out" | "reason">, model: string | null): number {
  const priceId = pricingId(model);
  if (!priceId) return 0;
  const p = rawPrice(priceId);
  let cost = (int(record.in) * p.in + int(record.cr) * p.cache_read
    + (int(record.out) + int(record.reason)) * p.out) / 1e6;
  const promptTokens = int(record.in) + int(record.cr);
  if (priceId === "x-ai/grok-4.6" && promptTokens >= 200_000) cost *= 2;
  return cost;
}

function statSig(file: string): string | null {
  try {
    const st = fs.statSync(file);
    return `${file}:${Math.trunc(st.mtimeMs / 1000)}:${st.size}`;
  } catch {
    return null;
  }
}

/** 对应 _grok_file_signature()：会话的四个文件合成一个签名 */
function grokFileSignature(files: string[]): string {
  return files.map(statSig).filter(Boolean).join("|");
}

interface GrokSessionEntry {
  sig: string;
  mtime: number;
  date: string;
  sid: string;
  model: string;
  project: string;
  tokens: number;
  turns: number;
  tools: number;
  duration: number;
  ctx_used: number;
  ctx_window: number;
  errors: number;
  cancellations: number;
  ttft_sum: number;
  response_sum: number;
  latency_count: number;
}

/** 对应 _load_grok_session()：summary + signals (+ updates/events 兜底) */
export function loadGrokSession(summaryPath: string, sig: string, mtime: number): GrokSessionEntry | null {
  const summary = loadJson<Record<string, any>>(summaryPath, {} as Record<string, any>);
  const stamp = summary.updated_at || summary.created_at || "";
  const ts = parseTs(stamp);
  if (!sessionOk(summary) || ts === null) return null;
  const sessionDir = path.dirname(summaryPath);
  const signals = loadJson<Record<string, any>>(path.join(sessionDir, "signals.json"), {});

  // updates.jsonl 的 totalTokens 是 contextTokensUsed 缺失时的兜底快照
  let maxTotal = 0;
  forEachLine(path.join(sessionDir, "updates.jsonl"), (text) => {
    if (!text.includes("totalTokens")) return;
    try {
      const update = JSON.parse(text);
      const total = (((update.params || {})._meta) || {}).totalTokens;
      if (Number.isFinite(total) && total > maxTotal) maxTotal = Math.trunc(total);
    } catch { /* 坏行跳过 */ }
  });

  let eventTurns = 0, eventTools = 0, eventDuration = 0, eventToolErrors = 0, eventTurnErrors = 0, eventCancellations = 0;
  forEachLine(path.join(sessionDir, "events.jsonl"), (text) => {
    let event: Record<string, any>;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (event.type === "turn_started") eventTurns += 1;
    else if (event.type === "tool_completed") {
      eventTools += 1;
      eventDuration += int(event.duration_ms || 0);
      if (event.outcome !== null && event.outcome !== undefined && event.outcome !== "success") eventToolErrors += 1;
    } else if (event.type === "turn_ended") {
      if (event.outcome === "cancelled") eventCancellations += 1;
      else if (event.outcome === "error") eventTurnErrors += 1;
    }
  });

  const turns = int(signals.turnCount) || eventTurns;
  const tools = int(signals.toolCallCount) || eventTools;
  const ctxUsed = int(signals.contextTokensUsed) || maxTotal;
  const signalErrors = int(signals.errorCount) + int(signals.toolFailureCount);
  const groupDir = path.dirname(sessionDir);
  let project = decodeURIComponentSafe(path.basename(groupDir));
  const cwdFile = readTextSafe(path.join(groupDir, ".cwd"));
  if (cwdFile && cwdFile.trim()) project = cwdFile.trim();

  const latencyCount = int(signals.latencySampleCount) || turns;
  return {
    sig, mtime,
    date: ts.day,
    sid: String(((summary.info || {}).id) || summaryPath),
    model: String(summary.current_model_id || "unknown"),
    project: path.isAbsolute(project) ? project : "",
    tokens: ctxUsed || maxTotal,
    turns,
    tools,
    duration: int(signals.sessionDurationSeconds),
    ctx_used: ctxUsed,
    ctx_window: int(signals.contextWindowTokens),
    errors: Math.max(signalErrors, eventTurnErrors, eventToolErrors),
    cancellations: Math.max(int(signals.cancellationCount), eventCancellations),
    ttft_sum: int(signals.avgTimeToFirstTokenMs) * latencyCount,
    response_sum: int(signals.avgResponseTimeMs) * latencyCount,
    latency_count: latencyCount,
  };
}

function sessionOk(summary: Record<string, any>): boolean {
  return !!summary && typeof summary === "object" && !Array.isArray(summary);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 对应 _load_grok_usage_records()：整文件签名变化才重扫，按 id 去重 */
export function loadGrokUsageRecords(cache: Record<string, any>): GrokUsageRecord[] {
  const previous = cache.grok_usage;
  const log = grokLogPath();
  let st: fs.Stats;
  try {
    st = fs.statSync(log);
  } catch {
    if (cache.grok_usage !== undefined) {
      delete cache.grok_usage;
      cache._dirty = true;
    }
    return [];
  }
  const sig = `${Math.trunc(st.mtimeMs / 1000)}:${st.size}`;
  if (previous && previous.sig === sig && Array.isArray(previous.records)) return previous.records as GrokUsageRecord[];

  const records: GrokUsageRecord[] = [];
  const seen = new Set<string>();
  forEachLine(log, (text) => {
    if (!text.startsWith("{") || !text.includes("shell.turn.inference_done")) return;
    let obj: Record<string, any>;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    const record = grokUsageRecord(obj);
    if (!record || seen.has(record.id)) return;
    seen.add(record.id);
    records.push(record);
  });
  cache.grok_usage = { sig, records };
  cache._dirty = true;
  return records;
}

interface GrokModelUsage { in: number; out: number; cr: number; cw: number; reason: number; cost: number; credits: number; cost_cny: number }
interface GrokDay {
  in: number; out: number; cr: number; cw: number; reason: number; cost: number; credits: number; cost_cny: number;
  tokens: number; calls: number; sessions: Set<string>; hours: number[];
  models: Record<string, GrokModelUsage>; projects: Record<string, { tokens: number; cost: number; sessions: Set<string>; models: Record<string, number> }>;
}

/** 进账本的日账：去掉 Set 字段，只留 JSON 兼容部分（对应 Python 的 grok_live_days） */
type GrokLedgerDay = Omit<GrokDay, "sessions" | "projects">;

/** 对应 _grok_usage_days()：逐调用按自身 ts 归日/归小时 */
export function grokUsageDays(
  records: GrokUsageRecord[],
  sessions: Record<string, GrokSessionEntry>,
  latestModel: string | null,
): Record<string, GrokDay> {
  const days: Record<string, GrokDay> = {};
  for (const record of records) {
    const ts = parseTs(record.ts);
    if (!ts) continue;
    const day = (days[ts.day] ??= {
      in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0,
      tokens: 0, calls: 0, sessions: new Set(), hours: new Array(24).fill(0), models: {}, projects: {},
    });
    const sid = record.sid || "";
    const meta = sessions[sid];
    const model = (meta && meta.model) || latestModel || "grok";
    const amount = record.in + record.out + record.cr + record.reason;
    const cost = grokUsageCost(record, model);
    addTokenUsage(day as any, record.in, record.out, record.cr, 0, record.reason, cost, model);
    day.tokens += amount;
    day.calls += 1;
    if (sid) day.sessions.add(sid);
    day.hours[ts.hour] += amount;

    const project = (meta && meta.project) || "";
    if (project) {
      const projectDay = (day.projects[project] ??= { tokens: 0, cost: 0, sessions: new Set(), models: {} });
      projectDay.tokens += amount;
      projectDay.cost += cost;
      if (sid) projectDay.sessions.add(sid);
      projectDay.models[model] = (projectDay.models[model] || 0) + amount;
    }
  }
  return days;
}

// ---------------- 额度（仅本地日志 / 缓存） ----------------

export interface GrokQuota {
  pct: number | null;
  reset: number | null;
  plan: string | null;
  products: Array<{ name: string; pct: number | null }>;
  window: string;
  source: string;
  updated: number;
  stale: boolean;
}

function isoEpoch(raw: unknown): number | null {
  const ts = parseTs(raw);
  return ts ? Math.trunc(ts.epoch) : null;
}

/** 对应 _normalize_grok_billing() */
export function normalizeGrokBilling(
  config: Record<string, any> | null | undefined,
  options: { plan?: string | null; source?: string; updated?: number | null; nowEpoch?: number } = {},
): GrokQuota | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const period = config.currentPeriod && typeof config.currentPeriod === "object" ? config.currentPeriod : {};
  const end = period.end || config.billingPeriodEnd;
  const reset = end ? isoEpoch(end) : null;
  let pctRaw: unknown = config.creditUsagePercent;
  if (config.creditUsagePercent === undefined) {
    // Grok 的 protobuf JSON 会省略 0 值；只有完整统一账单周期才敢当 0% 已用
    const hasPeriod = !!period.start && reset !== null;
    if (config.isUnifiedBillingUser !== true || !hasPeriod) return null;
    pctRaw = 0.0;
  } else if (pctRaw === null) {
    return null;
  }
  let pct = Number(pctRaw);
  if (!Number.isFinite(pct)) return null;
  pct = Math.min(100, Math.max(0, pct));

  const products: Array<{ name: string; pct: number | null }> = [];
  for (const item of config.productUsage || []) {
    if (!item || typeof item !== "object") continue;
    const name = item.product || item.name;
    if (!name) continue;
    let normalized: number | null = item.usagePercent === undefined || item.usagePercent === null ? null : Number(item.usagePercent);
    if (normalized !== null && !Number.isFinite(normalized)) normalized = null;
    else if (normalized !== null) normalized = Math.min(100, Math.max(0, normalized));
    products.push({ name: String(name), pct: normalized });
  }

  const now = Math.trunc(options.nowEpoch ?? Date.now() / 1000);
  const stale = !!(reset !== null && reset <= now);
  if (stale) {
    // 周期已过重置点，本地快照不代表当前额度
    pct = 0;
    for (const item of products) if (item.pct !== null) item.pct = 0;
  }
  const periodType = String(period.type || "").toUpperCase();
  const window = periodType.includes("WEEKLY") ? "week" : periodType.includes("MONTH") ? "month" : "week";
  const planName = options.plan || config.subscriptionTier || config.plan || null;
  return {
    pct,
    reset: stale ? null : reset,
    plan: planName ? String(planName) : null,
    products,
    window,
    source: options.source || "log",
    updated: Math.trunc(options.updated ?? now),
    stale,
  };
}

/** 对应 _scan_grok_billing_from_log()：读日志尾部 2MB，取最近一条 billing 配置 */
export function scanGrokBillingFromLog(file = grokLogPath(), maxBytes = QUOTA_LOG_SCAN_BYTES): GrokQuota | null {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  if (size <= 0) return null;
  const start = Math.max(0, size - maxBytes);
  const tail = readTail(file, start);
  let latest: { config: Record<string, any>; plan: unknown; ts: unknown } | null = null;
  let latestTs: string | null = null;
  for (const rawLine of tail.split("\n")) {
    const text = rawLine.trim();
    if (!text.startsWith("{") || !text.includes(BILLING_MSG)) continue;
    let obj: Record<string, any>;
    try {
      obj = JSON.parse(text);
    } catch {
      continue;
    }
    if (obj.msg !== BILLING_MSG) continue;
    const ctx = obj.ctx;
    if (!ctx || typeof ctx !== "object") continue;
    const config = ctx.config;
    if (!config || typeof config !== "object") continue;
    const ts = obj.ts;
    if (latestTs === null || (typeof ts === "string" && ts >= latestTs)) {
      latestTs = typeof ts === "string" ? ts : latestTs;
      latest = { config, plan: ctx.subscriptionTier || ctx.plan, ts };
    }
  }
  if (!latest) return null;
  return normalizeGrokBilling(latest.config, {
    plan: latest.plan ? String(latest.plan) : null,
    source: "log",
    updated: isoEpoch(latest.ts),
  });
}

function readTail(file: string, start: number): string {
  const buffer = Buffer.alloc(fs.statSync(file).size - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  // start>0 时首行可能被截断，交给 JSON.parse 丢弃
  return buffer.toString("utf8");
}

/** 对应 _cached_grok_quota() */
function cachedGrokQuota(maxAge: number, nowEpoch = Date.now() / 1000): GrokQuota | null {
  const cached = loadJson<Record<string, any>>(GROK_QUOTA_CACHE, {});
  if (!cached || typeof cached !== "object") return null;
  const quota = cached.quota;
  const fetchedAt = Number(cached.fetched_at);
  if (!quota || typeof quota !== "object" || !Number.isFinite(fetchedAt)) return null;
  if (nowEpoch - fetchedAt > maxAge) return null;
  return { ...quota, source: quota.source || cached.source || "cache" } as GrokQuota;
}

/** 对应 _save_grok_quota_cache() */
function saveGrokQuotaCache(quota: GrokQuota): void {
  if (!quota || quota.pct === null) return;
  saveJson(GROK_QUOTA_CACHE, { fetched_at: Date.now() / 1000, source: quota.source, quota });
}

/** 对应 scan_grok_quota()，去掉实时接口分支（本里程碑不联网，source 只会是 log/cache） */
export function scanGrokQuota(nowEpoch = Date.now() / 1000): { quota: Record<string, any> } {
  const logQuota = scanGrokBillingFromLog();
  if (logQuota && !logQuota.stale) saveGrokQuotaCache(logQuota);
  if (logQuota && logQuota.pct !== null) return { quota: logQuota as unknown as Record<string, any> };

  const cached = cachedGrokQuota(QUOTA_CACHE_TTL, nowEpoch);
  if (cached && cached.pct !== null) {
    const out: GrokQuota = { ...cached, source: "cache" };
    const reset = out.reset;
    if (reset !== null && Math.trunc(reset) <= Math.trunc(nowEpoch)) {
      out.stale = true;
      out.pct = 0;
      out.reset = null;
    }
    return { quota: out as unknown as Record<string, any> };
  }
  return { quota: {} };
}

// ---------------- 主入口 ----------------

export interface GrokRangeOut {
  tokens: number; hit: number; in: number; out: number; cr: number; reason: number; cost: number;
  models: ReturnType<typeof formatTokenModels>;
  usage_available: boolean; usage_calls: number; usage_sessions: number; sessions: number;
  turns: number; tools: number; duration: number; ctx_used: number; ctx_window: number; ctx: number;
  errors: number; cancellations: number; ttft: number; response: number;
}

export interface GrokScanResult {
  ranges: Record<RangeKey, GrokRangeOut>;
  model: string | null;
  pct: number | null;
  reset: number | null;
  plan: string | null;
  products: Array<{ name: string; pct: number | null }>;
  window: string | null;
  source: string | null;
  q_updated: number | null;
  stale: boolean | null;
  auth_expired: boolean;
  days: Record<string, Omit<GrokDay, "sessions" | "projects"> & { sessions: string[]; projects: Record<string, { tokens: number; cost: number; sessions: string[]; models: Record<string, number> }> }>;
}

interface GrokBucket {
  in: number; out: number; cr: number; cw: number; reason: number; cost: number; credits: number; cost_cny: number;
  models: Record<string, GrokModelUsage>;
  sessions: Set<string>;
  tokens: number; turns: number; tools: number; duration: number;
  ctx_used: number; ctx_window: number; errors: number; cancellations: number;
  ttft_sum: number; response_sum: number; latency_count: number;
  usage_calls: number; usage_sessions: Set<string>;
}

function emptyGrokBucket(): GrokBucket {
  return {
    in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0, models: {},
    sessions: new Set(), tokens: 0, turns: 0, tools: 0, duration: 0, ctx_used: 0, ctx_window: 0,
    errors: 0, cancellations: 0, ttft_sum: 0, response_sum: 0, latency_count: 0,
    usage_calls: 0, usage_sessions: new Set(),
  };
}

const SESSION_METRICS = ["tokens", "turns", "tools", "duration", "ctx_used", "ctx_window",
  "errors", "cancellations", "ttft_sum", "response_sum", "latency_count"] as const;

function summaryFiles(): string[] {
  const out: string[] = [];
  for (const group of listDirs(grokSessionsDir())) {
    for (const session of listDirs(group)) {
      const file = path.join(session, "summary.json");
      try {
        if (fs.statSync(file).isFile()) out.push(file);
      } catch { /* 无 summary 的会话目录跳过 */ }
    }
  }
  return out.sort();
}

export function scanGrok(bounds: Bounds, cache: Record<string, any>): GrokScanResult {
  ledgerTouch("grok");
  const fileCache: Record<string, GrokSessionEntry> = (cache.grok ??= {});
  const buckets = Object.fromEntries(RANGE_KEYS.map((k) => [k, emptyGrokBucket()])) as Record<RangeKey, GrokBucket>;

  const paths = summaryFiles();
  const keep = new Set(paths);
  let latestMtime = -1;
  let latestModel: string | null = null;
  for (const summaryPath of paths) {
    const sessionDir = path.dirname(summaryPath);
    const sig = grokFileSignature([
      summaryPath,
      path.join(sessionDir, "signals.json"),
      path.join(sessionDir, "updates.jsonl"),
      path.join(sessionDir, "events.jsonl"),
    ]);
    const mtime = mtimeMs(summaryPath) * 1000;
    const existing = fileCache[summaryPath];
    if (existing && existing.sig === sig) continue;
    const parsed = loadGrokSession(summaryPath, sig, mtime);
    if (!parsed) {
      if (fileCache[summaryPath]) {
        delete fileCache[summaryPath];
        cache._dirty = true;
      }
      continue;
    }
    fileCache[summaryPath] = parsed;
    cache._dirty = true;
  }
  for (const stale of Object.keys(fileCache)) {
    if (!keep.has(stale)) {
      delete fileCache[stale];
      cache._dirty = true;
    }
  }

  // 同一 sid 的多份快照只保留最新（会话目录会被复制/改名）
  const sessions: Record<string, GrokSessionEntry> = {};
  for (const [summaryPath, entry] of Object.entries(fileCache)) {
    const sid = entry.sid || summaryPath;
    const current = sessions[sid];
    if (!current || Number(entry.mtime) > Number(current.mtime)) sessions[sid] = entry;
  }

  for (const entry of Object.values(sessions)) {
    if (!entry.date) continue;
    if (Number(entry.mtime) > latestMtime) {
      latestMtime = Number(entry.mtime);
      latestModel = entry.model || "unknown";
    }
    for (const key of classifyDay(entry.date, bounds)) {
      const bucket = buckets[key];
      bucket.sessions.add(entry.sid);
      for (const field of SESSION_METRICS) bucket[field] += int((entry as any)[field]);
    }
  }

  const usageDays = grokUsageDays(loadGrokUsageRecords(cache), sessions, latestModel);
  // 会话数只能来自现存日志（被清日志无从归属）
  for (const [dayKey, day] of Object.entries(usageDays)) {
    for (const key of classifyDay(dayKey, bounds)) {
      const bucket = buckets[key];
      bucket.usage_sessions = new Set([...bucket.usage_sessions, ...day.sessions]);
      bucket.sessions = new Set([...bucket.sessions, ...day.sessions]);
    }
  }

  const days = Object.fromEntries(Object.entries(usageDays).map(([key, day]) => [key, {
    in: day.in, out: day.out, cr: day.cr, cw: day.cw, reason: day.reason, cost: day.cost,
    credits: day.credits, cost_cny: day.cost_cny, tokens: day.tokens, calls: day.calls,
    hours: day.hours, sessions: [...day.sessions].sort(),
    models: day.models,
    projects: Object.fromEntries(Object.entries(day.projects).map(([name, value]) => [
      name, { tokens: value.tokens, cost: value.cost, sessions: [...value.sessions].sort(), models: value.models },
    ])),
  }]));

  // sessions/projects 是集合语义，不进账本，只保留 JSON 兼容的计数字段
  const ledgerLiveDays: Record<string, GrokLedgerDay> = {};
  for (const [dk, day] of Object.entries(days)) {
    const { sessions: _s, projects: _p, ...rest } = day;
    ledgerLiveDays[dk] = rest as GrokLedgerDay;
  }
  // 天级高水位对账：usage 记录被删的天用 ~/.tokei/ledger.json 的快照兜底
  for (const [dayKey, day] of Object.entries<GrokLedgerDay>(ledgerReconcile("grok", ledgerLiveDays) as Record<string, GrokLedgerDay>)) {
    for (const key of classifyDay(dayKey, bounds)) {
      const bucket = buckets[key];
      addTokenUsage(bucket as any, day.in, day.out, day.cr, 0, day.reason, day.cost, null, 0, day.cost_cny);
      for (const [model, usage] of Object.entries(day.models || {})) {
        addModelUsage(bucket.models, model, {
          inp: usage.in, out: usage.out, cr: usage.cr, cw: 0, reason: usage.reason, cost: usage.cost,
        });
      }
      bucket.usage_calls += day.calls;
    }
  }

  const quota = scanGrokQuota().quota;

  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, grokRange(buckets[k])])) as Record<RangeKey, GrokRangeOut>,
    model: latestModel,
    pct: quota.pct ?? null,
    reset: quota.reset ?? null,
    plan: quota.plan ?? null,
    products: quota.products ?? [],
    window: quota.window ?? null,
    source: quota.source ?? null,
    q_updated: quota.updated ?? null,
    stale: quota.stale ?? null,
    auth_expired: false,
    days,
  };
}

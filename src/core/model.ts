/**
 * 统计桶、模型明细与输出序列化：对应 usage.30s.py 的 _empty_* / _add_model_usage /
 * _add_token_usage / _format_token_models / *_range() / _recalc_costs。
 * 输出 JSON 与 macOS 版 Swift 侧 Model.swift 的解码键位保持一致。
 */
import { RANGE_KEYS, RangeKey, niceModel } from "./ranges";
import { exactPricingId, pricingId, rawPrice, priceFor, geminiPrice, Price, deepseekOfficialPrice, modelIdentityId } from "./price";

export interface ModelUsage {
  in: number;
  out: number;
  cr: number;
  cw: number;
  reason: number;
  cost: number;
  credits: number;
  cost_cny: number;
}

export interface TokenModelRow extends ModelUsage {
  model_id: string | null;
  name: string;
  pin: number;
  pout: number;
  pcr: number;
  pref: string | null;
}

export interface DayStat extends ModelUsage {
  models: Record<string, ModelUsage>;
  hours: number[];
}

/**
 * 对应 _PROJECT_DAY_SOURCES 读取的形状：day["projects"][绝对路径] = 本桶。
 * 挂在 hermes/devin/minimax/opencode/mimocode 的日统计上；claude、cmdcode 那些
 * 工具的同名 day.projects 是账本用的名字列表（string[]），两种形状都不会同时出现。
 * 项目足迹与回顾页都从这里派生，所以桶里的 tokens 用各工具自己的总量口径。
 */
export interface ProjectBucket {
  tokens: number;
  cost: number;
  models: Record<string, number>;
  sessions: string[];
}

/**
 * day 形状里新增 projects 桶的那一轮升级。缓存条目没带这个标记就必须重扫 ——
 * 老形状没有逐项目桶，不重扫的话闲置的库会永远在足迹页缺席。
 * 与 *_COST_VERSION 分开记，那几个数值要跟 usage.30s.py 保持一一对应。
 */
export const PROJECT_BUCKETS_VERSION = 1;

/** 对应各 scanner 里的 day.setdefault("projects", {}).setdefault(project, ...) */
export function addProjectUsage(
  day: { projects?: Record<string, ProjectBucket> },
  project: string,
  tokens: number,
  cost: number,
  models: Record<string, number>,
  session: string,
): void {
  const buckets = (day.projects ??= {});
  const bucket = (buckets[project] ??= { tokens: 0, cost: 0, models: {}, sessions: [] });
  bucket.tokens += tokens;
  bucket.cost += cost;
  for (const [name, amount] of Object.entries(models)) {
    bucket.models[name] = (bucket.models[name] ?? 0) + amount;
  }
  if (session && !bucket.sessions.includes(session)) bucket.sessions.push(session);
}

export interface Bucket extends ModelUsage {
  sessions: Set<string>;
  models: Record<string, ModelUsage>;
}

export function emptyBucket(): Bucket {
  return { in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0, sessions: new Set(), models: {} };
}
export function emptyBuckets(): Record<RangeKey, Bucket> {
  return Object.fromEntries(RANGE_KEYS.map((k) => [k, emptyBucket()])) as Record<RangeKey, Bucket>;
}
export function emptyDay(): DayStat {
  return { in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0, models: {}, hours: new Array(24).fill(0) };
}

function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function float(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 对应 _add_model_usage() */
export function addModelUsage(
  models: Record<string, ModelUsage>,
  model: string | null | undefined,
  delta: { inp?: number; out?: number; cr?: number; cw?: number; reason?: number; cost?: number; credits?: number; cost_cny?: number },
): void {
  if (!model) return;
  const mm = models[model] ?? (models[model] = { in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0 });
  mm.in += int(delta.inp);
  mm.out += int(delta.out);
  mm.cr += int(delta.cr);
  mm.cw += int(delta.cw);
  mm.reason += int(delta.reason);
  mm.cost += float(delta.cost);
  mm.credits += float(delta.credits);
  mm.cost_cny += float(delta.cost_cny);
}

/** 对应 _add_token_usage()：桶 + 模型明细同时累加 */
export function addTokenUsage(
  target: Bucket,
  inp = 0, out = 0, cr = 0, cw = 0, reason = 0, cost = 0,
  model?: string | null, credits = 0, cost_cny = 0,
): void {
  target.in += int(inp);
  target.out += int(out);
  target.cr += int(cr);
  target.cw += int(cw);
  target.reason += int(reason);
  target.cost += float(cost);
  target.credits += float(credits);
  target.cost_cny += float(cost_cny);
  addModelUsage(target.models, model, { inp, out, cr, cw, reason, cost, credits, cost_cny });
}

/** 对应 _merge_token_day() */
export function mergeTokenDay(bucket: Bucket, day: Partial<DayStat>, session?: string | null): void {
  if (session !== null && session !== undefined) bucket.sessions.add(session);
  addTokenUsage(bucket, day.in, day.out, day.cr, day.cw, day.reason, day.cost, null, day.credits, day.cost_cny);
  for (const [model, mv] of Object.entries(day.models ?? {})) {
    addModelUsage(bucket.models, model, {
      inp: mv.in, out: mv.out, cr: mv.cr, cw: mv.cw, reason: mv.reason,
      cost: mv.cost, credits: mv.credits, cost_cny: mv.cost_cny,
    });
  }
}

/** 对应 _merge_live_token_day()：跨文件合并同日明细（账本 live_days 用） */
export function mergeLiveDay(agg: DayStat, day: Partial<DayStat>): void {
  addTokenUsage(agg as unknown as Bucket, day.in, day.out, day.cr, day.cw, day.reason, day.cost, null, day.credits, day.cost_cny);
  for (const [model, mv] of Object.entries(day.models ?? {})) {
    addModelUsage(agg.models, model, {
      inp: mv.in, out: mv.out, cr: mv.cr, cw: mv.cw, reason: mv.reason,
      cost: mv.cost, credits: mv.credits, cost_cny: mv.cost_cny,
    });
  }
  if (Array.isArray(day.hours)) {
    for (let h = 0; h < Math.min(24, day.hours.length); h++) agg.hours[h] += day.hours[h] || 0;
  }
}

export function tokenTotal(v: { in?: number; out?: number; cr?: number; cw?: number; reason?: number }): number {
  return (v.in || 0) + (v.out || 0) + (v.cr || 0) + (v.cw || 0) + (v.reason || 0);
}

/**
 * 这几个工具的 reason 是 out 的子集（采集时就没再单算，但字段仍留着展示「推理」行），
 * 相加会重复计数。Python 的 _ledger_token_sum 白名单、Swift 的 reasonIncludedInOutput
 * （PanelView 的 musecode 卡片、openclaw 卡片总量）是同一份规则。
 */
export const REASON_INSIDE_OUTPUT = new Set(["codex", "codex_reserve", "openclaw", "musecode"]);

/**
 * 展示用的「总量」口径。Swift 侧每个族有自己的计算属性，不能统一相加：
 * CodexRange.tokens = in+cached+out、GeminiRange 用 cached+thoughts、
 * GrokRange / TokenUsageRange 优先取 tokens 字段。renderer/app.js 的 fieldTokens 是同一份规则。
 */
export function displayTokenTotal(r: Record<string, any>, toolId?: string): number {
  const n = (v: unknown) => Number(v) || 0;
  if (n(r.tokens) > 0) return n(r.tokens);
  if (r.cached !== undefined && r.thoughts !== undefined) return n(r.in) + n(r.out) + n(r.cached) + n(r.thoughts);
  if (r.cached !== undefined) return n(r.in) + n(r.out) + n(r.cached);
  const reason = toolId && REASON_INSIDE_OUTPUT.has(toolId) ? 0 : n(r.reason);
  return n(r.in) + n(r.out) + n(r.cr) + n(r.cw) + reason;
}

export interface FormatTokenModelsOptions {
  includePrices?: boolean;
  /** 该工具算成本实际用的查价规则（如 Codex 的 reserve 价格映射） */
  priceModel?: (id: string | null) => string | null;
}

/** 对应 _format_token_models()：先按 canonical id 合并，再排序输出 */
export function formatTokenModels(
  models: Record<string, ModelUsage>,
  options: FormatTokenModelsOptions = {},
): TokenModelRow[] {
  const { includePrices = true, priceModel = null } = options;
  const canonical: Record<string, ModelUsage> = {};
  const identityOf = new Map<string, string | null>();
  for (const [model, usage] of Object.entries(models)) {
    const id = modelIdentityKey(model);
    identityOf.set(id ?? model, id);
    const merged = canonical[id ?? model] ?? (canonical[id ?? model] = { in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0 });
    for (const field of ["in", "out", "cr", "cw", "reason", "cost", "cost_cny", "credits"] as const) {
      merged[field] += usage[field] || 0;
    }
  }
  const entries = Object.entries(canonical);
  entries.sort(includePrices
    ? (a, b) => (b[1].cost || 0) - (a[1].cost || 0)
    : (a, b) => tokenTotal(b[1]) - tokenTotal(a[1]));

  return entries.map(([key, v]) => {
    const modelId = identityOf.get(key) ?? null;
    let priceId: string | null = null;
    if (includePrices) {
      priceId = priceModel ? priceModel(modelId) : (modelId ? exactPricingId(modelId) : null);
    }
    const p: Price = priceId ? rawPrice(priceId) : { in: 0, out: 0, cache_read: 0, cache_write: 0 };
    const estimatedFrom = priceId && modelIdentityKey(priceId) !== modelId ? niceModel(priceId) : null;
    const cny = v.cost_cny || 0;
    return {
      model_id: modelId,
      name: niceModel(modelId),
      in: v.in, out: v.out, cr: v.cr, cw: v.cw, reason: v.reason,
      cost: v.cost, cost_cny: cny, credits: v.credits,
      pin: cny ? 0 : p.in,
      pout: cny ? 0 : p.out,
      pcr: cny ? 0 : p.cache_read,
      pref: cny ? null : estimatedFrom,
    };
  });
}

// 模型明细的 canonical 合并键复用 price.ts 的精确身份解析
function modelIdentityKey(model: string): string | null {
  return modelIdentityId(model);
}

/** input 不含缓存的口径：hit = cr / (cr + cw + in) */
export function hitExcludingCache(b: { in: number; cr: number; cw: number }): number {
  const denom = b.cr + b.cw + b.in;
  return denom ? (b.cr / denom) * 100 : 0;
}
/** input 已含缓存的口径（Codex / Gemini / Qoder）：hit = cached / in */
export function hitIncludingCache(totalIn: number, cached: number): number {
  return totalIn ? (cached / totalIn) * 100 : 0;
}

// ---------------- 输出序列化 ----------------

export interface ClaudeRangeOut {
  hit: number; in: number; out: number; cr: number; cw: number; cost: number;
  sessions: number; models: Array<{ name: string; in: number; out: number; cr: number; cw: number; cost: number; pin: number; pout: number; pcr: number }>;
}

export interface ClaudeBucketLike {
  in: number; out: number; cr: number; cw: number; cost: number;
  models: Record<string, { in: number; out: number; cr: number; cw: number; cost: number }>;
  sessions: { size: number };
}

export function claudeRange(b: ClaudeBucketLike): ClaudeRangeOut {
  const models = Object.entries(b.models)
    .sort((a, c) => c[1].cost - a[1].cost)
    .map(([n, v]) => {
      const p = priceFor(n);
      return { name: niceModel(n), in: v.in, out: v.out, cr: v.cr, cw: v.cw, cost: v.cost, pin: p.in, pout: p.out, pcr: p.cache_read };
    });
  return { hit: hitExcludingCache(b), in: b.in, out: b.out, cr: b.cr, cw: b.cw, cost: b.cost, models, sessions: b.sessions.size };
}

export interface CodexRangeOut {
  hit: number; in: number; cached: number; out: number; reason: number; cost: number; sessions: number; models: TokenModelRow[];
}

export function codexRange(b: any, priceModel?: (id: string | null) => string | null): CodexRangeOut {
  const src = b ?? {};
  const totalIn = src.in || 0;
  const cached = src.cached ?? 0;
  return {
    hit: hitIncludingCache(totalIn, cached),
    in: Math.max(totalIn - cached, 0),
    cached,
    out: src.out || 0,
    reason: src.reason || 0,
    cost: src.cost || 0,
    sessions: src.sessions ? src.sessions.size : 0,
    models: formatTokenModels(src.models || {}, { priceModel }),
  };
}

export interface GeminiRangeOut {
  hit: number; in: number; out: number; cached: number; thoughts: number; cost: number; sessions: number;
  models: Array<{ name: string; in: number; out: number; cached: number; thoughts: number; cost: number; pin: number; pout: number; pcr: number }>;
}

export function geminiRange(b: any): GeminiRangeOut {
  const totalIn = b.in || 0;
  const cached = b.cached ?? 0;
  const models = Object.entries<any>(b.models ?? {})
    .sort((x, y) => (y[1].cost || 0) - (x[1].cost || 0))
    .map(([n, v]) => {
      const p = geminiPrice(n);
      return {
        name: niceModel(n), in: Math.max((v.in || 0) - (v.cached || 0), 0), out: v.out || 0,
        cached: v.cached || 0, thoughts: v.thoughts || 0, cost: v.cost || 0,
        pin: p.in, pout: p.out, pcr: p.cache_read,
      };
    });
  return {
    hit: hitIncludingCache(totalIn, cached),
    in: Math.max(totalIn - cached, 0),
    out: b.out || 0, cached, thoughts: b.thoughts || 0, cost: b.cost || 0,
    models, sessions: b.sessions.size,
  };
}

/** Pi / Prime / ZCode / Devin / MiniMax / MiMoCode / WorkBuddy / CodeBuddy / DSH / OpenCode / Qwen / Kimi / Muse / CmdCode 通用口径 */
export interface TokenUsageRangeOut {
  hit: number; in: number; out: number; cr: number; cw: number; reason: number;
  cost: number; cost_cny: number; credits: number; sessions: number; models: TokenModelRow[];
}
export function tokenUsageRange(b: Bucket): TokenUsageRangeOut {
  return {
    hit: hitExcludingCache(b), in: b.in, out: b.out, cr: b.cr, cw: b.cw, reason: b.reason,
    cost: b.cost, cost_cny: b.cost_cny, credits: b.credits, sessions: b.sessions.size,
    models: formatTokenModels(b.models),
  };
}

export interface HermesRangeOut extends TokenUsageRangeOut {}
export function hermesRange(b: any): HermesRangeOut {
  return {
    hit: hitExcludingCache(b), in: b.in, out: b.out, cr: b.cr, cw: b.cw, reason: b.reason,
    cost: b.cost, cost_cny: b.cost_cny, credits: b.credits,
    sessions: typeof b.sessions === "number" ? b.sessions : b.sessions.size,
    models: formatTokenModels(b.models),
  };
}

/** 对应 qoderwork_range() */
export function qoderworkRange(b: Record<string, any>): Record<string, any> {
  const ctxCount = b.ctx_count || 0;
  return {
    in: b.in || 0, out: b.out || 0, sessions: b.sessions || 0, calls: b.calls || 0,
    sub_agents: b.sub_agents || 0, turns: b.turns || 0, duration: b.duration || 0,
    ctx: ctxCount ? (b.ctx_sum || 0) / ctxCount * 100 : 0,
  };
}

/** 对应 qoder_range()（Qoder Desktop / IDE 的 SQLite 口径，cached 是 in 的子集） */
export function qoderRange(b: Record<string, any>): Record<string, any> {
  const totalIn = b.in || 0;
  const cached = b.cached || 0;
  return {
    in: Math.max(totalIn - cached, 0), out: b.out || 0, cached,
    sessions: b.sessions || 0, sub_agents: b.sub_agents || 0, calls: b.calls || 0,
    messages: b.messages || 0, ctx: hitIncludingCache(totalIn, cached), duration: b.duration || 0,
  };
}

/** 对应 qodercli_range() */
export function qodercliRange(b: Record<string, any>): Record<string, any> {
  const base = qoderworkRange(b);
  const inputTotal = (b.in || 0) + (b.cr || 0) + (b.cw || 0);
  return {
    ...base,
    cr: b.cr || 0, cw: b.cw || 0, credits: b.credits || 0,
    usage_calls: b.usage_calls || 0,
    usage_available: !!b.usage_calls,
    hit: inputTotal ? (b.cr || 0) / inputTotal * 100 : 0,
    models: formatTokenModels(b.models || {}, { includePrices: false }),
    tools: b.tools || 0, est: Math.trunc(b.est || 0),
  };
}

/** 对应 openclaw_range() */
export function openclawRange(b: any): Record<string, any> {
  return {
    tasks: b.tasks || 0, completed: b.completed || 0, failed: b.failed || 0,
    ...tokenUsageRange(b),
  };
}

/** 对应 grok_range() */
export function grokRange(b: Record<string, any>): Record<string, any> {
  const latencyCount = b.latency_count || 0;
  const ctxWindow = b.ctx_window || 0;
  const usageTotal = (b.in || 0) + (b.out || 0) + (b.cr || 0) + (b.reason || 0);
  const usageAvailable = (b.usage_calls || 0) > 0;
  const inputTotal = (b.in || 0) + (b.cr || 0);
  return {
    tokens: usageAvailable ? usageTotal : (b.ctx_used || 0),
    hit: inputTotal ? (b.cr || 0) / inputTotal * 100 : 0,
    in: b.in || 0, out: b.out || 0, cr: b.cr || 0, reason: b.reason || 0, cost: b.cost || 0,
    models: formatTokenModels(b.models || {}),
    usage_available: usageAvailable, usage_calls: b.usage_calls || 0,
    usage_sessions: b.usage_sessions ? b.usage_sessions.size : 0,
    sessions: b.sessions ? b.sessions.size : 0,
    turns: b.turns || 0, tools: b.tools || 0, duration: b.duration || 0,
    ctx_used: b.ctx_used || 0, ctx_window: ctxWindow, ctx: ctxWindow ? (b.ctx_used || 0) / ctxWindow * 100 : 0,
    errors: b.errors || 0, cancellations: b.cancellations || 0,
    ttft: latencyCount ? Math.trunc((b.ttft_sum || 0) / latencyCount) : 0,
    response: latencyCount ? Math.trunc((b.response_sum || 0) / latencyCount) : 0,
  };
}

// ---------------- _recalc_costs ----------------

const RECALC_TOOLS = ["gemini", "grok", "hermes", "zcode", "mimocode", "workbuddy", "workbuddy_ai", "codebuddy",
  "deepseek_harness", "qwencode", "devin", "minimax"] as const;

/** 对应 _recalc_costs()：只重算缺少权威账单的工具，已有日志成本的工具保留原值。 */
export function recalcCosts(result: Record<string, any>): void {
  for (const toolKey of RECALC_TOOLS) {
    const tool = result[toolKey];
    if (!tool || !tool.ranges) continue;
    for (const rk of RANGE_KEYS) {
      const r = tool.ranges[rk];
      if (!r || !Array.isArray(r.models)) continue;
      let totalCost = 0;
      for (const m of r.models) {
        const name = m.name ?? "";
        const modelId = typeof m.model_id === "string" ? m.model_id : null;
        let priceId = modelId ? exactPricingId(modelId) : null;
        if (!priceId) priceId = pricingId(name);
        // 单价借自别的模型（沿用上一个版本 / 家族代表）时注明参照，界面要标出来
        const identity = typeof m.model_id === "string" ? m.model_id : modelIdentityId(name);
        m.pref = priceId && modelIdentityId(priceId) !== identity ? niceModel(priceId) : null;
        const authoritative = float(m.cost);
        if (toolKey === "deepseek_harness") {
          totalCost += authoritative;
          m.pin = 0; m.pout = 0; m.pcr = 0;
          continue;
        }
        if (toolKey === "hermes" && authoritative) {
          totalCost += authoritative;
          if (priceId) {
            const price = rawPrice(priceId);
            m.pin = price.in; m.pout = price.out; m.pcr = price.cache_read;
          }
          continue;
        }
        if (!priceId) {
          totalCost += authoritative;
          m.pin = 0; m.pout = 0; m.pcr = 0;
          continue;
        }
        const p = rawPrice(priceId);
        const ti = m.in || 0;
        const to = m.out || 0;
        let cost: number;
        if (toolKey === "gemini") {
          cost = (ti / 1e6) * p.in + ((to + (m.thoughts || 0)) / 1e6) * p.out + ((m.cached || 0) / 1e6) * p.cache_read;
        } else if (["hermes", "zcode", "mimocode", "devin", "minimax"].includes(toolKey)) {
          cost = (ti / 1e6) * p.in + ((to + (m.reason || 0)) / 1e6) * p.out
            + ((m.cr || 0) / 1e6) * p.cache_read + ((m.cw || 0) / 1e6) * p.cache_write;
        } else if (toolKey === "grok") {
          // Grok 按请求计价，200K 上下文档位无法从聚合 token 还原，保留扫描结果
          cost = authoritative || ((ti / 1e6) * p.in + ((to + (m.reason || 0)) / 1e6) * p.out + ((m.cr || 0) / 1e6) * p.cache_read);
        } else if (toolKey === "qwencode") {
          cost = (ti / 1e6) * p.in + ((to + (m.reason || 0)) / 1e6) * p.out + ((m.cr || 0) / 1e6) * p.cache_read;
        } else {
          cost = (ti / 1e6) * p.in + (to / 1e6) * p.out + ((m.cr || 0) / 1e6) * p.cache_read + ((m.cw || 0) / 1e6) * p.cache_write;
        }
        m.cost = round6(cost);
        m.pin = p.in;
        m.pout = p.out;
        m.pcr = p.cache_read ?? 0;
        totalCost += cost;
      }
      r.cost = round6(totalCost);
    }
  }
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

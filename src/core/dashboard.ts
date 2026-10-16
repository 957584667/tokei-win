/**
 * Dashboard 数据层：逐日成本、模型排行与「Tokei 回顾」。
 * 对应 usage.30s.py 的 build_daily_costs(14333-14897) / build_wrapped(14927-15465) /
 * _cny_breakdown(14304) / _period_cutoff(14283) / _gemini_token_total(14297) /
 * _cache_dashboard_days(1526) / _merge_dashboard_days(1542) / _codex_accounted_days(3123)。
 *
 * Windows 三处偏差，逐条标在用到它的地方：
 * 1. 扫描缓存只活在主进程内存里（src/main/index.ts 的 scanCache），没有
 *    ~/.tokei/scan_cache.json，所以 cache 由调用方注入，本模块不碰 IO，
 *    也没有 Python `_load_dashboard_cache()` 见 `_dirty` 补扫一遍的分支。
 * 2. gemini 扫描器把成本留给 recalcCosts 补，日账里没有 cost，这里按 Python
 *    4658-4661 的同一条公式就地估价（成本按模型线性可加，日级 = 各模型之和）。
 * 3. 账本落盘走 ledgerFlush 的高水位合并，与本模块只读账本的口径不变。
 *    另外 Python 的 _save_scan_cache() 会 pop 掉 "_dirty"（1054），Windows 的缓存
 *    不落盘、没有这一步，所以 _dirty 一旦被采集器置上就一直留着；
 *    cacheDashboardDays() 仍照 Python 置位，不会带来新的可观察差异。
 */
import { niceModel } from "./ranges";
import { tokenTotal } from "./model";
import { geminiPrice } from "./price";
import { ledgerDayTotal, ledgerTokenSum, ledgerValues, loadLedger, type DayRecord } from "./ledger";
import { providerNumber, providerUsageInt } from "./providerQuota";
import { codexDayHasUsage, codexSplitDay } from "../collectors/codex";
import { iterWorkBuddyRecords } from "../collectors/workbuddy";
import { iterCodebuddyRecords } from "../collectors/codebuddy";
import { iterHarnessRecords } from "../collectors/deepseek_harness";
import { qoderCliUsageDays } from "../collectors/qodercli";
import { openclawTokenTotal } from "../collectors/openclaw";
import { projectDayNames } from "./trail";

/** 对应 _GEMINI_DAYS_CACHE_KEY 等五个日账缓存键 */
export const GEMINI_DAYS_CACHE_KEY = "_gemini_dashboard_days";
export const GROK_DAYS_CACHE_KEY = "_grok_dashboard_days";
export const CURSOR_PROVIDER_DAYS_CACHE_KEY = "_cursor_provider_days";
export const ZAI_PROVIDER_DAYS_CACHE_KEY = "_zai_provider_days";
export const GROK_BOT_PROVIDER_DAYS_CACHE_KEY = "_grok_bot_provider_days";

const TOKEN_FIELDS = ["in", "out", "cr", "cw", "reason"] as const;

/** 成本列：账本高水位合并只认这些列（对应 _LEDGER_COST_COLUMNS） */
const LEDGER_COST_COLUMNS = new Set([
  "claude", "codex", "codex_reserve", "gemini", "grok", "hermes", "openclaw", "zcode",
  "mimocode", "devin", "minimax", "pi", "workbuddy", "workbuddy_ai", "codebuddy",
  "deepseek_harness", "opencode", "qwencode", "musecode", "cmdcode",
]);

export interface DailyCost {
  date: string;
  claude: number; codex: number; codex_reserve: number; gemini: number; grok: number;
  hermes: number; openclaw: number; zcode: number; mimocode: number; devin: number;
  minimax: number; pi: number; workbuddy: number; workbuddy_ai: number; codebuddy: number;
  deepseek_harness: number; qwencode: number; kimicode: number; musecode: number;
  cmdcode: number; prime_agent: number; total: number;
  c_in: number; c_out: number; c_cr: number; c_cw: number;
  x_in: number; x_out: number; x_cached: number; x_reason: number;
  xr_in: number; xr_out: number; xr_cached: number; xr_reason: number;
  p_in: number; p_out: number; p_cr: number; p_cw: number; p_reason: number;
  pa_in: number; pa_out: number; pa_cr: number; pa_cw: number; pa_reason: number;
  w_in: number; w_out: number; w_cr: number; w_cw: number;
  wa_in: number; wa_out: number; wa_cr: number; wa_cw: number;
  cb_in: number; cb_out: number; cb_cr: number; cb_cw: number; cb_credits: number;
  d_in: number; d_out: number; d_cr: number; d_cw: number; d_reason: number;
  q_in: number; q_out: number; q_cr: number; q_reason: number;
  g_in: number; g_out: number; g_cr: number; g_reason: number;
  tokens: number;
  cost_cny: number;
  cny_by_tool: Record<string, number>;
}

export interface ModelCost {
  name: string;
  cost: number;
  in: number; out: number; cr: number; cw: number; reason: number;
  /** 只有 WorkBuddy 系三家的本地行有这项；账号级 provider 行不输出（同 Python） */
  credits?: number;
  tokens: number;
  tool: string;
  cost_per_k: number;
  out_ratio: number;
  cost_cny: number;
}

export interface WrappedPeakDay {
  date: string;
  tokens: number;
  projects: string[];
}

export interface WrappedProject {
  name: string;
  tokens: number;
  cost: number;
  cost_cny: number;
}

export interface WrappedAchievement {
  icon: string;
  title: string;
  desc: string;
  tint: string;
  tokens?: number;
  tokens_template?: string;
}

export interface WrappedData {
  total_tokens: number;
  total_cost: number;
  cost_cny: number;
  active_days: number;
  streak_max: number;
  streak_cur: number;
  busiest: { date: string; tokens: number };
  peak_days: WrappedPeakDay[];
  day_projects: Record<string, string[]>;
  top_model: { name: string; tokens: number };
  hours: number[];
  weekday: number[];
  projects: WrappedProject[];
  max_projs_day: number;
  night_share: number;
  first_day: string;
  achievements: WrappedAchievement[];
  period: string;
}

export interface DashboardPayload {
  daily: DailyCost[];
  models: ModelCost[];
  provider_models: ModelCost[];
  wrapped: WrappedData;
}

function isObj(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(v: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(v * factor) / factor;
}

const round2 = (v: number): number => round(v, 2);
const round3 = (v: number): number => round(v, 3);

/** 对应 _period_cutoff()：区间起点日（周一 / 月初 / 年初），all 无起点 */
export function periodCutoff(period = "all", today = new Date()): string | null {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (period === "1d") return iso(today);
  if (period === "7d") {
    // getDay() 周日=0，Python 的 weekday() 周一=0
    const sinceMonday = (today.getDay() + 6) % 7;
    return iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - sinceMonday));
  }
  if (period === "30d") return iso(new Date(today.getFullYear(), today.getMonth(), 1));
  if (period === "365d") return iso(new Date(today.getFullYear(), 0, 1));
  return null;
}

/** 对应 _gemini_token_total()：input 已含 cached，thoughts 按输出计 */
export function geminiTokenTotal(day: Record<string, any>): number {
  const inputTotal = num(day.in);
  const cached = Math.min(num(day.cached), inputTotal);
  return Math.max(inputTotal - cached, 0) + cached + num(day.out) + num(day.thoughts);
}

/** Muse Code 的推理并进输出（对应 _muse_token_total） */
function museTokenTotal(usage: Record<string, any>): number {
  return num(usage.in) + num(usage.out) + num(usage.cr) + num(usage.cw);
}

/** OpenClaw 的 reasoning 已含在 output 里（对应 _openclaw_token_total） */
function openclawTotal(usage: Record<string, any>): number {
  return openclawTokenTotal({ in: num(usage.in), out: num(usage.out), cr: num(usage.cr), cw: num(usage.cw) });
}

/**
 * 偏差 2：gemini 日账没有成本。Python 在扫描时就按
 * max(in-cached,0)×p.in + cached×p.cache_read + (out+thoughts)×p.out 记进日账
 * （4658-4661），这里用同一条公式补：逐模型算，日级取各模型之和（公式对事件线性，
 * 所以与 Python 逐事件累加的结果相同）。已有成本的条目一律尊重原值，不重复估价。
 */
export function priceGeminiDays(days: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [dayKey, raw] of Object.entries(days ?? {})) {
    if (!isObj(raw)) continue;
    const day = { ...raw };
    const models: Record<string, any> = {};
    let dayCost = num(day.cost);
    let priced = false;
    for (const [model, usage] of Object.entries<any>(day.models ?? {})) {
      if (!isObj(usage)) continue;
      const mv = { ...usage };
      if (!mv.cost) {
        const price = geminiPrice(model);
        const cached = Math.min(num(mv.cached), num(mv.in));
        mv.cost = (Math.max(num(mv.in) - cached, 0) / 1e6) * price.in
          + (cached / 1e6) * price.cache_read
          + ((num(mv.out) + num(mv.thoughts)) / 1e6) * price.out;
        priced = true;
      }
      models[model] = mv;
    }
    if (priced) dayCost = Object.values(models).reduce((sum, mv) => sum + num(mv.cost), 0);
    day.models = models;
    day.cost = dayCost;
    out[dayKey] = day;
  }
  return out;
}

function serializable(value: any): any {
  if (Array.isArray(value)) return value.map(serializable);
  if (value instanceof Set) return [...value].map(serializable).sort();
  if (isObj(value)) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[String(k)] = serializable(v);
    return out;
  }
  return value;
}

/** 对应 _cache_dashboard_days()：内容变了才写，顺带标脏 */
export function cacheDashboardDays(cache: Record<string, any>, key: string, days: unknown): void {
  const payload = serializable(isObj(days) ? days : {});
  if (JSON.stringify(cache[key] ?? null) !== JSON.stringify(payload)) {
    cache[key] = payload;
    cache._dirty = true;
  }
}

/** 对应 _merge_dashboard_days()：本轮没有读数也保留历史天（grok bot 断网时用） */
export function mergeDashboardDays(cache: Record<string, any>, key: string, days: unknown): void {
  if (!isObj(days) || !Object.keys(days).length) return;
  const existing = isObj(cache[key]) ? { ...cache[key] } : {};
  cacheDashboardDays(cache, key, { ...existing, ...days });
}

/** 对应 _iter_cached_token_days()：days 字典 + 单条 day（老形状） */
function* iterCachedTokenDays(toolCache: Record<string, any> | undefined | null): Generator<[string, Record<string, any>]> {
  for (const entry of Object.values(toolCache ?? {})) {
    if (!isObj(entry)) continue;
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (isObj(day)) yield [dayKey, day];
    }
    if (isObj(entry.day) && entry.day.date) yield [String(entry.day.date), entry.day];
  }
}

/** 对应 _codex_accounted_days()：按模型把每个缓存日拆成主额度/Reserve 两份再合并，账本高水位兜底 */
export function codexAccountedDays(cache: Record<string, any>, reserve = false): Record<string, DayRecord> {
  const live: Record<string, DayRecord> = {};
  for (const entry of Object.values<any>(cache.codex ?? {})) {
    if (!isObj(entry)) continue;
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day)) continue;
      const [main, reserveDay] = codexSplitDay(day);
      const selected = reserve ? reserveDay : main;
      if (!codexDayHasUsage(selected)) continue;
      live[dayKey] = ledgerValues(live[dayKey] ?? {}, selected as unknown as DayRecord);
    }
  }
  const tool = reserve ? "codex_reserve" : "codex";
  for (const [dayKey, kept] of Object.entries<any>((loadLedger().tools?.[tool]) ?? {})) {
    if (!(dayKey in live) || ledgerDayTotal(kept) >= ledgerDayTotal(live[dayKey])) live[dayKey] = kept;
  }
  return live;
}

/** 对应 _cny_breakdown()：只有原生人民币计价的两个工具，不做汇率换算 */
export function cnyBreakdown(
  cache: Record<string, any>,
  cutoff: string | null = null,
): { daily: Record<string, number>; models: Record<string, number>; dailyTools: Record<string, Record<string, number>> } {
  const byTool: Record<string, Record<string, Record<string, number>>> = { deepseek_harness: {}, opencode: {} };
  for (const [, , record] of iterHarnessRecords(isObj(cache.deepseek_harness) ? cache.deepseek_harness : {})) {
    const day = (byTool.deepseek_harness[record.date] ??= {});
    const model = String(record.model ?? "");
    day[model] = (day[model] ?? 0) + num(record.cost_cny);
  }
  for (const [dayKey, record] of iterCachedTokenDays(cache.opencode)) {
    const day = (byTool.opencode[dayKey] ??= {});
    for (const [model, mv] of Object.entries<any>(isObj(record.models) ? record.models : {})) {
      if (!isObj(mv)) continue;
      day[model] = (day[model] ?? 0) + num(mv.cost_cny);
    }
  }
  const ledgerTools = isObj(loadLedger().tools) ? loadLedger().tools! : {};
  for (const tool of Object.keys(byTool)) {
    const days = byTool[tool];
    for (const [dayKey, record] of Object.entries<any>(isObj(ledgerTools[tool]) ? ledgerTools[tool] : {})) {
      if (!isObj(record) || !Object.prototype.hasOwnProperty.call(record, "cost_cny")) continue;
      const fromLedger: Record<string, number> = {};
      for (const [model, mv] of Object.entries<any>(isObj(record.models) ? record.models : {})) {
        fromLedger[model] = num(isObj(mv) ? mv.cost_cny : 0);
      }
      days[dayKey] = fromLedger;
    }
  }

  const daily: Record<string, number> = {};
  const models: Record<string, number> = {};
  const dailyTools: Record<string, Record<string, number>> = {};
  for (const tool of Object.keys(byTool)) {
    for (const [dayKey, amounts] of Object.entries(byTool[tool])) {
      if (cutoff && dayKey < cutoff) continue;
      const sum = Object.values(amounts).reduce((s, v) => s + v, 0);
      daily[dayKey] = (daily[dayKey] ?? 0) + sum;
      (dailyTools[dayKey] ??= {})[tool] = (dailyTools[dayKey]?.[tool] ?? 0) + sum;
      for (const [model, amount] of Object.entries(amounts)) {
        const key = `${tool}\u0000${niceModel(model)}`;
        models[key] = (models[key] ?? 0) + amount;
      }
    }
  }
  return { daily, models, dailyTools };
}

interface DayAcc {
  claude: number; codex: number; codex_reserve: number; gemini: number; grok: number;
  zcode: number; mimocode: number; devin: number; minimax: number; pi: number;
  workbuddy: number; workbuddy_ai: number; codebuddy: number; deepseek_harness: number;
  opencode: number; qwencode: number; kimicode: number; musecode: number; cmdcode: number;
  prime_agent: number; hermes: number; openclaw: number;
  c_in: number; c_out: number; c_cr: number; c_cw: number;
  x_in: number; x_out: number; x_cached: number; x_reason: number;
  xr_in: number; xr_out: number; xr_cached: number; xr_reason: number;
  p_in: number; p_out: number; p_cr: number; p_cw: number; p_reason: number;
  pa_in: number; pa_out: number; pa_cr: number; pa_cw: number; pa_reason: number;
  w_in: number; w_out: number; w_cr: number; w_cw: number;
  wa_in: number; wa_out: number; wa_cr: number; wa_cw: number;
  cb_in: number; cb_out: number; cb_cr: number; cb_cw: number; cb_credits: number;
  d_in: number; d_out: number; d_cr: number; d_cw: number; d_reason: number;
  q_in: number; q_out: number; q_cr: number; q_reason: number;
  g_in: number; g_out: number; g_cr: number; g_reason: number;
  tokens: number; sessions: number;
}

function emptyDay(): DayAcc {
  return {
    claude: 0, codex: 0, codex_reserve: 0, gemini: 0, grok: 0,
    zcode: 0, mimocode: 0, devin: 0, minimax: 0, pi: 0,
    workbuddy: 0, workbuddy_ai: 0, codebuddy: 0, deepseek_harness: 0,
    opencode: 0, qwencode: 0, kimicode: 0, musecode: 0, cmdcode: 0,
    prime_agent: 0, hermes: 0, openclaw: 0,
    c_in: 0, c_out: 0, c_cr: 0, c_cw: 0,
    x_in: 0, x_out: 0, x_cached: 0, x_reason: 0,
    xr_in: 0, xr_out: 0, xr_cached: 0, xr_reason: 0,
    p_in: 0, p_out: 0, p_cr: 0, p_cw: 0, p_reason: 0,
    pa_in: 0, pa_out: 0, pa_cr: 0, pa_cw: 0, pa_reason: 0,
    w_in: 0, w_out: 0, w_cr: 0, w_cw: 0,
    wa_in: 0, wa_out: 0, wa_cr: 0, wa_cw: 0,
    cb_in: 0, cb_out: 0, cb_cr: 0, cb_cw: 0, cb_credits: 0,
    d_in: 0, d_out: 0, d_cr: 0, d_cw: 0, d_reason: 0,
    q_in: 0, q_out: 0, q_cr: 0, q_reason: 0,
    g_in: 0, g_out: 0, g_cr: 0, g_reason: 0,
    tokens: 0, sessions: 0,
  };
}

interface ModelAcc {
  cost: number; in: number; out: number; cr: number; cw: number; reason: number;
  credits: number; tool: string;
}

function emptyModelAcc(tool: string): ModelAcc {
  return { cost: 0, in: 0, out: 0, cr: 0, cw: 0, reason: 0, credits: 0, tool };
}

/** 对应 model_tokens()：各工具口径不同，别统一成一个「差不多」的算法 */
function modelTokens(v: ModelAcc): number {
  if (v.tool === "codex" || v.tool === "codex_reserve") return v.in + v.cr + v.out;
  if (v.tool === "openclaw" || v.tool === "musecode") return v.in + v.out + v.cr + v.cw;
  return v.in + v.out + v.cr + v.cw + v.reason;
}

/**
 * 对应 build_daily_costs()：从扫描缓存聚合逐日成本与模型排行。
 * cache 由调用方注入（偏差 1）。
 */
export function buildDailyCosts(cache: Record<string, any>, period = "all", today = new Date()):
  { daily: DailyCost[]; models: ModelCost[]; provider_models: ModelCost[] } {
  const cutoff = periodCutoff(period, today);
  const days: Record<string, DayAcc> = {};
  const models: Record<string, ModelAcc> = {};
  /** {日: {账本工具名: 实时 token}}，供账本逐工具高水位合并 */
  const liveToolTokens: Record<string, Record<string, number>> = {};

  const addDayTokens = (d: DayAcc, dayKey: string, tool: string, amount: number): void => {
    d.tokens += amount;
    const perTool = (liveToolTokens[dayKey] ??= {});
    perTool[tool] = (perTool[tool] ?? 0) + amount;
  };
  const dayFor = (dayKey: string): DayAcc => (days[dayKey] ??= emptyDay());
  const skipped = (dayKey: string): boolean => Boolean(cutoff) && dayKey < (cutoff as string);
  const addModelTokens = (target: ModelAcc, usage: Record<string, any>): void => {
    for (const field of TOKEN_FIELDS) target[field] += num(usage[field]);
  };

  for (const entry of Object.values<any>(cache.claude ?? {})) {
    if (!isObj(entry)) continue;
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const d = dayFor(dayKey);
      d.claude += num(day.cost);
      d.c_in += num(day.in); d.c_out += num(day.out);
      d.c_cr += num(day.cr); d.c_cw += num(day.cw);
      addDayTokens(d, dayKey, "claude", num(day.in) + num(day.out) + num(day.cr) + num(day.cw));
      // 会话数只能来自现存文件；它不进 payload，这里保持与 Python 同样的自增
      d.sessions += 1;
      for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(mv)) continue;
        const name = niceModel(modelName);
        const m = (models[name] ??= emptyModelAcc("claude"));
        m.cost += num(mv.cost);
        m.in += num(mv.in); m.out += num(mv.out); m.cr += num(mv.cr); m.cw += num(mv.cw);
      }
    }
  }

  const codexMain = codexAccountedDays(cache, false);
  for (const [dayKey, day] of Object.entries(codexMain)) {
    if (!isObj(day) || skipped(dayKey)) continue;
    const d = dayFor(dayKey);
    d.codex += num(day.cost);
    d.x_in += num(day.in); d.x_out += num(day.out);
    d.x_cached += num(day.cached); d.x_reason += num(day.reason);
    addDayTokens(d, dayKey, "codex", num(day.in) + num(day.out));
    for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
      if (!isObj(mv)) continue;
      const name = `${niceModel(modelName)} (Codex)`;
      const m = (models[name] ??= emptyModelAcc("codex"));
      m.cost += num(mv.cost);
      addModelTokens(m, mv);
    }
  }

  const codexReserve = codexAccountedDays(cache, true);
  for (const [dayKey, day] of Object.entries(codexReserve)) {
    if (!isObj(day) || skipped(dayKey)) continue;
    const d = dayFor(dayKey);
    d.codex_reserve += num(day.cost);
    d.xr_in += num(day.in); d.xr_out += num(day.out);
    d.xr_cached += num(day.cached); d.xr_reason += num(day.reason);
    addDayTokens(d, dayKey, "codex_reserve", num(day.in) + num(day.out));
    for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
      if (!isObj(mv)) continue;
      const name = `${niceModel(modelName)} (Codex Reserve)`;
      const m = (models[name] ??= emptyModelAcc("codex_reserve"));
      m.cost += num(mv.cost);
      addModelTokens(m, mv);
    }
  }

  const geminiDays = isObj(cache[GEMINI_DAYS_CACHE_KEY]) ? cache[GEMINI_DAYS_CACHE_KEY] : {};
  for (const [dayKey, day] of Object.entries<any>(geminiDays)) {
    if (!isObj(day) || skipped(dayKey)) continue;
    const d = dayFor(dayKey);
    d.gemini += num(day.cost);
    addDayTokens(d, dayKey, "gemini", geminiTokenTotal(day));
    for (const [modelName, usage] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
      if (!isObj(usage)) continue;
      const cached = Math.min(num(usage.cached), num(usage.in));
      const name = `${niceModel(modelName)} (Gemini)`;
      const m = (models[name] ??= emptyModelAcc("gemini"));
      m.cost += num(usage.cost);
      m.in += Math.max(num(usage.in) - cached, 0);
      m.out += num(usage.out);
      m.cr += cached;
      m.reason += num(usage.thoughts);
    }
  }

  for (const entry of Object.values<any>(cache.prime_agent ?? {})) {
    if (!isObj(entry)) continue;
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const d = dayFor(dayKey);
      d.prime_agent += num(day.cost);
      d.pa_in += num(day.in); d.pa_out += num(day.out);
      d.pa_cr += num(day.cr); d.pa_cw += num(day.cw); d.pa_reason += num(day.reason);
      d.tokens += tokenTotal(day);
      for (const [modelName, usage] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(usage)) continue;
        const name = `${niceModel(modelName)} (Prime Agent)`;
        const m = (models[name] ??= emptyModelAcc("prime_agent"));
        m.cost += num(usage.cost);
        addModelTokens(m, usage);
      }
    }
  }

  const grokDays = isObj(cache[GROK_DAYS_CACHE_KEY]) ? cache[GROK_DAYS_CACHE_KEY] : {};
  for (const [dayKey, day] of Object.entries<any>(grokDays)) {
    if (!isObj(day) || skipped(dayKey)) continue;
    const d = dayFor(dayKey);
    d.grok += num(day.cost);
    d.g_in += num(day.in); d.g_out += num(day.out);
    d.g_cr += num(day.cr); d.g_reason += num(day.reason);
    addDayTokens(d, dayKey, "grok", tokenTotal(day));
    for (const [modelName, usage] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
      if (!isObj(usage)) continue;
      const name = `${niceModel(modelName)} (Grok Build)`;
      const m = (models[name] ??= emptyModelAcc("grok"));
      m.cost += num(usage.cost);
      addModelTokens(m, usage);
    }
  }

  for (const entry of Object.values<any>(cache.pi ?? {})) {
    if (!isObj(entry)) continue;
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const d = dayFor(dayKey);
      d.pi += num(day.cost);
      d.p_in += num(day.in); d.p_out += num(day.out);
      d.p_cr += num(day.cr); d.p_cw += num(day.cw); d.p_reason += num(day.reason);
      addDayTokens(d, dayKey, "pi", tokenTotal(day));
      for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(mv)) continue;
        const name = `${niceModel(modelName)} (Pi)`;
        const m = (models[name] ??= emptyModelAcc("pi"));
        m.cost += num(mv.cost);
        addModelTokens(m, mv);
      }
    }
  }

  for (const [dayKey, day] of iterCachedTokenDays(cache.opencode)) {
    if (skipped(dayKey)) continue;
    const d = dayFor(dayKey);
    d.opencode += num(day.cost);
    addDayTokens(d, dayKey, "opencode", tokenTotal(day));
    for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
      if (!isObj(mv)) continue;
      const name = `${niceModel(modelName)} (OpenCode)`;
      const m = (models[name] ??= emptyModelAcc("opencode"));
      m.cost += num(mv.cost);
      addModelTokens(m, mv);
    }
  }

  for (const [toolKey, suffix] of [["zcode", "ZCode"], ["mimocode", "MiMoCode"], ["devin", "Devin"], ["minimax", "MiniMax Code"]] as const) {
    for (const [dayKey, day] of iterCachedTokenDays(cache[toolKey])) {
      if (skipped(dayKey)) continue;
      const d = dayFor(dayKey);
      d[toolKey] += num(day.cost);
      addDayTokens(d, dayKey, toolKey, tokenTotal(day));
      for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(mv)) continue;
        const name = `${niceModel(modelName)} (${suffix})`;
        const m = (models[name] ??= emptyModelAcc(toolKey));
        m.cost += num(mv.cost);
        addModelTokens(m, mv);
      }
    }
  }

  const workbuddyTrio: Array<[string, string, string, (fc: Record<string, any>) => Array<[string, any, Record<string, any>]>]> = [
    ["workbuddy", "w", "WorkBuddy", iterWorkBuddyRecords],
    ["workbuddy_ai", "wa", "WorkBuddy Intl.", iterWorkBuddyRecords],
    // 偏差：Windows 的 CodeBuddy 缓存形状与国内版不同，走 iterCodebuddyRecords（与足迹页同源）
    ["codebuddy", "cb", "CodeBuddy", iterCodebuddyRecords],
  ];
  for (const [toolKey, prefix, suffix, iterate] of workbuddyTrio) {
    for (const [, , record] of iterate(isObj(cache[toolKey]) ? cache[toolKey] : {})) {
      const dayKey = String(record.date ?? "");
      if (!dayKey || skipped(dayKey)) continue;
      const d = dayFor(dayKey);
      d[toolKey as keyof DayAcc] += num(record.cost);
      d[`${prefix}_in` as keyof DayAcc] += num(record.in);
      d[`${prefix}_out` as keyof DayAcc] += num(record.out);
      d[`${prefix}_cr` as keyof DayAcc] += num(record.cr);
      d[`${prefix}_cw` as keyof DayAcc] += num(record.cw);
      if (toolKey === "codebuddy") d.cb_credits += num(record.credits);
      addDayTokens(d, dayKey, toolKey, tokenTotal(record));
      const name = `${niceModel(record.model || "unknown")} (${suffix})`;
      const m = (models[name] ??= emptyModelAcc(toolKey));
      m.cost += num(record.cost);
      addModelTokens(m, record);
      m.credits += num(record.credits);
    }
  }

  for (const [, , record] of iterHarnessRecords(isObj(cache.deepseek_harness) ? cache.deepseek_harness : {})) {
    const dayKey = String(record.date ?? "");
    if (!dayKey || skipped(dayKey)) continue;
    const d = dayFor(dayKey);
    d.deepseek_harness += num(record.cost);
    d.d_in += num(record.in); d.d_out += num(record.out);
    d.d_cr += num(record.cr); d.d_cw += num(record.cw); d.d_reason += num(record.reason);
    addDayTokens(d, dayKey, "deepseek_harness", tokenTotal(record));
    const name = `${niceModel(record.model || "deepseek-v4-pro")} (DeepSeek Harness)`;
    const m = (models[name] ??= emptyModelAcc("deepseek_harness"));
    m.cost += num(record.cost);
    addModelTokens(m, record);
  }

  for (const entry of (isObj(cache.qwencode) ? cache.qwencode.entries : []) ?? []) {
    if (!isObj(entry)) continue;
    const dayKey = String(entry.date ?? "");
    if (!dayKey || skipped(dayKey)) continue;
    const d = dayFor(dayKey);
    d.qwencode += num(entry.cost);
    d.q_in += num(entry.in); d.q_out += num(entry.out);
    d.q_cr += num(entry.cr); d.q_reason += num(entry.reason);
    addDayTokens(d, dayKey, "qwencode", tokenTotal(entry));
    for (const [modelName, mv] of Object.entries<any>(isObj(entry.models) ? entry.models : {})) {
      if (!isObj(mv)) continue;
      const name = `${niceModel(modelName)} (Qwen Code)`;
      const m = (models[name] ??= emptyModelAcc("qwencode"));
      m.cost += num(mv.cost);
      addModelTokens(m, mv);
    }
  }

  for (const entry of Object.values<any>(cache.kimicode ?? {})) {
    if (!isObj(entry)) continue;
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const d = dayFor(dayKey);
      addDayTokens(d, dayKey, "kimicode", tokenTotal(day));
      for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(mv)) continue;
        const name = `${niceModel(modelName)} (Kimi Code)`;
        const m = (models[name] ??= emptyModelAcc("kimicode"));
        addModelTokens(m, mv);
      }
    }
  }

  for (const entry of Object.values<any>(cache.musecode ?? {})) {
    if (!isObj(entry)) continue;
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const d = dayFor(dayKey);
      d.musecode += num(day.cost);
      addDayTokens(d, dayKey, "musecode", museTokenTotal(day));
      for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(mv)) continue;
        const name = `${niceModel(modelName)} (Muse Code)`;
        const m = (models[name] ??= emptyModelAcc("musecode"));
        m.cost += num(mv.cost);
        addModelTokens(m, mv);
      }
    }
  }

  for (const entry of Object.values<any>(cache.cmdcode ?? {})) {
    if (!isObj(entry)) continue;
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const d = dayFor(dayKey);
      d.cmdcode += num(day.cost);
      addDayTokens(d, dayKey, "cmdcode", tokenTotal(day));
      for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(mv)) continue;
        const name = `${niceModel(modelName)} (Command Code)`;
        const m = (models[name] ??= emptyModelAcc("cmdcode"));
        m.cost += num(mv.cost);
        addModelTokens(m, mv);
      }
    }
  }

  for (const entry of Object.values<any>(cache.hermes ?? {})) {
    if (!isObj(entry)) continue;
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const d = dayFor(dayKey);
      d.hermes += num(day.cost);
      addDayTokens(d, dayKey, "hermes", tokenTotal(day));
      for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(mv)) continue;
        const name = `${niceModel(modelName)} (Hermes)`;
        const m = (models[name] ??= emptyModelAcc("hermes"));
        m.cost += num(mv.cost);
        addModelTokens(m, mv);
      }
    }
  }

  const openclawSelected = isObj(cache.openclaw) ? cache.openclaw._selected_days : null;
  for (const [dayKey, day] of Object.entries<any>(isObj(openclawSelected) ? openclawSelected : {})) {
    if (!isObj(day) || skipped(dayKey)) continue;
    const d = dayFor(dayKey);
    d.openclaw += num(day.cost);
    addDayTokens(d, dayKey, "openclaw", openclawTotal(day));
    for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
      if (!isObj(mv)) continue;
      const name = `${niceModel(modelName)} (OpenClaw)`;
      const m = (models[name] ??= emptyModelAcc("openclaw"));
      m.cost += num(mv.cost);
      addModelTokens(m, mv);
    }
  }

  // QoderWork：Python 的缓存键是 qoder，Windows 用 qoderwork（扫描器写入的键）
  for (const entry of Object.values<any>(cache.qoderwork ?? {})) {
    if (!isObj(entry)) continue;
    const modelName = entry.model || "QoderWork";
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const d = dayFor(dayKey);
      const inputTokens = num(day.in);
      const outputTokens = num(day.out);
      addDayTokens(d, dayKey, "qoderwork", inputTokens + outputTokens);
      const name = `${niceModel(modelName)} (QoderWork)`;
      const m = (models[name] ??= emptyModelAcc("qoderwork"));
      m.in += inputTokens;
      m.out += outputTokens;
    }
  }

  for (const entry of Object.values<any>(cache.qoder_ide ?? {})) {
    if (!isObj(entry)) continue;
    const modelName = entry.model || "Qoder";
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const d = dayFor(dayKey);
      const inputTotal = num(day.in);
      const cached = num(day.cached);
      const output = num(day.out);
      addDayTokens(d, dayKey, "qoder_ide", inputTotal + output);
      const name = `${niceModel(modelName)} (Qoder)`;
      const m = (models[name] ??= emptyModelAcc("qoder"));
      m.in += Math.max(inputTotal - cached, 0);
      m.out += output;
      m.cr += cached;
    }
  }

  for (const [qcliTool, qcliLabel] of [["qodercli", "Qoder CLI"], ["qodercli_cn", "Qoder CN"]] as const) {
    const toolCache = cache[qcliTool];
    if (!isObj(toolCache)) continue;
    for (const [dayKey, day] of Object.entries(qoderCliUsageDays(toolCache, true))) {
      if (skipped(dayKey)) continue;
      const d = dayFor(dayKey);
      addDayTokens(d, dayKey, qcliTool, tokenTotal(day));
      for (const [modelName, usage] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(usage)) continue;
        const name = `${niceModel(modelName)} (${qcliLabel})`;
        const m = (models[name] ??= emptyModelAcc(qcliTool));
        for (const field of ["in", "out", "cr", "cw"] as const) m[field] += num(usage[field]);
      }
    }
  }

  // --- 持久账本高水位合并：逐工具逐日取 max，被清理的历史天由账本兜底补进序列 ---
  // 同一份数据的存档与实时绝不相加：cost 与该工具当日成本列取 max；
  // tokens 只补「账本白名单 token 超出该工具当日实时 token」的差额。
  const ledgerTools = isObj(loadLedger().tools) ? loadLedger().tools! : {};
  for (const [tool, toolDays] of Object.entries<any>(ledgerTools)) {
    if (!isObj(toolDays)) continue;
    const column: keyof DayAcc | null = LEDGER_COST_COLUMNS.has(tool)
      ? (tool as keyof DayAcc) : null;
    for (const [dayKey, day] of Object.entries<any>(toolDays)) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const ledgerTok = ledgerTokenSum(day, tool);
      const rawCost = day.cost;
      const ledgerCost = typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : 0;
      const rawCredits = day.credits;
      const ledgerCredits = typeof rawCredits === "number" && Number.isFinite(rawCredits) ? rawCredits : 0;
      if (ledgerTok <= 0 && ledgerCost <= 0 && ledgerCredits <= 0) continue;
      const d = dayFor(dayKey);
      const liveTok = liveToolTokens[dayKey]?.[tool] ?? 0;
      if (ledgerTok > liveTok) d.tokens += ledgerTok - liveTok;
      if (column && ledgerCost > d[column]) d[column] = ledgerCost;
      if (tool === "codebuddy" && ledgerCredits > d.cb_credits) d.cb_credits = ledgerCredits;
    }
  }

  const dayList = Object.values(days);
  const codexTotal = dayList.reduce((s, d) => s + d.codex, 0);
  const codexIn = dayList.reduce((s, d) => s + d.x_in, 0);
  const codexOut = dayList.reduce((s, d) => s + d.x_out, 0);
  const codexReason = dayList.reduce((s, d) => s + d.x_reason, 0);
  if (codexTotal > 0 && !Object.values(models).some((v) => v.tool === "codex")) {
    models["GPT-5.5 (Codex)"] = {
      cost: round2(codexTotal), in: codexIn, out: codexOut, cr: 0, cw: 0, reason: codexReason, credits: 0, tool: "codex",
    };
  }
  const reserveTotal = dayList.reduce((s, d) => s + d.codex_reserve, 0);
  if (reserveTotal > 0 && !Object.values(models).some((v) => v.tool === "codex_reserve")) {
    models["Luna Reserve (Codex Reserve)"] = {
      cost: round2(reserveTotal),
      in: dayList.reduce((s, d) => s + d.xr_in - d.xr_cached, 0),
      out: dayList.reduce((s, d) => s + d.xr_out, 0),
      cr: dayList.reduce((s, d) => s + d.xr_cached, 0),
      cw: 0,
      reason: dayList.reduce((s, d) => s + d.xr_reason, 0),
      credits: 0,
      tool: "codex_reserve",
    };
  }

  const daily: DailyCost[] = Object.entries(days)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dayKey, v]) => ({
      date: dayKey,
      claude: round2(v.claude), codex: round2(v.codex), codex_reserve: round2(v.codex_reserve),
      gemini: round2(v.gemini), grok: round2(v.grok),
      hermes: round2(v.hermes), openclaw: round2(v.openclaw),
      zcode: round2(v.zcode), mimocode: round2(v.mimocode), devin: round2(v.devin), minimax: round2(v.minimax),
      pi: round2(v.pi),
      workbuddy: round2(v.workbuddy), workbuddy_ai: round2(v.workbuddy_ai), codebuddy: round2(v.codebuddy),
      deepseek_harness: round2(v.deepseek_harness),
      qwencode: round2(v.qwencode), kimicode: round2(v.kimicode), musecode: round2(v.musecode),
      cmdcode: round2(v.cmdcode), prime_agent: round2(v.prime_agent),
      total: round2(v.claude + v.codex + v.codex_reserve + v.gemini + v.grok + v.zcode
        + v.mimocode + v.pi + v.workbuddy + v.workbuddy_ai + v.codebuddy + v.deepseek_harness
        + v.opencode + v.qwencode + v.kimicode + v.musecode + v.cmdcode + v.prime_agent + v.hermes
        + v.openclaw + v.devin + v.minimax),
      c_in: v.c_in, c_out: v.c_out, c_cr: v.c_cr, c_cw: v.c_cw,
      x_in: v.x_in, x_out: v.x_out, x_cached: v.x_cached, x_reason: v.x_reason,
      xr_in: v.xr_in, xr_out: v.xr_out, xr_cached: v.xr_cached, xr_reason: v.xr_reason,
      p_in: v.p_in, p_out: v.p_out, p_cr: v.p_cr, p_cw: v.p_cw, p_reason: v.p_reason,
      pa_in: v.pa_in, pa_out: v.pa_out, pa_cr: v.pa_cr, pa_cw: v.pa_cw, pa_reason: v.pa_reason,
      w_in: v.w_in, w_out: v.w_out, w_cr: v.w_cr, w_cw: v.w_cw,
      wa_in: v.wa_in, wa_out: v.wa_out, wa_cr: v.wa_cr, wa_cw: v.wa_cw,
      cb_in: v.cb_in, cb_out: v.cb_out, cb_cr: v.cb_cr, cb_cw: v.cb_cw,
      cb_credits: round3(v.cb_credits),
      d_in: v.d_in, d_out: v.d_out, d_cr: v.d_cr, d_cw: v.d_cw, d_reason: v.d_reason,
      q_in: v.q_in, q_out: v.q_out, q_cr: v.q_cr, q_reason: v.q_reason,
      g_in: v.g_in, g_out: v.g_out, g_cr: v.g_cr, g_reason: v.g_reason,
      tokens: v.tokens,
      cost_cny: 0,
      cny_by_tool: {},
    }));

  const modelList: ModelCost[] = Object.entries(models)
    .sort(([, a], [, b]) => (b.cost - a.cost) || (modelTokens(b) - modelTokens(a)))
    .map(([name, v]) => {
      const totalTok = modelTokens(v);
      if (v.cost <= 0 && totalTok <= 0) return null;
      const outK = v.out ? v.out / 1000 : 0;
      const row: ModelCost = {
        name,
        cost: round2(v.cost),
        in: v.in, out: v.out, cr: v.cr, cw: v.cw, reason: v.reason,
        credits: round3(v.credits),
        tokens: totalTok,
        tool: v.tool,
        cost_per_k: outK > 0 ? round3(v.cost / outK) : 0,
        out_ratio: totalTok > 0 ? round(v.out / totalTok * 100, 1) : 0,
        cost_cny: 0,
      };
      return row;
    })
    .filter((row): row is ModelCost => row !== null);

  const accountModelRows = (specs: Array<[string, string, string | null]>): ModelCost[] => {
    const aggregated: Record<string, ModelAcc & { name: string; tokens: number }> = {};
    for (const [cacheKey, tool, suffix] of specs) {
      const daysOfTool = isObj(cache[cacheKey]) ? cache[cacheKey] : {};
      for (const [dayKey, day] of Object.entries<any>(daysOfTool)) {
        if (skipped(dayKey) || !isObj(day)) continue;
        for (const [rawName, rawUsage] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
          if (!isObj(rawUsage)) continue;
          const displayName = niceModel(rawName);
          const name = suffix ? `${displayName} (${suffix})` : displayName;
          const model = (aggregated[name] ??= {
            ...emptyModelAcc(tool), name, tokens: 0,
          });
          const components = {} as Record<(typeof TOKEN_FIELDS)[number], number>;
          for (const field of TOKEN_FIELDS) components[field] = providerUsageInt(rawUsage[field]);
          const declared = providerUsageInt(rawUsage.tokens);
          model.tokens += declared || TOKEN_FIELDS.reduce((s, f) => s + components[f], 0);
          for (const field of TOKEN_FIELDS) model[field] += components[field];
          const cost = providerNumber(rawUsage.cost) ?? 0;
          if (cost >= 0) model.cost += cost;
        }
      }
    }
    return Object.values(aggregated)
      .sort((a, b) => (b.tokens - a.tokens) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((model) => {
        const outK = model.out ? model.out / 1000 : 0;
        return {
          name: model.name,
          cost: round2(model.cost),
          in: model.in, out: model.out, cr: model.cr, cw: model.cw, reason: model.reason,
          tokens: model.tokens,
          tool: model.tool,
          cost_per_k: outK > 0 ? round3(model.cost / outK) : 0,
          out_ratio: model.tokens > 0 ? round(model.out / model.tokens * 100, 1) : 0,
          cost_cny: 0,
        };
      });
  };

  const grokBotRows = accountModelRows([[GROK_BOT_PROVIDER_DAYS_CACHE_KEY, "grok_bot", null]]);
  modelList.push(...grokBotRows);
  const providerModelList = accountModelRows([
    [CURSOR_PROVIDER_DAYS_CACHE_KEY, "cursor", "Cursor 账号"],
    [ZAI_PROVIDER_DAYS_CACHE_KEY, "zai", "z.ai 账号"],
  ]);

  const cny = cnyBreakdown(cache, cutoff);
  for (const day of daily) {
    day.cost_cny = cny.daily[day.date] ?? 0;
    day.cny_by_tool = cny.dailyTools[day.date] ?? {};
  }
  const attachCny = (rows: ModelCost[]): void => {
    for (const model of rows) {
      const baseName = model.name.includes(" (") ? model.name.slice(0, model.name.lastIndexOf(" (")) : model.name;
      model.cost_cny = cny.models[`${model.tool}\u0000${baseName}`] ?? 0;
    }
  };
  attachCny(modelList);
  attachCny(providerModelList);

  return { daily, models: modelList, provider_models: providerModelList };
}

/** 对应 _streak_info()：最长连续 / 当前连续（当前只有最近活跃日是今昨才算连着） */
function dayNumber(iso: string): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function streakInfo(dates: string[], todayIso: string): [number, number] {
  if (!dates.length) return [0, 0];
  const ds = [...dates].sort();
  let maxRun = 1;
  let run = 1;
  for (let i = 1; i < ds.length; i++) {
    run = (dayNumber(ds[i]) - dayNumber(ds[i - 1])) / 86400000 === 1 ? run + 1 : 1;
    if (run > maxRun) maxRun = run;
  }
  let cur = 0;
  if ((dayNumber(todayIso) - dayNumber(ds[ds.length - 1])) / 86400000 <= 1) {
    cur = 1;
    for (let i = ds.length - 1; i > 0; i--) {
      if ((dayNumber(ds[i]) - dayNumber(ds[i - 1])) / 86400000 === 1) cur += 1;
      else break;
    }
  }
  return [maxRun, cur];
}

function todayIso(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Python 的 os.path.basename(路径去尾分隔符)，空则回退 */
function projectBaseName(raw: unknown, fallback: string): string {
  const trimmed = String(raw ?? "").replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop() || "";
  return base || fallback;
}

/**
 * 对应 build_wrapped()：作息 / 项目 / 连续 / 成就，汇总全部工具，不联网。
 * cache 由调用方注入（偏差 1）。
 */
export function buildWrapped(cache: Record<string, any>, period = "all", now = new Date()): WrappedData {
  const cutoff = periodCutoff(period, now);
  const hours = new Array(24).fill(0);
  const weekday = new Array(7).fill(0);
  const dayTokens: Record<string, number> = {};
  const dayCost: Record<string, number> = {};
  const projTok = new Map<string, [number, number]>();
  const projCny = new Map<string, number>();
  const dayProjs = new Map<string, Set<string>>();
  const modelTok = new Map<string, number>();
  const allDayHours = new Set<string>();

  const addDayToken = (dayKey: string, amount: number): void => {
    dayTokens[dayKey] = (dayTokens[dayKey] ?? 0) + amount;
  };
  const addDayCost = (dayKey: string, amount: number): void => {
    dayCost[dayKey] = (dayCost[dayKey] ?? 0) + amount;
  };
  const addWeekday = (dayKey: string, amount: number): void => {
    // Python 用 date.weekday()（周一=0）；1970-01-01 是周四，所以纪元日 +3 再取模
    const dow = (dayNumber(dayKey) / 86400000 + 3) % 7;
    weekday[Math.trunc(dow)] += amount;
  };
  const addHours = (dayKey: string, values: unknown): void => {
    if (!Array.isArray(values) || values.length !== 24) return;
    values.forEach((raw, hour) => {
      const amount = Math.trunc(num(raw));
      hours[hour] += amount;
      if (amount) allDayHours.add(`${dayKey}:${hour}`);
    });
  };
  const addHour = (dayKey: string, hour: unknown, amount: number): void => {
    if (typeof hour === "number" && hour >= 0 && hour < 24) {
      hours[hour] += amount;
      allDayHours.add(`${dayKey}:${hour}`);
    }
  };
  const addProject = (project: string, tokens: number, cost: number): void => {
    const current = projTok.get(project) ?? [0, 0];
    current[0] += tokens;
    current[1] += cost;
    projTok.set(project, current);
  };
  const addDayProject = (dayKey: string, project: string): void => {
    if (!project) return;
    let set = dayProjs.get(dayKey);
    if (!set) { set = new Set(); dayProjs.set(dayKey, set); }
    set.add(project);
  };
  const addModel = (name: string, tokens: number): void => {
    modelTok.set(name, (modelTok.get(name) ?? 0) + tokens);
  };
  const skipped = (dayKey: string): boolean => Boolean(cutoff) && dayKey < (cutoff as string);

  // --- Claude（有 day_hours / proj / models）---
  for (const entry of Object.values<any>(cache.claude ?? {})) {
    if (!isObj(entry)) continue;
    for (const [dayKey, dayHours] of Object.entries<any>(isObj(entry.day_hours) ? entry.day_hours : {})) {
      if (!cutoff || dayKey >= (cutoff as string)) addHours(dayKey, dayHours);
    }
    const project = projectBaseName(entry.proj, "?");
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const tokens = tokenTotal(day);
      addDayToken(dayKey, tokens);
      addDayCost(dayKey, num(day.cost));
      addProject(project, tokens, num(day.cost));
      addDayProject(dayKey, project);
      addWeekday(dayKey, tokens);
      for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(mv)) continue;
        addModel(niceModel(modelName), tokenTotal(mv));
      }
    }
  }

  // --- Codex + Luna Reserve（in 含 cached；out 含 reasoning）---
  for (const [reserve, suffix] of [[false, "Codex"], [true, "Codex Reserve"]] as const) {
    for (const [dayKey, day] of Object.entries(codexAccountedDays(cache, reserve))) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const tokens = num(day.in) + num(day.out);
      addDayToken(dayKey, tokens);
      addDayCost(dayKey, num(day.cost));
      addWeekday(dayKey, tokens);
      addHours(dayKey, day.hours);
      for (const [modelName, usage] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(usage)) continue;
        addModel(`${niceModel(modelName)} (${suffix})`, num(usage.in) + num(usage.cr) + num(usage.out));
      }
    }
  }

  // --- Gemini（input 含 cached，thoughts 按输出 token 计入）---
  for (const [dayKey, day] of Object.entries<any>(isObj(cache[GEMINI_DAYS_CACHE_KEY]) ? cache[GEMINI_DAYS_CACHE_KEY] : {})) {
    if (!isObj(day) || skipped(dayKey)) continue;
    const tokens = geminiTokenTotal(day);
    addDayToken(dayKey, tokens);
    addDayCost(dayKey, num(day.cost));
    addWeekday(dayKey, tokens);
    addHours(dayKey, day.hours);
    for (const [modelName, usage] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
      if (!isObj(usage)) continue;
      addModel(`${niceModel(modelName)} (Gemini)`, geminiTokenTotal(usage));
    }
  }

  // --- Grok Build（unified 日志里的真实 token）---
  for (const [dayKey, day] of Object.entries<any>(isObj(cache[GROK_DAYS_CACHE_KEY]) ? cache[GROK_DAYS_CACHE_KEY] : {})) {
    if (!isObj(day) || skipped(dayKey)) continue;
    const tokens = tokenTotal(day);
    addDayToken(dayKey, tokens);
    addDayCost(dayKey, num(day.cost));
    addWeekday(dayKey, tokens);
    addHours(dayKey, day.hours);
    for (const [modelName, usage] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
      if (!isObj(usage)) continue;
      addModel(`${niceModel(modelName)} (Grok Build)`, tokenTotal(usage));
    }
  }

  // --- Hermes ---
  for (const entry of Object.values<any>(cache.hermes ?? {})) {
    if (!isObj(entry)) continue;
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const tokens = tokenTotal(day);
      addDayToken(dayKey, tokens);
      addDayCost(dayKey, num(day.cost));
      addWeekday(dayKey, tokens);
      addHours(dayKey, day.hours);
      for (const [modelName, usage] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(usage)) continue;
        addModel(`${niceModel(modelName)} (Hermes)`, tokenTotal(usage));
      }
    }
  }

  // --- OpenClaw（reasoning 已含在 output 里）---
  const selectedDays = isObj(cache.openclaw) ? cache.openclaw._selected_days : null;
  for (const [dayKey, day] of Object.entries<any>(isObj(selectedDays) ? selectedDays : {})) {
    if (!isObj(day) || skipped(dayKey)) continue;
    const tokens = openclawTotal(day);
    addDayToken(dayKey, tokens);
    addDayCost(dayKey, num(day.cost));
    addWeekday(dayKey, tokens);
    addHours(dayKey, day.hours);
    for (const [modelName, usage] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
      if (!isObj(usage)) continue;
      addModel(`${niceModel(modelName)} (OpenClaw)`, openclawTotal(usage));
    }
  }

  // --- 逐小时明细型：OpenCode / ZCode / MiMoCode / Devin / MiniMax Code ---
  const hourSources: Array<[Record<string, any> | undefined, string, (day: Record<string, any>) => number]> = [
    [cache.opencode, "OpenCode", tokenTotal],
    [cache.zcode, "ZCode", tokenTotal],
    [cache.mimocode, "MiMoCode", tokenTotal],
    [cache.devin, "Devin", tokenTotal],
    [cache.minimax, "MiniMax Code", tokenTotal],
  ];
  for (const [toolCache, suffix, count] of hourSources) {
    for (const [dayKey, day] of iterCachedTokenDays(toolCache)) {
      if (skipped(dayKey)) continue;
      const tokens = count(day);
      addDayToken(dayKey, tokens);
      addDayCost(dayKey, num(day.cost));
      addWeekday(dayKey, tokens);
      const list = Array.isArray(day.hours) ? day.hours : [];
      for (let hour = 0; hour < Math.min(24, list.length); hour++) {
        const amount = num(list[hour]);
        hours[hour] += amount;
        if (amount) allDayHours.add(`${dayKey}:${hour}`);
      }
      for (const [modelName, usage] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(usage)) continue;
        addModel(`${niceModel(modelName)} (${suffix})`, count(usage));
      }
    }
  }

  // --- Qwen Code（单条请求一个 hour）---
  for (const entry of (isObj(cache.qwencode) ? cache.qwencode.entries : []) ?? []) {
    if (!isObj(entry)) continue;
    const dayKey = String(entry.date ?? "");
    if (!dayKey || skipped(dayKey)) continue;
    const tokens = tokenTotal(entry);
    addDayToken(dayKey, tokens);
    addDayCost(dayKey, num(entry.cost));
    addWeekday(dayKey, tokens);
    addHour(dayKey, entry.hour, tokens);
    for (const [modelName, mv] of Object.entries<any>(isObj(entry.models) ? entry.models : {})) {
      if (!isObj(mv)) continue;
      addModel(`${niceModel(modelName)} (Qwen Code)`, tokenTotal(mv));
    }
  }

  // --- Kimi Code（wire 不落真实成本，与卡片口径一致不记）---
  for (const entry of Object.values<any>(cache.kimicode ?? {})) {
    if (!isObj(entry)) continue;
    const project = projectBaseName(entry.proj, "Kimi Code");
    for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const tokens = tokenTotal(day);
      addDayToken(dayKey, tokens);
      addWeekday(dayKey, tokens);
      addHours(dayKey, day.hours);
      addProject(project, tokens, 0);
      addDayProject(dayKey, project);
      for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(mv)) continue;
        addModel(`${niceModel(modelName)} (Kimi Code)`, tokenTotal(mv));
      }
    }
  }

  // --- Muse Code / Command Code ---
  for (const [toolCache, fallback, suffix, count] of [
    [cache.musecode, "Muse Code", "Muse Code", museTokenTotal],
    [cache.cmdcode, "Command Code", "Command Code", tokenTotal],
  ] as Array<[Record<string, any> | undefined, string, string, (u: Record<string, any>) => number]>) {
    for (const entry of Object.values<any>(toolCache ?? {})) {
      if (!isObj(entry)) continue;
      const project = projectBaseName(entry.proj, fallback);
      for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
        if (!isObj(day) || skipped(dayKey)) continue;
        const tokens = count(day);
        addDayToken(dayKey, tokens);
        addDayCost(dayKey, num(day.cost));
        addWeekday(dayKey, tokens);
        addHours(dayKey, day.hours);
        addProject(project, tokens, num(day.cost));
        addDayProject(dayKey, project);
        for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
          if (!isObj(mv)) continue;
          addModel(`${niceModel(modelName)} (${suffix})`, count(mv));
        }
      }
    }
  }

  // --- Pi / Prime Agent ---
  for (const [toolCache, suffix] of [[cache.pi, "Pi"], [cache.prime_agent, "Prime Agent"]] as const) {
    for (const entry of Object.values<any>(toolCache ?? {})) {
      if (!isObj(entry)) continue;
      for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
        if (!isObj(day) || skipped(dayKey)) continue;
        const tokens = tokenTotal(day);
        addDayToken(dayKey, tokens);
        addDayCost(dayKey, num(day.cost));
        addWeekday(dayKey, tokens);
        addHours(dayKey, day.hours);
        for (const [modelName, mv] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
          if (!isObj(mv)) continue;
          addModel(`${niceModel(modelName)} (${suffix})`, tokenTotal(mv));
        }
      }
    }
  }

  // --- WorkBuddy 国内版与国际版 / CodeBuddy（逐次调用，output 已含 reasoning）---
  const wrappedTrio: Array<[Record<string, any> | undefined, string, (fc: Record<string, any>) => Array<[string, any, Record<string, any>]>]> = [
    [cache.workbuddy, "WorkBuddy", iterWorkBuddyRecords],
    [cache.workbuddy_ai, "WorkBuddy Intl.", iterWorkBuddyRecords],
    [cache.codebuddy, "CodeBuddy", iterCodebuddyRecords],
  ];
  for (const [toolCache, suffix, iterate] of wrappedTrio) {
    for (const [, entry, record] of iterate(isObj(toolCache) ? toolCache : {})) {
      const dayKey = String(record.date ?? "");
      if (!dayKey || skipped(dayKey)) continue;
      const tokens = tokenTotal(record);
      addDayToken(dayKey, tokens);
      addDayCost(dayKey, num(record.cost));
      addWeekday(dayKey, tokens);
      addHour(dayKey, record.hour, tokens);
      const project = projectBaseName(entry?.proj, suffix);
      addProject(project, tokens, num(record.cost));
      addDayProject(dayKey, project);
      addModel(`${niceModel(record.model || "unknown")} (${suffix})`, tokens);
    }
  }

  // --- DeepSeek Harness ---
  for (const [, entry, record] of iterHarnessRecords(isObj(cache.deepseek_harness) ? cache.deepseek_harness : {})) {
    const dayKey = String(record.date ?? "");
    if (!dayKey || skipped(dayKey)) continue;
    const tokens = tokenTotal(record);
    addDayToken(dayKey, tokens);
    addDayCost(dayKey, num(record.cost));
    addWeekday(dayKey, tokens);
    addHour(dayKey, record.hour, tokens);
    const project = projectBaseName(entry?.proj, "DeepSeek Harness");
    addProject(project, tokens, num(record.cost));
    projCny.set(project, (projCny.get(project) ?? 0) + num(record.cost_cny));
    addDayProject(dayKey, project);
    addModel(`${niceModel(record.model || "deepseek-v4-pro")} (DeepSeek Harness)`, tokens);
  }

  // --- QoderWork / Qoder IDE（in + out，无成本）---
  for (const [toolCache, fallback, suffix] of [
    [cache.qoderwork, "QoderWork", "QoderWork"],
    [cache.qoder_ide, "Qoder", "Qoder"],
  ] as const) {
    for (const entry of Object.values<any>(toolCache ?? {})) {
      if (!isObj(entry)) continue;
      const modelName = entry.model || fallback;
      for (const [dayKey, day] of Object.entries<any>(isObj(entry.days) ? entry.days : {})) {
        if (!isObj(day) || skipped(dayKey)) continue;
        const tokens = num(day.in) + num(day.out);
        addDayToken(dayKey, tokens);
        addWeekday(dayKey, tokens);
        addHours(dayKey, day.hours);
        addModel(`${niceModel(modelName)} (${suffix})`, tokens);
      }
    }
  }

  // --- Qoder CLI / Qoder CN（去重后的 transcript 用量，无成本）---
  for (const [tool, label] of [["qodercli", "Qoder CLI"], ["qodercli_cn", "Qoder CN"]] as const) {
    const toolCache = cache[tool];
    if (!isObj(toolCache)) continue;
    for (const [dayKey, day] of Object.entries(qoderCliUsageDays(toolCache, true))) {
      if (skipped(dayKey)) continue;
      const tokens = tokenTotal(day);
      addDayToken(dayKey, tokens);
      addWeekday(dayKey, tokens);
      addHours(dayKey, (day as { hours?: unknown }).hours);
      for (const [modelName, usage] of Object.entries<any>(isObj(day.models) ? day.models : {})) {
        if (!isObj(usage)) continue;
        addModel(`${niceModel(modelName)} (${label})`, tokenTotal(usage));
      }
    }
  }

  // --- 持久账本合并：全部指标统一账本口径 ---
  // 账本是同一份数据的高水位存档：同一天取 max(账本合计, 实时值)，绝不相加以免重复计数。
  // 被清理日志的历史天由账本兜底补回，让 total/active/streak/busiest/peak 同口径。
  for (const [dayKey, names] of Object.entries(projectDayNames(cache))) {
    if (skipped(dayKey)) continue;
    if (names.length) {
      let set = dayProjs.get(dayKey);
      if (!set) { set = new Set(); dayProjs.set(dayKey, set); }
      for (const name of names) set.add(name);
    }
  }

  const ledgerDayTokens: Record<string, number> = {};
  const ledgerDayCost: Record<string, number> = {};
  const ledgerTools = isObj(loadLedger().tools) ? loadLedger().tools! : {};
  for (const [tool, toolDays] of Object.entries<any>(ledgerTools)) {
    if (!isObj(toolDays)) continue;
    for (const [dayKey, day] of Object.entries<any>(toolDays)) {
      if (!isObj(day) || skipped(dayKey)) continue;
      const tokens = ledgerTokenSum(day, tool);
      if (tokens) ledgerDayTokens[dayKey] = (ledgerDayTokens[dayKey] ?? 0) + tokens;
      const cost = day.cost;
      if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
        ledgerDayCost[dayKey] = (ledgerDayCost[dayKey] ?? 0) + cost;
      }
      if (Array.isArray(day.projects)) {
        const names = day.projects.filter((p: unknown) => typeof p === "string" && p) as string[];
        if (names.length) {
          let set = dayProjs.get(dayKey);
          if (!set) { set = new Set(); dayProjs.set(dayKey, set); }
          for (const name of names) set.add(name);
        }
      }
    }
  }
  for (const [dayKey, tokens] of Object.entries(ledgerDayTokens)) {
    dayTokens[dayKey] = Math.max(dayTokens[dayKey] ?? 0, tokens);
  }
  for (const [dayKey, cost] of Object.entries(ledgerDayCost)) {
    dayCost[dayKey] = Math.max(dayCost[dayKey] ?? 0, cost);
  }

  const totalTokens = Object.values(dayTokens).reduce((s, v) => s + v, 0);
  const totalCost = Object.values(dayCost).reduce((s, v) => s + v, 0);

  const active = Object.keys(dayTokens).sort();
  const [streakMax, streakCur] = streakInfo(active, todayIso(now));

  // --- 巅峰日 Top 3：直接取合并后的 dayTokens，与 total/active_days 同一份数据 ---
  const peakDays: WrappedPeakDay[] = Object.entries(dayTokens)
    .sort(([da, a], [db, b]) => (b - a) || (da < db ? -1 : da > db ? 1 : 0))
    .slice(0, 3)
    .filter(([, tokens]) => tokens > 0)
    .map(([dayKey, tokens]) => ({
      date: dayKey,
      tokens,
      projects: [...(dayProjs.get(dayKey) ?? [])].sort().slice(0, 3),
    }));
  const busiest = peakDays.length
    ? { date: peakDays[0].date, tokens: peakDays[0].tokens }
    : { date: "", tokens: 0 };
  const topModelEntry = [...modelTok.entries()].sort((a, b) => b[1] - a[1])[0];
  const topModel = topModelEntry ? { name: topModelEntry[0], tokens: topModelEntry[1] } : { name: "-", tokens: 0 };

  const projects: WrappedProject[] = [...projTok.entries()]
    .map(([name, [tokens, cost]]) => ({
      name,
      tokens,
      cost: round2(cost),
      cost_cny: projCny.get(name) ?? 0,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 8);

  const maxProjsDay = [...dayProjs.values()].reduce((m, s) => Math.max(m, s.size), 0);
  const hoursTotal = hours.reduce((s, v) => s + v, 0);
  const night = hours.slice(0, 6).reduce((s, v) => s + v, 0);
  const nightShare = hoursTotal ? round(night / hoursTotal * 100, 1) : 0;

  const achievements: WrappedAchievement[] = [];
  const add = (icon: string, title: string, desc: string, tint: string, tokens?: number, template?: string): void => {
    // desc 是给中文界面的现成句子；带「亿」的另给原始数和不含单位的模板，
    // 其他语言的界面用 K / M / B 重写数字（「亿」没法靠套模板换算）。
    const item: WrappedAchievement = { icon, title, desc, tint };
    if (tokens !== undefined && template) {
      item.tokens = Math.trunc(tokens);
      item.tokens_template = template;
    }
    achievements.push(item);
  };

  if (totalTokens >= 1_000_000_000_000) {
    add("crown.fill", "万亿先生", `${(totalTokens / 1e12).toFixed(2)} 万亿 token`, "gold", totalTokens, "%@ token");
  } else if (totalTokens >= 100_000_000_000) {
    add("hexagon.fill", "千亿先生", `${(totalTokens / 1e8).toFixed(0)} 亿 token`, "gold", totalTokens, "%@ token");
  } else if (totalTokens >= 10_000_000_000) {
    add("diamond.fill", "百亿先生", `${(totalTokens / 1e8).toFixed(0)} 亿 token`, "gold", totalTokens, "%@ token");
  } else if (totalTokens >= 1_000_000_000) {
    add("diamond", "十亿先生", `${(totalTokens / 1e8).toFixed(1)} 亿 token`, "gold", totalTokens, "%@ token");
  }

  if (totalCost >= 100000) add("dollarsign.circle.fill", "十万刀", `≈$${Math.trunc(totalCost).toLocaleString("en-US")}`, "green");
  else if (totalCost >= 10000) add("banknote.fill", "破万刀", `≈$${Math.trunc(totalCost).toLocaleString("en-US")}`, "green");
  else if (totalCost >= 1000) add("banknote", "破千刀", `≈$${Math.trunc(totalCost).toLocaleString("en-US")}`, "green");

  if (streakMax >= 100) add("flame.fill", "百日筑基", `连续 ${streakMax} 天`, "coral");
  else if (streakMax >= 30) add("flame.fill", "铁人", `连续 ${streakMax} 天`, "coral");
  else if (streakMax >= 7) add("flame.fill", "坚持", `连续 ${streakMax} 天`, "coral");

  if (busiest.tokens >= 1_000_000_000) {
    add("bolt.fill", "爆肝日", `单日 ${(busiest.tokens / 1e8).toFixed(0)} 亿 token`, "coral", busiest.tokens, "单日 %@ token");
  }

  if (maxProjsDay >= 5) add("square.grid.3x3.fill", "多线作战", `单日 ${maxProjsDay} 个项目`, "blue");
  else if (maxProjsDay >= 3) add("square.grid.2x2.fill", "多面手", `单日 ${maxProjsDay} 个项目`, "blue");
  const projTotal = [...projTok.values()].reduce((s, v) => s + v[0], 0);
  const topShare = projTotal
    ? Math.max(...[...projTok.values()].map((v) => v[0])) / projTotal * 100
    : 0;
  if (topShare >= 50) add("scope", "专一", `主项目占 ${topShare.toFixed(0)}%`, "blue");
  if (projTok.size >= 10) add("rectangle.3.group.fill", "广撒网", `${projTok.size} 个项目`, "blue");

  const activeHours = hours.filter((h) => h > 0).length;
  if (activeHours >= 24) add("clock.badge.checkmark.fill", "永动机", "24h 每个时段都有活跃", "purple");
  // Loop 成就：连续 N 天每天 24h 全时段都有 agent 活跃
  const dayHourMap = new Map<string, Set<number>>();
  for (const item of allDayHours) {
    const at = item.lastIndexOf(":");
    const dayKey = item.slice(0, at);
    const hour = Number(item.slice(at + 1));
    let set = dayHourMap.get(dayKey);
    if (!set) { set = new Set(); dayHourMap.set(dayKey, set); }
    set.add(hour);
  }
  const fullDays = [...dayHourMap.entries()].filter(([, hs]) => hs.size >= 24).map(([dk]) => dk).sort();
  let loopStreak = 0;
  if (fullDays.length) {
    let cur = 1;
    for (let i = 1; i < fullDays.length; i++) {
      if ((dayNumber(fullDays[i]) - dayNumber(fullDays[i - 1])) / 86400000 === 1) cur += 1;
      else { loopStreak = Math.max(loopStreak, cur); cur = 1; }
    }
    loopStreak = Math.max(loopStreak, cur);
  }
  if (loopStreak >= 30) add("repeat.circle.fill", "Loop滴神", `连续 ${loopStreak} 天 24/7`, "purple");
  else if (loopStreak >= 3) add("repeat.circle", "Loop Engineering !!", `连续 ${loopStreak} 天 24/7`, "purple");
  if (nightShare >= 5) add("moon.stars.fill", "夜猫子", `${nightShare.toFixed(0)}% 在凌晨`, "purple");
  const morningShare = hoursTotal ? hours.slice(5, 9).reduce((s, v) => s + v, 0) / hoursTotal * 100 : 0;
  if (morningShare >= 12) add("sunrise.fill", "早起鸟", `${morningShare.toFixed(0)}% 在清晨`, "purple");
  const weekdayTotal = weekday.reduce((s, v) => s + v, 0);
  const weekendShare = weekdayTotal ? (weekday[5] + weekday[6]) / weekdayTotal * 100 : 0;
  if (weekendShare >= 30) add("beach.umbrella.fill", "周末战士", `周末占 ${weekendShare.toFixed(0)}%`, "purple");

  if (active.length >= 100) add("calendar", "元老", `${active.length} 天活跃`, "pink");

  const dayProjectsOut: Record<string, string[]> = {};
  for (const [dayKey, set] of dayProjs) {
    if (set.size) dayProjectsOut[dayKey] = [...set].sort().slice(0, 3);
  }

  return {
    total_tokens: totalTokens,
    total_cost: round2(totalCost),
    cost_cny: Object.values(cnyBreakdown(cache, cutoff).daily).reduce((s, v) => s + v, 0),
    active_days: active.length,
    streak_max: streakMax,
    streak_cur: streakCur,
    busiest,
    peak_days: peakDays,
    day_projects: dayProjectsOut,
    top_model: topModel,
    hours,
    weekday,
    projects,
    max_projs_day: maxProjsDay,
    night_share: nightShare,
    first_day: cutoff ?? (active[0] ?? ""),
    achievements,
    period,
  };
}

/** 对应 build_dashboard()：逐日成本 + 模型排行 + 回顾，同一份缓存算两遍 */
export function buildDashboard(cache: Record<string, any>, period = "all", now = new Date()): DashboardPayload {
  const dailyCosts = buildDailyCosts(cache, period, now);
  return { ...dailyCosts, wrapped: buildWrapped(cache, period, now) };
}

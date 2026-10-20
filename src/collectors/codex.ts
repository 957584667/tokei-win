/**
 * Codex 采集器：对应 usage.30s.py 的 scan_codex 及全部 _codex_* 辅助函数。
 * 口径（CALCULATION.md §2）：input_tokens 已含 cached，output_tokens 已含 reasoning，
 * 所以累加字段存 in(含缓存)/cached/out(含推理)/reason，展示时由 codexRange() 再减回去。
 * 成本（§4）：(in-cached)/1M×价_in + cached/1M×价_cache_read + out/1M×价_out，
 * 单条请求输入 >272K 时输入与缓存读 ×2、输出 ×1.5（与 Python _codex_estimated_cost 一致）。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { HOME, existingDirs, isDirectory, isFile, pathCandidates } from "../core/paths";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, parseTs } from "../core/ranges";
import {
  cachedEntryHasPricingChange, hasKnownPrice, modelHasPricingChange, modelIdentityId,
  pricingChangeMultiplier, rawPrice,
} from "../core/price";
import { CodexRangeOut, ModelUsage, addModelUsage, codexRange } from "../core/model";
import {
  DayRecord, codexLegacyDay, ledgerMemo, ledgerReconcile, ledgerSameValue,
  ledgerTouch, ledgerValues, loadLedger,
} from "../core/ledger";

// ---------- 路径解析（对应 Python 的 _path_candidates("TOKEI_CODEX_*", CODEX_*)，每次调用现算，绝不在加载时钉死）----------
export const CODEX_SESSIONS_DEFAULT = path.join(HOME, ".codex", "sessions");
export const CODEX_ARCHIVED_DEFAULT = path.join(HOME, ".codex", "archived_sessions");
export const CODEX_CONFIG_DEFAULT = path.join(HOME, ".codex", "config.toml");

// Python 的 _path_candidates 会把默认根永远追加在 env 之后一起扫；端口改成
// "设了对应 TOKEI_CODEX_* 就只搜这些根"，否则把 TOKEI_CODEX_DIR 指向临时目录也拦不住
// 开发机 ~/.codex 的真实历史混进结果（数值对不上却看不出原因）。未设 env 时与 Python 完全一致。
// config.toml 的 TOKEI_CODEX_CONFIG 是端口新增（Python 用固定常量、无覆盖口），沿用 TOKEI_CODEX_* 命名族。
function codexRoots(envName: string, fallback: string): string[] {
  return process.env[envName] ? pathCandidates(envName) : [fallback];
}
/** Python 只有一个 CODEX_DIR 字符串，这里取"活动目录"候选的第一个 */
export function codexSessionsDir(): string { return codexRoots("TOKEI_CODEX_DIR", CODEX_SESSIONS_DEFAULT)[0]; }
export function codexConfigPath(): string { return codexRoots("TOKEI_CODEX_CONFIG", CODEX_CONFIG_DEFAULT)[0]; }

// ---------- 缓存版本（沿用 Python 的版本号，语义一致）----------
export const CODEX_PARSER_VERSION = 8;
export const CODEX_ACCOUNTING_VERSION = 7;

// ---------- Codex Luna Reserve（Python 804-839 行）----------
// Reserve 是 OpenAI 给 Codex 的第二缸油：主额度见底后会话切到 gpt-reserve，单独计量单独重置。
export const CODEX_RESERVE_MODEL = "gpt-reserve";
export const CODEX_RESERVE_LIMIT_NAMES = ["gpt-reserve"];
export const CODEX_RESERVE_LIMIT_IDS = ["base_model_inference"];
// Reserve 按 Luna 级别计价，不吃 gpt-5.5 兜底。
export const CODEX_RESERVE_PRICE_MODEL = "openai/gpt-5.6-luna";
export const CODEX_NO_PRICE_FALLBACK_MODEL = "openai/gpt-5.5";
const WEEK_MINUTES = 7 * 24 * 60;

const MODEL_RECORD_TYPES = ["turn_context", "session_meta"];
const USAGE_RECORD_MARKERS = ['"token_count"', '"token_usage_record"', '"task_started"', '"turn_context"', '"session_meta"'];
const HEADER_LIMIT = 1024;
const MODEL_LIMIT = 64 * 1024;

// ---------- 数据结构 ----------

/**
 * 一条用量事件，索引与 Python 的 events 列表完全对齐：
 * 0=ts(ISO, 带本地偏移) 1=本地日键 2..5=累计快照(total) 6..9=本次增量(last) 10=成本 11=模型 12=response_id
 */
export type CodexEvent = [
  string, string,
  number | null, number | null, number | null, number | null,
  number, number, number, number,
  number, string | null, string | null,
];

export interface CodexDay {
  /** 含 cached 的输入 */
  in: number;
  cached: number;
  /** 含 reasoning 的输出 */
  out: number;
  reason: number;
  cost: number;
  /** 模型明细沿用 Claude 口径：in=非缓存输入、cr=缓存读 */
  models: Record<string, ModelUsage>;
  hours: number[];
  model_hours: Record<string, number[]>;
}

export interface CodexFileEntry {
  sig: string;
  events: CodexEvent[];
  days: Record<string, CodexDay>;
  deduped_days: Record<string, CodexDay>;
  session_id: string | null;
  forked_from_id: string | null;
  history_base?: Record<string, any> | null;
  limits: Record<string, any> | null;
  limits_ts: string | null;
  plan: string | null;
  g_limits: Record<string, any> | null;
  g_ts: string | null;
  g_plan: string | null;
  reserve_limits: Record<string, any> | null;
  reserve_limits_ts: string | null;
  last_total: Record<string, any> | null;
  prev_total_key: number[] | null;
  active_model: string | null;
  parser_version: number;
  accounting_version: number;
  response_ids: string[];
  pending_responses: number[][];
  last_legacy_snapshot: (number | null)[] | null;
  file_id: string;
  parsed_size: number;
  parsed_guard: string;
  event_count: number;
  first_keys: string[];
  first_event_ts: string | null;
  last_event_ts: string | null;
  drop_count: number;
  dedupe_open: boolean;
  canonical: boolean;
  dedupe_peers?: string[];
  /** 项目足迹用的绝对路径；undefined=尚未补齐，""=读不到或超窗，不再重试 */
  proj?: string;
}

interface CodexBucket {
  in: number; cached: number; out: number; reason: number; cost: number;
  sessions: Set<string>;
  models: Record<string, ModelUsage>;
}

export interface CodexReserveQuota {
  used_percent: number | null;
  resets_at: number | string | null;
  window_minutes: number | null;
  plan: string | null;
  updated: number | null;
  stale: boolean;
}

export interface CodexQuotaValues {
  p5: number | null; pw: number | null;
  r5: number | string | null; rw: number | string | null;
  p5_stale: boolean; pw_stale: boolean;
}

export interface CodexScanResult {
  ranges: Record<RangeKey, CodexRangeOut>;
  reserve_ranges: Record<RangeKey, CodexRangeOut>;
  reserve_quota: CodexReserveQuota | null;
  plan: string | null;
  // Python 直接转发 rate_limits.resets_at，实测日志里是整数 epoch，个别版本是 ISO 串，故两种都留。
  p5: number | null; pw: number | null; r5: string | number | null; rw: string | number | null;
  limits_updated: number | null;
  q_updated: number | null;
  p5_stale: boolean | null; pw_stale: boolean | null;
  limits: Record<string, any> | null;
  limits_consumed: { p5: number | null; pw: number | null };
  cur_total: Record<string, any> | null;
  days: Record<string, CodexDay>;
  reserve_days: Record<string, CodexDay>;
  /** 24 槽逐时曲线（in+out 口径，Dashboard/回顾消费；主缸与 Reserve 分开） */
  hours: number[];
  reserve_hours: number[];
  /** 项目足迹：cwd 读不到的会话直接跳过（Python 口径，不冒充"未知项目"） */
  projects: Record<string, Record<string, CodexDay>>;
  /** 续卡网络抓取不在移植范围，恒为 null（对应 fetch_codex_reset_cards 失败分支） */
  reset_cards: null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function flt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
function normcase(p: string): string {
  return process.platform === "win32" ? path.normalize(p).toLowerCase() : path.normalize(p);
}

/** 与 Python astimezone().isoformat() 同格式（本地偏移 + 微秒），保证跨端缓存的时间戳串可直接比较 */
export function isoTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const ms = d.getMilliseconds();
  // Python 的 isoformat 只在有亚秒余量时才写小数部分，保持一致才能做字符串大小比较
  const frac = ms ? `.${pad(ms, 3)}` : "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T`
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${frac}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// ---------- 纯辅助函数（可单独做单元测试）----------

/** 对应 _codex_is_reserve_model */
export function codexIsReserveModel(model: unknown): boolean {
  if (typeof model !== "string") return false;
  const m = model.trim().toLowerCase();
  if (m === CODEX_RESERVE_MODEL) return true;
  return m.split("/").pop() === CODEX_RESERVE_MODEL;
}

/** 对应 _codex_is_reserve_limits */
export function codexIsReserveLimits(rl: unknown): boolean {
  if (!isObj(rl)) return false;
  const name = rl.limit_name;
  if (typeof name === "string" && CODEX_RESERVE_LIMIT_NAMES.includes(name.trim().toLowerCase())) return true;
  const id = rl.limit_id;
  return typeof id === "string" && CODEX_RESERVE_LIMIT_IDS.includes(id.trim());
}

/** 对应 _codex_price_model：成本与卡片单价必须用同一个查价规则才对得上 */
export function codexPriceModel(model: string | null | undefined): string | null {
  if (codexIsReserveModel(model)) return CODEX_RESERVE_PRICE_MODEL;
  return hasKnownPrice(model) ? (model ?? null) : CODEX_NO_PRICE_FALLBACK_MODEL;
}

/**
 * 对应 _codex_estimated_cost（inp 为含缓存的输入，out 为含推理的输出）。
 * 与 Python 同步：单条请求输入 >272K 时按高上下文档计价
 * （输入与缓存读 ×2、输出 ×1.5），阈值本身不加价（inp 必须严格大于 272000）。
 */
export const CODEX_HIGH_CONTEXT_INPUT = 272_000;

export function codexEstimatedCost(model: string | null | undefined, inp: number, cached: number, out: number): number {
  const base = rawPrice(codexPriceModel(model));
  const hi = inp > CODEX_HIGH_CONTEXT_INPUT ? 1 : 0;
  return ((inp - cached) / 1e6) * base.in * (hi ? 2 : 1)
    + (cached / 1e6) * base.cache_read * (hi ? 2 : 1)
    + (out / 1e6) * base.out * (hi ? 1.5 : 1);
}

/** 对应 _codex_event_key：用快照键（累计 4 + 增量 4）作为可比较字符串；无累计快照时不参与前缀去重 */
export function codexEventKey(event: unknown): string | null {
  if (!Array.isArray(event) || event.length < 11) return null;
  for (let i = 2; i < 6; i++) {
    if (event[i] === null || event[i] === undefined) return null;
  }
  return JSON.stringify(event.slice(2, 10));
}

/** 对应 _codex_events_match：有 response_id 就只认 id，否则退回快照键 */
export function codexEventsMatch(left: any[], right: any[]): boolean {
  const a = left.length > 12 ? left[12] : null;
  const b = right.length > 12 ? right[12] : null;
  if (a && b) return a === b;
  const key = codexEventKey(left);
  return key !== null && key === codexEventKey(right);
}

export function codexDay(): CodexDay {
  return { in: 0, cached: 0, out: 0, reason: 0, cost: 0, models: {}, hours: new Array(24).fill(0), model_hours: {} };
}

/** 对应 _codex_add_event：成本按当前价重算，不用事件里缓存的旧值 */
export function codexAddEvent(days: Record<string, CodexDay>, event: any): void {
  if (!Array.isArray(event) || event.length < 11) return;
  const dk = String(event[1]);
  const li = num(event[6]);
  const lc = num(event[7]);
  const lo = num(event[8]);
  const lr = num(event[9]);
  const model = event.length > 11 ? event[11] : null;
  const cost = codexEstimatedCost(model, li, lc, lo);
  const day = days[dk] ?? (days[dk] = codexDay());
  if (!Array.isArray(day.hours) || day.hours.length < 24) day.hours = new Array(24).fill(0);
  if (!isObj(day.model_hours)) day.model_hours = {};
  if (!isObj(day.models)) day.models = {};
  day.in += li;
  day.cached += lc;
  day.out += lo;
  day.reason += lr;
  day.cost += cost;
  addModelUsage(day.models, model, { inp: Math.max(li - lc, 0), out: lo, cr: lc, cw: 0, reason: lr, cost });
  const date = new Date(String(event[0]));
  if (!Number.isNaN(date.getTime())) {
    const hour = date.getHours();
    const amount = li + lo;
    day.hours[hour] += amount;
    const key = model === null || model === undefined ? "" : String(model);
    const modelHours = day.model_hours[key] ?? (day.model_hours[key] = new Array(24).fill(0));
    modelHours[hour] += amount;
  }
}

/** 对应 _codex_day_has_usage */
export function codexDayHasUsage(day: Partial<CodexDay> | null | undefined): boolean {
  if (!isObj(day)) return false;
  if (Object.keys(day.models ?? {}).length) return true;
  return ["in", "cached", "out", "reason", "cost"].some((k) => flt((day as any)[k]) !== 0);
}

/** 对应 _ledger_values 在本采集器需要的子集：标量相加、models 按身份合并、hours/model_hours 逐位相加 */
export function mergeCodexDays(left: Partial<CodexDay>, right: Partial<CodexDay>): CodexDay {
  const result = codexDay();
  const seen = new Set<string>();
  for (const key of Object.keys(left)) seen.add(key);
  for (const key of Object.keys(right)) seen.add(key);
  for (const key of seen) {
    if (key === "models" || key === "hours" || key === "model_hours") continue;
    const a = (left as any)[key];
    const b = (right as any)[key];
    if (typeof a === "number" || typeof b === "number") {
      (result as any)[key] = flt(a) + flt(b);
    }
  }
  // 同模型可能以不同别名出现在两侧，必须走 addModelUsage 的身份合并；
  // 注意 delta 的输入字段名是 inp（ModelUsage 上存的是 in），直接传对象会把输入吞成 0。
  for (const src of [left.models, right.models]) {
    for (const [model, usage] of Object.entries(isObj(src) ? src : {})) {
      const u = usage as ModelUsage;
      addModelUsage(result.models, model, {
        inp: num(u.in), out: num(u.out), cr: num(u.cr), cw: num(u.cw),
        reason: num(u.reason), cost: flt(u.cost), credits: flt(u.credits), cost_cny: flt(u.cost_cny),
      });
    }
  }
  const ha = Array.isArray(left.hours) ? left.hours : [];
  const hb = Array.isArray(right.hours) ? right.hours : [];
  for (let h = 0; h < 24; h++) result.hours[h] = num(ha[h]) + num(hb[h]);
  const ma = isObj(left.model_hours) ? left.model_hours : {};
  const mb = isObj(right.model_hours) ? right.model_hours : {};
  for (const model of [...Object.keys(ma), ...Object.keys(mb)]) {
    if (result.model_hours[model]) continue;
    const la = Array.isArray(ma[model]) ? ma[model] : [];
    const lb = Array.isArray(mb[model]) ? mb[model] : [];
    result.model_hours[model] = new Array(24).fill(0).map((_, h) => num(la[h]) + num(lb[h]));
  }
  return result;
}

/** 对应 _codex_split_day：按模型把一天拆成主额度与 Reserve 两份，不丢事件级小时归属 */
export function codexSplitDay(day: Partial<CodexDay>): [CodexDay, CodexDay] {
  const main = codexDay();
  const reserve = codexDay();
  const models = isObj(day.models) ? day.models : {};
  const modelList = Object.entries(models);
  if (!modelList.length) {
    for (const key of ["in", "cached", "out", "reason", "cost"] as const) {
      (main as any)[key] = flt((day as any)[key]);
    }
    const hours = Array.isArray(day.hours) ? day.hours : [];
    for (let h = 0; h < 24; h++) main.hours[h] = flt(hours[h]);
    return [main, reserve];
  }

  const modelHours = isObj(day.model_hours) ? day.model_hours : {};
  for (const [model, usage] of modelList) {
    const target = codexIsReserveModel(model) ? reserve : main;
    const li = num(usage.in);
    const lc = num(usage.cr);
    const lo = num(usage.out);
    const lr = num(usage.reason);
    const cost = flt(usage.cost);
    // 明细里 in 是非缓存输入，回到日级要加回缓存才是"含 cached 的输入"口径
    target.in += li + lc;
    target.cached += lc;
    target.out += lo;
    target.reason += lr;
    target.cost += cost;
    addModelUsage(target.models, model, { inp: li, out: lo, cr: lc, cw: num(usage.cw), reason: lr, cost });
    const allocated = modelHours[model];
    if (Array.isArray(allocated)) {
      for (let h = 0; h < Math.min(24, allocated.length); h++) target.hours[h] += flt(allocated[h]);
    }
  }

  // 没有 model_hours 的老条目：整天都归同一个桶时才能无歧义地分配
  if (!Object.keys(modelHours).length) {
    const hasReserve = modelList.some(([m]) => codexIsReserveModel(m));
    const hasMain = modelList.some(([m]) => !codexIsReserveModel(m));
    if (hasReserve !== hasMain) {
      const target = hasReserve ? reserve : main;
      const hours = Array.isArray(day.hours) ? day.hours : [];
      for (let h = 0; h < 24; h++) target.hours[h] = flt(hours[h]);
    }
  }
  return [main, reserve];
}

/**
 * 对应 _codex_split_sources：把每个会话副本拆成主额度/Reserve 两份，
 * 既汇总成 live 日账（main_days / reserve_days），也按来源留快照
 * （main_sources / reserve_sources），后者交给账本做逐来源合并。
 */
export function codexSplitSources(fileCache: Record<string, CodexFileEntry>): {
  mainDays: Record<string, CodexDay>;
  reserveDays: Record<string, CodexDay>;
  mainSources: Record<string, Record<string, DayRecord>>;
  reserveSources: Record<string, Record<string, DayRecord>>;
  mainSessions: Record<string, Set<string>>;
  reserveSessions: Record<string, Set<string>>;
} {
  const mainDays: Record<string, CodexDay> = {};
  const reserveDays: Record<string, CodexDay> = {};
  const mainSources: Record<string, Record<string, DayRecord>> = {};
  const reserveSources: Record<string, Record<string, DayRecord>> = {};
  const mainSessions: Record<string, Set<string>> = {};
  const reserveSessions: Record<string, Set<string>> = {};
  const stamp = (day: DayRecord): DayRecord => {
    // Python 同时写 _accounting_version 与 _ledger_version：前者让来源级合并认账，
    // 后者让天级高水位在口径升级时允许被更高的新值替换
    day._accounting_version = CODEX_ACCOUNTING_VERSION;
    day._ledger_version = CODEX_ACCOUNTING_VERSION;
    return day;
  };
  for (const [pathKey, entry] of Object.entries(fileCache)) {
    if (!isObj(entry)) continue;
    const identity = String(entry.session_id ?? pathKey);
    for (const [dk, day] of Object.entries(entry.days ?? {})) {
      const [main, reserve] = codexSplitDay(day);
      const hasMain = codexDayHasUsage(main);
      const hasReserve = codexDayHasUsage(reserve);
      if (hasMain) {
        mainDays[dk] = mergeCodexDays(mainDays[dk] ?? ({} as CodexDay), main);
        (mainSessions[dk] ??= new Set<string>()).add(identity);
        const sourceDays = (mainSources[identity] ??= {});
        sourceDays[dk] = stamp(ledgerValues(sourceDays[dk] ?? {}, main as DayRecord));
      }
      if (hasReserve) {
        reserveDays[dk] = mergeCodexDays(reserveDays[dk] ?? ({} as CodexDay), reserve);
        (reserveSessions[dk] ??= new Set<string>()).add(identity);
        const sourceDays = (reserveSources[identity] ??= {});
        sourceDays[dk] = stamp(ledgerValues(sourceDays[dk] ?? {}, reserve as DayRecord));
      }
    }
  }
  return { mainDays, reserveDays, mainSources, reserveSources, mainSessions, reserveSessions };
}

/** 来源身份的账本键：对应 Python 的 hashlib.sha256(str(identity).encode()).hexdigest() */
function sourceIdOf(identity: string): string {
  return crypto.createHash("sha256").update(String(identity)).digest("hex");
}

/**
 * 对应 _codex_migrate_mixed_ledger：v7 之前主账本里混着 Reserve 的快照要按
 * 当前重建出来的拆分结果整体替换，否则老的一天会被「主 + 主里含的 Reserve」双计。
 */
export function codexMigrateMixedLedger(
  mainSources: Record<string, Record<string, DayRecord>>,
  reserveSources: Record<string, Record<string, DayRecord>>,
): void {
  const stored = (loadLedger().tools ??= {})["codex"] ??= {};
  const byDay = (sources: Record<string, Record<string, DayRecord>>) => {
    const target: Record<string, Record<string, DayRecord>> = {};
    for (const [identity, days] of Object.entries(sources)) {
      const sourceId = sourceIdOf(identity);
      for (const [dk, day] of Object.entries(days)) (target[dk] ??= {})[sourceId] = day;
    }
    return target;
  };
  const mainByDay = byDay(mainSources);
  const reserveByDay = byDay(reserveSources);

  let changed = false;
  for (const [dk, reserveCurrent] of Object.entries(reserveByDay)) {
    const kept = stored[dk];
    if (!isDictDay(kept)) continue;
    const mainCurrent = mainByDay[dk] ?? {};
    let sources: Record<string, DayRecord>;
    if (kept._sources === undefined) {
      // 旧版没有来源标注：先把当前能看到的份额算出来，账本余额才是 legacy
      let actual: DayRecord = {};
      for (const sourceId of new Set([...Object.keys(mainCurrent), ...Object.keys(reserveCurrent)])) {
        actual = ledgerValues(actual, mainCurrent[sourceId] ?? {});
        actual = ledgerValues(actual, reserveCurrent[sourceId] ?? {});
      }
      const legacy = codexLegacyDay(ledgerValues(kept, actual, true));
      legacy._accounting_version = CODEX_ACCOUNTING_VERSION;
      legacy._ledger_version = CODEX_ACCOUNTING_VERSION;
      sources = codexDayHasUsage(legacy as Partial<CodexDay>) ? { legacy } : {};
    } else {
      sources = { ...(kept._sources as Record<string, DayRecord>) };
    }

    for (const [sourceId, reserveSnapshot] of Object.entries(reserveCurrent)) {
      let replacement = mainCurrent[sourceId];
      if (!replacement) {
        // 这一轮该来源只剩 Reserve：主份额写空壳，把老快照里的 token 挤出主账本
        replacement = { _accounting_version: CODEX_ACCOUNTING_VERSION, _ledger_version: CODEX_ACCOUNTING_VERSION };
      }
      // 当前 v7 的事件缓存对该来源是权威的：同版本也要替换，
      // 好让增量的「先有 response 再有 usage」回填能把用量挪出主账本
      if (!ledgerSameValue(sources[sourceId], replacement)) sources[sourceId] = replacement;
    }

    let result: DayRecord = {};
    for (const snapshot of Object.values(sources)) result = ledgerValues(result, snapshot);
    result._sources = sources;
    result._ledger_version = CODEX_ACCOUNTING_VERSION;
    if (!ledgerSameValue(kept, result)) {
      stored[dk] = result;
      changed = true;
    }
  }
  if (changed) ledgerMemo().dirty = true;
}

function isDictDay(value: unknown): value is DayRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 对应 _codex_used_since：窗口翻篇后本机又消耗了多少，拿不到返回 null */
export function codexUsedSince(days: Record<string, Partial<CodexDay>> | null | undefined, sinceEpoch: unknown): number | null {
  if (!isObj(days) || !sinceEpoch) return null;
  const seconds = Number(sinceEpoch);
  if (!Number.isFinite(seconds)) return null;
  const start = new Date(seconds * 1000);
  if (Number.isNaN(start.getTime())) return null;
  const startDay = localDay(start);
  let total = 0;
  for (const [dk, day] of Object.entries(days)) {
    if (!isObj(day) || dk < startDay) continue;
    const wholeDay = num(day.in) + num(day.out);
    if (dk > startDay) {
      total += wholeDay;
      continue;
    }
    const hours = Array.isArray(day.hours) ? day.hours : [];
    // 没有小时分布就整天算，保守方向是宁多勿少：漏报会让失真的读数被当成"还满着"
    if (hours.length) {
      for (let h = start.getHours(); h < 24; h++) total += num(hours[h]);
    } else {
      total += wholeDay;
    }
  }
  return total;
}

/**
 * 对应 _codex_quota_values：按 window_minutes 认窗口，不信 primary/secondary 的固定含义。
 * 旧日志 primary=5h、secondary=周；新套餐可能只有 primary=周。
 */
export function codexQuotaValues(
  limits: Record<string, any> | null | undefined,
  nowEpoch?: number,
  consumed?: Record<string, number | null> | null,
): CodexQuotaValues {
  const values: CodexQuotaValues = { p5: null, pw: null, r5: null, rw: null, p5_stale: false, pw_stale: false };
  for (const slotName of ["primary", "secondary"] as const) {
    const slot = (limits ?? {}).get?.(slotName) ?? (limits ?? {})[slotName];
    if (!isObj(slot) || !Object.keys(slot).length) continue;
    const minutes = slot.window_minutes;
    // 只在"缺 window_minutes 且是 secondary"时按周处理，其余一律以时长为准
    const isWeek = minutes === WEEK_MINUTES || (minutes == null && slotName === "secondary");
    const pctKey = isWeek ? "pw" : "p5";
    const resetKey = isWeek ? "rw" : "r5";
    (values as any)[pctKey] = slot.used_percent === undefined ? null : slot.used_percent;
    (values as any)[resetKey] = slot.resets_at === undefined ? null : slot.resets_at;
  }

  const now = nowEpoch === undefined || nowEpoch === null ? Math.floor(Date.now() / 1000) : nowEpoch;
  for (const [pctKey, resetKey] of [["p5", "r5"], ["pw", "rw"]] as const) {
    const reset = (values as any)[resetKey];
    if (!reset) continue;
    const resetEpoch = Number(reset);
    // Python 里 resets_at 是数值 epoch（`now_epoch <= reset` 直接比）；拿到非数值串时
    // 无法判窗口是否翻篇，保守做法是原样保留读数、不标失真。
    if (!Number.isFinite(resetEpoch) || now <= resetEpoch) continue;
    // 窗口已翻篇：一个 token 都没用 = 确实回满；用过 = 这份读数已经失真（issue #63）
    if (consumed && (consumed as any)[pctKey] === 0) {
      (values as any)[pctKey] = 0.0;
      (values as any)[resetKey] = null;
    } else if ((values as any)[pctKey] !== null && (values as any)[pctKey] !== undefined) {
      (values as any)[`${pctKey}_stale`] = true;
    }
  }
  return values;
}

/** 对应 _codex_session_meta：读文件头拿会话 id / 父会话 id / 分页基线 */
export function codexSessionMeta(file: string, maxLines = 20, maxLineBytes = 2 * 1024 * 1024): [string | null, string | null, Record<string, any> | null] {
  let result: [string | null, string | null, Record<string, any> | null] = [null, null, null];
  let done = false;
  forEachLineRange(file, 0, fileSize(file), (raw, index) => {
    if (index >= maxLines || done) return false;
    if (!raw.includes('"session_meta"', 0, "utf8")) return;
    let record: Record<string, any>;
    try {
      record = JSON.parse(decodeBounded(raw, maxLineBytes));
    } catch {
      return;
    }
    if (record.type !== "session_meta" || !isObj(record.payload)) return;
    done = true;
    const meta = record.payload;
    let parentId = meta.forked_from_id ?? meta.parent_thread_id;
    if (!parentId) {
      // 子代理：source.subagent.thread_spawn.parent_thread_id
      const source = meta.source;
      const subagent = isObj(source) ? source.subagent : null;
      const spawn = isObj(subagent) ? subagent.thread_spawn : null;
      if (isObj(spawn)) parentId = spawn.parent_thread_id;
    }
    const historyBase = isObj(meta.history_base) && Object.keys(meta.history_base).length ? meta.history_base : null;
    result = [meta.id ?? meta.session_id ?? null, parentId ?? null, historyBase];
    return false;
  });
  return result;
}

/** Python 只认 "/" 开头；Windows 上 Codex 写的是盘符/UNC 路径，照搬会把项目足迹整段丢掉 */
function isAbsoluteCwd(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** 对应 _codex_session_cwd：只读前几行找 session_meta 的 cwd，不为一个字段重解析整个会话 */
export function codexSessionCwd(file: string, maxLines = 8, maxLineBytes = 128 * 1024): string | null {
  let cwd: string | null = null;
  let done = false;
  forEachLineRange(file, 0, fileSize(file), (raw, index) => {
    if (index >= maxLines || done) return false;
    if (!raw.includes('"session_meta"', 0, "utf8")) return;
    let record: Record<string, any>;
    try {
      record = JSON.parse(decodeBounded(raw, maxLineBytes));
    } catch {
      return;
    }
    if (record.type !== "session_meta" || !isObj(record.payload)) return;
    done = true;
    const value = record.payload.cwd;
    if (typeof value === "string" && isAbsoluteCwd(value)) cwd = value;
    return false;
  });
  return cwd;
}

// 对应 _CODEX_PROJECT_BACKFILL_*：项目路径分摊补齐，读不到的写空串占位不再重试。
const CODEX_PROJECT_BACKFILL_PER_SCAN = 150;
const CODEX_PROJECT_BACKFILL_DAYS = 60;

/** 对应 _codex_page_key：同一会话里"这是哪一页"，老缓存缺字段时补读一次文件头 */
export function codexPageKey(file: string, entry: CodexFileEntry): string | null {
  if (entry.history_base === undefined) {
    entry.history_base = codexSessionMeta(file)[2];
  }
  const base = entry.history_base;
  return isObj(base) ? stableStringify(base) : null;
}

/**
 * 对应 _codex_canonical_file_cache：同一会话的多份拷贝只留覆盖未响应集合的那几份。
 * 有 response_ids 的按 id 覆盖去重；没有 id 的旧式文件按"同会话同页只留最完整一份"。
 */
export function codexCanonicalFileCache(fileCache: Record<string, CodexFileEntry>): Record<string, CodexFileEntry> {
  const canonical: Record<string, CodexFileEntry> = {};
  const groups = new Map<string, Array<[string, CodexFileEntry]>>();
  for (const [file, entry] of Object.entries(fileCache)) {
    if (!isObj(entry)) continue;
    const sid = entry.session_id;
    const key = sid ? `session\0${String(sid)}` : `rollout\0${path.basename(file)}`;
    const list = groups.get(key);
    if (list) list.push([file, entry]);
    else groups.set(key, [[file, entry]]);
  }
  const score = (item: [string, CodexFileEntry]): [number, string, number] => {
    const entry = item[1];
    return [num(entry.event_count ?? (entry.events?.length ?? 0)), String(entry.last_event_ts ?? ""), num(entry.parsed_size)];
  };
  for (const copies of groups.values()) {
    const covered = new Set<string>();
    const legacyPages = new Set<string | null>();
    const paged = copies.filter(([, entry]) => !(entry.response_ids && entry.response_ids.length)).length > 1;
    const ordered = [...copies].sort((a, b) => {
      const x = score(a);
      const y = score(b);
      if (x[0] !== y[0]) return y[0] - x[0];
      if (x[1] !== y[1]) return x[1] < y[1] ? 1 : -1;
      return y[2] - x[2];
    });
    for (const [file, entry] of ordered) {
      const ids = new Set(entry.response_ids ?? []);
      if (ids.size) {
        const subset = [...ids].every((id) => covered.has(id));
        if (subset) continue;
        for (const id of ids) covered.add(id);
      } else {
        const page = paged ? codexPageKey(file, entry) : null;
        if (legacyPages.has(page)) continue;
        legacyPages.add(page);
      }
      canonical[file] = entry;
    }
  }
  return canonical;
}

/** 对应 _codex_prefix_match_count */
export function codexPrefixMatchCount(childEvents: any[] | null | undefined, parentEvents: any[] | null | undefined): number {
  const child = childEvents ?? [];
  const parent = parentEvents ?? [];
  let n = 0;
  while (n < child.length && n < parent.length) {
    if (!codexEventsMatch(child[n], parent[n])) break;
    n++;
  }
  return n;
}

function prefixKeyOf(entry: CodexFileEntry): string | null {
  const keys = entry.first_keys ?? [];
  return keys.length >= 2 ? `${keys[0]}\0${keys[1]}` : null;
}

/**
 * 对应 _codex_cached_drop_count：算出某文件开头有多少事件是父会话/前一页的回放。
 * 三条规则：1) forked_from_id 指向的父文件前缀；2) 缺父元数据时只认"两事件以上"的相同前缀；
 * 3) 同一秒内 ≥5 条无 response_id 的 token 事件必是回放转储。
 * 返回 [drop_count, dedupe_open]，dedupe_open 表示这份前缀还可能继续增长、下轮要重建。
 */
export function codexCachedDropCount(
  file: string,
  entry: CodexFileEntry,
  fileCache: Record<string, CodexFileEntry>,
): [number, boolean] {
  const bySid = new Map<string, [string, CodexFileEntry]>();
  for (const [candidatePath, candidate] of Object.entries(fileCache)) {
    if (candidate?.session_id) bySid.set(String(candidate.session_id), [candidatePath, candidate]);
  }
  const eventCount = num(entry.event_count);
  let dropCount = 0;
  let prefixOpen = false;

  const parent = entry.forked_from_id ? bySid.get(String(entry.forked_from_id)) : undefined;
  let parentFound = !!parent;
  if (parent && parent[0] !== file) {
    dropCount = codexPrefixMatchCount(entry.events, parent[1].events);
    prefixOpen = dropCount > 0 && dropCount === eventCount;
  }

  const prefixKey = prefixKeyOf(entry);
  if (dropCount === 0 && prefixKey !== null && eventCount >= 2) {
    const childFirstTs = String(entry.first_event_ts ?? "");
    let best = 0;
    for (const [parentPath, parentEntry] of Object.entries(fileCache)) {
      if (parentPath === file || prefixKeyOf(parentEntry) !== prefixKey) continue;
      const parentFirstTs = String(parentEntry.first_event_ts ?? "");
      if (!parentFirstTs || parentFirstTs >= childFirstTs) continue;
      best = Math.max(best, codexPrefixMatchCount(entry.events, parentEntry.events));
    }
    if (best >= 2) {
      dropCount = best;
      prefixOpen = dropCount === eventCount;
    }
  }

  const burst = codexCachedBurstCount(entry.events, dropCount, eventCount);
  if (burst) dropCount += burst;

  if (eventCount < 2 && !entry.forked_from_id) prefixOpen = true;
  else if (entry.forked_from_id && !parentFound) prefixOpen = true;
  return [Math.min(dropCount, eventCount), prefixOpen];
}

/** 对应 _codex_cached_burst_count */
export function codexCachedBurstCount(events: any[] | null | undefined, startIndex: number, eventCount: number): number {
  const list = events ?? [];
  const limit = Math.max(num(eventCount) - num(startIndex), 0);
  let burstSecond: string | null = null;
  let count = 0;
  for (let i = startIndex; i < list.length && i - startIndex < limit; i++) {
    const event = list[i];
    if (!event || !Array.isArray(event) || !event.length) break;
    if (event.length > 12 && event[12]) break; // 有 response_id 的是真实调用，同秒也不算回放
    const second = String(event[0]).slice(0, 19);
    if (burstSecond === null) burstSecond = second;
    else if (second !== burstSecond) break;
    count++;
  }
  return count >= 5 ? count : 0;
}

/** 对应 _codex_days_from_cached_events：跳过前缀回放，同 thread 的多段按 response_id 再去重 */
export function codexDaysFromCachedEvents(
  entry: CodexFileEntry,
  startIndex = 0,
  eventCount?: number | null,
  seenResponses?: Set<string> | null,
): Record<string, CodexDay> {
  const days: Record<string, CodexDay> = {};
  const events = entry.events ?? [];
  const limit = eventCount === null || eventCount === undefined ? events.length : Math.max(num(eventCount) - startIndex, 0);
  for (let i = startIndex; i < events.length && i - startIndex < limit; i++) {
    const event = events[i];
    const responseId = event && event.length > 12 ? event[12] : null;
    if (seenResponses && responseId) {
      if (seenResponses.has(String(responseId))) continue;
      seenResponses.add(String(responseId));
    }
    codexAddEvent(days, event);
  }
  return days;
}

/**
 * 对应 _scale_codex_cached_days：拿不到某个变更模型的倍率就没法缩放（返回 false），
 * 由调用方退回「按事件重算」。days 与 deduped_days 常指向同一批日账对象，所以按引用去重，
 * 否则同一个模型的 cost 会被乘两遍。
 */
function scaleCodexCachedDays(
  entry: CodexFileEntry, changedModels: Array<string | null>, multipliers: Record<string, number>,
): boolean {
  const days: CodexDay[] = [];
  const seen = new Set<CodexDay>();
  for (const field of ["days", "deduped_days"] as const) {
    const values = entry[field];
    if (!isObj(values)) continue;
    for (const day of Object.values(values)) {
      if (isObj(day) && !seen.has(day as CodexDay)) {
        seen.add(day as CodexDay);
        days.push(day as CodexDay);
      }
    }
  }
  const targets: Array<[ModelUsage, number]> = [];
  for (const day of days) {
    if (!isObj(day.models)) continue;
    for (const [model, usage] of Object.entries(day.models)) {
      if (!modelHasPricingChange(model, changedModels)) continue;
      const multiplier = pricingChangeMultiplier(model, multipliers);
      if (multiplier === null) return false;
      targets.push([usage, multiplier]);
    }
  }
  if (!targets.length) return false;
  const updated = new Set<ModelUsage>();
  for (const [usage, multiplier] of targets) {
    if (updated.has(usage)) continue;
    usage.cost = flt(usage.cost) * multiplier;
    updated.add(usage);
  }
  for (const day of days) {
    const models = isObj(day.models) ? day.models : {};
    day.cost = Object.values(models).reduce((sum, value) => sum + flt((value as ModelUsage)?.cost), 0);
  }
  return true;
}

/**
 * 对应 _reprice_codex_event_caches：价目表变过，先把能缩放的日账按倍率乘过去，
 * 乘不动的就用手上的事件明细重算整份日账。
 * Python 那份「事件缓存读坏了就删盘重建」在这里没有对应物——我们的事件本来就在内存里，
 * 读它不会失败；缺明细（Array.isArray 不成立）等于 _codex_event_cache_ready 为假，
 * 跳过即可，紧接着的扫描循环会因为 sig/版本判定把这份条目重新解析一遍。
 */
function repriceCodexEventCaches(
  fileCache: Record<string, CodexFileEntry>, changedModels: Array<string | null>, multipliers: Record<string, number>,
): boolean {
  let changed = false;
  for (const entry of Object.values(fileCache)) {
    if (!entry || !cachedEntryHasPricingChange(entry, changedModels)) continue;
    if (scaleCodexCachedDays(entry, changedModels, multipliers)) {
      changed = true;
      continue;
    }
    const events = entry.events;
    if (!Array.isArray(events)) continue;
    const dropCount = Math.min(Math.max(num(entry.drop_count), 0), events.length);
    const days = codexDaysFromCachedEvents(entry, dropCount, entry.event_count);
    if (!sameDays(entry.deduped_days, days)) entry.deduped_days = days;
    const expectedDays = entry.canonical ? days : {};
    if (!sameDays(entry.days, expectedDays)) entry.days = expectedDays;
    changed = true;
  }
  return changed;
}

/** 对应 _codex_link_segment_mirrors：同一 thread 的多段之间把 response_id 传染给旧式镜像事件 */
export function codexLinkSegmentMirrors(fileCache: Record<string, CodexFileEntry>): Set<string> {
  const groups = new Map<string, string[]>();
  for (const [file, entry] of Object.entries(fileCache)) {
    if (!isObj(entry)) continue;
    const key = String(entry.session_id ?? file);
    const list = groups.get(key);
    if (list) list.push(file);
    else groups.set(key, [file]);
  }
  const changed = new Set<string>();
  for (const paths of groups.values()) {
    if (paths.length < 2) continue;
    const identified = new Map<string, [string, any[], string]>();
    for (const pathKey of paths) {
      for (const event of fileCache[pathKey].events ?? []) {
        const key = codexEventKey(event);
        const responseId = event.length > 12 ? event[12] : null;
        if (key !== null && responseId && !identified.has(key)) {
          identified.set(key, [String(responseId), event, pathKey]);
        }
      }
    }
    const touched = new Set<string>();
    for (const pathKey of paths) {
      for (const event of fileCache[pathKey].events ?? []) {
        const key = codexEventKey(event);
        const responseId = event.length > 12 ? event[12] : null;
        if (key === null || responseId) continue;
        const match = identified.get(key);
        if (!match) continue;
        while (event.length <= 12) event.push(null);
        event[12] = match[0];
        touched.add(pathKey);
        if (codexIsReserveModel(event[11]) || codexIsReserveModel(match[1][11])) {
          if (codexReclassifyReserveEvent(event)) touched.add(pathKey);
          if (codexReclassifyReserveEvent(match[1])) touched.add(match[2]);
        }
      }
    }
    for (const pathKey of touched) changed.add(pathKey);
  }
  return changed;
}

/** 对应 _codex_reclassify_reserve_event */
export function codexReclassifyReserveEvent(event: any[]): boolean {
  if (!Array.isArray(event) || event.length < 12) return false;
  const li = num(event[6]);
  const lc = num(event[7]);
  const lo = num(event[8]);
  const cost = codexEstimatedCost(CODEX_RESERVE_MODEL, li, lc, lo);
  if (event[11] === CODEX_RESERVE_MODEL && event[10] === cost) return false;
  event[10] = cost;
  event[11] = CODEX_RESERVE_MODEL;
  return true;
}

/** 对应 _codex_backfill_reserve_mirror：响应先于 Reserve 旧式镜像落盘时，把已计入的事件改判为 Reserve */
export function codexBackfillReserveMirror(candidates: any[] | null | undefined, mirror: number[]): boolean {
  const list = candidates ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const event = list[i];
    if (!Array.isArray(event) || event.length <= 9) continue;
    if ([num(event[6]), num(event[7]), num(event[8]), num(event[9])].join(",") !== mirror.slice(0, 4).join(",")) continue;
    return codexReclassifyReserveEvent(event);
  }
  return false;
}

// ---------- 低层读取 ----------

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function decodeBounded(raw: Buffer, limit: number): string {
  return raw.toString("utf8", 0, Math.min(limit, raw.length));
}

/** 有界逐行读取：只把需要的字节区间解码成字符串，55MB 级别会话里的巨型 response_item 行不进内存 */
function forEachLineRange(file: string, start: number, end: number, onLine: (raw: Buffer, index: number) => boolean | void): void {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  try {
    const chunk = Buffer.allocUnsafe(1 << 16);
    let position = start;
    let carry: Buffer | null = null;
    let index = 0;
    let stopped = false;
    while (position < end && !stopped) {
      const want = Math.min(chunk.length, end - position);
      let read = 0;
      try {
        read = fs.readSync(fd, chunk, 0, want, position);
      } catch {
        break;
      }
      if (read <= 0) break;
      position += read;
      const piece: Buffer = carry && carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      let from = 0;
      for (;;) {
        const nl = piece.indexOf(0x0a, from);
        if (nl === -1) break;
        const raw = piece.subarray(from, nl);
        from = nl + 1;
        if (raw.length && onLine(raw, index++) === false) {
          stopped = true;
          break;
        }
      }
      carry = from < piece.length ? Buffer.from(piece.subarray(from)) : null;
    }
    if (!stopped && carry && carry.length) onLine(carry, index);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 忽略 */
    }
  }
}

/** 对应 _codex_complete_offset：最后一个完整 JSONL 记录之后的字节偏移 */
export function codexCompleteOffset(file: string, size: number, chunkSize = 1 << 16): number {
  if (size <= 0) return 0;
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return 0;
  }
  try {
    const last = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 0x0a) return size;
    const buf = Buffer.allocUnsafe(chunkSize);
    let position = size;
    while (position > 0) {
      const start = Math.max(0, position - chunkSize);
      const read = fs.readSync(fd, buf, 0, position - start, start);
      const nl = buf.subarray(0, read).lastIndexOf(0x0a);
      if (nl >= 0) return start + nl + 1;
      position = start;
    }
  } catch {
    return 0;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 忽略 */
    }
  }
  return 0;
}

/** 对应 _codex_offset_guard：增量续读前校验上次停下来的位置没被改写 */
export function codexOffsetGuard(file: string, offset: number, guardSize = 4096): string {
  if (offset <= 0) return "";
  try {
    const start = Math.max(0, offset - guardSize);
    const buf = Buffer.allocUnsafe(offset - start);
    const fd = fs.openSync(file, "r");
    try {
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      return crypto.createHash("sha256").update(buf.subarray(0, read)).digest("hex");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "unreadable";
  }
}

/**
 * 对应 _codex_probe_record_header：在截断的记录前缀里按对象深度挑出
 * timestamp / 顶层 type / payload.type / payload.model，避免依赖序列化顺序，
 * 也不会被嵌套在 content 里的 "type":"token_count" 诱饵骗到。
 */
export function codexProbeRecordHeader(data: string): {
  timestamp: string | null; rootType: string | null; payloadType: string | null; model: string | null;
} {
  let timestamp: string | null = null;
  let rootType: string | null = null;
  let payloadType: string | null = null;
  let model: string | null = null;
  const pendingKeys = new Map<number, string>();
  let payloadDepth: number | null = null;
  let depth = 0;
  let containers = 0;
  const size = data.length;
  let i = 0;
  const isWs = (ch: string) => ch === " " || ch === "\t" || ch === "\r" || ch === "\n";

  while (i < size) {
    const ch = data[i];
    if (isWs(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      const start = i + 1;
      i = start;
      while (i < size) {
        if (data[i] === "\\") {
          i += 2;
          continue;
        }
        if (data[i] === '"') break;
        i++;
      }
      if (i >= size) break;
      const value = decodeJsonString(data.slice(start, i));
      i += 1;
      let lookahead = i;
      while (lookahead < size && isWs(data[lookahead])) lookahead++;
      if (lookahead < size && data[lookahead] === ":") {
        pendingKeys.set(depth, value);
        i = lookahead + 1;
        continue;
      }
      const key = pendingKeys.get(depth) ?? null;
      pendingKeys.delete(depth);
      if (depth === 1) {
        if (key === "timestamp") timestamp = value;
        else if (key === "type") rootType = value;
      } else if (payloadDepth !== null && depth === payloadDepth) {
        if (key === "type") payloadType = value;
        else if (key === "model") model = value;
      }
      i = lookahead;
      continue;
    }
    if (ch === "{" || ch === "[") {
      const parentDepth = depth;
      const key = pendingKeys.get(parentDepth) ?? null;
      pendingKeys.delete(parentDepth);
      containers++;
      depth += 1;
      if (ch === "{" && parentDepth === 1 && key === "payload") payloadDepth = depth;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      pendingKeys.delete(depth);
      if (payloadDepth === depth) payloadDepth = null;
      if (containers > 0) containers--;
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (ch === ",") pendingKeys.delete(depth);
    i++;
  }
  return { timestamp, rootType, payloadType, model };
}

function decodeJsonString(raw: string): string {
  if (!raw.includes("\\")) return raw;
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/**
 * 对应 _iter_codex_usage_records：只解码 model 记录与 token 记录，
 * 其余巨型行（agent_message / response_item）连字符串化都不做。
 * token 记录交回原始文本，由调用方 JSON.parse（坏行跳过）。
 */
export function iterCodexUsageRecords(
  file: string,
  startOffset: number,
  endOffset: number,
  onRecord: (kind: "model" | "token", value: string) => void,
): void {
  forEachLineRange(file, startOffset, endOffset, (raw) => {
    const headLimit = Math.min(HEADER_LIMIT, raw.length);
    // Buffer.includes 没有"结束偏移"参数，必须先切窗，否则第三个实参会被当成编码
    const headBuf = raw.subarray(0, headLimit);
    if (!USAGE_RECORD_MARKERS.some((marker) => headBuf.includes(marker, "utf8"))) return;
    const headText = raw.toString("utf8", 0, headLimit);
    const head = codexProbeRecordHeader(headText);
    if (!head.timestamp) return;
    const rootType = head.rootType;
    if (rootType === "token_usage_record"
      || (rootType === "event_msg" && (head.payloadType === "token_count" || head.payloadType === "task_started"))) {
      onRecord("token", raw.toString("utf8"));
      return;
    }
    if (rootType !== null && MODEL_RECORD_TYPES.includes(rootType)) {
      if (head.model) {
        onRecord("model", head.model);
        return;
      }
      // model 字段可能被巨大的 permission_profile / instructions 顶到 1KB 之外，按 64KB 上界继续探
      const limit = Math.min(MODEL_LIMIT, raw.length);
      const sizes: number[] = [];
      for (let take = headLimit + 1024; take < limit; take += 1024) sizes.push(take);
      sizes.push(limit); // 尾段可能不足 1KB，必须连最后一段一起探，否则小行的 model 永远读不到
      for (const size of sizes) {
        const probed = codexProbeRecordHeader(raw.toString("utf8", 0, size));
        if (probed.model) {
          onRecord("model", probed.model);
          return;
        }
      }
    }
  });
}

/** 对应 _codex_rollout_files：sessions + archived_sessions 下的 rollout-*.jsonl，按 normcase(realpath) 去重 */
export function codexRolloutFiles(): string[] {
  const roots = existingDirs(
    codexRoots("TOKEI_CODEX_DIR", CODEX_SESSIONS_DEFAULT)
      .concat(codexRoots("TOKEI_CODEX_ARCHIVED_DIR", CODEX_ARCHIVED_DEFAULT)),
  );
  const files: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const matched = walkRolloutFiles(root);
    for (const candidate of matched) {
      let real = candidate;
      try {
        real = fs.realpathSync(candidate);
      } catch {
        continue;
      }
      const key = normcase(real);
      if (seen.has(key) || !isFile(real)) continue;
      seen.add(key);
      files.push(real);
    }
  }
  return files;
}

function walkRolloutFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < 20000) {
    const dir = stack.pop()!;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile() && /^rollout-.*\.jsonl$/.test(item.name)) out.push(full);
    }
  }
  return out.sort();
}

/** 对应 _codex_config + _codex_is_custom_provider：只认显式声明的顶层 model_provider */
export function codexIsCustomProvider(configFile: string = codexConfigPath()): boolean {
  let text: string;
  try {
    text = fs.readFileSync(configFile, "utf8").slice(0, 64 * 1024);
  } catch {
    return false;
  }
  // TOML 规定顶层键必须写在第一个 [section] 之前，遇到表头就停，避免把
  // [model_providers.custom] 段里的同名键误当成顶层选择。
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const hit = /^\s*model_provider\s*=\s*["']([^"']+)["']/.exec(line);
    if (hit) return hit[1] !== "openai";
  }
  return false;
}

function localDay(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function stableStringify(value: Record<string, any>): string {
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(value[k])}`).join(",")}}`;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

// ---------- 单文件解析 ----------

interface ParseState {
  events: CodexEvent[];
  session_id: string | null;
  forked_from_id: string | null;
  history_base: Record<string, any> | null | undefined;
  limits: Record<string, any> | null;
  limits_ts: string | null;
  plan: string | null;
  g_limits: Record<string, any> | null;
  g_ts: string | null;
  g_plan: string | null;
  reserve_limits: Record<string, any> | null;
  reserve_limits_ts: string | null;
  last_total: Record<string, any> | null;
  prev_total_key: number[] | null;
  active_model: string | null;
  response_ids: Set<string>;
  pending_responses: number[][];
  last_legacy_snapshot: (number | null)[] | null;
  mutated_prior: boolean;
}

function usageTuple(source: Record<string, any>): number[] {
  return [num(source.input_tokens), num(source.cached_input_tokens), num(source.output_tokens), num(source.reasoning_output_tokens)];
}
function sameNumbers(a: (number | null)[] | null | undefined, b: (number | null)[] | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * 对应 scan_codex 的 3821-3936 行解析循环。
 * 去重规则（严格按 Python，不做近似）：
 *  A. token_usage_record.payload.usage 按 response_id 去重（含跨增量扫描的持久集合）。
 *  B. 双写：token_usage_record 的 thread_token_usage+usage 快照与上一条旧式 token_count
 *     快照完全一致时，视为同一笔 —— 把 response_id 补到已计入的事件上，不重复计数。
 *  C. 旧式 token_count 的 mirror 命中 pending_responses（响应先到、旧式通知后到）时整笔抵扣。
 *  D. 同一文件内 total_token_usage 快照连续重复（Codex 会重复吐同一累计快照）时不重复计 last。
 *  E. fork/子代理会话开头的父前缀在装配阶段扣除（见 codexCachedDropCount）。
 *  F. payload.thread_id 与本会话 id 不一致的响应是分叉复制来的，直接丢弃。
 */
function parseRolloutRange(file: string, from: number, to: number, state: ParseState, priorEvents: CodexEvent[] | null): void {
  // 事件级"已计入"数组：本轮新解析出来的；增量模式下本轮为空时要能改到已缓存的那批
  const currentEvents = state.events;
  const mirrorTargets = (): CodexEvent[] => (currentEvents.length ? currentEvents : (priorEvents ?? currentEvents));

  iterCodexUsageRecords(file, from, to, (kind, value) => {
    if (kind === "model") {
      state.active_model = value;
      return;
    }
    let record: Record<string, any>;
    try {
      record = JSON.parse(value);
    } catch {
      return;
    }
    const ts = parseTs(record.timestamp ?? "");
    if (!ts) return;
    const payload = isObj(record.payload) ? record.payload : {};
    if (payload.type === "task_started") {
      // 新一轮开始：上一轮的待抵扣镜像与旧快照关系作废
      state.pending_responses = [];
      state.last_legacy_snapshot = null;
      return;
    }
    const isResponse = record.type === "token_usage_record";
    let responseId: string | null = null;
    let info: Record<string, any>;
    if (isResponse) {
      const usage = isObj(payload.usage) ? payload.usage : null;
      if (!usage) return;
      const responseUsage = usageTuple(usage);
      const rawId = payload.response_id;
      responseId = rawId ? sha256(String(rawId)) : null;
      if (responseId && state.response_ids.has(responseId)) return;
      if (responseId) state.response_ids.add(responseId);
      const responseTotal = isObj(payload.thread_token_usage) ? payload.thread_token_usage : {};
      const snapshotKey = [...usageTuple(responseTotal), ...responseUsage];
      if (Object.keys(responseTotal).length && sameNumbers(snapshotKey, state.last_legacy_snapshot)) {
        // 规则 B：旧式通知已经先计入，把身份挂到那条事件上，让跨段重叠也能按 id 去重
        const prior = mirrorTargets();
        if (responseId && prior.length && JSON.stringify(prior[prior.length - 1].slice(2, 10)) === JSON.stringify(snapshotKey)) {
          prior[prior.length - 1][12] = responseId;
          if (prior === priorEvents) state.mutated_prior = true;
        }
        state.last_legacy_snapshot = null;
        return;
      }
      state.pending_responses.push(responseUsage);
      const owner = payload.thread_id;
      if (owner && state.session_id && owner !== state.session_id) return; // 规则 F
      info = { last_token_usage: usage, total_token_usage: responseTotal };
    } else {
      info = isObj(payload.info) ? payload.info : {};
    }

    const last = isObj(info.last_token_usage) ? info.last_token_usage : {};
    const total = isObj(info.total_token_usage) ? info.total_token_usage : {};
    let totalKey: number[] | null = null;
    let duplicateTotal = false;
    if (Object.keys(total).length) {
      totalKey = usageTuple(total);
      duplicateTotal = !isResponse && sameNumbers(totalKey, state.prev_total_key); // 规则 D
      state.prev_total_key = totalKey;
      state.last_total = total;
    }
    if (!isResponse && Object.keys(last).length) {
      const mirror = usageTuple(last);
      state.last_legacy_snapshot = [...(totalKey ?? [null, null, null, null]), ...mirror];
      const hitIndex = state.pending_responses.findIndex((pending) => sameNumbers(pending, mirror));
      if (hitIndex >= 0) {
        duplicateTotal = true; // 规则 C
        state.pending_responses.splice(hitIndex, 1);
        if (codexIsReserveLimits(payload.rate_limits)) {
          const targets = mirrorTargets();
          if (codexBackfillReserveMirror(targets, mirror) && targets === priorEvents) state.mutated_prior = true;
        }
      }
    }

    const rl = isObj(payload.rate_limits) ? payload.rate_limits : null;
    if (rl) {
      const tsIso = isoTimestamp(ts.date);
      if (state.g_ts === null || tsIso > state.g_ts) {
        state.g_ts = tsIso;
        state.g_limits = rl;
        state.g_plan = rl.plan_type ?? null;
      }
      if (rl.limit_id === "codex" && (state.limits_ts === null || tsIso > state.limits_ts)) {
        state.limits_ts = tsIso;
        state.limits = rl;
        state.plan = rl.plan_type ?? null;
      }
      // Reserve 是第二缸油：额度独立展示，不混进主额度读数
      if (codexIsReserveLimits(rl) && (state.reserve_limits_ts === null || tsIso > state.reserve_limits_ts)) {
        state.reserve_limits_ts = tsIso;
        state.reserve_limits = rl;
      }
    }

    if (Object.keys(last).length && !duplicateTotal) {
      const li = num(last.input_tokens);
      const lc = num(last.cached_input_tokens);
      const lo = num(last.output_tokens);
      const lr = num(last.reasoning_output_tokens);
      // 无模型字段的老 CLI 日志标 unknown，不冒充 gpt-5.5；计费仍按 gpt-5.5 保守估算
      let model = modelIdentityId(state.active_model) ?? "unknown";
      // 同一文件可先走主额度后切 Reserve：事件级额度优先于文件级模型
      if (rl && codexIsReserveLimits(rl)) model = CODEX_RESERVE_MODEL;
      const cost = codexEstimatedCost(model, li, lc, lo);
      if (li || lc || lo || lr) {
        const totals = totalKey ?? [null, null, null, null];
        state.events.push([isoTimestamp(ts.date), ts.day, totals[0], totals[1], totals[2], totals[3], li, lc, lo, lr, cost, model, responseId]);
      }
    }
  });
}

// ---------- 主入口 ----------

function emptyCodexBucket(): CodexBucket {
  return { in: 0, cached: 0, out: 0, reason: 0, cost: 0, sessions: new Set<string>(), models: {} };
}
function emptyCodexRangeMap(): Record<RangeKey, CodexRangeOut> {
  return Object.fromEntries(RANGE_KEYS.map((k) => [k, codexRange(emptyCodexBucket(), codexPriceModel)])) as Record<RangeKey, CodexRangeOut>;
}

function emptyResult(): CodexScanResult {
  return {
    ranges: emptyCodexRangeMap(),
    reserve_ranges: emptyCodexRangeMap(),
    reserve_quota: null,
    plan: null,
    p5: null, pw: null, r5: null, rw: null,
    limits_updated: null, q_updated: null,
    p5_stale: null, pw_stale: null,
    limits: null,
    limits_consumed: { p5: null, pw: null },
    cur_total: null,
    days: {},
    reserve_days: {},
    hours: new Array(24).fill(0),
    reserve_hours: new Array(24).fill(0),
    projects: {},
    reset_cards: null,
  };
}

/**
 * 持久账本合并（对应 ledger_reconcile(tool, live_days, sources)）：日志被删除后
 * 用 ~/.tokei/ledger.json 的历史日账兜底，主额度与 Reserve 各记各的工具键。
 */
export function codexLedgerReconcile(
  tool: string,
  days: Record<string, CodexDay>,
  sources: Record<string, Record<string, DayRecord>>,
): Record<string, CodexDay> {
  return ledgerReconcile(tool, days, sources) as Record<string, CodexDay>;
}

/**
 * 对应 fetch_codex_live_limits() 的返回值 (limits, plan_type, 抓取时刻)。
 * 联网抓取不在采集器里做：主进程每轮先取好，再作为 scanCodex 的第三个参数传进来，
 * 采集器只做「这条 live 是否比日志里那条新」的判定与覆盖。
 */
export type CodexLiveResult = [limits: Record<string, any> | null, plan: any, fetchedAt: number] | null;

/** 对应 _codex_live_snapshot_is_current(2219)：日志那条没有时间或时间读不出来时，live 一律胜出 */
function codexLiveSnapshotIsCurrent(liveUpdated: number, localUpdated: string | null): boolean {
  if (!localUpdated) return true;
  const parsed = parseTs(localUpdated);
  if (!parsed) return true;
  return liveUpdated >= parsed.epoch;
}

/** 对应 scan_codex()：历史账本已接（ledger_touch + 混合账本迁移 + 双工具 reconcile） */
export function scanCodex(
  bounds: Bounds, cache: Record<string, any>, live?: CodexLiveResult,
): CodexScanResult {
  ledgerTouch("codex");
  const fc: Record<string, CodexFileEntry> = (cache.codex ??= {});
  // 对应 4420-4424：这一轮价目表变过，未重新解析的文件条目先按新价重算缓存日账
  if (cache._pricing_changed && repriceCodexEventCaches(
    fc,
    Array.isArray(cache._pricing_changed_models) ? cache._pricing_changed_models : [],
    isObj(cache._pricing_cost_multipliers) ? cache._pricing_cost_multipliers : {},
  )) cache._dirty = true;
  const rolloutFiles = codexRolloutFiles();
  const activeSessionsDir = codexSessionsDir();
  const activeRoot = isDirectory(activeSessionsDir) ? safeRealpath(activeSessionsDir) : null;

  let curFile: string | null = null;
  let curMtime = -1;
  const stale = new Set(Object.keys(fc));
  const dedupePaths = new Set<string>();

  for (const file of rolloutFiles) {
    stale.delete(file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const mtime = stat.mtimeMs / 1000;
    const isCurrent = activeRoot !== null && isWithin(activeRoot, file);
    if (isCurrent && mtime > curMtime) {
      curMtime = mtime;
      curFile = file;
    }
    const sig = `${mtime}:${stat.size}`;
    const entry: CodexFileEntry | undefined = fc[file];
    // 与 Python 一致：sig 命中且解析/记账版本齐全、事件数组还在，就整文件跳过，
    // 连完整偏移和校验哈希都不用算（这就是"未变文件永不重读"的那条硬要求）。
    if (entry && entry.sig === sig
      && entry.parser_version === CODEX_PARSER_VERSION
      && entry.accounting_version === CODEX_ACCOUNTING_VERSION
      && Array.isArray(entry.events)) {
      continue;
    }

    const completeOffset = codexCompleteOffset(file, stat.size);
    const fileId = `${stat.dev}:${stat.ino}`;
    // 增量续读：只有版本一致、同一文件、上次停下来的偏移仍在完整记录边界上才追加
    let appendFrom: number | null = null;
    if (entry && Array.isArray(entry.events)
      && entry.parser_version === CODEX_PARSER_VERSION
      && entry.accounting_version === CODEX_ACCOUNTING_VERSION
      && entry.file_id === fileId
      && entry.parsed_size <= completeOffset
      && entry.parsed_guard === codexOffsetGuard(file, entry.parsed_size)) {
      appendFrom = entry.parsed_size;
    }

    const state: ParseState = appendFrom === null || !entry ? {
      events: [],
      session_id: null, forked_from_id: null, history_base: undefined,
      limits: null, limits_ts: null, plan: null,
      g_limits: null, g_ts: null, g_plan: null,
      reserve_limits: null, reserve_limits_ts: null,
      last_total: null, prev_total_key: null, active_model: null,
      response_ids: new Set<string>(), pending_responses: [], last_legacy_snapshot: null,
      mutated_prior: false,
    } : {
      events: [],
      session_id: entry.session_id ?? null,
      forked_from_id: entry.forked_from_id ?? null,
      history_base: entry.history_base,
      limits: entry.limits ?? null, limits_ts: entry.limits_ts ?? null, plan: entry.plan ?? null,
      g_limits: entry.g_limits ?? null, g_ts: entry.g_ts ?? null, g_plan: entry.g_plan ?? null,
      reserve_limits: entry.reserve_limits ?? null, reserve_limits_ts: entry.reserve_limits_ts ?? null,
      last_total: entry.last_total ?? null,
      prev_total_key: entry.prev_total_key ?? null,
      active_model: entry.active_model ?? null,
      response_ids: new Set<string>(entry.response_ids ?? []),
      pending_responses: (entry.pending_responses ?? []).map((row) => [...row]),
      last_legacy_snapshot: entry.last_legacy_snapshot ?? null,
      mutated_prior: false,
    };

    if (appendFrom === null || !entry) {
      const [sessionId, forkedFromId, historyBase] = codexSessionMeta(file);
      state.session_id = sessionId;
      state.forked_from_id = forkedFromId;
      state.history_base = historyBase;
    }

    const priorEvents = appendFrom === null || !entry ? null : entry.events;
    try {
      parseRolloutRange(file, appendFrom ?? 0, completeOffset, state, priorEvents);
    } catch {
      continue;
    }

    const merged: CodexEvent[] = appendFrom === null || !entry || !priorEvents
      ? state.events
      : priorEvents.concat(state.events);

    const dedupedDays: Record<string, CodexDay> = {};
    let dropCount = 0;
    let dedupeOpen = true;
    if (appendFrom === null || !entry) {
      dedupePaths.add(file);
    } else {
      Object.assign(dedupedDays, entry.deduped_days ?? entry.days ?? {});
      dropCount = num(entry.drop_count);
      dedupeOpen = !!entry.dedupe_open;
      // 本轮若改写了已缓存事件（补 response_id / Reserve 归类），必须整文件重建，
      // 否则跨段去重看到的还是旧身份，重复计数。
      if (dedupeOpen || state.mutated_prior) dedupePaths.add(file);
      else for (const event of state.events) codexAddEvent(dedupedDays, event);
    }

    const metadata = codexEventMetadata(merged);
    const next: CodexFileEntry = {
      sig,
      events: merged,
      days: entry?.days ?? {},
      deduped_days: dedupedDays,
      session_id: state.session_id,
      forked_from_id: state.forked_from_id,
      history_base: state.history_base,
      limits: state.limits, limits_ts: state.limits_ts, plan: state.plan,
      g_limits: state.g_limits, g_ts: state.g_ts, g_plan: state.g_plan,
      reserve_limits: state.reserve_limits, reserve_limits_ts: state.reserve_limits_ts,
      last_total: state.last_total,
      prev_total_key: state.prev_total_key,
      active_model: state.active_model,
      parser_version: CODEX_PARSER_VERSION,
      accounting_version: CODEX_ACCOUNTING_VERSION,
      response_ids: [...state.response_ids].sort(),
      pending_responses: state.pending_responses,
      last_legacy_snapshot: state.last_legacy_snapshot,
      file_id: fileId,
      parsed_size: completeOffset,
      parsed_guard: codexOffsetGuard(file, completeOffset),
      event_count: metadata.event_count,
      first_keys: metadata.first_keys,
      first_event_ts: metadata.first_event_ts,
      last_event_ts: metadata.last_event_ts,
      drop_count: dropCount,
      dedupe_open: dedupeOpen,
      canonical: !!entry?.canonical,
      dedupe_peers: entry?.dedupe_peers,
      proj: entry?.proj,
    };
    fc[file] = next;
    cache["_dirty"] = true;
  }

  for (const pathKey of stale) {
    delete fc[pathKey];
    cache["_dirty"] = true;
  }

  // 没有会话日志本来就是空结果，但带 live 读数时不能这么早退：Python 的 scan_codex
  // 一路走到底把 fetch_codex_live_limits 的值并进 payload，日志为空也要显示实时额度。
  if (!Object.keys(fc).length && !live) return emptyResult();

  // 同一会话可能同时存在于 sessions/ 与 archived_sessions/，先挑更完整的那份再做前缀去重
  for (const pathKey of codexLinkSegmentMirrors(fc)) dedupePaths.add(pathKey);

  // 项目路径按需补齐（_codex_session_cwd 那段）：超窗的直接写空串占位不开文件，
  // 窗内的最近活跃优先、每轮最多 150 个，免得升级后第一轮为几千个会话扛几十秒。
  {
    const horizon = isoTimestamp(new Date(Date.now() - CODEX_PROJECT_BACKFILL_DAYS * 86400_000));
    const pending: { stamp: string; file: string; entry: CodexFileEntry }[] = [];
    let touched = false;
    for (const [file, entry] of Object.entries(fc)) {
      if (entry.proj !== undefined) continue;
      const stamp = String(entry.last_event_ts ?? "");
      if (stamp >= horizon) pending.push({ stamp, file, entry });
      else { entry.proj = ""; touched = true; }
    }
    if (pending.length) {
      pending.sort((a, b) => (a.stamp === b.stamp ? (a.file < b.file ? 1 : -1) : (a.stamp < b.stamp ? 1 : -1)));
      for (const item of pending.slice(0, CODEX_PROJECT_BACKFILL_PER_SCAN)) {
        item.entry.proj = codexSessionCwd(item.file) ?? "";
        touched = true;
      }
    }
    if (touched) cache["_dirty"] = true;
  }

  const canonical = codexCanonicalFileCache(fc);
  for (const [file, entry] of Object.entries(fc)) {
    const isCanonical = Object.prototype.hasOwnProperty.call(canonical, file);
    if (isCanonical && !entry.canonical) dedupePaths.add(file);
    if (!!entry.canonical !== isCanonical) {
      entry.canonical = isCanonical;
      cache["_dirty"] = true;
    }
  }

  // 同一 thread id 的多个运行时段可能重叠响应，必须整组重建，避免热扫描留着过期副本
  const sessionGroups = new Map<string, string[]>();
  for (const [file, entry] of Object.entries(canonical)) {
    const key = String(entry.session_id ?? file);
    const list = sessionGroups.get(key);
    if (list) list.push(file);
    else sessionGroups.set(key, [file]);
  }
  const sharedSeen = new Map<string, Set<string>>();
  for (const [, files] of sessionGroups) {
    const peers = [...files].sort();
    for (const file of files) {
      const entry = canonical[file];
      if (JSON.stringify(entry.dedupe_peers ?? null) !== JSON.stringify(peers)) {
        entry.dedupe_peers = peers;
        dedupePaths.add(file);
        cache["_dirty"] = true;
      }
      if (files.length > 1) {
        // 整组共用同一个 seen 集合：同 thread id 的多段之间响应会重叠，
        // 各自一份集合就退化成文件内去重，跨段重复会被计两次。
        let seen = sharedSeen.get(files[0]);
        if (!seen) {
          seen = new Set<string>();
          for (const file of files) {
            sharedSeen.set(file, seen);
            dedupePaths.add(file);
          }
        }
      }
    }
  }

  for (const file of [...dedupePaths].sort()) {
    const entry = canonical[file];
    if (!entry) continue;
    const [drop, open] = codexCachedDropCount(file, entry, canonical);
    const days = codexDaysFromCachedEvents(entry, drop, entry.event_count, sharedSeen.get(file) ?? null);
    if (entry.drop_count !== drop || entry.dedupe_open !== open || !sameDays(entry.deduped_days, days)) {
      entry.drop_count = drop;
      entry.dedupe_open = open;
      entry.deduped_days = days;
      cache["_dirty"] = true;
    }
  }

  for (const [file, entry] of Object.entries(fc)) {
    const days = Object.prototype.hasOwnProperty.call(canonical, file) ? (entry.deduped_days ?? {}) : {};
    if (!sameDays(entry.days, days)) {
      entry.days = days;
      cache["_dirty"] = true;
    }
  }

  const split = codexSplitSources(canonical);
  // 混合账本迁移必须在对账之前：老账本里混着 Reserve 的主快照要先拆开，
  // 否则同一天会被「主 + 主里含的 Reserve」双计（对应 _codex_migrate_mixed_ledger）
  codexMigrateMixedLedger(split.mainSources, split.reserveSources);
  const mainDays = codexLedgerReconcile("codex", split.mainDays, split.mainSources);
  const reserveDays = codexLedgerReconcile("codex_reserve", split.reserveDays, split.reserveSources);
  const { mainSessions, reserveSessions } = split;

  const B = Object.fromEntries(RANGE_KEYS.map((k) => [k, emptyCodexBucket()])) as Record<RangeKey, CodexBucket>;
  const RB = Object.fromEntries(RANGE_KEYS.map((k) => [k, emptyCodexBucket()])) as Record<RangeKey, CodexBucket>;
  assembleRanges(B, mainDays, mainSessions, bounds);
  assembleRanges(RB, reserveDays, reserveSessions, bounds);

  // 跨所有缓存文件挑最新的额度读数
  let latestLimits: Record<string, any> | null = null;
  let latestTs: string | null = null;
  let planType: string | null = null;
  let reserveLimits: Record<string, any> | null = null;
  let reserveTs: string | null = null;
  let gLimits: Record<string, any> | null = null;
  let gTs: string | null = null;
  for (const entry of Object.values(fc)) {
    if (entry.limits_ts && (latestTs === null || entry.limits_ts > latestTs)) {
      latestTs = entry.limits_ts;
      latestLimits = entry.limits ?? null;
      planType = entry.plan ?? null;
    }
    if (entry.reserve_limits_ts && (reserveTs === null || entry.reserve_limits_ts > reserveTs)) {
      reserveTs = entry.reserve_limits_ts;
      reserveLimits = entry.reserve_limits ?? null;
    }
    if (entry.g_ts && (gTs === null || entry.g_ts > gTs)) {
      gTs = entry.g_ts;
      gLimits = entry.g_limits ?? null;
    }
  }
  let selectedLimitsTs = latestTs;
  if (latestLimits === null && gLimits !== null && !codexIsReserveLimits(gLimits)) {
    latestLimits = gLimits;
    planType = gLimits.plan_type ?? null;
    selectedLimitsTs = gTs;
  }
  // 读数时间：live 真正胜出时用抓取时刻，否则用日志里那条记录的时间
  let limitsUpdated = isoToEpoch(selectedLimitsTs);
  // 对应 scan_codex 里的 fetch_codex_live_limits 覆盖段（4166-4172）：
  // live 读数不早于日志那条才算新，plan_type 也是 live 优先
  if (live) {
    const [liveLimits, livePlan, liveFetchedAt] = live;
    if (codexLiveSnapshotIsCurrent(liveFetchedAt, selectedLimitsTs)) {
      latestLimits = liveLimits ?? null;
      const chosen = livePlan || (liveLimits ? liveLimits.plan_type : null) || planType;
      planType = chosen ? String(chosen) : null;
      limitsUpdated = Math.trunc(liveFetchedAt);
    }
  }

  // 窗口翻篇后本机又消耗了多少 —— 用来区分"确实回满了"和"读数已经失真"。
  // nowEpoch=0 只做槽位归类，不触发过期处理。
  const slots = codexQuotaValues(latestLimits, 0, null);
  const limitsConsumed = {
    p5: codexUsedSince(mainDays, slots.r5),
    pw: codexUsedSince(mainDays, slots.rw),
  };

  // 第三方中转下官方额度没有意义，老会话留下的过期读数也不能展示
  if (codexIsCustomProvider()) {
    latestLimits = null;
    reserveLimits = null;
    planType = null;
  }

  let curTotal: Record<string, any> | null = null;
  if (curFile && fc[curFile]) curTotal = fc[curFile].last_total ?? null;

  let reserveQuota: CodexReserveQuota | null = null;
  if (reserveLimits) {
    const rPrimary = isObj(reserveLimits.primary) ? reserveLimits.primary : {};
    const isWeek = rPrimary.window_minutes === WEEK_MINUTES;
    const pctKey = isWeek ? "pw" : "p5";
    const resetKey = isWeek ? "rw" : "r5";
    const initial = codexQuotaValues(reserveLimits, 0, null);
    const consumed = codexUsedSince(reserveDays, (initial as any)[resetKey]);
    const normalized = codexQuotaValues(reserveLimits, undefined, { [pctKey]: consumed });
    reserveQuota = {
      used_percent: (normalized as any)[pctKey],
      resets_at: (normalized as any)[resetKey],
      window_minutes: rPrimary.window_minutes ?? null,
      plan: reserveLimits.plan_type ?? null,
      updated: isoToEpoch(reserveTs),
      stale: !!(normalized as any)[`${pctKey}_stale`],
    };
  }

  const quota = codexQuotaValues(latestLimits, undefined, limitsConsumed);

  // 逐时曲线：CodexDay.hours 本身就是 in(含缓存)+out(含推理) 口径，直接按槽位累加
  const hours = new Array(24).fill(0);
  for (const day of Object.values(mainDays)) {
    const list = Array.isArray(day.hours) ? day.hours : [];
    for (let h = 0; h < 24; h++) hours[h] += num(list[h]);
  }
  const reserveHours = new Array(24).fill(0);
  for (const day of Object.values(reserveDays)) {
    const list = Array.isArray(day.hours) ? day.hours : [];
    for (let h = 0; h < 24; h++) reserveHours[h] += num(list[h]);
  }

  // 项目足迹：cwd 读不到的会话直接跳过，与 Python _project_contributions 一致
  const projects: Record<string, Record<string, CodexDay>> = {};
  for (const [, entry] of Object.entries(canonical)) {
    const projPath = entry.proj ?? "";
    if (!projPath) continue;
    const name = path.basename(projPath.replace(/[\\/]+$/, "")) || "?";
    const bucket = (projects[name] ??= {});
    for (const [dk, day] of Object.entries(entry.days ?? {})) {
      bucket[dk] = mergeCodexDays(bucket[dk] ?? ({} as CodexDay), day);
    }
  }

  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, codexRange(B[k], codexPriceModel)])) as Record<RangeKey, CodexRangeOut>,
    reserve_ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, codexRange(RB[k], codexPriceModel)])) as Record<RangeKey, CodexRangeOut>,
    reserve_quota: reserveQuota,
    plan: planType,
    p5: quota.p5, pw: quota.pw, r5: quota.r5, rw: quota.rw,
    limits_updated: limitsUpdated,
    q_updated: limitsUpdated,
    p5_stale: quota.p5_stale, pw_stale: quota.pw_stale,
    limits: latestLimits,
    limits_consumed: limitsConsumed,
    cur_total: curTotal,
    days: mainDays,
    reserve_days: reserveDays,
    hours,
    reserve_hours: reserveHours,
    projects,
    reset_cards: null,
  };
}

function assembleRanges(
  target: Record<RangeKey, CodexBucket>,
  days: Record<string, CodexDay>,
  sessions: Record<string, Set<string>>,
  bounds: Bounds,
): void {
  for (const [dk, day] of Object.entries(days)) {
    let keys: RangeKey[];
    try {
      keys = classifyDay(dk, bounds);
    } catch {
      continue;
    }
    for (const key of keys) {
      const bucket = target[key];
      bucket.in += num(day.in);
      bucket.cached += num(day.cached);
      bucket.out += num(day.out);
      bucket.reason += num(day.reason);
      bucket.cost += flt(day.cost);
      const identities = sessions[dk];
      if (identities) for (const identity of identities) bucket.sessions.add(identity);
      for (const [model, usage] of Object.entries(day.models ?? {})) {
        addModelUsage(bucket.models, model, {
          inp: usage.in, out: usage.out, cr: usage.cr, cw: usage.cw, reason: usage.reason, cost: usage.cost,
        });
      }
    }
  }
}

function codexEventMetadata(events: CodexEvent[]): { event_count: number; first_keys: string[]; first_event_ts: string | null; last_event_ts: string | null } {
  const keys: string[] = [];
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  for (const event of events) {
    if (firstTs === null && event && event.length) firstTs = String(event[0]);
    if (event && event.length) lastTs = String(event[0]);
    if (keys.length < 2) {
      const key = codexEventKey(event);
      if (key !== null) keys.push(key);
    }
  }
  return { event_count: events.length, first_keys: keys, first_event_ts: firstTs, last_event_ts: lastTs };
}

function sameDays(left: Record<string, CodexDay> | undefined, right: Record<string, CodexDay>): boolean {
  const a = left ?? {};
  const ka = Object.keys(a);
  const kb = Object.keys(right);
  if (ka.length !== kb.length) return false;
  return JSON.stringify(a) === JSON.stringify(right);
}

function isoToEpoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = parseTs(value);
  return parsed ? Math.trunc(parsed.epoch) : null;
}

function safeRealpath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

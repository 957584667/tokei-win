/**
 * 额度详情（额度页的周期切分 + 多设备合并）：对应 usage.30s.py 15488-15953。
 *
 * 额度百分比是账号级的，token 体量却是每台机器各自记的：单看本机会把「活儿在另一台
 * 机器上干的」那段漏掉，所以详情要把 sync/ 里 peer 的账本与锚点一起吃进来。
 * 周期边界靠 ~/.tokei/quota_cycles.json 里的观测锚点切，锚点只在真正读到读数时落盘。
 *
 * 与 Python 的三处结构性差别（都在函数注释里逐条标注）：
 * 1. 扫描缓存在 Windows 只活在主进程内存里（没有 ~/.tokei/scan_cache.json），
 *    所以 buildQuotaDetail 由调用方把 cache 传进来；
 * 2. Codex 的事件也在内存条目 entry.events 上，不再从 per-file 事件缓存逐行读；
 * 3. 重算（Python 的 compute()）由调用方以回调形式给出，核心层不拉任何子进程。
 */
import * as fs from "fs";
import * as path from "path";
import { TOKEI_DIR, expandPath, loadJson, saveJson } from "./paths";
import { dayKey, parseDay, parseTs } from "./ranges";
import { LedgerTools, loadLedger } from "./ledger";
import { ClaudeEvent, claudeEventTotal, dedupeClaudeEvents } from "../collectors/claude";

/** 对应 _QUOTA_CYCLE_HISTORY：详情最多带回约一年的周周期，界面默认只展示 8 个 */
export const QUOTA_CYCLE_HISTORY = 52;
/** 对应 _QUOTA_WEEK_HOURS */
export const QUOTA_WEEK_HOURS = 7 * 24;
/** 对应 _QUOTA_SELF_DEVICE */
export const QUOTA_SELF_DEVICE = "本机";
/** 对应 _QUOTA_ANCHOR_JITTER：resets_in_seconds 是整秒截断的，同一锚点跨机器读数差几秒 */
export const QUOTA_ANCHOR_JITTER = 120;
/** 对应 _QUOTA_CYCLE_MIN_USED_PCT */
export const QUOTA_CYCLE_MIN_USED_PCT = 2;
/** 对应 _QUOTA_TOOLS：有周额度窗口的三个工具 → 日表里的短键 */
export const QUOTA_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["claude", "c"],
  ["codex", "x"],
  ["grok", "g"],
];

const DEFAULT_ANCHOR_FILE = path.join(TOKEI_DIR, "quota_cycles.json");
const DEFAULT_DETAIL_FILE = path.join(TOKEI_DIR, "quota_detail.json");
const DEFAULT_CONFIG_FILE = path.join(TOKEI_DIR, "config.json");
const DEFAULT_LAST_USAGE_FILE = path.join(TOKEI_DIR, "last_usage.json");
/** 对应 _QUOTA_ANCHOR_FILE 之外那份 HOME/.tokei/sync 兜底 */
const DEFAULT_SYNC_DIR = path.join(TOKEI_DIR, "sync");

/** 对应 _recent_quota_detail_payload 的 60 秒窗口 */
const RECENT_PAYLOAD_MAX_AGE = 60;

export interface QuotaDetailFiles {
  anchorFile?: string | null;
  syncDir?: string | null;
  detailFile?: string | null;
  configFile?: string | null;
  lastUsageFile?: string | null;
}

const target = {
  anchorFile: DEFAULT_ANCHOR_FILE,
  syncDir: null as string | null,
  detailFile: DEFAULT_DETAIL_FILE,
  configFile: DEFAULT_CONFIG_FILE,
  lastUsageFile: DEFAULT_LAST_USAGE_FILE,
};

/**
 * 测试注入口（仿 useProviderQuotaFiles）：锚点、peer 快照目录、详情缓存全指到临时目录，
 * 单测绝不写真实的 ~/.tokei。configFile / lastUsageFile 也一并给出去，因为设备身份
 * （device_id、sync_dir）与「最近快照新鲜度」那两条判定都要读盘。
 */
export function useQuotaDetailFiles(files?: QuotaDetailFiles | null): void {
  target.anchorFile = files?.anchorFile ?? DEFAULT_ANCHOR_FILE;
  target.syncDir = files?.syncDir ?? null;
  target.detailFile = files?.detailFile ?? DEFAULT_DETAIL_FILE;
  target.configFile = files?.configFile ?? DEFAULT_CONFIG_FILE;
  target.lastUsageFile = files?.lastUsageFile ?? DEFAULT_LAST_USAGE_FILE;
}

export function quotaDetailAnchorFile(): string {
  return target.anchorFile;
}

export function quotaDetailCacheFile(): string {
  return target.detailFile;
}

export function quotaDetailLastUsageFile(): string {
  return target.lastUsageFile;
}

/** 对应 _QUOTA_ANCHOR_FILE 的读写口与 _TOKEI_CONFIG 的读取（供测试与主进程取路径） */
export function quotaDetailPaths(): { anchorFile: string; syncDir: string; detailFile: string; configFile: string; lastUsageFile: string } {
  return {
    anchorFile: target.anchorFile,
    syncDir: resolvedSyncDir(readTokeiConfig()),
    detailFile: target.detailFile,
    configFile: target.configFile,
    lastUsageFile: target.lastUsageFile,
  };
}

function isDict(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 对应 Python 的 int(x or 0)：falsy 归 0，其余截断取整。
 * 差别是坏值（NaN、"abc"）Python 会抛 ValueError 让整次采集崩掉，这里按 0 处理 ——
 * 面板不能因为一份被截断的快照整体打不开。
 */
function intOr(value: unknown): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 对应 float(used or 0) */
function floatOrZero(value: unknown): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 对应 datetime.fromtimestamp(x).hour / .minute / .second：一律按本机时区 */
function localDate(epoch: number): Date {
  return new Date(epoch * 1000);
}

function epochOf(date: Date): number {
  return Math.trunc(date.getTime() / 1000);
}

function addLocalDays(day: string, days: number): string {
  const date = parseDay(day);
  date.setDate(date.getDate() + days);
  return dayKey(date);
}

function epochNow(): number {
  return Math.trunc(Date.now() / 1000);
}

/** 对应 _iso_to_epoch */
export function isoToEpoch(value: unknown): number | null {
  if (!value) return null;
  const parsed = parseTs(value);
  return parsed ? Math.trunc(parsed.epoch) : null;
}

/** 对应 _quota_local_day_range：本地自然日的 [start, end) 秒区间 */
export function quotaLocalDayRange(day: string): [number, number] {
  const start = parseDay(day);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [epochOf(start), epochOf(end)];
}

/** 对应 _quota_day_tokens：一天的 token 数。三个工具口径不同，别混。 */
export function quotaDayTokens(tool: string, entry: unknown): number {
  if (!isDict(entry)) return 0;
  if (tool === "claude") {
    return (["in", "out", "cr", "cw"] as const).reduce((sum, k) => sum + intOr(entry[k]), 0);
  }
  if (tool === "codex") {
    // 账本里的 codex "in" 已含 cached（与 ranges 相反，那边 in 是未缓存部分），
    // 再加 cached 会翻倍。
    return intOr(entry.in) + intOr(entry.out);
  }
  if (entry.tokens !== undefined && entry.tokens !== null) return intOr(entry.tokens);
  return (["in", "out", "cr", "reason"] as const).reduce((sum, k) => sum + intOr(entry[k]), 0);
}

export type QuotaDailyRow = Record<string, number>;

function emptyDailyRow(): QuotaDailyRow {
  const row: QuotaDailyRow = {};
  for (const [, key] of QUOTA_TOOLS) row[key] = 0;
  return row;
}

/** 对应 _quota_daily_from_tools：账本日表 → {日: {"c":…, "x":…, "g":…}} */
export function quotaDailyFromTools(tools: unknown): Record<string, QuotaDailyRow> {
  const out: Record<string, QuotaDailyRow> = {};
  if (!isDict(tools)) return out;
  for (const [tool, key] of QUOTA_TOOLS) {
    const days = tools[tool];
    // Python 直接 .items()，非字典就整体抛错；peer 快照是别的进程写的，这里跳过坏形状。
    if (!isDict(days)) continue;
    for (const [day, entry] of Object.entries(days)) {
      if (!isDict(entry)) continue;
      const row = (out[day] ??= emptyDailyRow());
      row[key] = quotaDayTokens(tool, entry);
    }
  }
  return out;
}

/** 对应 _quota_window_days：[start, end) 覆盖的本地自然日 →（完整在窗内的, 只盖一半的） */
export function quotaWindowDays(start: number, end: number): [Set<string>, string[]] {
  const interior = new Set<string>();
  const boundary: string[] = [];
  let cursor = dayKey(localDate(start));
  const last = dayKey(localDate(Math.max(end - 1, start)));
  while (cursor <= last) {
    const [dayStart, dayEnd] = quotaLocalDayRange(cursor);
    if (dayStart >= start && dayEnd <= end) interior.add(cursor);
    else boundary.push(cursor);
    cursor = addLocalDays(cursor, 1);
  }
  return [interior, boundary];
}

/** 对应 _quota_day_hour_bounds：该自然日与 [start, end) 相交的小时下标 [lo, hi)；无交集 null */
export function quotaDayHourBounds(day: string, start: number, end: number): [number, number] | null {
  const [dayStart, dayEnd] = quotaLocalDayRange(day);
  const lo = Math.max(start, dayStart);
  const hi = Math.min(end, dayEnd);
  if (lo >= hi) return null;
  const loHour = lo <= dayStart ? 0 : localDate(lo).getHours();
  let hiHour: number;
  if (hi >= dayEnd) {
    hiHour = 24;
  } else {
    const moment = localDate(hi);
    hiHour = moment.getHours() + (moment.getMinutes() || moment.getSeconds() ? 1 : 0);
  }
  return [loHour, Math.max(hiHour, loHour + 1)];
}

/** 事件缓存的一行：对应 Python 的 (epoch, 本地日, tokens) 三元组 */
export interface QuotaEvent {
  epoch: number;
  day: string;
  tokens: number;
}

/**
 * 对应 _quota_claude_events：去重后的 Claude 事件 → [(epoch, 本地日, tokens)]。
 * 去重与 scan_claude 同一套（collectors/claude.ts）。
 * 偏差：Windows 的事件缓存存的是已经换算到本机时区的毫秒 ts（claude.ts:88），
 * 不再重读 timestamp 字符串；两处口径同为「本地时刻」，等价于 Python 的
 * parse_ts(...).astimezone()。带 timestamp 的旧格式也认，免得手工拼的 fixture 落空。
 */
export function quotaClaudeEvents(cache?: Record<string, any> | null): QuotaEvent[] {
  const fileCache = isDict(cache?.claude) ? (cache!.claude as Record<string, any>) : {};
  const all: Array<[string, ClaudeEvent]> = [];
  for (const [file, entry] of Object.entries(fileCache)) {
    if (!isDict(entry) || !Array.isArray(entry.events)) continue;
    for (const event of entry.events) all.push([file, event as ClaudeEvent]);
  }
  const events: QuotaEvent[] = [];
  for (const [, event] of dedupeClaudeEvents(all)) {
    const raw = event as unknown as Record<string, any>;
    let epoch: number | null = null;
    if (typeof raw.ts === "number" && Number.isFinite(raw.ts)) epoch = Math.trunc(raw.ts / 1000);
    if (epoch === null) {
      const parsed = parseTs(raw.timestamp);
      if (parsed) epoch = Math.trunc(parsed.epoch);
    }
    if (epoch === null) continue;
    events.push({ epoch, day: dayKey(localDate(epoch)), tokens: claudeEventTotal(event) });
  }
  return events;
}

/**
 * 对应 _quota_codex_events：只读与 spans 有交集的事件文件。
 * 行内 idx6 已含 cached，故 tokens = idx6 + idx8。
 * 续接会话会把父会话的事件整段重放，口径必须和账本一致：只认 canonical 文件，
 * 并跳过开头 drop_count 行重放，否则重的日子能比账本多出几十倍。
 * 偏差：Python 从 side-car 事件缓存逐行读（_iter_codex_cached_events），Windows 的
 * 事件就在主进程内存的 entry.events 上，跳过前 drop_count 条这个语义保持不变。
 */
export function quotaCodexEvents(spans: Array<[number, number]>, cache?: Record<string, any> | null): QuotaEvent[] {
  if (!spans.length) return [];
  let loMin = Infinity;
  let hiMax = -Infinity;
  for (const [lo, hi] of spans) {
    loMin = Math.min(loMin, lo);
    hiMax = Math.max(hiMax, hi);
  }
  const fileCache = isDict(cache?.codex) ? (cache!.codex as Record<string, any>) : {};
  const events: QuotaEvent[] = [];
  for (const entry of Object.values(fileCache)) {
    if (!isDict(entry) || !entry.event_count) continue;
    if (!entry.canonical) continue;
    const first = isoToEpoch(entry.first_event_ts);
    const last = isoToEpoch(entry.last_event_ts);
    if (first !== null && first > hiMax) continue;
    if (last !== null && last < loMin) continue;
    const rows = Array.isArray(entry.events) ? entry.events : [];
    // 对应 start_index=drop_count：开头那段是父会话回放
    const startIndex = Math.max(intOr(entry.drop_count), 0);
    for (let index = startIndex; index < rows.length; index++) {
      const row = rows[index];
      if (!Array.isArray(row) || row.length < 9) continue;
      const dt = parseTs(row[0]);
      if (!dt) continue;
      events.push({ epoch: Math.trunc(dt.epoch), day: String(row[1]), tokens: intOr(row[6]) + intOr(row[8]) });
    }
  }
  return events;
}

/** 对应 _quota_peer_boundary：没有事件缓存时，有 hours[24] 就按小时切，没有就按覆盖小时折算 */
export function quotaPeerBoundary(
  tools: unknown, tool: string, day: string, bounds: [number, number], dayTotal: number,
): [number, boolean] {
  const [loHour, hiHour] = bounds;
  const entry = isDict(tools) && isDict(tools[tool]) ? tools[tool][day] : undefined;
  const hours = isDict(entry) ? entry.hours : undefined;
  if (Array.isArray(hours) && hours.length >= 24) {
    let sum = 0;
    for (let hour = loHour; hour < hiHour; hour++) sum += intOr(hours[hour]);
    return [sum, false];
  }
  // Python 的 // 是向下取整，非负场景与 Math.floor 同值
  return [Math.floor((dayTotal * (hiHour - loHour)) / 24), true];
}

export interface QuotaDevice {
  name: string;
  tools: LedgerTools;
  /** peer 的同步快照原文；本机为 null（对应 Python 元组第三项） */
  snapshot: Record<string, any> | null;
  daily: Record<string, QuotaDailyRow>;
}

export interface QuotaWindowTokens {
  tokens: number;
  perDevice: Record<string, number>;
  approx: boolean;
}

/** 对应 _quota_window_tokens：selfEvents 为 null 时本机也走 hours */
export function quotaWindowTokens(
  devices: QuotaDevice[], tool: string, key: string, start: number, end: number,
  selfEvents: QuotaEvent[] | null,
): QuotaWindowTokens {
  const [interior, boundary] = quotaWindowDays(start, end);
  const selfByDay: Record<string, number> = {};
  if (selfEvents) {
    for (const event of selfEvents) {
      if (event.epoch >= start && event.epoch < end && !interior.has(event.day)) {
        selfByDay[event.day] = (selfByDay[event.day] ?? 0) + event.tokens;
      }
    }
  }

  const perDevice: Record<string, number> = {};
  let approx = false;
  for (const device of devices) {
    const own = device.name === QUOTA_SELF_DEVICE && selfEvents !== null;
    let total = 0;
    for (const day of interior) total += intOr((device.daily[day] ?? {})[key]);
    for (const day of boundary) {
      const bounds = quotaDayHourBounds(day, start, end);
      if (!bounds) continue;
      const dayTotal = intOr((device.daily[day] ?? {})[key]);
      // 事件有就用事件（最准）；事件空但账本当天有量 = 日志被清理过，退回折算。
      if (own && ((selfByDay[day] ?? 0) || !dayTotal)) {
        total += selfByDay[day] ?? 0;
        continue;
      }
      const [amount, guessed] = quotaPeerBoundary(device.tools, tool, day, bounds, dayTotal);
      total += amount;
      approx = approx || (guessed && amount > 0);
    }
    perDevice[device.name] = total;
  }
  let tokens = 0;
  for (const value of Object.values(perDevice)) tokens += value;
  return { tokens, perDevice, approx };
}

/** 对应 _quota_tool_reading：取 (used_pct, reset_epoch, 读数时间)，取不到返回 null */
export interface QuotaToolReading {
  /** 原样带出，可能是 null/字符串；归一化在 _record_quota_anchor 里做 */
  used: unknown;
  reset: number;
  updated: number;
}

export function quotaToolReading(source: unknown, tool: string): QuotaToolReading | null {
  const data = isDict(source) && isDict(source[tool]) ? source[tool] : {};
  let used: unknown;
  let reset: unknown;
  let updated: unknown;
  if (tool === "claude") {
    // 读数过期就别拿去锚新周期，否则会把一段没发生过的重置写进历史
    if (data.q7_stale) return null;
    used = data.q7;
    reset = data.q7_reset;
    updated = data.q_updated;
  } else if (tool === "codex") {
    if (data.pw_stale) return null;
    used = data.pw;
    reset = data.rw;
    updated = data.q_updated;
  } else {
    // Grok 也可能是月套餐，月窗口长度不定又没有数据可验证，先只认周
    if (data.stale || data.window !== "week") return null;
    used = data.pct;
    reset = data.reset;
    updated = data.q_updated;
  }
  // Python 只在 reset 不是数字时按 ISO 串解析：布尔/数组/None 一律当没有读数
  const resetEpoch = typeof reset === "number" && Number.isFinite(reset) ? reset
    : typeof reset === "string" ? isoToEpoch(reset) : null;
  if (resetEpoch === null || resetEpoch <= 0) return null;
  return { used, reset: Math.trunc(resetEpoch), updated: intOr(updated) };
}

export interface QuotaAnchorRow {
  reset?: number;
  first_seen?: number;
  last_seen?: number;
  max_used?: number;
  confirmed_reset?: boolean;
  [key: string]: any;
}

export type QuotaAnchorTable = Record<string, QuotaAnchorRow[]>;

/** 对应 _load_quota_anchors */
export function loadQuotaAnchors(): QuotaAnchorTable {
  const data = loadJson<unknown>(target.anchorFile, null);
  const anchors = isDict(data) ? data.anchors : undefined;
  return isDict(anchors) ? (anchors as QuotaAnchorTable) : {};
}

/**
 * 对应 _save_quota_anchors：mkstemp + os.replace 的原子写换成 paths.saveJson
 * （同样是 tmp + rename），失败静默 —— 锚点写不进去只影响下次冷启动的周期历史。
 */
export function saveQuotaAnchors(anchors: QuotaAnchorTable): boolean {
  return saveJson(target.anchorFile, { anchors });
}

/**
 * 对应 _record_quota_anchor：记一次额度读数，同一锚点只留一条，used 取见过的最大值。
 *
 * 额度从有消耗的旧窗口回到 0%、同时 reset 前移到新窗口，已经足以确认提前重置。
 * 后续空闲时 reset 继续漂移不会连开新周期：只有紧邻的上一锚点有真实消耗时
 * 才确认这次 0% 重置。
 */
export function recordQuotaAnchor(
  anchors: QuotaAnchorTable, tool: string, reset: number, used: unknown, now: number,
  confirmedReset = false,
): boolean {
  const usedValue = floatOrZero(used);
  const rows = (anchors[tool] ??= []);
  const previous = rows.filter((row) => intOr(row.reset) < reset - QUOTA_ANCHOR_JITTER);
  let latestPrevious: QuotaAnchorRow | null = null;
  for (const row of previous) {
    if (!latestPrevious || intOr(row.reset) > intOr(latestPrevious.reset)) latestPrevious = row;
  }
  const confirmed = Boolean(confirmedReset
    || usedValue >= QUOTA_CYCLE_MIN_USED_PCT
    || (latestPrevious && floatOrZero(latestPrevious.max_used) >= QUOTA_CYCLE_MIN_USED_PCT));

  for (const row of rows) {
    // 抖动窗口内的两条读数算同一个周期：跨机器读出的 reset 差几秒也要并成一条
    if (Math.abs(intOr(row.reset) - reset) <= QUOTA_ANCHOR_JITTER) {
      const changed = usedValue > floatOrZero(row.max_used)
        || now > intOr(row.last_seen)
        || (confirmed && !row.confirmed_reset);
      row.max_used = Math.max(floatOrZero(row.max_used), usedValue);
      row.last_seen = Math.max(intOr(row.last_seen), now);
      if (confirmed) row.confirmed_reset = true;
      return changed;
    }
  }
  const row: QuotaAnchorRow = { reset, first_seen: now, last_seen: now, max_used: usedValue };
  if (confirmed) row.confirmed_reset = true;
  rows.push(row);
  return true;
}

/**
 * 对应 _merge_quota_anchors：把 peer 快照里的锚点并进内存表 —— 只为渲染，不回写自己的账。
 *
 * 周期边界只有亲眼观测到的那台机器知道，所以谁看到都算数；抖动对齐交给
 * recordQuotaAnchor。
 */
export function mergeQuotaAnchors(anchors: QuotaAnchorTable, incoming: unknown): QuotaAnchorTable {
  const known = new Set<string>(QUOTA_TOOLS.map(([tool]) => tool));
  if (!isDict(incoming)) return anchors;
  for (const [tool, rows] of Object.entries(incoming)) {
    if (!known.has(tool) || !Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isDict(row)) continue;
      // 快照是别的进程写的，字段可能是任何东西 —— 挑不出数的直接跳过
      // （Python 只认 isinstance(int/float)，故字符串也不算）
      const reset = row.reset;
      if (typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0) continue;
      const used = typeof row.max_used === "number" ? row.max_used : 0;
      const seen = typeof row.last_seen === "number" && Number.isFinite(row.last_seen)
        ? Math.trunc(row.last_seen) : 0;
      recordQuotaAnchor(anchors, tool, Math.trunc(reset), used, seen, row.confirmed_reset === true);
    }
  }
  return anchors;
}

export interface QuotaAnchorCycle {
  start: number;
  end: number;
  used: number;
  current: boolean;
}

/** 对应 _quota_anchor_cycles：按 reset 排序切周期，最新的排最前 */
export function quotaAnchorCycles(
  anchors: QuotaAnchorTable, tool: string, span: number, limit: number, now: number,
): QuotaAnchorCycle[] {
  const sorted = (anchors[tool] ?? []).slice()
    .sort((a, b) => intOr(a.reset) - intOr(b.reset));
  // 窗口空着的时候 reset 会一直跟着 now+7d 漂，那不是真周期。真实消耗和
  // 「旧窗口有消耗后回到 0%」两种证据都能确认周期；没有证据时只展示最新读数。
  const rows = sorted.filter((row) => floatOrZero(row.max_used) >= QUOTA_CYCLE_MIN_USED_PCT
    || row.confirmed_reset === true);
  const usable = rows.length ? rows : sorted.slice(-1);

  const cycles: QuotaAnchorCycle[] = [];
  for (let index = 0; index < usable.length; index++) {
    const row = usable[index];
    const reset = intOr(row.reset);
    const start = reset - span;
    const end = index + 1 < usable.length ? Math.min(reset, intOr(usable[index + 1].reset) - span) : reset;
    if (end > start) {
      // 读数断了就不会再有新锚点，最后一条也可能早已过期 —— 那是历史，不是进行中。
      // 但「进行中」仍只能是最后一条：多标一条会被前端当成当前卡片，另一条就没了。
      cycles.push({ start, end, used: floatOrZero(row.max_used), current: index + 1 === usable.length && reset > now });
    }
  }
  return cycles.slice(-limit).reverse();
}

/** 对应 _quota_cycle_specs：能切周期的工具 / 一条锚点都没有的工具 / 锚点表 */
export function quotaCycleSpecs(
  payload: Record<string, any>, devices: QuotaDevice[], peerAnchors: unknown[], now: number,
): [string[], string[], QuotaAnchorTable] {
  const anchors = loadQuotaAnchors();
  let dirty = false;
  for (const [tool] of QUOTA_TOOLS) {
    for (const device of devices) {
      // 额度是账号级的：本机读不到就用同步过来的（Grok 只在另一台机器登录就属于这种）
      const reading = quotaToolReading(device.snapshot ? device.snapshot : payload, tool);
      if (reading) dirty = recordQuotaAnchor(anchors, tool, reading.reset, reading.used, now) || dirty;
    }
  }
  // 落盘只写本机这轮亲眼读到的；peer 锚点在落盘之后才并进来，免得把别人的记录
  // 反复回写成自己的观测。
  if (dirty) saveQuotaAnchors(anchors);
  for (const incoming of peerAnchors) mergeQuotaAnchors(anchors, incoming);
  // 当前读数断了不等于历史没了 —— 有锚点就照旧切周期，
  // 只有一条都没有才算真没有，那才需要提示怎么把额度读数找回来。
  const has = (tool: string) => Array.isArray(anchors[tool]) && anchors[tool].length > 0;
  const charted = QUOTA_TOOLS.filter(([tool]) => has(tool)).map(([tool]) => tool);
  const missing = QUOTA_TOOLS.filter(([tool]) => !has(tool)).map(([tool]) => tool);
  return [charted, missing, anchors];
}

/** 对应 _sync_snapshot_filename */
export function syncSnapshotFilename(deviceId: unknown): string | null {
  if (typeof deviceId !== "string") return null;
  const value = deviceId.trim();
  if (!value || value === "." || value === ".." || value.length > 128) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\/\\\0]/.test(value) || /[\x00-\x1f]/.test(value)) return null;
  return `${value}.json`;
}

function readTokeiConfig(): Record<string, any> {
  const cfg = loadJson<unknown>(target.configFile, {});
  return isDict(cfg) ? cfg : {};
}

/** Python 是 os.path.expanduser；Windows 上还要吃 %USERPROFILE% 那类变量，故走 expandPath */
function resolvedSyncDir(cfg: Record<string, any>): string {
  if (target.syncDir) return target.syncDir;
  const configured = typeof cfg.sync_dir === "string" ? cfg.sync_dir : "";
  if (!configured.trim()) return DEFAULT_SYNC_DIR;
  return expandPath(configured) || DEFAULT_SYNC_DIR;
}

/** 对应 _quota_device_ledgers：本机 + 各 peer 的账本与锚点 */
export function quotaDeviceLedgers(config?: Record<string, any> | null): [QuotaDevice[], Record<string, any>[]] {
  const ownTools = (loadLedger().tools ?? {}) as LedgerTools;
  const devices: QuotaDevice[] = [{
    name: QUOTA_SELF_DEVICE, tools: ownTools, snapshot: null, daily: quotaDailyFromTools(ownTools),
  }];
  const peerAnchors: Record<string, any>[] = [];
  const cfg = isDict(config) ? config : readTokeiConfig();
  const syncDir = resolvedSyncDir(cfg);
  const own = syncSnapshotFilename(cfg.device_id ?? "") || "";

  let names: string[];
  try {
    names = fs.readdirSync(syncDir).sort();
  } catch {
    return [devices, peerAnchors];
  }
  for (const name of names) {
    // 自己那份快照是本地账本的副本，再算一遍就是双倍
    if (!name.endsWith(".json") || name.toLowerCase() === own.toLowerCase()) continue;
    const snapshot = loadJson<unknown>(path.join(syncDir, name), null);
    if (!isDict(snapshot)) continue;
    // 锚点不看 _ledger：周期历史推不出来，哪台机器观测到的都得收下
    if (isDict(snapshot._quota_anchors)) peerAnchors.push(snapshot._quota_anchors as Record<string, any>);
    const tools = isDict(snapshot._ledger) ? snapshot._ledger.tools : undefined;
    if (isDict(tools) && Object.keys(tools).length) {
      devices.push({
        name: typeof snapshot._device === "string" && snapshot._device ? snapshot._device : name.slice(0, -5),
        tools: tools as LedgerTools,
        snapshot,
        daily: quotaDailyFromTools(tools),
      });
    }
  }
  return [devices, peerAnchors];
}

export interface QuotaDetailDailyRow {
  d: string;
  c: number;
  x: number;
  g: number;
}

export interface QuotaDetailCycle {
  tool: string;
  start: number;
  end: number;
  used_pct: number | null;
  tokens: number;
  devices: Record<string, number>;
  approx: boolean;
  current: boolean;
}

export interface QuotaDetailPayload {
  daily: QuotaDetailDailyRow[];
  cycles: QuotaDetailCycle[];
  devices: string[];
  missing: string[];
  now: number;
}

export interface QuotaDetailRecalc {
  payload: Record<string, any>;
  cache: Record<string, any>;
}

export interface QuotaDetailInput {
  /** 主进程内存里这一轮的 payload（对应 _recent_quota_detail_payload 命中的那份） */
  payload?: Record<string, any> | null;
  /** payload 落盘距今秒数；不传就当作新鲜（主进程刚扫完就直接给） */
  payloadAgeSeconds?: number | null;
  /** 主进程的扫描缓存：Python 那份 ~/.tokei/scan_cache.json 在 Windows 只存在于内存 */
  cache?: Record<string, any> | null;
  /** 缓存脏 / 快照不新鲜时的重算回调（对应 compute()），不传就退回 payload */
  recalculate?: (() => QuotaDetailRecalc | null | undefined) | null;
  /** ~/.tokei/config.json 的内容覆盖（device_id / sync_dir） */
  config?: Record<string, any> | null;
  /** epoch 秒 */
  now?: number;
}

/** 对应 _recent_quota_detail_payload：只有 60 秒内落盘、且三个工具都在的快照才算可用 */
export function recentQuotaDetailPayload(now?: number, file?: string | null): Record<string, any> | null {
  const pathName = file ?? target.lastUsageFile;
  let stat: fs.Stats;
  let raw: string;
  try {
    raw = fs.readFileSync(pathName, "utf8");
    stat = fs.statSync(pathName);
  } catch {
    return null;
  }
  const age = (now ?? epochNow()) - Math.trunc(stat.mtimeMs / 1000);
  if (!(age >= 0 && age <= RECENT_PAYLOAD_MAX_AGE)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isDict(payload)) return null;
  for (const [tool] of QUOTA_TOOLS) {
    if (!isDict(payload[tool])) return null;
  }
  return payload;
}

/** 对应 _quota_detail_inputs：缓存脏就重算，否则复用最近快照 */
export function quotaDetailInputs(input: QuotaDetailInput = {}): QuotaDetailRecalc {
  const cache = isDict(input.cache) ? (input.cache as Record<string, any>) : {};
  const now = input.now ?? epochNow();
  let payload: Record<string, any> | null = null;
  if (!cache._dirty) {
    if (isDict(input.payload)) {
      const age = input.payloadAgeSeconds;
      if (age === null || age === undefined || (age >= 0 && age <= RECENT_PAYLOAD_MAX_AGE)) {
        payload = input.payload as Record<string, any>;
      }
    } else {
      payload = recentQuotaDetailPayload(now);
    }
  }
  if (payload) return { payload, cache };
  const recalc = input.recalculate ? input.recalculate() : null;
  if (recalc && isDict(recalc.payload)) {
    return { payload: recalc.payload, cache: isDict(recalc.cache) ? recalc.cache : cache };
  }
  // 偏差：Windows 侧没有可拉起的采集子进程，也没给重算回调时只能退回调用方那份 payload
  // （最坏是用上稍旧的读数，详情缓存 30 秒到期后会再算一轮）。
  return { payload: isDict(input.payload) ? (input.payload as Record<string, any>) : {}, cache };
}

/** 对应 _quota_detail_payload */
export function quotaDetailPayload(input: QuotaDetailInput = {}): Record<string, any> {
  return quotaDetailInputs(input).payload;
}

/** 对应 build_quota_detail：payload/cache 由调用方给（见文件头的偏差说明） */
export function buildQuotaDetail(input: QuotaDetailInput = {}): QuotaDetailPayload {
  const now = Math.trunc(input.now ?? epochNow());
  const { payload, cache } = quotaDetailInputs({ ...input, now });
  const [devices, peerAnchors] = quotaDeviceLedgers(input.config ?? null);
  const span = QUOTA_WEEK_HOURS * 3600;
  const [charted, missing, anchors] = quotaCycleSpecs(payload, devices, peerAnchors, now);

  interface Planned {
    tool: string;
    start: number;
    end: number;
    used: number;
    current: boolean;
  }
  const planned: Planned[] = [];
  for (const tool of charted) {
    for (const cycle of quotaAnchorCycles(anchors, tool, span, QUOTA_CYCLE_HISTORY, now)) {
      planned.push({ tool, start: cycle.start, end: cycle.end, used: cycle.used, current: cycle.current });
    }
  }

  const codexSpans: Array<[number, number]> = planned
    .filter((item) => item.tool === "codex").map((item) => [item.start, item.end]);
  const keys = new Map<string, string>(QUOTA_TOOLS.map(([tool, key]) => [tool, key]));
  const events: Record<string, QuotaEvent[] | null> = {};
  const cycles: QuotaDetailCycle[] = [];
  for (const item of planned) {
    if (!(item.tool in events)) {
      // Grok 没有带时间戳的事件缓存，只能靠账本的 hours
      events[item.tool] = item.tool === "claude" ? quotaClaudeEvents(cache)
        : item.tool === "codex" ? quotaCodexEvents(codexSpans, cache) : null;
    }
    const window = quotaWindowTokens(
      devices, item.tool, keys.get(item.tool) as string, item.start, item.end, events[item.tool]);
    cycles.push({
      tool: item.tool,
      start: item.start,
      end: item.end,
      used_pct: item.used,
      tokens: window.tokens,
      devices: window.perDevice,
      approx: window.approx,
      current: item.current,
    });
  }

  const merged: Record<string, QuotaDailyRow> = {};
  for (const device of devices) {
    for (const [day, value] of Object.entries(device.daily)) {
      const agg = (merged[day] ??= emptyDailyRow());
      for (const [, key] of QUOTA_TOOLS) agg[key] += intOr(value[key]);
    }
  }

  return {
    daily: Object.keys(merged).sort().map((day) => ({
      d: day,
      c: merged[day].c ?? 0,
      x: merged[day].x ?? 0,
      g: merged[day].g ?? 0,
    })),
    cycles,
    devices: devices.map((device) => device.name),
    missing,
    now,
  };
}

/** 对应 quota_detail()：命令行打印一份紧凑 JSON（cli.ts 的 --quota-detail 用） */
export function quotaDetail(input: QuotaDetailInput = {}): string {
  return JSON.stringify(buildQuotaDetail(input));
}

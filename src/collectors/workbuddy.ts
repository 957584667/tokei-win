/**
 * WorkBuddy / WorkBuddy Intl. 共用采集器工厂：对应 usage.30s.py 的
 * _workbuddy_usage_record / _iter_workbuddy_records / _scan_workbuddy_root /
 * scan_workbuddy / scan_workbuddy_ai（行 9795–10094）。
 * 同一工厂生成 workbuddy（~/.workbuddy/projects）与 workbuddy_ai
 * （~/.workbuddy-ai/projects）两个独立统计键，缓存与账本互不相干。
 * CodeBuddy 已拆到 collectors/codebuddy.ts（口径不同）。
 *
 * 口径（CALCULATION.md §2/§4）：
 * - 每个带 usage 的 item 是一次模型调用；providerData 中的同一份 usage 仅作字段
 *   补全，不重复累计。
 * - input 不含缓存；但当某来源 total_tokens == input + output 时说明该来源的
 *   input 已含缓存，需减掉 cache_read 与 cache_write。
 * - reasoning/completion_thinking 已含在 output 内，reason 恒为 0。
 * - 无公开价的模型不估美元；workbuddy/workbuddy_ai 在 _recalc_costs 名单内，
 *   最终成本由 recalc 按价格表重算。
 * 历史账本已接 ledger_reconcile + _prepare_unpriced_cost_ledger：JSONL 被清后用
 * ~/.tokei/ledger.json 的逐会话快照回补；首次入账前清掉无公开价模型被估出的历史美元。
 */
import * as path from "path";
import * as fs from "fs";
import { HOME, existingDirs, pathCandidates } from "../core/paths";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey, parseTs } from "../core/ranges";
import { pricingId, rawPrice } from "../core/price";
import {
  Bucket, DayStat, TokenUsageRangeOut, addTokenUsage, emptyBuckets, emptyDay,
  mergeTokenDay, tokenTotal, tokenUsageRange,
} from "../core/model";
import { forEachLine, walkFiles } from "../core/fsutil";
import { DayRecord, ledgerAddRecordSource, ledgerReconcile, ledgerTouch, prepareUnpricedCostLedger } from "../core/ledger";

export type WorkBuddyTool = "workbuddy" | "workbuddy_ai";

/**
 * 对应 _UNPRICED_COST_TOOLS 中与本工厂相关的成员（workbuddy / workbuddy_ai / pi / qwencode）：
 * pi、qwencode 在各自文件接线，codebuddy 不在此名单（Python 9988-9990）。
 */
const UNPRICED_COST_TOOLS = new Set<WorkBuddyTool>(["workbuddy", "workbuddy_ai"]);

export interface WorkBuddyScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  model: string | null;
  days: Record<string, DayStat & { projects?: string[] }>;
  projects: Record<string, Record<string, DayStat>>;
}

/** 与 Python _WORKBUDDY_PARSER_VERSION 对应：改解析规则时 +1 使旧缓存失效 */
const PARSER_VERSION = 3;

interface WorkBuddyRecord {
  date: string;
  hour: number;
  ts: number;
  ts_key: string;
  item_id: string;
  in: number;
  out: number;
  cr: number;
  cw: number;
  reason: number;
  cost: number;
  credits: number;
  model: string;
  message_id: string;
  dedup: string;
  session: string;
  line: number;
}

interface FileEntry {
  sig: string;
  parser: number;
  records: WorkBuddyRecord[];
  proj: string | null;
  sid: string;
}

const TOOL_DEFAULTS: Record<WorkBuddyTool, { env: string; dir: string }> = {
  workbuddy: { env: "TOKEI_WORKBUDDY_DIR", dir: path.join(HOME, ".workbuddy", "projects") },
  workbuddy_ai: { env: "TOKEI_WORKBUDDY_AI_DIR", dir: path.join(HOME, ".workbuddy-ai", "projects") },
};

/** 对应 WORKBUDDY_DIR 与 WORKBUDDY_AI_DIR：查漏补缺扫模型名时要的那两个根。 */
export function workbuddyRoots(): string[] {
  return [...toolRoots("workbuddy"), ...toolRoots("workbuddy_ai")];
}

function toolRoots(tool: WorkBuddyTool): string[] {
  const def = TOOL_DEFAULTS[tool];
  // env 覆盖时替换默认根（测试注入隔离），未设置才回落到 ~/.<tool>/projects
  const configured = process.env[def.env];
  return existingDirs(configured ? pathCandidates(def.env) : pathCandidates(def.env, def.dir));
}

function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 对应 _workbuddy_number()：首个存在且可 int 化的键（bool 跳过），结果 max(int,0) */
function wbNumber(obj: unknown, ...keys: string[]): number | null {
  if (!isObject(obj)) return null;
  for (const key of keys) {
    if (!(key in obj)) continue;
    const value = obj[key];
    if (typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      return Math.max(Math.trunc(value), 0);
    }
    if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
      return Math.max(Math.trunc(Number(value)), 0);
    }
  }
  return null;
}

/** 对应 _workbuddy_float()：可 float 化且有限，结果 max(value,0) */
function wbFloat(obj: unknown, ...keys: string[]): number | null {
  if (!isObject(obj)) return null;
  for (const key of keys) {
    if (!(key in obj)) continue;
    const value = obj[key];
    if (typeof value === "boolean") continue;
    let n = NaN;
    if (typeof value === "number") n = value;
    else if (typeof value === "string" && value.trim() !== "") n = Number(value);
    if (Number.isFinite(n)) return Math.max(n, 0);
  }
  return null;
}

/** 对应 _workbuddy_detail_total()：details 可能是 dict 或 dict 数组 */
function wbDetailTotal(value: unknown, ...keys: string[]): number {
  if (isObject(value)) return wbNumber(value, ...keys) || 0;
  if (Array.isArray(value)) {
    let sum = 0;
    for (const item of value) if (isObject(item)) sum += wbNumber(item, ...keys) || 0;
    return sum;
  }
  return 0;
}

/** 对应 _workbuddy_timestamp()：数字 >1e10 视为毫秒；字符串走 parse_ts，均取本地时区 */
function wbTimestamp(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const seconds = value > 10_000_000_000 ? value / 1000 : value;
    const d = new Date(seconds * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const parsed = parseTs(value);
    return parsed ? parsed.date : null;
  }
  return null;
}

/** 对应 _workbuddy_usage_record(item)：WorkBuddy 不启用 CodeBuddy 的严格定价分支 */
export function workbuddyUsageRecord(item: Record<string, any>): Omit<WorkBuddyRecord, "dedup" | "session" | "line"> | null {
  const message = isObject(item.message) ? item.message : {};
  const provider = isObject(item.providerData) ? item.providerData
    : isObject(message.providerData) ? message.providerData : {};

  const sources = [message.usage, provider.usage, provider.rawUsage]
    .filter((s): s is Record<string, any> => isObject(s) && Object.keys(s).length > 0);

  let credits = 0;
  for (const source of sources) credits = Math.max(credits, wbFloat(source, "credit", "credits") || 0);

  let selected: Record<string, any> | null = null;
  let inputTotal = 0;
  let output = 0;
  for (const source of sources) {
    const inp = wbNumber(source, "input_tokens", "inputTokens", "input", "prompt_tokens") || 0;
    const out = wbNumber(source, "output_tokens", "outputTokens", "output", "completion_tokens") || 0;
    if (inp + out > 0) {
      selected = source;
      inputTotal = inp;
      output = out;
      break;
    }
  }
  if (!selected) {
    // 纯 Credit 事件也要保留
    if (credits <= 0) return null;
    selected = sources[0];
  }

  const cacheReadCandidates: number[] = [];
  const cacheWriteCandidates: number[] = [];
  const totalCandidates: number[] = [];
  for (const source of sources) {
    cacheReadCandidates.push(
      wbNumber(source, "cache_read_input_tokens", "cacheReadInputTokens",
        "cache_read", "cacheRead", "cached_tokens", "cachedTokens") || 0,
      wbNumber(source, "prompt_cache_hit_tokens") || 0,
      wbDetailTotal(source.inputTokensDetails, "cached_tokens", "cachedTokens"),
      wbDetailTotal(source.input_tokens_details, "cached_tokens", "cachedTokens"),
      wbDetailTotal(source.prompt_tokens_details, "cached_tokens", "cachedTokens"),
    );
    cacheWriteCandidates.push(
      wbNumber(source, "cache_creation_input_tokens", "cacheCreationInputTokens",
        "cache_write_input_tokens", "cacheWriteInputTokens",
        "prompt_cache_write_tokens", "cache_write", "cacheWrite") || 0,
    );
    const total = wbNumber(source, "total_tokens", "totalTokens", "total");
    if (total !== null) totalCandidates.push(total);
  }

  let cacheRead = cacheReadCandidates.length ? Math.max(...cacheReadCandidates) : 0;
  let cacheWrite = cacheWriteCandidates.length ? Math.max(...cacheWriteCandidates) : 0;
  // total==input+output ⇒ 该来源 input 已含缓存，需要减出去（§2 input 不含缓存口径）
  const inclusiveInput = totalCandidates.some((t) => t === inputTotal + output);
  let input: number;
  if (inclusiveInput) {
    cacheRead = Math.min(cacheRead, inputTotal);
    cacheWrite = Math.min(cacheWrite, Math.max(inputTotal - cacheRead, 0));
    input = Math.max(inputTotal - cacheRead - cacheWrite, 0);
  } else {
    input = inputTotal;
  }

  const timestampValue = item.timestamp || message.timestamp;
  const dt = wbTimestamp(timestampValue);
  if (!dt) return null;

  const model = String(
    provider.requestModelName || provider.requestModelId
    || provider.model || message.model || item.model || "unknown",
  );
  // 没有公开价的模型不估美元：以前落到 Opus 兜底价，便宜模型被算出几百美元
  const priceId = pricingId(model);
  const price = priceId ? rawPrice(priceId) : null;
  const cost = price
    ? (input / 1e6) * price.in + (output / 1e6) * price.out
      + (cacheRead / 1e6) * price.cache_read + (cacheWrite / 1e6) * price.cache_write
    : 0;

  const itemKey = String(item.id || provider.messageId || "");
  return {
    date: dayKey(dt),
    hour: dt.getHours(),
    ts: dt.getTime() / 1000,
    ts_key: String(timestampValue ?? ""),
    item_id: itemKey,
    in: input,
    out: output,
    cr: cacheRead,
    cw: cacheWrite,
    reason: 0, // thinking/reasoning 已含在 output，重复计会双倍
    cost,
    credits,
    model,
    message_id: String(provider.messageId || ""),
  };
}

function parseWorkBuddyFile(file: string): { records: WorkBuddyRecord[]; proj: string | null; sid: string } {
  const records: WorkBuddyRecord[] = [];
  let project: string | null = null;
  let sessionId = path.basename(file).replace(/\.jsonl$/i, "");
  forEachLine(file, (text, lineNo) => {
    if (!text.includes('"usage"') && !text.includes('"cwd"')) return;
    let item: Record<string, any>;
    try {
      item = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(item)) return;
    if (item.cwd) project = String(item.cwd);
    if (item.sessionId) sessionId = String(item.sessionId);
    const record = workbuddyUsageRecord(item);
    if (!record) return;
    const recordSession = String(item.sessionId || sessionId);
    const dedupId = record.message_id || record.item_id;
    let dedup: string;
    if (dedupId) {
      dedup = JSON.stringify([recordSession, dedupId, record.ts_key]);
    } else {
      dedup = `${file}:${lineNo}:${record.ts_key}`;
    }
    records.push({ ...record, dedup, session: recordSession, line: lineNo });
  });
  return { records, proj: project, sid: String(sessionId) };
}

/** 对应 _iter_workbuddy_records()：全局去重，冲突时保留 token 总量大、其次 Credit 多的 */
export function iterWorkBuddyRecords(fc: Record<string, FileEntry>): Array<[string, FileEntry, WorkBuddyRecord]> {
  const items: Array<[number, string, FileEntry, WorkBuddyRecord]> = [];
  for (const [file, entry] of Object.entries(fc)) {
    if (!isObject(entry)) continue;
    for (const record of entry.records ?? []) {
      if (isObject(record)) items.push([record.ts || 0, file, entry, record]);
    }
  }
  items.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  const selected = new Map<string, [string, FileEntry, WorkBuddyRecord]>();
  for (const [, file, entry, record] of items) {
    const key = record.dedup || `${file}:${record.line}:${record.ts_key}`;
    const current = selected.get(key);
    if (!current) {
      selected.set(key, [file, entry, record]);
      continue;
    }
    const cur = current[2];
    if (tokenTotal(record) > tokenTotal(cur)
      || (tokenTotal(record) === tokenTotal(cur) && (record.credits || 0) > (cur.credits || 0))) {
      selected.set(key, [file, entry, record]);
    }
  }
  return [...selected.values()]
    .sort((a, b) => (a[2].ts !== b[2].ts ? a[2].ts - b[2].ts : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function projNameOf(entry: FileEntry): string {
  return entry.proj ? path.basename(String(entry.proj).replace(/[\\/]+$/, "")) : "";
}

/**
 * 工厂：对应 _scan_workbuddy_root() + scan_workbuddy / scan_workbuddy_ai。
 * 返回该工具的 scan(bounds, cache) 闭包；tool 同时决定缓存键与目录。
 */
export function makeWorkbuddyScanner(tool: WorkBuddyTool): (bounds: Bounds, cache: Record<string, any>) => WorkBuddyScanResult {
  return function scanWorkbuddyRoot(bounds: Bounds, cache: Record<string, any>): WorkBuddyScanResult {
    // 对应 9988-9990：无公开价工具先清掉历史上被 Opus 兜底价估出的美元，再登记账本
    if (UNPRICED_COST_TOOLS.has(tool)) prepareUnpricedCostLedger(tool);
    ledgerTouch(tool);
    const fc: Record<string, FileEntry> = (cache[tool] ??= {});

    const files = new Set<string>();
    for (const root of toolRoots(tool)) {
      for (const found of walkFiles(root, [".jsonl"])) files.add(found.file);
    }

    let changed = false;
    const stale = new Set(Object.keys(fc));
    for (const file of [...files].sort()) {
      stale.delete(file);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const sig = `${st.mtimeMs / 1000}:${st.size}`;
      const entry = fc[file];
      if (entry && entry.sig === sig && entry.parser === PARSER_VERSION) continue;
      const parsed = parseWorkBuddyFile(file);
      fc[file] = { sig, parser: PARSER_VERSION, records: parsed.records, proj: parsed.proj, sid: parsed.sid };
      changed = true;
    }
    for (const file of stale) {
      delete fc[file];
      changed = true;
    }

    const buckets = emptyBuckets();
    const days: WorkBuddyScanResult["days"] = {};
    const ledgerSources: Record<string, Record<string, DayRecord>> = {}; // 对应 ledger_sources（10051）
    const daySessions = new Map<string, Set<string>>();
    const dayProjects = new Map<string, Set<string>>();
    const projects: Record<string, Record<string, DayStat>> = {};

    for (const [file, entry, record] of iterWorkBuddyRecords(fc)) {
      // 逐会话来源快照（10055-10056）：文件被清后账本仍能按会话还原当天贡献
      ledgerAddRecordSource(ledgerSources, record.session || entry.sid || file, record.date, record, record.hour);
      const day = (days[record.date] ??= emptyDay());
      addTokenUsage(day as unknown as Bucket, record.in, record.out, record.cr, record.cw,
        0, record.cost, record.model, record.credits);
      (daySessions.get(record.date) ?? daySessions.set(record.date, new Set()).get(record.date)!)
        .add(record.session || "unknown");
      const projName = projNameOf(entry);
      if (projName) {
        (dayProjects.get(record.date) ?? dayProjects.set(record.date, new Set()).get(record.date)!).add(projName);
        const perDay = (projects[projName] ??= {});
        const target = (perDay[record.date] ??= emptyDay());
        addTokenUsage(target as unknown as Bucket, record.in, record.out, record.cr, record.cw,
          0, record.cost, record.model, record.credits);
      }
    }

    // 项目名随天入账本（10064-10066，同 scan_claude）：日志被清理后仍能回答「那天在干什么」
    for (const [date, names] of dayProjects) {
      if (days[date]) days[date].projects = [...names].sort().slice(0, 3);
    }

    // 会话数只能来自现存日志（10068-10075：被清日志无从归属）
    for (const [date, sessions] of daySessions) {
      for (const rk of classifyDay(date, bounds)) {
        for (const sid of sessions) buckets[rk].sessions.add(sid);
      }
    }
    // 天级高水位对账（10077-10083）：日志被删的天用 ~/.tokei/ledger.json 的快照兜底
    const reconciled = ledgerReconcile(tool, days, ledgerSources) as Record<string, WorkBuddyScanResult["days"][string]>;
    for (const [date, day] of Object.entries(reconciled)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // 对应 date.fromisoformat 校验（10078-10081）
      for (const rk of classifyDay(date, bounds)) mergeTokenDay(buckets[rk], day);
    }

    let model: string | null = null;
    let bestTotal = 0;
    for (const [name, usage] of Object.entries(buckets.all.models)) {
      const total = tokenTotal(usage);
      if (total > bestTotal) {
        bestTotal = total;
        model = name;
      }
    }

    if (changed) cache._dirty = true;
    return {
      ranges: Object.fromEntries(
        RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])]),
      ) as Record<RangeKey, TokenUsageRangeOut>,
      model, days, projects,
    };
  };
}

export const scanWorkbuddy = makeWorkbuddyScanner("workbuddy");
export const scanWorkbuddyAi = makeWorkbuddyScanner("workbuddy_ai");

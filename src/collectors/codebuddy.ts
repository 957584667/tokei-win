/**
 * CodeBuddy Code 采集器：对应 usage.30s.py 的 scan_codebuddy（复用 _scan_workbuddy_root，
 * model_id_first=True 分支）与 CALCULATION.md §2/§4 CodeBuddy 条目（行 222–229、362–364）。
 * ~/.codebuddy/projects 下递归全部 .jsonl（含 subagents）都参与统计；
 * traces / logs / auth / transcript 正文不是数据源，不参与扫描。
 * 口径：
 * - input 不含缓存：input = prompt 总量 - cache_read_input_tokens - prompt_cache_write_tokens；
 *   output = output_tokens/completion_tokens（thinking 已含在输出内，reason 恒 0）。
 * - Credit = providerData.rawUsage.credit 逐次模型调用累计；Credit 绝不换算成美元。
 * - 只有模型命中精确目录价才估美元；codebuddy 在 _recalc_costs 名单，最终由 recalc 重算。
 * - 去重键 providerData.messageId 的 sha256（全局，不含会话），回退 sessionId + entry id；
 *   conversationRequestId 只关联轮次，绝不作为去重键。
 * 历史账本已接 ledger_reconcile：JSONL 被清后用 ~/.tokei/ledger.json 的逐会话快照回补；
 * codebuddy 不在 _UNPRICED_COST_TOOLS 名单，无需 _prepare_unpriced_cost_ledger 清历史美元。
 */
import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import { HOME, existingDirs, pathCandidates } from "../core/paths";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey, parseTs } from "../core/ranges";
import { exactPricingId, modelIdentityId, pricingId, rawPrice } from "../core/price";
import {
  Bucket, DayStat, TokenUsageRangeOut, addTokenUsage, emptyBuckets, emptyDay,
  mergeTokenDay, tokenTotal, tokenUsageRange,
} from "../core/model";
import { forEachLine, walkFiles } from "../core/fsutil";
import { DayRecord, ledgerAddRecordSource, ledgerReconcile, ledgerTouch } from "../core/ledger";

export interface CodeBuddyScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  model: string | null;
  days: Record<string, DayStat & { projects?: string[] }>;
  projects: Record<string, Record<string, DayStat>>;
}

/** 解析口径版本：改解析规则时 +1 使旧缓存失效（v2：去重键改为 messageId 的 sha256） */
const CODEBUDDY_PARSER_VERSION = 2;

interface CodeBuddyRecord {
  date: string;
  hour: number;
  ts: number;
  in: number;
  out: number;
  cr: number;
  cw: number;
  reason: number;
  cost: number;
  credits: number;
  model: string;
  session: string;
  dedup: string;
  line: number;
  ts_key: string;
}

interface FileEntry {
  sig: string;
  parser: number;
  records: CodeBuddyRecord[];
  proj: string | null;
  sid: string;
}

/** 对应 CODEBUDDY_DIR：TOKEI_CODEBUDDY_DIR 优先（设置时替换默认根，保证测试可隔离），
 * 默认 ~/.codebuddy/projects */
export function codebuddyRoots(): string[] {
  const configured = process.env.TOKEI_CODEBUDDY_DIR;
  return existingDirs(configured
    ? pathCandidates("TOKEI_CODEBUDDY_DIR")
    : pathCandidates("TOKEI_CODEBUDDY_DIR", path.join(HOME, ".codebuddy", "projects")));
}

function isObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function cbNumber(obj: unknown, ...keys: string[]): number {
  if (!isObject(obj)) return 0;
  for (const key of keys) {
    if (!(key in obj)) continue;
    const value = obj[key];
    if (typeof value === "boolean") continue;
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(Math.trunc(value), 0);
    if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return Math.max(Math.trunc(Number(value)), 0);
  }
  return 0;
}

function cbFloat(obj: unknown, ...keys: string[]): number {
  if (!isObject(obj)) return 0;
  for (const key of keys) {
    if (!(key in obj)) continue;
    const value = obj[key];
    if (typeof value === "boolean") continue;
    let n = NaN;
    if (typeof value === "number") n = value;
    else if (typeof value === "string" && value.trim() !== "") n = Number(value);
    if (Number.isFinite(n)) return Math.max(n, 0);
  }
  return 0;
}

function cbDetailTotal(value: unknown, ...keys: string[]): number {
  if (isObject(value)) return cbNumber(value, ...keys);
  if (Array.isArray(value)) {
    let sum = 0;
    for (const item of value) if (isObject(item)) sum += cbNumber(item, ...keys);
    return sum;
  }
  return 0;
}

function cbTimestamp(value: unknown): Date | null {
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

/** 对应 _workbuddy_usage_record(item, model_id_first=True)，按 §2 简化为恒减缓存 */
export function codebuddyUsageRecord(item: Record<string, any>): Omit<CodeBuddyRecord, "dedup" | "session" | "line" | "ts_key"> | null {
  const message = isObject(item.message) ? item.message : {};
  const provider = isObject(item.providerData) ? item.providerData
    : isObject(message.providerData) ? message.providerData : {};
  const raw = isObject(provider.rawUsage) ? provider.rawUsage : {};

  const sources = [message.usage, provider.usage, raw]
    .filter((s): s is Record<string, any> => isObject(s) && Object.keys(s).length > 0);
  if (!sources.length) return null;

  // prompt 总量：input_tokens/prompt_tokens 均含缓存输入（§2 CodeBuddy）
  let promptTotal = 0;
  let output = 0;
  for (const source of sources) {
    const inp = cbNumber(source, "input_tokens", "inputTokens", "prompt_tokens");
    const out = cbNumber(source, "output_tokens", "outputTokens", "completion_tokens");
    if (inp + out > 0) {
      promptTotal = inp;
      output = out;
      break;
    }
  }

  let cacheRead = 0;
  let cacheWrite = 0;
  for (const source of sources) {
    cacheRead = Math.max(cacheRead,
      cbNumber(source, "cache_read_input_tokens", "cacheReadInputTokens", "prompt_cache_hit_tokens",
        "cache_read", "cacheRead", "cached_tokens", "cachedTokens"),
      cbDetailTotal(source.inputTokensDetails, "cached_tokens", "cachedTokens"),
      cbDetailTotal(source.input_tokens_details, "cached_tokens", "cachedTokens"),
      cbDetailTotal(source.prompt_tokens_details, "cached_tokens", "cachedTokens"),
    );
    cacheWrite = Math.max(cacheWrite,
      cbNumber(source, "prompt_cache_write_tokens", "cache_creation_input_tokens", "cacheCreationInputTokens",
        "cache_write_input_tokens", "cacheWriteInputTokens", "cache_write", "cacheWrite"),
    );
  }

  cacheRead = Math.min(cacheRead, promptTotal);
  cacheWrite = Math.min(cacheWrite, Math.max(promptTotal - cacheRead, 0));
  const input = Math.max(promptTotal - cacheRead - cacheWrite, 0);

  // Credit 逐次模型调用累计，只展示不折算美元（§4 CodeBuddy Code 成本）
  const credits = Math.max(cbFloat(raw, "credit", "credits"), ...sources.map((s) => cbFloat(s, "credit", "credits")));

  if (input + output + cacheRead + cacheWrite === 0 && credits === 0) return null;

  const timestampValue = item.timestamp || message.timestamp;
  const dt = cbTimestamp(timestampValue);
  if (!dt) return null;

  const model = String(
    provider.requestModelId || provider.requestModelName
    || provider.model || message.model || item.model || "unknown",
  );
  // 只有精确目录身份才给美元估算，家族回退一律不算（混元/Step 曾被估出几百美元）
  const priceId = exactPricingId(modelIdentityId(model)) ? pricingId(model) : null;
  const price = priceId ? rawPrice(priceId) : null;
  const cost = price
    ? (input / 1e6) * price.in + (output / 1e6) * price.out
      + (cacheRead / 1e6) * price.cache_read + (cacheWrite / 1e6) * price.cache_write
    : 0;

  return {
    date: dayKey(dt),
    hour: dt.getHours(),
    ts: dt.getTime() / 1000,
    in: input,
    out: output,
    cr: cacheRead,
    cw: cacheWrite,
    reason: 0, // completion_thinking 已含在 output
    cost,
    credits,
    model,
  };
}

/** traces/logs 目录与 auth、transcript 正文不是数据源；projects 递归含 subagents */
function isDataSource(file: string): boolean {
  const norm = file.split(path.sep).join("/");
  return !/(^|\/)(traces|logs)(\/|$)/i.test(norm);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function parseCodeBuddyFile(file: string): { records: CodeBuddyRecord[]; proj: string | null; sid: string } {
  const records: CodeBuddyRecord[] = [];
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
    const base = codebuddyUsageRecord(item);
    if (!base) return;
    const provider = isObject(item.providerData) ? item.providerData : {};
    const session = String(item.sessionId || sessionId);
    const messageId = String(provider.messageId || "");
    const tsKey = String(item.timestamp ?? messageOf(item)?.timestamp ?? "");
    // codebuddy 按 messageId 的 sha256 全局去重（同一消息在多个文件里重复出现），
    // 没有 messageId 才退回 sessionId+entry id；conversationRequestId 只作轮次关联
    const dedupId = messageId || String(item.id || "");
    const dedup = messageId
      ? `codebuddy:${sha256(messageId)}`
      : dedupId
        ? JSON.stringify([session, dedupId, tsKey])
        : `${file}:${lineNo}:${tsKey}`;
    records.push({ ...base, session, dedup, line: lineNo, ts_key: tsKey });
  });
  return { records, proj: project, sid: String(sessionId) };
}

function messageOf(item: Record<string, any>): Record<string, any> | null {
  return isObject(item.message) ? item.message : null;
}

/** 全局去重：冲突时保留 token 总量大、其次 Credit 多的记录 */
export function iterCodebuddyRecords(fc: Record<string, FileEntry>): Array<[string, FileEntry, CodeBuddyRecord]> {
  const items: Array<[number, string, CodeBuddyRecord]> = [];
  for (const [file, entry] of Object.entries(fc)) {
    if (!isObject(entry)) continue;
    for (const record of entry.records ?? []) {
      if (isObject(record)) items.push([record.ts || 0, file, record]);
    }
  }
  items.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  const selected = new Map<string, [string, FileEntry, CodeBuddyRecord]>();
  for (const [, file, record] of items) {
    const key = record.dedup || `${file}:${record.line}:${record.ts_key}`;
    const current = selected.get(key);
    if (!current) {
      selected.set(key, [file, fc[file], record]);
      continue;
    }
    const cur = current[2];
    if (tokenTotal(record) > tokenTotal(cur)
      || (tokenTotal(record) === tokenTotal(cur) && record.credits > cur.credits)) {
      selected.set(key, [file, fc[file], record]);
    }
  }
  return [...selected.values()];
}

/** 对应 scan_codebuddy()（_scan_workbuddy_root 的 codebuddy 分支，账本接线见 9987-10085） */
export function scanCodebuddy(bounds: Bounds, cache: Record<string, any>): CodeBuddyScanResult {
  ledgerTouch("codebuddy"); // 9990；codebuddy 不在 _UNPRICED_COST_TOOLS，跳过 9988-9989 的历史美元清理
  const fc: Record<string, FileEntry> = (cache.codebuddy ??= {});

  const files = new Set<string>();
  for (const root of codebuddyRoots()) {
    for (const found of walkFiles(root, [".jsonl"])) {
      if (isDataSource(found.file)) files.add(found.file);
    }
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
    if (entry && entry.sig === sig && entry.parser === CODEBUDDY_PARSER_VERSION) continue;
    const parsed = parseCodeBuddyFile(file);
    fc[file] = { sig, parser: CODEBUDDY_PARSER_VERSION, records: parsed.records, proj: parsed.proj, sid: parsed.sid };
    changed = true;
  }
  for (const file of stale) {
    delete fc[file];
    changed = true;
  }

  const buckets = emptyBuckets();
  const days: CodeBuddyScanResult["days"] = {};
  const ledgerSources: Record<string, Record<string, DayRecord>> = {}; // 对应 ledger_sources（10051）
  const daySessions = new Map<string, Set<string>>();
  const dayProjects = new Map<string, Set<string>>();
  const projects: Record<string, Record<string, DayStat>> = {};

  for (const [file, entry, record] of iterCodebuddyRecords(fc)) {
    // 逐会话来源快照（10055-10056）：文件被清后账本仍能按会话还原当天贡献
    ledgerAddRecordSource(ledgerSources, record.session || entry.sid || file, record.date, record, record.hour);
    const day = (days[record.date] ??= emptyDay());
    addTokenUsage(day as unknown as Bucket, record.in, record.out, record.cr, record.cw,
      0, record.cost, record.model, record.credits);
    (daySessions.get(record.date) ?? daySessions.set(record.date, new Set()).get(record.date)!)
      .add(record.session || entry.sid || "unknown");
    const projName = entry.proj ? path.basename(String(entry.proj).replace(/[\\/]+$/, "")) : "";
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
  const reconciled = ledgerReconcile("codebuddy", days, ledgerSources) as Record<string, CodeBuddyScanResult["days"][string]>;
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
}

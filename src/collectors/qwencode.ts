/**
 * Qwen Code 采集器：对应 usage.30s.py 的 scan_qwencode(11721) / _qwen_entries(11656) /
 * _qwen_request_entry(11540) / _qwen_summary_entry(11576) / _qwen_usage_parts(11522) /
 * _qwen_group_entries(11626) / _qwen_runtime_dirs(11486)。
 *
 * 口径（CALCULATION.md §2 Qwen Code）：inputTokens 已含缓存，thoughtsTokens 独立：
 *   in = inputTokens - cachedTokens, out = outputTokens, cr = cachedTokens,
 *   reason = thoughtsTokens, total = inputTokens + outputTokens + thoughtsTokens。
 * 逐请求日志（`${QWEN_RUNTIME_DIR:-~/.qwen}/usage/token-usage-*.jsonl`）决定进行中会话与
 * 小时分布；旧版 `usage_record.jsonl` 按 sessionId 取最后一份快照补历史。
 * 同一会话两种来源都在时：保留逐请求记录，只把汇总里**尚未覆盖的每模型余额**补进来，
 * 余额归到汇总日期（hour=null，不伪造缺失请求的小时），并且缓存明细更全时
 * 不把输入总量重复计一遍（cr/cw 夹在剩余输入之内）。
 * 成本不持久化，交给 recalcCosts("qwencode") 按价格表重算（与 Python 同式）。
 * 历史账本已接 ledger_reconcile：日志被清后用 ~/.tokei/ledger.json 的日快照回补，
 * 来源按 (会话, 日) 逐条入账（对应 _ledger_add_record_source）。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey, parseTs } from "../core/ranges";
import { pricingId, rawPrice } from "../core/price";
import { HOME, expandPath, loadJson } from "../core/paths";
import { forEachLine, listFiles } from "../core/fsutil";
import { ledgerAddRecordSource, ledgerReconcile, ledgerTouch, prepareUnpricedCostLedger } from "../core/ledger";
import type { DayRecord } from "../core/ledger";
import { Bucket, DayStat, ModelUsage, addModelUsage, addTokenUsage, emptyBucket, emptyDay, mergeTokenDay, tokenTotal, tokenUsageRange, TokenUsageRangeOut } from "../core/model";

const QWEN_CODE_DEFAULT_DIR = path.join(HOME, ".qwen");
/** 对应 QWEN_CODE_DIR：env 在调用时读取，便于测试注入 */
export function qwenCodeDir(): string {
  return expandPath(process.env.QWEN_HOME) || QWEN_CODE_DEFAULT_DIR;
}
const TOKEN_FIELDS = ["in", "out", "cr", "cw", "reason"] as const;
/** 对应 Python accounting_version=3：没有公开价的模型不再按 Opus 兜底价估美元 */
export const QWEN_ACCOUNTING_VERSION = 3;

function int(v: unknown): number {
  if (typeof v === "boolean") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(Math.trunc(n), 0) : 0;
}

/** 对应 _qwen_runtime_dirs()：QWEN_RUNTIME_DIR → settings.json advanced.runtimeOutputDir → QWEN_HOME */
export function qwenRuntimeDirs(codeDir = qwenCodeDir()): string[] {
  const envDir = expandPath(process.env.QWEN_RUNTIME_DIR);
  if (envDir) return [envDir];
  const settings = loadJson<Record<string, any>>(path.join(codeDir, "settings.json"), {});
  const advanced = settings && typeof settings === "object" ? settings.advanced : null;
  const configured = advanced && typeof advanced === "object" ? advanced.runtimeOutputDir : null;
  if (typeof configured === "string" && configured) {
    const resolved = expandPath(configured);
    if (resolved && (path.isAbsolute(resolved) || configured.startsWith("~"))) return [resolved];
  }
  return [codeDir];
}

/** 对应 _qwen_token_usage_files() */
export function qwenTokenUsageFiles(): string[] {
  const files = new Set<string>();
  for (const runtimeDir of qwenRuntimeDirs()) {
    for (const file of listFiles(path.join(runtimeDir, "usage"))) {
      const name = path.basename(file);
      if (/^token-usage-.*\.jsonl$/.test(name)) files.add(file);
    }
  }
  return [...files].sort();
}

export function qwenSummaryFile(): string | null {
  const file = path.join(qwenCodeDir(), "usage_record.jsonl");
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** 对应 _qwen_datetime()：数字（秒/毫秒）或 ISO；数字按本地时区 */
function qwenDatetime(raw: unknown): Date | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const seconds = Math.abs(raw) >= 10_000_000_000 ? raw / 1000 : raw;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof raw === "string") {
    const ts = parseTs(raw);
    return ts ? ts.date : null;
  }
  return null;
}

export interface QwenParts { in: number; out: number; cr: number; reason: number; cost: number }

/** 对应 _qwen_usage_parts()：input 拆出非缓存部分，无公开价则不估美元 */
export function qwenUsageParts(model: string, values: Record<string, any> | null | undefined): QwenParts {
  const src = values && typeof values === "object" ? values : {};
  let inputTotal = int(src.inputTokens);
  let cached = int(src.cachedTokens);
  if (inputTotal === 0 && cached > 0) inputTotal = cached;
  cached = Math.min(cached, inputTotal);
  const inp = Math.max(inputTotal - cached, 0);
  const out = int(src.outputTokens);
  const reason = int(src.thoughtsTokens);
  const priceId = pricingId(model);
  let cost = 0;
  if (priceId) {
    const p = rawPrice(priceId);
    cost = (inp * p.in + cached * p.cache_read + (out + reason) * p.out) / 1e6;
  }
  return { in: inp, out, cr: cached, reason, cost };
}

type ModelEntry = ModelUsage;

function newModelEntry(): ModelEntry {
  return { in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0 };
}

export interface QwenEntry {
  date: string;
  hour: number | null;
  in: number; out: number; cr: number; cw: number; reason: number;
  cost: number; credits: number; cost_cny: number;
  session: string;
  project?: string;
  models: Record<string, ModelEntry>;
}

/** 对应 _qwen_request_entry()：schemaVersion 必须为 1，id 与 sessionId 必填 */
export function qwenRequestEntry(record: Record<string, any> | null): QwenEntry | null {
  if (!record || typeof record !== "object") return null;
  if (int(record.schemaVersion) !== 1) return null;
  const recordId = String(record.id || "").trim();
  const session = String(record.sessionId || "").trim();
  const model = String(record.model || "unknown");
  if (!recordId || !session) return null;

  const date = qwenDatetime(record.timestamp);
  let dayStr = String(record.localDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) dayStr = date ? dayKeyOf(date) : "";
  if (!dayStr) return null;

  const parts = qwenUsageParts(model, record);
  const models: Record<string, ModelEntry> = {};
  const modelEntry = (models[model] ??= newModelEntry());
  modelEntry.in = parts.in;
  modelEntry.out = parts.out;
  modelEntry.cr = parts.cr;
  modelEntry.reason = parts.reason;
  modelEntry.cost = parts.cost;
  return {
    date: dayStr, hour: date ? date.getHours() : null,
    in: parts.in, out: parts.out, cr: parts.cr, cw: 0, reason: parts.reason,
    cost: parts.cost, credits: 0, cost_cny: 0, session, models,
  };
}

/** 对应 _qwen_summary_entry()：version=1 的会话累计快照 */
export function qwenSummaryEntry(record: Record<string, any> | null): QwenEntry | null {
  if (!record || typeof record !== "object" || record.version !== 1) return null;
  const session = String(record.sessionId || "").trim();
  const date = qwenDatetime(record.timestamp ?? record.startTime);
  const modelsRaw = record.models;
  if (!session || !date || !modelsRaw || typeof modelsRaw !== "object") return null;

  const models: Record<string, ModelEntry> = {};
  let totalIn = 0, totalOut = 0, totalCr = 0, totalReason = 0, totalCost = 0;
  for (const [model, values] of Object.entries<Record<string, any>>(modelsRaw)) {
    const parts = qwenUsageParts(String(model), values);
    const entry = (models[String(model)] ??= newModelEntry());
    entry.in = parts.in;
    entry.out = parts.out;
    entry.cr = parts.cr;
    entry.reason = parts.reason;
    entry.cost = parts.cost;
    totalIn += parts.in;
    totalOut += parts.out;
    totalCr += parts.cr;
    totalReason += parts.reason;
    totalCost += parts.cost;
  }
  return {
    date: dayKeyOf(date), hour: date.getHours(),
    in: totalIn, out: totalOut, cr: totalCr, cw: 0, reason: totalReason,
    cost: totalCost, credits: 0, cost_cny: 0, session,
    project: String(record.project || ""), models,
  };
}

function dayKeyOf(date: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 对应 _qwen_read_jsonl()：坏行跳过、文件不可读时为空 */
function readJsonl(file: string | null): Array<Record<string, any>> {
  const records: Array<Record<string, any>> = [];
  if (!file) return records;
  forEachLine(file, (text) => {
    if (!text.startsWith("{")) return;
    try {
      records.push(JSON.parse(text));
    } catch { /* 坏行跳过 */ }
  });
  return records;
}

/** 对应 _qwen_entries()：逐请求优先，旧汇总只补每模型未覆盖的余额 */
export function qwenEntries(tokenFiles: string[], summaryFile: string | null): QwenEntry[] {
  const requestEntries = new Map<string, QwenEntry>();
  for (const file of tokenFiles) {
    for (const record of readJsonl(file)) {
      const recordId = String(record.id || "").trim();
      const entry = qwenRequestEntry(record);
      if (recordId && entry) requestEntries.set(recordId, entry);
    }
  }
  const entries: QwenEntry[] = [...requestEntries.values()];
  const requestSessions = new Set(entries.map((entry) => entry.session));

  const summaries = new Map<string, Record<string, any>>();
  for (const record of readJsonl(summaryFile)) {
    const session = String(record.sessionId || "").trim();
    if (session) summaries.set(session, record);
  }

  for (const [session, record] of summaries) {
    const entry = qwenSummaryEntry(record);
    if (!entry) continue;
    if (requestSessions.has(session)) {
      // 现存逐请求日志未必覆盖整段会话：只补汇总里剩余的每模型余额，
      // 既不再加一遍汇总，也不丢弃已知的多请求时刻
      for (const request of requestEntries.values()) {
        if (request.session !== session) continue;
        for (const [model, values] of Object.entries(request.models)) {
          const target = entry.models[model];
          if (!target) continue;
          for (const field of [...TOKEN_FIELDS, "cost", "cost_cny"] as const) {
            (target as any)[field] = (target as any)[field] - ((values as any)[field] || 0);
          }
        }
      }
      for (const values of Object.values(entry.models)) {
        // 逐请求的缓存明细可能比汇总更全：保留这份明细，但不虚增输入总量
        const remainingInput = Math.max(values.in + values.cr + values.cw, 0);
        for (const field of [...TOKEN_FIELDS, "cost", "cost_cny"] as const) {
          (values as any)[field] = Math.max((values as any)[field] || 0, 0);
        }
        values.cr = Math.min(values.cr, remainingInput);
        values.cw = Math.min(values.cw, remainingInput - values.cr);
        values.in = remainingInput - values.cr - values.cw;
      }
      for (const field of [...TOKEN_FIELDS, "cost", "cost_cny"] as const) {
        (entry as any)[field] = Object.values(entry.models)
          .reduce((sum, values) => sum + ((values as any)[field] || 0), 0);
      }
      entry.hour = null;
    }
    if (entry.in + entry.out + entry.cr + entry.cw + entry.reason > 0) entries.push(entry);
  }
  return qwenGroupEntries(entries);
}

/** 对应 _qwen_group_entries()：按 (session, date, hour) 折叠 */
export function qwenGroupEntries(entries: QwenEntry[]): QwenEntry[] {
  const grouped = new Map<string, QwenEntry>();
  for (const entry of entries) {
    const key = `${entry.session}\0${entry.date}\0${entry.hour}`;
    let target = grouped.get(key);
    if (!target) {
      target = {
        date: entry.date, hour: entry.hour,
        in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0,
        session: entry.session, project: entry.project || "", models: {},
      };
      grouped.set(key, target);
    }
    addTokenUsage(target as unknown as Bucket, entry.in, entry.out, entry.cr, entry.cw, entry.reason, entry.cost, null, entry.credits, entry.cost_cny);
    for (const [model, values] of Object.entries(entry.models)) {
      addModelUsage(target.models as Record<string, ModelUsage>, model, {
        inp: values.in, out: values.out, cr: values.cr, cw: values.cw, reason: values.reason,
        cost: values.cost, credits: values.credits, cost_cny: values.cost_cny,
      });
    }
  }
  return [...grouped.values()];
}

function sourceSignature(paths: string[]): string | null {
  const digest = crypto.createHash("sha256");
  let found = false;
  for (const file of [...paths].sort()) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    found = true;
    digest.update(file);
    digest.update(`\0${Math.trunc(st.mtimeMs / 1000)}\0${st.size}\0`);
  }
  return found ? digest.digest("hex") : null;
}

export interface QwenCodeDay {
  in: number; out: number; cr: number; cw: number; reason: number; cost: number; credits: number; cost_cny: number;
  hours: number[]; sessions: string[]; models: Record<string, ModelUsage>;
}

export interface QwenCodeScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  model?: string | null;
  /** 逐日/逐小时明细不进 payload：与 Python 一致，只留在扫描缓存里供 Dashboard 复用 */
  days?: Record<string, QwenCodeDay>;
  hours?: number[];
}

/** 对应 scan_qwencode()（11722–11775）：历史账本已接 ledger_reconcile */
export function scanQwenCode(bounds: Bounds, cache: Record<string, any>): QwenCodeScanResult {
  prepareUnpricedCostLedger("qwencode");
  ledgerTouch("qwencode");
  const fc: Record<string, any> = (cache.qwencode ??= {});
  const buckets = Object.fromEntries(RANGE_KEYS.map((k) => [k, emptyBucket()])) as Record<RangeKey, Bucket>;
  const tokenFiles = qwenTokenUsageFiles();
  const summaryFile = qwenSummaryFile();
  const sig = sourceSignature([...tokenFiles, ...(summaryFile ? [summaryFile] : [])]);
  if (sig === null) {
    if (Object.keys(fc).length) {
      for (const key of Object.keys(fc)) delete fc[key];
      cache._dirty = true;
    }
    return { ranges: emptyRanges(), model: null, days: {}, hours: new Array(24).fill(0) };
  }
  if (fc.sig !== sig || fc.accounting_version !== QWEN_ACCOUNTING_VERSION) {
    const entries = qwenEntries(tokenFiles, summaryFile);
    for (const key of Object.keys(fc)) delete fc[key];
    fc.sig = sig;
    fc.entries = entries;
    fc.accounting_version = QWEN_ACCOUNTING_VERSION;
    cache._dirty = true;
  }

  // 对应 11744–11766：live_days 用 _empty_token_day 形状（不含 sessions），
  // 会话数只能来自现存日志、单独归拢，避免被写进账本
  const liveDays: Record<string, DayStat> = {};
  const ledgerSources: Record<string, Record<string, DayRecord>> = {};
  const daySessions = new Map<string, string[]>();
  const hours = new Array(24).fill(0);
  for (const entry of (fc.entries || []) as QwenEntry[]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) continue;
    ledgerAddRecordSource(ledgerSources, entry.session || "unknown", entry.date, entry, entry.hour);
    const agg = (liveDays[entry.date] ??= emptyDay());
    addTokenUsage(agg as unknown as Bucket, entry.in, entry.out, entry.cr, entry.cw, entry.reason, entry.cost);
    for (const [model, values] of Object.entries(entry.models || {})) {
      addModelUsage(agg.models, model, {
        inp: values.in, out: values.out, cr: values.cr, cw: values.cw, reason: values.reason,
        cost: values.cost,
      });
    }
    // hour=null 表示余额来自汇总：归日到当天但不伪造小时
    if (typeof entry.hour === "number" && entry.hour >= 0 && entry.hour < 24) {
      const total = tokenTotal(entry);
      agg.hours[entry.hour] += total;
      hours[entry.hour] += total;
    }
    if (entry.session) {
      const list = daySessions.get(entry.date) ?? [];
      if (!list.includes(entry.session)) list.push(entry.session);
      daySessions.set(entry.date, list);
      for (const key of classifyDay(entry.date, bounds)) buckets[key].sessions.add(entry.session || "unknown");
    }
  }

  // 天级高水位对账：对应 ledger_reconcile("qwencode", live_days, ledger_sources)（11768）
  const reconciled = ledgerReconcile("qwencode", liveDays, ledgerSources) as Record<string, DayStat>;
  for (const [dk, dayUsage] of Object.entries(reconciled)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
    for (const key of classifyDay(dk, bounds)) mergeTokenDay(buckets[key], dayUsage);
  }

  const days: Record<string, QwenCodeDay> = {};
  for (const [dk, day] of Object.entries(liveDays)) {
    days[dk] = { ...day, sessions: daySessions.get(dk) ?? [] };
  }

  const ranges = Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])])) as Record<RangeKey, TokenUsageRangeOut>;
  return { ranges, model: null, days, hours };
}

function emptyRanges(): Record<RangeKey, TokenUsageRangeOut> {
  return Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(emptyBucket())])) as Record<RangeKey, TokenUsageRangeOut>;
}

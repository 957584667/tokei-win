/**
 * Qoder CLI / Qoder CN 采集器：对应 usage.30s.py 的
 * _QODERCLI_DIRS(8544) / _qodercli_dir(8568) / _empty_qodercli(8573) / _est_tokens(8581) /
 * _qodercli_int(8586) / _qodercli_usage(8595) / _merge_qodercli_event(8620) /
 * _parse_qodercli_file(8639) / _qodercli_usage_days(8738) / scan_qodercli(8792)。
 *
 * 口径要点（严格照 Python，不做“改进”）：
 * - token 只来自 assistant 行的 message.usage（input_tokens / cache_read_input_tokens /
 *   cache_creation_input_tokens / output_tokens），input 是「扣除缓存后的净输入」：
 *   in = max(raw_in - cr - cw, 0)。
 * - raw_in+out+cr+cw == 0 时 usage_available=false：内置路由不落 token，只记 Credits，
 *   所以 calls/credits/est 非零而 in/out/cr/cw 为 0 是真实数据的形状，不是缺字段。
 * - 请求事件按 request_id 归并，跨行、跨文件（主会话 + subagents）去重后持久在
 *   cache[tool]["_requests"]，日账由该索引重建，故重复落盘只算一次。
 * - 未落 token 的部分用 _est_tokens 文本估算（CJK/全角≈1 token，其余≈1/4 token）。
 * - 账本 _prepare_qodercli_ledger / ledger_touch / ledger_reconcile 已接 core/ledger：
 *   日志被删的天用 ~/.tokei/ledger.json 的日快照兜底。
 */
import * as fs from "fs";
import * as path from "path";
import { HOME, expandPath, isDirectory } from "../core/paths";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, parseTs } from "../core/ranges";
import { ledgerReconcile, ledgerTouch, prepareQoderCliLedger } from "../core/ledger";
import { qodercliRange } from "../core/model";
import { forEachLine, listDirs, listFiles } from "../core/fsutil";

/** 对应 _QODERCLI_PARSER_VERSION：加 1 让旧缓存失效重扫。 */
const QODERCLI_PARSER_VERSION = 2;

/** 对应 _QODERCLI_LEDGER_VERSION：账本口径标记，写进日账的 _cost_version */
const QODERCLI_LEDGER_VERSION = 1;

/** 对应 _QODERCLI_DIRS：默认根目录 + 环境变量覆盖（CN 根为 ~/.qoder-cn/projects）。 */
const QODERCLI_DIRS: Record<QoderCliTool, [string, string, string]> = {
  qodercli: [path.join(HOME, ".qoder", "projects"), "TOKEI_QODERCLI_DIR", "Qoder CLI"],
  qodercli_cn: [path.join(HOME, ".qoder-cn", "projects"), "TOKEI_QODERCLI_CN_DIR", "Qoder CN"],
};

export type QoderCliTool = "qodercli" | "qodercli_cn";

/** 对应 _qodercli_dir()：env 覆盖优先，expanduser + abspath。 */
export function qoderCliDir(tool: QoderCliTool): string {
  const [defaultDir, envName] = QODERCLI_DIRS[tool];
  const configured = expandPath(process.env[envName] ?? "");
  if (configured) return configured;
  return expandPath(defaultDir) ?? path.resolve(defaultDir);
}

/** 对应 _qodercli_usage() 的产物（事件里 **usage 展开的字段）。 */
export interface QoderCliUsageFields {
  in: number;
  out: number;
  cr: number;
  cw: number;
  credits: number;
  usage_available: boolean;
  request_id: string | null;
}

/** 事件 = 一次模型请求（Python responses 的 value）。 */
export interface QoderCliEvent extends QoderCliUsageFields {
  id: string;
  day: string;
  hour: number;
  model: string | null;
  est: number;
  tools: string[];
}

export interface QoderCliModelUsage { in: number; out: number; cr: number; cw: number; credits: number }

/** 单文件日账（对应 _parse_qodercli_file 里 days 的 value）。 */
export interface QoderCliFileDay { turns: number; est: number; active: number }

/** 请求侧重建出来的日账（对应 _qodercli_usage_days 的 value；Python 另有 _cost_version 账本标记，未移植）。 */
export interface QoderCliUsageDay {
  in: number; out: number; cr: number; cw: number; credits: number;
  usage_calls: number; calls: number; tools: number; est: number; duration: number;
  models: Record<string, QoderCliModelUsage>;
  hours: number[];
  /** 对应 _QODERCLI_LEDGER_VERSION 写进日账的账本口径标记 */
  _cost_version?: number;
}

/** 缓存里的单文件条目（与 Python 的 fc[path] 同形状：不含 responses，请求只活在 _requests）。 */
interface QoderCliFileEntry {
  sig: string;
  parser: number;
  days: Record<string, QoderCliFileDay>;
  model: string | null;
  sub: boolean;
}

/** 内部缓存键，对应 scan_qodercli 里 stale.discard 的那四个。 */
const INTERNAL_KEYS = ["_model", "_parser", "_requests", "_usage_days"];

function emptyUsageDay(): QoderCliUsageDay {
  return {
    in: 0, out: 0, cr: 0, cw: 0, credits: 0, usage_calls: 0, calls: 0, tools: 0,
    est: 0, duration: 0, models: {}, hours: new Array(24).fill(0),
    _cost_version: QODERCLI_LEDGER_VERSION,
  };
}

/** 对应 _empty_qodercli() 的区间桶。 */
function emptyBucket(): Record<string, any> {
  return {
    in: 0, out: 0, cr: 0, cw: 0, credits: 0, usage_calls: 0, usage_available: false,
    sessions: 0, calls: 0, sub_agents: 0, duration: 0, turns: 0, tools: 0, est: 0,
    ctx_sum: 0, ctx_count: 0, models: {},
  };
}

/** 对应 Python int()：向零截断，非数视作 0。 */
function trunc(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 对应 _qodercli_int()：int(value or 0) 后 max(..., 0)，坏值归 0。 */
function qoderInt(value: unknown): number {
  if (value === null || value === undefined || value === false || value === "" || value === 0) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(Math.trunc(n), 0);
}

/** 对应 _est_tokens()：CJK/全角字符≈1 token，其余≈1/4 token；按码点计数（代理对算 2，同 Python len）。 */
export function estTokens(text: unknown): number {
  if (!text) return 0;
  const chars = Array.from(String(text));
  let cjk = 0;
  for (const ch of chars) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef)) cjk++;
  }
  return cjk + (chars.length - cjk) / 4;
}

/** Python 的 falsy 语义（`x or {}`）：0/""/false/null/undefined/空数组/空对象都算空。 */
function pyOrEmpty(value: unknown): unknown {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return {};
  if (Array.isArray(value)) return value.length ? value : {};
  if (typeof value === "object") return Object.keys(value as object).length ? value : {};
  return value;
}

/** 近似 json.dumps(..., ensure_ascii=False)（默认分隔符 ", " / ": "），用于估算 tool_use 输入体量。 */
function pyDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyDumps).join(", ")}]`;
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${JSON.stringify(k)}: ${pyDumps(v)}`);
    return `{${parts.join(", ")}}`;
  }
  return String(value);
}

/**
 * 对应 _qodercli_usage()：从 message.usage 取四桶 + Credits + request_id。
 * cw 有两形状：cache_creation_input_tokens 存在就直接用，否则退回
 * cache_creation 的 ephemeral_5m + ephemeral_1h（两份数据同时存在时只读前者，避免双计）。
 */
export function qoderCliUsage(message: Record<string, any>): QoderCliUsageFields {
  let usage: Record<string, any> = message["usage"];
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) usage = {};
  const rawIn = qoderInt(usage["input_tokens"]);
  const cr = qoderInt(usage["cache_read_input_tokens"]);
  let cw: number;
  if ("cache_creation_input_tokens" in usage) {
    cw = qoderInt(usage["cache_creation_input_tokens"]);
  } else {
    const cc = usage["cache_creation"];
    const cacheCreation: Record<string, any> = cc && typeof cc === "object" ? cc : {};
    cw = qoderInt(cacheCreation["ephemeral_5m_input_tokens"])
       + qoderInt(cacheCreation["ephemeral_1h_input_tokens"]);
  }
  const out = qoderInt(usage["output_tokens"]);
  const inp = Math.max(rawIn - cr - cw, 0);
  let creditValue = usage["credits"];
  if (creditValue === null || creditValue === undefined) creditValue = usage["original_credits"];
  let credits: number;
  if (creditValue === null || creditValue === undefined || creditValue === false || creditValue === "") {
    credits = 0;
  } else {
    const n = Number(creditValue);
    credits = Number.isFinite(n) ? Math.max(n, 0) : 0;
  }
  const requestId = usage["request_id"];
  return {
    in: inp, out, cr, cw, credits,
    usage_available: rawIn + out + cr + cw > 0,
    request_id: requestId ? String(requestId) : null,
  };
}

/**
 * 对应 _merge_qodercli_event()：token 总量大者作为基准 dict（另一份只用于补 model），
 * credits / est 取两者最大，tools 取并集排序，usage_available 取或。
 */
export function mergeQoderCliEvent(
  existing: QoderCliEvent | null | undefined,
  candidate: QoderCliEvent,
): QoderCliEvent {
  if (!existing) return { ...candidate, tools: [...(candidate.tools || [])] };
  const tokenSum = (e: QoderCliEvent) => (e.in || 0) + (e.out || 0) + (e.cr || 0) + (e.cw || 0);
  const useCandidate = tokenSum(candidate) > tokenSum(existing);
  const merged: QoderCliEvent = { ...(useCandidate ? candidate : existing) };
  const other = useCandidate ? existing : candidate;
  merged.credits = Math.max(Number(existing.credits) || 0, Number(candidate.credits) || 0);
  merged.tools = [...new Set([...(existing.tools || []), ...(candidate.tools || [])])].sort();
  merged.est = Math.max(Number(existing.est) || 0, Number(candidate.est) || 0);
  merged.usage_available = !!(existing.usage_available || candidate.usage_available);
  if (!merged.model) merged.model = other.model ?? null;
  return merged;
}

/** Python str(x) 在键位上的等价写法（数字/布尔直出字符串）。 */
function pyStr(value: unknown): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** 对应 date.fromisoformat() 的成功判定：只接受 YYYY-MM-DD 且日期自洽。 */
export function isIsoDay(key: unknown): key is string {
  if (typeof key !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const daysInMonth = new Date(y, mo, 0).getDate();
  return d <= daysInMonth;
}

/**
 * 对应 _parse_qodercli_file()：逐行解析一个 transcript，产出
 * days（每日 user 轮次 / user 文本估算 / active 秒）与 responses（按请求去重后的事件）。
 */
export function parseQoderCliFile(file: string): {
  days: Record<string, QoderCliFileDay>;
  responses: QoderCliEvent[];
  model: string | null;
} {
  const days: Record<string, QoderCliFileDay> = {};
  const responses = new Map<string, QoderCliEvent>();
  // message_id → request_id：同一响应可能先以 message.id 落盘、后再以 request_id 落盘
  const messageRequests = new Map<string, string>();
  let model: string | null = null;
  let prevTs: number | null = null;

  forEachLine(file, (text, lineNumber) => {
    let row: Record<string, any>;
    try {
      row = JSON.parse(text);
    } catch {
      return; // 坏行与 Python 一致：静默跳过
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    const typ = row["type"];
    if (typ === "runtime-config") {
      // runtime-config 只用来认模型，不产生任何用量
      if (row["model"]) model = pyStr(row["model"]);
      return;
    }
    if (typ !== "user" && typ !== "assistant") return;

    const dt = parseTs(row["timestamp"] || "");
    if (!dt) return;
    const dk = dt.day;
    const day: QoderCliFileDay = (days[dk] ??= { turns: 0, est: 0, active: 0 });
    const ts = dt.epoch;
    if (prevTs !== null) {
      // 活跃时长只累计「合理连续」的间隔：0 < gap <= 300s，跨长空档视为人离开
      const gap = ts - prevTs;
      if (gap > 0 && gap <= 300) day.active += gap;
    }
    prevTs = ts;

    const message: Record<string, any> =
      row["message"] && typeof row["message"] === "object" && !Array.isArray(row["message"])
        ? row["message"] : {};
    const content = message["content"];

    if (typ === "assistant") {
      const usage = qoderCliUsage(message);
      const messageId = message["id"];
      const rowId = row["uuid"] || row["id"];
      let responseId: string;
      let prior: QoderCliEvent | null | undefined = null;

      if (usage.request_id) {
        responseId = usage.request_id;
        if (messageId) {
          // 之前只有 message.id 的那份事件要搬到这里：pop 出来当 prior，避免同一请求计两次
          const messageKey = pyStr(messageId);
          if (messageRequests.has(messageKey)) {
            prior = null;
          } else {
            prior = responses.get(messageKey) ?? null;
            responses.delete(messageKey);
          }
          messageRequests.set(messageKey, responseId);
        } else {
          prior = null;
        }
      } else if (messageId && messageRequests.has(pyStr(messageId))) {
        responseId = messageRequests.get(pyStr(messageId))!;
        prior = null;
      } else {
        responseId = pyStr(messageId || rowId || `${file}:${lineNumber}`);
        prior = null;
      }

      let assistantEst = 0;
      const toolIds = new Set<string>();
      if (Array.isArray(content)) {
        content.forEach((block: any, index: number) => {
          if (!block || typeof block !== "object") return;
          const blockType = block["type"];
          if (blockType === "tool_use") {
            toolIds.add(pyStr(block["id"] || `${responseId}:${index}`));
            try {
              assistantEst += estTokens(pyDumps(pyOrEmpty(block["input"])));
            } catch {
              /* 不可序列化就忽略，同 Python 的 except (TypeError, ValueError) */
            }
          } else if (blockType === "text") {
            assistantEst += estTokens(block["text"]);
          } else if (blockType === "thinking") {
            assistantEst += estTokens(block["thinking"]);
          }
        });
      }

      const eventModel = message["model"] || model;
      if (eventModel) model = pyStr(eventModel);

      const event: QoderCliEvent = {
        id: pyStr(responseId), day: dk, hour: dt.hour,
        model: eventModel ? pyStr(eventModel) : null,
        est: assistantEst, tools: [...toolIds].sort(),
        ...usage,
      };
      const key = pyStr(responseId);
      let existing = responses.get(key) ?? null;
      if (prior) existing = mergeQoderCliEvent(existing, prior);
      // 合并是整份取胜者，所以事件自带的 id 可能仍是 prior 的 message.id（Python 同此形状，
      // _requests 就是按 event.id 落键的），去重靠的是 responses 的 key，不受影响。
      responses.set(key, mergeQoderCliEvent(existing, event));
      return;
    }

    // user 侧只数真实用户轮次：meta / sidechain / "<" 前缀的系统注入文本都不算
    if (row["isMeta"] || row["isSidechain"]) return;
    let texts: unknown[] = [];
    if (typeof content === "string") texts = [content];
    else if (Array.isArray(content)) {
      texts = content
        .filter((b: any) => b && typeof b === "object" && b["type"] === "text")
        .map((b: any) => b["text"]);
    }
    const kept = texts.filter((t): t is string =>
      !!t && typeof t === "string" && !t.startsWith("<"));
    if (kept.length) {
      day.turns += 1;
      day.est += kept.reduce((acc: number, t: string) => acc + estTokens(t), 0);
    }
  });

  return { days, responses: [...responses.values()], model };
}

/**
 * 对应 _qodercli_usage_days(entries, use_cached)：
 * use_cached 且有 _usage_days 时直接复用，否则从持久 _requests 索引重建日账
 * （_requests 不是 dict 的兜底路径改为合并各文件本次解析出的事件）。
 */
export function qoderCliUsageDays(
  entries: Record<string, any>,
  useCached: boolean,
  fresh?: QoderCliEvent[],
): Record<string, QoderCliUsageDay> {
  if (useCached && entries["_usage_days"] && !Array.isArray(entries["_usage_days"])) {
    return entries["_usage_days"] as Record<string, QoderCliUsageDay>;
  }
  let events: QoderCliEvent[];
  const requestIndex = entries["_requests"];
  if (requestIndex && typeof requestIndex === "object" && !Array.isArray(requestIndex)) {
    events = Object.values(requestIndex) as QoderCliEvent[];
  } else {
    // 兜底：_requests 不可用时按 id 合并本次解析出的事件（没有 fresh 就翻缓存条目里的 responses）
    const source: QoderCliEvent[] = fresh
      ?? Object.entries(entries)
        .filter(([key, entry]) => !key.startsWith("_") && entry && typeof entry === "object")
        .flatMap(([, entry]) => (entry as any).responses || []);
    const rebuilt: Record<string, QoderCliEvent> = {};
    for (const event of source) {
      if (!event || !event.id) continue;
      rebuilt[event.id] = mergeQoderCliEvent(rebuilt[event.id], event);
    }
    events = Object.values(rebuilt);
  }

  const days: Record<string, QoderCliUsageDay> = {};
  for (const event of events) {
    const dk: unknown = event && event.day;
    if (!isIsoDay(dk)) continue;
    const day: QoderCliUsageDay = (days[dk] ??= emptyUsageDay());
    day.calls += 1;
    day.tools += (event.tools || []).length;
    day.est += trunc(event.est || 0);
    day.credits += Number(event.credits) || 0;
    let tokenTotal = 0;
    for (const field of ["in", "out", "cr", "cw"] as const) {
      const value = trunc(event[field] || 0);
      day[field] += value;
      tokenTotal += value;
    }
    if (event.usage_available && tokenTotal > 0) day.usage_calls += 1;
    const hour = event.hour;
    if (Number.isInteger(hour) && hour >= 0 && hour < 24) day.hours[hour] += tokenTotal;
    const modelName = event.model;
    if (modelName && (tokenTotal > 0 || (Number(event.credits) || 0))) {
      const modelUsage: QoderCliModelUsage = (day.models[modelName] ??= { in: 0, out: 0, cr: 0, cw: 0, credits: 0 });
      for (const field of ["in", "out", "cr", "cw"] as const) modelUsage[field] += trunc(event[field] || 0);
      modelUsage.credits += Number(event.credits) || 0;
    }
  }
  return days;
}

/** Python 的 dict == 值比较（用于 _usage_days 变化判定），只做纯对象/数组/标量。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      Object.prototype.hasOwnProperty.call(b, k)
      && deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

/**
 * 对应 scan_qodercli 里的 ledger_reconcile(tool, live_days)：日志被删后用
 * ~/.tokei/ledger.json 的日快照兜底（天级整取整用，不做字段级混合）。
 */
export function qoderCliLedgerReconcile(tool: string, days: Record<string, QoderCliUsageDay>): Record<string, QoderCliUsageDay> {
  return ledgerReconcile(tool, days) as Record<string, QoderCliUsageDay>;
}

export interface QoderCliScanResult {
  ranges: Record<RangeKey, any>;
  model: string | null;
  /** 请求侧重建出的日账（Python 内部产物，此处一并返回方便上层复用；payload 只用 ranges/model）。 */
  days?: Record<string, QoderCliUsageDay>;
}

/** glob 的 `*` 不匹配点号开头的名字，故过滤掉隐藏项。 */
function visible(name: string): boolean {
  return !path.basename(name).startsWith(".");
}

/**
 * 对应 scan_qodercli(bounds, cache, tool)：qodercli 与 qodercli_cn 各有独立目录、
 * 独立缓存键，互不串数。返回 ranges(7 桶) + model。
 */
export function scanQoderCli(
  bounds: Bounds,
  cache: Record<string, any>,
  tool: QoderCliTool = "qodercli",
): QoderCliScanResult {
  prepareQoderCliLedger(tool, QODERCLI_LEDGER_VERSION);
  ledgerTouch(tool);
  const fc: Record<string, any> = (cache[tool] ??= {});
  if (fc["_parser"] !== QODERCLI_PARSER_VERSION) {
    // 口径变更：整块缓存作废（对应 fc.clear()）
    for (const key of Object.keys(fc)) delete fc[key];
    fc["_parser"] = QODERCLI_PARSER_VERSION;
    fc["_requests"] = {};
    cache["_dirty"] = true;
  }
  const requestIndex: Record<string, QoderCliEvent> = (fc["_requests"] ??= {});

  // glob(root/*/*.jsonl) + glob(root/*/*/subagents/*.jsonl)，排序去重
  const root = qoderCliDir(tool);
  const found = new Set<string>();
  if (isDirectory(root)) {
    for (const projectDir of listDirs(root)) {
      if (!visible(projectDir)) continue;
      for (const file of listFiles(projectDir)) {
        if (visible(file) && file.endsWith(".jsonl")) found.add(file);
      }
      for (const sessionDir of listDirs(projectDir)) {
        if (!visible(sessionDir)) continue;
        const subDir = path.join(sessionDir, "subagents");
        if (!isDirectory(subDir)) continue;
        for (const file of listFiles(subDir)) {
          if (visible(file) && file.endsWith(".jsonl")) found.add(file);
        }
      }
    }
  }
  const paths = [...found].sort();

  const stale = new Set(Object.keys(fc));
  for (const key of INTERNAL_KEYS) stale.delete(key);
  const subagentKey = path.sep + "subagents" + path.sep;
  let latestModel: string | null = fc["_model"] ?? null;
  let latestMtime = -1n;
  for (const file of paths) {
    stale.delete(file);
    let st: fs.Stats | fs.BigIntStats;
    try {
      st = fs.statSync(file, { bigint: true });
    } catch {
      continue;
    }
    // 对应 sig = f"{size}|{mtime_ns}"
    const sig = `${st.size}|${st.mtimeNs}`;
    const entry = fc[file] as QoderCliFileEntry | undefined;
    if (entry && typeof entry === "object" && entry.sig === sig && entry.parser === QODERCLI_PARSER_VERSION) {
      if (entry.model && st.mtimeNs > latestMtime) {
        latestMtime = st.mtimeNs;
        latestModel = entry.model;
      }
      continue;
    }
    let parsed: ReturnType<typeof parseQoderCliFile>;
    try {
      parsed = parseQoderCliFile(file);
    } catch {
      continue; // 对应 except OSError
    }
    for (const event of parsed.responses) {
      if (event.id) requestIndex[event.id] = mergeQoderCliEvent(requestIndex[event.id], event);
    }
    fc[file] = {
      sig, parser: QODERCLI_PARSER_VERSION, days: parsed.days, model: parsed.model,
      sub: file.includes(subagentKey),
    } satisfies QoderCliFileEntry;
    cache["_dirty"] = true;
    if (parsed.model && st.mtimeNs > latestMtime) {
      latestMtime = st.mtimeNs;
      latestModel = parsed.model;
    }
  }
  for (const gone of stale) {
    delete fc[gone];
    cache["_dirty"] = true;
  }
  if (latestModel && fc["_model"] !== latestModel) {
    fc["_model"] = latestModel;
    cache["_dirty"] = true;
  }

  const B = Object.fromEntries(RANGE_KEYS.map((k) => [k, emptyBucket()])) as Record<RangeKey, any>;
  // 日账始终由持久请求索引重建（scan_qodercli 传的就是 use_cached=False）
  const liveDays = qoderCliUsageDays(fc, false);
  const rangeSessions = Object.fromEntries(RANGE_KEYS.map((k) => [k, new Set<string>()])) as Record<RangeKey, Set<string>>;
  const rangeSubagents = Object.fromEntries(RANGE_KEYS.map((k) => [k, new Set<string>()])) as Record<RangeKey, Set<string>>;

  // 文件侧的日账：est / active 折进请求侧，会话数与 turns 只算非子代理文件
  for (const [file, raw] of Object.entries(fc)) {
    if (file.startsWith("_") || !raw || typeof raw !== "object") continue;
    const entry = raw as QoderCliFileEntry;
    const isSub = entry.sub === true;
    for (const [dk, day] of Object.entries(entry.days || {})) {
      if (!isIsoDay(dk)) continue;
      const agg: QoderCliUsageDay = (liveDays[dk] ??= emptyUsageDay());
      agg.est += trunc(day.est || 0);
      agg.duration += trunc(Number(day.active || 0) * 1000);
      for (const key of classifyDay(dk, bounds)) {
        if (isSub) rangeSubagents[key].add(file);
        else {
          rangeSessions[key].add(file);
          B[key].turns += day.turns || 0;
        }
      }
    }
  }

  if (!deepEqual(fc["_usage_days"], liveDays)) {
    fc["_usage_days"] = liveDays;
    cache["_dirty"] = true;
  }
  for (const key of RANGE_KEYS) {
    B[key].sessions = rangeSessions[key].size;
    B[key].sub_agents = rangeSubagents[key].size;
  }
  for (const [dk, day] of Object.entries(qoderCliLedgerReconcile(tool, liveDays))) {
    if (!isIsoDay(dk)) continue;
    for (const key of classifyDay(dk, bounds)) {
      const target = B[key];
      for (const field of ["in", "out", "cr", "cw", "calls", "tools", "usage_calls", "est", "duration"] as const) {
        target[field] += trunc(day[field] || 0);
      }
      target.credits += Number(day.credits) || 0;
      target.usage_available = target.usage_calls > 0;
      for (const [name, usage] of Object.entries(day.models || {})) {
        const modelTarget: QoderCliModelUsage = (target.models[name] ??= { in: 0, out: 0, cr: 0, cw: 0, credits: 0 });
        for (const field of ["in", "out", "cr", "cw"] as const) modelTarget[field] += trunc((usage as any)[field] || 0);
        modelTarget.credits += Number((usage as any).credits) || 0;
      }
    }
  }

  // Python 的 _qodercli_range()/qoderwork_range() 序列化在 payload 段做，本端口沿用
  // 采集器内序列化的约定（ctx_sum/ctx_count 只有 qoderwork 会写，这里恒为 0 → ctx:0）。
  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, qodercliRange(B[k])])) as Record<RangeKey, any>,
    model: fc["_model"] ?? null,
    days: liveDays,
  };
}

/** 工厂：CN 与 CLI 同口径，只差根目录与缓存键。 */
export function createQoderCliScanner(tool: QoderCliTool = "qodercli") {
  return (bounds: Bounds, cache: Record<string, any>) => scanQoderCli(bounds, cache, tool);
}

export const scanQoderCliCn = createQoderCliScanner("qodercli_cn");

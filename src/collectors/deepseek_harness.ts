/**
 * DeepSeek Harness 采集器：对应 usage.30s.py 的 scan_deepseek_harness(10388) /
 * _deepseek_harness_usage_record(10301) / _iter_deepseek_harness_records(10366)。
 *
 * 数据源：`~/.dsh/sessions/<项目>/<会话>/session*.jsonl.zstd`（多帧 zstd JSONL）。macOS 版是 App
 * 先原生解压成 .jsonl 再扫（TOKEI_DSH_DECOMPRESSED_DIR），Windows 侧直接用 Node 解压，
 * 两个目录都支持：压缩源走 zstd，已解压目录走纯 .jsonl。
 *
 * 字段（CALCULATION.md §2 DeepSeek Harness，底层字段互斥保存，卡片按 inclusiveIO 组合展示）：
 *   in = inputTokens，cr = cacheReadTokens，cw = cacheWriteTokens，
 *   out = outputTokens - reasoningTokens，reason = reasoningTokens（outputTokens 已含推理）。
 *   卡片输入 = in+cr+cw、输出 = out+reason、总量 = 五者之和，与「in=输入+缓存读+缓存写、
 *   out=outputTokens、total=in+out」的展示口径一致。
 * 成本：provider=deepseek-official 走官方人民币潮汐价 → 记 cost_cny，cost 保持 0；
 * 第三方渠道用其渠道价记 cost(USD)。**两币种分别累计，永不互加或换算**。
 * 定价一律交给 src/core/price.ts 的 deepseekOfficialPrice(model, 请求时刻)，本文件不重复实现。
 * 历史账本已接 ledger_reconcile：.jsonl 被清后用 ~/.tokei/ledger.json 的逐会话快照回补，
 * _cost_version 随天入账本，定价口径升级前旧快照不会被高水位误覆盖。
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey } from "../core/ranges";
import { deepseekOfficialPrice, pricingId, rawPrice } from "../core/price";
import { HOME, TOKEI_DIR, expandPath, existingDirs } from "../core/paths";
import { walkFiles } from "../core/fsutil";
import { Bucket, addTokenUsage, emptyBucket, mergeTokenDay, tokenUsageRange, TokenUsageRangeOut } from "../core/model";
import { DayRecord, ledgerAddRecordSource, ledgerReconcile, ledgerTouch } from "../core/ledger";

/** 对应 _DEEPSEEK_HARNESS_COST_VERSION = 5 */
export const DEEPSEEK_HARNESS_COST_VERSION = 5;
const MAX_FILE_BYTES = 256 * 1024 * 1024;

/** 压缩会话目录 + App 预解压目录（后者保留兼容 macOS 侧的落盘位置） */
export function deepseekHarnessDirs(): { compressed: string[]; plain: string[] } {
  // TOKEI_DSH_DIR 完全替换压缩根（与 claude/zcode 的 TOKEI_* 覆盖语义一致，便于测试注入）；
  // 否则 DSH_HOME → <dsh>/sessions，最终 ~/.dsh/sessions
  const configured = expandPath(process.env.TOKEI_DSH_DIR);
  const sessions = configured
    ? [configured]
    : [path.join(expandPath(process.env.DSH_HOME) || path.join(HOME, ".dsh"), "sessions")];
  // 对应 Python 138-139：TOKEI_DSH_DECOMPRESSED_DIR 是 os.environ.get 替换语义，
  // 设置后就是唯一已解压根，绝不与默认 ~/.tokei/cache/dsh-sessions 并扫
  const decompressedEnv = expandPath(process.env.TOKEI_DSH_DECOMPRESSED_DIR);
  const decompressed = decompressedEnv
    ? [decompressedEnv]
    : [path.join(TOKEI_DIR, "cache", "dsh-sessions")];
  return { compressed: existingDirs(sessions), plain: existingDirs(decompressed) };
}

// ---------------- 多帧 zstd ----------------

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DICT_ID_SIZE = [0, 1, 2, 4];

/**
 * Node 的 zlib.zstdDecompressSync / ZstdDecompress 流都只解**第一帧**就停下
 * （实测三帧拼接只返回 6 字节里的第一帧），所以必须自己按帧切分。
 * 帧头位序按 zstd 参考实现：bits7-6 FCS 长度档、bit5 single_segment、bit2 content_checksum、
 * bits1-0 dictID 长度档；!single_segment 时固定带 1 字节 Window_Descriptor。
 * 校验：真实 ~/.dsh 12 个文件、3 万+ 行全部逐帧解出且行内 JSON 可解析。
 */
export function zstdFrameEnd(buf: Buffer, start: number): number {
  let p = start + 4;
  if (p >= buf.length) return -1;
  const flg = buf[p];
  p += 1;
  const fcsId = flg >> 6;
  const singleSegment = (flg >> 5) & 1;
  const checksum = (flg >> 2) & 1;
  const dictIdFlag = flg & 3;
  if (!singleSegment) p += 1;
  p += DICT_ID_SIZE[dictIdFlag];
  p += singleSegment ? (fcsId === 0 ? 1 : 1 << fcsId) : (fcsId === 0 ? 0 : 1 << fcsId);
  for (;;) {
    if (p + 3 > buf.length) return -1;
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >> 3;
    if (type === 3) return -1; // reserved block type：不是合法帧
    p += 3 + (type === 1 ? 1 : size); // RLE 块固定 1 字节载荷
    if (p > buf.length) return -1;
    if (last) break;
  }
  if (checksum) p += 4;
  return p;
}

/** 多帧解压：逐帧切片解压后拼接；遇到截断帧就用已解出的部分（Harness 会续写） */
export function decompressZstdFrames(buf: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let p = 0;
  while (p < buf.length) {
    if (buf.compare(ZSTD_MAGIC, 0, 4, p, p + 4) !== 0) {
      // 尾部脏字节（并发写入未落全）：跳到下一个魔数再试
      const next = buf.indexOf(ZSTD_MAGIC, p);
      if (next === -1) break;
      p = next;
      continue;
    }
    const end = zstdFrameEnd(buf, p);
    if (end <= p || end > buf.length) break;
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(p, end)));
    } catch {
      break;
    }
    p = end;
  }
  return Buffer.concat(chunks);
}

export function readSessionJsonl(file: string): string {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return "";
  }
  if (st.size <= 0 || st.size > MAX_FILE_BYTES) return "";
  const buf = fs.readFileSync(file);
  return file.endsWith(".zstd") ? decompressZstdFrames(buf).toString("utf8") : buf.toString("utf8");
}

// ---------------- 记录解析 ----------------

export interface HarnessRecord {
  date: string;
  hour: number;
  ts: number;
  turn: number;
  step: number;
  priority: number;
  model: string;
  provider: string;
  in: number;
  out: number;
  cr: number;
  cw: number;
  reason: number;
  cost: number;
  cost_cny: number;
}

/** 对应 _deepseek_harness_usage_record()：assistant/message 权威，chunk usage 仅兜底 */
export function harnessUsageRecord(
  item: Record<string, any> | null | undefined,
  fallbackModel = "",
  fallbackProvider = "deepseek-official",
): HarnessRecord | null {
  if (!item || typeof item !== "object") return null;
  const eventType = item.type;
  const data = item.data && typeof item.data === "object" ? item.data : null;
  if (!data) return null;

  let priority = 0;
  let usage: Record<string, any> | null = null;
  let model: unknown = fallbackModel;
  let provider: unknown = fallbackProvider;
  if (eventType === "assistant/message") {
    usage = data.usage as Record<string, any>;
    const message = data.message && typeof data.message === "object" ? data.message : {};
    const source = message.source && typeof message.source === "object" ? message.source : {};
    model = source.model || model;
    provider = source.provider || provider;
    priority = 2;
  } else if (eventType === "assistant/chunk") {
    const chunk = data.chunk && typeof data.chunk === "object" ? data.chunk : {};
    if (chunk.type === "usage") {
      usage = chunk.usage as Record<string, any>;
      priority = 1;
    }
  }
  if (!usage || typeof usage !== "object") return null;

  const timestamp = Number(item.time);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(Math.trunc(timestamp));
  if (Number.isNaN(date.getTime())) return null;
  const turn = Number(data.turn);
  const step = Number(data.step);
  if (!Number.isFinite(turn) || !Number.isFinite(step)) return null;

  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const dayText = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  const inp = Math.max(Math.trunc(Number(usage.inputTokens) || 0), 0);
  const rawOut = Math.max(Math.trunc(Number(usage.outputTokens) || 0), 0);
  const cr = Math.max(Math.trunc(Number(usage.cacheReadTokens) || 0), 0);
  const cw = Math.max(Math.trunc(Number(usage.cacheWriteTokens) || 0), 0);
  const reason = Math.min(Math.max(Math.trunc(Number(usage.reasoningTokens) || 0), 0), rawOut);
  const out = rawOut - reason;
  if (inp + rawOut + cr + cw <= 0) return null;

  const modelId = String(model || "deepseek-v4-pro");
  const providerId = String(provider || "");
  const official = providerId === "deepseek-official" ? deepseekOfficialPrice(modelId, date) : null;
  const usesCny = official !== null;
  let cost = 0;
  let costCny = 0;
  const price = official ?? (() => {
    const priceId = pricingId(modelId);
    return priceId ? rawPrice(priceId) : null;
  })();
  if (price) {
    // 官方价表单位是 CNY/1M token，第三方是 USD/1M token：分别入不同字段，不换算
    const amount = (inp * price.in + rawOut * price.out + cr * price.cache_read + cw * price.cache_write) / 1e6;
    if (usesCny) costCny = amount;
    else cost = amount;
  }
  return {
    date: dayText, hour: date.getHours(), ts: Math.trunc(timestamp),
    turn: Math.trunc(turn), step: Math.trunc(step), priority,
    model: modelId, provider: providerId,
    in: inp, out, cr, cw, reason, cost, cost_cny: costCny,
  };
}

interface HarnessFileEntry {
  sig: string;
  records: HarnessRecord[];
  proj: string;
  sid: string;
  cost_version: number;
}

function parseHarnessFile(file: string): HarnessFileEntry | null {
  const text = readSessionJsonl(file);
  if (!text) return null;
  let sessionId = path.basename(file).replace(/\.jsonl(\.zstd)?$/, "");
  let project = "";
  let currentModel = "deepseek-v4-pro";
  let currentProvider = "deepseek-official";
  const candidates = new Map<string, HarnessRecord>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    if (!line.includes('"type"')) continue;
    if (!line.includes('"session"') && !line.includes('"request/header"')
      && !line.includes('"assistant/chunk"') && !line.includes('"assistant/message"')) continue;
    let item: Record<string, any>;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item.type === "session") {
      sessionId = String(item.id || sessionId);
      project = String(item.cwd || project);
      continue;
    }
    if (item.type === "request/header") {
      const config = ((((item.data || {}).header) || {}).config) || {};
      if (config && typeof config === "object") {
        currentModel = String(config.model || currentModel);
        currentProvider = String(config.provider || currentProvider);
      }
      continue;
    }
    const record = harnessUsageRecord(item, currentModel, currentProvider);
    if (!record) continue;
    const key = `${record.turn}:${record.step}`;
    const previous = candidates.get(key);
    // 同一次调用 Harness 会写 chunk usage 和最终 message：只留最终 message，异常中断时 chunk 兜底
    if (!previous || record.priority >= previous.priority) candidates.set(key, record);
  }
  const records = [...candidates.values()].sort((a, b) => a.ts - b.ts);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  return {
    sig: `${Math.trunc(st.mtimeMs / 1000)}:${st.size}`,
    records, proj: project, sid: sessionId, cost_version: DEEPSEEK_HARNESS_COST_VERSION,
  };
}

/** 对应 _iter_deepseek_harness_records()：跨文件按 (session,turn,step) 二次去重 */
export function iterHarnessRecords(fileCache: Record<string, HarnessFileEntry>): Array<[string, HarnessFileEntry, HarnessRecord]> {
  const all: Array<[number, string, HarnessFileEntry, HarnessRecord]> = [];
  for (const [file, entry] of Object.entries(fileCache)) {
    if (!entry || !Array.isArray(entry.records)) continue;
    for (const record of entry.records) all.push([record.ts, file, entry, record]);
  }
  all.sort((a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const seen = new Set<string>();
  const out: Array<[string, HarnessFileEntry, HarnessRecord]> = [];
  for (const [, file, entry, record] of all) {
    const session = String(entry.sid || file);
    const key = `${session}\0${record.turn}\0${record.step}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([file, entry, record]);
  }
  return out;
}

export interface HarnessDay {
  in: number; out: number; cr: number; cw: number; reason: number; cost: number; credits: number; cost_cny: number;
  hours: number[]; models: Record<string, any>; sessions: string[]; projects: string[];
  _cost_version: number;
}

export interface DeepSeekHarnessScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  model?: string | null;
  /** 逐日/逐小时明细不进 payload：与 Python 一致，只留在扫描缓存里供 Dashboard 复用 */
  days?: Record<string, HarnessDay>;
  hours?: number[];
}

function emptyDay(): HarnessDay {
  return {
    in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0,
    hours: new Array(24).fill(0), models: {}, sessions: [], projects: [],
    _cost_version: DEEPSEEK_HARNESS_COST_VERSION,
  };
}

/** 对应 scan_deepseek_harness()（10388）：账本对账已接入（10459-10499） */
export function scanDeepSeekHarness(bounds: Bounds, cache: Record<string, any>): DeepSeekHarnessScanResult {
  ledgerTouch("deepseek_harness"); // ledger_touch（10389）
  const fc: Record<string, HarnessFileEntry> = (cache.deepseek_harness ??= {});
  const buckets = Object.fromEntries(RANGE_KEYS.map((k) => [k, emptyBucket()])) as Record<RangeKey, Bucket>;
  const { compressed, plain } = deepseekHarnessDirs();

  const files: string[] = [];
  for (const dir of compressed) for (const entry of walkFiles(dir, [".jsonl.zstd"])) files.push(entry.file);
  for (const dir of plain) for (const entry of walkFiles(dir, [".jsonl"])) files.push(entry.file);
  const unique = [...new Set(files)].sort();
  const keep = new Set(unique);

  for (const file of unique) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const sig = `${Math.trunc(st.mtimeMs / 1000)}:${st.size}`;
    const existing = fc[file];
    if (existing && existing.sig === sig && existing.cost_version === DEEPSEEK_HARNESS_COST_VERSION) continue;
    const parsed = parseHarnessFile(file);
    if (!parsed) continue;
    fc[file] = parsed;
    cache._dirty = true;
  }
  for (const stale of Object.keys(fc)) {
    if (!keep.has(stale)) {
      delete fc[stale];
      cache._dirty = true;
    }
  }

  const days: Record<string, HarnessDay> = {};
  const ledgerSources: Record<string, Record<string, DayRecord>> = {}; // 对应 ledger_sources（10460）
  const daySessions = new Map<string, Set<string>>(); // 对应 sessions（10461）
  const dayProjects = new Map<string, Set<string>>(); // 对应 day_projects（10462）
  const hours = new Array(24).fill(0);
  for (const [file, entry, record] of iterHarnessRecords(fc)) {
    // 逐会话来源快照（10464-10465）：文件被清后账本仍能按会话还原当天贡献
    ledgerAddRecordSource(ledgerSources, entry.sid || file, record.date, record, record.hour);
    const day = (days[record.date] ??= emptyDay());
    addTokenUsage(day as unknown as Bucket, record.in, record.out, record.cr, record.cw,
      record.reason, record.cost, record.model, 0, record.cost_cny);
    const total = record.in + record.out + record.cr + record.cw + record.reason;
    day.hours[record.hour] += total;
    hours[record.hour] += total;
    const session = String(entry.sid || "unknown");
    const set = daySessions.get(record.date) ?? new Set<string>();
    set.add(session);
    daySessions.set(record.date, set);
    if (!day.sessions.includes(session)) day.sessions.push(session);
    const projectName = entry.proj ? path.basename(entry.proj.replace(/[\\/]+$/, "")) : "";
    if (projectName) {
      const names = dayProjects.get(record.date) ?? new Set<string>();
      names.add(projectName);
      dayProjects.set(record.date, names);
    }
  }
  // 项目名随天入账本（10477-10478）：日志被清理后仍能回答「那天在干什么」
  for (const [date, names] of dayProjects) {
    days[date].projects = [...names].sort().slice(0, 3);
  }
  // 成本口径版本戳（10479-10483）：实时天与逐来源快照都盖章，账本高水位据此比较
  for (const day of Object.values(days)) day._cost_version = DEEPSEEK_HARNESS_COST_VERSION;
  for (const source of Object.values(ledgerSources)) {
    for (const day of Object.values(source)) day._cost_version = DEEPSEEK_HARNESS_COST_VERSION;
  }

  // 会话数只能来自现存日志（10485-10491：被清日志无从归属）
  for (const [dayKey, set] of daySessions) {
    for (const key of classifyDay(dayKey, bounds)) {
      for (const session of set) buckets[key].sessions.add(session);
    }
  }
  // 天级高水位对账（10493-10499）：日志被删的天用 ~/.tokei/ledger.json 的快照兜底
  const reconciled = ledgerReconcile("deepseek_harness", days, ledgerSources) as Record<string, HarnessDay>;
  for (const [dayKey, day] of Object.entries(reconciled)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) continue; // 对应 date.fromisoformat 校验（10494-10497）
    for (const key of classifyDay(dayKey, bounds)) mergeTokenDay(buckets[key], day);
  }

  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])])) as Record<RangeKey, TokenUsageRangeOut>,
    model: null,
    days,
    hours,
  };
}

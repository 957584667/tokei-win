/**
 * Gemini / Antigravity CLI 采集器：对应 usage.30s.py 的 scan_gemini / _gemini_session_files /
 * _load_gemini_usage_file / _load_antigravity_db / _antigravity_gen_step。
 * 源：~/.gemini/antigravity-cli/conversations/*.db（gen_metadata protobuf）
 *     + ~/.gemini/<项目哈希>/chats/session-*.json(l)（messages[].tokens）。
 *
 * 关键口径：
 * - tokens.input 已含 cached：in = input - cached、cached = tokens.cached、
 *   thoughts = tokens.thoughts（拆分与 hit=cached/input 由 model.ts geminiRange 完成）。
 * - thoughts 按输出价计费；成本公式已在 model.ts recalcCosts 的 "gemini" 分支实现，
 *   采集器只聚合 token、不重复算成本（与 claude.ts 的职责切分一致）。
 * - db/json 同源重复按 sid 去重，取 (rank, updated, mtime) 更大者（db=3 > jsonl=2 > json=1）。
 * - gen_metadata 字段号系逆向（无官方 schema），保留 Python 的 token/时间戳上界校验，坏数据宁可丢。
 */
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "node:module";
import { HOME, APPDATA, pathCandidates } from "../core/paths";
import { walkFiles, forEachLine, readTextSafe } from "../core/fsutil";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey, parseTs } from "../core/ranges";
import { ledgerReconcile, ledgerTouch } from "../core/ledger";
import { GeminiRangeOut, geminiRange } from "../core/model";

// vite-node 的内置模块表没有 node:sqlite（静态 import 会被当外部包解析），
// 统一走 createRequire；Electron 的 CJS 产物同样适用
const { DatabaseSync } = createRequire(path.join(process.cwd(), "noop.js"))("node:sqlite") as typeof import("node:sqlite");

/** 事件：compact 结构，ts 为本地毫秒时间戳（与 claude.ts 约定一致） */
export interface GeminiEvent {
  id: string;
  ts: number;
  model: string;
  inp: number;    // 已含 cached
  out: number;
  cached: number;
  thoughts: number;
}

interface ParsedFile {
  sig: string | null;
  sid: string;
  updated: string;
  rank: number;
  mtime: number;
  events: GeminiEvent[];
}

interface GeminiBucket {
  in: number; out: number; cached: number; thoughts: number;
  models: Record<string, { in: number; out: number; cached: number; thoughts: number }>;
  sessions: Set<string>;
}

export interface GeminiDayAgg {
  in: number; out: number; cached: number; thoughts: number;
  models: Record<string, { in: number; out: number; cached: number; thoughts: number }>;
  sessions: Set<string>;
  hours: number[];
}

export interface GeminiScanResult {
  ranges: Record<RangeKey, GeminiRangeOut>;
  days: Record<string, GeminiDayAgg>;
}

// ---------------- 路径发现（对应 GEMINI_DIR / GEMINI_DIRS / _gemini_session_files） ----------------

export function geminiRoots(): string[] {
  const agy = process.env.TOKEI_ANTIGRAVITY_DIR;
  return pathCandidates(
    "TOKEI_GEMINI_DIR",
    path.join(HOME, ".gemini", "tmp"),
    path.join(HOME, ".gemini", "antigravity-cli", "conversations"),
    path.join(HOME, ".gemini", "antigravity", "conversations"),
    path.join(HOME, ".gemini", "antigravity-ide", "conversations"),
    path.join(HOME, ".gemini", "gemini-cli", "conversations"),
    // Windows 安装位置（tests/test_windows_paths.py：%APPDATA%\Gemini\conversations）
    path.join(APPDATA, "Gemini", "conversations"),
    agy || null,
  );
}

export function geminiSessionFiles(): string[] {
  const found = new Set<string>();
  for (const root of geminiRoots()) {
    for (const { file, rel } of walkFiles(root, [".db", ".json", ".jsonl"])) {
      if (!matchGeminiPattern(file, rel)) continue;
      if (!isPlainFile(file)) continue;
      try {
        found.add(fs.realpathSync(file));
      } catch {
        /* 扫描瞬间被删 */
      }
    }
  }
  return [...found].sort();
}

function isPlainFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 对应 Python 的 glob 集合：任意层级的 .db（排除 conversation_summaries.db）、session-*.json(l)、root/项目/chats/ 下的 .jsonl */
function matchGeminiPattern(file: string, rel: string): boolean {
  const name = path.basename(file);
  if (name.endsWith(".db")) return name !== "conversation_summaries.db";
  if (/^session-.*\.(json|jsonl)$/.test(name)) return true;
  if (!name.endsWith(".jsonl")) return false;
  const segs = rel.split(path.sep);
  return segs.length >= 3 && segs[1] === "chats";
}

// ---------------- protobuf 最小读取器（仅本文件用，不入 core） ----------------

const PROTO_VARINT_MAX_BYTES = 10; // 64 位整数最多 10 字节

function decodeProtoVarint(data: Uint8Array, offset: number): [number, number] {
  let val = 0;
  let shift = 0;
  for (let i = 0; i < PROTO_VARINT_MAX_BYTES; i++) {
    if (offset >= data.length) break;
    const b = data[offset++];
    // 不用位运算：>2^31 的 key/val 在 int32 下会回绕；超出安全整数的值必然过不了上界校验
    val += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [val, offset];
    shift += 7;
  }
  throw new Error("varint 超过 64 位,当坏数据处理");
}

interface ProtoField { fn: number; wt: number; val: number | Uint8Array }

function parseProtoFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < data.length) {
    let key: number;
    try {
      [key, i] = decodeProtoVarint(data, i);
    } catch {
      break;
    }
    const fn = Math.floor(key / 8);
    const wt = key % 8;
    if (wt === 0) {
      let v: number;
      try {
        [v, i] = decodeProtoVarint(data, i);
      } catch {
        break;
      }
      fields.push({ fn, wt, val: v });
    } else if (wt === 2) {
      let length: number;
      try {
        [length, i] = decodeProtoVarint(data, i);
      } catch {
        break;
      }
      // 越界不能静默截短：截出的碎片会被当成合法子消息继续解析
      if (length < 0 || i + length > data.length) break;
      fields.push({ fn, wt, val: data.subarray(i, i + length) });
      i += length;
    } else if (wt === 1 || wt === 5) {
      const width = wt === 1 ? 8 : 4;
      if (i + width > data.length) break;
      fields.push({ fn, wt, val: data.subarray(i, i + width) });
      i += width;
    } else {
      break;
    }
  }
  return fields;
}

function decodePackedVarints(data: Uint8Array): number[] {
  const values: number[] = [];
  let offset = 0;
  while (offset < data.length) {
    const [value, next] = decodeProtoVarint(data, offset);
    values.push(value);
    offset = next;
  }
  return values;
}

// ---------------- Antigravity SQLite ----------------

const ANTIGRAVITY_MAX_TOKENS = 100_000_000; // 单次生成上界,超了就是解析错位
const ANTIGRAVITY_MIN_TS = 1_577_836_800;   // 2020-01-01,更早的时间戳必然是错位

function tsOk(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= ANTIGRAVITY_MIN_TS && v <= 2 ** 34;
}

function isPrintable(s: string): boolean {
  return !/[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200d\ufeff]/.test(s);
}

function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return new Uint8Array(Buffer.from(v, "binary"));
  return null;
}

/** gen_metadata.data 字段号逆向所得：1=生成记录（19=模型,4={2:输入(不含缓存),3:输出,5:缓存读,9:思考},9→4→1=开始秒） */
function antigravityGenStep(record: Uint8Array, fallbackTs: number | null): Omit<GeminiEvent, "id" | "ts"> & { tsSec: number } | null {
  let model = "unknown";
  let inp = 0, out = 0, cached = 0, thoughts = 0;
  let tsSec: number | null = null;
  for (const f of parseProtoFields(record)) {
    if (f.fn === 19 && f.wt === 2) {
      try {
        model = new TextDecoder("utf-8", { fatal: true }).decode(f.val as Uint8Array);
      } catch {
        /* 保持 unknown */
      }
    } else if (f.fn === 4 && f.wt === 2) {
      for (const t of parseProtoFields(f.val as Uint8Array)) {
        if (t.wt !== 0) continue;
        if (t.fn === 2) inp = t.val as number;
        else if (t.fn === 3) out = t.val as number;
        else if (t.fn === 5) cached = t.val as number;
        else if (t.fn === 9) thoughts = t.val as number;
      }
    } else if (f.fn === 9 && f.wt === 2) {
      for (const t of parseProtoFields(f.val as Uint8Array)) {
        if (t.fn !== 4 || t.wt !== 2) continue;
        for (const s of parseProtoFields(t.val as Uint8Array)) {
          if (s.fn === 1 && s.wt === 0) tsSec = s.val as number;
        }
      }
    }
  }
  // 账本是逐日高水位,虚高数字一旦写进去就永久留着 —— 宁可丢也不能记错
  if (!tsOk(tsSec)) tsSec = fallbackTs;
  if (!tsOk(tsSec)) return null;
  if (Math.max(inp, out, cached, thoughts) > ANTIGRAVITY_MAX_TOKENS) return null;
  if (!model || model.length > 120 || !isPrintable(model)) model = "unknown";
  return { model, inp, out, cached, thoughts, tsSec };
}

/** 当前版本把 google.protobuf.Timestamp 存在 steps.metadata 字段 1 */
function antigravityStepTimestamp(metadata: Uint8Array | null): number | null {
  if (!metadata) return null;
  for (const f of parseProtoFields(metadata)) {
    if (f.fn !== 1 || f.wt !== 2) continue;
    for (const sub of parseProtoFields(f.val as Uint8Array)) {
      if (sub.fn === 1 && sub.wt === 0 && tsOk(sub.val)) return sub.val as number;
    }
  }
  return null;
}

function loadAntigravityDb(file: string): Omit<ParsedFile, "sig" | "mtime"> | null {
  let rows: Record<string, unknown>[] = [];
  let stepRows: Record<string, unknown>[] = [];
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      rows = db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx ASC").all() as Record<string, unknown>[];
      try {
        stepRows = db.prepare("SELECT idx, metadata FROM steps").all() as Record<string, unknown>[];
      } catch {
        stepRows = [];
      }
    } finally {
      db.close();
    }
  } catch {
    return null;
  }

  const stepTimestamps = new Map<number, number>();
  for (const row of stepRows) {
    const ts = antigravityStepTimestamp(toBytes(row.metadata));
    if (ts !== null) stepTimestamps.set(Number(row.idx), ts);
  }

  const events: GeminiEvent[] = [];
  let maxTs = "";
  for (const row of rows) {
    const data = toBytes(row.data);
    if (!data || data.length === 0) continue;
    const fields = parseProtoFields(data);
    const referenced: number[] = [];
    for (const f of fields) {
      if (f.fn === 2 && f.wt === 2) {
        try {
          referenced.push(...decodePackedVarints(f.val as Uint8Array));
        } catch {
          /* 截断的引用列表整段丢弃 */
        }
      }
    }
    let fallbackTs: number | null = null;
    for (const idx of referenced) {
      const hit = stepTimestamps.get(idx);
      if (hit !== undefined) {
        fallbackTs = hit;
        break;
      }
    }
    let recordIndex = 0;
    for (const f of fields) {
      if (f.fn !== 1 || f.wt !== 2) continue;
      let step: ReturnType<typeof antigravityGenStep> = null;
      try {
        step = antigravityGenStep(f.val as Uint8Array, fallbackTs);
      } catch {
        step = null; // 一行坏数据不该带走同库的好数据
      }
      if (!step) continue;
      const iso = new Date(step.tsSec * 1000).toISOString().slice(0, 19) + "Z";
      if (iso > maxTs) maxTs = iso;
      events.push({
        id: `${path.basename(file)}:${Number(row.idx)}:${recordIndex}`,
        ts: step.tsSec * 1000,
        model: step.model,
        // db 的 input 不含缓存；统一成 JSON 侧口径（input 已含 cached）
        inp: step.inp + step.cached,
        out: step.out,
        cached: step.cached,
        thoughts: step.thoughts,
      });
      recordIndex++;
    }
  }

  if (!events.length) return null;
  const sid = path.basename(file).replace(/\.db$/, "");
  return { sid, updated: maxTs, rank: 3, events };
}

// ---------------- Gemini JSON / JSONL ----------------

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function intOf(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 对应 _gemini_apply_messages：按消息 id 建索引（Map 保插入序，数字串 id 不会乱序） */
function applyMessages(map: Map<string, Record<string, any>>, messages: unknown, replace = false): void {
  if (replace) map.clear();
  const list = isObj(messages) ? [messages] : Array.isArray(messages) ? messages : null;
  if (!list) return;
  for (const message of list) {
    if (!isObj(message)) continue;
    const id = message.id;
    if (id) map.set(String(id), message);
  }
}

function loadGeminiJsonFile(file: string): Omit<ParsedFile, "sig" | "mtime"> | null {
  const rank = file.endsWith(".jsonl") ? 2 : 1;
  const metadata: Record<string, any> = {};
  const messages = new Map<string, Record<string, any>>();

  if (rank === 1) {
    let record: unknown;
    try {
      record = JSON.parse(readTextSafe(file) ?? "");
    } catch {
      return null;
    }
    if (!isObj(record)) return null;
    Object.assign(metadata, record);
    applyMessages(messages, record.messages);
  } else {
    forEachLine(file, (text) => {
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        return;
      }
      if (!isObj(record)) return;
      const rewindId = record.$rewindTo;
      if (typeof rewindId === "string") {
        const keys = [...messages.keys()];
        if (messages.has(rewindId)) {
          // 回退：丢掉该消息及其后的所有版本
          for (const id of keys.slice(keys.indexOf(rewindId))) messages.delete(id);
        } else {
          messages.clear();
        }
        return;
      }
      if (typeof record.id === "string") {
        messages.set(record.id, record);
        return;
      }
      if (isObj(record.$set)) {
        applyMessages(messages, record.$set.messages, true);
        Object.assign(metadata, record.$set);
        return;
      }
      if (isObj(record.$push)) {
        applyMessages(messages, record.$push.messages);
        return;
      }
      if (typeof record.sessionId === "string") {
        Object.assign(metadata, record);
        applyMessages(messages, record.messages);
      }
    });
  }

  const events: GeminiEvent[] = [];
  for (const [messageId, message] of messages) {
    const tokens = message.tokens;
    if (message.type !== "gemini" || !isObj(tokens)) continue;
    if (!message.timestamp) continue;
    const parsed = parseTs(message.timestamp);
    if (!parsed) continue;
    events.push({
      id: messageId,
      ts: parsed.epoch * 1000,
      model: message.model ? String(message.model) : "unknown",
      inp: intOf(tokens.input),
      out: intOf(tokens.output),
      cached: intOf(tokens.cached),
      thoughts: intOf(tokens.thoughts),
    });
  }
  return {
    sid: metadata.sessionId ? String(metadata.sessionId) : path.basename(file),
    updated: metadata.lastUpdated ? String(metadata.lastUpdated) : "",
    rank,
    events,
  };
}

/** 导出来给「查漏补缺」扫模型名用：它只要 events[].model，不要区间。 */
export function loadGeminiUsageFile(file: string): Omit<ParsedFile, "sig" | "mtime"> | null {
  return file.endsWith(".db") ? loadAntigravityDb(file) : loadGeminiJsonFile(file);
}

/** SQLite 新数据可能全在 -wal 里,主库 mtime/size 一动不动 —— 签名必须带上 -wal */
function fileSignature(file: string, stat: fs.Stats): string | null {
  if (!file.endsWith(".db")) return `${stat.mtimeMs}:${stat.size}`;
  const parts: string[] = [];
  for (const candidate of [file, `${file}-wal`]) {
    try {
      const s = fs.statSync(candidate);
      parts.push(`${candidate}:${s.mtimeMs}:${s.size}`);
    } catch {
      /* wal 未必存在 */
    }
  }
  return parts.join("|") || null;
}

// ---------------- scan ----------------

function emptyInternalBucket(): GeminiBucket {
  return { in: 0, out: 0, cached: 0, thoughts: 0, models: {}, sessions: new Set() };
}

export function emptyGemini(): GeminiScanResult {
  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, geminiRange(emptyInternalBucket())])) as Record<RangeKey, GeminiRangeOut>,
    days: {},
  };
}

/** 对应 scan_gemini()：历史账本已接 ledger_reconcile（日志被清的天用 ~/.tokei/ledger.json 回补） */
export function scanGemini(bounds: Bounds, cache: Record<string, any>): GeminiScanResult {
  ledgerTouch("gemini");
  const fc: Record<string, ParsedFile> = (cache.gemini ??= {});
  const files = geminiSessionFiles();

  if (!files.length) {
    if (Object.keys(fc).length) {
      for (const key of Object.keys(fc)) delete fc[key];
      cache._dirty = true;
    }
    return emptyGemini();
  }

  const present = new Set(files);
  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const sig = fileSignature(file, stat);
    const entry = fc[file];
    if (entry && entry.sig === sig) continue;
    const parsed = loadGeminiUsageFile(file);
    if (!parsed) continue; // 解析失败保留旧缓存,别让坏文件清空历史
    fc[file] = { ...parsed, sig, mtime: stat.mtimeMs };
    cache._dirty = true;
  }
  for (const file of Object.keys(fc)) {
    if (!present.has(file)) {
      delete fc[file];
      cache._dirty = true;
    }
  }

  // sid 去重：同一会话可能同时有 db/jsonl/json 三副本,取分数最高的整份
  const sessions = new Map<string, { score: [number, string, number]; entry: ParsedFile }>();
  for (const entry of Object.values(fc)) {
    const sid = entry.sid || "unknown";
    const score: [number, string, number] = [entry.rank, entry.updated, entry.mtime];
    const current = sessions.get(sid);
    if (!current || cmpScore(score, current.score) > 0) sessions.set(sid, { score, entry });
  }

  const days: Record<string, GeminiDayAgg> = {};
  for (const [sid, { entry }] of sessions) {
    for (const event of entry.events) {
      const date = new Date(event.ts);
      const dk = dayKey(date);
      const day = (days[dk] ??= { in: 0, out: 0, cached: 0, thoughts: 0, models: {}, sessions: new Set(), hours: new Array(24).fill(0) });
      day.in += event.inp;
      day.out += event.out;
      day.cached += event.cached;
      day.thoughts += event.thoughts;
      day.sessions.add(sid);
      day.hours[date.getHours()] += event.inp + event.out + event.thoughts;
      const m = (day.models[event.model] ??= { in: 0, out: 0, cached: 0, thoughts: 0 });
      m.in += event.inp;
      m.out += event.out;
      m.cached += event.cached;
      m.thoughts += event.thoughts;
    }
  }

  const buckets = Object.fromEntries(RANGE_KEYS.map((k) => [k, emptyInternalBucket()])) as Record<RangeKey, GeminiBucket>;
  // 会话数只能来自现存日志（被清日志无从归属）
  for (const [dk, day] of Object.entries(days)) {
    for (const key of classifyDay(dk, bounds)) {
      for (const s of day.sessions) buckets[key].sessions.add(s);
    }
  }
  // 天级高水位对账：日志被删的天用 ~/.tokei/ledger.json 的快照兜底（对应 ledger_reconcile("gemini", days)）
  const reconciled = ledgerReconcile("gemini", days) as Record<string, GeminiDayAgg>;
  for (const [dk, day] of Object.entries(reconciled)) {
    for (const key of classifyDay(dk, bounds)) {
      const bucket = buckets[key];
      bucket.in += day.in || 0;
      bucket.out += day.out || 0;
      bucket.cached += day.cached || 0;
      bucket.thoughts += day.thoughts || 0;
      for (const [model, usage] of Object.entries<GeminiDayAgg["models"][string]>(day.models ?? {})) {
        const m = (bucket.models[model] ??= { in: 0, out: 0, cached: 0, thoughts: 0 });
        m.in += usage.in || 0;
        m.out += usage.out || 0;
        m.cached += usage.cached || 0;
        m.thoughts += usage.thoughts || 0;
      }
    }
  }

  // cost 留 0：装配 payload 后由 recalcCosts 的 "gemini" 分支按
  // in(不含缓存)×p.in + (out+thoughts)×p.out + cached×p.cache_read 统一补
  const ranges = Object.fromEntries(RANGE_KEYS.map((k) => [k, geminiRange(buckets[k])])) as Record<RangeKey, GeminiRangeOut>;
  return { ranges, days };
}

function cmpScore(a: [number, string, number], b: [number, string, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] > b[1] ? 1 : -1;
  return a[2] - b[2];
}

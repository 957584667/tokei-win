/**
 * Grok Bot 采集器：对应 usage.30s.py 的 scan_grok_bot(10211) / _grok_bot_parse_blob(10109)。
 *
 * macOS 读 ~/Library/Application Support/Grok Bot/sand-client-persistence/*.blob；
 * Windows 侧目前还没有这个目录，所以路径候选改挂 %APPDATA% / %LOCALAPPDATA%
 * （Python 的 GROK_BOT_DIRS 已经预留了这两条），目录不存在时返回键位齐全的空结果。
 *
 * 口径（CALCULATION.md §2 Grok Bot）：blob 是 JSON 快照，只有消息/活动元数据，
 * **没有 token、模型、成本字段**，因此 ranges 的 in/out 恒为 0（未知），
 * 文本长度绝不参与 token 估算。响应数按 requestId 去重，用户消息按稳定 entry id 去重，
 * 多个持久化键存同一份 transcript 时按首尾 entry 边界（fingerprint）再去重。
 * 官方额度查询（Keychain/sand usage）需要网络与 macOS 专有能力，本里程碑不实现：quota 恒 null。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey } from "../core/ranges";
import { ledgerTouch } from "../core/ledger";
import { APPDATA, HOME, LOCALAPPDATA, existingDirs, pathCandidates } from "../core/paths";

const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const ACTIVE_GAP_SECONDS = 5 * 60;

/** 对应 GROK_BOT_DIRS：TOKEI_GROK_BOT_DIR 优先，其次 Windows 两个标准位置与 ~/.config */
export function grokBotDirs(): string[] {
  return existingDirs(pathCandidates(
    "TOKEI_GROK_BOT_DIR",
    path.join(APPDATA, "Grok Bot", "sand-client-persistence"),
    path.join(LOCALAPPDATA, "Grok Bot", "sand-client-persistence"),
    path.join(HOME, "Library", "Application Support", "Grok Bot", "sand-client-persistence"),
    path.join(HOME, ".config", "Grok Bot", "sand-client-persistence"),
  ));
}

export interface GrokBotDay {
  turns: number;
  calls: number;
  tools: number;
  duration: number;
}

export type GrokBotBlob =
  | { kind: "ignored"; sig?: number[] }
  | { kind: "roster"; rows: Array<{ id: string; markers: string[] }>; sig?: number[] }
  | { kind: "transcript"; days: Record<string, GrokBotDay>; markers: string[]; fingerprint: string; sig?: number[]; sid?: string };

function numberValue(value: unknown): number | null {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 对应 _grok_bot_parse_blob() */
export function parseGrokBotBlob(file: string): GrokBotBlob {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { kind: "ignored" };
  }
  if (size <= 0 || size > MAX_BLOB_BYTES) return { kind: "ignored" };
  let root: Record<string, any>;
  try {
    root = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { kind: "ignored" };
  }
  const value = root && typeof root === "object" ? root.value : null;
  if (!value || typeof value !== "object") return { kind: "ignored" };

  // roster：会话清单位，行 id + 若干 entry 标记，用于给 transcript 归属会话
  const rows = value.rows;
  if (Array.isArray(rows)) {
    const cleanRows: Array<{ id: string; markers: string[] }> = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const rowId = row.id;
      const markers = new Set<string>();
      for (const candidate of [row.lastMessageId, row.newestEntryId]) {
        if (typeof candidate === "string" && candidate) markers.add(candidate);
      }
      const lastEntry = row.lastEntry;
      if (lastEntry && typeof lastEntry === "object") {
        for (const candidate of [lastEntry.id, lastEntry.requestId]) {
          if (typeof candidate === "string" && candidate) markers.add(candidate);
        }
      }
      if (typeof rowId === "string" && rowId) cleanRows.push({ id: rowId, markers: [...markers].sort() });
    }
    return { kind: "roster", rows: cleanRows };
  }

  const entries = value.entries;
  if (!Array.isArray(entries)) return { kind: "ignored" };

  interface DayBucket { turnIds: Set<string>; callIds: Set<string>; toolIds: Set<string>; timestamps: number[] }
  const days: Record<string, DayBucket> = {};
  const entryIds: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const raw = numberValue(entry.timestampMs);
    if (raw === null || raw <= 0) continue;
    const seconds = raw > 100_000_000_000 ? raw / 1000 : raw;
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) continue;
    const dayText = dayKey(date);
    const day = (days[dayText] ??= { turnIds: new Set(), callIds: new Set(), toolIds: new Set(), timestamps: [] });
    const entryId = typeof entry.id === "string" && entry.id ? entry.id : null;
    const stableId = entryId ?? `${file}:${index}:${Math.trunc(seconds * 1000)}`;
    if (entryId) entryIds.push(entryId);
    day.timestamps.push(seconds);
    const kind = entry.kind;
    if (kind === "message" && entry.role === "user") day.turnIds.add(stableId);
    if (kind === "send-message") {
      const requestId = typeof entry.requestId === "string" && entry.requestId ? entry.requestId : stableId;
      day.callIds.add(requestId);
      const message = entry.message;
      if (message && typeof message === "object" && message.type === "connector") day.toolIds.add(stableId);
    }
  }

  const cleanDays: Record<string, GrokBotDay> = {};
  for (const [dayText, day] of Object.entries(days)) {
    const timestamps = [...new Set(day.timestamps)].sort((a, b) => a - b);
    let duration = 0;
    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      if (gap > 0 && gap <= ACTIVE_GAP_SECONDS) duration += Math.trunc(gap);
    }
    cleanDays[dayText] = { turns: day.turnIds.size, calls: day.callIds.size, tools: day.toolIds.size, duration };
  }

  const markerIds = [...entryIds.slice(0, 4), ...entryIds.slice(-64)];
  // 首尾 entry 边界 = 同一份 transcript 的多个持久化键的稳定身份
  const fingerprint = crypto.createHash("sha256")
    .update(`${entryIds.length}\0${entryIds[0] ?? ""}\0${entryIds[entryIds.length - 1] ?? ""}`)
    .digest("hex");
  return {
    kind: "transcript",
    days: cleanDays,
    markers: [...new Set(markerIds)].sort(),
    fingerprint,
  };
}

export interface GrokBotRangeOut {
  in: number; out: number; sessions: number; calls: number; turns: number; tools: number; duration: number;
}

export interface GrokBotScanResult {
  ranges: Record<RangeKey, GrokBotRangeOut>;
  quota: null;
}

function emptyRanges(): Record<RangeKey, GrokBotRangeOut> {
  return Object.fromEntries(RANGE_KEYS.map((k) => [k, {
    // in/out 恒 0：快照没有 token 字段，未知不是零
    in: 0, out: 0, sessions: 0, calls: 0, turns: 0, tools: 0, duration: 0,
  }])) as Record<RangeKey, GrokBotRangeOut>;
}

interface CachedBlob extends Record<string, any> {
  sig: number[];
}

export function scanGrokBot(bounds: Bounds, cache: Record<string, any>): GrokBotScanResult {
  ledgerTouch("grok_bot");
  const fileCache: Record<string, CachedBlob> = (cache.grok_bot ??= {});
  const ranges = emptyRanges();
  const seen = new Set<string>();

  for (const rootDir of grokBotDirs()) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(rootDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".blob"))
        .map((e) => path.join(rootDir, e.name));
    } catch { /* 目录不可读 */ }
    for (const file of names.sort()) {
      let real: string;
      let stat: fs.Stats;
      try {
        real = fs.realpathSync(file);
        stat = fs.statSync(real);
      } catch {
        continue;
      }
      // 防符号链接逃逸出持久化目录（与 Python 的 commonpath 检查同义）
      if (!real.startsWith(rootDir + path.sep)) continue;
      seen.add(real);
      const signature = [stat.mtimeMs * 1000, stat.size].map(Math.trunc);
      const old = fileCache[real];
      if (old && old.sig && old.sig[0] === signature[0] && old.sig[1] === signature[1]) continue;
      const parsed = parseGrokBotBlob(real) as CachedBlob;
      parsed.sig = signature;
      fileCache[real] = parsed;
      cache._dirty = true;
    }
  }
  for (const stale of Object.keys(fileCache)) {
    if (!seen.has(stale)) {
      delete fileCache[stale];
      cache._dirty = true;
    }
  }

  const rosterRows: Array<{ id: string; markers: string[] }> = [];
  let transcripts: Array<[string, CachedBlob]> = [];
  for (const [file, entry] of Object.entries(fileCache)) {
    if (entry.kind === "roster") rosterRows.push(...(entry.rows || []));
    else if (entry.kind === "transcript") transcripts.push([file, entry]);
  }

  // 同一份 transcript 的多把持久化键合并成一条
  const unique = new Map<string, [string, CachedBlob]>();
  for (const [file, entry] of transcripts) {
    const fingerprint = entry.fingerprint || file;
    const current = unique.get(fingerprint);
    if (!current || ((entry.sig || [0])[0]) > ((current[1].sig || [0])[0])) unique.set(fingerprint, [file, entry]);
  }
  transcripts = [...unique.values()];

  const assigned = new Map<string, { id: string }>();
  const unusedRows = new Set(rosterRows.map((_, index) => index));
  for (const [file, entry] of transcripts) {
    const markers = new Set<string>(entry.markers || []);
    let match: number | undefined;
    for (const index of unusedRows) {
      if ((rosterRows[index].markers || []).some((marker) => markers.has(marker))) {
        match = index;
        break;
      }
    }
    if (match !== undefined) {
      assigned.set(file, rosterRows[match]);
      unusedRows.delete(match);
    }
  }
  if (transcripts.length === 1 && rosterRows.length === 1 && !assigned.has(transcripts[0][0])) {
    assigned.set(transcripts[0][0], rosterRows[0]);
  }

  // Set 不能进 JSON 缓存，所以先聚合再序列化
  const collected = Object.fromEntries(RANGE_KEYS.map((k) => [k, {
    sessions: new Set<string>(), calls: 0, turns: 0, tools: 0, duration: 0,
  }])) as Record<RangeKey, { sessions: Set<string>; calls: number; turns: number; tools: number; duration: number }>;

  for (const [file, entry] of transcripts) {
    const row = assigned.get(file);
    const sid = (row && row.id) || entry.fingerprint || file;
    if (entry.sid !== sid) {
      entry.sid = sid;
      delete entry.project;
      cache._dirty = true;
    }
    for (const [dayText, day] of Object.entries<GrokBotDay>(entry.days || {})) {
      for (const key of classifyDay(dayText, bounds)) {
        const bucket = collected[key];
        bucket.sessions.add(sid);
        bucket.calls += int(day.calls);
        bucket.turns += int(day.turns);
        bucket.tools += int(day.tools);
        bucket.duration += int(day.duration);
      }
    }
  }
  for (const key of RANGE_KEYS) {
    const bucket = collected[key];
    ranges[key].sessions = bucket.sessions.size;
    ranges[key].calls = bucket.calls;
    ranges[key].turns = bucket.turns;
    ranges[key].tools = bucket.tools;
    ranges[key].duration = bucket.duration;
  }
  return { ranges, quota: null };
}

function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

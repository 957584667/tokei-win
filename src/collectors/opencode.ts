/**
 * OpenCode 采集器：对应 usage.30s.py 的 scan_opencode / _scan_opencode_database /
 * _opencode_message_day / _opencode_v2_message 及路径发现函数。
 *
 * 数据源：opencode.db（V2 session_message 优先、V1 message 补漏），
 * 旧版回退 storage/message 下 ses_ 目录里的 msg_ 系列 JSON 文件；同一条消息（id）SQLite 优先不重计。
 * Windows 候选目录含 %APPDATA%\opencode、%LOCALAPPDATA%\opencode；
 * OPENCODE_DATA_DIR / TOKEI_OPENCODE_DATA_DIR / TOKEI_OPENCODE_DIR 可覆盖。
 * 口径：tokens.input/output/reasoning + tokens.cache.read/write 字段互相独立。
 * 成本优先消息自带 cost；缺失且能命中价表才估算；deepseek 官方渠道记人民币。
 * 历史账本已接 ledger_reconcile（日志被清的天用 ~/.tokei/ledger.json 回补）；项目桶已写进 day.projects（供项目足迹用，不进 payload）。
 */
import * as fs from "fs";
import * as path from "path";
import {
  APPDATA, HOME, LOCALAPPDATA, absoluteProjectPath, expandPath, existingDirs, firstExistingFile, pathCandidates,
} from "../core/paths";
import { listDirs, listFiles, readTextSafe } from "../core/fsutil";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey } from "../core/ranges";
import { ledgerReconcile, ledgerTouch } from "../core/ledger";
import { deepseekOfficialPrice, pricingId, rawPrice } from "../core/price";
import {
  Bucket, DayStat, PROJECT_BUCKETS_VERSION, ProjectBucket, TokenUsageRangeOut,
  addProjectUsage, addTokenUsage, emptyBuckets, emptyDay, mergeLiveDay, mergeTokenDay, tokenUsageRange,
} from "../core/model";
import { openReadonly, sqliteSignature } from "./zcode";

/** 对应 _OPENCODE_COST_CACHE_VERSION */
export const OPENCODE_COST_VERSION = 3;

export interface OpencodeDay extends DayStat {
  sessions: string[];
  projects?: Record<string, ProjectBucket>;
}

export type OpencodeMessage = OpencodeDay & { date: string; session: string };

export interface OpencodeScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
}

function int(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(Math.trunc(n), 0) : 0;
}

function baseDataDir(): string {
  // 对应 OPENCODE_DATA_DIR：注意用的是 OPENCODE_DATA_DIR 而非 TOKEI_ 前缀
  return expandPath(process.env.OPENCODE_DATA_DIR) || path.join(HOME, ".local", "share", "opencode");
}

function allDataDirs(): string[] {
  const base = baseDataDir();
  return pathCandidates(
    "TOKEI_OPENCODE_DATA_DIR", base,
    path.join(APPDATA, "opencode"), path.join(LOCALAPPDATA, "opencode"),
  );
}

/** 对应 _opencode_db_paths：主库优先，缺库时取第一个 channel 库 opencode-*.db */
export function opencodeDbPaths(): string[] {
  const dataDirs = allDataDirs();
  const baseDb = path.join(baseDataDir(), "opencode.db");
  const direct = [baseDb, ...dataDirs.map((root) => path.join(root, "opencode.db"))];
  const database = firstExistingFile(direct);
  if (database) return [fs.realpathSync(database)];
  for (const parent of [path.dirname(baseDb), ...dataDirs]) {
    const channels = listFiles(parent)
      .filter((f) => {
        const name = path.basename(f);
        if (!name.startsWith("opencode-") || !name.endsWith(".db")) return false;
        const channel = name.slice("opencode-".length, -".db".length);
        return channel.length > 0 && /^[A-Za-z0-9._-]+$/.test(channel);
      })
      .sort();
    if (channels.length) return [fs.realpathSync(channels[0])];
  }
  return [];
}

/** 对应 _opencode_json_dirs */
export function opencodeJsonDirs(): string[] {
  const base = baseDataDir();
  const defaults = [
    path.join(base, "storage", "message"),
    ...allDataDirs().map((root) => path.join(root, "storage", "message")),
  ];
  return existingDirs(pathCandidates("TOKEI_OPENCODE_DIR", ...defaults));
}

/** 对应 _opencode_message_day()：只有 assistant 且带时间戳才计数 */
export function opencodeMessageDay(
  message: Record<string, any>,
  sessionId = "",
  createdMs = 0,
  estimateMissingCost = false,
): OpencodeMessage | null {
  if (!message || message.role !== "assistant") return null;
  const timestamp = int((message.time ?? {}).created) || int(createdMs);
  if (!timestamp) return null;
  const tokens = message.tokens ?? {};
  const cache = tokens.cache ?? {};
  const model = String(message.modelID ?? "");
  const created = new Date(Number(timestamp) < 1e11 ? Number(timestamp) * 1000 : Number(timestamp));
  if (!Number.isFinite(created.getTime())) return null;
  let cost = Number(message.cost ?? 0) || 0;
  const inp = int(tokens.input);
  const out = int(tokens.output);
  const reason = int(tokens.reasoning);
  const cr = int(cache.read);
  const cw = int(cache.write);
  if (estimateMissingCost && !cost) {
    const priceId = pricingId(model);
    if (priceId) {
      const p = rawPrice(priceId);
      cost = (inp / 1e6) * p.in + ((out + reason) / 1e6) * p.out
        + (cr / 1e6) * p.cache_read + (cw / 1e6) * p.cache_write;
    }
  }
  let costCny = 0;
  const provider = message.providerID;
  if (provider === "deepseek" || provider === "deepseek-official") {
    const official = deepseekOfficialPrice(model, created);
    if (official) {
      costCny = (inp * official.in + (out + reason) * official.out
        + cr * official.cache_read + cw * official.cache_write) / 1e6;
      cost = 0;
    }
  }
  const day = Object.assign(emptyDay(), {
    date: dayKey(created),
    session: String(message.sessionID || sessionId || ""),
    sessions: [] as string[],
  }) as OpencodeMessage;
  day.hours[created.getHours()] = inp + out + cr + cw + reason;
  addTokenUsage(day as unknown as Bucket, inp, out, cr, cw, reason, cost, model || null, 0, costCny);
  return day;
}

/** 对应 _opencode_v2_message()：V2 形状转 V1 形状共用解析 */
export function opencodeV2Message(message: Record<string, any>, sessionId: string): Record<string, any> {
  const model = message.model;
  const converted: Record<string, any> = { ...message };
  converted.role = "assistant";
  converted.sessionID = message.sessionID || sessionId;
  if (model && typeof model === "object") {
    converted.modelID = message.modelID || model.id || "";
    converted.providerID = message.providerID || model.providerID;
  }
  return converted;
}

/** 对应 _opencode_database_messages + _scan_opencode_database：同时读 session/session_v2 的工作目录做逐项目桶 */
export function scanOpencodeDatabase(dbPath: string, estimateMissingCost = false): { days: Record<string, OpencodeDay>; messageIds: string[] } {
  const days: Record<string, OpencodeDay> = {};
  const messageIds = new Set<string>();
  let conn: ReturnType<typeof openReadonly>;
  try {
    conn = openReadonly(dbPath);
  } catch {
    return { days, messageIds: [] };
  }
  try {
    const tables = new Set((conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<Record<string, any>>).map((r) => String(r.name)));
    // 会话自带工作目录，让 OpenCode / MiMoCode 参与项目足迹；旧版把会话放在 session_v2
    const sessionProjects = new Map<string, string>();
    for (const table of ["session", "session_v2"]) {
      if (!tables.has(table)) continue;
      const cols = new Set((conn.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, any>>).map((r) => String(r.name)));
      if (!cols.has("id") || !cols.has("directory")) continue;
      try {
        // 表名是上面的字面量，不接受外部输入
        for (const row of conn.prepare(`SELECT id, directory FROM ${table}`).all() as Array<Record<string, any>>) {
          const project = absoluteProjectPath(row.directory);
          if (project && !sessionProjects.has(String(row.id))) sessionProjects.set(String(row.id), project);
        }
      } catch { /* 忽略 */ }
    }
    const emitted: Array<[unknown, string, number, Record<string, any>]> = [];
    if (tables.has("session_message")) {
      for (const row of conn.prepare(
        "SELECT id, session_id, time_created, data FROM session_message WHERE type = 'assistant'",
      ).all() as Array<Record<string, any>>) {
        let message: unknown;
        try { message = JSON.parse(String(row.data)); } catch { continue; }
        if (message && typeof message === "object") {
          emitted.push([row.id, String(row.session_id ?? ""), Number(row.time_created) || 0,
            opencodeV2Message(message as Record<string, any>, String(row.session_id ?? ""))]);
        }
      }
    }
    if (tables.has("message")) {
      for (const row of conn.prepare(
        "SELECT id, session_id, time_created, data FROM message",
      ).all() as Array<Record<string, any>>) {
        let message: unknown;
        try { message = JSON.parse(String(row.data)); } catch { continue; }
        if (message && typeof message === "object") {
          emitted.push([row.id, String(row.session_id ?? ""), Number(row.time_created) || 0,
            message as Record<string, any>]);
        }
      }
    }
    for (const [messageId, sessionId, createdMs, message] of emitted) {
      const idKey = messageId === null || messageId === undefined ? "" : String(messageId);
      if (idKey && messageIds.has(idKey)) continue;
      const day = opencodeMessageDay(message, sessionId, createdMs, estimateMissingCost);
      if (!day) continue;
      if (idKey) messageIds.add(idKey);
      const dk = day.date;
      delete (day as any).date;
      const target: OpencodeDay = (days[dk] ??= Object.assign(emptyDay(), { sessions: [] as string[] }));
      addTokenUsage(target as unknown as Bucket, day.in, day.out, day.cr, day.cw, day.reason, day.cost, null, day.credits, day.cost_cny);
      for (const [mn, mv] of Object.entries(day.models)) {
        const mm = (target.models[mn] ??= { in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0 });
        mm.in += mv.in; mm.out += mv.out; mm.cr += mv.cr; mm.cw += mv.cw; mm.reason += mv.reason;
        mm.cost += mv.cost; mm.cost_cny += mv.cost_cny;
      }
      day.hours.forEach((amount, h) => { target.hours[h] += amount; });
      if (day.session && !target.sessions.includes(day.session)) target.sessions.push(day.session);
      const project = sessionProjects.get(sessionId);
      if (project) {
        // 桶里只记美元成本，与 Python 一致：官方渠道的人民币成本留在模型明细里
        const modelTok: Record<string, number> = {};
        for (const [mn, mv] of Object.entries(day.models)) {
          modelTok[mn] = (modelTok[mn] ?? 0) + mv.in + mv.out + mv.cr + mv.cw + mv.reason;
        }
        addProjectUsage(target, project,
          day.in + day.out + day.cr + day.cw + day.reason, day.cost, modelTok,
          String(day.session || sessionId));
      }
    }
  } catch {
    // 表缺失/损坏：返回已读到的部分
  } finally {
    try { conn.close(); } catch { /* 忽略 */ }
  }
  return { days, messageIds: [...messageIds].sort() };
}

/** 对应 scan_opencode()：SQLite 优先，legacy JSON 只补 SQLite 没有的消息 */
export function scanOpencode(bounds: Bounds, cache: Record<string, any>): OpencodeScanResult {
  ledgerTouch("opencode");
  const fc: Record<string, any> = (cache.opencode ??= {});
  let changed = false;
  const buckets = emptyBuckets();

  const dbPaths = opencodeDbPaths();
  const jsonDirs = opencodeJsonDirs();
  if (!dbPaths.length && !jsonDirs.length) {
    if (Object.keys(fc).length) {
      for (const key of Object.keys(fc)) delete fc[key];
      cache._dirty = true;
    }
    return emptyResult(buckets);
  }

  const stale = new Set(Object.keys(fc));
  const dbMessageIds = new Set<string>();
  const liveDays: Record<string, OpencodeDay> = {};
  const liveSessions = new Map<string, Set<string>>();

  for (const dbPath of dbPaths) {
    const cacheKey = `db:${dbPath}`;
    stale.delete(cacheKey);
    const sig = sqliteSignature(dbPath);
    let entry = fc[cacheKey];
    if (!entry || entry.sig !== sig || entry.cost_version !== OPENCODE_COST_VERSION
      || entry.projects_version !== PROJECT_BUCKETS_VERSION) {
      try {
        const scanned = scanOpencodeDatabase(dbPath, true);
        entry = {
          sig, days: scanned.days, message_ids: scanned.messageIds, source: "sqlite",
          cost_version: OPENCODE_COST_VERSION, projects_version: PROJECT_BUCKETS_VERSION,
        };
        fc[cacheKey] = entry;
        changed = true;
      } catch {
        continue;
      }
    }
    for (const id of entry.message_ids ?? []) dbMessageIds.add(String(id));
    for (const [dk, day] of Object.entries<OpencodeDay>(entry.days ?? {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
      const agg = (liveDays[dk] ??= Object.assign(emptyDay(), { sessions: [] as string[] }));
      mergeLiveDay(agg, day);
      const set = liveSessions.get(dk) ?? new Set<string>();
      for (const s of day.sessions ?? []) set.add(s);
      liveSessions.set(dk, set);
    }
  }

  const seenMessageIds = new Set(dbMessageIds);
  for (const jsonDir of jsonDirs) {
    for (const sessDir of listDirs(jsonDir).filter((d) => path.basename(d).startsWith("ses_"))) {
      for (const file of listFiles(sessDir).filter((f) => /^msg_.*\.json$/.test(path.basename(f)))) {
        const fileId = path.basename(file, ".json");
        if (seenMessageIds.has(fileId)) continue;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        const sig = `${stat.mtimeMs}:${stat.size}`;
        const entry = fc[file];
        let dayData: ReturnType<typeof opencodeMessageDay>;
        let messageId: string;
        if (entry && entry.sig === sig && entry.cost_version === OPENCODE_COST_VERSION) {
          dayData = entry.day;
          messageId = String(entry.message_id || fileId);
        } else {
          let parsed: unknown;
          const text = readTextSafe(file);
          try { parsed = text === null ? null : JSON.parse(text); } catch { continue; }
          if (!parsed || typeof parsed !== "object") continue;
          messageId = String((parsed as Record<string, any>).id || fileId);
          if (seenMessageIds.has(messageId)) continue;
          dayData = opencodeMessageDay(parsed as Record<string, any>, "", 0, true);
          fc[file] = { sig, day: dayData, message_id: messageId, cost_version: OPENCODE_COST_VERSION };
          changed = true;
        }
        if (seenMessageIds.has(messageId)) continue;
        seenMessageIds.add(messageId);
        stale.delete(file);
        if (!dayData) continue;
        const dk = (dayData as any).date as string;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
        const agg = (liveDays[dk] ??= Object.assign(emptyDay(), { sessions: [] as string[] }));
        const copy: Partial<OpencodeDay> = { ...dayData };
        delete (copy as any).date;
        mergeLiveDay(agg, copy);
        const set = liveSessions.get(dk) ?? new Set<string>();
        if (dayData.session !== "" && dayData.session !== undefined) set.add(String(dayData.session));
        liveSessions.set(dk, set);
      }
    }
  }

  for (const key of stale) {
    delete fc[key];
    changed = true;
  }

  // 会话数只来自现存记录（账本合并点：Python 在此处 reconcile）
  for (const [dk, day] of Object.entries(liveDays)) {
    day.sessions = [...(liveSessions.get(dk) ?? [])].sort();
    for (const rk of classifyDay(dk, bounds)) {
      mergeTokenDay(buckets[rk], day);
      for (const s of day.sessions) buckets[rk].sessions.add(s);
    }
  }

  if (changed) cache._dirty = true;
  return emptyResult(buckets);
}

function emptyResult(buckets: Record<RangeKey, Bucket>): OpencodeScanResult {
  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])])) as Record<RangeKey, TokenUsageRangeOut>,
  };
}

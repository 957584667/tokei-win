/**
 * QoderWork 采集器：对应 usage.30s.py 的 scan_qoder（口径见 §1 表 QoderWork）。
 * SQLite agents.db：messages.metadata 含 durationMs/numTurns，sub_chats.ext 含上下文快照。
 * 另按 CALCULATION.md §5「Qoder(credit)」从 main.log 提取 userQuota
 * （totalCredits / usedCredits / isQuotaExceeded）——Python 侧仅有规范、无实现，此处按规范落地。
 *
 * 关键口径：
 * - 只统计 role='assistant' 且 metadata!='{}' 的行：user 行也可能带 metadata，会虚增任务数。
 * - metadata 的 inputTokens/outputTokens 目前全为 0，只有 durationMs/contextUsageRatio 有值，
 *   不估算（§1「Qoder」）。
 * - 历史账本已接 ledger_reconcile（DB 里被清掉的天用 ~/.tokei/ledger.json 回补）。
 */
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { APPDATA, HOME, LOCALAPPDATA, firstExistingFile, isFile, pathCandidates } from "../core/paths";
import { forEachLine, listDirs } from "../core/fsutil";
import { Bounds, RANGE_KEYS, RangeKey, classifyDay } from "../core/ranges";
import { ledgerReconcile, ledgerTouch } from "../core/ledger";
import { qoderworkRange } from "../core/model";

// node:sqlite 在 Node 22 是实验内置模块、不在 builtinModules 清单里，
// vitest/vite 的静态导入解析会失败，故运行时经 createRequire 获取构造器
const { DatabaseSync: DatabaseSyncCtor } = createRequire(path.join(process.cwd(), "noop.cjs"))("node:sqlite") as typeof import("node:sqlite");

/** 对应 _QODER_DB / QODER_DB_PATHS（Windows 期望 %APPDATA%\QoderWork\data\agents.db） */
export function qoderWorkDbPath(): string | null {
  return firstExistingFile(pathCandidates(
    "TOKEI_QODER_DB",
    path.join(HOME, "Library", "Application Support", "QoderWork", "data", "agents.db"),
    path.join(APPDATA, "QoderWork", "data", "agents.db"),
    path.join(LOCALAPPDATA, "QoderWork", "data", "agents.db"),
  ));
}

/** main.log 定位：Electron 日志按运行目录分桶，取最近修改的一份 */
export function qoderWorkLogPath(): string | null {
  const direct = firstExistingFile(pathCandidates("TOKEI_QODERWORK_LOG"));
  if (direct) return direct;
  const env = process.env.TOKEI_QODERWORK_LOG;
  if (env) return null; // 显式配置但不存在时不再回退默认目录
  const logDirs = [
    path.join(APPDATA, "QoderWork", "logs"),
    path.join(LOCALAPPDATA, "QoderWork", "logs"),
    path.join(HOME, "Library", "Application Support", "QoderWork", "logs"),
  ];
  for (const dir of logDirs) {
    if (!fs.existsSync(dir)) continue;
    const files: string[] = [];
    if (isFile(path.join(dir, "main.log"))) files.push(path.join(dir, "main.log"));
    for (const sub of listDirs(dir)) {
      const f = path.join(sub, "main.log");
      if (isFile(f)) files.push(f);
    }
    if (!files.length) continue;
    files.sort((a, b) => {
      try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
    });
    return files[0];
  }
  return null;
}

export interface QoderWorkQuota {
  totalCredits: number | null;
  usedCredits: number | null;
  isQuotaExceeded: boolean;
}

function numFrom(text: string, field: string): number | null {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return m ? Number(m[1]) : null;
}

/** 对应 §5：日志可能被并发追加，取最后一条 userQuota（后写覆盖先写） */
export function scanQoderWorkQuota(logFile: string): QoderWorkQuota | null {
  let last: string | null = null;
  forEachLine(logFile, (line) => {
    if (line.includes("userQuota")) last = line;
  });
  if (!last) return null;
  const total = numFrom(last, "totalCredits");
  const used = numFrom(last, "usedCredits");
  const exceeded = /"isQuotaExceeded"\s*:\s*true/.test(last);
  if (total === null && used === null && !exceeded) return null;
  return { totalCredits: total, usedCredits: used, isQuotaExceeded: exceeded };
}

/** 对应 _sqlite_signature：db 与 -wal 的 mtime+size；SHM 会被只读连接刷新，故排除 */
function sqliteSignature(db: string): string | null {
  const parts: string[] = [];
  for (const candidate of [db, `${db}-wal`]) {
    try {
      const st = fs.statSync(candidate);
      parts.push(`${candidate}:${st.mtimeMs}:${st.size}`);
    } catch { /* 不存在则跳过 */ }
  }
  return parts.length ? parts.join("|") : null;
}

interface QoderWorkDay {
  calls: number; sessions: number; in: number; out: number;
  duration: number; turns: number; ctx_ratio: number; hours: number[];
  sub_agents?: number;
}

function queryDb(db: string): { days: Record<string, QoderWorkDay>; subChatDays: Record<string, number>; model: string | null } {
  const days: Record<string, QoderWorkDay> = {};
  const subChatDays: Record<string, number> = {};
  let model: string | null = null;
  let conn: DatabaseSync | null = null;
  try {
    conn = new DatabaseSyncCtor(db, { readOnly: true });
    conn.exec("PRAGMA query_only=ON");
    for (const row of conn.prepare(`
      SELECT date(created_at,'unixepoch','localtime') as day,
             COUNT(*) as calls,
             COUNT(DISTINCT chat_id) as sessions,
             COALESCE(SUM(json_extract(metadata,'$.inputTokens')),0) as ti,
             COALESCE(SUM(json_extract(metadata,'$.outputTokens')),0) as to_,
             COALESCE(SUM(json_extract(metadata,'$.durationMs')),0) as dur,
             COALESCE(SUM(json_extract(metadata,'$.numTurns')),0) as turns
      FROM messages WHERE metadata!='{}' AND role='assistant'
      GROUP BY day`).all() as any[]) {
      const dk = row.day as string;
      if (!dk) continue;
      days[dk] = {
        calls: Math.trunc(Number(row.calls) || 0),
        sessions: Math.trunc(Number(row.sessions) || 0),
        in: Math.trunc(Number(row.ti) || 0), out: Math.trunc(Number(row.to_) || 0),
        duration: Math.trunc(Number(row.dur) || 0), turns: Math.trunc(Number(row.turns) || 0),
        ctx_ratio: 0, hours: new Array(24).fill(0),
      };
    }
    for (const row of conn.prepare(`
      SELECT date(created_at,'unixepoch','localtime') as day,
             CAST(strftime('%H',created_at,'unixepoch','localtime') AS INTEGER) as hour,
             COALESCE(SUM(json_extract(metadata,'$.inputTokens')),0) +
             COALESCE(SUM(json_extract(metadata,'$.outputTokens')),0) as tokens
      FROM messages WHERE metadata!='{}' AND role='assistant'
      GROUP BY day, strftime('%H',created_at,'unixepoch','localtime')`).all() as any[]) {
      const day = days[row.day as string];
      if (day && row.hour != null) day.hours[Math.trunc(Number(row.hour))] += Math.trunc(Number(row.tokens) || 0);
    }
    for (const row of conn.prepare(`
      SELECT date(created_at,'unixepoch','localtime') as day,
             AVG(CASE WHEN json_extract(ext,'$.contextUsageSnapshot.percentage')>0
                      THEN json_extract(ext,'$.contextUsageSnapshot.percentage') END) as ctx_pct
      FROM sub_chats WHERE ext IS NOT NULL AND ext != '{}'
      GROUP BY day`).all() as any[]) {
      const dk = row.day as string;
      if (dk && row.ctx_pct && days[dk]) days[dk].ctx_ratio = Number(row.ctx_pct);
    }
    for (const row of conn.prepare(`
      SELECT date(created_at,'unixepoch','localtime') as day, COUNT(*) as n
      FROM sub_chats WHERE created_at IS NOT NULL
      GROUP BY day`).all() as any[]) {
      if (row.day) subChatDays[row.day as string] = Math.trunc(Number(row.n) || 0);
    }
    const mrow = conn.prepare(
      "SELECT value FROM app_settings WHERE key='modelLevel'").get() as any;
    // 对应 Python 的 value.strip('"')
    if (mrow && mrow.value != null) model = String(mrow.value).replace(/^"+|"+$/g, "");
  } catch { /* 表缺失/被锁：返回已收集部分，与 Python 一致 */ } finally {
    try { conn?.close(); } catch { /* 忽略 */ }
  }
  return { days, subChatDays, model };
}

function emptyRanges(): Record<RangeKey, ReturnType<typeof qoderworkRange>> {
  return Object.fromEntries(RANGE_KEYS.map((k) => [k, qoderworkRange({})])) as any;
}

export interface QoderWorkScanResult {
  ranges: Record<RangeKey, ReturnType<typeof qoderworkRange>>;
  model: string | null;
  quota: QoderWorkQuota | null;
  days: Record<string, QoderWorkDay>;
}

/** 对应 _empty_qoder() */
export function emptyQoderWork(): QoderWorkScanResult {
  return { ranges: emptyRanges(), model: null, quota: null, days: {} };
}

/** 对应 scan_qoder(bounds, cache)。cache 键用 qoderwork（Python 内部键为 qoder，输出键为 qoderwork） */
export function scanQoderWork(bounds: Bounds, cache: Record<string, any>): QoderWorkScanResult {
  ledgerTouch("qoderwork");
  const fc: Record<string, any> = (cache.qoderwork ??= {});
  let changed = false;

  // --- Part 1: agents.db（整组查询按 sig 缓存） ---
  let dbDays: Record<string, QoderWorkDay> = {};
  let subChatDays: Record<string, number> = {};
  let model: string | null = null;
  const db = qoderWorkDbPath();
  if (db) {
    const sqliteSig = sqliteSignature(db);
    const sig = sqliteSig ? `${(() => { try { return fs.realpathSync(db); } catch { return db; } })()}|${sqliteSig}` : null;
    const entry = fc.db;
    if (sig && (!entry || entry.sig !== sig)) {
      const parsed = queryDb(db);
      dbDays = parsed.days;
      subChatDays = parsed.subChatDays;
      model = parsed.model;
      fc.db = { sig, days: dbDays, sub_chat_days: subChatDays, model };
      changed = true;
    } else {
      dbDays = (entry || {}).days || {};
      subChatDays = (entry || {}).sub_chat_days || {};
      model = (entry || {}).model ?? null;
    }
  } else if (fc.db) {
    delete fc.db;
    changed = true;
  }

  // --- Part 2: main.log 的 userQuota（按 sig 缓存） ---
  let quota: QoderWorkQuota | null = null;
  const logFile = qoderWorkLogPath();
  if (logFile) {
    let logSig = "";
    try {
      const st = fs.statSync(logFile);
      logSig = `${st.mtimeMs}:${st.size}`;
    } catch { /* 读不到就跳过 */ }
    if (logSig && fc.quota?.sig !== logSig) {
      quota = scanQoderWorkQuota(logFile);
      fc.quota = { sig: logSig, quota };
      changed = true;
    } else {
      quota = fc.quota?.quota ?? null;
    }
  } else if (fc.quota) {
    delete fc.quota;
    changed = true;
  }

  // --- 汇总 ---
  const B = Object.fromEntries(RANGE_KEYS.map((k) => [k, {
    in: 0, out: 0, sessions: 0, calls: 0, sub_agents: 0, duration: 0, turns: 0, ctx_sum: 0, ctx_count: 0,
  }])) as Record<RangeKey, any>;

  // sub_chats 计数并入 day，连同会话计数一起进账本（天级整取整用）
  const liveDays: Record<string, QoderWorkDay> = {};
  for (const [dk, day] of Object.entries(dbDays)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
    liveDays[dk] = { ...day, sub_agents: Math.trunc(Number(subChatDays[dk] || 0) || 0) };
  }

  // 天级高水位对账：DB 里被清掉的日行用 ~/.tokei/ledger.json 的快照兜底
  for (const [dk, day] of Object.entries(ledgerReconcile("qoderwork", liveDays) as Record<string, QoderWorkDay>)) {
    const ks = classifyDay(dk, bounds);
    if (!ks.length) continue;
    const calls = day.calls || 0;
    const ctxRatio = Number(day.ctx_ratio) || 0;
    for (const k of ks) {
      const b = B[k];
      b.in += day.in || 0;
      b.out += day.out || 0;
      b.sessions += day.sessions || 0;
      b.calls += calls;
      b.sub_agents += day.sub_agents || 0;
      b.duration += day.duration || 0;
      b.turns += day.turns || 0;
      if (ctxRatio > 0) {
        b.ctx_sum += ctxRatio * calls;
        b.ctx_count += calls;
      }
    }
  }

  if (changed) cache._dirty = true;
  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, qoderworkRange(B[k])])) as any,
    model,
    quota,
    days: liveDays,
  };
}

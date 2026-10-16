/**
 * Qoder Desktop 采集器：对应 usage.30s.py 的 scan_qoder_ide（口径见 §1 表 Qoder Desktop）。
 * SQLite local.db 的 chat_message 表：token_info/model_info 为 JSON 明文，gmt_create 毫秒时间戳。
 *
 * 关键口径（CALCULATION.md §1「Qoder」）：
 * - 现阶段 inputTokens/outputTokens 全为 0，只有 durationMs 与 contextUsageRatio 有值；
 *   仍照实查询 token_info，绝不估算补数——数字必须诚实。
 * - cached 是 in(prompt_tokens) 的子集：输出 in = max(in - cached, 0)，ctx = cached/in 命中率。
 * - Python 端默认关闭，需 ~/.tokei/config.json 的 qoder_ide_enabled；Windows 下另加
 *   TOKEI_QODER_IDE_ENABLED=1 供采集器单测直接启用（同 TOKEI_* 家族口径）。
 * - 历史账本已接 ledger_reconcile（日志被清的天用 ~/.tokei/ledger.json 回补）。
 */
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { APPDATA, HOME, LOCALAPPDATA, TOKEI_DIR, firstExistingFile, loadJson, pathCandidates } from "../core/paths";
import { Bounds, RANGE_KEYS, RangeKey, classifyDay } from "../core/ranges";
import { ledgerReconcile, ledgerTouch } from "../core/ledger";
import { qoderRange } from "../core/model";

// node:sqlite 在 Node 22 是实验内置模块、不在 builtinModules 清单里，
// vitest/vite 的静态导入解析会失败，故运行时经 createRequire 获取构造器
const { DatabaseSync: DatabaseSyncCtor } = createRequire(path.join(process.cwd(), "noop.cjs"))("node:sqlite") as typeof import("node:sqlite");

/** 对应 QODER_IDE_DB / QODER_IDE_DB_PATHS（Windows 期望 %APPDATA%\Qoder\SharedClientCache\cache\db\local.db） */
export function qoderDesktopDbPath(): string | null {
  return firstExistingFile(pathCandidates(
    "TOKEI_QODER_IDE_DB",
    path.join(HOME, "Library", "Application Support", "Qoder", "SharedClientCache", "cache", "db", "local.db"),
    path.join(APPDATA, "Qoder", "SharedClientCache", "cache", "db", "local.db"),
    path.join(LOCALAPPDATA, "Qoder", "SharedClientCache", "cache", "db", "local.db"),
  ));
}

/** 对应 _USER_DIR/config.json 的 qoder_ide_enabled 开关 */
export function qoderDesktopEnabled(): boolean {
  const env = process.env.TOKEI_QODER_IDE_ENABLED;
  if (env) return /^(1|true|yes)$/i.test(env.trim());
  return loadJson<Record<string, any>>(path.join(TOKEI_DIR, "config.json"), {}).qoder_ide_enabled === true;
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

interface QoderIdeDay {
  in: number; out: number; cached: number;
  session_ids: string[]; sub_agent_ids: string[];
  calls: number; messages: number; duration: number; hours: number[];
}

interface QoderIdeDbEntry {
  sig: string;
  days: Record<string, QoderIdeDay>;
  model: string | null;
}

function queryDays(db: string): QoderIdeDbEntry {
  const days: Record<string, QoderIdeDay> = {};
  let latestModel: string | null = null;
  let conn: DatabaseSync | null = null;
  try {
    conn = new DatabaseSyncCtor(db, { readOnly: true });
    conn.exec("PRAGMA query_only=ON");
    for (const row of conn.prepare(`
      SELECT date(gmt_create/1000, 'unixepoch', 'localtime') as day,
             COALESCE(SUM(json_extract(token_info, '$.prompt_tokens')), 0) as ti,
             COALESCE(SUM(json_extract(token_info, '$.completion_tokens')), 0) as to_,
             COALESCE(SUM(json_extract(token_info, '$.cached_tokens')), 0) as cached,
             COUNT(DISTINCT request_id) as calls,
             COUNT(*) as msgs
      FROM chat_message
      WHERE token_info IS NOT NULL AND token_info != ''
      GROUP BY day`).all() as any[]) {
      const dk = row.day as string;
      if (!dk) continue;
      days[dk] = {
        in: Math.trunc(Number(row.ti) || 0), out: Math.trunc(Number(row.to_) || 0),
        cached: Math.trunc(Number(row.cached) || 0),
        session_ids: [], sub_agent_ids: [],
        calls: Math.trunc(Number(row.calls) || 0), messages: Math.trunc(Number(row.msgs) || 0),
        duration: 0, hours: new Array(24).fill(0),
      };
    }
    for (const row of conn.prepare(`
      SELECT date(gmt_create/1000, 'unixepoch', 'localtime') as day,
             CAST(strftime('%H', gmt_create/1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
             COALESCE(SUM(json_extract(token_info, '$.prompt_tokens')), 0) +
             COALESCE(SUM(json_extract(token_info, '$.completion_tokens')), 0) as tokens
      FROM chat_message
      WHERE token_info IS NOT NULL AND token_info != ''
      GROUP BY day, strftime('%H', gmt_create/1000, 'unixepoch', 'localtime')`).all() as any[]) {
      const day = days[row.day as string];
      if (day && row.hour != null) day.hours[Math.trunc(Number(row.hour))] += Math.trunc(Number(row.tokens) || 0);
    }
    // 子代理会话集合：chat_session 可能不存在（旧库），失败时按无子代理处理
    const subAgentSids = new Set<string>();
    try {
      for (const row of conn.prepare(
        "SELECT session_id FROM chat_session WHERE session_type LIKE 'agent_sub_%'").all() as any[]) {
        if (row.session_id != null) subAgentSids.add(String(row.session_id));
      }
    } catch { /* 忽略 */ }
    for (const row of conn.prepare(`
      SELECT date(gmt_create/1000, 'unixepoch', 'localtime') as day, session_id
      FROM chat_message
      WHERE token_info IS NOT NULL AND token_info != ''
      GROUP BY day, session_id`).all() as any[]) {
      const dk = row.day as string;
      const day = dk ? days[dk] : undefined;
      const sid = row.session_id;
      if (day && sid) {
        if (subAgentSids.has(String(sid))) day.sub_agent_ids.push(String(sid));
        else day.session_ids.push(String(sid));
      }
    }
    // 时长 = 每个多消息请求的首尾时间跨度之和（秒）
    for (const row of conn.prepare(`
      SELECT date(min_ts/1000, 'unixepoch', 'localtime') as day,
             SUM(max_ts - min_ts) / 1000 as dur_sec
      FROM (SELECT request_id, MIN(gmt_create) as min_ts, MAX(gmt_create) as max_ts
            FROM chat_message GROUP BY request_id HAVING COUNT(*) > 1) sub
      GROUP BY day`).all() as any[]) {
      const dk = row.day as string;
      if (dk && days[dk]) days[dk].duration = Math.trunc(Number(row.dur_sec) || 0);
    }
    const mrow = conn.prepare(`
      SELECT json_extract(model_info, '$.model_key') as k FROM chat_message
      WHERE model_info IS NOT NULL AND model_info != ''
      ORDER BY gmt_create DESC LIMIT 1`).get() as any;
    if (mrow && mrow.k) latestModel = String(mrow.k);
  } catch { /* DB 被占用或表缺失：与 Python 一样吞异常、返回已收集部分 */ } finally {
    try { conn?.close(); } catch { /* 忽略 */ }
  }
  return { sig: "", days, model: latestModel };
}

function emptyRanges(): Record<RangeKey, ReturnType<typeof qoderRange>> {
  return Object.fromEntries(RANGE_KEYS.map((k) => [k, qoderRange({})])) as any;
}

export interface QoderDesktopScanResult {
  ranges: Record<RangeKey, ReturnType<typeof qoderRange>>;
  model: string | null;
  days: Record<string, QoderIdeDay>;
}

/** 对应 _empty_qoder_ide() */
export function emptyQoderDesktop(): QoderDesktopScanResult {
  return { ranges: emptyRanges(), model: null, days: {} };
}

/** 对应 scan_qoder_ide(bounds, cache) */
export function scanQoderDesktop(bounds: Bounds, cache: Record<string, any>): QoderDesktopScanResult {
  const fc: Record<string, any> = (cache.qoder_ide ??= {});

  const clear = () => {
    if (Object.keys(fc).length) {
      for (const k of Object.keys(fc)) delete fc[k];
      cache._dirty = true;
    }
    return emptyQoderDesktop();
  };

  // 默认关闭：未启用时绝不触碰缓存与账本
  if (!qoderDesktopEnabled()) return clear();
  ledgerTouch("qoder_ide");
  const db = qoderDesktopDbPath();
  if (!db) return clear();

  const sqliteSig = sqliteSignature(db);
  if (!sqliteSig) return emptyQoderDesktop();
  let realpath = db;
  try { realpath = fs.realpathSync(db); } catch { /* 保持原路径 */ }
  const sig = `${realpath}|${sqliteSig}`;

  let entry = fc.data as QoderIdeDbEntry & { sig: string } | undefined;
  if (!entry || entry.sig !== sig) {
    const parsed = queryDays(db);
    entry = { sig, days: parsed.days, model: parsed.model };
    fc.data = entry;
    cache._dirty = true;
  }

  const B = Object.fromEntries(RANGE_KEYS.map((k) => [k, {
    in: 0, out: 0, cached: 0, sessions: 0, sub_agents: 0, calls: 0, messages: 0, duration: 0,
  }])) as Record<RangeKey, any>;
  const sessionSets = Object.fromEntries(RANGE_KEYS.map((k) => [k, new Set<string>()])) as Record<RangeKey, Set<string>>;
  const subAgentSets = Object.fromEntries(RANGE_KEYS.map((k) => [k, new Set<string>()])) as Record<RangeKey, Set<string>>;

  // 天级高水位对账：DB 里被清掉的日行用 ~/.tokei/ledger.json 的快照兜底
  const reconciled = ledgerReconcile("qoder_ide", entry.days ?? {}) as Record<string, QoderIdeDay>;
  for (const [dk, day] of Object.entries(reconciled)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
    for (const k of classifyDay(dk, bounds)) {
      const b = B[k];
      b.in += day.in || 0;
      b.out += day.out || 0;
      b.cached += day.cached || 0;
      b.calls += day.calls || 0;
      b.messages += day.messages || 0;
      b.duration += day.duration || 0;
      for (const sid of day.session_ids || []) sessionSets[k].add(sid);
      for (const sid of day.sub_agent_ids || []) subAgentSets[k].add(sid);
    }
  }
  // sessions/sub_agents 用 set 去重，避免跨天会话被多算
  for (const k of RANGE_KEYS) {
    B[k].sessions = sessionSets[k].size;
    B[k].sub_agents = subAgentSets[k].size;
  }

  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, qoderRange(B[k])])) as any,
    model: entry.model ?? null,
    days: entry.days || {},
  };
}

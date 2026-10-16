/**
 * ZCode 采集器：对应 usage.30s.py 的 scan_zcode / _scan_zcode_database。
 * SQLite: ~/.zcode/cli/db/db.sqlite（TOKEI_ZCODE_DB 可覆盖），model_usage 逐请求明细。
 *
 * 口径：input_tokens 含缓存（减出 fresh input），output_tokens 含 reasoning（减出 visible output）；
 * 成本先按家族回退价估算，最终由 recalcCosts(zcode 在 RECALC_TOOLS) 统一重算。
 * 历史账本已接 ledger_reconcile：库行被清后用 ~/.tokei/ledger.json 的日快照回补。
 */
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

// vitest/vite 的内置模块表没有 sqlite，静态 import 会被当成裸模块解析失败；
// 运行时经 createRequire 加载（tsc 出的是 CJS，同样正常），类型走 import type。
const nodeRequire = createRequire(typeof __filename === "string" ? __filename : path.join(process.cwd(), "noop.js"));
const sqlite = nodeRequire("node:sqlite") as typeof import("node:sqlite");
import { HOME, expandPath, isFile } from "../core/paths";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey } from "../core/ranges";
import { pricingId, rawPrice, knownIdOrRaw } from "../core/price";
import { ledgerReconcile, ledgerTouch } from "../core/ledger";
import {
  Bucket, DayStat, TokenUsageRangeOut, addTokenUsage, emptyBuckets, emptyDay,
  tokenUsageRange,
} from "../core/model";

const ZCODE_SCAN_VERSION = 1;

/** 对应 ZCODE_DB：env 在调用时读取，便于测试注入 */
export function zcodeDbPath(): string {
  return (
    expandPath(process.env.TOKEI_ZCODE_DB) ||
    path.resolve(path.join(HOME, ".zcode", "cli", "db", "db.sqlite"))
  );
}

export interface ZcodeDay extends DayStat {
  sessions: string[];
}

export interface ZcodeScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
}

function int(v: unknown): number {
  // 对应 Python number()：max(int(value or 0), 0)
  if (v === null || v === undefined || v === false) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(Math.trunc(n), 0) : 0;
}

/** 对应 _sqlite_signature：db 与 -wal 的 mtime(纳秒)+size；SHM 不参与（只读连接会刷新它） */
export function sqliteSignature(dbPath: string): string {
  const parts: string[] = [];
  for (const candidate of [dbPath, `${dbPath}-wal`]) {
    try {
      const st = fs.statSync(candidate, { bigint: true });
      parts.push(`${candidate}:${st.mtimeMs}:${st.size}`);
    } catch {
      /* 侧文件不存在时跳过，与 Python 一致 */
    }
  }
  return parts.join("|");
}

export function openReadonly(dbPath: string): DatabaseSync {
  // 对应 sqlite3.connect(ro_uri, uri=True, timeout=1)：绝不写库、绝不锁库
  return new sqlite.DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: false, timeout: 1000 });
}

/** 对应 _scan_zcode_database() */
export function scanZcodeDatabase(dbPath: string): Record<string, ZcodeDay> {
  const days: Record<string, ZcodeDay> = {};
  const conn = openReadonly(dbPath);
  try {
    const rows = conn.prepare(`
      SELECT id, session_id, model_id, input_tokens, output_tokens,
             reasoning_tokens, cache_creation_input_tokens,
             cache_read_input_tokens, started_at, completed_at
      FROM model_usage
      ORDER BY started_at ASC
    `).all() as Array<Record<string, any>>;
    for (const row of rows) {
      const timestampMs = int(row.completed_at) || int(row.started_at);
      if (!timestampMs) continue;
      const created = new Date(timestampMs);
      if (!Number.isFinite(created.getTime())) continue;
      const inputTotal = int(row.input_tokens);
      const outputTotal = int(row.output_tokens);
      const reasoning = int(row.reasoning_tokens);
      const cacheWrite = int(row.cache_creation_input_tokens);
      const cacheRead = int(row.cache_read_input_tokens);
      const freshInput = Math.max(inputTotal - cacheRead - cacheWrite, 0);
      const visibleOutput = Math.max(outputTotal - reasoning, 0);
      if (freshInput + outputTotal + cacheRead + cacheWrite <= 0) continue;
      const displayModel = knownIdOrRaw(row.model_id) || String(row.model_id ?? "unknown");
      // 估算成本仅缓存期展示用；recalcCosts 会按 canonical id 重算
      let cost = 0;
      const priceId = pricingId(row.model_id);
      if (priceId) {
        const p = rawPrice(priceId);
        cost = (freshInput / 1e6) * p.in + (outputTotal / 1e6) * p.out
          + (cacheRead / 1e6) * p.cache_read + (cacheWrite / 1e6) * p.cache_write;
      }
      const dk = dayKey(created);
      const day: ZcodeDay = (days[dk] ??= Object.assign(emptyDay(), { sessions: [] as string[] }));
      addTokenUsage(day as unknown as Bucket, freshInput, visibleOutput, cacheRead, cacheWrite, reasoning, cost, displayModel);
      day.hours[created.getHours()] += freshInput + outputTotal + cacheRead + cacheWrite;
      const session = String(row.session_id ?? row.id ?? "unknown");
      if (!day.sessions.includes(session)) day.sessions.push(session);
    }
  } finally {
    try { conn.close(); } catch { /* 忽略 */ }
  }
  return days;
}

/** 对应 scan_zcode()（去掉 ledger_reconcile，账本余额合并留待后续里程碑） */
export function scanZcode(bounds: Bounds, cache: Record<string, any>): ZcodeScanResult {
  ledgerTouch("zcode");
  const fc: Record<string, any> = (cache.zcode ??= {});
  const buckets = emptyBuckets();
  const dbPath = zcodeDbPath();

  if (!isFile(dbPath)) {
    if (Object.keys(fc).length) {
      for (const key of Object.keys(fc)) delete fc[key];
      cache._dirty = true;
    }
    return { ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])])) as Record<RangeKey, TokenUsageRangeOut> };
  }

  const real = fs.realpathSync(dbPath);
  const cacheKey = `db:${real}`;
  const sig = sqliteSignature(dbPath);
  let entry = fc[cacheKey];
  if (!entry || entry.sig !== sig || entry.version !== ZCODE_SCAN_VERSION) {
    entry = { sig, days: scanZcodeDatabase(dbPath), version: ZCODE_SCAN_VERSION };
    for (const key of Object.keys(fc)) delete fc[key];
    fc[cacheKey] = entry;
    cache._dirty = true;
  }

  // 天级高水位对账：库里被清掉的日行用账本快照兜底
  const reconciled = ledgerReconcile("zcode", entry.days ?? {}) as Record<string, ZcodeDay>;
  for (const [dk, day] of Object.entries<ZcodeDay>(reconciled)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
    for (const rk of classifyDay(dk, bounds)) {
      const b = buckets[rk];
      addTokenUsage(b, day.in, day.out, day.cr, day.cw, day.reason, day.cost, null, day.credits, day.cost_cny);
      for (const [mn, mv] of Object.entries(day.models ?? {})) {
        const mm = (b.models[mn] ??= { in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, credits: 0, cost_cny: 0 });
        mm.in += mv.in; mm.out += mv.out; mm.cr += mv.cr; mm.cw += mv.cw; mm.reason += mv.reason; mm.cost += mv.cost;
      }
      for (const s of day.sessions ?? []) b.sessions.add(s);
    }
  }

  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])])) as Record<RangeKey, TokenUsageRangeOut>,
  };
}

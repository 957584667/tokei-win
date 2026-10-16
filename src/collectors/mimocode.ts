/**
 * MiMoCode 采集器：对应 usage.30s.py 的 scan_mimocode / _mimocode_data_dirs / _mimocode_db_paths。
 * 数据是 OpenCode 兼容的 message 表，解析直接复用 opencode 的库扫描。
 * 目录规则：TOKEI_MIMOCODE_DB 直指库；MIMOCODE_HOME → <home>/data；
 * XDG_DATA_HOME → $XDG_DATA_HOME/mimocode；Windows 默认 %LOCALAPPDATA%\mimocode 优先，
 * 其次 %APPDATA%\mimocode（与 test_windows_paths.py 的 nt 顺序一致）。
 * 历史账本已接 ledger_reconcile（库行被清后用 ~/.tokei/ledger.json 回补）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { APPDATA, HOME, LOCALAPPDATA, expandPath, isFile } from "../core/paths";
import { listFiles, mtimeMs } from "../core/fsutil";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay } from "../core/ranges";
import { ledgerReconcile, ledgerTouch } from "../core/ledger";
import {
  PROJECT_BUCKETS_VERSION, Bucket, TokenUsageRangeOut, emptyBuckets, mergeTokenDay, tokenUsageRange,
} from "../core/model";
import { OpencodeDay, scanOpencodeDatabase } from "./opencode";
import { sqliteSignature } from "./zcode";

/** 对应 _MIMOCODE_SCAN_VERSION */
const MIMOCODE_SCAN_VERSION = 2;

export interface MimocodeScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
}

/** 对应 _mimocode_data_dirs */
export function mimocodeDataDirs(): string[] {
  const configuredHome = expandPath(process.env.MIMOCODE_HOME);
  if (configuredHome) return [path.join(configuredHome, "data")];
  const xdg = expandPath(process.env.XDG_DATA_HOME);
  if (xdg) return [path.join(xdg, "mimocode")];
  const mac = path.join(HOME, "Library", "Application Support", "mimocode");
  const linux = path.join(HOME, ".local", "share", "mimocode");
  const windows = [path.join(LOCALAPPDATA, "mimocode"), path.join(APPDATA, "mimocode")];
  const ordered = os.platform() === "win32"
    ? [...windows, linux, mac]
    : (os.platform() === "darwin" ? [mac, linux] : [linux, mac]);
  return [...new Set(ordered.map((p) => path.resolve(p)))];
}

/** 对应 _mimocode_db_paths：默认库优先，否则取 mtime 最新的 channel 库 */
export function mimocodeDbPaths(): string[] {
  const direct = expandPath(process.env.TOKEI_MIMOCODE_DB);
  if (direct) return isFile(direct) ? [fs.realpathSync(direct)] : [];
  for (const dataDir of mimocodeDataDirs()) {
    const defaultDb = path.join(dataDir, "mimocode.db");
    if (isFile(defaultDb)) return [fs.realpathSync(defaultDb)];
    const channels = listFiles(dataDir).filter((f) => {
      const name = path.basename(f);
      if (!name.startsWith("mimocode-") || !name.endsWith(".db")) return false;
      const channel = name.slice("mimocode-".length, -".db".length);
      return channel.length > 0 && /^[A-Za-z0-9._-]+$/.test(channel);
    });
    if (channels.length) {
      const active = channels.reduce((a, b) => (mtimeMs(a) >= mtimeMs(b) ? a : b));
      return [fs.realpathSync(active)];
    }
  }
  return [];
}

/** 对应 scan_mimocode()（去掉 ledger_reconcile） */
export function scanMimoCode(bounds: Bounds, cache: Record<string, any>): MimocodeScanResult {
  ledgerTouch("mimocode");
  const fc: Record<string, any> = (cache.mimocode ??= {});
  const buckets = emptyBuckets();
  const dbPaths = mimocodeDbPaths();

  if (!dbPaths.length) {
    if (Object.keys(fc).length) {
      for (const key of Object.keys(fc)) delete fc[key];
      cache._dirty = true;
    }
    return result(buckets);
  }

  const dbPath = dbPaths[0];
  const cacheKey = `db:${dbPath}`;
  const sig = sqliteSignature(dbPath);
  let entry = fc[cacheKey];
  if (!entry || entry.sig !== sig || entry.version !== MIMOCODE_SCAN_VERSION
    || entry.projects_version !== PROJECT_BUCKETS_VERSION) {
    const { days } = scanOpencodeDatabase(dbPath, true);
    entry = {
      sig, days, version: MIMOCODE_SCAN_VERSION, projects_version: PROJECT_BUCKETS_VERSION,
    };
    for (const key of Object.keys(fc)) delete fc[key];
    fc[cacheKey] = entry;
    cache._dirty = true;
  }

  // 天级高水位对账：库里被清掉的日行用账本快照兜底
  const reconciled = ledgerReconcile("mimocode", entry.days ?? {}) as Record<string, OpencodeDay>;
  for (const [dk, day] of Object.entries<OpencodeDay>(reconciled)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
    for (const rk of classifyDay(dk, bounds)) {
      const b: Bucket = buckets[rk];
      mergeTokenDay(b, day);
      for (const s of day.sessions ?? []) b.sessions.add(s);
    }
  }
  return result(buckets);
}

function result(buckets: ReturnType<typeof emptyBuckets>): MimocodeScanResult {
  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])])) as Record<RangeKey, TokenUsageRangeOut>,
  };
}

/**
 * Claude 套餐额度：对应 usage.30s.py 的 _claude_cache_records / _parse_claude_quota_record /
 * _claude_quota_with_freshness / _scan_claude_plan_raw / scan_claude_plan（12927-13215）。
 *
 * 数据不是我们请求出来的：Claude Desktop 每 ~10 分钟轮询一次 /usage，响应被 Chromium
 * 以 zstd 落在 HTTP 缓存目录里，这里只读那个缓存。因为缓存条目会不断被 Chromium 淘汰重写，
 * 所以照原版维护一份水位线状态（candidate / snapshot / scan_boundary / last_full_scan）：
 * 首轮全量定位，之后只看mtime 变化的条目，并复用最近一次的有效候选。
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { APPDATA, LOCALAPPDATA, HOME, TOKEI_DIR, existingDirs, loadJson, pathCandidates, saveJson } from "../core/paths";
import { parseTs } from "../core/ranges";
import { zstdFrameEnd } from "./deepseek_harness";

/** 对应 CLAUDE_QUOTA_STATE_VERSION：改了状态结构就要 +1，旧状态直接作废重扫 */
const STATE_VERSION = 3;
/** 对应 _CLAUDE_QUOTA_STALE_TTL：超过 30 分钟没新缓存条目就算过期 */
const STALE_TTL = 1800;
/** 对应 _CLAUDE_QUOTA_FULL_SCAN_INTERVAL / _CLAUDE_QUOTA_RETRY_SCAN_INTERVAL */
const FULL_SCAN_INTERVAL = 6 * 3600;
const RETRY_SCAN_INTERVAL = 5 * 60;
/** 对应 _CLAUDE_CACHE_FILE_LIMIT：Chromium 单条缓存上限，超过就不是我们的响应 */
const CACHE_FILE_LIMIT = 16 * 1024 * 1024;
/** 对应 _CLAUDE_QUOTA_FUTURE_SKEW：mtime 晚于「现在 + 5 分钟」的条目不可信，见原版注释 */
const FUTURE_SKEW = 5 * 60;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const NEEDLE_ORG = Buffer.from("organizations/");
const NEEDLE_USAGE = Buffer.from("/usage");

/** 对应 CLAUDE_QUOTA_CACHE = _writable_path("claude_quota_cache.json") */
export const CLAUDE_QUOTA_CACHE = path.join(TOKEI_DIR, "claude_quota_cache.json");

export interface ClaudeQuota {
  q5?: number | null;
  q5_reset?: number | null;
  q7?: number | null;
  q7_reset?: number | null;
  qf?: number | null;
  qf_reset?: number | null;
  q_updated?: number | null;
  q5_stale?: boolean;
  q7_stale?: boolean;
  qf_stale?: boolean;
}

interface CacheRecord {
  path: string;
  /**
   * 纳秒。Node 只在 statSync({bigint:true}) 下暴露 mtimeNs，转 number 后会掉约 256ns 的精度，
   * 但这里只做「谁更新」和「和上次是否同一条」的比较，读写用同一个数就自洽。
   */
  mtimeNs: number;
  size: number;
}

/** 对应 CLAUDE_CACHE / CLAUDE_CACHE_DIRS：三个平台候选 + TOKEI_CLAUDE_CACHE_DIR 覆盖 */
export function claudeCacheDirs(): string[] {
  const mac = path.join(HOME, "Library", "Application Support", "Claude", "Cache", "Cache_Data");
  return existingDirs(pathCandidates("TOKEI_CLAUDE_CACHE_DIR", mac,
    path.join(APPDATA, "Claude", "Cache", "Cache_Data"),
    path.join(LOCALAPPDATA, "Claude", "Cache", "Cache_Data")));
}

/** 对应 _claude_cache_records：只收 *_0 条目，按 (mtime_ns, path) 倒序 */
export function claudeCacheRecords(dirs = claudeCacheDirs()): CacheRecord[] {
  const records = new Map<string, CacheRecord>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith("_0"));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        // 与 Python 一样：链接条目按真实目标记账，避免同一份内容被记成两条互相覆盖
        const link = fs.lstatSync(file);
        const real = link.isSymbolicLink() ? fs.realpathSync(file) : file;
        // 默认 statSync 只有毫秒，必须开 bigint 才拿得到纳秒级的 mtimeNs
        const st = fs.statSync(real, { bigint: true });
        if (!st.isFile()) continue;
        records.set(real, { path: real, mtimeNs: Number(st.mtimeNs), size: Number(st.size) });
      } catch {
        continue;
      }
    }
  }
  return [...records.values()].sort((a, b) => b.mtimeNs - a.mtimeNs || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
}

function isoToEpoch(raw: unknown): number | null {
  const ts = parseTs(raw);
  return ts ? Math.trunc(ts.epoch) : null;
}

/** 对应 _parse_claude_quota_record：不是 /usage 响应就返回 null */
export function parseClaudeQuotaRecord(record: CacheRecord): ClaudeQuota | null {
  if (record.size <= 0 || record.size > CACHE_FILE_LIMIT) return null;
  let data: Buffer;
  try {
    data = fs.readFileSync(record.path);
  } catch {
    return null;
  }
  if (!data.includes(NEEDLE_ORG) || !data.includes(NEEDLE_USAGE)) return null;
  const start = data.indexOf(ZSTD_MAGIC);
  if (start < 0) return null;
  let payload: any;
  try {
    // 只解第一帧：帧外的填充字节不是响应内容，多帧扫描反而会因尾部垃圾抛错
    payload = JSON.parse(zlib.zstdDecompressSync(data.subarray(start, zstdFrameEnd(data, start))).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const fiveHour = asDict(payload.five_hour);
  const sevenDay = asDict(payload.seven_day);
  // fable 周额度藏在 limits 的 weekly_scoped 项里，按 scope.model.display_name 认
  let fable: Record<string, any> = {};
  for (const item of Array.isArray(payload.limits) ? payload.limits : []) {
    if (!item || typeof item !== "object" || item.kind !== "weekly_scoped") continue;
    const displayName = asDict(asDict(item.scope).model).display_name;
    if (typeof displayName === "string" && displayName.toLowerCase() === "fable") {
      fable = item;
      break;
    }
  }

  const result: ClaudeQuota = {
    q5: fiveHour.utilization ?? null,
    q5_reset: isoToEpoch(fiveHour.resets_at),
    q7: sevenDay.utilization ?? null,
    q7_reset: isoToEpoch(sevenDay.resets_at),
    qf: fable.percent ?? null,
    qf_reset: isoToEpoch(fable.resets_at),
    q_updated: Math.floor(record.mtimeNs / 1e9),
  };
  return result.q5 == null && result.q7 == null && result.qf == null ? null : result;
}

function asDict(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** 对应 _claude_quota_with_freshness：整源过期（超 TTL / 未来时间）或该窗口已过重置点都算 stale */
export function claudeQuotaWithFreshness(snapshot: ClaudeQuota | null | undefined, now = nowSeconds()): ClaudeQuota {
  if (!snapshot || typeof snapshot !== "object") return {};
  const result: Record<string, any> = { ...snapshot };
  const updated = Number(result.q_updated);
  const age = now - (Number.isFinite(updated) ? updated : 0);
  const sourceStale = !Number.isFinite(updated) || updated <= 0 || age > STALE_TTL || age < -FUTURE_SKEW;
  for (const [valueKey, resetKey, staleKey] of [
    ["q5", "q5_reset", "q5_stale"], ["q7", "q7_reset", "q7_stale"], ["qf", "qf_reset", "qf_stale"],
  ] as const) {
    const reset = Number(result[resetKey]);
    const resetExpired = result[resetKey] != null && Number.isFinite(reset) && reset <= now;
    result[staleKey] = Boolean(result[valueKey] != null && (sourceStale || resetExpired));
  }
  return result as ClaudeQuota;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 对应 _claude_record_signature */
function signature(record: CacheRecord): string {
  return `${record.path}|${record.mtimeNs}|${record.size}`;
}

/** 对应 _load_claude_quota_state：版本不符就当没状态，全量重扫 */
function loadQuotaState(stateFile: string): Record<string, any> {
  const state = loadJson<Record<string, any>>(stateFile, {});
  if (!state || typeof state !== "object" || state.version !== STATE_VERSION) return { version: STATE_VERSION };
  return { ...state };
}

/**
 * 对应 _scan_claude_plan_raw：增量 → 候选复用 → 到期才全量。
 * dirs / stateFile 只为测试留的注入口，线上走 claudeCacheDirs() 与 CLAUDE_QUOTA_CACHE。
 */
export function scanClaudeQuota(now = nowSeconds(), dirs?: string[], stateFile = CLAUDE_QUOTA_CACHE): ClaudeQuota {
  const horizonNs = (now + FUTURE_SKEW) * 1e9;
  const records = claudeCacheRecords(dirs).filter((record) => record.mtimeNs <= horizonNs);
  const recordsByPath = new Map(records.map((record) => [record.path, record]));
  const original = loadQuotaState(stateFile);
  const state: Record<string, any> = { ...original };
  const initialScan = state.scan_mtime_ns === undefined;
  // 与 Python 一致：snapshot 为 null 表示「还没定位到有效条目」，重试间隔走 5 分钟档
  let snapshot: ClaudeQuota | null = isDict(state.snapshot) ? state.snapshot as ClaudeQuota : null;
  const candidateValue = isDict(state.candidate) ? state.candidate as Record<string, any> : null;
  const lastScanNs = Number(state.scan_mtime_ns ?? -1);
  const scanBoundary = new Set<string>(Array.isArray(state.scan_boundary) ? state.scan_boundary : []);

  const inspected = new Set<string>();
  let selected: { record: CacheRecord; snapshot: ClaudeQuota } | null = null;
  const inspect = (record: CacheRecord) => {
    inspected.add(record.path);
    const parsed = parseClaudeQuotaRecord(record);
    return parsed ? { record, snapshot: parsed } : null;
  };

  for (const record of records) {
    if (record.mtimeNs <= lastScanNs
      && !(record.mtimeNs === lastScanNs && !scanBoundary.has(signature(record)))) continue;
    selected = inspect(record);
    if (selected) break;
  }

  let candidateInvalid = false;
  if (!selected && candidateValue) {
    const record = recordsByPath.get(String(candidateValue.path));
    if (!record) {
      candidateInvalid = true;
    } else if (record.mtimeNs !== candidateValue.mtime_ns || record.size !== candidateValue.size) {
      if (!inspected.has(record.path)) {
        selected = inspect(record);
        candidateInvalid = selected === null;
      } else {
        candidateInvalid = true;
      }
    }
  }

  if (initialScan) state.last_full_scan = now;
  const lastFullScan = Number(state.last_full_scan ?? 0);
  // 还没定位到有效条目时 5 分钟就重试；已经稳定了 6 小时才做一次全量兜底
  if (!selected && (candidateInvalid || now - lastFullScan >= (snapshot ? FULL_SCAN_INTERVAL : RETRY_SCAN_INTERVAL))) {
    for (const record of records) {
      if (inspected.has(record.path)) continue;
      selected = inspect(record);
      if (selected) break;
    }
    state.last_full_scan = now;
  }

  if (selected) {
    state.candidate = { path: selected.record.path, mtime_ns: selected.record.mtimeNs, size: selected.record.size };
    state.snapshot = selected.snapshot;
    snapshot = selected.snapshot;
  } else if (candidateInvalid) {
    delete state.candidate;
  }

  if (records.length) {
    const newest = records[0].mtimeNs;
    state.scan_mtime_ns = newest;
    state.scan_boundary = records.filter((record) => record.mtimeNs === newest).map(signature);
  } else {
    state.scan_mtime_ns = -1;
    state.scan_boundary = [];
  }
  state.version = STATE_VERSION;
  // 对应 Python 的 `if state != original`：没变化就不动磁盘
  if (stableStringify(state) !== stableStringify(original)) saveJson(stateFile, state);
  return claudeQuotaWithFreshness(snapshot, now);
}

function isDict(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, any>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, any>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * 对应 _claude_quota_from_environment：原版里 Swift 自己解好 zstd 再用环境变量喂给采集器。
 * Windows 是同进程直调，留着这条分支是为了和 macOS 共用一份配置时行为一致。
 */
function quotaFromEnvironment(now: number): ClaudeQuota | null {
  const raw = process.env.TOKEI_CLAUDE_QUOTA_JSON;
  if (!raw) return null;
  const payload = asDict(safeParse(raw));
  const allowed = ["q5", "q5_reset", "q7", "q7_reset", "qf", "qf_reset", "q_updated"] as const;
  const snapshot: Record<string, any> = {};
  for (const key of allowed) if (payload[key] !== undefined) snapshot[key] = payload[key];
  if (snapshot.q5 == null && snapshot.q7 == null && snapshot.qf == null) return null;
  return claudeQuotaWithFreshness(snapshot as ClaudeQuota, now);
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 对应 scan_claude_plan() */
export function scanClaudePlan(now = nowSeconds(), dirs?: string[], stateFile = CLAUDE_QUOTA_CACHE): ClaudeQuota {
  return quotaFromEnvironment(now) ?? scanClaudeQuota(now, dirs, stateFile);
}

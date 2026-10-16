/**
 * Kimi Code 官方额度：对应 usage.30s.py 的 11806-12109
 * （KIMI_QUOTA_CACHE 等常量 / _kimi_epoch_seconds / _kimi_amount / _kimi_credential_files /
 * _kimi_auth_context / _kimi_window_minutes / _kimi_slot / _kimi_ratio_slot / _kimi_usage_target /
 * _kimi_live_to_limits / _kimi_limits_have_active_window / _cached_kimi_live_limits /
 * fetch_kimi_live_limits / _kimi_quota_values）。
 *
 * 缓存文件：与 grok 一样**不走 provider_quota_cache.json**，用 Python 自己的
 * `~/.tokei/kimi_quota_cache.json`（11810），形状
 * `{fetched_at, limits, plan, user_id, auth_key, source}`，失败时改写 `{auth_key, last_failure_at}`；
 * 因此这里保留同名独立文件并开 useKimiLiveFiles 注入缝。凭据路径复用采集器里的
 * kimiCredentialFiles / kimiRoots 语义（roots 改走 deps.env，便于单测指向临时目录）。
 *
 * 接线点（我不动采集器，供后续 wiring 用）：
 * - Python 13437 `kimi_live = _safe_scan("kimi_quota", fetch_kimi_live_limits, lambda: None, errors)`
 * - Python 13438 `kimi_limits, kimi_plan, kimi_updated = kimi_live if kimi_live else (None, None, None)`
 * - Python 13439 `kimi_quota = _kimi_quota_values(kimi_limits, updated_at=kimi_updated)`
 * - payload 13572-13579 的 `"kimicode"` 段：p5/pw(13574)、r5/rw(13575)、
 *   q_updated(13576 ← int(kimi_updated) if kimi_updated else None)、p5_stale/pw_stale(13577)、
 *   plan(13578 ← kimi_plan)。
 * - Windows 侧对应 src/collectors/kimicode.ts:451-454 的 return（p5/pw/r5/rw/q_updated/
 *   p5_stale/pw_stale/plan 现在恒 null）。
 *
 * 安全口径照原版（11807-11809）：凭据由 Kimi Code CLI 自己写入并刷新，Tokei **只读 access_token，
 * 绝不使用同文件的 refresh_token**（OAuth refresh 带 rotation，抢刷会顶掉 CLI 的登录态）；
 * token 过期（约 30 分钟）直接沿用缓存并标 stale，不发这次必然 401 的请求；token 只发
 * api.kimi.com（host/port/scheme 三者都与 KIMI_CODE_BASE_URL 校验），且不跟随重定向。
 * 开关：TOKEI_KIMI_LIVE_QUOTA=0 才关（与 grok 相反，这一路 Python 默认是开的）。
 *
 * 与原版的三处小差异（语义等价）：
 * 1) http.ts 从不跟随重定向，所以 12044-12048 的 final_url host/port/scheme 复核不需要重写一遍；
 * 2) fetched_at / last_failure_at 用 deps.now() 的整秒（Python 是 float 时间戳），只影响亚秒精度；
 * 3) 凭据根目录走 deps.env 而不是 process.env，便于单测把凭据指到临时目录。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { HOME, TOKEI_DIR, expandPath, loadJson, saveJson } from "../../core/paths";
import { parseTs } from "../../core/ranges";
import { kimiCredentialFiles } from "../../collectors/kimicode";
import { QuotaDeps } from "./context";

/** 对应 KIMI_QUOTA_CACHE(11810) */
const DEFAULT_CACHE = path.join(TOKEI_DIR, "kimi_quota_cache.json");
/** 对应 _KIMI_QUOTA_TTL(11811) */
export const KIMI_QUOTA_TTL = 300;
/** 对应 _KIMI_QUOTA_FALLBACK_TTL(11812) */
export const KIMI_QUOTA_FALLBACK_TTL = 300;
/** 对应 _KIMI_QUOTA_STALE_AFTER(11813)：读数超过 30 分钟没刷新就标 stale */
export const KIMI_QUOTA_STALE_AFTER = 1800;
/** 对应 _KIMI_CODE_DEFAULT_BASE_URL(11814) 与 _KIMI_USAGE_URL(11815) */
export const KIMI_CODE_DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
/** 对应 _KIMI_USAGE_MAX_RESPONSE_BYTES(11816) */
export const KIMI_USAGE_MAX_RESPONSE_BYTES = 256 * 1024;
/** 对应 _KIMI_FIVE_HOUR_MINUTES(11817) */
export const KIMI_FIVE_HOUR_MINUTES = 300;
/** 对应 _KIMI_TIME_UNITS(11818-11823) */
export const KIMI_TIME_UNITS: Record<string, number> = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 60 * 24,
  TIME_UNIT_WEEK: 60 * 24 * 7,
};
/** 对应 12030 的失败冷却：一次失败后 300 秒内不再敲接口 */
export const KIMI_FAILURE_COOLDOWN = 300;

const DEFAULT_DIR = path.join(HOME, ".kimi-code");
const LEGACY_DIR = path.join(HOME, ".kimi");

export interface KimiLiveFiles {
  /** 缓存文件（对应 KIMI_QUOTA_CACHE） */
  cache: string;
  /** 凭据文件候选（对应 _kimi_credential_files）；顺序敏感，先命中先用 */
  credentialFiles: string[];
}

let filesOverride: Partial<KimiLiveFiles> = {};

/** 测试注入口：单测把 cache 与凭据文件都指到临时目录，绝不碰真实 ~/.tokei 与 ~/.kimi-code */
export function useKimiLiveFiles(files?: Partial<KimiLiveFiles> | null): void {
  filesOverride = files ?? {};
}

/** 对应 _kimi_roots(11785)：显式配置只有一个根，否则新旧两个根都试。
 *  与采集器的 kimiRoots() 同一套规则，差别只在这里从 deps.env 取环境变量，单测能指向临时目录。 */
export function kimiLiveRoots(deps: QuotaDeps): string[] {
  const configured = deps.env("TOKEI_KIMI_DIR") || deps.env("KIMI_CODE_HOME") || deps.env("KIMI_SHARE_DIR");
  const candidates = configured ? [configured] : [DEFAULT_DIR, LEGACY_DIR];
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const root = expandPath(candidate);
    if (!root) continue;
    let real = root;
    try {
      real = fs.realpathSync(root);
    } catch {
      /* 目录尚不存在：Python 的 realpath 失败时也用原始路径 */
    }
    const key = path.normalize(real).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(real);
  }
  return roots;
}

export function kimiLiveFiles(deps: QuotaDeps, files?: Partial<KimiLiveFiles> | null): KimiLiveFiles {
  const merged = { ...filesOverride, ...(files ?? {}) };
  return {
    cache: merged.cache ?? DEFAULT_CACHE,
    // 凭据位置复用采集器的 kimiCredentialFiles()：<root>/credentials/kimi-code.json
    credentialFiles: merged.credentialFiles ?? kimiCredentialFiles(kimiLiveRoots(deps)),
  };
}

/** Python 的 float(x)：布尔/None/空串/非数字一律 null。
 *  与原版的一处口径差：Python 允许 NaN 一路传到 _kimi_ratio_slot 的 isfinite 检查，
 *  这里按本仓库 provider_number 的统一做法把 NaN/Inf 直接判成不可用（结果一致，只是更早）。 */
function toFloat(value: unknown): number | null {
  if (typeof value === "boolean" || value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 对应 _kimi_amount(11839) */
export function kimiAmount(value: unknown): number | null {
  return toFloat(value);
}

/** 对应 _kimi_epoch_seconds(11826)：秒或毫秒都收，<=0 视为无 */
export function kimiEpochSeconds(value: unknown): number | null {
  const num = toFloat(value);
  if (num === null || num <= 0) return null;
  return num > 1e11 ? num / 1000 : num;
}

function isoEpoch(raw: unknown): number | null {
  // 对应 _iso_to_epoch(12968)
  const ts = raw ? parseTs(raw) : null;
  return ts ? Math.trunc(ts.epoch) : null;
}

export interface KimiAuthContext {
  access_token?: string;
  expires_at?: number | null;
  expired?: boolean;
  auth_key?: string;
}

/**
 * 对应 _kimi_auth_context(11854)：只读 CLI 写好的 access_token，过期就标出来让调用方别发请求。
 * 绝口不提 refresh_token —— 同文件里有，但一次都不读。
 */
export function kimiAuthContext(deps: QuotaDeps, files?: Partial<KimiLiveFiles>): KimiAuthContext {
  const now = deps.now();
  for (const file of kimiLiveFiles(deps, files).credentialFiles) {
    const creds = loadJson<unknown>(file, {});
    if (!creds || typeof creds !== "object" || Array.isArray(creds)) continue;
    const token = (creds as Record<string, any>).access_token;
    if (typeof token !== "string" || !token) continue;
    const expiresAt = kimiEpochSeconds((creds as Record<string, any>).expires_at);
    return {
      access_token: token,
      expires_at: expiresAt,
      expired: Boolean(expiresAt !== null && now >= expiresAt),
      auth_key: crypto.createHash("sha256").update(token, "utf8").digest("hex"),
    };
  }
  return {};
}

/** 对应 _kimi_window_minutes(11874) */
export function kimiWindowMinutes(window: unknown): number | null {
  if (!window || typeof window !== "object" || Array.isArray(window)) return null;
  const duration = kimiAmount((window as Record<string, any>).duration);
  const unit = KIMI_TIME_UNITS[String((window as Record<string, any>).timeUnit)];
  if (duration === null || unit === undefined) return null;
  return Math.round(duration * unit);
}

export interface KimiSlot {
  used_percent: number;
  resets_at?: number;
}

function firstValue(detail: Record<string, any>, keys: string[]): unknown {
  for (const key of keys) {
    const value = detail[key];
    if (value) return value;
  }
  return null;
}

/** 对应 _kimi_slot(11884)：detail = {limit, used, remaining, resetTime} → 百分比 + 重置时刻 */
export function kimiSlot(detail: unknown): KimiSlot | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const item = detail as Record<string, any>;
  const limit = kimiAmount(item.limit);
  let used = kimiAmount(item.used);
  const remaining = kimiAmount(item.remaining);
  // 接口有时只给 limit+remaining：used 自己减出来
  if (used === null && limit !== null && remaining !== null) used = limit - remaining;
  if (limit === null || limit <= 0 || used === null) return null;
  const slot: KimiSlot = { used_percent: Math.max(0, Math.min(100, (100 * used) / limit)) };
  const reset = isoEpoch(firstValue(item, ["resetTime", "reset_time", "resetAt", "reset_at"]));
  if (reset !== null) slot.resets_at = reset;
  return slot;
}

/** 对应 _kimi_ratio_slot(11903)：新版用 0-1 的 used_ratio 直接表达已用比例 */
export function kimiRatioSlot(detail: unknown): KimiSlot | null {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const item = detail as Record<string, any>;
  const ratio = kimiAmount(item.used_ratio);
  if (ratio === null || ratio < 0) return null;
  const slot: KimiSlot = { used_percent: Math.min(1, ratio) * 100 };
  const reset = isoEpoch(firstValue(item, ["reset_time", "resetTime"]));
  if (reset !== null) slot.resets_at = reset;
  return slot;
}

/** 对应 _kimi_usage_target(11916)：[url, 期望 host, 期望 port]；非法配置返回 null */
export function kimiUsageTarget(deps: QuotaDeps): [string, string, number | null] | null {
  const raw = (deps.env("KIMI_CODE_BASE_URL") ?? KIMI_CODE_DEFAULT_BASE_URL).trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // 只认干净的 https URL：带 query/fragment/账号密码都可能把 token 带去别处
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password
    || parsed.search || parsed.hash) return null;
  const basePath = parsed.pathname.replace(/\/+$/, "");
  let usagePath: string;
  if (basePath.endsWith("/usages")) usagePath = basePath;
  else if (basePath.endsWith("/coding/v1")) usagePath = `${basePath}/usages`;
  else if (basePath.endsWith("/coding")) usagePath = `${basePath}/v1/usages`;
  else usagePath = `${basePath}/coding/v1/usages`;
  const port = parsed.port ? Number(parsed.port) : null;
  return [`https://${parsed.host}${usagePath}`, parsed.hostname.toLowerCase(), port];
}

export interface KimiLimits {
  limit_id: string;
  five_hour: KimiSlot | null;
  subscription: KimiSlot | null;
  plan: unknown;
  user_id: unknown;
}

/** 对应 _kimi_live_to_limits(11940)：新版 usages 池优先，旧版 limits/usage 结构兜底 */
export function kimiLiveToLimits(data: unknown): KimiLimits | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const body = data as Record<string, any>;
  const pools = body.usages && typeof body.usages === "object" && !Array.isArray(body.usages)
    ? body.usages as Record<string, any> : {};
  let fiveHour = kimiRatioSlot(pools.limit_5h);
  let subscription = [pools.limit_month_total, pools.limit_month, pools.limit_7d]
    .map((pool) => kimiRatioSlot(pool)).find((slot) => slot) ?? null;
  if (!fiveHour) {
    for (const item of Array.isArray(body.limits) ? body.limits : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (kimiWindowMinutes(item.window) === KIMI_FIVE_HOUR_MINUTES) {
        fiveHour = kimiSlot(item.detail);
        break;
      }
    }
  }
  if (!subscription) subscription = kimiSlot(body.usage);
  if (!fiveHour && !subscription) return null;
  const user = body.user && typeof body.user === "object" && !Array.isArray(body.user)
    ? body.user as Record<string, any> : {};
  const membership = user.membership && typeof user.membership === "object" && !Array.isArray(user.membership)
    ? user.membership as Record<string, any> : {};
  return {
    limit_id: "kimicode",
    five_hour: fiveHour,
    subscription,
    plan: membership.level,
    user_id: user.userId,
  };
}

/** 对应 _kimi_limits_have_active_window(11973)：还有没走完的窗口 → 旧读数仍然可用 */
export function kimiLimitsHaveActiveWindow(limits: unknown, nowEpoch: number): boolean {
  const now = Number(nowEpoch);
  for (const key of ["five_hour", "subscription"]) {
    const slot = ((limits || {}) as Record<string, any>)[key] || {};
    const reset = slot.resets_at;
    if (reset !== null && reset !== undefined && Number(reset) > now) return true;
  }
  return false;
}

/** fetch_kimi_live_limits 的返回：Python 的 (limits, plan, fetched_at) 三元组，没有就 None */
export type KimiLiveResult = [KimiLimits, any, number] | null;

/** 对应 _cached_kimi_live_limits(11986)：auth_key 变了就当没有缓存 */
export function cachedKimiLiveLimits(
  maxAge: number, authKey: string | null | undefined, deps: QuotaDeps,
  allowActiveWindow = false, files?: Partial<KimiLiveFiles>,
): KimiLiveResult {
  if (!authKey) return null;
  const cached = loadJson<unknown>(kimiLiveFiles(deps, files).cache, {});
  if (!cached || typeof cached !== "object" || Array.isArray(cached)) return null;
  const state = cached as Record<string, any>;
  if (state.auth_key !== authKey) return null;
  const limits = state.limits;
  const fetchedAt = toFloat(state.fetched_at);
  if (fetchedAt === null || !limits) return null;
  const age = deps.now() - fetchedAt;
  if (age > maxAge && !(allowActiveWindow && kimiLimitsHaveActiveWindow(limits, deps.now()))) return null;
  return [limits as KimiLimits, state.plan, fetchedAt];
}

/** 对应 fetch_kimi_live_limits(12005) */
export async function fetchKimiLiveLimits(
  deps: QuotaDeps, files?: Partial<KimiLiveFiles>,
): Promise<KimiLiveResult> {
  if (deps.env("TOKEI_KIMI_LIVE_QUOTA") === "0") return null;
  const target = kimiUsageTarget(deps);
  if (!target) return null;
  const [usageUrl] = target;
  const paths = kimiLiveFiles(deps, files);
  const auth = kimiAuthContext(deps, paths);
  const token = auth.access_token;
  if (!token) return null;
  const authKey = auth.auth_key;

  const cached = cachedKimiLiveLimits(KIMI_QUOTA_TTL, authKey, deps, false, paths);
  if (cached) return cached;
  if (auth.expired) {
    // token 已过期：发出去只是 401，允许沿用「窗口还没走完」的旧读数（12020-12022）
    return cachedKimiLiveLimits(KIMI_QUOTA_FALLBACK_TTL, authKey, deps, true, paths);
  }

  const cacheState = readCacheState(paths.cache, authKey);
  const lastFailure = toFloat(cacheState.last_failure_at) ?? 0;
  // 一次失败后 5 分钟内不再敲接口（12026-12035）
  if (lastFailure && deps.now() - lastFailure < KIMI_FAILURE_COOLDOWN) {
    return cachedKimiLiveLimits(KIMI_QUOTA_FALLBACK_TTL, authKey, deps, true, paths);
  }

  try {
    // http.ts 从不跟随重定向，等价于 Python 12044-12048 的 final_url host/port/scheme 复核：
    // Bearer 只会落到 KIMI_CODE_BASE_URL 指名的那台主机。
    const data = await deps.request(usageUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Tokei",
        Authorization: `Bearer ${token}`,
      },
      timeoutSeconds: 3,
      maxBytes: KIMI_USAGE_MAX_RESPONSE_BYTES,
    });
    const limits = kimiLiveToLimits(data);
    if (!limits) throw new Error("invalid Kimi usage response");
    const plan = limits.plan ?? null;
    const fetchedAt = deps.now();
    saveJson(paths.cache, {
      fetched_at: fetchedAt,
      limits,
      plan,
      user_id: limits.user_id ?? null,
      auth_key: authKey,
      source: "live",
    });
    return [limits, plan, fetchedAt];
  } catch {
    try {
      const state = readCacheState(paths.cache, authKey);
      state.last_failure_at = deps.now();
      saveJson(paths.cache, state);
    } catch {
      // 缓存写不进去就算了（Python 12073 同样吞掉）
    }
  }
  return cachedKimiLiveLimits(KIMI_QUOTA_FALLBACK_TTL, authKey, deps, true, paths);
}

// auth_key 对不上就丢掉旧状态，避免把别人的失败时间/读数算到自己头上（对应 12023-12025）
function readCacheState(cacheFile: string, authKey: string | null | undefined): Record<string, any> {
  const raw = loadJson<unknown>(cacheFile, {});
  const state = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, any>) } : {};
  if (state.auth_key !== authKey) return { auth_key: authKey ?? null };
  return state;
}

export interface KimiQuotaValues {
  p5: number | null;
  pw: number | null;
  r5: number | null;
  rw: number | null;
  p5_stale: boolean;
  pw_stale: boolean;
}

/** 对应 _kimi_quota_values(12079)：limits → Codex 卡片同名的 p5/pw/r5/rw + stale 标记 */
export function kimiQuotaValues(
  limits: unknown, options: { nowEpoch?: number; updatedAt?: number | null } = {},
): KimiQuotaValues {
  const values: KimiQuotaValues = {
    p5: null, pw: null, r5: null, rw: null, p5_stale: false, pw_stale: false,
  };
  const mapping: Array<["five_hour" | "subscription", "p5" | "pw", "r5" | "rw"]> = [
    ["five_hour", "p5", "r5"], ["subscription", "pw", "rw"],
  ];
  for (const [slotKey, pctKey, resetKey] of mapping) {
    const slot = (((limits || {}) as Record<string, any>)[slotKey] || {}) as Record<string, any>;
    if (!Object.keys(slot).length) continue;
    values[pctKey] = slot.used_percent ?? null;
    values[resetKey] = slot.resets_at ?? null;
  }

  const now = options.nowEpoch !== undefined ? options.nowEpoch : Math.trunc(Date.now() / 1000);
  const updatedAt = options.updatedAt;
  // Python 12098 的 `if updated_at else None`：0 也按「没有更新时间」
  const updatedAge = updatedAt ? now - Number(updatedAt) : null;
  for (const [, pctKey, resetKey] of mapping) {
    if (values[pctKey] === null) continue;
    const reset = values[resetKey];
    if (reset && now > Number(reset)) {
      // 窗口已经翻篇：读数必然失真
      values[`${pctKey}_stale` as "p5_stale" | "pw_stale"] = true;
    } else if (updatedAge !== null && updatedAge > KIMI_QUOTA_STALE_AFTER) {
      // 读数本身太旧（CLI 久未刷新 token）
      values[`${pctKey}_stale` as "p5_stale" | "pw_stale"] = true;
    }
  }
  return values;
}

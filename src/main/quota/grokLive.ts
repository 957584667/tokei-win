/**
 * Grok 实时额度：对应 usage.30s.py 的 4984-5261（_tokei_config / _grok_live_quota_enabled /
 * _grok_auth_state / _normalize_grok_billing / _scan_grok_billing_from_log / _cached_grok_quota /
 * _save_grok_quota_cache / fetch_grok_live_quota / scan_grok_quota）。
 *
 * 缓存文件：Python 这一路**不走 provider_quota_cache.json**，而是自己的
 * `~/.tokei/grok_quota_cache.json`（4976-4981 常量 + 5147/5170 读写），形状
 * `{fetched_at, source, quota}`，所以这里保留同名独立文件，并留出 useGrokLiveFiles 注入缝。
 * 归一化与本地日志扫描直接复用 src/collectors/grok.ts 的 normalizeGrokBilling /
 * scanGrokBillingFromLog（同一份语义，不重写第二遍）。
 *
 * 接线点（我不动采集器，供后续 wiring 用）：
 * - Python 13434 `grok_quota = _safe_scan("grok_quota", scan_grok_quota, lambda: {}, errors) or {}`
 *   → payload 13502-13514 的 `"grok"` 段：pct(13505)/reset(13506)/plan(13507)/products(13508)/
 *   window(13509)/source(13510)/q_updated(13511 ← quota["updated"])/stale(13512)/
 *   auth_expired(13513，bool(grok_quota.get("auth_expired")))。
 * - Windows 侧对应 src/collectors/grok.ts:626 `scanGrokQuota().quota`，落到 631-639 的
 *   pct/reset/plan/products/window/source/q_updated/stale，其中 639 的 auth_expired 现在恒为
 *   false，接入本文件后即可带上真实值。
 *
 * 安全口径照原版（4999-5022）：只读 access token、绝不代刷 refresh_token（auth.json 与 Grok CLI
 * / OpenUsage 共用，抢刷会把它们自己的登录顶掉）；离过期不足 _GROK_AUTH_EXPIRY_SKEW=60 秒按已过期
 * 处理；token 只发给它自己的域 cli-chat-proxy.grok.com，且不跟随重定向。
 * 实时额度**默认关闭**：只有 TOKEI_GROK_LIVE_QUOTA=1 或 config.json 的 grok_live_quota_enabled 才联网。
 *
 * 与原版的三处小差异（语义等价）：
 * 1) http.ts 从不跟随重定向，所以 5209-5211 的 final_url 复核不需要重写一遍；
 * 2) fetched_at 用 deps.now() 的整秒（Python 是 float 时间戳）；
 * 3) plan 一律字符串化（采集器的 normalizeGrokBilling 如此，Python 原样保留 json 里的类型）。
 */
import * as fs from "fs";
import * as path from "path";
import { TOKEI_DIR, loadJson, saveJson } from "../../core/paths";
import { parseTs } from "../../core/ranges";
import { grokHome, grokLogPath, normalizeGrokBilling, scanGrokBillingFromLog } from "../../collectors/grok";
import { QuotaDeps } from "./context";

/** 对应 _GROK_QUOTA_TTL(4976)：live 读数 30 秒内直接复用 */
export const GROK_QUOTA_TTL = 30;
/** 对应 _GROK_QUOTA_FALLBACK_TTL(4977)：请求失败/无 token 时退回 300 秒内的旧读数 */
export const GROK_QUOTA_FALLBACK_TTL = 300;
/** 对应 _GROK_BILLING_MAX_RESPONSE_BYTES(4979)：响应超 1MiB 判异常 */
export const GROK_BILLING_MAX_RESPONSE_BYTES = 1024 * 1024;
/** 对应 _GROK_LIVE_BILLING_URL(4981) */
export const GROK_LIVE_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/** 对应 _GROK_AUTH_EXPIRY_SKEW(5000) */
export const GROK_AUTH_EXPIRY_SKEW = 60;
/** 对应 5249 的 `_GROK_QUOTA_FALLBACK_TTL * 12`：本地缓存放宽到约 1 小时 */
export const GROK_CACHE_SCAN_TTL = GROK_QUOTA_FALLBACK_TTL * 12;

export interface GrokLiveFiles {
  /** 对应 GROK_QUOTA_CACHE(241) */
  cache: string;
  /** 对应 GROK_AUTH(118) */
  auth: string;
  /** 对应 GROK_LOG(117) */
  log: string;
}

let filesOverride: Partial<GrokLiveFiles> = {};

/** 测试注入口：整份或按字段改到临时目录，单测绝不碰真实 ~/.tokei 与 ~/.grok */
export function useGrokLiveFiles(files?: Partial<GrokLiveFiles> | null): void {
  filesOverride = files ?? {};
}

export function grokLiveFiles(files?: Partial<GrokLiveFiles> | null): GrokLiveFiles {
  const merged = { ...filesOverride, ...(files ?? {}) };
  return {
    cache: merged.cache ?? path.join(TOKEI_DIR, "grok_quota_cache.json"),
    auth: merged.auth ?? path.join(grokHome(), "auth.json"),
    log: merged.log ?? grokLogPath(),
  };
}

/** 对应 _tokei_config(4984) + _grok_live_quota_enabled(4989)：环境变量 "0"/"1" 优先，否则看配置 */
export function grokLiveQuotaEnabled(deps: QuotaDeps): boolean {
  const env = deps.env("TOKEI_GROK_LIVE_QUOTA");
  if (env === "0") return false;
  if (env === "1") return true;
  const config = deps.config();
  return Boolean(config && typeof config === "object" && config.grok_live_quota_enabled);
}

function isoEpoch(raw: unknown): number | null {
  // 对应 _iso_to_epoch(12968)：parse_ts 后取整；坏值 → null
  const ts = raw ? parseTs(raw) : null;
  return ts ? Math.trunc(ts.epoch) : null;
}

/**
 * 对应 _grok_auth_state(5003)：返回 [token, 是否已过期]。
 * 只读 access token，不代刷；两个字段都兼容（key / access_token），第一个有 token 的条目即返回。
 * expires_at 只在写成字符串时才解析（Python 5017 的 isinstance(str)），数字一律当永不过期。
 */
export function grokAuthState(
  deps: QuotaDeps, files?: Partial<GrokLiveFiles>,
): [string | null, boolean] {
  const auth = loadJson<unknown>(grokLiveFiles(files).auth, {});
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return [null, false];
  const now = deps.now();
  for (const entry of Object.values(auth as Record<string, any>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const token = entry.key ?? entry.access_token;
    if (typeof token === "string" && token.trim()) {
      const expires = typeof entry.expires_at === "string" ? isoEpoch(entry.expires_at) : null;
      // Python 5021：expires - now <= 60 即算过期（expires 为 None 时恒 False）
      return [token.trim(), Boolean(expires !== null && expires - now <= GROK_AUTH_EXPIRY_SKEW)];
    }
  }
  return [null, false];
}

/** 对应 _cached_grok_quota(5146)：年龄超窗就当作没有 */
export function cachedGrokQuota(
  maxAge: number, deps: QuotaDeps, files?: Partial<GrokLiveFiles>,
): Record<string, any> | null {
  const cached = loadJson<unknown>(grokLiveFiles(files).cache, {});
  if (!cached || typeof cached !== "object" || Array.isArray(cached)) return null;
  const quota = (cached as Record<string, any>).quota;
  const fetchedAt = Number((cached as Record<string, any>).fetched_at);
  if (!quota || typeof quota !== "object" || Array.isArray(quota) || !Number.isFinite(fetchedAt)) return null;
  if (deps.now() - fetchedAt > maxAge) return null;
  const out = { ...(quota as Record<string, any>) };
  // Python 5161 的 setdefault：只在缺键时补，已有的 source（哪怕来自 live）保持不变
  if (!("source" in out)) out.source = (cached as Record<string, any>).source ?? out.source ?? "cache";
  return out;
}

/** 对应 _save_grok_quota_cache(5165)：没有 pct 的读数（如 auth_expired 占位）不落盘 */
export function saveGrokQuotaCache(
  quota: Record<string, any> | null | undefined, deps: QuotaDeps, files?: Partial<GrokLiveFiles>,
): void {
  if (!quota || typeof quota !== "object" || quota.pct === null || quota.pct === undefined) return;
  const cache = grokLiveFiles(files).cache;
  if (!saveJson(cache, { fetched_at: deps.now(), source: quota.source, quota })) return;
  try {
    fs.chmodSync(cache, 0o600);
  } catch {
    // Windows 没有 POSIX 权限位，失败就算了（Python 5176 同样忽略）
  }
}

/**
 * 对应 fetch_grok_live_quota(5183)：只在用户显式开启时请求；失败一律退 300 秒旧读数。
 * 返回值形状随 Python：null / {auth_expired:true} / 归一化后的 quota。
 */
export async function fetchGrokLiveQuota(
  deps: QuotaDeps, files?: Partial<GrokLiveFiles>,
): Promise<Record<string, any> | null> {
  if (!grokLiveQuotaEnabled(deps)) return null;
  const paths = grokLiveFiles(files);
  const cached = cachedGrokQuota(GROK_QUOTA_TTL, deps, paths);
  if (cached && cached.source === "live") return cached;
  const [token, expired] = grokAuthState(deps, paths);
  if (!token) return cachedGrokQuota(GROK_QUOTA_FALLBACK_TTL, deps, paths);
  if (expired) {
    // 过期 token 只会换来 401（Python 5193-5195）：不发这次请求，直接告诉界面登录已过期
    return { auth_expired: true };
  }
  try {
    // http.ts 从不跟随重定向（3xx 直接抛错），等价于 Python 5207 的 add_unredirected_header
    // + 5210 的 final_url 校验：Bearer 只发到 cli-chat-proxy.grok.com 这一次请求，不会被搬到别的域。
    const data = await deps.request(GROK_LIVE_BILLING_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Tokei",
        Authorization: `Bearer ${token}`,
      },
      timeoutSeconds: 3,
      maxBytes: GROK_BILLING_MAX_RESPONSE_BYTES,
    });
    const config = data && typeof data === "object" && !Array.isArray(data) ? data.config : null;
    let plan: unknown = null;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      plan = data.subscriptionTier ?? data.plan;
    }
    const quota = normalizeGrokBilling(
      config && typeof config === "object" && !Array.isArray(config) ? config : null,
      {
        plan: plan === null || plan === undefined || plan === "" ? null : String(plan),
        source: "live",
        nowEpoch: Math.trunc(deps.now()),
      },
    );
    if (!quota) return cachedGrokQuota(GROK_QUOTA_FALLBACK_TTL, deps, paths);
    const out = quota as unknown as Record<string, any>;
    saveGrokQuotaCache(out, deps, paths);
    return out;
  } catch {
    return cachedGrokQuota(GROK_QUOTA_FALLBACK_TTL, deps, paths);
  }
}

/**
 * 对应 scan_grok_quota(5229)：默认优先本地日志，只有显式开启才走实时 API。
 * 返回 Python 那个 dict（pct/reset/plan/products/window/source/updated/stale[/auth_expired]）。
 */
export async function scanGrokQuota(
  deps: QuotaDeps, files?: Partial<GrokLiveFiles>,
): Promise<Record<string, any>> {
  const paths = grokLiveFiles(files);
  const logQuota = scanGrokBillingFromLog(paths.log);
  if (logQuota && !logQuota.stale) saveGrokQuotaCache(logQuota as any, deps, paths);

  let authExpired = false;
  if (grokLiveQuotaEnabled(deps)) {
    const live = await fetchGrokLiveQuota(deps, paths);
    if (live && live.pct !== null && live.pct !== undefined) return live;
    authExpired = Boolean(live && live.auth_expired);
  }

  const withAuthState = (quota: Record<string, any>): Record<string, any> =>
    // 实时开关开着却只能给本地值时，把原因带给界面，不装作还在查实时（Python 5242-5244）
    authExpired ? { ...quota, auth_expired: true } : quota;

  if (logQuota && logQuota.pct !== null) return withAuthState(logQuota as any);

  const cached = cachedGrokQuota(GROK_CACHE_SCAN_TTL, deps, paths);
  if (cached && cached.pct !== null && cached.pct !== undefined) {
    const out: Record<string, any> = { ...cached, source: "cache" };
    const reset = out.reset;
    // 缓存里的周期已过重置点 → 仍标 stale 并把用量归零（Python 5254-5259）
    if (reset !== null && reset !== undefined && Math.trunc(Number(reset)) <= Math.trunc(deps.now())) {
      out.stale = true;
      out.pct = 0.0;
      out.reset = null;
    }
    return withAuthState(out);
  }
  return authExpired ? { auth_expired: true } : {};
}

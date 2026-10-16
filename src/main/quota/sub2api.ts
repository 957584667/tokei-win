/**
 * sub2api 额度：对应 usage.30s.py 的 6825-6975。
 *
 * 这是一路「自建中转站」取数：Base URL 由用户填（sub2api_base_url），Key 走
 * DPAPI 凭据（名称 sub2api），两者缺一就直接返回 {}，绝不联网。Base URL 在
 * 拼请求之前必须过 validSub2APIBaseURL —— 与面板保存同一套白名单（https 任意
 * 主机；http 只允许本机；带账号密码 / 查询串 / 锚点一律拒绝），保证面板里能看到
 * 的地址和真正发请求的地址判定一致。
 *
 * 骨架仍是 zed.ts 那套：开关 → 凭据 → marker → 5 分钟缓存 → 请求 → 归一化 →
 * 落缓存 → 失败退 1 小时旧读数。
 */
import {
  PROVIDER_QUOTA_FALLBACK_TTL, PROVIDER_QUOTA_TTL, cachedProviderQuota, defaultEnvAccess,
  epochSeconds, providerConfigString, providerCredentialMarker, providerEpoch, providerInteger,
  providerMoney, providerNumber, providerQuotaEnabled, providerWindow, saveProviderQuotaCache,
} from "../../core/providerQuota";
import { validSub2APIBaseURL } from "../providers";
import { QuotaDeps, secretValue } from "./context";

type Dict = Record<string, any>;

function asDict(value: unknown): Dict | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Dict : null;
}

/**
 * 对应 _local_timezone_name。原版在 macOS/Linux 上解析 /etc/localtime 软链；
 * Windows 没有这个文件，直接用 Intl 的 IANA 时区名，语义等价。TZ 环境变量照旧最优先。
 */
export function localTimezoneName(
  env: (key: string) => string | undefined = defaultEnvAccess.env,
): string {
  const configured = env("TZ");
  if (configured && configured.trim()) return configured.trim();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone || "UTC";
}

/** 对应 urlencode 的 quote_plus：空格写成 + 而不是 %20，服务端两侧解码结果一致 */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

/** 对应 _sub2api_usage_url 里的 ipaddress(...).is_loopback 判定 */
function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost") return true;
  const ipv4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(lower);
  if (ipv4) return Number(ipv4[1]) === 127; // 127.0.0.0/8 整段都算回环
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  const mapped = /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(lower);
  return mapped !== null;
}

/**
 * 对应 _sub2api_usage_url：path 若已以 /v1 或 /v1/usage 结尾就不再补 /v1，
 * 然后统一补 /usage；查询串固定 days=30 + timezone。
 */
export function sub2apiUsageUrl(baseUrl: unknown, timezoneName?: string): string | null {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") return null;
  // WHATWG 的 IPv6 主机自带方括号，去掉后才能和 Python urlsplit 的 hostname 对齐
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (scheme === "http" && !isLoopbackHost(host)) return null;
  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (!/\/v1(?:\/usage)?$/.test(pathname)) pathname += "/v1";
  if (!pathname.endsWith("/usage")) pathname += "/usage";
  const tz = timezoneName || localTimezoneName();
  const query = `days=30&timezone=${formEncode(tz)}`;
  return `${scheme}://${parsed.host}${pathname}?${query}`;
}

/** 对应 _normalize_sub2api_quota */
export function normalizeSub2ApiQuota(payload: unknown, updated?: number): Dict {
  const data = asDict(payload);
  if (!data || data.isValid === false) return {};
  const unit = typeof data.unit === "string" ? data.unit : "USD";
  const windows: ReturnType<typeof providerWindow>[] = [];

  // 与原版内嵌的 add_window 一致：used/limit 任一缺失或 limit<=0 就整条丢弃
  const addWindow = (
    windowId: string, title: string, used: unknown, limit: unknown,
    minutes?: number | null, reset?: unknown, valueUnit?: string | null,
  ): void => {
    const usedNumber = providerNumber(used);
    const limitNumber = providerNumber(limit);
    if (usedNumber === null || limitNumber === null || limitNumber <= 0) return;
    const currency = valueUnit || unit;
    const detail = `${providerMoney(usedNumber, currency)} / ${providerMoney(limitNumber, currency)}`;
    windows.push(providerWindow(windowId, title, usedNumber / limitNumber * 100, reset, minutes, detail));
  };

  const subscription = asDict(data.subscription);
  const quota = asDict(data.quota);
  if (subscription && Object.keys(subscription).length) {
    addWindow("sub2api-daily", "日额度", subscription.daily_usage_usd, subscription.daily_limit_usd, 1440);
    addWindow("sub2api-weekly", "周额度", subscription.weekly_usage_usd, subscription.weekly_limit_usd, 10080);
    addWindow("sub2api-monthly", "月额度", subscription.monthly_usage_usd, subscription.monthly_limit_usd, 43200);
  } else if (quota && Object.keys(quota).length) {
    const quotaUnit = typeof quota.unit === "string" ? quota.unit : unit;
    addWindow("sub2api-quota", "额度", quota.used, quota.limit, null, null, quotaUnit);
  }

  const rateMinutes: Record<string, number> = { "5h": 300, "1d": 1440, "7d": 10080 };
  const rateTitles: Record<string, string> = { "5h": "5h 额度", "1d": "日限额", "7d": "周限额" };
  const rates = Array.isArray(data.rate_limits) ? data.rate_limits : [];
  rates.forEach((rate, index) => {
    const row = asDict(rate);
    if (!row) return;
    // Python: str(rate.get("window") or f"rate-{index}")——假值（None/空串/0）都落到序号兜底
    const name = String(row.window || `rate-${index}`);
    const lower = name.toLowerCase();
    addWindow(
      `sub2api-${name}`, rateTitles[lower] ?? `${name} 限额`,
      row.used, row.limit, rateMinutes[lower] ?? null, row.reset_at);
  });

  const details: Array<Dict> = [];
  const balance = providerNumber(data.balance);
  if (balance !== null) details.push({ label: "余额", value: providerMoney(balance, unit) });
  const usage = asDict(data.usage) ?? {};
  for (const [key, label] of [["today", "今日"], ["total", "累计"]] as const) {
    const row = asDict(usage[key]);
    if (!row || !Object.keys(row).length) continue;
    // 计数缺失按 0，但出现非法值（非整数的数字/字符串）要像原版一样抛错
    const requests = row.requests === undefined || row.requests === null
      ? 0 : providerInteger(row.requests);
    const tokens = row.total_tokens === undefined || row.total_tokens === null
      ? 0 : providerInteger(row.total_tokens);
    if (requests === null || tokens === null) {
      throw new ValueError(`sub2api ${key} usage counts must be integers`);
    }
    const cost = providerNumber(row.actual_cost) ?? 0;
    details.push({ label: `${label}请求`, value: requests.toLocaleString("en-US") });
    const tokenRow: Dict = { label: `${label} Token`, value: tokens.toLocaleString("en-US") };
    if (cost) tokenRow.secondary = providerMoney(cost);
    details.push(tokenRow);
  }

  // Python 的 `A or B`：订阅里没有或为空值都退回顶层 expires_at
  const expiration = subscription?.expires_at || data.expires_at;
  const expirationEpoch = providerEpoch(expiration);
  if (expirationEpoch) details.push({ label: "套餐到期", value: String(expirationEpoch) });
  const planName = typeof data.planName === "string" ? data.planName : null;
  return {
    available: Boolean(windows.length || details.length || planName),
    plan: planName,
    account: null,
    windows,
    details,
    source: "sub2api",
    updated: Math.trunc(updated ?? epochSeconds()),
    stale: false,
  };
}

/** 与 Python ValueError 对齐：http.ts 里的错误类也都用 name 标注 Python 异常类型 */
class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

/** 对应 fetch_sub2api_quota */
export async function fetchSub2ApiQuota(deps: QuotaDeps): Promise<Dict> {
  const apiKey = secretValue(deps, "SUB2API_API_KEY", "sub2api", "sub2api_api_key");
  const baseUrl = providerConfigString("SUB2API_BASE_URL", "sub2api_base_url", deps);
  // 硬性前置：Base URL 必须过面板同一套白名单，非法地址不拼 URL、不发请求
  if (baseUrl && !validSub2APIBaseURL(baseUrl)) return {};
  const usageUrl = baseUrl ? sub2apiUsageUrl(baseUrl, localTimezoneName(deps.env)) : null;
  if (!apiKey || !usageUrl) return {};
  const marker = providerCredentialMarker("sub2api", apiKey, usageUrl);
  const now = Math.trunc(deps.now());
  const cached = cachedProviderQuota("sub2api", marker, PROVIDER_QUOTA_TTL, now);
  if (cached) return cached;
  try {
    const payload = await deps.request(usageUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutSeconds: 15,
    });
    if (asDict(payload) && (payload as Dict).isValid === false) {
      throw new Error("sub2api rejected the API key");
    }
    const quota = normalizeSub2ApiQuota(payload);
    saveProviderQuotaCache("sub2api", marker, quota, deps.now());
    return quota;
  } catch (error) {
    const fallback = cachedProviderQuota("sub2api", marker, PROVIDER_QUOTA_FALLBACK_TTL, now, true);
    if (fallback) return fallback;
    throw error;
  }
}

/** 对应 scan_sub2api_quota */
export async function scanSub2ApiQuota(deps: QuotaDeps): Promise<Dict> {
  if (!providerQuotaEnabled("sub2api", deps)) return {};
  return fetchSub2ApiQuota(deps);
}

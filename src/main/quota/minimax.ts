/**
 * MiniMax Token Plan 额度：对应 usage.30s.py 的 7708-7867。
 *
 * 本地库只有 token 没有额度。额度要拿 Token Plan 的 Subscription Key（sk-cp-…）
 * 去官方接口查，所以默认关闭：用户在设置里填了 Key 才会联网。
 *
 * 返回的 model_remains 有几种写法并存，桌面端自己也是分别解析的：
 *   current_interval_remaining_percent        剩余百分比（数字）
 *   current_interval_used/total_percent       已用 / 总额（字符串，加赠时总额 > 100）
 *   current_interval_total/usage_count        次数；注意 usage_count 其实是「剩余」次数
 * weekly 同理（current_weekly_*），*_status == 3 表示不限量。
 * 中国区与国际区的 Key 不通用：拿错区域的 Key 会得到 1004，此时换另一个区域再试。
 */
import {
  PROVIDER_QUOTA_FALLBACK_TTL, PROVIDER_QUOTA_TTL, cachedProviderQuota, epochSeconds,
  latestCachedProviderQuota, providerConfigString, providerCredentialMarker, providerEpoch,
  providerNumber, providerQuotaEnabled, providerQuotaRecentAttemptResult, providerWindow,
  saveProviderQuotaAttempt, saveProviderQuotaCache,
} from "../../core/providerQuota";
import { QuotaDeps, secretValue } from "./context";
import { BadJsonError, HttpError, ResponseTooLargeError } from "./http";

/** 对应 _MINIMAX_QUOTA_ENDPOINTS：同一区域有新旧两个入口 */
const MINIMAX_QUOTA_ENDPOINTS: Record<string, string[]> = {
  cn: [
    "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains",
    "https://www.minimax.cn/v1/token_plan/remains",
  ],
  global: [
    "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
    "https://www.minimax.io/v1/token_plan/remains",
  ],
};
/** 对应 _MINIMAX_UNAUTHORIZED：区域不匹配时接口返回的业务码 */
const MINIMAX_UNAUTHORIZED = 1004;
/** 对应 _MINIMAX_UNLIMITED_STATUS */
const MINIMAX_UNLIMITED_STATUS = 3;

/** 对应 _minimax_number：接口把百分比写成 "37.5%" 这类字符串，剥掉 % 再按数字读 */
export function minimaxNumber(value: unknown): number | null {
  let raw = value;
  if (typeof raw === "string") raw = raw.trim().replace(/%+$/, "").trim();
  return providerNumber(raw);
}

/** 对应 _minimax_window_usage：返回 [已用百分比, 说明]；拿不到时百分比为 null */
export function minimaxWindowUsage(
  entry: Record<string, any>, prefix: string,
): [number | null, string | null] {
  if (providerNumber(entry[`${prefix}_status`]) === MINIMAX_UNLIMITED_STATUS) {
    return [0, "不限量"];
  }
  const remaining = minimaxNumber(entry[`${prefix}_remaining_percent`]);
  if (remaining !== null) return [100 - remaining, null];
  const used = minimaxNumber(entry[`${prefix}_used_percent`]);
  if (used !== null) {
    // 加赠时段总额 > 100，已用要按总额折算回百分比
    const total = minimaxNumber(entry[`${prefix}_total_percent`]);
    return [total && total > 0 ? used / total * 100 : used, null];
  }
  const total = providerNumber(entry[`${prefix}_total_count`]);
  const left = providerNumber(entry[`${prefix}_usage_count`]);
  if (total && total > 0 && left !== null) {
    // usage_count 是「剩余」次数，不是已用；负数按没用过处理
    const usedCount = Math.max(0, total - left);
    return [usedCount / total * 100,
      `${Math.trunc(usedCount).toLocaleString("en-US")}/${Math.trunc(total).toLocaleString("en-US")} 次`];
  }
  return [null, null];
}

/** 对应 _minimax_reset：优先给定的结束时刻，否则用剩余毫秒数推算 */
export function minimaxReset(
  entry: Record<string, any>, endKey: string, remainsKey: string, now: number,
): number | null {
  const reset = providerEpoch(entry[endKey]);
  if (reset) return reset;
  const remains = providerNumber(entry[remainsKey]);
  return remains && remains > 0 ? Math.trunc(now + remains / 1000) : null;
}

/** 对应 _minimax_status_code：业务码藏在 base_resp.status_code 里 */
export function minimaxStatusCode(payload: unknown): number | null {
  const base = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, any>).base_resp : null;
  const code = base && typeof base === "object" && !Array.isArray(base)
    ? providerNumber((base as Record<string, any>).status_code) : null;
  return code !== null ? Math.trunc(code) : null;
}

/** 对应 _normalize_minimax_quota */
export function normalizeMinimaxQuota(
  payload: unknown, region = "cn", updated?: number,
): Record<string, any> {
  const now = Math.trunc(updated ?? epochSeconds());
  const rawEntries = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, any>).model_remains : null;
  const entries = (Array.isArray(rawEntries) ? rawEntries : [])
    .filter((item): item is Record<string, any> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item));

  // 视频额度独立成环，其余（general 或第一个非视频条目）算文本额度
  const isVideo = (item: Record<string, any>) =>
    String(item.model_name || "").toLowerCase().includes("video");
  const text = entries.find((item) => item.model_name === "general")
    ?? entries.find((item) => !isVideo(item));

  const windows: ReturnType<typeof providerWindow>[] = [];
  if (text) {
    for (const [windowId, title, prefix, endKey, remainsKey, minutes] of [
      ["minimax-5h", "5小时额度", "current_interval", "end_time", "remains_time", 300],
      ["minimax-weekly", "周额度", "current_weekly", "weekly_end_time", "weekly_remains_time", 10080],
    ] as const) {
      const [used, detail] = minimaxWindowUsage(text, prefix);
      if (used !== null) {
        windows.push(providerWindow(windowId, title, used,
          minimaxReset(text, endKey, remainsKey, now), minutes, detail));
      }
    }
  }
  // 只有真给了总额的视频条目才画环，否则整段响应里随便一个视频占位都会生成额度
  const video = entries.find((item) => isVideo(item)
    && (providerNumber(item.current_interval_total_count) ?? 0) > 0);
  if (video) {
    const [used, detail] = minimaxWindowUsage(video, "current_interval");
    if (used !== null) {
      windows.push(providerWindow("minimax-video", "视频额度", used,
        minimaxReset(video, "end_time", "remains_time", now), null, detail));
    }
  }
  return {
    available: Boolean(windows.length),
    plan: windows.length ? "Token Plan" : null,
    account: null,
    windows,
    details: [],
    source: "minimax-api",
    region,
    updated: now,
    stale: false,
  };
}

/** 对应 _minimax_regions：显式配置优先，否则上次查通的区域先试，省掉一次注定 1004 的请求 */
export function minimaxRegions(deps: QuotaDeps): string[] {
  const configured = (providerConfigString("TOKEI_MINIMAX_REGION", "minimax_region", deps) ?? "").toLowerCase();
  if (MINIMAX_QUOTA_ENDPOINTS[configured]) return [configured];
  const last = latestCachedProviderQuota("minimax", null, Math.trunc(deps.now())) ?? {};
  return last.region === "global" ? ["global", "cn"] : ["cn", "global"];
}

/** 对应 _minimax_quota_payload：同一区域有新旧两个入口；404 或非 JSON 换下一个，网络错误直接抛出 */
async function minimaxQuotaPayload(
  deps: QuotaDeps, apiKey: string, region: string,
): Promise<any> {
  let lastError: unknown = null;
  for (const url of MINIMAX_QUOTA_ENDPOINTS[region]) {
    try {
      return await deps.request(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutSeconds: 8,
      });
    } catch (error) {
      // 只接住原版 (RuntimeError, ValueError) 对应的三类：HTTP 状态异常、
      // 响应过大、非 JSON——换下一个入口；真正的网络故障照原样上抛
      if (error instanceof HttpError || error instanceof ResponseTooLargeError
        || error instanceof BadJsonError) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error("MiniMax quota endpoint unavailable");
}

/**
 * 对应 fetch_minimax_quota。凭据走 secretValue：DPAPI 凭据名固定为 minimax，
 * 环境变量 TOKEI_MINIMAX_API_KEY / config.json 的 minimax_api_key 仍按原顺序生效。
 */
export async function fetchMinimaxQuota(deps: QuotaDeps): Promise<Record<string, any>> {
  const apiKey = secretValue(deps, "TOKEI_MINIMAX_API_KEY", "minimax", "minimax_api_key");
  if (!apiKey) return {};
  const marker = providerCredentialMarker("minimax-remains-v1", apiKey);
  const now = Math.trunc(deps.now());
  const cached = cachedProviderQuota("minimax", marker, PROVIDER_QUOTA_TTL, now);
  if (cached) return cached;
  const fallback = cachedProviderQuota("minimax", marker, PROVIDER_QUOTA_FALLBACK_TTL, now, true);
  // 失败后同样按 TTL 节流，Key 填错时不至于每次刷新都去敲接口。
  if (providerQuotaRecentAttemptResult("minimax", marker, PROVIDER_QUOTA_TTL, now)) {
    return fallback ?? {};
  }
  try {
    for (const region of minimaxRegions(deps)) {
      const payload = await minimaxQuotaPayload(deps, apiKey, region);
      const code = minimaxStatusCode(payload);
      if (code === MINIMAX_UNAUTHORIZED) continue;
      if (code !== null && code !== 0) throw new Error(`MiniMax quota error ${code}`);
      const quota = normalizeMinimaxQuota(payload, region, now);
      if (!quota.available) {
        saveProviderQuotaAttempt("minimax", marker, deps.now(), "empty");
        return fallback ?? {};
      }
      saveProviderQuotaCache("minimax", marker, quota, deps.now());
      return quota;
    }
    // 原版抛 PermissionError；JS 没有这一层，用同文案的 Error 顶上
    throw new Error("MiniMax rejected the Token Plan key");
  } catch (error) {
    saveProviderQuotaAttempt("minimax", marker, deps.now());
    if (fallback) return fallback;
    throw error;
  }
}

/** 对应 scan_minimax_quota：默认关闭，填了 Key 且在设置里打开才会联网 */
export async function scanMinimaxQuota(deps: QuotaDeps): Promise<Record<string, any>> {
  if (!providerQuotaEnabled("minimax", deps)) return {};
  return fetchMinimaxQuota(deps);
}

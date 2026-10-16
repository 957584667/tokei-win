/**
 * Grok Bot 额度：对应 usage.30s.py 的 6578-6666（fetch_grok_bot_quota + scan + 用量兜底）。
 *
 * 归一化、cursor 会话、原生 bridge 的取数 helper 都在 cursor.ts 里（Python 6319-6598 那段
 * 属于 cursor 区间，被 fetch_cursor_quota 直接调用），本文件只负责组装 fetch_grok_bot_quota：
 * 先试「本机 Grok Bot 账号」这条路（要 active account id + 授权标记 + helper 进程），
 * 走不通就退回「复用 cursor 会话」——Windows 上没有 macOS 那套 Keychain helper，
 * TOKEI_GROK_BOT_HELPER 未配时本机这条路直接返回空，额度全靠 cursor 那条回退路拿到。
 */
import {
  PROVIDER_QUOTA_FALLBACK_TTL, PROVIDER_QUOTA_TTL, cachedProviderQuota, latestCachedProviderQuota,
  providerCredentialMarker, providerQuotaEnabled, providerQuotaRecentAttemptResult, providerUsageInt,
  saveProviderQuotaAttempt, saveProviderQuotaCache,
} from "../../core/providerQuota";
import { QuotaDeps } from "./context";
import {
  CursorSession, cursorSession, fetchCursorQuota, grokBotActiveAccountId, grokBotAuthorizationGeneration,
  grokBotHelperSandUsage, grokBotProviderData, grokBotQuotaFromCursor, grokBotRepairAuthorizationMarker,
} from "./cursor";

/**
 * 对应 _grok_bot_usage_only_fallback：额度没了但缓存里还留着用量时，返回一个只有 usage 的空壳，
 * 面板至少还能画曲线。用量必须真有 tokens 才算数。
 * nowEpoch 对应原版隐式的 datetime.now()：这里接注入时钟，让「未来时间」的过滤与用例一致。
 */
export function grokBotUsageOnlyFallback(nowEpoch?: number): Record<string, any> {
  const cached = latestCachedProviderQuota("grok_bot", null, nowEpoch, true);
  const usage = cached && typeof cached === "object" ? (cached as Record<string, any>).usage : null;
  const ranges = usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, any>).ranges : null;
  const hasTokens = ranges && typeof ranges === "object" && !Array.isArray(ranges)
    && Object.values(ranges as Record<string, any>).some(
      (row) => row && typeof row === "object" && !Array.isArray(row) && providerUsageInt(row.tokens) > 0);
  if (!hasTokens) return {};
  return {
    available: false,
    plan: null,
    account: null,
    windows: [],
    details: [],
    usage,
    source: "cache",
    updated: (cached as Record<string, any>).updated ?? null,
    stale: true,
  };
}

/** 对应 fetch_grok_bot_quota：session 传入时跳过本机那条路，直接用给定 cursor 会话回退 */
export async function fetchGrokBotQuota(
  deps: QuotaDeps, session?: CursorSession | null,
): Promise<Record<string, any>> {
  const now = Math.trunc(deps.now());
  let nativeFallback = latestCachedProviderQuota("grok_bot", PROVIDER_QUOTA_FALLBACK_TTL, now, true)
    ?? grokBotUsageOnlyFallback(now);

  if (session === undefined || session === null) {
    const accountId = grokBotActiveAccountId();
    let authorizationGeneration = grokBotAuthorizationGeneration();
    if (accountId && authorizationGeneration === null) {
      // 有账号但授权标记丢了：先查近期是否已试过修复，没试过才跑 helper --grok-bot-verify
      const repairMarker = providerCredentialMarker("grok-bot-auth-repair-v1", accountId);
      const recentRepair = providerQuotaRecentAttemptResult("grok_bot_auth", repairMarker, PROVIDER_QUOTA_TTL, now);
      if (recentRepair === null) {
        if (grokBotRepairAuthorizationMarker()) {
          authorizationGeneration = grokBotAuthorizationGeneration();
        } else {
          saveProviderQuotaAttempt("grok_bot_auth", repairMarker, now, "failed");
        }
      }
    }
    if (accountId && authorizationGeneration !== null) {
      const nativeMarker = providerCredentialMarker("grok-bot-account-v1", accountId, authorizationGeneration);
      const cached = cachedProviderQuota("grok_bot", nativeMarker, PROVIDER_QUOTA_TTL, now);
      if (cached) return cached;
      nativeFallback = cachedProviderQuota("grok_bot", nativeMarker, PROVIDER_QUOTA_FALLBACK_TTL, now, true)
        ?? nativeFallback;
      const recentAttempt = providerQuotaRecentAttemptResult("grok_bot", nativeMarker, PROVIDER_QUOTA_TTL, now);
      if (recentAttempt === "empty") return {};
      if (recentAttempt === null) {
        const payload = grokBotHelperSandUsage();
        if (payload !== null) {
          const quota = grokBotProviderData(payload, { updated: payload.updated });
          if (Object.keys(quota).length) {
            saveProviderQuotaCache("grok_bot", nativeMarker, quota, deps.now());
            return quota;
          }
          // helper 明确报「额度取到了但没额度」→ 记 empty，短窗口内不再联网
          if (payload.quotaFetched === true || !("quotaFetched" in payload)) {
            saveProviderQuotaAttempt("grok_bot", nativeMarker, now, "empty");
            return {};
          }
        }
        saveProviderQuotaAttempt("grok_bot", nativeMarker, now, "failed");
      }
    }
  }

  const resolvedSession = session ?? cursorSession(deps);
  if (!resolvedSession) return nativeFallback;
  const marker = providerCredentialMarker("cursor-usage-v1", resolvedSession.marker);
  const cached = cachedProviderQuota("grok_bot", marker, PROVIDER_QUOTA_TTL, now);
  if (cached) return cached;
  // 强制刷 cursor（顺带把 grok_bot 缓存按同一 marker 写进去，见 fetch_cursor_quota 尾部）
  const cursorQuota = await fetchCursorQuota(deps, { session: resolvedSession, force: true });
  const afterRefresh = cachedProviderQuota("grok_bot", marker, PROVIDER_QUOTA_TTL, now);
  if (afterRefresh) return afterRefresh;
  const quota = grokBotQuotaFromCursor(cursorQuota);
  if (Object.keys(quota).length) {
    saveProviderQuotaCache("grok_bot", marker, quota, deps.now());
    return quota;
  }
  return cachedProviderQuota("grok_bot", marker, PROVIDER_QUOTA_FALLBACK_TTL, now, true) ?? nativeFallback;
}

/** 对应 scan_grok_bot_quota */
export async function scanGrokBotQuota(deps: QuotaDeps): Promise<Record<string, any>> {
  if (!providerQuotaEnabled("grok_bot", deps)) return {};
  return fetchGrokBotQuota(deps);
}

/**
 * Zed 额度：对应 usage.30s.py 的 6672-6822。
 *
 * 凭据来自 Zed 自己的登录（settings.json 里的 server_url / credentials_url）+
 * TOKEI_ZED_USER_ID / zed_user_id、zed_access_token。少了任何一项就返回 {}（不联网）。
 *
 * 这一路是全项目的「样板 fetcher」，其余 provider 照它的骨架写：
 * 开关 → 凭据 → marker → 5 分钟缓存 → 请求 → 归一化 → 落缓存 → 失败退 1 小时旧读数。
 */
import * as path from "path";
import { HOME, isFile, loadJson } from "../../core/paths";
import {
  PROVIDER_QUOTA_FALLBACK_TTL, PROVIDER_QUOTA_TTL, cachedProviderQuota, epochSeconds,
  providerConfigString, providerCredentialMarker, providerEpoch, providerNumber,
  providerQuotaEnabled, providerWindow, saveProviderQuotaCache,
} from "../../core/providerQuota";
import { QuotaDeps } from "./context";

const PLAN_NAMES: Record<string, string> = {
  zed_free: "Zed Free", zed_pro: "Zed Pro",
  zed_pro_trial: "Zed Pro Trial", zed_student: "Zed Student",
  zed_business: "Zed Business", student: "Student",
  vip: "VIP", zed_vip: "Zed VIP",
};

export interface ZedConnection {
  service: string;
  api_url: string;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 对应 _zed_connection_settings：非官方服务且 credentials_url 与 server_url 不一致就当不可信 */
export function zedConnectionSettings(raw: unknown): ZedConnection | null {
  const settings = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, any>;
  const credentials = str(settings.credentials_url);
  const serverRaw = str(settings.server_url);
  const server = serverRaw ? serverRaw.replace(/\/+$/, "") : "https://zed.dev";
  const service = credentials ?? server;
  const trusted = server === "https://zed.dev" || server === "https://staging.zed.dev";
  if (!trusted && credentials && credentials.replace(/\/+$/, "") !== server) return null;
  let parsed: URL;
  try {
    parsed = new URL(server);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password
    || parsed.search || parsed.hash) return null;
  const apiBase = trusted ? "https://cloud.zed.dev" : server;
  return { service, api_url: `${apiBase}/client/users/me` };
}

/**
 * 对应 _load_zed_connection_settings。Windows 上 Zed 把设置放在 %APPDATA%\Zed，
 * 所以候选路径比原版多一条；配置项 zed_settings_path / TOKEI_ZED_SETTINGS 仍然最优先。
 */
export function loadZedConnectionSettings(deps: QuotaDeps, file?: string | null): ZedConnection | null {
  const configured = file ?? providerConfigString("TOKEI_ZED_SETTINGS", "zed_settings_path", deps);
  const candidates = configured
    ? [configured]
    : [path.join(HOME, ".config", "zed", "settings.json"),
       path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "Zed", "settings.json")];
  const target = candidates.find((item) => isFile(item));
  const settings = target ? loadJson<unknown>(target, {}) : {};
  return zedConnectionSettings(settings);
}

/** 对应 _zed_plan_name */
export function zedPlanName(raw: unknown): string | null {
  const value = str(raw);
  if (!value) return null;
  const key = value.toLowerCase();
  if (PLAN_NAMES[key]) return PLAN_NAMES[key];
  return key.split("_").filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** 对应 _normalize_zed_quota */
export function normalizeZedQuota(payload: unknown, updated?: number): Record<string, any> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const data = payload as Record<string, any>;
  const user = (data.user && typeof data.user === "object" ? data.user : {}) as Record<string, any>;
  const plan = (data.plan && typeof data.plan === "object" ? data.plan : {}) as Record<string, any>;
  const usage = (plan.usage && typeof plan.usage === "object" ? plan.usage : {}) as Record<string, any>;
  const predictions = (usage.edit_predictions && typeof usage.edit_predictions === "object"
    ? usage.edit_predictions : {}) as Record<string, any>;
  const used = Math.max(0, providerNumber(predictions.used) ?? 0);
  let limitValue = predictions.limit;
  if (limitValue && typeof limitValue === "object" && !Array.isArray(limitValue)) {
    limitValue = (limitValue as Record<string, any>).limited;
  }
  const windows: ReturnType<typeof providerWindow>[] = [];
  if (typeof limitValue === "string" && limitValue.toLowerCase() === "unlimited") {
    windows.push(providerWindow("zed-predictions", "Edit Predictions", 0, undefined, undefined, "Unlimited"));
  } else {
    const limit = providerNumber(limitValue);
    if (limit !== null && limit > 0) {
      const clamped = Math.min(used, limit);
      windows.push(providerWindow(
        "zed-predictions", "Edit Predictions", (clamped / limit) * 100,
        undefined, undefined, `${Math.trunc(clamped)} / ${Math.trunc(limit)} predictions`));
    }
  }

  const period = (plan.subscription_period && typeof plan.subscription_period === "object"
    ? plan.subscription_period : {}) as Record<string, any>;
  const start = providerEpoch(period.started_at);
  const end = providerEpoch(period.ended_at);
  const now = Math.trunc(updated ?? epochSeconds());
  if (start && end && end > start) {
    windows.push(providerWindow("zed-cycle", "订阅周期",
      ((now - start) / (end - start)) * 100, end, Math.trunc((end - start) / 60)));
  }
  if (plan.has_overdue_invoices === true) {
    windows.push(providerWindow(
      "zed-overdue", "账单", undefined, undefined, undefined, "Overdue invoices", false));
  }

  const details: Array<Record<string, string>> = [];
  const accountName = str(user.name);
  if (accountName) details.push({ label: "账号", value: accountName });
  const organizationPlans = (data.plans_by_organization && typeof data.plans_by_organization === "object"
    ? data.plans_by_organization : {}) as Record<string, any>;
  const defaultOrganizationId = idToString(data.default_organization_id);
  const planNames: string[] = [];
  const organizations = Array.isArray(data.organizations) ? data.organizations : [];
  for (const organization of organizations) {
    if (!organization || typeof organization !== "object" || Array.isArray(organization)) continue;
    const organizationId = idToString((organization as Record<string, any>).id);
    const name = str((organization as Record<string, any>).name);
    if (!organizationId || !name) continue;
    const planName = zedPlanName(organizationPlans[organizationId]);
    if (!planName) continue;
    if (!planNames.includes(planName)) planNames.push(planName);
    const detail: Record<string, string> = { label: name, value: planName };
    if (organizationId === defaultOrganizationId) detail.secondary = "当前组织";
    details.push(detail);
  }
  const displayedPlan = planNames.length ? planNames.join(" + ") : zedPlanName(plan.plan_v3);
  return {
    available: Boolean(windows.length || Object.keys(plan).length || planNames.length),
    plan: displayedPlan,
    account: typeof user.github_login === "string" ? user.github_login : null,
    windows,
    details,
    source: "zed-cloud",
    updated: now,
    stale: false,
  };
}

/** Python 的 str|int 判定：布尔值要单独排除 */
function idToString(value: unknown): string | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** 对应 fetch_zed_quota */
export async function fetchZedQuota(deps: QuotaDeps): Promise<Record<string, any>> {
  const userId = providerConfigString("TOKEI_ZED_USER_ID", "zed_user_id", deps);
  const token = providerConfigString("TOKEI_ZED_ACCESS_TOKEN", "zed_access_token", deps);
  const connection = loadZedConnectionSettings(deps);
  if (!userId || !token || !connection) return {};
  const marker = providerCredentialMarker("zed", userId, token, connection.service, connection.api_url);
  const now = Math.trunc(deps.now());
  const cached = cachedProviderQuota("zed", marker, PROVIDER_QUOTA_TTL, now);
  if (cached) return cached;
  try {
    const payload = await deps.request(connection.api_url, {
      headers: {
        Authorization: `${userId} ${token}`,
        // Zed Cloud 会拒绝默认脚本 UA，原版特意写了 User-Agent
        "User-Agent": "Tokei/1.0",
      },
    });
    const quota = normalizeZedQuota(payload);
    saveProviderQuotaCache("zed", marker, quota, deps.now());
    return quota;
  } catch (error) {
    const fallback = cachedProviderQuota("zed", marker, PROVIDER_QUOTA_FALLBACK_TTL, now, true);
    if (fallback) return fallback;
    throw error;
  }
}

/** 对应 scan_zed_quota */
export async function scanZedQuota(deps: QuotaDeps): Promise<Record<string, any>> {
  if (!providerQuotaEnabled("zed", deps)) return {};
  return fetchZedQuota(deps);
}

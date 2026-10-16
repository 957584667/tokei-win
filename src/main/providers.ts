/**
 * Provider 额度的设置层：对应 macOS 的 ProviderCredentialStore + SyncManager.providerSetting
 * + PanelView 的 validSub2APIBaseURL / saveProviderSettings。
 *
 * 分工：密钥走 DPAPI 文件（等价 Keychain），非密文设置（Base URL、区域）走
 * ~/.tokei/config.json 且键名与 Python、macOS 完全一致，两边读到的是同一份配置。
 *
 * 与 macOS 的一处有意差异：原版把 {provider}_quota_enabled 绑在卡片显隐上
 * （PanelView.swift:3021-3035），这里改成「填了必要凭据才开」。原因是这份 config.json
 * 与 Python 采集器共用，若跟随显隐就会在用户没填 Key 的情况下让 Python 去联网取数。
 */
import { Settings } from "./settings";

/** 对应 ProviderSecret（ProviderCredentialStore.swift:6-10） */
export const PROVIDER_SECRETS = ["sub2api", "zai", "minimax"] as const;
export type ProviderSecret = (typeof PROVIDER_SECRETS)[number];

/** 对应 SyncManager.providerSettingKeys 里面板真正暴露的两项 */
export const PROVIDER_SETTING_KEYS = ["sub2api_base_url", "zai_region"] as const;

export const ZAI_REGIONS = ["global", "bigmodel-cn"] as const;
export type ZaiRegion = (typeof ZAI_REGIONS)[number];

/** 传给凭据文件的名称白名单：与 index.ts 的落盘文件名规则保持一致 */
export const CRED_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export function isProviderSecret(name: unknown): name is ProviderSecret {
  return typeof name === "string" && CRED_NAME.test(name)
    && (PROVIDER_SECRETS as readonly string[]).includes(name);
}

export function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 对应 validSub2APIBaseURL（PanelView.swift:3278-3287）：
 * https 任意主机；http 只允许本机；带账号密码、查询串或锚点的地址一律拒绝。
 */
export function validSub2APIBaseURL(value: string): boolean {
  const raw = clean(value);
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  // 去掉 IPv6 的方括号才能和 Swift 的 URLComponents.host 对上（"::1"）
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (scheme === "https") return true;
  if (scheme !== "http") return false;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** 对应 zai_region 的读法：只认两个枚举值，其余回落 global（PanelView.swift:3100-3106） */
export function zaiRegion(settings: Settings): ZaiRegion {
  const v = clean(settings?.zai_region).toLowerCase();
  return (ZAI_REGIONS as readonly string[]).includes(v) ? (v as ZaiRegion) : "global";
}

/**
 * 对应 setProviderQuotaEnabled 的批量落点：没凭据就不开，清掉凭据即关。
 * MiniMax 的规则照 PanelView.swift:3018（enabled = 有 Key），Sub2API 还要求 Base URL
 * （没 URL 无处可请求），z.ai 只要求 Key（区域有默认值）。
 */
export function providerQuotaFlags(
  stored: Record<ProviderSecret, boolean>, settings: Settings,
): Pick<Settings, "sub2api_quota_enabled" | "zai_quota_enabled" | "minimax_quota_enabled"> {
  const hasUrl = Boolean(clean(settings?.sub2api_base_url));
  return {
    sub2api_quota_enabled: Boolean(stored.sub2api && hasUrl),
    zai_quota_enabled: Boolean(stored.zai),
    minimax_quota_enabled: Boolean(stored.minimax),
  };
}

/** 面板回填用的只读视图：对应 loadProviderSettings（PanelView.swift:3191-3197） */
export function providerSettingsView(settings: Settings) {
  return {
    sub2api_base_url: clean(settings?.sub2api_base_url),
    zai_region: zaiRegion(settings),
  };
}

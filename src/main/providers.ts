/**
 * Provider 额度的设置层：对应 macOS 的 ProviderCredentialStore + SyncManager.providerSetting
 * + PanelView 的 validSub2APIBaseURL / saveProviderSettings。
 *
 * 分工：密钥走 DPAPI 文件（等价 Keychain），非密文设置（Base URL、区域）走
 * ~/.tokei/config.json 且键名与 Python、macOS 完全一致，两边读到的是同一份配置。
 *
 * 与 macOS 的一处有意差异：原版的 {provider}_quota_enabled 只跟随卡片显隐
 * （PanelView.swift:3128-3158），这里在显隐之外还要求凭据齐不齐。原因是这份 config.json
 * 与 Python 采集器共用，若只跟随显隐，用户点开 Sub2API/z.ai 卡却没填 Key 时
 * Python 就会去联网取数。Cursor/Zed/Antigravity/Devin 不需要用户填东西，照原版只看显隐。
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
 * 对应 setProviderQuotaEnabled 那一组落点（PV:3128-3158 + 3568-3587）：卡片显镜像成
 * config.json 里的 8 个开关，外加 Qoder Desktop 的本机数据开关。
 * MiniMax 的规则照 PV:3140（enabled = 卡片开着 && 存了 Key）；Sub2API、z.ai 在原版只看
 * 显隐，这里额外要求凭据齐不齐（见文件头那段差异说明），Cursor/Zed/Antigravity/Devin
 * 用的是各家应用自己落下的登录态，没有需要用户填的密钥，所以跟原版一样只看显隐。
 */
export function quotaMirror(
  stored: Record<ProviderSecret, boolean>, settings: Settings,
): SettingsMirror {
  const shown = (card: string) => !(settings?.disabled_tools ?? []).includes(card);
  const hasUrl = Boolean(clean(settings?.sub2api_base_url));
  return {
    antigravity_quota_enabled: shown("gemini"),
    devin_quota_enabled: shown("devin"),
    cursor_quota_enabled: shown("cursor"),
    zed_quota_enabled: shown("zed"),
    sub2api_quota_enabled: shown("sub2api") && hasUrl && Boolean(stored.sub2api),
    zai_quota_enabled: shown("zai") && Boolean(stored.zai),
    minimax_quota_enabled: shown("minimax") && Boolean(stored.minimax),
    qoder_ide_enabled: shown("qoder"),
  };
}

/** quotaMirror 的落点集合：这几个键全部进 config.json */
export type SettingsMirror = Record<
  "antigravity_quota_enabled" | "devin_quota_enabled" | "cursor_quota_enabled"
  | "zed_quota_enabled" | "sub2api_quota_enabled" | "zai_quota_enabled"
  | "minimax_quota_enabled" | "qoder_ide_enabled", boolean>;

/** 面板回填用的只读视图：对应 loadProviderSettings（PanelView.swift:3191-3197） */
export function providerSettingsView(settings: Settings) {
  return {
    sub2api_base_url: clean(settings?.sub2api_base_url),
    zai_region: zaiRegion(settings),
  };
}

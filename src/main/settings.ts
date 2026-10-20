/**
 * 设置持久化。macOS 版散落在 UserDefaults，Windows 没有等价的每应用 KV，
 * 统一落到 ~/.tokei/config.json —— 与 Python 采集器共用同一个文件，
 * 键名沿用原版（device_id / sync_dir / grok_live_quota_enabled / qwenwork_quota_enabled），
 * 这样同一份配置在两个平台之间可迁移。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TOKEI_DIR, loadJson, saveJson } from "../core/paths";

export const CONFIG_FILE = path.join(TOKEI_DIR, "config.json");

export type MenuBarStyle = "system" | "color" | "symbols" | "dots" | "compact" | "artistic" | "palm";
export type MenuBarDensity = "full" | "lowest" | "icon";
export type QuotaSourceId =
  | "claude5h" | "claudeWeek" | "claudeFable"
  | "codex5h" | "codexWeek"
  | "kimi5h" | "kimiSubscription" | "grok";

export interface Settings {
  disabled_tools: string[];
  menu_style: MenuBarStyle;
  menu_density: MenuBarDensity;
  /** 状态栏显示哪些额度窗口；未设置的项按 MenuBarQuotaSource.defaultEnabled */
  menu_quota_enabled: Partial<Record<QuotaSourceId, boolean>>;
  autostart: boolean;
  /** 防休眠的低电量保护：对应 macOS 的 UserDefaults("keepAwakeLowBattery")，默认开 */
  keep_awake_low_battery: boolean;
  sit_reminder_enabled: boolean;
  sit_reminder_minutes: number;
  panel_tab: string;
  device_id: string;
  sync_dir: string;
  grok_live_quota_enabled: boolean;
  qwenwork_quota_enabled: boolean;
  /** 对应 @AppStorage("grokBotQuotaEnabled")（PV:94）：Grok Bot 用自己的开关，不跟卡片显隐 */
  grok_bot_quota_enabled: boolean;
  /** 以下键名与 Python / macOS 共用同一份 config.json，改名就等于两边失联 */
  sub2api_base_url: string;
  zai_region: string;
  sub2api_quota_enabled: boolean;
  zai_quota_enabled: boolean;
  minimax_quota_enabled: boolean;
  /** 卡片显隐镜像出来的四路（PV:3131-3150）：Antigravity/Devin 默认开，Cursor/Zed 默认关 */
  antigravity_quota_enabled: boolean;
  devin_quota_enabled: boolean;
  cursor_quota_enabled: boolean;
  zed_quota_enabled: boolean;
  /** 对应 setQoderIdeEnabled：Qoder Desktop 采集器的本机数据开关，Python 与 macOS 同名 */
  qoder_ide_enabled: boolean;
  /** 对应 PanelFontSize（PanelTypography.swift:4-22）：只缩放字号，scale 小 1 / 大 1.12 */
  panel_font_size: PanelFontSize;
  locale: string;
  /** 对应 @AppStorage(ActivityReporter.enabledKey)="shareBasicActivity"（PV:101）：默认开、可关 */
  share_basic_activity: boolean;
}

export type PanelFontSize = "small" | "large";
export const PANEL_FONT_SCALE: Record<PanelFontSize, number> = { small: 1, large: 1.12 };

/**
 * 对应 @AppStorage 的每卡默认值：Cursor/Zed/Sub2API/z.ai 四张卡默认关（PV:65-68）。
 * Windows 侧只有 disabled_tools 一个列表，所以首次运行（config 里还没有这个键时）
 * 把这几张塞进「关掉」那一侧；这份默认关同时保证镜像之后联网仍默认不铺开。
 */
export const DEFAULT_HIDDEN_CARDS = ["cursor", "zed", "sub2api", "zai"] as const;

/**
 * 对应 syncProviderQuotaConfigOnLaunch 的 fallback 列（PV:3570-3578）+ showQoderIde 默认开（PV:71）。
 * 键名必须和 core/providerQuota.ts 读的 `${provider}_quota_enabled` 对得上。
 */
export const QUOTA_KEY_DEFAULTS = {
  antigravity_quota_enabled: true, devin_quota_enabled: true,
  cursor_quota_enabled: false, zed_quota_enabled: false,
  sub2api_quota_enabled: false, zai_quota_enabled: false, minimax_quota_enabled: false,
  qoder_ide_enabled: true,
} as const;

/** 对应 MenuBarQuotaSource.defaultEnabled：只有历史上默认开的两项保持默认开 */
export const QUOTA_SOURCE_DEFAULTS: Record<QuotaSourceId, boolean> = {
  claude5h: true, codexWeek: true,
  claudeWeek: false, claudeFable: false, codex5h: false,
  kimi5h: false, kimiSubscription: false, grok: false,
};
export const QUOTA_SOURCE_ORDER: QuotaSourceId[] = [
  "claude5h", "claudeWeek", "claudeFable", "codex5h", "codexWeek",
  "kimi5h", "kimiSubscription", "grok",
];

export function quotaSourceEnabled(settings: Settings, id: QuotaSourceId): boolean {
  const stored = settings.menu_quota_enabled?.[id];
  return stored === undefined ? QUOTA_SOURCE_DEFAULTS[id] : stored;
}

function newDeviceId(): string {
  return `${os.hostname().toLowerCase()}-${os.userInfo().username.toLowerCase()}`;
}

export function defaultSettings(): Settings {
  return {
    disabled_tools: [...DEFAULT_HIDDEN_CARDS],
    menu_style: "system",
    menu_density: "full",
    menu_quota_enabled: {},
    autostart: false,
    keep_awake_low_battery: true,
    sit_reminder_enabled: false,
    sit_reminder_minutes: 90,
    panel_tab: "usage",
    device_id: newDeviceId(),
    sync_dir: "",
    grok_live_quota_enabled: false,
    qwenwork_quota_enabled: false,
    grok_bot_quota_enabled: false,
    sub2api_base_url: "",
    zai_region: "global",
    ...QUOTA_KEY_DEFAULTS,
    panel_font_size: "small",
    locale: "auto",
    // 原版用 defaults.register 给默认值而不是写进去：用户关过就一直是关
    share_basic_activity: true,
  };
}

/** 纯函数：把 config.json 里那一份原始键值收敛成 Settings，脏值一概按默认回落 */
export function settingsFrom(raw: Record<string, any>): Settings {
  const base = defaultSettings();
  const merged: Settings = { ...base, ...raw };
  merged.menu_style = STYLE_VALUES.has(raw.menu_style) ? raw.menu_style : base.menu_style;
  merged.menu_density = DENSITY_VALUES.has(raw.menu_density) ? raw.menu_density : base.menu_density;
  // 键不存在才塞默认关的那几张；已经存过（哪怕是空数组）就以用户的选择为准
  merged.disabled_tools = Array.isArray(raw.disabled_tools)
    ? raw.disabled_tools.filter((x: any) => typeof x === "string")
    : [...DEFAULT_HIDDEN_CARDS];
  merged.menu_quota_enabled = raw.menu_quota_enabled && typeof raw.menu_quota_enabled === "object" ? raw.menu_quota_enabled : {};
  merged.sit_reminder_minutes = Number.isFinite(raw.sit_reminder_minutes) && raw.sit_reminder_minutes > 0
    ? Math.min(Math.round(raw.sit_reminder_minutes), 600) : base.sit_reminder_minutes;
  merged.keep_awake_low_battery = raw.keep_awake_low_battery !== false;
  merged.panel_font_size = FONT_SIZE_VALUES.has(raw.panel_font_size) ? raw.panel_font_size : base.panel_font_size;
  // 隐私段的三个联网开关都是「默认关、明确勾才算开」，脏值不能默认开出去
  merged.grok_bot_quota_enabled = raw.grok_bot_quota_enabled === true;
  // 活跃统计反过来：原版默认开，只有明确写入 false 才算关（缺键、脏值都保持默认开）
  merged.share_basic_activity = raw.share_basic_activity !== false;
  // Provider 段：外部（Python、手改）写进来的脏值不能带进面板
  merged.sub2api_base_url = typeof raw.sub2api_base_url === "string" ? raw.sub2api_base_url.trim() : "";
  merged.zai_region = typeof raw.zai_region === "string" ? raw.zai_region.trim() : base.zai_region;
  for (const [k, fallback] of Object.entries(QUOTA_KEY_DEFAULTS)) {
    const key = k as keyof typeof QUOTA_KEY_DEFAULTS;
    // 缺键回原版那份 fallback（Antigravity/Devin/Qoder 默认开），有键就只认真正的 true
    merged[key] = raw[k] === undefined ? fallback : raw[k] === true;
  }
  return merged;
}

/** 与 Python 的 _load_json 一样：坏文件不能把应用带崩 */
export function loadSettings(): Settings {
  try {
    return settingsFrom(loadJson<Record<string, any>>(CONFIG_FILE, {}) ?? {});
  } catch {
    return defaultSettings();
  }
}

const STYLE_VALUES = new Set(["system", "color", "symbols", "dots", "compact", "artistic", "palm"]);
const DENSITY_VALUES = new Set(["full", "lowest", "icon"]);
const FONT_SIZE_VALUES = new Set(["small", "large"]);

export function saveSettings(settings: Settings): boolean {
  try {
    // 保留采集器读的非 UI 键（sync_dir 等由外部写入）
    const existing = loadJson<Record<string, any>>(CONFIG_FILE, {}) ?? {};
    return saveJson(CONFIG_FILE, { ...existing, ...settings });
  } catch {
    return false;
  }
}

export function configFlag(envName: string, key: keyof Settings, settings: Settings): boolean {
  const env = process.env[envName];
  if (env === "0" || env === "false") return false;
  if (env === "1" || env === "true") return true;
  return Boolean(settings[key]);
}

export { fs };

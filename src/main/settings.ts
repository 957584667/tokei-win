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
  locale: string;
}

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
    disabled_tools: [],
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
    sub2api_quota_enabled: false,
    zai_quota_enabled: false,
    minimax_quota_enabled: false,
    locale: "auto",
  };
}

/** 与 Python 的 _load_json 一样：坏文件不能把应用带崩 */
export function loadSettings(): Settings {
  const base = defaultSettings();
  let raw: Record<string, any> = {};
  try {
    raw = loadJson<Record<string, any>>(CONFIG_FILE, {}) ?? {};
  } catch {
    return base;
  }
  const merged: Settings = { ...base, ...raw };
  merged.menu_style = STYLE_VALUES.has(raw.menu_style) ? raw.menu_style : base.menu_style;
  merged.menu_density = DENSITY_VALUES.has(raw.menu_density) ? raw.menu_density : base.menu_density;
  merged.disabled_tools = Array.isArray(raw.disabled_tools) ? raw.disabled_tools.filter((x: any) => typeof x === "string") : [];
  merged.menu_quota_enabled = raw.menu_quota_enabled && typeof raw.menu_quota_enabled === "object" ? raw.menu_quota_enabled : {};
  merged.sit_reminder_minutes = Number.isFinite(raw.sit_reminder_minutes) && raw.sit_reminder_minutes > 0
    ? Math.min(Math.round(raw.sit_reminder_minutes), 600) : base.sit_reminder_minutes;
  merged.keep_awake_low_battery = raw.keep_awake_low_battery !== false;
  // 隐私段的三个联网开关都是「默认关、明确勾才算开」，脏值不能默认开出去
  merged.grok_bot_quota_enabled = raw.grok_bot_quota_enabled === true;
  // Provider 段：外部（Python、手改）写进来的脏值不能带进面板
  merged.sub2api_base_url = typeof raw.sub2api_base_url === "string" ? raw.sub2api_base_url.trim() : "";
  merged.zai_region = typeof raw.zai_region === "string" ? raw.zai_region.trim() : base.zai_region;
  for (const k of ["sub2api_quota_enabled", "zai_quota_enabled", "minimax_quota_enabled"] as const) {
    merged[k] = raw[k] === true;
  }
  return merged;
}

const STYLE_VALUES = new Set(["system", "color", "symbols", "dots", "compact", "artistic", "palm"]);
const DENSITY_VALUES = new Set(["full", "lowest", "icon"]);

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

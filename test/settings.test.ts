/**
 * 设置层的收敛规则：config.json 与 Python 采集器共用，所以「脏值不能带出去、缺键要回原版默认」
 * 是这一层的契约。默认值取自 macOS：@AppStorage 的每卡默认（PV:62-92）
 * 与 syncProviderQuotaConfigOnLaunch 那份 fallback（PV:3570-3578）。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_HIDDEN_CARDS, QUOTA_KEY_DEFAULTS, defaultSettings, settingsFrom } from "../src/main/settings";

describe("首次运行与已存配置的分别", () => {
  it("config 里没有 disabled_tools 才塞默认关的四张卡", () => {
    expect(settingsFrom({}).disabled_tools).toEqual([...DEFAULT_HIDDEN_CARDS]);
    expect(settingsFrom({ disabled_tools: [] }).disabled_tools).toEqual([]);
    expect(settingsFrom({ disabled_tools: ["claude"] }).disabled_tools).toEqual(["claude"]);
  });

  it("脏列表只收字符串，非数组按未设置处理", () => {
    expect(settingsFrom({ disabled_tools: ["claude", 7, null] }).disabled_tools).toEqual(["claude"]);
    expect(settingsFrom({ disabled_tools: "claude" }).disabled_tools).toEqual([...DEFAULT_HIDDEN_CARDS]);
  });
});

describe("联网/采集开关的默认值", () => {
  it("缺键回原版那份 fallback", () => {
    const s = settingsFrom({});
    expect(s.antigravity_quota_enabled).toBe(true);
    expect(s.devin_quota_enabled).toBe(true);
    expect(s.qoder_ide_enabled).toBe(true);
    expect(s.cursor_quota_enabled).toBe(false);
    expect(s.zed_quota_enabled).toBe(false);
    for (const key of Object.keys(QUOTA_KEY_DEFAULTS)) {
      expect(s[key as keyof typeof QUOTA_KEY_DEFAULTS]).toBe(QUOTA_KEY_DEFAULTS[key as keyof typeof QUOTA_KEY_DEFAULTS]);
    }
  });

  it("有键就只认真正的 true，脏值一律算关", () => {
    expect(settingsFrom({ zed_quota_enabled: "yes" }).zed_quota_enabled).toBe(false);
    expect(settingsFrom({ cursor_quota_enabled: 1 }).cursor_quota_enabled).toBe(false);
    // 外部（Python、手改）能关，但不能把脏值当开
    expect(settingsFrom({ antigravity_quota_enabled: false }).antigravity_quota_enabled).toBe(false);
    expect(settingsFrom({ grok_bot_quota_enabled: "true" }).grok_bot_quota_enabled).toBe(false);
  });
});

describe("其余键的收敛", () => {
  it("枚举值不认识就回默认，数字越界夹回来", () => {
    expect(settingsFrom({ menu_style: "neon" }).menu_style).toBe("system");
    expect(settingsFrom({ menu_density: "huge" }).menu_density).toBe("full");
    expect(settingsFrom({ panel_font_size: "huge" }).panel_font_size).toBe("small");
    expect(settingsFrom({ panel_font_size: "large" }).panel_font_size).toBe("large");
    expect(settingsFrom({ sit_reminder_minutes: 9999 }).sit_reminder_minutes).toBe(600);
    expect(settingsFrom({ sit_reminder_minutes: 0 }).sit_reminder_minutes).toBe(90);
  });

  it("Provider 段的文本按 trim 收，缺省区域回 global", () => {
    expect(settingsFrom({ sub2api_base_url: "  https://h.example  " }).sub2api_base_url).toBe("https://h.example");
    expect(settingsFrom({ sub2api_base_url: 42 }).sub2api_base_url).toBe("");
    expect(settingsFrom({}).zai_region).toBe("global");
  });

  it("defaultSettings 与 settingsFrom({}) 说的是同一份默认值", () => {
    const base = defaultSettings();
    const fromEmpty = settingsFrom({});
    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      expect(fromEmpty[key]).toEqual(base[key]);
    }
  });
});

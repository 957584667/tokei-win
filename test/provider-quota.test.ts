/**
 * provider 额度底座单测：开关优先级、数值归一化、按天汇总、缓存读写。
 * 全程用临时目录，绝不碰真实的 ~/.tokei。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  PROVIDER_QUOTA_FALLBACK_TTL, PROVIDER_QUOTA_TTL, cachedProviderQuota, latestCachedProviderQuota,
  providerConfigString, providerCredentialMarker, providerEpoch, providerInteger, providerMoney,
  providerNumber, providerPercent, providerQuotaEnabled, providerQuotaRecentAttemptResult,
  providerUsageFromDays, providerUsageInt, providerWindow, saveProviderQuotaAttempt,
  saveProviderQuotaCache, useProviderQuotaFiles,
} from "../src/core/providerQuota";
import { rangeBounds } from "../src/core/ranges";

const NOW = 1_800_000_000;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-provider-quota-"));
  useProviderQuotaFiles(path.join(root, "provider_quota_cache.json"), path.join(root, "config.json"));
});
afterEach(() => {
  useProviderQuotaFiles(null, null);
  fs.rmSync(root, { recursive: true, force: true });
});

function access(env: Record<string, string>, config: Record<string, any> = {}) {
  return { env: (key: string) => env[key], config: () => config };
}

describe("开关与配置串", () => {
  it("环境变量 0/1 覆盖配置，默认只有 antigravity 与 devin 开", () => {
    expect(providerQuotaEnabled("antigravity", access({}))).toBe(true);
    expect(providerQuotaEnabled("devin", access({}))).toBe(true);
    expect(providerQuotaEnabled("zed", access({}))).toBe(false);
    expect(providerQuotaEnabled("zed", access({}, { zed_quota_enabled: true }))).toBe(true);
    expect(providerQuotaEnabled("zed", access({ TOKEI_ZED_QUOTA: "1" }, { zed_quota_enabled: false }))).toBe(true);
    expect(providerQuotaEnabled("zed", access({ TOKEI_ZED_QUOTA: "0" }, { zed_quota_enabled: true }))).toBe(false);
    // 非 0/1 的取值按未设置处理
    expect(providerQuotaEnabled("zed", access({ TOKEI_ZED_QUOTA: "yes" }))).toBe(false);
  });

  it("配置串：环境变量优先，空白等同未设置", () => {
    expect(providerConfigString("TOKEI_X", "x_key", access({ TOKEI_X: "  from-env  " }, { x_key: "cfg" })))
      .toBe("from-env");
    expect(providerConfigString("TOKEI_X", "x_key", access({ TOKEI_X: "   " }, { x_key: "cfg" }))).toBe("cfg");
    expect(providerConfigString("TOKEI_X", "x_key", access({}, { x_key: "  " }))).toBeNull();
    expect(providerConfigString("TOKEI_X", "x_key", access({}, { x_key: 12 }))).toBeNull();
  });
});

describe("数值归一化", () => {
  it("providerNumber 拒布尔、拒非有限值，收字符串数字", () => {
    expect(providerNumber(true)).toBeNull();
    expect(providerNumber("12.5")).toBe(12.5);
    expect(providerNumber("abc")).toBeNull();
    expect(providerNumber(Infinity)).toBeNull();
    expect(providerNumber(null)).toBeNull();
    expect(providerInteger("42")).toBe(42);
    expect(providerInteger(42.5)).toBeNull();
    expect(providerUsageInt(-3)).toBe(0);
    expect(providerUsageInt("7")).toBe(7);
  });

  it("百分比夹到 0-100，epoch 认毫秒与字符串时间", () => {
    expect(providerPercent(-4)).toBe(0);
    expect(providerPercent(120.5)).toBe(100);
    expect(providerPercent("33.3333333333")).toBe(33.333333);
    expect(providerEpoch(1_800_000_000)).toBe(1_800_000_000);
    expect(providerEpoch(1_800_000_000_000)).toBe(1_800_000_000);
    expect(providerEpoch(-5)).toBeNull();
    expect(providerEpoch("2026-01-02T03:04:05Z")).toBe(Date.parse("2026-01-02T03:04:05Z") / 1000);
    expect(providerEpoch("not-a-date")).toBeNull();
  });

  it("金额按币种排版", () => {
    expect(providerMoney(1234.5)).toBe("$1,234.50");
    expect(providerMoney(12, "cny")).toBe("12.00 CNY");
    expect(providerMoney("x")).toBeNull();
  });

  it("窗口把未知读数留成 null", () => {
    const w = providerWindow("a", "A", 12.3456789, 1_800_000_000, 60.9, "detail", false);
    expect(w).toEqual({
      id: "a", title: "A", used_pct: 12.345679, reset: 1_800_000_000,
      window_minutes: 60, detail: "detail", usage_known: false,
    });
    expect(providerWindow("b", "B").detail).toBeNull();
    expect(providerWindow("c", "C", undefined, undefined, -5).window_minutes).toBeNull();
  });
});

describe("按天用量汇总", () => {
  const bounds = rangeBounds(new Date("2026-09-29T12:00:00"));

  it("tokens 缺失时按分项求和兜底，坏日键与非对象整天跳过", () => {
    const usage = providerUsageFromDays({
      "2026-09-29": { in: 100, out: 20, cr: 30, cw: 4, reason: 6, cost: 1.5, requests: 3,
        models: { "claude-opus-4-8": { in: 100, out: 20, cr: 30, cw: 4, reason: 6, cost: 1.5 } } },
      "2026-09-28": { tokens: 500, cost: -2 },
      "bad-key": { tokens: 999 },
      "2026-09-27": "not-a-day",
    }, { bounds });
    expect(usage.ranges.today.tokens).toBe(160);
    expect(usage.ranges.today.requests).toBe(3);
    expect(usage.ranges.today.hit).toBeCloseTo(30 / 134 * 100, 6);
    expect(usage.ranges.today.models[0].name).toBe("Opus 4.8");
    expect(usage.ranges.yesterday.tokens).toBe(500);
    expect(usage.ranges.yesterday.cost).toBe(0);
    expect(usage.ranges.all.tokens).toBe(660);
  });

  it("同名模型的别名归并后按 token 倒序、再按名字排序", () => {
    const usage = providerUsageFromDays({
      "2026-09-29": { models: {
        "anthropic/claude-sonnet-5": { tokens: 10 },
        "claude-sonnet-5": { tokens: 70 },
        "gpt-6-sol": { tokens: 40 },
      } },
    }, { bounds });
    expect(usage.ranges.today.models.map((m) => [m.name, m.tokens]))
      .toEqual([["Sonnet 5", 80], ["GPT-6 Sol", 40]]);
  });

  it("limited_coverage 只标在 year 与 all", () => {
    const usage = providerUsageFromDays({ "2026-09-29": { tokens: 5 } },
      { bounds, limitedCoverage: "2026-09-01" });
    expect(usage.ranges.today.coverage).toBeUndefined();
    expect(usage.ranges.year.coverage).toBe("2026-09-01");
    expect(usage.ranges.all.coverage).toBe("2026-09-01");
  });
});

describe("缓存文件", () => {
  it("marker 变了就不给用；同 marker 按 TTL 与 stale 标记", () => {
    const quota = { available: true, windows: [{ id: "w" }] };
    saveProviderQuotaCache("zed", "m1", quota, NOW);
    expect(cachedProviderQuota("zed", "m1", PROVIDER_QUOTA_TTL, NOW + 10)).toEqual(quota);
    expect(cachedProviderQuota("zed", "m2", PROVIDER_QUOTA_TTL, NOW + 10)).toBeNull();
    expect(cachedProviderQuota("zed", "m1", PROVIDER_QUOTA_TTL, NOW + PROVIDER_QUOTA_TTL + 1)).toBeNull();
    expect(cachedProviderQuota("zed", "m1", PROVIDER_QUOTA_FALLBACK_TTL, NOW + 600, true))
      .toEqual({ ...quota, stale: true, source: "cache" });
    // 未来 301 秒以前的时间戳视为时钟漂移，直接不要
    expect(cachedProviderQuota("zed", "m1", PROVIDER_QUOTA_TTL, NOW - 301)).toBeNull();
    expect(latestCachedProviderQuota("zed", null, NOW + 20)).toEqual(quota);
    expect(latestCachedProviderQuota("nope", null, NOW)).toBeNull();
  });

  it("available=false 且无任何用量的读数不落盘", () => {
    saveProviderQuotaCache("zai", "m", { available: false, usage: { ranges: { today: { tokens: 0, requests: 0 } } } }, NOW);
    expect(latestCachedProviderQuota("zai", null, NOW)).toBeNull();
    saveProviderQuotaCache("zai", "m", { available: false, usage: { ranges: { today: { tokens: 12 } } } }, NOW);
    expect(latestCachedProviderQuota("zai", null, NOW)).not.toBeNull();
  });

  it("尝试记录只认 empty/failed，且与 quota 共存", () => {
    saveProviderQuotaCache("devin", "m", { available: true }, NOW);
    saveProviderQuotaAttempt("devin", "m", NOW + 5, "empty");
    expect(providerQuotaRecentAttemptResult("devin", "m", PROVIDER_QUOTA_TTL, NOW + 20)).toBe("empty");
    expect(providerQuotaRecentAttemptResult("devin", "other", PROVIDER_QUOTA_TTL, NOW + 20)).toBeNull();
    expect(providerQuotaRecentAttemptResult("devin", "m", 5, NOW + 20)).toBeNull();
    saveProviderQuotaAttempt("devin", "m", NOW + 30, "bogus" as any);
    expect(providerQuotaRecentAttemptResult("devin", "m", PROVIDER_QUOTA_TTL, NOW + 40)).toBe("failed");
    // 换凭据后旧的 attempt 记录不作数
    expect(providerQuotaRecentAttemptResult("devin", "m2", PROVIDER_QUOTA_TTL, NOW + 40)).toBeNull();
    expect(latestCachedProviderQuota("devin", null, NOW + 40)).toEqual({ available: true });
  });

  it("marker 是 provider 与凭据片段的 sha256，空片段按空串参与", () => {
    expect(providerCredentialMarker("zed", "a", "b")).toHaveLength(64);
    expect(providerCredentialMarker("zed", "ab")).not.toBe(providerCredentialMarker("zed", "a", "b"));
    expect(providerCredentialMarker("zed", "a", null)).toBe(providerCredentialMarker("zed", "a", ""));
  });
});

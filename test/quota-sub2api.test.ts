/**
 * sub2api fetcher 单测：fixture 传输层，不发任何真实请求、不写真实 ~/.tokei。
 * 覆盖凭据缺失、开关关闭、非法 Base URL 拒发、5 分钟缓存、失败退旧读数、归一化。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { useProviderQuotaFiles } from "../src/core/providerQuota";
import { QuotaDeps, baseDeps } from "../src/main/quota/context";
import {
  fetchSub2ApiQuota, localTimezoneName, normalizeSub2ApiQuota,
  scanSub2ApiQuota, sub2apiUsageUrl,
} from "../src/main/quota/sub2api";

const NOW = 1_800_000_000;
let root: string;
let env: Record<string, string>;
let requests: Array<{ url: string; headers: Record<string, string>; timeoutSeconds?: number }>;
let responder: (url: string) => any;
let deps: QuotaDeps;

const PAYLOAD = {
  isValid: true,
  unit: "USD",
  subscription: {
    daily_usage_usd: 3.5, daily_limit_usd: 10,
    weekly_usage_usd: "12", weekly_limit_usd: 100,
    monthly_usage_usd: 40, monthly_limit_usd: 0, // limit<=0 整条丢弃
    expires_at: NOW + 86400,
  },
  quota: { used: 1, limit: 2 }, // subscription 优先，这一路必须被忽略
  rate_limits: [
    { window: "5h", used: 1, limit: 4, reset_at: NOW + 3600 },
    { window: "", used: 5, limit: 10 }, // 假值 window → rate-{index} 兜底
    { window: "1D", used: "3", limit: 12, reset_at: NOW + 7200 },
    "not-a-dict",
  ],
  balance: 12.5,
  usage: {
    today: { requests: 42, total_tokens: 123456, actual_cost: 0.75 },
    total: { requests: null, total_tokens: 999999, actual_cost: "3.25" },
  },
  planName: "Pro",
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-sub2api-"));
  useProviderQuotaFiles(path.join(root, "provider_quota_cache.json"), path.join(root, "config.json"));
  env = {
    TOKEI_SUB2API_QUOTA: "1",
    SUB2API_API_KEY: "key-1",
    SUB2API_BASE_URL: "https://sub.example.com/",
    TZ: "Asia/Shanghai",
  };
  requests = [];
  responder = () => PAYLOAD;
  deps = baseDeps({
    env: (key) => env[key],
    config: () => ({}),
    request: async (url, options) => {
      requests.push({
        url,
        headers: (options?.headers ?? {}) as Record<string, string>,
        timeoutSeconds: options?.timeoutSeconds,
      });
      return responder(url);
    },
    now: () => NOW,
  });
});

afterEach(() => {
  useProviderQuotaFiles(null, null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("URL 构造", () => {
  it("补 /v1/usage 并按 quote_plus 编码时区", () => {
    expect(sub2apiUsageUrl("https://sub.example.com", "Asia/Shanghai"))
      .toBe("https://sub.example.com/v1/usage?days=30&timezone=Asia%2FShanghai");
    // 尾部斜杠会被剥；已有 /v1 不再重复追加
    expect(sub2apiUsageUrl("https://x.example/v1/", "UTC"))
      .toBe("https://x.example/v1/usage?days=30&timezone=UTC");
    expect(sub2apiUsageUrl("http://127.0.0.1:3000/api/v1/usage", "UTC"))
      .toBe("http://127.0.0.1:3000/api/v1/usage?days=30&timezone=UTC");
    // 带空格/冒号的怪时区按 quote_plus：空格→+
    expect(sub2apiUsageUrl("https://x", "A B:C")).toContain("timezone=A+B%3AC");
  });

  it("非 https 且非本机、带凭据/查询串/锚点的一律拒绝", () => {
    expect(sub2apiUsageUrl("http://evil.example", "UTC")).toBeNull();
    expect(sub2apiUsageUrl("https://u:p@x.example", "UTC")).toBeNull();
    expect(sub2apiUsageUrl("https://x.example/?q=1", "UTC")).toBeNull();
    expect(sub2apiUsageUrl("https://x.example/#frag", "UTC")).toBeNull();
    expect(sub2apiUsageUrl("ftp://x.example", "UTC")).toBeNull();
    expect(sub2apiUsageUrl("   ", "UTC")).toBeNull();
    expect(sub2apiUsageUrl(null, "UTC")).toBeNull();
    // IPv6 回环（WHATWG 的 hostname 自带方括号）也放行
    expect(sub2apiUsageUrl("http://[::1]:8080", "UTC"))
      .toBe("http://[::1]:8080/v1/usage?days=30&timezone=UTC");
  });

  it("localTimezoneName：TZ 最优先，其余走 Intl，拿不到按 UTC", () => {
    expect(localTimezoneName(() => " America/New_York ")).toBe("America/New_York");
    expect(localTimezoneName(() => "   ")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(localTimezoneName(() => undefined)).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });
});

describe("归一化", () => {
  it("订阅三窗口 + 速率限制 + 明细，金额串与百分比逐项对齐", () => {
    const quota = normalizeSub2ApiQuota(PAYLOAD, NOW);
    expect(quota.available).toBe(true);
    expect(quota.plan).toBe("Pro");
    expect(quota.account).toBeNull();
    expect(quota.source).toBe("sub2api");
    expect(quota.updated).toBe(NOW);
    expect(quota.stale).toBe(false);
    expect(quota.windows.map((w: any) =>
      [w.id, w.title, w.used_pct, w.reset, w.window_minutes, w.detail])).toEqual([
      ["sub2api-daily", "日额度", 35, null, 1440, "$3.50 / $10.00"],
      ["sub2api-weekly", "周额度", 12, null, 10080, "$12.00 / $100.00"],
      ["sub2api-5h", "5h 额度", 25, NOW + 3600, 300, "$1.00 / $4.00"],
      ["sub2api-rate-1", "rate-1 限额", 50, null, null, "$5.00 / $10.00"],
      ["sub2api-1D", "日限额", 25, NOW + 7200, 1440, "$3.00 / $12.00"],
    ]);
    expect(quota.details).toEqual([
      { label: "余额", value: "$12.50" },
      { label: "今日请求", value: "42" },
      { label: "今日 Token", value: "123,456", secondary: "$0.75" },
      { label: "累计请求", value: "0" },
      { label: "累计 Token", value: "999,999", secondary: "$3.25" },
      { label: "套餐到期", value: String(NOW + 86400) },
    ]);
  });

  it("无订阅时落到 quota 分支，币种跟随 quota.unit", () => {
    const quota = normalizeSub2ApiQuota(
      { quota: { used: 3, limit: 6, unit: "credits" } }, NOW);
    expect(quota.windows).toHaveLength(1);
    expect(quota.windows[0]).toMatchObject({
      id: "sub2api-quota", title: "额度", used_pct: 50,
      window_minutes: null, detail: "3.00 CREDITS / 6.00 CREDITS",
    });
    expect(quota.details).toEqual([]);
  });

  it("isValid:false、空对象与非法计数分别按 {}、{}、抛错处理", () => {
    expect(normalizeSub2ApiQuota({ isValid: false, balance: 1 }, NOW)).toEqual({});
    expect(normalizeSub2ApiQuota("nope", NOW)).toEqual({});
    expect(normalizeSub2ApiQuota({}, NOW).available).toBe(false);
    expect(() => normalizeSub2ApiQuota(
      { usage: { today: { requests: "abc" } } }, NOW)).toThrow(/must be integers/);
  });
});

describe("取数", () => {
  it("缺 API Key 就不联网", async () => {
    delete env.SUB2API_API_KEY;
    expect(await scanSub2ApiQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("开关关掉时即使凭据齐全也不联网", async () => {
    env.TOKEI_SUB2API_QUOTA = "0";
    expect(await scanSub2ApiQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("非 https 的外部 Base URL 直接拒绝，不发请求", async () => {
    env.SUB2API_BASE_URL = "http://evil.example";
    expect(await scanSub2ApiQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("请求打向 <base>/v1/usage，Bearer 头与 15 秒超时都按原版钉死", async () => {
    const quota = await scanSub2ApiQuota(deps);
    expect(quota.plan).toBe("Pro");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://sub.example.com/v1/usage?days=30&timezone=Asia%2FShanghai");
    expect(requests[0].headers.Authorization).toBe("Bearer key-1");
    expect(requests[0].timeoutSeconds).toBe(15);
  });

  it("Key 也可以来自 DPAPI 凭据与 config.json", async () => {
    delete env.SUB2API_API_KEY;
    delete env.SUB2API_BASE_URL;
    let called = 0;
    const custom = baseDeps({
      env: (key) => env[key],
      config: () => ({ sub2api_base_url: "https://cfg.example" }),
      secret: (name) => (name === "sub2api" ? "dpapi-key" : null),
      request: async (url) => {
        called += 1;
        expect(url).toBe("https://cfg.example/v1/usage?days=30&timezone=Asia%2FShanghai");
        return PAYLOAD;
      },
      now: () => NOW,
    });
    expect((await fetchSub2ApiQuota(custom)).available).toBe(true);
    expect(called).toBe(1);
  });

  it("同一凭据 5 分钟内只请求一次，换 Key 后缓存作废", async () => {
    const first = await scanSub2ApiQuota(deps);
    expect(requests).toHaveLength(1);
    const second = await scanSub2ApiQuota({ ...deps, now: () => NOW + 200 });
    expect(second).toEqual(first);
    expect(requests).toHaveLength(1);
    env.SUB2API_API_KEY = "key-2";
    await scanSub2ApiQuota({ ...deps, now: () => NOW + 200 });
    expect(requests).toHaveLength(2);
  });

  it("isValid:false 视作 Key 被拒，无缓存时把错误抛出", async () => {
    responder = () => ({ isValid: false });
    await expect(fetchSub2ApiQuota(deps)).rejects.toThrow("sub2api rejected the API key");
  });

  it("请求失败退回一小时内的旧读数并标 stale，超窗则把错误抛给上层", async () => {
    await scanSub2ApiQuota(deps);
    responder = () => { throw new Error("boom"); };
    const stale = await scanSub2ApiQuota({ ...deps, now: () => NOW + 900 });
    expect(stale.stale).toBe(true);
    expect(stale.source).toBe("cache");
    expect(stale.plan).toBe("Pro");
    await expect(scanSub2ApiQuota({ ...deps, now: () => NOW + 4000 }))
      .rejects.toThrow("boom");
  });
});

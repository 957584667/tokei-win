/**
 * Grok 实时额度单测：fixture 传输层 + 临时文件，零网络、零真实 ~/.tokei / ~/.grok 读写。
 * 覆盖：开关默认关、token 过期/缺失、缓存 TTL 只请求一次、失败退旧读数、归一化形状。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { baseDeps, QuotaDeps } from "../src/main/quota/context";
import {
  GROK_AUTH_EXPIRY_SKEW, GROK_LIVE_BILLING_URL, cachedGrokQuota, fetchGrokLiveQuota,
  grokAuthState, grokLiveQuotaEnabled, scanGrokQuota, useGrokLiveFiles,
} from "../src/main/quota/grokLive";
import { normalizeGrokBilling } from "../src/collectors/grok";

let root: string;
let cacheFile: string;
let authFile: string;
let logFile: string;
let env: Record<string, string>;
let config: Record<string, any>;
let requests: Array<{ url: string; headers: Record<string, string>; options: any }>;
let responder: () => any;
let clock: number;

function deps(): QuotaDeps {
  return baseDeps({
    env: (key) => env[key],
    config: () => config,
    request: async (url, options) => {
      requests.push({ url, headers: (options?.headers ?? {}) as Record<string, string>, options });
      return responder();
    },
    now: () => clock,
  });
}

function iso(offsetSeconds: number): string {
  return new Date((clock + offsetSeconds) * 1000).toISOString();
}

/** auth.json 的真实形状：按账号 id 建索引，token 写在 key 字段 */
function writeAuth(entry: Record<string, any> | null): void {
  fs.writeFileSync(authFile, JSON.stringify(entry ? { "account-1": entry } : {}));
}

const LIVE_PAYLOAD = () => ({
  subscriptionTier: "SuperGrok",
  config: {
    creditUsagePercent: 42.5,
    isUnifiedBillingUser: true,
    billingPeriodEnd: iso(3600),
    currentPeriod: { start: iso(-3600), end: iso(3600), type: "PERIOD_TYPE_WEEKLY" },
    productUsage: [
      { product: "Grok", usagePercent: 180 },
      { name: "Console", usagePercent: "not-a-number" },
      { name: "" },
    ],
  },
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-grok-"));
  cacheFile = path.join(root, "grok_quota_cache.json");
  authFile = path.join(root, "auth.json");
  logFile = path.join(root, "unified.jsonl");
  env = { TOKEI_GROK_LIVE_QUOTA: "1" };
  config = {};
  requests = [];
  responder = LIVE_PAYLOAD;
  clock = Math.trunc(Date.now() / 1000);
  useGrokLiveFiles({ cache: cacheFile, auth: authFile, log: logFile });
});

afterEach(() => {
  useGrokLiveFiles(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("开关", () => {
  it("默认关闭：环境变量和配置都没点头时绝不联网", async () => {
    writeAuth({ key: "tok", expires_at: iso(3600) });
    delete env.TOKEI_GROK_LIVE_QUOTA;
    expect(grokLiveQuotaEnabled(deps())).toBe(false);
    expect(await scanGrokQuota(deps())).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("TOKEI_GROK_LIVE_QUOTA=0 能压过配置里的 true", () => {
    env.TOKEI_GROK_LIVE_QUOTA = "0";
    config = { grok_live_quota_enabled: true };
    expect(grokLiveQuotaEnabled(deps())).toBe(false);
  });

  it("配置 grok_live_quota_enabled 也算开启（环境变量其它值按未设置）", () => {
    env.TOKEI_GROK_LIVE_QUOTA = "yes";
    config = { grok_live_quota_enabled: true };
    expect(grokLiveQuotaEnabled(deps())).toBe(true);
  });
});

describe("凭据", () => {
  it("只读 access token；60 秒内到期的按已过期，直接给 auth_expired 且不发请求", () => {
    writeAuth({ key: "tok", expires_at: iso(GROK_AUTH_EXPIRY_SKEW - 1) });
    const [token, expired] = grokAuthState(deps());
    expect(token).toBe("tok");
    expect(expired).toBe(true);
  });

  it("access_token 字段与空白 token：前者可用，后者视为没登录", () => {
    writeAuth({ access_token: "  spaced  " });
    expect(grokAuthState(deps())).toEqual(["spaced", false]);
    writeAuth({ access_token: "   " });
    expect(grokAuthState(deps())).toEqual([null, false]);
  });

  it("expires_at 写成数字时不解析（Python 只认字符串），按未过期处理", () => {
    writeAuth({ key: "tok", expires_at: clock + 1 });
    expect(grokAuthState(deps())).toEqual(["tok", false]);
  });

  it("没有 token：不联网，返回 {}（连 auth_expired 都不标，Python 5191-5192 走缓存兜底）", async () => {
    fs.writeFileSync(authFile, "not json");
    expect(await scanGrokQuota(deps())).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("token 过期时把原因带给界面：live 不可用，本地日志值上补 auth_expired", async () => {
    writeAuth({ key: "tok", expires_at: iso(-10) });
    writeLog({ creditUsagePercent: 10, currentPeriod: { start: iso(-100), end: iso(7200), type: "MONTHLY" }, isUnifiedBillingUser: true });
    const quota = await scanGrokQuota(deps());
    expect(quota).toMatchObject({ pct: 10, source: "log", auth_expired: true });
    expect(requests).toHaveLength(0);
  });
});

describe("归一化（_normalize_grok_billing 5025-5094）", () => {
  it("pct 夹到 0-100，products 逐项归一，周期类型决定 window", () => {
    const quota = normalizeGrokBilling({
      creditUsagePercent: 140,
      currentPeriod: { type: "PERIOD_TYPE_WEEKLY", start: iso(-100), end: iso(3600) },
      productUsage: [{ product: "Grok", usagePercent: "55.5" }, { product: "X", usagePercent: -3 }],
    }, { plan: "Xplan", source: "live", nowEpoch: clock });
    expect(quota).toEqual({
      pct: 100,
      reset: clock + 3600,
      plan: "Xplan",
      products: [{ name: "Grok", pct: 55.5 }, { name: "X", pct: 0 }],
      window: "week",
      source: "live",
      updated: clock,
      stale: false,
    });
  });

  it("protobuf 省略 0 值：只有完整统一账单周期才敢当 0% 已用", () => {
    expect(normalizeGrokBilling({
      isUnifiedBillingUser: true,
      currentPeriod: { start: iso(-100), end: iso(3600) },
    }, { nowEpoch: clock })?.pct).toBe(0);
    // 非统一账单用户缺字段 → 整条读数作废（不能谎报 0%）
    expect(normalizeGrokBilling({ currentPeriod: { start: iso(-100), end: iso(3600) } }, { nowEpoch: clock })).toBeNull();
    expect(normalizeGrokBilling({ creditUsagePercent: null }, { nowEpoch: clock })).toBeNull();
  });

  it("周期已过重置点：pct 归零、reset 抹掉并标 stale（避免把上个周期的用量当成当前）", () => {
    const quota = normalizeGrokBilling({
      creditUsagePercent: 99,
      currentPeriod: { start: iso(-7200), end: iso(-60), type: "MONTH" },
      productUsage: [{ product: "Grok", usagePercent: 88 }],
    }, { nowEpoch: clock });
    expect(quota).toMatchObject({ pct: 0, reset: null, stale: true, window: "month" });
    expect(quota?.products).toEqual([{ name: "Grok", pct: 0 }]);
  });

  it("MONTH 之外的类型一律按 week（Python 5075-5081 的兜底）", () => {
    expect(normalizeGrokBilling({ creditUsagePercent: 1 }, { nowEpoch: clock })?.window).toBe("week");
  });
});

describe("取数", () => {
  it("URL 与请求头照原版钉死：Bearer 只发这一次，超时 3 秒、响应上限 1MiB", async () => {
    writeAuth({ key: "tok", expires_at: iso(3600) });
    const quota = await fetchGrokLiveQuota(deps());
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(GROK_LIVE_BILLING_URL);
    expect(requests[0].headers).toEqual({
      Accept: "application/json",
      "User-Agent": "Tokei",
      Authorization: "Bearer tok",
    });
    expect(requests[0].options.timeoutSeconds).toBe(3);
    expect(requests[0].options.maxBytes).toBe(1024 * 1024);
    expect(quota).toMatchObject({ pct: 42.5, plan: "SuperGrok", source: "live", window: "week" });
    // 非法 productUsage 项：坏数值降级成 null，空名整条丢弃
    expect(quota?.products).toEqual([{ name: "Grok", pct: 100 }, { name: "Console", pct: null }]);
    expect(quota?.reset).toBe(clock + 3600);
  });

  it("30 秒 TTL 内只请求一次；换 token 后必须重新请求", async () => {
    writeAuth({ key: "tok", expires_at: iso(3600) });
    const first = await scanGrokQuota(deps());
    expect(first.source).toBe("live");
    expect(requests).toHaveLength(1);
    const second = await scanGrokQuota({ ...deps(), now: () => clock + 20 });
    expect(second).toEqual(first);
    expect(requests).toHaveLength(1);
    // 落盘的缓存形状与 Python 的 _save_grok_quota_cache 一致
    const onDisk = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(onDisk.source).toBe("live");
    expect(onDisk.quota.pct).toBe(42.5);
    expect(Math.trunc(onDisk.fetched_at)).toBe(clock);
  });

  it("请求失败退回 300 秒内的旧读数；超窗就不再返回", async () => {
    writeAuth({ key: "tok", expires_at: iso(3600) });
    await fetchGrokLiveQuota(deps());
    responder = () => { throw new Error("boom"); };
    const fallback = await fetchGrokLiveQuota({ ...deps(), now: () => clock + 120 });
    expect(fallback).toMatchObject({ pct: 42.5, source: "live" });
    expect(await fetchGrokLiveQuota({ ...deps(), now: () => clock + 400 })).toBeNull();
  });

  it("接口给了废配置（归一化为 null）也按失败处理，退回旧读数", async () => {
    writeAuth({ key: "tok", expires_at: iso(3600) });
    await fetchGrokLiveQuota(deps());
    responder = () => ({ config: { creditUsagePercent: "abc" } });
    const fallback = await fetchGrokLiveQuota({ ...deps(), now: () => clock + 200 });
    expect(fallback).toMatchObject({ pct: 42.5 });
  });

  it("本地日志优先且会顺手落缓存；关掉实时就完全不调接口", async () => {
    writeAuth({ key: "tok", expires_at: iso(3600) });
    delete env.TOKEI_GROK_LIVE_QUOTA;
    writeLog({ creditUsagePercent: 33, currentPeriod: { start: iso(-100), end: iso(3600) }, isUnifiedBillingUser: true });
    const quota = await scanGrokQuota(deps());
    expect(requests).toHaveLength(0);
    expect(quota).toMatchObject({ pct: 33, source: "log", plan: "LogPlan" });
    expect("auth_expired" in quota).toBe(false);
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf8")).quota.source).toBe("log");
  });

  it("日志与实时都没有时，用放宽到 1 小时的本地缓存并改标 cache", async () => {
    writeAuth(null);
    fs.writeFileSync(cacheFile, JSON.stringify({
      fetched_at: clock - 1200,
      source: "live",
      quota: { pct: 77, reset: clock + 900, products: [], window: "week", updated: clock - 1200, stale: false },
    }));
    const quota = await scanGrokQuota(deps());
    expect(quota).toMatchObject({ pct: 77, source: "cache", stale: false });
    expect(cachedGrokQuota(3600, deps())).toMatchObject({ pct: 77, source: "live" });
  });

  it("缓存里的周期已经翻篇 → 标 stale、用量归零、reset 抹掉", async () => {
    writeAuth(null);
    fs.writeFileSync(cacheFile, JSON.stringify({
      fetched_at: clock - 1200,
      source: "live",
      quota: { pct: 88, reset: clock - 30, products: [{ name: "Grok", pct: 50 }], window: "month", updated: clock - 1200, stale: false },
    }));
    expect(await scanGrokQuota(deps())).toMatchObject({ pct: 0, reset: null, stale: true, source: "cache" });
  });
});

/** 写一条 unified.jsonl 的 billing 记录，形状与 Grok CLI 落盘一致 */
function writeLog(configBody: Record<string, any>): void {
  const line = {
    msg: "billing: fetched credits config",
    ts: new Date(clock * 1000).toISOString(),
    ctx: { subscriptionTier: "LogPlan", config: configBody },
  };
  fs.writeFileSync(logFile, `${JSON.stringify(line)}\n`);
}

/**
 * Grok Bot fetcher 单测：fixture 传输层 + 临时缓存目录，不发真实请求、不写真实 ~/.tokei。
 * 覆盖：开关关掉不联网、无凭据不联网、归一化（sand usage / 桥接负载 / cursor 额度搬运）、
 * Windows 上没有本机 helper → 走「复用 cursor 会话」这条回退路，命中后 grok_bot 缓存写回。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  PROVIDER_QUOTA_FALLBACK_TTL, PROVIDER_QUOTA_TTL, saveProviderQuotaCache, useProviderQuotaFiles,
} from "../src/core/providerQuota";
import { QuotaDeps, baseDeps } from "../src/main/quota/context";
import {
  grokBotProviderData, grokBotQuotaFromCursor, grokBotUsageFromBridge, normalizeGrokBotQuota,
} from "../src/main/quota/cursor";
import { fetchGrokBotQuota, scanGrokBotQuota } from "../src/main/quota/grokBot";

const NOW = 1_800_000_000;
let root: string;
let env: Record<string, string>;
let requests: Array<{ url: string; options: any }>;
let responder: (url: string, options: any) => any;
let deps: QuotaDeps;

// 本机侧 helper 走的是 Python 的模块级常量（process.env + 磁盘），没有 deps 注入口，
// 所以测试里把这三个环境变量指到临时目录里的不存在路径，保证不去翻真实 Grok Bot。
const PROCESS_ENV_KEYS = ["TOKEI_GROK_BOT_SECRETS", "TOKEI_GROK_BOT_AUTH_MARKER", "TOKEI_GROK_BOT_HELPER"];
const savedProcessEnv: Record<string, string | undefined> = {};

function makeJwt(claims: Record<string, any>): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}
function makeCookie(claims: Record<string, any>): string {
  const jwt = makeJwt(claims);
  const userId = String(claims.sub).split("|").pop();
  return `WorkosCursorSessionToken=${userId}%3A%3A${jwt}`;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-grok-"));
  useProviderQuotaFiles(path.join(root, "cache.json"), path.join(root, "config.json"));
  env = { TOKEI_GROK_BOT_QUOTA: "1" };
  requests = [];
  responder = () => ({});
  deps = baseDeps({
    env: (key) => env[key],
    config: () => ({}),
    request: async (url, options) => {
      requests.push({ url, options });
      return responder(url, options);
    },
    now: () => NOW,
  });
  // 隔离本机侧 helper：把三个环境变量指到临时目录里不存在的路径，native 账号/标记/helper 全为空，
  // 于是 fetch_grok_bot_quota 必然跳过原生那条，只走 cursor 会话回退路（也不 spawn helper）。
  for (const key of PROCESS_ENV_KEYS) {
    savedProcessEnv[key] = process.env[key];
    process.env[key] = path.join(root, `absent-${key}`);
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  useProviderQuotaFiles(null, null);
  for (const key of PROCESS_ENV_KEYS) {
    if (savedProcessEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProcessEnv[key];
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch { /* Windows 句柄未释放时忽略 */ }
  vi.restoreAllMocks();
});

describe("归一化", () => {
  it("sand usage 出周期窗口，plan 优先取 grokPlanLabel", () => {
    const quota = normalizeGrokBotQuota({
      usagePercent: 42, hasNonZeroIncludedLimit: true,
      currentPeriodStart: NOW - 600, nextResetTimestampUtc: NOW + 600,
      grokPlanLabel: "Grok Pro",
    }, { updated: NOW });
    expect(quota.available).toBe(true);
    expect(quota.plan).toBe("Grok Pro");
    expect(quota.source).toBe("cursor-sand-api");
    expect(quota.windows).toEqual([
      { id: "grok-bot-period", title: "本周期额度", used_pct: 42, reset: NOW + 600,
        window_minutes: 20, detail: null, usage_known: true },
    ]);
  });

  it("usagePercent 缺失、或明确没有付费额度时返回 {}", () => {
    expect(normalizeGrokBotQuota({ hasNonZeroIncludedLimit: true })).toEqual({});
    expect(normalizeGrokBotQuota({ usagePercent: 10, hasNonZeroIncludedLimit: false })).toEqual({});
    expect(normalizeGrokBotQuota("nope")).toEqual({});
  });

  it("从 cursor 额度搬运 cursor-grok-bot 窗口（detail 变 plan，id/标题改写）", () => {
    const quota = grokBotQuotaFromCursor({
      updated: NOW, stale: true,
      windows: [
        { id: "cursor-auto", used_pct: 5 },
        { id: "cursor-grok-bot", title: "旧标题", used_pct: 66, reset: NOW + 900,
          window_minutes: 15, detail: "Grok Max", usage_known: true },
      ],
    });
    expect(quota.plan).toBe("Grok Max");
    expect(quota.stale).toBe(true);
    expect(quota.source).toBe("cursor-sand-api");
    expect(quota.windows).toEqual([
      { id: "grok-bot-period", title: "本周期额度", used_pct: 66, reset: NOW + 900,
        window_minutes: 15, usage_known: true },
    ]);
    // 没有 cursor-grok-bot 窗口 → 搬不出东西
    expect(grokBotQuotaFromCursor({ windows: [{ id: "cursor-auto" }] })).toEqual({});
  });

  it("桥接负载：用量按天聚合、本年覆盖标记、有额度就合并", () => {
    const data = grokBotProviderData({
      quotaFetched: true, usageFetched: true,
      sandUsage: { usagePercent: 25, hasNonZeroIncludedLimit: true, planLabel: "Grok" },
      usageEventsDisplay: [
        { timestamp: NOW, model: "grok-3", tokenUsage: { inputTokens: 100, outputTokens: 20 } },
        // 完全相同的一条要按稳定序列化去重
        { timestamp: NOW, model: "grok-3", tokenUsage: { inputTokens: 100, outputTokens: 20 } },
      ],
    }, { updated: NOW });
    expect(data.plan).toBe("Grok");
    expect(data.windows[0].id).toBe("grok-bot-period");
    expect(data.usage.ranges.all.tokens).toBe(120);
    expect(data.usage.ranges.all.coverage).toBe("本年");
  });

  it("桥接只有用量没有额度：出 available=false 的空壳挂着 usage", () => {
    const data = grokBotProviderData({
      quotaFetched: true, usageFetched: true, sandUsage: { usagePercent: null },
      usageEventsDisplay: [{ timestamp: NOW, tokenUsage: { inputTokens: 7 } }],
    }, { updated: NOW });
    expect(data.available).toBe(false);
    expect(data.usage.ranges.all.tokens).toBe(7);
  });

  it("usageFetched 非 true 时桥接用量不认", () => {
    expect(grokBotUsageFromBridge({ usageFetched: false, usageEventsDisplay: [] })).toBeNull();
    expect(grokBotUsageFromBridge({ usageEventsDisplay: [] })).toBeNull();
  });
});

describe("取数与开关", () => {
  it("开关关掉时不联网", async () => {
    env.TOKEI_GROK_BOT_QUOTA = "0";
    expect(await scanGrokBotQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("没有任何凭据（本机 helper 在 Windows 缺席、又没 cursor 会话）不联网，返回 {}", async () => {
    // 指向不存在的库，确保 cursor 会话取不到（也不碰真实 Cursor）
    env.TOKEI_CURSOR_AUTH_DB = path.join(root, "missing.vscdb");
    expect(await scanGrokBotQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("Windows 回退路：复用 cursor 会话，从 sand usage 拿到 grok_bot 额度并写回缓存", async () => {
    env.TOKEI_CURSOR_COOKIE = makeCookie({ sub: "auth0|user-9", exp: NOW + 3600 });
    responder = (url) => {
      if (url.includes("get-sand-usage-status")) {
        return { usagePercent: 33, hasNonZeroIncludedLimit: true, grokPlanLabel: "Grok Pro",
          currentPeriodStart: NOW - 600, nextResetTimestampUtc: NOW + 600 };
      }
      if (url.includes("usage-summary")) return { membershipType: "pro", individualUsage: { plan: { autoPercentUsed: 1 } } };
      return {};
    };
    const first = await scanGrokBotQuota(deps);
    expect(first.source).toBe("cursor-sand-api");
    expect(first.windows.map((w: any) => w.id)).toEqual(["grok-bot-period"]);
    expect(first.windows[0].used_pct).toBe(33);
    const afterFirst = requests.length;
    expect(afterFirst).toBeGreaterThan(0);
    // 5 分钟内第二次直接命中 grok_bot 缓存，请求数不再增长
    const second = await scanGrokBotQuota({ ...deps, now: () => NOW + 200 });
    expect(second).toEqual(first);
    expect(requests).toHaveLength(afterFirst);
    expect(PROVIDER_QUOTA_TTL).toBe(300);
  });

  it("请求失败：先退 1 小时内的旧读数并标 stale，超窗就把错误抛给上层", async () => {
    env.TOKEI_CURSOR_COOKIE = makeCookie({ sub: "auth0|user-9", exp: NOW + 3600 });
    responder = (url) => (url.includes("get-sand-usage-status")
      ? { usagePercent: 33, hasNonZeroIncludedLimit: true, grokPlanLabel: "Grok Pro" }
      : {});
    const first = await scanGrokBotQuota(deps);
    expect(first.windows[0].id).toBe("grok-bot-period");
    responder = () => { throw new Error("boom"); };
    // cursor 自己还在 1 小时兜底窗内 → 取到旧读数，grok_bot 也跟着 stale
    const stale = await scanGrokBotQuota({ ...deps, now: () => NOW + 900 });
    expect(stale.stale).toBe(true);
    expect(stale.source).toBe("cache");
    expect(stale.windows[0].id).toBe("grok-bot-period");
    await expect(scanGrokBotQuota({ ...deps, now: () => NOW + PROVIDER_QUOTA_FALLBACK_TTL + 1 }))
      .rejects.toThrow("boom");
  });

  it("额度彻底没了但缓存里还有用量：退回只有 usage 的空壳", async () => {
    // 直接往（临时）缓存里种一条带用量的 grok_bot 读数
    saveProviderQuotaCache("grok_bot", "marker-x", {
      available: false, plan: null, account: null, windows: [], details: [],
      usage: { ranges: { today: { tokens: 4242 } }, days: {} },
      source: "grok-bot-api", stale: false,
    }, NOW);
    // 超出 1 小时兜底窗，且没有任何 cursor 会话 → 只剩用量可用
    const quota = await fetchGrokBotQuota({ ...deps, now: () => NOW + PROVIDER_QUOTA_FALLBACK_TTL + 60 });
    expect(quota.available).toBe(false);
    expect(quota.windows).toEqual([]);
    expect(quota.source).toBe("cache");
    expect(quota.stale).toBe(true);
    expect(quota.usage.ranges.today.tokens).toBe(4242);
    expect(requests).toHaveLength(0);
  });
});

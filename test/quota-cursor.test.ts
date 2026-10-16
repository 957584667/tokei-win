/**
 * Cursor fetcher 单测：fixture 传输层，不发任何真实请求，也不写真实 ~/.tokei。
 * 覆盖：无凭据不联网、开关关掉不联网、5 分钟缓存命中、失败退 1 小时旧读数、
 * 归一化对照真实抓包负载（窗口 id / used_pct / reset / 用量区间 / 按天）、
 * 翻页对账、SQLite 会话（有效与过期 JWT）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "node:module";
// vitest 环境里 node:sqlite 不能静态 import（vite 内置表没有它），与采集器同法
const { DatabaseSync } = createRequire(path.join(process.cwd(), "noop.cjs"))("node:sqlite") as typeof import("node:sqlite");
import {
  PROVIDER_QUOTA_FALLBACK_TTL, PROVIDER_QUOTA_TTL, useProviderQuotaFiles,
} from "../src/core/providerQuota";
import { rangeBounds, dayKey } from "../src/core/ranges";
import { QuotaDeps, baseDeps } from "../src/main/quota/context";
import {
  CURSOR_USAGE_PAGE_SIZE, cursorAppSession, cursorCookieSession, cursorPlanName, decodeJwtClaims,
  fetchCursorQuota, normalizeCursorQuota, normalizeCursorUsageEvents, scanCursorQuota,
} from "../src/main/quota/cursor";

const NOW = 1_800_000_000;
let root: string;
let env: Record<string, string>;
let config: Record<string, any>;
let requests: Array<{ url: string; options: any }>;
let responder: (url: string, options: any) => any;
let deps: QuotaDeps;

/** 造一段真-looking 的 JWT：header.payload.signature，payload 走 base64url */
function makeJwt(claims: Record<string, any>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

function makeCookie(claims: Record<string, any>): string {
  const jwt = makeJwt(claims);
  const userId = String(claims.sub).split("|").pop();
  return `other=1; WorkosCursorSessionToken=${userId}%3A%3A${jwt}; foo=bar`;
}

// 一段贴近真实抓包的 usage-summary（金额单位是分，plan.used/limit 是套餐面额）
const CURSOR_SUMMARY = {
  membershipType: "pro_plus",
  billingCycleStart: NOW - 1200,
  billingCycleEnd: NOW + 1200,
  individualUsage: {
    plan: { used: 3000, limit: 20000, autoPercentUsed: 40, apiPercentUsed: 20 },
    onDemand: { used: 500, limit: 10000 },
  },
  teamUsage: {},
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-cursor-"));
  useProviderQuotaFiles(path.join(root, "cache.json"), path.join(root, "config.json"));
  env = {
    TOKEI_CURSOR_QUOTA: "1",
    TOKEI_CURSOR_COOKIE: makeCookie({ sub: "auth0|user-42", email: "ada@example.com", exp: NOW + 3600 }),
  };
  config = {};
  requests = [];
  responder = () => ({});
  deps = baseDeps({
    env: (key) => env[key],
    config: () => config,
    request: async (url, options) => {
      requests.push({ url, options });
      return responder(url, options);
    },
    now: () => NOW,
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  useProviderQuotaFiles(null, null);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch { /* Windows 句柄未释放时忽略 */ }
  vi.restoreAllMocks();
});

describe("会话", () => {
  it("手工 Cookie 解出账号、user_id 与 marker", () => {
    const session = cursorCookieSession(env.TOKEI_CURSOR_COOKIE)!;
    expect(session.user_id).toBe("user-42");
    expect(session.subject).toBe("auth0|user-42");
    expect(session.account).toBe("ada@example.com");
    expect(session.cookie).toBe(env.TOKEI_CURSOR_COOKIE);
    expect(session.marker).toMatch(/^[0-9a-f]{64}$/);
    // 没有 WorkosCursorSessionToken 的 Cookie 仍算会话（身份字段留空），与原版一致
    const bare = cursorCookieSession("only=1")!;
    expect(bare.user_id).toBeNull();
    expect(bare.account).toBeNull();
    expect(cursorCookieSession("   ")).toBeNull();
  });

  it("JWT claims 解码：不足三段或坏 base64 返回 {}", () => {
    expect(decodeJwtClaims(makeJwt({ sub: "auth0|u1" })).sub).toBe("auth0|u1");
    expect(decodeJwtClaims("a.b")).toEqual({});
    expect(decodeJwtClaims("...")).toEqual({});
    expect(decodeJwtClaims(123)).toEqual({});
  });

  it("SQLite 会话：有效 JWT 出得来，过期 JWT 与坏库都当作没有", () => {
    const dbFile = path.join(root, "state.vscdb");
    const write = (jwt: string) => {
      const db = new DatabaseSync(dbFile);
      try {
        db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)");
        db.exec("DELETE FROM ItemTable");
        db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/accessToken", jwt);
      } finally {
        db.close();
      }
    };
    write(makeJwt({ sub: "auth0|user-7", email: " bob@example.com ", exp: NOW + 3600 }));
    const session = cursorAppSession(deps, { path: dbFile, now: NOW })!;
    expect(session.user_id).toBe("user-7");
    expect(session.account).toBe("bob@example.com");
    expect(session.cookie).toContain("WorkosCursorSessionToken=user-7%3A%3A");
    // exp 只比 now 多 30 秒（<= now+60）视为即将过期，拒用
    write(makeJwt({ sub: "auth0|user-7", exp: NOW + 30 }));
    expect(cursorAppSession(deps, { path: dbFile, now: NOW })).toBeNull();
    // 非 JWT（解不出 sub）也拒
    write("not-a-jwt");
    expect(cursorAppSession(deps, { path: dbFile, now: NOW })).toBeNull();
  });

  it("套餐名映射与 Cursor 前缀", () => {
    expect(cursorPlanName("pro_plus")).toBe("Cursor Pro+");
    expect(cursorPlanName("  Express ")).toBe("Cursor Start");
    expect(cursorPlanName("team")).toBe("Cursor Team");
    expect(cursorPlanName("ultra")).toBe("Cursor Ultra");
    expect(cursorPlanName("weird_tier")).toBe("Cursor weird_tier");
    expect(cursorPlanName("")).toBeNull();
  });
});

describe("归一化", () => {
  it("金额口径：auto/api 两个窗口 + 套餐与按量预算明细", () => {
    const quota = normalizeCursorQuota({
      membershipType: "pro",
      billingCycleStart: NOW - 1200,
      billingCycleEnd: NOW + 1200,
      individualUsage: {
        plan: { used: 3000, limit: 20000, autoPercentUsed: 40, apiPercentUsed: 20 },
        onDemand: { used: 500, limit: 10000 },
      },
    }, { userInfo: { email: "ada@example.com" }, identity: {}, updated: NOW });
    expect(quota.available).toBe(true);
    expect(quota.plan).toBe("Cursor Pro");
    expect(quota.account).toBe("ada@example.com");
    expect(quota.source).toBe("cursor-api");
    expect(quota.stale).toBe(false);
    expect(quota.windows.map((w: any) => [w.id, w.used_pct])).toEqual([
      ["cursor-auto", 40],
      ["cursor-api", 20],
    ]);
    expect(quota.windows[0].reset).toBe(NOW + 1200);
    expect(quota.windows[0].window_minutes).toBe(40);
    expect(quota.details).toEqual([
      { label: "套餐用量", value: "$40.00 / $200.00" },
      { label: "按量预算", value: "$5.00 / $100.00" },
    ]);
  });

  it("老式按请求数套餐：只出一个 cursor-total 窗口", () => {
    const quota = normalizeCursorQuota({
      billingCycleStart: NOW - 3600, billingCycleEnd: NOW + 3600,
      individualUsage: { plan: {} },
    }, {
      requestUsage: { "gpt-4": { numRequestsTotal: 30, maxRequestUsage: 100 } },
      updated: NOW,
    });
    expect(quota.windows).toHaveLength(1);
    expect(quota.windows[0]).toMatchObject({
      id: "cursor-total", used_pct: 30, detail: "30 / 100 requests", window_minutes: 120,
    });
    expect(quota.details).toEqual([]);
  });

  it("plan 没有任何百分比时退回 overall 资金池的 used/limit", () => {
    const quota = normalizeCursorQuota({
      individualUsage: { overall: { used: 1500, limit: 6000 } },
    }, { updated: NOW });
    expect(quota.details).toEqual([{ label: "套餐用量", value: "$15.00 / $60.00" }]);
    expect(quota.windows).toEqual([]);
  });

  it("按天用量聚合成 today 区间并带模型/命中", () => {
    const bounds = rangeBounds(new Date(NOW * 1000));
    const today = dayKey(new Date(NOW * 1000));
    const events = [
      { timestamp: NOW, model: "gpt-4o", tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0, totalCents: 120 } },
      // 毫秒时间戳也要认；同一天的第二条
      { timestamp: NOW * 1000 + 60_000, model: "claude-3-5-sonnet", tokenUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalCents: 30 } },
      // 全零 token：丢弃
      { timestamp: NOW, model: "gpt-4o", tokenUsage: { inputTokens: 0, outputTokens: 0 } },
      // 没有 tokenUsage：丢弃
      { timestamp: NOW },
    ];
    const usage = normalizeCursorUsageEvents(events, { bounds });
    expect(usage.days[today]).toMatchObject({ tokens: 365, requests: 2, in: 110, out: 55, cr: 200 });
    expect(usage.ranges.today.tokens).toBe(365);
    expect(usage.ranges.today.requests).toBe(2);
    // cr / (in+cr+cw) 的命中率
    expect(usage.ranges.today.hit).toBeCloseTo((200 / 310) * 100, 3);
    const models = usage.ranges.today.models.map((m: any) => m.name);
    expect(models).toContain("GPT-4");
    expect(usage.ranges.week.tokens).toBe(365);
    expect(usage.ranges.year.tokens).toBe(365);
    expect(usage.ranges.last_week.tokens).toBe(0);
  });
});

describe("翻页取事件", () => {
  it("满页继续翻、末页不满即停，条数对账通过", async () => {
    const full = Array.from({ length: CURSOR_USAGE_PAGE_SIZE }, (_, i) => ({
      timestamp: NOW - i, model: "gpt-4o", tokenUsage: { inputTokens: 1 },
    }));
    const last = [{ timestamp: NOW, model: "gpt-4o", tokenUsage: { inputTokens: 2 } }];
    const total = CURSOR_USAGE_PAGE_SIZE + 1;
    responder = (url, options) => {
      if (url.includes("get-filtered-usage-events")) {
        return options.body.page === 1
          ? { totalUsageEventsCount: total, usageEventsDisplay: full }
          : { totalUsageEventsCount: total, usageEventsDisplay: last };
      }
      return {};
    };
    const quota = await fetchCursorQuota(deps);
    // usage 里当天 tokens 汇总应含末页那条
    expect(quota.usage.ranges.all.tokens).toBeGreaterThanOrEqual(2);
  });

  it("条数与返回不符：整段用量取失败也不影响额度返回", async () => {
    responder = (url) => {
      if (url.includes("get-filtered-usage-events")) {
        return { totalUsageEventsCount: 5000, usageEventsDisplay: [{ timestamp: NOW, tokenUsage: { inputTokens: 1 } }] };
      }
      return { individualUsage: { plan: { autoPercentUsed: 10 } } };
    };
    const quota = await fetchCursorQuota(deps);
    // 事件条数不足会抛，被 catch 掉，usage 留空但额度照样回来
    expect(quota.available).toBe(true);
    expect(quota.usage.ranges.all.tokens).toBe(0);
  });
});

describe("取数与缓存", () => {
  it("无凭据（既没 Cookie 也没库）就不联网", async () => {
    delete env.TOKEI_CURSOR_COOKIE;
    // 指向一个不存在的库，避免翻真实机器
    env.TOKEI_CURSOR_AUTH_DB = path.join(root, "missing.vscdb");
    expect(await scanCursorQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("开关关掉时即使有 Cookie 也不联网", async () => {
    env.TOKEI_CURSOR_QUOTA = "0";
    expect(await scanCursorQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("端到端对照抓包负载：窗口、明细、请求头与按天用量一起回来", async () => {
    responder = (url, options) => {
      if (url.includes("usage-summary")) return CURSOR_SUMMARY;
      if (url.includes("auth/me")) return { sub: "auth0|user-42", email: "ada@example.com" };
      if (url.includes("/api/usage?user=")) return { "gpt-4": { maxRequestUsage: null } };
      if (url.includes("get-sand-usage-status")) {
        return { usagePercent: 10, hasNonZeroIncludedLimit: true, grokPlanLabel: "Grok Pro" };
      }
      if (url.includes("get-filtered-usage-events")) {
        return { totalUsageEventsCount: 1, usageEventsDisplay: [{
          timestamp: NOW, model: "claude-sonnet-4",
          tokenUsage: { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 600, cacheWriteTokens: 0, totalCents: 250 },
        }] };
      }
      return {};
    };
    const quota = await scanCursorQuota(deps);
    expect(quota.plan).toBe("Cursor Pro+");
    expect(quota.account).toBe("ada@example.com");
    expect(quota.windows.map((w: any) => [w.id, w.used_pct, w.reset, w.window_minutes])).toEqual([
      ["cursor-auto", 40, NOW + 1200, 40],
      ["cursor-api", 20, NOW + 1200, 40],
    ]);
    expect(quota.details).toEqual([
      { label: "套餐用量", value: "$40.00 / $200.00" },
      { label: "按量预算", value: "$5.00 / $100.00" },
    ]);
    const today = dayKey(new Date(NOW * 1000));
    expect(quota.usage.days[today]).toMatchObject({ tokens: 2000, requests: 1, cost: 2.5 });
    expect(quota.usage.ranges.today.tokens).toBe(2000);
    expect(quota.usage.ranges.today.models[0].name).toBe("Sonnet 4");
    expect(quota.usage.ranges.today.hit).toBeCloseTo(37.5, 3);
    // 请求头：Cookie 全程带着，用量与 sand 接口还要求 Origin
    const events = requests.find((item) => item.url.includes("get-filtered-usage-events"))!;
    expect(events.options.headers.Origin).toBe("https://cursor.com");
    expect(events.options.headers.Cookie).toBe(env.TOKEI_CURSOR_COOKIE);
    expect(events.options.method).toBe("POST");
    expect(events.options.timeoutSeconds).toBe(15);
    expect(events.options.body.pageSize).toBe(CURSOR_USAGE_PAGE_SIZE);
    expect(events.options.body.startDate).toMatch(/^\d+$/);
    // user id 从 auth/me 的 sub 尾部取，并按 quote(safe="") 转义
    expect(requests.some((item) => item.url === "https://cursor.com/api/usage?user=user-42")).toBe(true);
    const sand = requests.find((item) => item.url.includes("get-sand-usage-status"))!;
    expect(sand.options.body).toEqual({});
  });

  it("同一凭据 5 分钟内只请求一次", async () => {
    responder = (url) => (url.includes("usage-summary")
      ? { membershipType: "pro", individualUsage: { plan: { autoPercentUsed: 12 } } } : {});
    const first = await scanCursorQuota(deps);
    expect(first.plan).toBe("Cursor Pro");
    const afterFirst = requests.length;
    expect(afterFirst).toBeGreaterThan(0);
    const second = await scanCursorQuota({ ...deps, now: () => NOW + 200 });
    expect(second).toEqual(first);
    expect(requests).toHaveLength(afterFirst);
  });

  it("请求失败退回一小时内的旧读数并标 stale，超窗则抛出错误", async () => {
    responder = (url) => (url.includes("usage-summary")
      ? { membershipType: "pro", individualUsage: { plan: { autoPercentUsed: 12 } } } : {});
    await scanCursorQuota(deps);
    responder = () => { throw new Error("boom"); };
    const stale = await scanCursorQuota({ ...deps, now: () => NOW + 900 });
    expect(stale.stale).toBe(true);
    expect(stale.source).toBe("cache");
    await expect(scanCursorQuota({ ...deps, now: () => NOW + PROVIDER_QUOTA_FALLBACK_TTL + 1 }))
      .rejects.toThrow("boom");
    expect(PROVIDER_QUOTA_TTL).toBe(300);
  });
});

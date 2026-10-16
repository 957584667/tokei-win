/**
 * z.ai fetcher 单测：fixture 传输层，不发任何真实请求、不写真实 ~/.tokei。
 * 覆盖 region/scope 白名单、团队作用域缺组织、Key 兜底 env、双区域域名与请求头、
 * 余额/曲线失败静默、5 分钟缓存、失败退旧读数、额度与模型用量归一化。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { useProviderQuotaFiles } from "../src/core/providerQuota";
import { Bounds } from "../src/core/ranges";
import { QuotaDeps, baseDeps } from "../src/main/quota/context";
import {
  fetchZaiQuota, normalizeZaiModelUsage, normalizeZaiQuota, scanZaiQuota,
  zaiModelUsageUrl, zaiQuotaUrl,
} from "../src/main/quota/zai";

const NOW = 1_800_000_000;
let root: string;
let env: Record<string, string>;
let requests: Array<{ url: string; headers: Record<string, string>; options: any }>;
let responder: (url: string) => any;
let deps: QuotaDeps;

// 两条 TOKENS_LIMIT（1440 与 10080 分钟）+ 一条 TIME_LIMIT（unit5/number1 → 43200 分钟）
// + 一条未知类型必须被丢弃
const QUOTA_PAYLOAD = {
  success: true, code: 200,
  data: {
    plan_type: " GLM Pro Max ",
    limits: [
      { type: "TOKENS_LIMIT", unit: 1, number: 1, percentage: 40, usage: 1000,
        remaining: 700, nextResetTime: NOW + 3600 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 25, usage: "2000",
        remaining: 500, currentValue: 1600 },
      { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 12, usage: 100, remaining: 88,
        usageDetails: [
          { modelCode: "glm-4.6", usage: 2000 },
          { modelCode: 5, usage: 1 },
          { modelCode: "glm-4.5", usage: -2 },
          { modelCode: "glm-x", usage: "bad" },
        ] },
      { type: "BOGUS", unit: 1, number: 1, percentage: 1 },
    ],
  },
};

const MODEL_PAYLOAD = {
  success: true, code: 200,
  data: {
    x_time: ["2026-01-15 10:00:00", "2026-01-14 23:00:00", "bad-label"],
    modelDataList: [
      { modelName: " GLM-4.6 ", tokensUsage: [1500, 200, 999] },
      { modelName: "", tokensUsage: [null, -5, 10] },
      { modelName: "glm", tokensUsage: [5] },
    ],
  },
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-zai-"));
  useProviderQuotaFiles(path.join(root, "provider_quota_cache.json"), path.join(root, "config.json"));
  env = { TOKEI_ZAI_QUOTA: "1", Z_AI_API_KEY: "key-z", TZ: "Asia/Shanghai" };
  requests = [];
  responder = (url) => (url.includes("model-usage") ? MODEL_PAYLOAD : QUOTA_PAYLOAD);
  deps = baseDeps({
    env: (key) => env[key],
    config: () => ({}),
    request: async (url, options) => {
      requests.push({ url, headers: (options?.headers ?? {}) as Record<string, string>, options });
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
  it("team 作用域把 type 顶掉换成 2，其余参数与锚点保留", () => {
    expect(zaiQuotaUrl("https://api.z.ai/api/monitor/usage/quota/limit", "personal"))
      .toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(zaiQuotaUrl("https://api.z.ai/api/monitor/usage/quota/limit", "team"))
      .toBe("https://api.z.ai/api/monitor/usage/quota/limit?type=2");
    expect(zaiQuotaUrl("https://x.example/a?b=1&type=9#frag", "team"))
      .toBe("https://x.example/a?b=1&type=2#frag");
  });

  it("model-usage 窗口：start 取当日零点、end 把分时秒钉到 59:59（原版怪写法）", () => {
    const now = new Date(2026, 5, 15, 10, 30, 45); // 6 月中旬，任何时区都没有 DST 跨界
    expect(zaiModelUsageUrl("https://api.z.ai", "personal", now)).toBe(
      "https://api.z.ai/api/monitor/usage/model-usage"
      + "?startTime=2026-05-16+00%3A00%3A00&endTime=2026-06-15+10%3A59%3A59");
    expect(zaiModelUsageUrl("https://api.z.ai/", "team", now))
      .toContain("&type=3");
  });
});

describe("额度归一化", () => {
  it("会话/周期/MCP 三窗口与明细，percentage 会被用量口径重算", () => {
    const quota = normalizeZaiQuota(QUOTA_PAYLOAD, { region: "global", updated: NOW });
    expect(quota.available).toBe(true);
    expect(quota.plan).toBe("GLM Pro Max");
    expect(quota.source).toBe("zai-api");
    expect(quota.updated).toBe(NOW);
    expect(quota.stale).toBe(false);
    // usage=1000 remaining=700 current 缺失 → used=300 → 30%（接口 percentage 40 被覆盖）
    // usage=2000 remaining=500 current=1600 → used=max(1500,1600)=1600 → 80%
    expect(quota.windows.map((w: any) =>
      [w.id, w.title, w.used_pct, w.reset, w.window_minutes, w.detail])).toEqual([
      ["zai-primary", "会话额度", 30, NOW + 3600, 1440, "1000 limit · 700 remaining"],
      ["zai-secondary", "周期额度", 80, null, 10080, "2000 limit · 500 remaining"],
      ["zai-mcp", "MCP", 12, null, 43200, "100 limit · 88 remaining"],
    ]);
    expect(quota.details).toEqual([
      { label: "Token quota", value: "80% used", secondary: "2000 limit · 500 remaining" },
      { label: "Session token quota", value: "30% used", secondary: "1000 limit · 700 remaining" },
      { label: "MCP quota", value: "12% used", secondary: "100 limit · 88 remaining" },
      { label: "glm-4.6", value: "2,000" },
    ]);
  });

  it("只有一条窗口额度时不产生 secondary 窗口", () => {
    const single = normalizeZaiQuota(
      { success: true, code: 200, data: { limits: [QUOTA_PAYLOAD.data.limits[0]] } },
      { updated: NOW });
    expect(single.windows.map((w: any) => w.id)).toEqual(["zai-primary"]);
    expect(single.windows[0].title).toBe("额度");
    expect(single.details[0].label).toBe("Token quota");
  });

  it("success 非 true 或 code 非 200 一律 {}", () => {
    expect(normalizeZaiQuota({ success: false, code: 200, data: {} }, {})).toEqual({});
    expect(normalizeZaiQuota({ success: true, code: 1001, data: {} }, {})).toEqual({});
    expect(normalizeZaiQuota("nope", {})).toEqual({});
  });

  it("bigmodel-cn 才拼人民币余额行，giveAmount 为 0 时省略", () => {
    const quota = normalizeZaiQuota(
      { success: true, code: 200, data: { limits: [] } },
      {
        region: "bigmodel-cn",
        balance: { success: true, data: {
          availableBalance: "88.8", rechargeAmount: 100, giveAmount: 0, totalSpendAmount: 12.5,
        } },
        updated: NOW,
      });
    expect(quota.details).toEqual([{
      label: "Account balance", value: "¥88.80",
      secondary: "recharged ¥100.00 · spent ¥12.50",
    }]);
    const globalQuota = normalizeZaiQuota(
      { success: true, code: 200, data: { limits: [] } },
      { region: "global", balance: { success: true, data: { availableBalance: 5 } }, updated: NOW });
    expect(globalQuota.details).toEqual([]);
  });
});

describe("模型用量归一化", () => {
  const bounds: Bounds = {
    today: "2026-01-15", yesterday: "2026-01-14", week: "2026-01-12",
    last_week: "2026-01-05", last_week_end: "2026-01-12",
    month: "2026-01-01", year: "2026-01-01",
  };

  it("x_time × modelDataList 摊成按天桶，坏标签与负值跳过", () => {
    const usage = normalizeZaiModelUsage(MODEL_PAYLOAD, { bounds });
    expect(usage.ranges.today.tokens).toBe(1505); // GLM-4.6 的 1500 + glm 的 5
    expect(usage.ranges.today.models.map((m) => m.tokens)).toEqual([1500, 5]);
    expect(usage.ranges.yesterday.tokens).toBe(200);
    expect(usage.ranges.week.tokens).toBe(1705);
    expect(usage.ranges.all.tokens).toBe(1705);
    expect(usage.ranges.all.coverage).toBe("近30天");
    expect(Object.keys(usage.days)).toEqual(["2026-01-15", "2026-01-14"]);
    expect(usage.days["2026-01-15"].hours[10]).toBe(1505);
  });

  it("接口失败退回空曲线但保留近30天口径", () => {
    const usage = normalizeZaiModelUsage({ success: true, code: 500 }, { bounds });
    expect(usage.ranges.all.tokens).toBe(0);
    expect(usage.ranges.year.coverage).toBe("近30天");
  });
});

describe("取数", () => {
  it("缺 Key 就不联网", async () => {
    delete env.Z_AI_API_KEY;
    expect(await scanZaiQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("开关关掉时即使凭据齐全也不联网", async () => {
    env.TOKEI_ZAI_QUOTA = "0";
    expect(await scanZaiQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("region/scope 白名单外一律 {}，team 缺组织或项目也不联网", async () => {
    env.Z_AI_REGION = "eu-west";
    expect(await scanZaiQuota(deps)).toEqual({});
    delete env.Z_AI_REGION;
    env.Z_AI_USAGE_SCOPE = "org";
    expect(await scanZaiQuota(deps)).toEqual({});
    env.Z_AI_USAGE_SCOPE = "team";
    expect(await scanZaiQuota(deps)).toEqual({});
    env.Z_AI_ORGANIZATION = "org-1";
    expect(await scanZaiQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("global 区域走 api.z.ai，两条请求都带 Bearer 头，曲线请求 15 秒 + 8MiB", async () => {
    const quota = await scanZaiQuota(deps);
    expect(quota.windows[0].id).toBe("zai-primary");
    expect(quota.usage.ranges.all.tokens).toBe(1705);
    expect(quota.usage.ranges.all.coverage).toBe("近30天");
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(requests[0].headers.Authorization).toBe("Bearer key-z");
    expect(requests[0].options.timeoutSeconds).toBeUndefined();
    expect(requests[1].url).toMatch(
      /^https:\/\/api\.z\.ai\/api\/monitor\/usage\/model-usage\?startTime=\d{4}-\d{2}-\d{2}\+00%3A00%3A00&endTime=/);
    expect(requests[1].options.timeoutSeconds).toBe(15);
    expect(requests[1].options.maxBytes).toBe(8 * 1024 * 1024);
  });

  it("bigmodel-cn：open.bigmodel.cn 域名 + 余额请求，Key 允许 BIGMODEL_API_KEY 兜底", async () => {
    env.Z_AI_REGION = "bigmodel-cn";
    delete env.Z_AI_API_KEY;
    env.BIGMODEL_API_KEY = "bm-key";
    responder = (url) => {
      if (url.includes("query-customer-account-report")) {
        return { success: true, data: { availableBalance: 5 } };
      }
      if (url.includes("model-usage")) throw new Error("model usage unavailable");
      return QUOTA_PAYLOAD;
    };
    const quota = await scanZaiQuota(deps);
    expect(requests.map((r) => new URL(r.url).host).sort()).toEqual(
      ["open.bigmodel.cn", "open.bigmodel.cn", "www.bigmodel.cn"]);
    expect(requests.every((r) => r.headers.Authorization === "Bearer bm-key")).toBe(true);
    expect(quota.details).toContainEqual(
      { label: "Account balance", value: "¥5.00" });
    // 曲线接口失败静默：退回空用量而不是让整个额度作废
    expect(quota.usage.ranges.all.tokens).toBe(0);
    // balance 请求也带 5 秒超时
    const balance = requests.find((r) => r.url.startsWith("https://www.bigmodel.cn"))!;
    expect(balance.options.timeoutSeconds).toBe(5);
  });

  it("team 作用域：quota URL 钉 type=2，两条组织/项目请求头", async () => {
    env.Z_AI_USAGE_SCOPE = "team";
    env.Z_AI_ORGANIZATION = "org-1";
    env.Z_AI_PROJECT = "proj-1";
    await fetchZaiQuota(deps);
    expect(requests[0].url).toBe(
      "https://api.z.ai/api/monitor/usage/quota/limit?type=2");
    expect(requests[0].headers["Bigmodel-Organization"]).toBe("org-1");
    expect(requests[0].headers["Bigmodel-Project"]).toBe("proj-1");
    expect(requests[1].url).toContain("&type=3");
  });

  it("同一凭据 5 分钟内只请求一次", async () => {
    const first = await scanZaiQuota(deps);
    expect(requests).toHaveLength(2);
    const second = await scanZaiQuota({ ...deps, now: () => NOW + 200 });
    expect(second).toEqual(first);
    expect(requests).toHaveLength(2);
  });

  it("请求失败退回一小时内的旧读数并标 stale，超窗则把错误抛给上层", async () => {
    await scanZaiQuota(deps);
    responder = () => { throw new Error("boom"); };
    const stale = await scanZaiQuota({ ...deps, now: () => NOW + 900 });
    expect(stale.stale).toBe(true);
    expect(stale.source).toBe("cache");
    await expect(scanZaiQuota({ ...deps, now: () => NOW + 4000 })).rejects.toThrow("boom");
  });
});

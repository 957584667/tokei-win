/**
 * MiniMax fetcher 单测：fixture 传输层，不发任何真实请求、不写真实 ~/.tokei。
 * 覆盖凭据缺失、默认开关、区域轮换（1004 换区）、同区域新旧入口、5 分钟缓存、
 * 失败节流与旧读数回退、空结果 attempt 记录、归一化对拍。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  providerCredentialMarker, providerQuotaCacheFile, saveProviderQuotaCache,
  useProviderQuotaFiles,
} from "../src/core/providerQuota";
import { QuotaDeps, baseDeps } from "../src/main/quota/context";
import { HttpError } from "../src/main/quota/http";
import {
  fetchMinimaxQuota, minimaxNumber, minimaxReset, minimaxWindowUsage, normalizeMinimaxQuota,
  scanMinimaxQuota,
} from "../src/main/quota/minimax";

const NOW = 1_800_000_000;
const CN = [
  "https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains",
  "https://www.minimax.cn/v1/token_plan/remains",
];
const GLOBAL = [
  "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
  "https://www.minimax.io/v1/token_plan/remains",
];

/** 原版注释里说的「几种写法并存」，这里各占一种：剩余百分比 / 不限量 / 计数 */
const PAYLOAD = {
  base_resp: { status_code: 0 },
  model_remains: [
    {
      model_name: "general",
      current_interval_status: 1,
      current_interval_remaining_percent: 62.5,
      end_time: NOW + 900,
      remains_time: 900_000,
      current_weekly_status: 3,
      weekly_end_time: NOW + 100_000,
      weekly_remains_time: 100_000_000,
    },
    {
      model_name: "MiniMax-Hailuo-02 video",
      current_interval_status: 0,
      current_interval_total_count: "100",
      // usage_count 其实是「剩余」次数
      current_interval_usage_count: "37",
      end_time: NOW + 1800,
    },
  ],
};

let root: string;
let env: Record<string, string>;
let config: Record<string, any>;
let secret: string | null;
let requests: Array<{ url: string; headers: Record<string, string> }>;
let responder: (url: string) => any;
let deps: QuotaDeps;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-minimax-"));
  useProviderQuotaFiles(path.join(root, "provider_quota_cache.json"), path.join(root, "config.json"));
  env = { TOKEI_MINIMAX_QUOTA: "1", TOKEI_MINIMAX_API_KEY: "sk-cp-test" };
  config = {};
  secret = null;
  requests = [];
  responder = () => JSON.parse(JSON.stringify(PAYLOAD));
  deps = baseDeps({
    env: (key) => env[key],
    config: () => config,
    secret: () => secret,
    request: async (url, options) => {
      requests.push({ url, headers: (options?.headers ?? {}) as Record<string, string> });
      return responder(url);
    },
    now: () => NOW,
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  useProviderQuotaFiles(null, null);
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function readCache(): any {
  return JSON.parse(fs.readFileSync(providerQuotaCacheFile(), "utf8"));
}

describe("取数", () => {
  it("没填 Key 就不联网", async () => {
    delete env.TOKEI_MINIMAX_API_KEY;
    expect(await scanMinimaxQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("默认关闭：凭据齐全也不联网", async () => {
    delete env.TOKEI_MINIMAX_QUOTA;
    expect(await scanMinimaxQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("DPAPI 凭据与 config 仍是合法的 Key 来源", async () => {
    delete env.TOKEI_MINIMAX_API_KEY;
    secret = "sk-cp-dpapi";
    await fetchMinimaxQuota(deps);
    expect(requests[0].headers.Authorization).toBe("Bearer sk-cp-dpapi");
  });

  it("同一凭据 5 分钟内只请求一次，且钉死 URL 与 Bearer 头", async () => {
    const first = await scanMinimaxQuota(deps);
    expect(first.plan).toBe("Token Plan");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(CN[0]);
    expect(requests[0].headers.Authorization).toBe("Bearer sk-cp-test");
    const second = await scanMinimaxQuota({ ...deps, now: () => NOW + 200 });
    expect(second).toEqual(first);
    expect(requests).toHaveLength(1);
    // 缓存里的 marker 就是凭据的 sha256，换 Key 后必须重新请求
    expect(readCache().providers.minimax.marker)
      .toBe(providerCredentialMarker("minimax-remains-v1", "sk-cp-test"));
    env.TOKEI_MINIMAX_API_KEY = "sk-cp-other";
    await scanMinimaxQuota({ ...deps, now: () => NOW + 200 });
    expect(requests).toHaveLength(2);
  });

  it("中国区 Key 打到国际区得到 1004：换区域再试并记住查通的区域", async () => {
    responder = (url) => (GLOBAL.includes(url)
      ? JSON.parse(JSON.stringify(PAYLOAD))
      : { base_resp: { status_code: 1004 } });
    const quota = await scanMinimaxQuota(deps);
    expect(quota.region).toBe("global");
    expect(requests.map((r) => r.url)).toEqual([CN[0], GLOBAL[0]]);
  });

  it("上次查通的区域先试，省掉一次注定 1004 的请求", async () => {
    // 手动种一条过期但区域为 global 的读数（fetched_at 远早于 TTL）
    saveProviderQuotaCache("minimax", "seed", { ...normalizeMinimaxQuota(PAYLOAD, "global", NOW), available: true }, NOW - 4000);
    await fetchMinimaxQuota(deps);
    expect(requests.map((r) => r.url)).toEqual([GLOBAL[0]]);
  });

  it("TOKEI_MINIMAX_REGION 显式配置压倒一切", async () => {
    env.TOKEI_MINIMAX_REGION = "global";
    await fetchMinimaxQuota(deps);
    expect(requests[0].url).toBe(GLOBAL[0]);
  });

  it("同区域旧入口 404 就换新入口", async () => {
    responder = (url) => {
      if (url === CN[0]) throw new HttpError(404);
      return JSON.parse(JSON.stringify(PAYLOAD));
    };
    const quota = await fetchMinimaxQuota(deps);
    expect(quota.region).toBe("cn");
    expect(requests.map((r) => r.url)).toEqual([CN[0], CN[1]]);
  });

  it("失败后按 TTL 节流：Key 填错不至于每次刷新都敲接口", async () => {
    responder = () => { throw new Error("ECONNREFUSED"); };
    await expect(fetchMinimaxQuota(deps)).rejects.toThrow("ECONNREFUSED");
    expect(requests).toHaveLength(1);
    expect(await fetchMinimaxQuota({ ...deps, now: () => NOW + 60 })).toEqual({});
    expect(requests).toHaveLength(1);
  });

  it("请求失败退回一小时内的旧读数并标 stale，超窗则把错误抛给上层", async () => {
    await fetchMinimaxQuota(deps);
    responder = () => { throw new Error("boom"); };
    const stale = await fetchMinimaxQuota({ ...deps, now: () => NOW + 900 });
    expect(stale.stale).toBe(true);
    expect(stale.source).toBe("cache");
    await expect(fetchMinimaxQuota({ ...deps, now: () => NOW + 4000 })).rejects.toThrow("boom");
  });

  it("非 1004 的业务码按错误抛出", async () => {
    responder = () => ({ base_resp: { status_code: 2 }, model_remains: [] });
    await expect(fetchMinimaxQuota(deps)).rejects.toThrow("MiniMax quota error 2");
  });

  it("两个区域都 1004 视为 Key 被拒", async () => {
    responder = () => ({ base_resp: { status_code: 1004 } });
    await expect(fetchMinimaxQuota(deps)).rejects.toThrow("MiniMax rejected the Token Plan key");
    expect(requests.map((r) => r.url)).toEqual([CN[0], GLOBAL[0]]);
  });

  it("接口通了但没有任何额度环：记 attempt=empty 且不落缓存", async () => {
    responder = () => ({ base_resp: { status_code: 0 }, model_remains: [] });
    expect(await fetchMinimaxQuota(deps)).toEqual({});
    const entry = readCache().providers.minimax;
    expect(entry.attempt_result).toBe("empty");
    expect(entry.quota).toBeUndefined();
    expect(await fetchMinimaxQuota({ ...deps, now: () => NOW + 60 })).toEqual({});
    expect(requests).toHaveLength(1);
  });
});

describe("归一化", () => {
  it("剩余百分比、不限量与视频计数各成一条窗口", () => {
    const quota = normalizeMinimaxQuota(PAYLOAD, "cn", NOW);
    expect(quota.available).toBe(true);
    expect(quota.plan).toBe("Token Plan");
    expect(quota.account).toBeNull();
    expect(quota.source).toBe("minimax-api");
    expect(quota.details).toEqual([]);
    expect(quota.updated).toBe(NOW);
    expect(quota.stale).toBe(false);
    expect(quota.windows).toEqual([
      { id: "minimax-5h", title: "5小时额度", used_pct: 37.5, reset: NOW + 900,
        window_minutes: 300, detail: null, usage_known: true },
      { id: "minimax-weekly", title: "周额度", used_pct: 0, reset: NOW + 100_000,
        window_minutes: 10080, detail: "不限量", usage_known: true },
      { id: "minimax-video", title: "视频额度", used_pct: 63, reset: NOW + 1800,
        window_minutes: null, detail: "63/100 次", usage_known: true },
    ]);
  });

  it("文本环取 model_name=general，没有 general 才取第一个非视频条目", () => {
    const entries = [
      { model_name: "MiniMax-Text-01", current_interval_remaining_percent: 40 },
      { model_name: "general", current_interval_remaining_percent: 60 },
    ];
    expect(normalizeMinimaxQuota({ model_remains: entries }, "cn", NOW).windows[0].used_pct)
      .toBe(40);
  });

  it("字符串百分比剥 %，加赠时按总额折算", () => {
    const [used, detail] = minimaxWindowUsage({
      current_interval_status: 0,
      current_interval_used_percent: "75%",
      current_interval_total_percent: "150%",
    }, "current_interval");
    expect(used).toBe(50);
    expect(detail).toBeNull();
    expect(minimaxNumber("  12.5 % ")).toBe(12.5);
  });

  it("end_time 缺失用 remains_time 毫秒推算重置时刻", () => {
    expect(minimaxReset({ remains_time: 900_000 }, "end_time", "remains_time", NOW))
      .toBe(NOW + 900);
    expect(minimaxReset({}, "end_time", "remains_time", NOW)).toBeNull();
  });

  it("计数写法的千分位与负数兜底", () => {
    const [used, detail] = minimaxWindowUsage({
      current_interval_status: 0,
      current_interval_total_count: 1234,
      current_interval_usage_count: -5, // 剩余为负：used 顶到 total，providerWindow 再把百分比夹回 100
    }, "current_interval");
    expect(used).toBe((1239 / 1234) * 100);
    expect(detail).toBe("1,239/1,234 次");
  });

  it("没有可用环时 available=false、plan=null", () => {
    const quota = normalizeMinimaxQuota({ model_remains: [{ model_name: "general" }] }, "cn", NOW);
    expect(quota.available).toBe(false);
    expect(quota.plan).toBeNull();
  });

  it("model_remains 缺失或非字典条目都不炸", () => {
    expect(normalizeMinimaxQuota({}, "cn", NOW).windows).toEqual([]);
    expect(normalizeMinimaxQuota(null, "cn", NOW).available).toBe(false);
    expect(normalizeMinimaxQuota({ model_remains: [null, "x", 1] }, "cn", NOW).windows).toEqual([]);
  });
});

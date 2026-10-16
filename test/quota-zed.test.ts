/**
 * Zed fetcher 单测：fixture 传输层，不发任何真实请求。
 * 覆盖凭据缺失、5 分钟缓存命中、失败退旧读数、归一化结果。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { useProviderQuotaFiles } from "../src/core/providerQuota";
import { QuotaDeps, baseDeps } from "../src/main/quota/context";
import { normalizeZedQuota, scanZedQuota, zedConnectionSettings, zedPlanName } from "../src/main/quota/zed";

const NOW = 1_800_000_000;
let root: string;
let settingsFile: string;
let env: Record<string, string>;
let requests: Array<{ url: string; headers: Record<string, string> }>;
let responder: (url: string) => any;
let deps: QuotaDeps;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-zed-"));
  settingsFile = path.join(root, "zed-settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ server_url: "https://zed.dev/" }));
  useProviderQuotaFiles(path.join(root, "provider_quota_cache.json"), path.join(root, "config.json"));
  env = {
    TOKEI_ZED_QUOTA: "1",
    TOKEI_ZED_SETTINGS: settingsFile,
    TOKEI_ZED_USER_ID: "user-1",
    TOKEI_ZED_ACCESS_TOKEN: "token-1",
  };
  requests = [];
  responder = () => ({
    user: { name: "Ada", github_login: "ada" },
    plan: { plan_v3: "zed_pro", usage: { edit_predictions: { used: 1, limit: "Unlimited" } } },
  });
  deps = baseDeps({
    env: (key) => env[key],
    config: () => ({}),
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

describe("连接设置", () => {
  it("官方域走 cloud.zed.dev，非官方且 credentials_url 不一致直接判不可信", () => {
    expect(zedConnectionSettings({ server_url: "https://zed.dev" }))
      .toEqual({ service: "https://zed.dev", api_url: "https://cloud.zed.dev/client/users/me" });
    // 官方与 staging 都走 cloud.zed.dev，只有自建服务才用 server_url 本身
    expect(zedConnectionSettings({ server_url: "https://staging.zed.dev" }).api_url)
      .toBe("https://cloud.zed.dev/client/users/me");
    expect(zedConnectionSettings({ server_url: "https://zed.example/" }).api_url)
      .toBe("https://zed.example/client/users/me");
    expect(zedConnectionSettings({ server_url: "https://zed.example", credentials_url: "https://other/credentials" }))
      .toBeNull();
    expect(zedConnectionSettings({ server_url: "http://zed.dev" })).toBeNull();
    expect(zedConnectionSettings({ server_url: "https://zed.dev?next=1" })).toBeNull();
    expect(zedConnectionSettings({})).toEqual({ service: "https://zed.dev", api_url: "https://cloud.zed.dev/client/users/me" });
  });

  it("套餐名有映射表，其余按下划线拆词首字母大写", () => {
    expect(zedPlanName("zed_pro_trial")).toBe("Zed Pro Trial");
    expect(zedPlanName("zed_education")).toBe("Zed Education");
    expect(zedPlanName("  ")).toBeNull();
  });
});

describe("归一化", () => {
  it("预测用量、订阅周期与逾期账单各成一条窗口", () => {
    const quota = normalizeZedQuota({
      user: { name: "Ada", github_login: "ada" },
      plan: {
        plan_v3: "zed_pro",
        usage: { edit_predictions: { used: 30, limit: { limited: 100 } } },
        subscription_period: { started_at: NOW - 1200, ended_at: NOW + 1200 },
        has_overdue_invoices: true,
      },
      organizations: [
        { id: 7, name: "Acme" },
        { id: 8, name: "" },
      ],
      plans_by_organization: { "7": "zed_business" },
      default_organization_id: 7,
    }, NOW);
    expect(quota.available).toBe(true);
    expect(quota.plan).toBe("Zed Business");
    expect(quota.account).toBe("ada");
    expect(quota.windows.map((w: any) => [w.id, w.used_pct, w.detail])).toEqual([
      ["zed-predictions", 30, "30 / 100 predictions"],
      ["zed-cycle", 50, null],
      ["zed-overdue", null, "Overdue invoices"],
    ]);
    expect(quota.windows[1].reset).toBe(NOW + 1200);
    expect(quota.windows[1].window_minutes).toBe(40);
    expect(quota.windows[2].usage_known).toBe(false);
    expect(quota.details).toEqual([
      { label: "账号", value: "Ada" },
      { label: "Acme", value: "Zed Business", secondary: "当前组织" },
    ]);
    expect(quota.updated).toBe(NOW);
    expect(quota.stale).toBe(false);
  });

  it("limit 为 unlimited 时按 0% 显示", () => {
    const quota = normalizeZedQuota({ plan: { usage: { edit_predictions: { used: 999, limit: "Unlimited" } } } }, NOW);
    expect(quota.windows[0]).toMatchObject({ used_pct: 0, detail: "Unlimited" });
  });
});

describe("取数", () => {
  it("缺任一凭据就不联网", async () => {
    delete env.TOKEI_ZED_ACCESS_TOKEN;
    expect(await scanZedQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("开关关掉时即使凭据齐全也不联网", async () => {
    env.TOKEI_ZED_QUOTA = "0";
    expect(await scanZedQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("同一凭据 5 分钟内只请求一次", async () => {
    const first = await scanZedQuota(deps);
    expect(first.plan).toBe("Zed Pro");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://cloud.zed.dev/client/users/me");
    expect(requests[0].headers.Authorization).toBe("user-1 token-1");
    expect(requests[0].headers["User-Agent"]).toBe("Tokei/1.0");
    const second = await scanZedQuota({ ...deps, now: () => NOW + 200 });
    expect(second).toEqual(first);
    expect(requests).toHaveLength(1);
    // 换账号后 marker 变了，必须重新请求
    env.TOKEI_ZED_ACCESS_TOKEN = "token-2";
    await scanZedQuota({ ...deps, now: () => NOW + 200 });
    expect(requests).toHaveLength(2);
  });

  it("请求失败退回一小时内的旧读数并标 stale，超窗则把错误抛给上层", async () => {
    await scanZedQuota(deps);
    responder = () => { throw new Error("boom"); };
    const stale = await scanZedQuota({ ...deps, now: () => NOW + 900 });
    expect(stale.stale).toBe(true);
    expect(stale.source).toBe("cache");
    await expect(scanZedQuota({ ...deps, now: () => NOW + 4000 })).rejects.toThrow("boom");
  });
});

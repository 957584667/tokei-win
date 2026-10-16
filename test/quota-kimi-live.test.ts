/**
 * Kimi Code 实时额度单测：fixture 传输层 + 临时文件，零网络、零真实 ~/.tokei / ~/.kimi-code 读写。
 * 覆盖：TOKEI_KIMI_LIVE_QUOTA=0 关闭、Base URL 校验、凭据缺失、5 分钟缓存只请求一次、
 * token 过期沿用「未走完窗口」的旧读数、失败冷却、新旧两种响应形状的归一化。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { baseDeps, QuotaDeps } from "../src/main/quota/context";
import {
  KIMI_USAGE_MAX_RESPONSE_BYTES, cachedKimiLiveLimits, fetchKimiLiveLimits, kimiAuthContext,
  kimiLiveToLimits, kimiQuotaValues, kimiSlot, kimiUsageTarget, kimiWindowMinutes, useKimiLiveFiles,
} from "../src/main/quota/kimiLive";

let root: string;
let cacheFile: string;
let credentialFile: string;
let env: Record<string, string>;
let requests: Array<{ url: string; headers: Record<string, string>; options: any }>;
let responder: () => any;
let clock: number;

function deps(): QuotaDeps {
  return baseDeps({
    env: (key) => env[key],
    config: () => ({}),
    request: async (url, options) => {
      requests.push({ url, headers: (options?.headers ?? {}) as Record<string, string>, options });
      return responder();
    },
    now: () => clock,
  });
}

function writeCredentials(token: string | null, expiresAt: number | null): void {
  const body: Record<string, any> = { refresh_token: "never-touch-me" };
  if (token) body.access_token = token;
  if (expiresAt !== null) body.expires_at = expiresAt;
  fs.writeFileSync(credentialFile, JSON.stringify(body));
}

const ISO_LIVE = () => ({
  usages: {
    limit_5h: { used_ratio: 0.25, reset_time: new Date((clock + 1800) * 1000).toISOString() },
    limit_month_total: { used_ratio: 1.8, reset_time: new Date((clock + 86400) * 1000).toISOString() },
  },
  user: { userId: "u-9", membership: { level: "KimiCode Pro" } },
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-kimi-"));
  cacheFile = path.join(root, "kimi_quota_cache.json");
  credentialFile = path.join(root, "kimi-code.json");
  env = {};
  requests = [];
  responder = ISO_LIVE;
  clock = Math.trunc(Date.now() / 1000);
  useKimiLiveFiles({ cache: cacheFile, credentialFiles: [credentialFile] });
  writeCredentials("kimi-token", clock + 1800);
});

afterEach(() => {
  useKimiLiveFiles(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("开关与目标", () => {
  it("TOKEI_KIMI_LIVE_QUOTA=0 直接不联网", async () => {
    env.TOKEI_KIMI_LIVE_QUOTA = "0";
    expect(await fetchKimiLiveLimits(deps())).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("Base URL 只认干净的 https：明文、带 query、带账号密码一律作废", () => {
    env.KIMI_CODE_BASE_URL = "http://api.kimi.com/coding/v1";
    expect(kimiUsageTarget(deps())).toBeNull();
    env.KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1?debug=1";
    expect(kimiUsageTarget(deps())).toBeNull();
    env.KIMI_CODE_BASE_URL = "https://u:p@api.kimi.com/coding/v1";
    expect(kimiUsageTarget(deps())).toBeNull();
  });

  it("路径后缀三种写法都能拼出 /coding/v1/usages，端口原样保留", () => {
    expect(kimiUsageTarget(deps())?.[0]).toBe("https://api.kimi.com/coding/v1/usages");
    env.KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1/usages/";
    expect(kimiUsageTarget(deps())?.[0]).toBe("https://api.kimi.com/coding/v1/usages");
    env.KIMI_CODE_BASE_URL = "https://kimi.example/coding";
    expect(kimiUsageTarget(deps())?.[0]).toBe("https://kimi.example/coding/v1/usages");
    env.KIMI_CODE_BASE_URL = "https://kimi.example:8443/";
    const target = kimiUsageTarget(deps());
    expect(target).toEqual(["https://kimi.example:8443/coding/v1/usages", "kimi.example", 8443]);
  });

  it("没有凭据文件就不发请求；只读 access_token，绝不用 refresh_token", async () => {
    fs.rmSync(credentialFile);
    expect(await fetchKimiLiveLimits(deps())).toBeNull();
    expect(requests).toHaveLength(0);
    const auth = kimiAuthContext(deps());
    expect(auth.access_token).toBeUndefined();
  });

  it("auth_key 是 token 的 sha256，换号后旧缓存不能接着用", () => {
    const auth = kimiAuthContext(deps());
    expect(auth.auth_key).toBe(crypto.createHash("sha256").update("kimi-token", "utf8").digest("hex"));
    expect(auth.expired).toBe(false);
  });

  it("token 已过期：不发这次必然 401 的请求", async () => {
    writeCredentials("kimi-token", clock - 1);
    expect(kimiAuthContext(deps()).expired).toBe(true);
    expect(await fetchKimiLiveLimits(deps())).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("expires_at 写成毫秒也认（11826 的秒/毫秒两可）", () => {
    writeCredentials("kimi-token", (clock - 1) * 1000);
    expect(kimiAuthContext(deps()).expired).toBe(true);
  });
});

describe("归一化", () => {
  it("新版 usages 池：used_ratio 夹到 100%，plan/user_id 从 user 里取", () => {
    const limits = kimiLiveToLimits(ISO_LIVE());
    expect(limits).toEqual({
      limit_id: "kimicode",
      five_hour: { used_percent: 25, resets_at: clock + 1800 },
      subscription: { used_percent: 100, resets_at: clock + 86400 },
      plan: "KimiCode Pro",
      user_id: "u-9",
    });
  });

  it("旧版 limits/usage 结构：window 时长命中 300 分钟才算 5 小时槽", () => {
    const limits = kimiLiveToLimits({
      limits: [
        { window: { duration: "60", timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: 100, used: 200 } },
        { window: { timeUnit: "TIME_UNIT_HOUR", duration: 5 }, detail: { limit: "500", remaining: 100, resetTime: clock + 600 } },
      ],
      usage: { limit: 0, used: 5 },
    });
    // 第一-个窗口 60 分钟不是 5 小时；第二个 used = limit-remaining = 400 → 80%
    expect(limits?.five_hour).toEqual({ used_percent: 80, resets_at: clock + 600 });
    // usage 的 limit<=0 判无效 → subscription 缺失
    expect(limits?.subscription).toBeNull();
    expect(kimiWindowMinutes({ duration: 5, timeUnit: "TIME_UNIT_HOUR" })).toBe(300);
    expect(kimiWindowMinutes({ duration: 5, timeUnit: "TIME_UNIT_UNKNOWN" })).toBeNull();
    // used 超限时夹到 100%
    expect(kimiSlot({ limit: 100, used: 200 })).toEqual({ used_percent: 100 });
  });

  it("没有任何可用槽位就整份响应作废（宁缺勿假）", () => {
    expect(kimiLiveToLimits({ usages: {} })).toBeNull();
    expect(kimiLiveToLimits(null)).toBeNull();
    expect(kimiLiveToLimits({ usages: { limit_5h: { used_ratio: -1 } } })).toBeNull();
  });

  it("p5/pw/r5/rw 与 Codex 卡片同义；窗口翻篇或读数超 30 分钟都标 stale", () => {
    const limits = kimiLiveToLimits(ISO_LIVE());
    expect(kimiQuotaValues(limits, { nowEpoch: clock + 60, updatedAt: clock })).toEqual({
      p5: 25, pw: 100, r5: clock + 1800, rw: clock + 86400, p5_stale: false, pw_stale: false,
    });
    // 读数太旧（CLI 久未刷新）
    expect(kimiQuotaValues(limits, { nowEpoch: clock + 3600, updatedAt: clock })).toMatchObject({
      p5_stale: true, pw_stale: true,
    });
    // 窗口已翻篇
    const late = kimiQuotaValues({ five_hour: { used_percent: 60, resets_at: clock + 10 } }, { nowEpoch: clock + 30 });
    expect(late).toMatchObject({ p5: 60, p5_stale: true, pw: null, pw_stale: false });
  });
});

describe("取数", () => {
  it("URL、请求头与限额照原版钉死；成功后落盘带 auth_key/source", async () => {
    const result = await fetchKimiLiveLimits(deps());
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.kimi.com/coding/v1/usages");
    expect(requests[0].headers).toEqual({
      Accept: "application/json",
      "User-Agent": "Tokei",
      Authorization: "Bearer kimi-token",
    });
    expect(requests[0].options.timeoutSeconds).toBe(3);
    expect(requests[0].options.maxBytes).toBe(KIMI_USAGE_MAX_RESPONSE_BYTES);
    expect(result).not.toBeNull();
    const [limits, plan, fetchedAt] = result!;
    expect(limits.five_hour).toEqual({ used_percent: 25, resets_at: clock + 1800 });
    expect(plan).toBe("KimiCode Pro");
    expect(fetchedAt).toBe(clock);
    const onDisk = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(onDisk).toMatchObject({ plan: "KimiCode Pro", user_id: "u-9", source: "live", fetched_at: clock });
  });

  it("5 分钟 TTL 内只请求一次；换 token 后必须重新请求", async () => {
    await fetchKimiLiveLimits(deps());
    const cached = await fetchKimiLiveLimits({ ...deps(), now: () => clock + 120 });
    expect(cached).toEqual(await fetchKimiLiveLimits({ ...deps(), now: () => clock + 120 }));
    expect(requests).toHaveLength(1);
    writeCredentials("other-token", clock + 1800);
    await fetchKimiLiveLimits({ ...deps(), now: () => clock + 120 });
    expect(requests).toHaveLength(2);
  });

  it("请求失败：记下 last_failure_at，冷却期内不再敲接口，只给旧读数", async () => {
    await fetchKimiLiveLimits(deps());
    responder = () => { throw new Error("boom"); };
    // TTL 已过（301 秒），但 reset_time 还在未来 → 允许沿用
    const fallback = await fetchKimiLiveLimits({ ...deps(), now: () => clock + 301 });
    expect(fallback?.[0].five_hour).toEqual({ used_percent: 25, resets_at: clock + 1800 });
    expect(requests).toHaveLength(2);
    const state = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(state.last_failure_at).toBe(clock + 301);
    // 冷却 300 秒内：不发第三次
    const cooled = await fetchKimiLiveLimits({ ...deps(), now: () => clock + 361 });
    expect(cooled?.[0].five_hour?.used_percent).toBe(25);
    expect(requests).toHaveLength(2);
  });

  it("没有可用旧读数就返回 null；窗口已走完的旧读数也不给（11986-12002）", async () => {
    fs.writeFileSync(cacheFile, JSON.stringify({
      auth_key: crypto.createHash("sha256").update("kimi-token", "utf8").digest("hex"),
      fetched_at: clock - 400,
      limits: { five_hour: { used_percent: 10, resets_at: clock - 10 } },
      plan: "KimiCode Pro",
    }));
    responder = () => { throw new Error("boom"); };
    expect(await fetchKimiLiveLimits({ ...deps(), now: () => clock + 1 })).toBeNull();
    // 同一份缓存，窗口还没翻篇 → 可以出场
    fs.writeFileSync(cacheFile, JSON.stringify({
      auth_key: crypto.createHash("sha256").update("kimi-token", "utf8").digest("hex"),
      fetched_at: clock - 400,
      limits: { five_hour: { used_percent: 10, resets_at: clock + 900 } },
      plan: "KimiCode Pro",
    }));
    expect(cachedKimiLiveLimits(300, kimiAuthContext(deps()).auth_key, deps(), true)?.[0].five_hour)
      .toEqual({ used_percent: 10, resets_at: clock + 900 });
  });

  it("token 过期时不发请求，改用「窗口未走完」的缓存", async () => {
    writeCredentials("kimi-token", clock - 1);
    fs.writeFileSync(cacheFile, JSON.stringify({
      auth_key: crypto.createHash("sha256").update("kimi-token", "utf8").digest("hex"),
      fetched_at: clock - 1000,
      limits: { five_hour: { used_percent: 40, resets_at: clock + 100 } },
      plan: "Old",
    }));
    const result = await fetchKimiLiveLimits(deps());
    expect(requests).toHaveLength(0);
    expect(result?.[0].five_hour).toEqual({ used_percent: 40, resets_at: clock + 100 });
    expect(result?.[1]).toBe("Old");
    expect(result?.[2]).toBe(clock - 1000);
  });

  it("响应里没有可用槽位也算失败：不污染缓存", async () => {
    responder = () => ({ usages: {} });
    expect(await fetchKimiLiveLimits(deps())).toBeNull();
    expect(requests).toHaveLength(1);
    const state = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    expect(state.limits).toBeUndefined();
    expect(state.last_failure_at).toBe(clock);
  });
});

/**
 * Codex live 额度 + 续卡单测：fixture 传输层，零网络、零真实 ~/.tokei / ~/.codex 写入。
 * 所有路径都通过 useCodexLiveFiles / TOKEI_CODEX_CONFIG 指到临时目录。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HttpError } from "../src/main/quota/http";
import { baseDeps, QuotaDeps } from "../src/main/quota/context";
import {
  CODEX_RESET_CARDS_REFRESH_INTERVAL, CODEX_USAGE_URL, CODEX_RESET_CARDS_URL,
  cachedCodexLiveLimits, cachedCodexResetCards, codexAuthContext, codexLiveSnapshotIsCurrent,
  codexLiveToLimits, codexQuotaCachePath, codexResetCardsCachePath, codexResetCardsNextAttempt,
  decodeJwtClaims, fetchCodexLiveLimits, fetchCodexResetCards, normalizeCodexResetCards,
  useCodexLiveFiles, windowFromCodexLive,
} from "../src/main/quota/codexLive";

const NOW = 1_800_000_000;
const sha = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** 拼一个假 JWT：只要求结构合法（两段 base64url） */
function jwt(payload: Record<string, any>, sig = "sig"): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.${sig}`;
}

const ACCESS = jwt({
  sub: "user-1",
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
});
const ACCOUNT_KEY = sha("acct-1");
const AUTH_KEY = sha(ACCESS);

let root: string;
let authFile: string;
let configFile: string;
let env: Record<string, string>;
let requests: Array<{ url: string; headers: Record<string, string> }>;
let responder: (url: string) => any;
let deps: QuotaDeps;

function writeAuth(access: string | null): void {
  const data = access === null
    ? {}
    : { tokens: { access_token: access, id_token: jwt({ sub: "other" }) } };
  fs.writeFileSync(authFile, JSON.stringify(data));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-codex-live-"));
  authFile = path.join(root, "auth.json");
  configFile = path.join(root, "config.toml");
  fs.writeFileSync(configFile, "# no provider switch\n");
  // 采集器的 codexConfigPath 每次调用现读 env，这里把 config.toml 也钉在临时目录
  process.env.TOKEI_CODEX_CONFIG = configFile;
  useCodexLiveFiles({
    quotaCache: path.join(root, "codex_quota_cache.json"),
    resetCardsCache: path.join(root, "codex_reset_cards_cache.json"),
    authFile,
  });
  env = {};
  requests = [];
  responder = () => { throw new Error("no fixture"); };
  deps = baseDeps({
    env: (key) => env[key],
    config: () => ({}),
    secret: () => null,
    request: async (url, options) => {
      requests.push({ url, headers: (options?.headers ?? {}) as Record<string, string> });
      return responder(url);
    },
    now: () => NOW,
  });
});

afterEach(() => {
  useCodexLiveFiles(null);
  delete process.env.TOKEI_CODEX_CONFIG;
  fs.rmSync(root, { recursive: true, force: true });
});

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---------- 纯函数 ----------

describe("windowFromCodexLive / codexLiveToLimits", () => {
  it("used_percent 字符串收、window_minutes 半偶舍入、reset_after 只在 reset_at 缺失时换算", () => {
    expect(windowFromCodexLive(
      { used_percent: "42.5", limit_window_seconds: 18000, reset_at: NOW + 3600, reset_after_seconds: 1 },
      NOW,
    )).toEqual({ used_percent: 42.5, window_minutes: 300, resets_at: NOW + 3600 });
    // Python int(round()) 是半偶舍入：0.5→0、1.5→2
    expect(windowFromCodexLive({ limit_window_seconds: 30 }, NOW)?.window_minutes).toBe(0);
    expect(windowFromCodexLive({ limit_window_seconds: 90 }, NOW)?.window_minutes).toBe(2);
    expect(windowFromCodexLive({ reset_after_seconds: 7200.9 }, NOW)).toEqual({
      resets_at: NOW + 7200,
    });
    expect(windowFromCodexLive({}, NOW)).toBeNull();
    expect(windowFromCodexLive(null, NOW)).toBeNull();
  });

  it("两缸全空时 limits 判 null，字段原样透传", () => {
    expect(codexLiveToLimits({ rate_limit: {}, plan_type: "pro" }, NOW)).toBeNull();
    const limits = codexLiveToLimits({
      rate_limit: {
        primary_window: { used_percent: 1 },
        rate_limit_reached_type: "free_user_logs_in",
      },
      credits: { has_credits: true },
      plan_type: "pro",
    }, NOW);
    expect(limits).toMatchObject({
      limit_id: "codex", limit_name: null, credits: { has_credits: true },
      plan_type: "pro", rate_limit_reached_type: "free_user_logs_in",
    });
    expect(limits!.secondary).toBeNull();
  });

  it("codexLiveSnapshotIsCurrent：live 缺时刻放行，本地解析失败放行，否则比大小", () => {
    expect(codexLiveSnapshotIsCurrent(null, "2026-01-01T00:00:00Z")).toBe(true);
    expect(codexLiveSnapshotIsCurrent(NOW, null)).toBe(true);
    expect(codexLiveSnapshotIsCurrent(NOW, "not-a-date")).toBe(true);
    expect(codexLiveSnapshotIsCurrent(NOW, "2026-09-01T00:00:00Z")).toBe(true);
    const future = new Date((NOW + 10) * 1000).toISOString();
    expect(codexLiveSnapshotIsCurrent(NOW, future)).toBe(false);
  });
});

describe("codexAuthContext", () => {
  it("坏 JWT 一律当空 claims，token 缺失直接返回 {}", () => {
    expect(decodeJwtClaims("a.b")).toEqual({});
    expect(decodeJwtClaims("!!!not-jwt!!!")).toEqual({});
    expect(codexAuthContext({})).toEqual({});
    expect(codexAuthContext({ tokens: { access_token: "" } })).toEqual({});
  });

  it("account_id 走顶层 → claims 兜底，key 是 sha256", () => {
    const context = codexAuthContext({ tokens: { access_token: ACCESS } });
    expect(context.account_id).toBe("acct-1");
    expect(context.account_key).toBe(ACCOUNT_KEY);
    expect(context.auth_key).toBe(AUTH_KEY);
    // 没有 chatgpt_account_id 时用 sub 兜底当身份
    const fallback = codexAuthContext({ tokens: { access_token: jwt({ sub: "user-9" }) } });
    expect(fallback.account_key).toBe(sha("user-9"));
    expect(fallback.account_id).toBeNull();
  });
});

// ---------- fetchCodexLiveLimits ----------

describe("fetchCodexLiveLimits", () => {
  it("环境变量 TOKEI_CODEX_LIVE_QUOTA=0 直接掐死，不读缓存不联网", async () => {
    env.TOKEI_CODEX_LIVE_QUOTA = "0";
    writeAuth(ACCESS);
    expect(await fetchCodexLiveLimits(deps)).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("切到自定义 provider：官方额度缓存被删掉且返回 null", async () => {
    fs.writeFileSync(configFile, 'model_provider = "kimi-proxy"\n');
    fs.writeFileSync(codexQuotaCachePath(), JSON.stringify({
      fetched_at: NOW - 1, limits: { limit_id: "codex", primary: { used_percent: 1 } }, plan: "plus",
    }));
    writeAuth(ACCESS);
    expect(await fetchCodexLiveLimits(deps)).toBeNull();
    expect(requests).toHaveLength(0);
    expect(fs.existsSync(codexQuotaCachePath())).toBe(false);
    // model_provider=openai 不算自定义
    fs.writeFileSync(configFile, 'model_provider = "openai"\n');
    responder = () => ({ rate_limit: { primary_window: { used_percent: 1 } } });
    expect(await fetchCodexLiveLimits(deps)).not.toBeNull();
  });

  it("5 分钟内的新鲜缓存直接命中，不读 auth 不联网", async () => {
    fs.writeFileSync(codexQuotaCachePath(), JSON.stringify({
      fetched_at: NOW - 60,
      limits: { limit_id: "codex", primary: { used_percent: 10 } },
      plan: "plus",
    }));
    const hit = await fetchCodexLiveLimits(deps);
    expect(hit).not.toBeNull();
    expect(hit![0].primary).toEqual({ used_percent: 10 });
    expect(hit![1]).toBe("plus");
    expect(hit![2]).toBe(NOW - 60);
    expect(requests).toHaveLength(0);
  });

  it("auth 缺失或没有 access_token 时返回 null，不联网", async () => {
    writeAuth(null);
    expect(await fetchCodexLiveLimits(deps)).toBeNull();
    fs.writeFileSync(authFile, JSON.stringify({ tokens: { refresh_token: "r" } }));
    expect(await fetchCodexLiveLimits(deps)).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("成功：带 Bearer 与账号头请求，写全量缓存并返回三元组；随后 TTL 内不再联网", async () => {
    writeAuth(ACCESS);
    responder = () => ({
      rate_limit: {
        primary_window: { used_percent: 42.5, limit_window_seconds: 18000, reset_at: NOW + 3600 },
        secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_after_seconds: 7200 },
      },
      credits: null,
      plan_type: "pro",
    });
    const result = await fetchCodexLiveLimits(deps);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(CODEX_USAGE_URL);
    expect(requests[0].headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(requests[0].headers["ChatGPT-Account-Id"]).toBe("acct-1");
    expect(requests[0].headers["User-Agent"]).toBe("Tokei");
    expect(result).not.toBeNull();
    expect(result![0]).toEqual({
      limit_id: "codex", limit_name: null,
      primary: { used_percent: 42.5, window_minutes: 300, resets_at: NOW + 3600 },
      secondary: { used_percent: 3, window_minutes: 10080, resets_at: NOW + 7200 },
      credits: null, plan_type: "pro", rate_limit_reached_type: null,
    });
    expect(result![1]).toBe("pro");
    expect(result![2]).toBe(NOW);
    const cache = readJson(codexQuotaCachePath());
    expect(cache).toMatchObject({
      fetched_at: NOW, plan: "pro", source: "live",
      account_key: ACCOUNT_KEY, auth_key: AUTH_KEY,
    });
    expect(cache.limits.limit_id).toBe("codex");
    // TTL 内二次调用命中缓存
    await expect(fetchCodexLiveLimits({ ...deps, now: () => NOW + 100 }))
      .resolves.toEqual(result);
    expect(requests).toHaveLength(1);
  });

  it("失败：记 last_failure_at，5 分钟内不再联网，换到超窗才重试", async () => {
    writeAuth(ACCESS);
    responder = () => { throw new Error("network down"); };
    expect(await fetchCodexLiveLimits(deps)).toBeNull();
    expect(requests).toHaveLength(1);
    const cache = readJson(codexQuotaCachePath());
    expect(cache).toMatchObject({
      last_failure_at: NOW, account_key: ACCOUNT_KEY, auth_key: AUTH_KEY,
    });
    // 退避期内重复调用不联网
    expect(await fetchCodexLiveLimits({ ...deps, now: () => NOW + 60 })).toBeNull();
    expect(await fetchCodexLiveLimits({ ...deps, now: () => NOW + 299 })).toBeNull();
    expect(requests).toHaveLength(1);
    // 满 300 秒后放行重试
    await fetchCodexLiveLimits({ ...deps, now: () => NOW + 301 });
    expect(requests).toHaveLength(2);
  });

  it("退避期内放行「窗口未过气」的旧读数（allow_active_window）", async () => {
    writeAuth(ACCESS);
    fs.writeFileSync(codexQuotaCachePath(), JSON.stringify({
      fetched_at: NOW - 400, // 已超 300s TTL，常规命中不行
      limits: { limit_id: "codex", primary: { used_percent: 90, resets_at: NOW + 1000 } },
      plan: "pro", account_key: ACCOUNT_KEY, auth_key: AUTH_KEY,
      last_failure_at: NOW - 100,
    }));
    const result = await fetchCodexLiveLimits(deps);
    expect(requests).toHaveLength(0);
    expect(result![1]).toBe("pro");
    expect(result![0].primary!.resets_at).toBe(NOW + 1000);
  });

  it("换账号或换 token 会作废失败退避，立刻重试", async () => {
    writeAuth(ACCESS);
    fs.writeFileSync(codexQuotaCachePath(), JSON.stringify({
      last_failure_at: NOW - 60, account_key: "another-account", auth_key: "x",
    }));
    responder = () => ({ rate_limit: { primary_window: { used_percent: 1 } } });
    expect(await fetchCodexLiveLimits(deps)).not.toBeNull();
    expect(requests).toHaveLength(1);

    // 同账号、auth_key 变了（Codex 自己刷新了登录态）：同样立刻重试
    fs.writeFileSync(codexQuotaCachePath(), JSON.stringify({
      last_failure_at: NOW - 60, account_key: ACCOUNT_KEY, auth_key: "old-token-key",
    }));
    expect(await fetchCodexLiveLimits({ ...deps, now: () => NOW + 1 })).not.toBeNull();
    expect(requests).toHaveLength(2);
  });

  it("cachedCodexLiveLimits：账号 key 不一致的缓存一律不吃", () => {
    fs.writeFileSync(codexQuotaCachePath(), JSON.stringify({
      fetched_at: NOW - 10, limits: { limit_id: "codex", primary: { used_percent: 1 } },
      account_key: "someone-else",
    }));
    expect(cachedCodexLiveLimits(300, { accountKey: ACCOUNT_KEY }, NOW)).toBeNull();
    expect(cachedCodexLiveLimits(300, undefined, NOW)).not.toBeNull();
  });
});

// ---------- 续卡 ----------

describe("normalizeCodexResetCards / cachedCodexResetCards", () => {
  const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

  it("只留 available、plan 未标记不支持、到期时间在未来的卡，按时间升序", () => {
    const cards = normalizeCodexResetCards({
      credits: [
        { status: "available", expires_at: iso(NOW + 7200) },
        { status: "used", expires_at: iso(NOW + 9000) },
        { status: "available", is_supported_by_plan: false, expires_at: iso(NOW + 8000) },
        // is_supported_by_plan 缺字段算支持；过去的时间丢弃
        { status: "available", is_supported_by_plan: true, expires_at: iso(NOW + 1800) },
        { status: "available", expires_at: iso(NOW - 10) },
        { status: "available", expires_at: "garbage" },
        "not-a-dict",
      ],
    }, NOW);
    expect(cards).toEqual({ count: 2, expires: [NOW + 1800, NOW + 7200], updated: NOW });
    // 非 dict 或 credits 不是列表 → 整个响应判无效
    expect(normalizeCodexResetCards({}, NOW)).toBeNull();
    expect(normalizeCodexResetCards({ credits: {} }, NOW)).toBeNull();
  });

  it("cachedCodexResetCards：没有 cards 返回空壳，有则过滤过期并透传 updated", () => {
    expect(cachedCodexResetCards({}, NOW)).toEqual({ count: 0, expires: [], updated: null });
    expect(cachedCodexResetCards({ cards: { expires: [NOW + 5, "x", NOW - 9], updated: NOW - 3 } }, NOW))
      .toEqual({ count: 1, expires: [NOW + 5], updated: NOW - 3 });
  });

  it("next_attempt 取「6 小时日常刷新」与「最早到期前 60 秒」的较小者", () => {
    expect(codexResetCardsNextAttempt({ count: 0, expires: [], updated: NOW }, NOW))
      .toBe(NOW + CODEX_RESET_CARDS_REFRESH_INTERVAL);
    expect(codexResetCardsNextAttempt({ count: 1, expires: [NOW + 7200], updated: NOW }, NOW))
      .toBe(NOW + 7260);
  });
});

describe("fetchCodexResetCards", () => {
  const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

  it("开关关掉或凭据不齐返回 {}，不联网", async () => {
    env.TOKEI_CODEX_LIVE_QUOTA = "0";
    writeAuth(ACCESS);
    expect(await fetchCodexResetCards(deps)).toEqual({});
    delete env.TOKEI_CODEX_LIVE_QUOTA;
    writeAuth(null);
    expect(await fetchCodexResetCards(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("成功：过滤后的卡片落缓存，到期前 60 秒才再联网；老 24h 缓存被 6 小时上限夹住", async () => {
    writeAuth(ACCESS);
    responder = () => ({
      credits: [
        { status: "available", expires_at: iso(NOW + 7200) },
        { status: "expired", expires_at: iso(NOW + 900) },
      ],
    });
    const cards = await fetchCodexResetCards(deps, NOW);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(CODEX_RESET_CARDS_URL);
    expect(requests[0].headers.Authorization).toBe(`Bearer ${ACCESS}`);
    expect(cards).toEqual({ count: 1, expires: [NOW + 7200], updated: NOW });
    const state = readJson(codexResetCardsCachePath());
    expect(state).toMatchObject({
      account_key: ACCOUNT_KEY, auth_key: AUTH_KEY,
      fetched_at: NOW, last_attempt_at: NOW, next_attempt_at: NOW + 7260,
    });
    // 未到下次尝试时间：吃缓存不联网
    const again = await fetchCodexResetCards(deps, NOW + 3600);
    expect(again).toEqual(cards);
    expect(requests).toHaveLength(1);
    // 越过 deadline 再拿一次
    responder = () => ({ credits: [] });
    const empty = await fetchCodexResetCards(deps, NOW + 7261);
    expect(empty).toEqual({ count: 0, expires: [], updated: NOW + 7261 });
    expect(requests).toHaveLength(2);

    // 旧版本存过 24 小时的成功缓存：升级后被 fetched_at+6h 夹住。这里成功读数已是
    // 7 小时前（>6h），夹出来的 next_attempt 已经过去 → 立刻补拿，新卡不用白等。
    fs.writeFileSync(codexResetCardsCachePath(), JSON.stringify({
      account_key: ACCOUNT_KEY, auth_key: AUTH_KEY, fetched_at: NOW - 7 * 3600,
      next_attempt_at: NOW + 61200, // 旧的 24h 成功缓存算出来的截止
      cards: { count: 1, expires: [NOW + 500000], updated: NOW - 7 * 3600 },
    }));
    await fetchCodexResetCards(deps, NOW);
    expect(requests).toHaveLength(3);
  });

  it("失败：401/403 记 auth、404/410 记 unsupported 且按 6 小时重试，其余记 request；期间吃旧卡片不联网", async () => {
    writeAuth(ACCESS);
    responder = () => { throw new HttpError(401); };
    expect(await fetchCodexResetCards(deps, NOW)).toEqual({ count: 0, expires: [], updated: null });
    let state = readJson(codexResetCardsCachePath());
    expect(state).toMatchObject({
      last_error: "auth", last_attempt_at: NOW,
      next_attempt_at: NOW + CODEX_RESET_CARDS_REFRESH_INTERVAL,
    });
    // 重试窗口内不再联网
    await fetchCodexResetCards(deps, NOW + 60);
    expect(requests).toHaveLength(1);

    // 换 token 会清掉 next_attempt 立刻重试；这次是 404
    fs.writeFileSync(codexResetCardsCachePath(), JSON.stringify({
      ...state, auth_key: "old-key", next_attempt_at: NOW + 999999,
    }));
    responder = () => { throw new HttpError(404); };
    expect(await fetchCodexResetCards(deps, NOW + 120).then(() => readJson(codexResetCardsCachePath()).last_error))
      .toBe("unsupported");
    expect(requests).toHaveLength(2);

    // 无状态码的网络错误落 request 分支；旧卡片仍从缓存返回
    fs.writeFileSync(codexResetCardsCachePath(), JSON.stringify({
      account_key: ACCOUNT_KEY, auth_key: AUTH_KEY,
      cards: { count: 2, expires: [NOW + 100000, NOW + 200000], updated: NOW - 1000 },
    }));
    responder = () => { throw new Error("socket closed"); };
    expect((await fetchCodexResetCards(deps, NOW)).count).toBe(2);
    expect(readJson(codexResetCardsCachePath()).last_error).toBe("request");
  });

  it("响应结构无效（credits 不是列表）当失败处理；credits 为空列表是成功", async () => {
    writeAuth(ACCESS);
    responder = () => ({});
    expect(await fetchCodexResetCards(deps, NOW)).toEqual({ count: 0, expires: [], updated: null });
    expect(readJson(codexResetCardsCachePath()).last_error).toBe("request");
    responder = () => ({ credits: [] });
    expect(await fetchCodexResetCards(deps, NOW + CODEX_RESET_CARDS_REFRESH_INTERVAL + 1))
      .toEqual({ count: 0, expires: [], updated: NOW + CODEX_RESET_CARDS_REFRESH_INTERVAL + 1 });
  });
});

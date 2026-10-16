/**
 * Antigravity fetcher 单测：假进程表 + 假 netstat + fixture 传输层。
 * 不发任何真实请求、不起任何真实 shell 命令，也不碰真实的 ~/.tokei。
 * 覆盖发现失败（含扫描 miss TTL）、5 分钟缓存命中、失败退旧读数、
 * 归一化窗口、ps/netstat 行解析（含 PID 查不到）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { useProviderQuotaFiles } from "../src/core/providerQuota";
import { baseDeps } from "../src/main/quota/context";
import {
  ANTIGRAVITY_NETSTAT_COMMAND, ANTIGRAVITY_PROCESS_LIST_COMMAND, AntigravityDeps,
  AntigravityProcessInfo, antigravityEndpoints, antigravityExtractFlag,
  antigravityProcessInfos, antigravityUserIdentity, fetchAntigravityQuota,
  normalizeAntigravityQuotaSummary, parseNetstatListeningPorts, scanAntigravityQuota,
} from "../src/main/quota/antigravity";

const NOW = 1_800_000_000;
const SUMMARY_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";

/** Windows 形态的 language server 行：Get-CimInstance 的输出约定就是「PID 命令行」 */
const IDE_LINE = "4321 C:\\Users\\me\\AppData\\Local\\Programs\\Antigravity\\resources"
  + "\\language_server_windows_x64.exe --app_data_dir C:\\Users\\me\\AppData\\Roaming\\Antigravity"
  + " --csrf_token csrf-ide --extension_server_port 45678 --extension_server_csrf_token csrf-ext";

const NETSTAT = [
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:40511        0.0.0.0:0              LISTENING       4321",
  "  TCP    [::1]:40511            [::]:0                 LISTENING       4321",
  "  TCP    127.0.0.1:40511        127.0.0.1:52222        ESTABLISHED     4321",
  "  TCP    127.0.0.1:55555        0.0.0.0:0              LISTENING       7777",
].join("\r\n");

const SUMMARY = {
  response: {
    groups: [
      {
        displayName: "Gemini",
        buckets: [
          // 模型变体：cadence 里没有周期标记，绝不能顶替共享窗口
          { bucketId: "gemini_model_variant", window: "model", remainingFraction: 0.9 },
          { bucketId: "gemini_week", window: "weekly", remainingFraction: 0.25, resetTime: NOW + 3600 },
          { bucketId: "gemini_session", window: "5h", remainingFraction: 0.5, resetTime: NOW + 600 },
        ],
      },
      {
        displayName: "Claude/GPT (third-party)",
        buckets: [
          // 老客户端把 oneof 包在 remaining 里；1.8 要钳到 1
          { bucketId: "3p_week", window: "week", remaining: { case: "remainingFraction", value: "1.8" } },
          { bucketId: "3p_session", window: "session", disabled: true, remainingFraction: 0.1 },
        ],
      },
      { displayName: "Unrelated", buckets: [{ bucketId: "x_weekly", remainingFraction: 0.5 }] },
    ],
  },
};

const IDENTITY = {
  userStatus: {
    userTier: { name: "  " },
    planStatus: { planInfo: { planName: " Ultra ", planDisplayName: "ignored" } },
    email: "me@example.com",
  },
};

let root: string;
let scanCacheFile: string;
let env: Record<string, string>;
let commands: string[];
let psOutput: string;
let netstatOutput: string;
let requests: Array<{ url: string; headers: Record<string, string>; options: any }>;
let responder: (url: string, attempt: number) => any;
let deps: AntigravityDeps;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-antigravity-"));
  useProviderQuotaFiles(path.join(root, "provider_quota_cache.json"), path.join(root, "config.json"));
  scanCacheFile = path.join(root, "antigravity_scan_cache.json");
  env = { TOKEI_ANTIGRAVITY_QUOTA: "1" };
  commands = [];
  psOutput = IDE_LINE;
  netstatOutput = NETSTAT;
  requests = [];
  responder = (url) => (url.endsWith(STATUS_PATH) ? IDENTITY : SUMMARY);
  deps = {
    ...baseDeps({
      env: (key) => env[key],
      config: () => ({}),
      request: async (url, options) => {
        requests.push({ url, headers: (options?.headers ?? {}) as Record<string, string>, options });
        return responder(url, requests.length);
      },
      now: () => NOW,
    }),
    runCommand: (command) => {
      commands.push(command);
      if (command === ANTIGRAVITY_NETSTAT_COMMAND) return netstatOutput;
      if (command === ANTIGRAVITY_PROCESS_LIST_COMMAND) return psOutput;
      throw new Error(`unexpected command ${command}`);
    },
    scanCacheFile,
  };
});

afterEach(() => {
  useProviderQuotaFiles(null, null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("进程行解析", () => {
  it("flag 支持 --k=v 与 --k v 两种写法，缺值不给默认", () => {
    expect(antigravityExtractFlag("x --csrf_token=abc def", "--csrf_token")).toBe("abc");
    expect(antigravityExtractFlag("x --csrf_token abc", "--csrf_token")).toBe("abc");
    expect(antigravityExtractFlag("x --csrf_token", "--csrf_token")).toBeNull();
    // --extension_server_csrf_token 里含 "csrf_token" 子串，但不能被当成 --csrf_token
    expect(antigravityExtractFlag("x --extension_server_csrf_token t", "--csrf_token")).toBeNull();
  });

  it("ide 必须带 csrf；cli 免 csrf；端口越界置空；无关进程跳过", () => {
    const infos = antigravityProcessInfos([
      `1001 C:\\apps\\Antigravity\\language_server_windows_x64.exe --app_data_dir C:\\data\\Antigravity --extension_server_csrf_token tok`,
      `2002 C:\\tools\\antigravity-cli.exe --csrf_token=tok-cli`,
      `3003 C:\\apps\\Antigravity\\language_server_windows_x64.exe --app_data_dir C:\\data\\Antigravity --csrf_token tok-ide --extension_server_port 70000 --extension_server_csrf_token tok-ext`,
      `4004 chrome.exe --app_data_dir C:\\Antigravity`,
      "not-a-process-line",
    ].join("\n"));
    expect(infos).toEqual([
      { pid: 2002, kind: "cli", csrf_token: "tok-cli", extension_port: null, extension_csrf_token: null },
      { pid: 3003, kind: "ide", csrf_token: "tok-ide", extension_port: null, extension_csrf_token: "tok-ext" },
    ]);
    // 合法端口原样保留
    expect(antigravityProcessInfos(IDE_LINE)[0]).toMatchObject({
      pid: 4321, kind: "ide", extension_port: 45678, extension_csrf_token: "csrf-ext",
    });
  });
});

describe("netstat 与端点", () => {
  it("只收本机 PID 的 TCP LISTENING 行，v4/v6 同端口去重升序", () => {
    expect(parseNetstatListeningPorts(NETSTAT, 4321)).toEqual([40511]);
    expect(parseNetstatListeningPorts(NETSTAT, 7777)).toEqual([55555]);
    expect(parseNetstatListeningPorts(NETSTAT, 8888)).toEqual([]);
  });

  it("端点顺序：扩展 http 在前（先扩展 token 后主 token），LISTEN 端口走 https", () => {
    const portsDeps: AntigravityDeps = {
      ...deps,
      runCommand: (command) => (command === ANTIGRAVITY_NETSTAT_COMMAND
        ? "  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       4321\r\n"
        : ""),
    };
    const ide: AntigravityProcessInfo =
      { pid: 4321, kind: "ide", csrf_token: "main", extension_port: 45678, extension_csrf_token: "ext" };
    expect(antigravityEndpoints(portsDeps, ide)).toEqual([
      ["http", 45678, "ext", true],
      ["http", 45678, "main", true],
      ["https", 8080, "main", true],
    ]);
    // 两个 token 相同 → 元组相等去重，只剩一条 http
    const dup: AntigravityProcessInfo = { ...ide, extension_csrf_token: "main" };
    expect(antigravityEndpoints(portsDeps, dup)).toEqual([
      ["http", 45678, "main", true],
      ["https", 8080, "main", true],
    ]);
    // cli 的 https 端点不要求 csrf；空 token 也照 Python 发出去（http 侧仍要求）
    const cli: AntigravityProcessInfo =
      { pid: 4321, kind: "cli", csrf_token: "main", extension_port: null, extension_csrf_token: null };
    expect(antigravityEndpoints(portsDeps, cli)).toEqual([["https", 8080, "main", false]]);
    const cliWithExt: AntigravityProcessInfo =
      { pid: 4321, kind: "cli", csrf_token: "", extension_port: 45678, extension_csrf_token: null };
    expect(antigravityEndpoints(portsDeps, cliWithExt)).toEqual([
      ["http", 45678, "", true],
      ["https", 8080, "", false],
    ]);
  });
});

describe("归一化", () => {
  it("四个共享窗口按官方分组出，disabled/模型变体忽略，oneof 包裹与钳位生效", () => {
    const quota = normalizeAntigravityQuotaSummary(SUMMARY, NOW);
    expect(quota).toMatchObject({
      available: true, plan: null, account: null, details: [],
      source: "antigravity-local", updated: NOW, stale: false,
    });
    expect(quota.windows).toEqual([
      { id: "antigravity-gemini-weekly", title: "Gemini 周", used_pct: 75,
        reset: NOW + 3600, window_minutes: 10080, detail: null, usage_known: true },
      { id: "antigravity-gemini-5h", title: "Gemini 5h", used_pct: 50,
        reset: NOW + 600, window_minutes: 300, detail: null, usage_known: true },
      { id: "antigravity-3p-weekly", title: "Claude/GPT 周", used_pct: 0,
        reset: null, window_minutes: 10080, detail: null, usage_known: true },
      { id: "antigravity-3p-5h", title: "Claude/GPT 5h", used_pct: null,
        reset: null, window_minutes: 300, detail: "暂时无法读取", usage_known: false },
    ]);
  });

  it("读不到的窗口保留为 unknown 行而不是硬凑模型变体；缺共享组就没有窗口", () => {
    const partial = normalizeAntigravityQuotaSummary(
      { groups: [{ displayName: "Gemini", buckets: [{ bucketId: "shared_session" }] }] }, NOW);
    expect(partial.available).toBe(true);
    expect(partial.windows).toHaveLength(4);
    expect(partial.windows[1]).toMatchObject({ id: "antigravity-gemini-5h", usage_known: false });

    const variantOnly = normalizeAntigravityQuotaSummary(
      { groups: [{ displayName: "Gemini", buckets: [{ bucketId: "gemini_flash_model", remainingFraction: 0.5 }] }] }, NOW);
    expect(variantOnly.available).toBe(false);
    expect(variantOnly.windows).toEqual([]);

    // payload 不是对象、groups 不是列表，都只会被判空，不许抛
    expect(normalizeAntigravityQuotaSummary([1, 2], NOW).windows).toEqual([]);
    expect(normalizeAntigravityQuotaSummary({ groups: "no" }, NOW).available).toBe(false);
  });

  it("身份：tier 空白就退到 planInfo，plan 去空白，email 非字符串按 null", () => {
    expect(antigravityUserIdentity(IDENTITY)).toEqual({ plan: "Ultra", account: "me@example.com" });
    expect(antigravityUserIdentity({
      userStatus: { userTier: { name: "  " }, planStatus: { planInfo: { planDisplayName: " Pro " } }, email: 42 },
    })).toEqual({ plan: "Pro", account: null });
    expect(antigravityUserIdentity("nope")).toEqual({ plan: null, account: null });
  });
});

describe("取数", () => {
  it("开关关掉时既不扫进程也不联网；环境变量缺省时默认开", async () => {
    env.TOKEI_ANTIGRAVITY_QUOTA = "0";
    expect(await scanAntigravityQuota(deps)).toEqual({});
    expect(commands).toHaveLength(0);
    expect(requests).toHaveLength(0);
    // "" 按未设置处理：antigravity 是 Python 里默认开的两路之一
    env.TOKEI_ANTIGRAVITY_QUOTA = "";
    expect((await scanAntigravityQuota(deps)).available).toBe(true);
  });

  it("扫空返回 {} 且 90 秒内不重扫；TTL 过后才再扫一次", async () => {
    psOutput = "";
    expect(await scanAntigravityQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
    expect(commands.filter((c) => c === ANTIGRAVITY_PROCESS_LIST_COMMAND)).toHaveLength(1);
    expect(fs.existsSync(scanCacheFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(scanCacheFile, "utf8"))).toEqual({ empty_at: NOW });
    expect(await scanAntigravityQuota(deps)).toEqual({});
    expect(commands).toHaveLength(1);
    expect(await scanAntigravityQuota({ ...deps, now: () => NOW + 120 })).toEqual({});
    expect(commands).toHaveLength(2);
  });

  it("命令本身失败（null）按 {} 处理且不落 miss 缓存", async () => {
    deps.runCommand = () => null;
    expect(await scanAntigravityQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
    expect(fs.existsSync(scanCacheFile)).toBe(false);
  });

  it("netstat 查不到该 PID → 没有端点 → 一次请求都不发", async () => {
    psOutput = "8888 C:\\tools\\agy.exe --profile x"; // cli、无扩展端口，只能靠 netstat
    expect(await fetchAntigravityQuota(deps)).toEqual({});
    expect(requests).toHaveLength(0);
  });

  it("命中扩展端点：先 summary 后 status，头/体/TLS 例外齐全；5 分钟内只请求一次", async () => {
    const quota = await scanAntigravityQuota(deps);
    expect(quota.available).toBe(true);
    expect(quota.plan).toBe("Ultra");
    expect(quota.account).toBe("me@example.com");
    expect(quota.source).toBe("antigravity-local");
    expect(requests.map((r) => r.url)).toEqual([
      `http://127.0.0.1:45678${SUMMARY_PATH}`,
      `http://127.0.0.1:45678${STATUS_PATH}`,
    ]);
    expect(requests[0].headers).toMatchObject({
      "Connect-Protocol-Version": "1", "X-Codeium-Csrf-Token": "csrf-ext",
    });
    expect(requests[0].options).toMatchObject({
      method: "POST", body: { forceRefresh: true }, timeoutSeconds: 2, allowInsecureLoopbackTls: true,
    });
    expect(requests[1].options.body).toEqual({
      metadata: { ideName: "antigravity", extensionName: "antigravity", ideVersion: "unknown", locale: "en" },
    });
    expect(requests[1].headers["X-Codeium-Csrf-Token"]).toBe("csrf-ext");
    // 命中后扫描缓存被删（进程确实在跑）
    expect(fs.existsSync(scanCacheFile)).toBe(false);

    const second = await scanAntigravityQuota({ ...deps, now: () => NOW + 200 });
    expect(second).toEqual(quota);
    expect(requests).toHaveLength(2);

    // 换 token 后 marker 变了，必须重新请求
    psOutput = IDE_LINE.replace("csrf-ext", "csrf-ext2").replace("csrf-ide", "csrf-ide2");
    await scanAntigravityQuota({ ...deps, now: () => NOW + 200 });
    expect(requests).toHaveLength(4);
  });

  it("第一个端点读数不可用时换端点重试", async () => {
    responder = (url, attempt) => {
      if (url.endsWith(STATUS_PATH)) return IDENTITY;
      if (attempt === 1) return { response: { groups: [] } };
      return SUMMARY;
    };
    const quota = await scanAntigravityQuota(deps);
    expect(quota.available).toBe(true);
    expect(requests).toHaveLength(3); // summary(空) → 换 token 的 summary(命中) → status
    expect(requests[1].headers["X-Codeium-Csrf-Token"]).toBe("csrf-ide");
  });

  it("身份接口失败不影响额度，plan/account 留 null", async () => {
    responder = (url) => {
      if (url.endsWith(STATUS_PATH)) throw new Error("no identity");
      return SUMMARY;
    };
    const quota = await fetchAntigravityQuota(deps);
    expect(quota.available).toBe(true);
    expect(quota.plan).toBeNull();
    expect(quota.account).toBeNull();
  });

  it("请求失败退回一小时内的旧读数并标 stale，超窗则把错误抛给上层", async () => {
    await scanAntigravityQuota(deps);
    responder = () => { throw new Error("boom"); };
    const stale = await scanAntigravityQuota({ ...deps, now: () => NOW + 900 });
    expect(stale.stale).toBe(true);
    expect(stale.source).toBe("cache");
    expect(stale.available).toBe(true);
    await expect(scanAntigravityQuota({ ...deps, now: () => NOW + 4000 })).rejects.toThrow("boom");
  });
});

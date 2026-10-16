/**
 * compute() 的联网额度落点测试：live 参数怎么并进 payload、缺省时给不给空壳。
 * 这一层是面板字段的唯一来源（macOS 侧 Swift 解码缺一个键就整份失败），
 * 所以夹具只在临时 HOME 里跑，绝不联网、绝不写真实 ~/.tokei。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const NOW = new Date("2026-10-13T12:00:00");
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

let tmpHome: string;
let previous: Record<string, string | undefined> = {};
let compute: (cache: Record<string, any>, now?: Date, live?: any) => {
  payload: Record<string, any>; errors: Record<string, string>;
};

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-compute-"));
  const env: Record<string, string> = {
    USERPROFILE: tmpHome, HOME: tmpHome,
    APPDATA: path.join(tmpHome, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(tmpHome, "AppData", "Local"),
    // 采集器的路径覆盖变量：全部指到临时目录，别让本机真实日志进来
    CODEX_HOME: path.join(tmpHome, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(tmpHome, ".claude"),
    TOKEI_QWENWORK_HOME: path.join(tmpHome, ".qwenworkcn"),
    TOKEI_QWENCODE_HOME: path.join(tmpHome, ".qwen"),
    TOKEI_KIMICODE_HOME: path.join(tmpHome, ".kimi-code"),
  };
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  vi.resetModules();
  // 账本、provider 额度缓存、价格表都要指向临时目录 / 仓库资源，模块级常量在 import 时求值
  const ledger = await import("../src/core/ledger");
  ledger.useLedgerFile(path.join(tmpHome, ".tokei", "ledger.json"), path.join(tmpHome, ".tokei", "config.json"));
  const provider = await import("../src/core/providerQuota");
  provider.useProviderQuotaFiles(path.join(tmpHome, ".tokei", "provider_quota_cache.json"), path.join(tmpHome, ".tokei", "config.json"));
  const price = await import("../src/core/price");
  price.initPricing(path.join(process.cwd(), "resources"));
  compute = (await import("../src/core/compute")).compute;
});

afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function payloadOf(live: any) {
  return compute({}, NOW, live).payload;
}

const PROVIDER_KEYS = ["antigravity", "cursor", "devin", "grok_bot", "minimax", "sub2api", "zed", "zai"];

describe("compute 的联网额度落点", () => {
  it("不传 live 时八键齐备、额度全是空壳", () => {
    const payload = payloadOf({});
    for (const key of PROVIDER_KEYS) {
      const value = key === "devin" || key === "minimax" || key === "grok_bot"
        ? payload[key].quota : payload[key];
      expect(value).toEqual({});
    }
    expect(payload.codex.reset_cards).toBeNull();
    expect(payload.codex.p5).toBeNull();
    expect(payload.grok.pct).toBeNull();
    expect(payload.grok.auth_expired).toBe(false);
    expect(payload.kimicode.p5).toBeNull();
    expect(payload.qwenwork.available).toBe(false);
  });

  it("provider 那 8 路原样进 payload，带用量的三路外面套 ranges", () => {
    const providerQuotas = Object.fromEntries(
      PROVIDER_KEYS.map((name) => [name, { source: name, available: true }]));
    const payload = payloadOf({ providerQuotas });
    expect(payload.zed).toEqual({ source: "zed", available: true });
    expect(payload.cursor).toEqual({ source: "cursor", available: true });
    expect(payload.devin).toEqual({ ranges: payload.devin.ranges, quota: { source: "devin", available: true } });
    expect(payload.minimax.quota.source).toBe("minimax");
    expect(payload.grok_bot.quota.source).toBe("grok_bot");
  });

  it("codex 的 live 三元组覆盖日志读数，plan_type 也听 live 的", () => {
    // 窗口翻篇与否看真实时钟（codexQuotaValues 用 Date.now()），重置点相对真实时刻取未来
    const realNow = Math.floor(Date.now() / 1000);
    const limits = {
      plan_type: "proplus",
      primary: { window_minutes: 300, used_percent: 42.5, resets_at: realNow + 7200 },
      secondary: { window_minutes: 10080, used_percent: 7.5, resets_at: realNow + 5 * 86400 },
    };
    const payload = payloadOf({ codexLive: [limits, "pro-plus", 1_790_000_123.9] });
    expect(payload.codex.p5).toBe(42.5);
    expect(payload.codex.pw).toBe(7.5);
    expect(payload.codex.r5).toBe(realNow + 7200);
    expect(payload.codex.rw).toBe(realNow + 5 * 86400);
    expect(payload.codex.plan).toBe("pro-plus");
    // 时刻截断成整数秒；本机没有日志那条读数时，live 一律算新的（_codex_live_snapshot_is_current）
    expect(payload.codex.q_updated).toBe(1_790_000_123);
    expect(payload.codex.p5_stale).toBe(false);
  });

  it("reset_cards：一张卡都没有当没有，有就原样带上", () => {
    expect(payloadOf({ codexResetCards: { count: 0, expires: [] } }).codex.reset_cards).toBeNull();
    const cards = { count: 2, expires: [NOW_EPOCH + 3600, NOW_EPOCH + 7200], updated: NOW_EPOCH };
    expect(payloadOf({ codexResetCards: cards }).codex.reset_cards).toEqual(cards);
  });

  it("grok：live 读数覆盖日志，auth_expired 强制成布尔", () => {
    const payload = payloadOf({
      grokQuota: { pct: 31.5, reset: NOW_EPOCH + 1800, plan: "super", products: ["grok"] },
    });
    expect(payload.grok.pct).toBe(31.5);
    expect(payload.grok.reset).toBe(NOW_EPOCH + 1800);
    expect(payload.grok.plan).toBe("super");
    expect(payload.grok.products).toEqual(["grok"]);
    expect(payload.grok.window).toBeNull();
    expect(payload.grok.auth_expired).toBe(false);
    expect(payloadOf({ grokQuota: { auth_expired: 1 } }).grok.auth_expired).toBe(true);
  });

  it("kimi：实时窗口值进 kimicode 段，缺省回落到日志", () => {
    const payload = payloadOf({
      kimi: { p5: 12, pw: 34, r5: NOW_EPOCH + 900, rw: NOW_EPOCH + 86400, q_updated: NOW_EPOCH - 5, p5_stale: false, pw_stale: true, plan: "kimi_for_all" },
    });
    expect(payload.kimicode.p5).toBe(12);
    expect(payload.kimicode.pw).toBe(34);
    expect(payload.kimicode.r5).toBe(NOW_EPOCH + 900);
    expect(payload.kimicode.q_updated).toBe(NOW_EPOCH - 5);
    expect(payload.kimicode.pw_stale).toBe(true);
    expect(payload.kimicode.plan).toBe("kimi_for_all");
  });

  it("qwenwork：live 读数优先，没给只吃缓存那一路", () => {
    const live = { available: true, remaining: 800, segments: [], shared: null };
    expect(payloadOf({ qwenwork: live }).qwenwork).toEqual(live);
    expect(payloadOf({}).qwenwork.available).toBe(false);
  });

  it("联网错误和本地扫描错误并成一份 _errors", () => {
    // compute 自己不带联网错误；主进程把 quotaErrors 并进来，这里只验 compute 那半
    const { errors } = compute({}, NOW, {});
    expect(errors).toEqual({});
  });
});

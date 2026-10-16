/**
 * 编排层单测：scan_provider_quotas / collectQuotas 的并发与错误归属。
 * 八路 fetcher 全部 mock，只验编排语义（键位齐全、开关、错误键名、cursor 打包），
 * 各路自己的归一化在 test/quota-<provider>.test.ts 里覆盖。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    zed: fn(), sub2api: fn(), zai: fn(), antigravity: fn(), devin: fn(), minimax: fn(),
    cursorSession: fn(), fetchCursor: fn(), fetchGrokBot: fn(),
    codexLive: fn(), codexResetCards: fn(), grokQuota: fn(), qwenwork: fn(), kimiLive: fn(),
  };
});

vi.mock("../src/main/quota/zed", () => ({ scanZedQuota: h.zed }));
vi.mock("../src/main/quota/sub2api", () => ({ scanSub2ApiQuota: h.sub2api }));
vi.mock("../src/main/quota/zai", () => ({ scanZaiQuota: h.zai }));
vi.mock("../src/main/quota/antigravity", () => ({ scanAntigravityQuota: h.antigravity }));
vi.mock("../src/main/quota/devin", () => ({ scanDevinQuota: h.devin }));
vi.mock("../src/main/quota/minimax", () => ({ scanMinimaxQuota: h.minimax }));
vi.mock("../src/main/quota/cursor", () => ({ cursorSession: h.cursorSession, fetchCursorQuota: h.fetchCursor }));
vi.mock("../src/main/quota/grokBot", () => ({ fetchGrokBotQuota: h.fetchGrokBot }));
vi.mock("../src/main/quota/codexLive", () => ({
  fetchCodexLiveLimits: h.codexLive, fetchCodexResetCards: h.codexResetCards,
}));
vi.mock("../src/main/quota/grokLive", () => ({ scanGrokQuota: h.grokQuota }));
vi.mock("../src/main/quota/kimiLive", () => ({ fetchKimiLiveLimits: h.kimiLive }));
vi.mock("../src/collectors/qwenwork", () => ({
  scanQwenworkQuota: h.qwenwork,
  emptyQwenworkPayload: () => ({ available: false }),
}));

const { collectQuotas, scanProviderQuotas } = await import("../src/main/quota");
const { baseDeps } = await import("../src/main/quota/context");

function deps(env: Record<string, string> = {}) {
  return baseDeps({ env: (key) => env[key], config: () => ({}), now: () => 1_800_000_000 });
}

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset();
  for (const name of ["zed", "sub2api", "zai", "antigravity", "devin", "minimax"] as const) {
    h[name].mockResolvedValue({ source: name });
  }
  h.cursorSession.mockReturnValue(null);
  h.fetchCursor.mockResolvedValue({ source: "cursor" });
  h.fetchGrokBot.mockResolvedValue({ source: "grok_bot" });
  h.codexLive.mockResolvedValue(null);
  h.codexResetCards.mockResolvedValue({});
  h.grokQuota.mockResolvedValue({});
  h.qwenwork.mockResolvedValue({ available: false });
  h.kimiLive.mockResolvedValue(null);
});

/** 八个 provider 键全开（antigravity/devin 默认开，其余用环境变量强制） */
const ALL_ON = {
  TOKEI_ZED_QUOTA: "1", TOKEI_SUB2API_QUOTA: "1", TOKEI_ZAI_QUOTA: "1",
  TOKEI_ANTIGRAVITY_QUOTA: "1", TOKEI_DEVIN_QUOTA: "1", TOKEI_MINIMAX_QUOTA: "1",
  TOKEI_CURSOR_QUOTA: "1", TOKEI_GROK_BOT_QUOTA: "1",
};

describe("scan_provider_quotas", () => {
  it("开关全关时只剩默认开的两路，且八键齐备", async () => {
    h.antigravity.mockResolvedValue({ source: "antigravity-off" });
    const errors: Record<string, string> = {};
    const out = await scanProviderQuotas(deps({
      TOKEI_ANTIGRAVITY_QUOTA: "0", TOKEI_DEVIN_QUOTA: "0",
    }), errors);
    expect(Object.keys(out).sort()).toEqual(
      ["antigravity", "cursor", "devin", "grok_bot", "minimax", "sub2api", "zed", "zai"].sort());
    for (const value of Object.values(out)) expect(value).toEqual({});
    expect(h.zed).not.toHaveBeenCalled();
    expect(h.cursorSession).not.toHaveBeenCalled();
    expect(errors).toEqual({});
  });

  it("某一路抛错只写自己的 <name>_quota，其余照常返回", async () => {
    h.zai.mockRejectedValue(new TypeError("boom"));
    const errors: Record<string, string> = {};
    const out = await scanProviderQuotas(deps(ALL_ON), errors);
    expect(out.zai).toEqual({});
    expect(out.zed).toEqual({ source: "zed" });
    expect(errors).toEqual({ zai_quota: "TypeError: boom" });
  });

  it("cursor 会话只取一次；没有会话时 cursor 让位给 grok bot 自己的原生路", async () => {
    h.cursorSession.mockReturnValue({ marker: "m", cookie: "c" });
    const out = await scanProviderQuotas(deps(ALL_ON), {});
    expect(h.cursorSession).toHaveBeenCalledTimes(1);
    expect(h.fetchCursor).toHaveBeenCalledTimes(1);
    expect(out.cursor).toEqual({ source: "cursor" });
    expect(out.grok_bot).toEqual({ source: "grok_bot" });
    // 只有 grok_bot 开着时也一样不请求 cursor 额度
    h.fetchCursor.mockClear();
    await scanProviderQuotas(deps({ TOKEI_GROK_BOT_QUOTA: "1" }), {});
    expect(h.fetchCursor).not.toHaveBeenCalled();
  });

  it("打包那一路失败记在 cursor 名下（Python 的 cursor_bundle 归属）", async () => {
    h.cursorSession.mockReturnValue({ marker: "m", cookie: "c" });
    h.fetchCursor.mockRejectedValue(new Error("403"));
    const errors: Record<string, string> = {};
    await scanProviderQuotas(deps(ALL_ON), errors);
    expect(errors).toEqual({ cursor_quota: "Error: 403" });
    expect(errors.grok_bot_quota).toBeUndefined();
  });

  it("非对象返回值一律归一成空对象", async () => {
    h.devin.mockResolvedValue(undefined as any);
    const out = await scanProviderQuotas(deps(ALL_ON), {});
    expect(out.devin).toEqual({});
  });
});

describe("collectQuotas", () => {
  it("实时那几路各自记自己的错误键，bundle 形状保持完整", async () => {
    h.codexLive.mockRejectedValue(new Error("net"));
    h.grokQuota.mockRejectedValue(new Error("auth"));
    h.qwenwork.mockRejectedValue(new Error("mcp"));
    h.kimiLive.mockRejectedValue(new Error("401"));
    h.codexResetCards.mockRejectedValue(new Error("credits"));
    const errors: Record<string, string> = {};
    const bundle = await collectQuotas(deps(), errors);
    expect(bundle.codexLive).toBeNull();
    expect(bundle.grokQuota).toEqual({});
    expect(bundle.qwenwork).toEqual({ available: false });
    expect(bundle.kimiLive).toBeNull();
    expect(bundle.codexResetCards).toEqual({});
    expect(errors).toMatchObject({
      codex: "Error: net", grok_quota: "Error: auth", qwenwork_quota: "Error: mcp",
      kimi_quota: "Error: 401", codex_reset_cards: "Error: credits",
    });
  });

  it("成功时把各路读数原样放进 bundle", async () => {
    const tuple = [{}, "pro", 1_800_000_000] as const;
    h.codexLive.mockResolvedValue(tuple);
    h.codexResetCards.mockResolvedValue({ count: 2, expires: [1, 2], updated: 3 });
    h.grokQuota.mockResolvedValue({ pct: 12, reset: 9 });
    h.qwenwork.mockResolvedValue({ available: true, remaining: 800 });
    h.kimiLive.mockResolvedValue([{}, "kimi", 7]);
    const bundle = await collectQuotas(deps(ALL_ON), {});
    expect(bundle.codexLive).toEqual(tuple);
    expect(bundle.codexResetCards).toEqual({ count: 2, expires: [1, 2], updated: 3 });
    expect(bundle.grokQuota).toEqual({ pct: 12, reset: 9 });
    expect(bundle.qwenwork).toEqual({ available: true, remaining: 800 });
    expect(bundle.kimiLive).toEqual([{}, "kimi", 7]);
    expect(bundle.providerQuotas.zed).toEqual({ source: "zed" });
  });
});

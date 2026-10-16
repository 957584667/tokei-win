/**
 * Grok Build / Grok Bot / Qwen Code / Kimi Code / DeepSeek Harness / 千问办公 的夹具测试。
 * 全部在临时 HOME 与显式 env 覆盖的临时目录里跑，绝不碰本机真实 ~/.grok / ~/.qwen 等；
 * 千问办公联网分支保持默认关闭，测试不触发任何网络请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { Bounds, rangeBounds } from "../src/core/ranges";
import { deepseekOfficialPrice } from "../src/core/price";
import { recalcCosts } from "../src/core/model";
import { useLedgerFile } from "../src/core/ledger";

let tmpHome: string;
let bounds: Bounds;
const NOW = new Date();

function iso(offsetMs = 0): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

/** 临时 HOME + 各采集器的 env 覆盖；模块级路径常量在 import 时求值，所以每次都要 resetModules */
async function useTempHome(overrides: Record<string, string> = {}) {
  process.env.USERPROFILE = tmpHome;
  process.env.HOME = tmpHome;
  process.env.APPDATA = path.join(tmpHome, "AppData", "Roaming");
  process.env.LOCALAPPDATA = path.join(tmpHome, "AppData", "Local");
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  vi.resetModules();
  bounds = rangeBounds(NOW);
}

async function importCollector<T = any>(name: string): Promise<T> {
  // @vite-ignore：动态拼接的采集器名，vitest 不需要静态解析
  return (await import(/* @vite-ignore */ `../src/collectors/${name}`)) as T;
}

/** 生产在 main/index.ts 里 initPricing(resources) 注入模型目录；resetModules 后必须对
 *  同一份 price 模块重新注入，否则 _PRICING_DB 为空，model_id 退化回原始名
 *  （Python 552 行：目录命中 norm 时 return norm，即 deepseek-v4-flash → deepseek/deepseek-v4-flash） */
async function usePricingCatalog() {
  const { initPricing } = await import("../src/core/price");
  initPricing(path.join(process.cwd(), "resources"));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function append(file: string, lines: string[]): void {
  fs.appendFileSync(file, lines.join("\n") + "\n", "utf8");
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-test-"));
  // 账本指到临时目录：扫描器接入 ledger 后也绝不写 ~/.tokei
  useLedgerFile(path.join(tmpHome, "ledger.json"), path.join(tmpHome, "config.json"));
});

afterEach(() => {
  for (const key of ["GROK_HOME", "QWEN_HOME", "QWEN_RUNTIME_DIR", "TOKEI_KIMI_DIR",
    "KIMI_CODE_HOME", "KIMI_SHARE_DIR", "TOKEI_GROK_BOT_DIR", "TOKEI_DSH_DIR",
    "TOKEI_DSH_DECOMPRESSED_DIR", "TOKEI_QWENWORK_HOME", "TOKEI_QWENWORK_QUOTA"]) {
    delete process.env[key];
  }
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch { /* Windows 偶发占用 */ }
});

// ---------------- Grok Build ----------------

describe("grok build", () => {
  function makeSessions(grokHome: string) {
    const sessionDir = path.join(grokHome, "sessions", "--tmp-project--", "s1");
    write(path.join(sessionDir, "summary.json"), JSON.stringify({
      updated_at: iso(), info: { id: "s1" }, current_model_id: "grok-4.6",
    }));
    write(path.join(sessionDir, "signals.json"), JSON.stringify({
      turnCount: 3, toolCallCount: 2, sessionDurationSeconds: 40,
      contextTokensUsed: 5000, contextWindowTokens: 256000, errorCount: 1,
      latencySampleCount: 2, avgTimeToFirstTokenMs: 300, avgResponseTimeMs: 1200,
    }));
    fs.writeFileSync(path.join(path.dirname(sessionDir), ".cwd"), tmpHome, "utf8");
    return sessionDir;
  }

  it("旧版 inference_done（无 token 字段）只降级成上下文快照，不进用量", async () => {
    const grokHome = path.join(tmpHome, ".grok");
    makeSessions(grokHome);
    write(path.join(grokHome, "logs", "unified.jsonl"), JSON.stringify({
      msg: "shell.turn.inference_done", sid: "s1", ts: iso(),
      ctx: { loop_index: 0, attempts: 1, totalTokens: 4321 },
    }) + "\n");
    await useTempHome({ GROK_HOME: grokHome });
    const { scanGrok } = await importCollector<any>("grok");

    const result = scanGrok(bounds, {});
    const today = result.ranges.today;
    expect(today.usage_available).toBe(false);
    expect(today.usage_calls).toBe(0);
    expect(today.in).toBe(0);
    expect(today.out).toBe(0);
    expect(today.cr).toBe(0);
    expect(today.reason).toBe(0);
    expect(today.models).toHaveLength(0);
    // 卡片降级展示：tokens 回落到上下文快照，且快照不进任何 token 明细
    expect(today.ctx_used).toBe(5000);
    expect(today.tokens).toBe(5000);
    // Dashboard / 回顾 / 项目 token 总量看的是 days：旧版一行都不该有
    expect(result.days).toEqual({});
  });

  it("带 token 字段的 inference_done 按 in/out/cr/reason 拆分并按自身 ts 归日", async () => {
    const grokHome = path.join(tmpHome, ".grok");
    makeSessions(grokHome);
    const lines = [
      // 旧版行混在里面，不能被计一次
      JSON.stringify({ msg: "shell.turn.inference_done", sid: "s1", ts: iso(), ctx: { loop_index: 9 } }),
      JSON.stringify({
        msg: "shell.turn.inference_done", sid: "s1", ts: iso(),
        ctx: { prompt_tokens: 1000, cached_prompt_tokens: 600, completion_tokens: 300, reasoning_tokens: 100, loop_index: 0 },
      }),
      // 同一秒同参数但 loop_index 不同 → 两次调用
      JSON.stringify({
        msg: "shell.turn.inference_done", sid: "s1", ts: iso(),
        ctx: { prompt_tokens: 1000, cached_prompt_tokens: 600, completion_tokens: 300, reasoning_tokens: 100, loop_index: 1 },
      }),
    ];
    write(path.join(grokHome, "logs", "unified.jsonl"), lines.join("\n") + "\n");
    await useTempHome({ GROK_HOME: grokHome });
    const { scanGrok } = await importCollector<any>("grok");

    const today = scanGrok(bounds, {}).ranges.today;
    expect(today.usage_available).toBe(true);
    expect(today.usage_calls).toBe(2);
    expect(today.in).toBe(800);      // (1000-600) × 2
    expect(today.cr).toBe(1200);     // 600 × 2
    expect(today.out).toBe(400);     // (300-100) × 2
    expect(today.reason).toBe(200);  // 100 × 2
    expect(today.tokens).toBe(2600); // 四项之和
    expect(today.usage_sessions).toBe(1);
    expect(today.turns).toBe(3);
    expect(today.tools).toBe(2);
    expect(today.ctx_window).toBe(256000);
    expect(today.ttft).toBe(300);
    expect(today.response).toBe(1200);
    // 目录里认得的模型按 canonical id 出行（_model_identity_id：grok-4.6 → x-ai/grok-4.6）
    expect(today.models.map((m: any) => m.model_id)).toContain("x-ai/grok-4.6");
  });

  it("额度只从本地 billing 日志解析，source=log 且带重置时刻", async () => {
    const grokHome = path.join(tmpHome, ".grok");
    makeSessions(grokHome);
    const reset = new Date(NOW.getTime() + 3 * 24 * 3600 * 1000).toISOString();
    const billing = JSON.stringify({
      msg: "billing: fetched credits config", ts: iso(),
      ctx: {
        subscriptionTier: "SuperGrok",
        config: {
          isUnifiedBillingUser: true,
          creditUsagePercent: 42.5,
          currentPeriod: { start: iso(-86400000), end: reset, type: "PERIOD_TYPE_WEEKLY" },
          productUsage: [{ product: "GrokBuild", usagePercent: 70 }],
        },
      },
    });
    write(path.join(grokHome, "logs", "unified.jsonl"), billing + "\n");
    await useTempHome({ GROK_HOME: grokHome });
    const { scanGrok, scanGrokBillingFromLog } = await importCollector<any>("grok");

    const quota = scanGrokBillingFromLog();
    expect(quota!.pct).toBe(42.5);
    expect(quota!.plan).toBe("SuperGrok");
    expect(quota!.window).toBe("week");
    expect(quota!.source).toBe("log");
    expect(quota!.stale).toBe(false);
    expect(quota!.products).toEqual([{ name: "GrokBuild", pct: 70 }]);

    const result = scanGrok(bounds, {});
    expect(result.source).toBe("log");
    expect(result.pct).toBe(42.5);
    expect(result.reset).toBeGreaterThan(Math.trunc(NOW.getTime() / 1000));
    // 实时账单接口不在本里程碑内，auth_expired 恒 false
    expect(result.auth_expired).toBe(false);
  });

  it("周期已过重置点时读数判为过期并归零", async () => {
    await useTempHome({});
    const { normalizeGrokBilling } = await importCollector<any>("grok");
    const past = new Date(NOW.getTime() - 3600 * 1000).toISOString();
    const quota = normalizeGrokBilling({
      isUnifiedBillingUser: true,
      creditUsagePercent: 80,
      currentPeriod: { start: iso(-86400000), end: past, type: "PERIOD_TYPE_MONTHLY" },
    }, { plan: "SuperGrok", source: "log", nowEpoch: Math.trunc(NOW.getTime() / 1000) });
    expect(quota.stale).toBe(true);
    expect(quota.pct).toBe(0);
    expect(quota.reset).toBeNull();
    expect(quota.window).toBe("month");
  });
});

// ---------------- Grok Bot ----------------

describe("grok bot", () => {
  it("目录不存在时返回键位齐全的空结果", async () => {
    await useTempHome({ TOKEI_GROK_BOT_DIR: path.join(tmpHome, "nope", "sand-client-persistence") });
    const { scanGrokBot } = await importCollector<any>("grok_bot");
    const result = scanGrokBot(bounds, {});
    expect(result.ranges.today).toEqual({ in: 0, out: 0, sessions: 0, calls: 0, turns: 0, tools: 0, duration: 0 });
    expect(Object.keys(result.ranges).sort()).toEqual(
      ["all", "last_week", "month", "today", "week", "year", "yesterday"].sort(),
    );
    expect(result.quota).toBeNull();
  });

  it("响应按 requestId 去重、用户消息按 entry id 去重、整份 transcript 按键去重", async () => {
    const dir = path.join(tmpHome, "GrokBot", "sand-client-persistence");
    const nowMs = NOW.getTime();
    const entries = [
      { id: "e1", kind: "message", role: "user", timestampMs: nowMs },
      { id: "e1", kind: "message", role: "user", timestampMs: nowMs + 1000 }, // 同一 entry id 重复写
      { id: "e2", kind: "send-message", requestId: "r1", timestampMs: nowMs + 2000 },
      { id: "e3", kind: "send-message", requestId: "r1", timestampMs: nowMs + 4000 }, // 流式续写，同一响应
      { id: "e4", kind: "send-message", requestId: "r2", timestampMs: nowMs + 6000, message: { type: "connector" } },
    ];
    write(path.join(dir, "transcript-1.blob"), JSON.stringify({ value: { entries } }));
    // 另一个持久化键保存同一份 transcript → 首尾 entry 边界识别后只算一次
    write(path.join(dir, "transcript-2.blob"), JSON.stringify({ value: { entries } }));
    write(path.join(dir, "roster.blob"), JSON.stringify({
      value: { rows: [{ id: "chat-1", lastMessageId: "e4" }] },
    }));
    await useTempHome({ TOKEI_GROK_BOT_DIR: dir });
    const { scanGrokBot } = await importCollector<any>("grok_bot");

    const today = scanGrokBot(bounds, {}).ranges.today;
    expect(today.turns).toBe(1);
    expect(today.calls).toBe(2);
    expect(today.tools).toBe(1);
    expect(today.sessions).toBe(1);
    expect(today.duration).toBe(6);
    // 快照没有 token 字段 → 永远未知，不凭文本长度估算
    expect(today.in).toBe(0);
    expect(today.out).toBe(0);
  });
});

// ---------------- Qwen Code ----------------

describe("qwen code", () => {
  interface Request {
    id: string; sessionId: string; model: string; timestamp: number;
    inputTokens: number; cachedTokens: number; outputTokens: number; thoughtsTokens?: number;
  }
  function request(p: Request): string {
    return JSON.stringify({ schemaVersion: 1, localDate: rangeBounds(new Date(p.timestamp)).today, ...p });
  }

  it("逐请求日志驱动会话与小时分布，字段按 input-cached 拆分", async () => {
    const qwenHome = path.join(tmpHome, ".qwen");
    const runtime = path.join(tmpHome, "qwen-runtime");
    const stamp = NOW.getTime();
    write(path.join(runtime, "usage", "token-usage-today.jsonl"), [
      request({ id: "a", sessionId: "s1", model: "qwen3.8-max", timestamp: stamp, inputTokens: 1000, cachedTokens: 600, outputTokens: 200, thoughtsTokens: 50 }),
      request({ id: "b", sessionId: "s1", model: "qwen3.8-max", timestamp: stamp, inputTokens: 500, cachedTokens: 100, outputTokens: 100 }),
    ].join("\n") + "\n");
    await useTempHome({ QWEN_HOME: qwenHome, QWEN_RUNTIME_DIR: runtime });
    const { scanQwenCode } = await importCollector<any>("qwencode");

    const result = scanQwenCode(bounds, {});
    const today = result.ranges.today;
    expect(today.in).toBe(800);          // (1000-600) + (500-100)
    expect(today.cr).toBe(700);
    expect(today.out).toBe(300);
    expect(today.reason).toBe(50);       // thoughtsTokens
    expect(today.sessions).toBe(1);
    const day = result.days[today === undefined ? "" : rangeBounds(NOW).today];
    expect(day.in).toBe(800);
    // 小时分布来自逐请求时刻
    expect(day.hours[NOW.getHours()]).toBe(800 + 700 + 300 + 50);
  });

  it("同一会话两种来源并存：保留逐请求，只补每模型未覆盖的余额，且归到汇总日不伪造小时", async () => {
    const qwenHome = path.join(tmpHome, ".qwen");
    const runtime = path.join(tmpHome, "qwen-runtime");
    const stamp = NOW.getTime();
    const yesterday = rangeBounds(NOW).yesterday;
    write(path.join(runtime, "usage", "token-usage-today.jsonl"), request({
      id: "a", sessionId: "s1", model: "qwen3.8-max", timestamp: stamp,
      inputTokens: 1000, cachedTokens: 600, outputTokens: 200,
    }) + "\n");
    // 旧版累计快照：同一会话的全程总量（大于逐请求）
    write(path.join(qwenHome, "usage_record.jsonl"), JSON.stringify({
      version: 1, sessionId: "s1", timestamp: `${yesterday}T10:00:00`,
      models: { "qwen3.8-max": { inputTokens: 3000, cachedTokens: 600, outputTokens: 700, thoughtsTokens: 0 } },
    }) + "\n");
    await useTempHome({ QWEN_HOME: qwenHome, QWEN_RUNTIME_DIR: runtime });
    const { qwenEntries, qwenSummaryFile, qwenTokenUsageFiles } = await importCollector<any>("qwencode");

    const entries = qwenEntries(qwenTokenUsageFiles(), qwenSummaryFile());
    expect(entries).toHaveLength(2);
    const summary = entries.find((e: any) => e.date === yesterday);
    expect(summary).toBeDefined();
    // 3000-600=2400 输入里减掉逐请求的 400，只剩 2000；缓存 600-400? 逐请求 cr=600 已覆盖 → 补 0
    expect(summary.in).toBe(2000);
    expect(summary.cr).toBe(0);
    expect(summary.out).toBe(500);
    // 余额归汇总日期，但没有可靠时刻 → 不伪造小时
    expect(summary.hour).toBeNull();

    const { scanQwenCode } = await importCollector<any>("qwencode");
    const result = scanQwenCode(bounds, {});
    const y = result.days[yesterday];
    expect(y.hours.every((h: number) => h === 0)).toBe(true);
    expect(result.ranges.all.in).toBe(400 + 2000);
  });

  it("缓存明细比汇总更全时不把输入再计一遍", async () => {
    const qwenHome = path.join(tmpHome, ".qwen");
    const runtime = path.join(tmpHome, "qwen-runtime");
    const stamp = NOW.getTime();
    const yesterday = rangeBounds(NOW).yesterday;
    write(path.join(runtime, "usage", "token-usage-today.jsonl"), request({
      id: "a", sessionId: "s1", model: "qwen3.8-max", timestamp: stamp,
      inputTokens: 1000, cachedTokens: 900, outputTokens: 100,
    }) + "\n");
    write(path.join(qwenHome, "usage_record.jsonl"), JSON.stringify({
      version: 1, sessionId: "s1", timestamp: `${yesterday}T09:00:00`,
      models: { "qwen3.8-max": { inputTokens: 1200, cachedTokens: 100, outputTokens: 100 } },
    }) + "\n");
    await useTempHome({ QWEN_HOME: qwenHome, QWEN_RUNTIME_DIR: runtime });
    const { qwenEntries, qwenSummaryFile, qwenTokenUsageFiles } = await importCollector<any>("qwencode");
    const summary = qwenEntries(qwenTokenUsageFiles(), qwenSummaryFile())
      .find((e: any) => e.date === yesterday);
    // 余额 = 汇总(1100 输入 + 100 缓存) - 逐请求(100 输入 + 900 缓存)：
    // 逐请求的缓存明细更全，先按 Python 原式在负数上合并（1000 + (-800) = 200），
    // 再把负余额折进 in，所以输入总量只补 200，两来源相加正好等于汇总的 1200，不重复计
    expect(summary.in).toBe(200);
    expect(summary.cr).toBe(0);
    expect(summary.cw).toBe(0);
    const inputTotal = qwenEntries(qwenTokenUsageFiles(), qwenSummaryFile())
      .reduce((sum: number, e: any) => sum + e.in + e.cr + e.cw, 0);
    expect(inputTotal).toBe(1200);
    expect(summary.out).toBe(0);
  });
});

// ---------------- DeepSeek Harness ----------------

describe("deepseek harness", () => {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

  function frames(lines: string[]): Buffer {
    return Buffer.concat(lines.map((line) => zlib.zstdCompressSync(Buffer.from(line + "\n", "utf8"))));
  }

  it("Node 的 zstdDecompressSync 只解第一帧，自实现的分帧要解全部", async () => {
    const { decompressZstdFrames, zstdFrameEnd } = await importCollector<any>("deepseek_harness");
    const joined = frames(["A", "B", "C"]);
    // 平台事实：官方 API 到第一帧就停（静默截断）
    expect(zlib.zstdDecompressSync(joined).toString("utf8")).toBe("A\n");
    expect(decompressZstdFrames(joined).toString("utf8")).toBe("A\nB\nC\n");
    let p = 0;
    const ends: number[] = [];
    while (p < joined.length) {
      const end = zstdFrameEnd(joined, p);
      expect(end).toBeGreaterThan(p);
      ends.push(end);
      p = end;
    }
    expect(ends[ends.length - 1]).toBe(joined.length);
    expect(joined.subarray(0, 4)).toEqual(MAGIC);
  });

  it("多帧 zstd 会话文件扫描出用量并按渠道分离 USD / CNY", async () => {
    const sessions = path.join(tmpHome, ".dsh", "sessions", "proj", "session-x");
    const stamp = new Date("2026-09-15T02:30:00Z").getTime(); // 北京时间周二 10:30 → 高峰
    const lines = [
      JSON.stringify({ type: "session", id: "session-x", cwd: path.join(tmpHome, "repo"), time: stamp }),
      JSON.stringify({ type: "request/header", time: stamp, data: { header: { config: { provider: "openrouter", model: "deepseek-v4-flash" } } } }),
      // 同一次调用的 chunk usage（低优先级）与最终 message（权威）
      JSON.stringify({
        type: "assistant/chunk", time: stamp,
        data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 1 } } },
      }),
      JSON.stringify({
        type: "assistant/message", time: stamp,
        data: {
          turn: 1, step: 1,
          message: { source: { provider: "openrouter", model: "deepseek-v4-flash" } },
          usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0, reasoningTokens: 40_000 },
        },
      }),
      JSON.stringify({
        type: "assistant/message", time: stamp + 1000,
        data: {
          turn: 1, step: 2,
          message: { source: { provider: "deepseek-official", model: "deepseek-v4-flash" } },
          usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      }),
    ];
    write(path.join(sessions, "session.jsonl.zstd"), "");
    fs.writeFileSync(path.join(sessions, "session.jsonl.zstd"), frames(lines));
    await useTempHome({ TOKEI_DSH_DIR: path.join(tmpHome, ".dsh", "sessions") });
    await usePricingCatalog();
    const { scanDeepSeekHarness } = await importCollector<any>("deepseek_harness");

    const result = scanDeepSeekHarness(bounds, {});
    const all = result.ranges.all;
    // chunk 被最终 message 取代：turn/step 只算一次
    expect(all.in).toBe(2_000_000);
    expect(all.cr).toBe(2_000_000);
    expect(all.out).toBe(60_000 + 100_000); // outputTokens 已含推理，拆开成 out+reason
    expect(all.reason).toBe(40_000);
    expect(all.sessions).toBe(1);

    // 官方渠道只进 cost_cny，第三方只进 cost(USD)，两者不同时非零
    // 目录（pricing.json）命中时 model_id 输出 canonical id：deepseek-v4-flash → deepseek/deepseek-v4-flash
    // （Python 552-553：norm in _PRICING_DB → return norm）
    const flash = all.models.find((m: any) => m.model_id === "deepseek/deepseek-v4-flash");
    expect(flash).toBeDefined();
    const price = deepseekOfficialPrice("deepseek-v4-flash", new Date(stamp + 1000))!;
    expect(price.cache_read).toBeGreaterThan(0);
    expect(flash.cost_cny).toBeCloseTo((1_000_000 * price.in + 100_000 * price.out) / 1e6, 6);
    expect(all.cost_cny).toBeGreaterThan(0);
    // 第三方那条按渠道价，与人民币互不换算
    expect(all.cost).toBeGreaterThan(0);
    for (const day of Object.values<any>(result.days)) {
      expect(day.cost_cny).toBeGreaterThan(0);
      expect(day.cost).toBeGreaterThan(0);
    }
    // recalcCosts 对 deepseek_harness 保留权威金额，不用聚合 token 重算；
    // Python 尾部统一 r["cost"] = round(total_cost, 6)（_recalc_costs），所以断言精度取 1e-6
    const before = all.cost;
    const payload: Record<string, any> = { deepseek_harness: { ranges: result.ranges } };
    recalcCosts(payload);
    expect(payload.deepseek_harness.ranges.all.cost).toBeCloseTo(before, 6);
  });
});

// ---------------- Kimi Code ----------------

describe("kimi code", () => {
  function kimi15Session(root: string, sessionDir: string, agents: Record<string, string[]>) {
    const session = path.join(root, "sessions", "wdhash", sessionDir);
    write(path.join(session, "state.json"), JSON.stringify({ id: "sess-1", cwd: path.join(tmpHome, "repo") }));
    for (const [agent, lines] of Object.entries(agents)) {
      write(path.join(session, "agents", agent, "wire.jsonl"), lines.join("\n") + "\n");
    }
    return session;
  }

  it("protocol 1.5 按 usage.record 四字段计，模型取记录自带", async () => {
    const root = path.join(tmpHome, ".kimi-code");
    const stamp = Math.trunc(NOW.getTime() / 1000);
    kimi15Session(root, "s1", {
      main: [
        JSON.stringify({ type: "usage.record", time: stamp, model: "kimi-for-coding", usage: { inputOther: 1000, output: 200, inputCacheRead: 5000, inputCacheCreation: 300 } }),
        JSON.stringify({ type: "usage.record", time: stamp, model: "kimi-for-coding", usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } }),
      ],
      subagent: [
        JSON.stringify({ type: "usage.record", time: stamp, model: "kimi-for-coding", usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 } }),
      ],
    });
    await useTempHome({ TOKEI_KIMI_DIR: root });
    const { scanKimiCode } = await importCollector<any>("kimicode");
    const result = scanKimiCode(bounds, {});
    const today = result.ranges.today;
    expect(today.in).toBe(1010);
    expect(today.out).toBe(205);
    expect(today.cr).toBe(5000);
    expect(today.cw).toBe(300);
    // 多个 agent 用 state.json.id 归并成一个会话
    expect(today.sessions).toBe(1);
    expect(result.days[rangeBounds(NOW).today].projects).toEqual([path.join(tmpHome, "repo")]);

    // 没有权威账单就绝不推断 USD：recalcCosts 之后仍是 0
    const payload: Record<string, any> = { kimicode: { ranges: result.ranges } };
    recalcCosts(payload);
    expect(payload.kimicode.ranges.today.cost).toBe(0);
    expect(today.models.every((m: any) => m.cost === 0)).toBe(true);
    // 额度是网络调用，本里程碑保持 null
    expect([result.p5, result.pw, result.r5, result.rw, result.plan, result.q_updated]).toEqual([null, null, null, null, null, null]);
  });

  it("protocol 1 展开主 wire 里的 SubagentEvent，并按 message_id 去重", async () => {
    const root = path.join(tmpHome, ".kimi");
    const stamp = Math.trunc(NOW.getTime() / 1000);
    const session = path.join(root, "sessions", "wdhash", "legacy-s");
    const statusUpdate = (messageId: string, usage: Record<string, number>) => JSON.stringify({
      timestamp: stamp,
      message: { type: "StatusUpdate", payload: { message_id: messageId, token_usage: usage } },
    });
    const subagentEvent = (messageId: string, usage: Record<string, number>) => JSON.stringify({
      timestamp: stamp,
      message: {
        type: "SubagentEvent",
        payload: { agent_id: "worker", event: { type: "StatusUpdate", payload: { message_id: messageId, token_usage: usage } } },
      },
    });
    write(path.join(session, "wire.jsonl"), [
      statusUpdate("m1", { input_other: 500, output: 50, input_cache_read: 900, input_cache_creation: 0 }),
      statusUpdate("m1", { input_other: 500, output: 50, input_cache_read: 900, input_cache_creation: 0 }),
      subagentEvent("m2", { input_other: 100, output: 20, input_cache_read: 0, input_cache_creation: 40 }),
    ].join("\n") + "\n");
    // 旧版 session/subagents 目录即使存在也不该被单独扫（否则与 SubagentEvent 重复）
    write(path.join(session, "subagents", "worker", "wire.jsonl"),
      statusUpdate("m2", { input_other: 100, output: 20, input_cache_read: 0, input_cache_creation: 40 }) + "\n");
    await useTempHome({ TOKEI_KIMI_DIR: root });
    const { scanKimiCode } = await importCollector<any>("kimicode");
    const today = scanKimiCode(bounds, {}).ranges.today;
    expect(today.in).toBe(600);
    expect(today.out).toBe(70);
    expect(today.cr).toBe(900);
    expect(today.cw).toBe(40);
    expect(today.cost).toBe(0);
    expect(today.models.every((m: any) => m.model_id === null)).toBe(true);
  });

  it("根 wire 与 agent wire 并存时按记录键多重集抵扣镜像", async () => {
    const root = path.join(tmpHome, ".kimi-code");
    const stamp = Math.trunc(NOW.getTime() / 1000);
    const rec = (inp: number, out: number) => JSON.stringify({
      type: "usage.record", time: stamp, model: "kimi-for-coding",
      usage: { inputOther: inp, output: out, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    // 会话 1：根 wire 完全是 agent wire 的镜像 → 抵扣后只剩 agent 那一份
    kimi15Session(root, "s1", { main: [rec(700, 100), rec(300, 50)] });
    const mirror = path.join(root, "sessions", "wdhash", "s1");
    write(path.join(mirror, "wire.jsonl"), [rec(700, 100), rec(300, 50)].join("\n") + "\n");
    // 会话 2：根 wire 除镜像外还有一条独有记录 → 多条那份必须保留
    kimi15Session(root, "s2", { main: [rec(700, 100)] });
    const extra = path.join(root, "sessions", "wdhash", "s2");
    write(path.join(extra, "wire.jsonl"), [rec(700, 100), rec(120, 30)].join("\n") + "\n");
    await useTempHome({ TOKEI_KIMI_DIR: root });
    const { scanKimiCode } = await importCollector<any>("kimicode");
    const today = scanKimiCode(bounds, {}).ranges.today;
    expect(today.in).toBe(700 + 300 + 700 + 120);
    expect(today.out).toBe(100 + 50 + 100 + 30);
  });

  it("凭据只读 access_token 且报告过期，不触碰 refresh_token", async () => {
    const root = path.join(tmpHome, ".kimi-code");
    const expires = Math.trunc(NOW.getTime() / 1000) - 60;
    write(path.join(root, "credentials", "kimi-code.json"), JSON.stringify({
      access_token: "ki-token", refresh_token: "ki-refresh", expires_at: expires * 1000,
    }));
    await useTempHome({ TOKEI_KIMI_DIR: root });
    const { kimiCredentialFiles, kimiCredentialState } = await importCollector<any>("kimicode");
    expect(kimiCredentialFiles()).toEqual([path.join(root, "credentials", "kimi-code.json")]);
    const state = kimiCredentialState(Math.trunc(NOW.getTime() / 1000));
    expect(state!.expired).toBe(true);
    expect(state!.hasAccessToken).toBe(true);
    expect(JSON.stringify(state)).not.toContain("ki-refresh");
  });
});

// ---------------- 千问办公 ----------------

describe("qwenwork", () => {
  it("URL 只允许 http://127.0.0.1:<port>，其余一律拒绝", async () => {
    await useTempHome({});
    const { resolveQwenworkLoopbackUrl } = await importCollector<any>("qwenwork");
    expect(resolveQwenworkLoopbackUrl("http://127.0.0.1:53124")).toBe("http://127.0.0.1:53124");
    expect(resolveQwenworkLoopbackUrl("http://127.0.0.1:53124/")).toBe("http://127.0.0.1:53124");
    for (const bad of [
      "http://localhost:53124", "http://0.0.0.0:53124", "https://127.0.0.1:53124",
      "http://127.0.0.1:53124/query", "http://127.0.0.1:53124/?token=x", "http://127.0.0.1:53124/#f",
      "http://user:pass@127.0.0.1:53124", "http://127.0.0.1:0", "http://127.0.0.1:70000",
      "http://api.qwen.com", "127.0.0.1:53124", "", null, undefined, 1234,
    ]) {
      expect(resolveQwenworkLoopbackUrl(bad), String(bad)).toBeNull();
    }
  });

  it("配置非环回或被占用的地址时不产出可用配置，也不会发请求", async () => {
    const home = path.join(tmpHome, ".qwenworkcn");
    write(path.join(home, "mcp-adaptor.config"), JSON.stringify({
      url: "http://example.com:80", token: "f".repeat(64),
    }));
    await useTempHome({ TOKEI_QWENWORK_HOME: home });
    const { readQwenworkMcpConfig, scanQwenwork, qwenworkQuotaEnabled } = await importCollector<any>("qwenwork");
    expect(qwenworkQuotaEnabled()).toBe(false);
    expect(readQwenworkMcpConfig()).toBeNull();
    // 键位与 Swift QwenWorkQuota 权威键一致（含 remaining/remaining_pct/exceeded/is_team/
    // expires_at/plan_expiration/shared），关闭时全部为空值
    expect(scanQwenwork()).toEqual({
      available: false, remaining: null, remaining_pct: null, exceeded: false, is_team: false,
      expires_at: null, plan_expiration: null,
      segments: [], plan_credits: null, add_on_credits: null, shared: null, shared_add_on_credits: null,
      aggregate_remaining_percent: null, source: null, updated: null, stale: null,
    });
  });

  it("segments 为 canonical：别名不双计，共享包单独展示", async () => {
    await useTempHome({});
    const { normalizeQwenworkUsage } = await importCollector<any>("qwenwork");
    const quota = normalizeQwenworkUsage({
      available: true,
      segments: [
        { id: "plan", kind: "plan_credits", total: 1000, used: 400, remaining: 600, unit: "credits", percentageUsed: 40 },
        { id: "addon", kind: "add_on_credits", total: 500, used: 0, remaining: 500, unit: "credits", percentageUsed: 0 },
      ],
      // 与 segments 完全同值的别名，绝不能再加一遍
      planCredits: { total: 1000, used: 400, remaining: 600 },
      addOnCredits: { total: 500, used: 0, remaining: 500 },
      sharedResourcePackage: { total: 9000, used: 1000, remaining: 8000, unit: "credits" },
      aggregateRemainingPercent: 73.5,
    }, { updated: 1700000000 });
    expect(quota.segments).toHaveLength(2);
    expect(quota.segments.map((s: any) => s.remaining)).toEqual([600, 500]);
    expect(quota.aggregate_remaining_percent).toBe(73.5);
    expect(quota.plan_credits.remaining).toBe(600);
    expect(quota.add_on_credits.remaining).toBe(500);
    expect(quota.shared_add_on_credits.remaining).toBe(8000);
    expect(quota.available).toBe(true);
    expect(quota.source).toBe("mcp");
  });

  it("只有别名时才生成 segment，total=0/remaining>0 视为总额未知", async () => {
    await useTempHome({});
    const { normalizeQwenworkUsage, normalizeQwenworkSegment } = await importCollector<any>("qwenwork");
    const quota = normalizeQwenworkUsage({
      available: true,
      planCredits: { total: 0, used: 0, remaining: 2100, unit: "credits", percentageUsed: 0 },
      sharedAddOnCredits: { cap: "1000", remaining: "250" },
    });
    expect(quota.segments).toHaveLength(1);
    expect(quota.segments[0].id).toBe("plan");
    // total=0 → 分母未知：保留绝对余额，但不把 percentageUsed=0 当成假的 0% 剩余条
    expect(quota.segments[0].remaining).toBe(2100);
    expect(quota.segments[0].percentage_used).toBeNull();
    // 共享包只作 fallback，仍然独立展示
    expect(quota.shared_add_on_credits!.total).toBe(1000);
    expect(quota.aggregate_remaining_percent).toBeNull();

    const empty = normalizeQwenworkSegment({ id: "x", kind: "other" }, 0);
    expect(empty).toBeNull(); // 全空字段的 segment 不进明细
  });

  it("MCP 信封拆解：structuredContent 与 text JSON 都支持，key 不符或 ok=false 不采信", async () => {
    await useTempHome({});
    const { qwenworkMcpData } = await importCollector<any>("qwenwork");
    const inner = { ok: true, key: "qwenwork.usage", data: { available: true, segments: [] } };
    expect(qwenworkMcpData({ result: { structuredContent: inner } })).toEqual(inner.data);
    expect(qwenworkMcpData({ result: { content: [{ type: "text", text: JSON.stringify(inner) }] } })).toEqual(inner.data);
    expect(qwenworkMcpData({ result: { structuredContent: { ...inner, key: "qwenwork.other" } } })).toBeNull();
    expect(qwenworkMcpData({ result: { structuredContent: { ...inner, ok: false } } })).toBeNull();
    expect(qwenworkMcpData({ error: { code: -1 } })).toBeNull();
  });

  it("默认关闭：未开启配置时同步入口直接返回空，不发网络", async () => {
    const home = path.join(tmpHome, ".qwenworkcn");
    write(path.join(home, "mcp-adaptor.config"), JSON.stringify({
      url: "http://127.0.0.1:53124", token: "a".repeat(64),
    }));
    await useTempHome({ TOKEI_QWENWORK_HOME: home, TOKEI_QWENWORK_QUOTA: "0" });
    const { readQwenworkMcpConfig, scanQwenwork, qwenworkQuotaEnabled } = await importCollector<any>("qwenwork");
    expect(qwenworkQuotaEnabled()).toBe(false);
    // 即便配置合法也不读它 —— 开关优先
    expect(readQwenworkMcpConfig()).not.toBeNull();
    expect(scanQwenwork().available).toBe(false);
  });
});

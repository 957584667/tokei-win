/**
 * Codex 采集器单测：临时目录 + TOKEI_* env 注入。
 * 采集器每次调用现算路径，且 TOKEI_CODEX_* 一旦设置就只搜这些根，所以 env 只要在
 * scanCodex 之前设好即可；loadCodex 仍 resetModules，避免跨用例的模块级缓存。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rangeBounds } from "../src/core/ranges";
import { useLedgerFile } from "../src/core/ledger";

type CodexModule = typeof import("../src/collectors/codex");

// 固定的「现在」：2025-05-14（周三）
const NOW = new Date(2025, 4, 14, 18, 0, 0);
const ENV_KEYS = ["TOKEI_CODEX_DIR", "TOKEI_CODEX_ARCHIVED_DIR", "TOKEI_CODEX_CONFIG"];
const savedEnv: Record<string, string | undefined> = {};

let tmp: string;
let sessions: string;

async function loadCodex(): Promise<CodexModule> {
  vi.resetModules();
  // resetModules 换了一册模块表，账本的单例状态也跟着换：必须在新表里再指一次临时
  // 账本，否则扫描器读到的是真实的 ~/.tokei/ledger.json（本机历史会混进断言）
  const ledger = await import("../src/core/ledger");
  ledger.useLedgerFile(path.join(tmp, "ledger.json"), path.join(tmp, "config.json"));
  return await import("../src/collectors/codex");
}

function runScan(mod: CodexModule) {
  return mod.scanCodex(rangeBounds(NOW), {});
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-codex-"));
  // 账本指到临时目录：扫描器接入 ledger 后也绝不写 ~/.tokei
  useLedgerFile(path.join(tmp, "ledger.json"), path.join(tmp, "config.json"));
  sessions = path.join(tmp, "sessions", "2025-05-14");
  fs.mkdirSync(sessions, { recursive: true });
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.TOKEI_CODEX_DIR = path.join(tmp, "sessions");
  process.env.TOKEI_CODEX_ARCHIVED_DIR = path.join(tmp, "archived_sessions");
  process.env.TOKEI_CODEX_CONFIG = path.join(tmp, "config.toml"); // 不存在 = 非 custom
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 句柄未释放时忽略 */ }
});

const pad = (n: number) => String(n).padStart(2, "0");const ts = (h: number, m = 0, s = 0) => `2025-05-14T${pad(h)}:${pad(m)}:${pad(s)}`;

/** 用量四元组一律按 [input, cached, output, reasoning] 写，映射到日志字段 */
function usage([input, cached, output, reasoning]: number[]) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
  };
}

function sessionMeta(id: string, extra: Record<string, unknown> = {}) {
  return { timestamp: ts(9), type: "session_meta", payload: { id, ...extra } };
}

function turnContext(model: string, h: number, m = 0) {
  return { timestamp: ts(h, m), type: "turn_context", payload: { model } };
}

function tokenCount(total: number[], last: number[], h: number, m = 0, rateLimits?: Record<string, unknown>) {
  return {
    timestamp: ts(h, m),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: usage(total), last_token_usage: usage(last) },
      ...(rateLimits ? { rate_limits: rateLimits } : {}),
    },
  };
}

function usageRecord(responseId: string, threadId: string, u: number[], threadTotal: number[], h: number, m = 0) {
  return {
    timestamp: ts(h, m),
    type: "token_usage_record",
    payload: {
      response_id: responseId,
      thread_id: threadId,
      usage: usage(u),
      thread_token_usage: usage(threadTotal),
    },
  };
}

function writeRollout(name: string, rows: Array<Record<string, unknown>>, dir = sessions) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

const future = () => Math.floor(Date.now() / 1000) + 3600;

describe("codex：新格式 token_usage_record 与 response_id 去重", () => {
  it("同 response_id 只计一次；字段映射 in=input-cached、reason 单列", async () => {
    const mod = await loadCodex();
    writeRollout("dup", [
      sessionMeta("S1"),
      usageRecord("resp-1", "S1", [1000, 400, 300, 100], [1000, 400, 300, 100], 10),
      // 同一 response_id 的重复落盘（不同快照也不能再计一次）
      usageRecord("resp-1", "S1", [9000, 8000, 5000, 900], [9000, 8000, 5000, 900], 10, 30),
    ]);
    const r = runScan(mod);
    expect(r.ranges.month.in).toBe(600);
    expect(r.ranges.month.cached).toBe(400);
    expect(r.ranges.month.out).toBe(300);
    expect(r.ranges.month.reason).toBe(100);
    expect(r.ranges.month.sessions).toBe(1);
    // hit = cached / input(含缓存) ×100
    expect(r.ranges.month.hit).toBeCloseTo(40, 6);
    // 逐时明细：in(含缓存)+out 进 hours 槽
    expect(r.hours[10]).toBe(1300);
    expect(r.hours[11]).toBe(0);
    expect(r.reset_cards).toBeNull();
  });

  it("双写日志：旧式 token_count 先计入，随后同快照的 token_usage_record 抵扣不重复计", async () => {
    const mod = await loadCodex();
    writeRollout("dual", [
      sessionMeta("S1"),
      tokenCount([1000, 400, 300, 100], [1000, 400, 300, 100], 10),
      usageRecord("resp-9", "S1", [1000, 400, 300, 100], [1000, 400, 300, 100], 10, 5),
    ]);
    const r = runScan(mod);
    expect(r.ranges.month.in).toBe(600);
    expect(r.ranges.month.cached).toBe(400);
    expect(r.ranges.month.out).toBe(300);
  });

  it("thread_id 与本会话 id 不一致的响应是分叉复制来的，直接丢弃", async () => {
    const mod = await loadCodex();
    writeRollout("stray", [
      sessionMeta("S1"),
      usageRecord("resp-1", "OTHER-THREAD", [1000, 400, 300, 100], [1000, 400, 300, 100], 10),
      usageRecord("resp-2", "S1", [500, 100, 200, 50], [500, 100, 200, 50], 11),
    ]);
    const r = runScan(mod);
    expect(r.ranges.month.in).toBe(400);
    expect(r.ranges.month.cached).toBe(100);
    expect(r.ranges.month.out).toBe(200);
  });
});

describe("codex：fork/子代理回放前缀去重", () => {
  it("子会话开头回放父会话的前缀事件时只计新增", async () => {
    const mod = await loadCodex();
    writeRollout("parent", [
      sessionMeta("P"),
      tokenCount([100, 40, 30, 10], [100, 40, 30, 10], 9, 5),
      tokenCount([300, 120, 90, 30], [200, 80, 60, 20], 9, 10),
    ]);
    writeRollout("child", [
      { timestamp: ts(10), type: "session_meta", payload: { id: "C", forked_from_id: "P" } },
      // 前两条与父会话逐键相同（Codex fork 把历史整段重放），第三条才是新工作
      tokenCount([100, 40, 30, 10], [100, 40, 30, 10], 10, 0),
      tokenCount([300, 120, 90, 30], [200, 80, 60, 20], 10, 1),
      tokenCount([350, 130, 110, 35], [50, 10, 20, 5], 11, 0),
    ]);
    const r = runScan(mod);
    // 期望 = 父 2 条 + 子 1 条，回放的两条不再计
    expect(r.ranges.month.in).toBe(220);
    expect(r.ranges.month.cached).toBe(130);
    expect(r.ranges.month.out).toBe(110);
    expect(r.ranges.month.reason).toBe(35);
    expect(r.ranges.month.sessions).toBe(2);
    expect(r.hours[11]).toBe(70); // 只有第三条 (50+20)，回放的两条不进逐时槽
    expect(r.hours[10]).toBe(0);
  });

  it("缺父元数据时只认 ≥2 事件的长前缀；恰好相等但只有 1 条快照的独立会话不许删", async () => {
    const mod = await loadCodex();
    // a：单条事件、b：同样快照的单条事件（两个独立会话偶然同值）
    writeRollout("solo-a", [
      { timestamp: ts(9), type: "session_meta", payload: { id: "A" } },
      tokenCount([100, 40, 30, 10], [100, 40, 30, 10], 9),
    ]);
    writeRollout("solo-b", [
      { timestamp: ts(12), type: "session_meta", payload: { id: "B" } },
      tokenCount([100, 40, 30, 10], [100, 40, 30, 10], 12),
    ]);
    const r = runScan(mod);
    expect(r.ranges.month.in).toBe(120);
    expect(r.ranges.month.cached).toBe(80);
  });
});

describe("codex：rate_limits 按 window_minutes 认窗口", () => {
  it("primary=300 分钟 / secondary=10080 分钟 → p5 与 pw 各归各", async () => {
    const mod = await loadCodex();
    const reset5 = future();
    const resetW = future() + 86400;
    writeRollout("limits", [
      sessionMeta("S1"),
      tokenCount([100, 40, 30, 10], [100, 40, 30, 10], 10, 0, {
        limit_id: "codex",
        limit_name: "codex",
        plan_type: "plus",
        primary: { used_percent: 42.0, window_minutes: 300, resets_at: reset5 },
        secondary: { used_percent: 15.0, window_minutes: 10080, resets_at: resetW },
      }),
    ]);
    const r = runScan(mod);
    expect(r.p5).toBe(42.0);
    expect(r.pw).toBe(15.0);
    expect(r.r5).toBe(reset5);
    expect(r.rw).toBe(resetW);
    expect(r.plan).toBe("plus");
    expect(r.p5_stale).toBe(false);
    expect(r.pw_stale).toBe(false);
  });

  it("新形状只有 primary=周时，pw 由 primary 承担、p5 为 null", async () => {
    const mod = await loadCodex();
    const resetW = future() + 86400;
    writeRollout("weekonly", [
      sessionMeta("S1"),
      tokenCount([100, 40, 30, 10], [100, 40, 30, 10], 10, 0, {
        limit_id: "codex",
        plan_type: "pro",
        primary: { used_percent: 7.5, window_minutes: 10080, resets_at: resetW },
      }),
    ]);
    const r = runScan(mod);
    expect(r.pw).toBe(7.5);
    expect(r.p5).toBeNull();
    expect(r.rw).toBe(resetW);
    expect(r.plan).toBe("pro");
  });

  it("config.toml 顶层 model_provider ≠ openai 时官方额度整段作废", async () => {
    process.env.TOKEI_CODEX_CONFIG = path.join(tmp, "config.toml");
    fs.writeFileSync(process.env.TOKEI_CODEX_CONFIG, 'model_provider = "custom"\n\n[model_providers.custom]\nname = "custom"\n', "utf8");
    const mod = await loadCodex();
    writeRollout("custom", [
      sessionMeta("S1"),
      tokenCount([100, 40, 30, 10], [100, 40, 30, 10], 10, 0, {
        limit_id: "codex",
        plan_type: "plus",
        primary: { used_percent: 42.0, window_minutes: 300, resets_at: future() },
        secondary: { used_percent: 15.0, window_minutes: 10080, resets_at: future() },
      }),
    ]);
    const r = runScan(mod);
    expect(r.p5).toBeNull();
    expect(r.pw).toBeNull();
    expect(r.plan).toBeNull();
    // 用量本身照常统计，只是额度读数不作数
    expect(r.ranges.month.in).toBe(60);
  });
});

describe("codex：Luna Reserve 分离", () => {
  it("事件级 rate_limits 判 reserve：用量进 reserve_ranges，主口径排除", async () => {
    const mod = await loadCodex();
    writeRollout("reserve", [
      sessionMeta("S1"),
      turnContext("gpt-5.5", 9, 55),
      tokenCount([100, 40, 30, 10], [100, 40, 30, 10], 10),
      // 同一文件内主额度见底后切 Reserve：模型字段没变，靠事件级 rate_limits 认
      tokenCount([300, 120, 90, 30], [200, 80, 60, 20], 11, 0, {
        limit_id: "base_model_inference",
        limit_name: "gpt-reserve",
        plan_type: "plus",
        primary: { used_percent: 50.0, window_minutes: 300, resets_at: future() },
      }),
    ]);
    const r = runScan(mod);
    expect(r.ranges.month.in).toBe(60);
    expect(r.ranges.month.cached).toBe(40);
    expect(r.ranges.month.out).toBe(30);
    expect(r.reserve_ranges.month.in).toBe(120);
    expect(r.reserve_ranges.month.cached).toBe(80);
    expect(r.reserve_ranges.month.out).toBe(60);
    expect(r.reserve_ranges.month.reason).toBe(20);
    // 展示名与定价：Reserve 按 Luna 价，卡片名 "Luna Reserve"
    const names = r.reserve_ranges.month.models.map((m) => m.name);
    expect(names).toContain("Luna Reserve");
    expect(r.reserve_quota).not.toBeNull();
    expect(r.reserve_quota!.used_percent).toBe(50.0);
    // reserve 的逐时曲线独立
    expect(r.hours[10]).toBe(130);
    expect(r.reserve_hours[11]).toBe(260);
    expect(r.ranges.month.sessions).toBe(1);
  });
});

describe("codex：定价口径与 Python 对齐", () => {
  it("输入 >272K 走高上下文加价（输入与缓存读 ×2、输出 ×1.5），阈值本身不加价", async () => {
    const mod = await loadCodex();
    // gpt-5.5: in=5 / out=30 / cache_read=0.5（每百万）
    // 加价：(300000-100000)/1M*10 + 100000/1M*1 + 50000/1M*45 = 2.0 + 0.1 + 2.25 = 4.35
    expect(mod.codexEstimatedCost("gpt-5.5", 300_000, 100_000, 50_000)).toBeCloseTo(4.35, 9);
    // 恰好 272000 不算高上下文：0.172*5 + 0.1*0.5 + 0.05*30 = 2.41
    expect(mod.codexEstimatedCost("gpt-5.5", 272_000, 100_000, 50_000)).toBeCloseTo(2.41, 9);
    // Reserve 走 Luna 定价（0.2/1.2/0.02），同样吃加价：0.2*0.4 + 0.1*0.04 + 0.05*1.8 = 0.174
    const luna = mod.codexEstimatedCost("gpt-reserve", 300_000, 100_000, 50_000);
    expect(luna).toBeCloseTo((200_000 / 1e6) * 0.4 + (100_000 / 1e6) * 0.04 + (50_000 / 1e6) * 1.8, 9);
    // 未知模型按 gpt-5.5 保守兜底，1M 输入同样翻倍
    expect(mod.codexEstimatedCost("no-such-model", 1_000_000, 0, 0)).toBeCloseTo(10, 9);
  });

  it("持久账本已接：日志被清的天用 ~/.tokei/ledger.json 回补", async () => {
    const mod = await loadCodex();
    // 与 loadCodex 同一册模块表，才写得到本用例的临时账本
    const ledger = await import("../src/core/ledger");
    // 第一轮：会话还在，逐来源入账
    const day = { ...mod.codexDay(), in: 1000, cached: 100, out: 200, reason: 50, cost: 1.5 };
    ledger.ledgerReconcile("codex", { "2025-05-14": day as any }, { "session-1": { "2025-05-14": day as any } });
    // 第二轮：日志整体消失（live 为空），账本快照必须把这一天兜回来
    const merged = mod.codexLedgerReconcile("codex", {}, {});
    expect(merged["2025-05-14"].in).toBe(1000);
    expect(merged["2025-05-14"].out).toBe(200);
    expect(merged["2025-05-14"].cost).toBeCloseTo(1.5, 9);
  });
});

/**
 * Grok Build / Grok Bot 采集器单测：临时目录 + GROK_HOME / TOKEI_GROK_BOT_DIR 注入。
 * grok.ts 的路径常量在模块加载时求值，所以每个用例先 vi.resetModules() 再动态 import。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Bounds, rangeBounds } from "../src/core/ranges";
import { useLedgerFile } from "../src/core/ledger";

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["GROK_HOME", "TOKEI_GROK_BOT_DIR"];

// 固定的「现在」：2025-05-14（周三）
const NOW = new Date(2025, 4, 14, 18, 0, 0);
let bounds: Bounds;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-grok-"));
  // 账本指到临时目录：扫描器接入 ledger 后也绝不写 ~/.tokei
  useLedgerFile(path.join(tmp, "ledger.json"), path.join(tmp, "config.json"));
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  bounds = rangeBounds(NOW);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 句柄未释放时忽略 */ }
  vi.resetModules();
});

async function loadGrok(grokHome: string) {
  process.env.GROK_HOME = grokHome;
  vi.resetModules();
  return await import("../src/collectors/grok");
}

function writeJsonl(file: string, rows: Array<Record<string, unknown>>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

const INF = "shell.turn.inference_done";

describe("grokUsageRecord：token 行 vs 旧版快照行", () => {
  it("带 token 字段的 inference_done 产生用量记录，缓存/推理做减法", async () => {
    const mod = await loadGrok(tmp);
    const rec = mod.grokUsageRecord({
      msg: INF, sid: "s1", ts: "2025-05-14T09:00:00Z",
      ctx: { prompt_tokens: 1000, cached_prompt_tokens: 400, completion_tokens: 300, reasoning_tokens: 120, loop_index: 1, attempts: 0 },
    })!;
    expect(rec).toMatchObject({ in: 600, cr: 400, out: 180, reason: 120, sid: "s1" });
    // 旧口径 total = in+cr+out+reason = 1000+300 = prompt+completion
    expect(rec.in + rec.cr + rec.out + rec.reason).toBe(1300 - 0);
  });

  it("cached/reasoning 越界时钳制", async () => {
    const mod = await loadGrok(tmp);
    const rec = mod.grokUsageRecord({
      msg: INF, sid: "s1", ts: "2025-05-14T09:00:00Z",
      ctx: { prompt_tokens: 100, cached_prompt_tokens: 500, completion_tokens: 50, reasoning_tokens: 90 },
    })!;
    expect(rec).toMatchObject({ in: 0, cr: 100, out: 0, reason: 50 });
  });

  it("旧版 inference_done 没有 token 字段 → 不产生用量记录", async () => {
    const mod = await loadGrok(tmp);
    expect(mod.grokUsageRecord({ msg: INF, sid: "s1", ts: "2025-05-14T09:00:00Z", ctx: { model: "grok" } })).toBeNull();
    expect(mod.grokUsageRecord({ msg: "other", sid: "s1", ts: "2025-05-14T09:00:00Z", ctx: { prompt_tokens: 1 } })).toBeNull();
    expect(mod.grokUsageRecord({ msg: INF, ts: "2025-05-14T09:00:00Z", ctx: { prompt_tokens: 1 } })).toBeNull(); // 缺 sid
  });
});

describe("scanGrok：日志聚合与会话快照", () => {
  function fixture() {
    const root = path.join(tmp, "grokhome");
    const log = path.join(root, "logs", "unified.jsonl");
    writeJsonl(log, [
      // 今天两条带 token 的调用；第二条与第一条同 id（去重）
      { msg: INF, sid: "sess-1", ts: "2025-05-14T09:00:00", loop_index: 0, attempts: 0,
        ctx: { prompt_tokens: 1000, cached_prompt_tokens: 400, completion_tokens: 300, reasoning_tokens: 100, loop_index: 0, attempts: 0 } },
      { msg: INF, sid: "sess-1", ts: "2025-05-14T09:00:00", ctx: { prompt_tokens: 1000, cached_prompt_tokens: 400, completion_tokens: 300, reasoning_tokens: 100, loop_index: 0, attempts: 0 } },
      { msg: INF, sid: "sess-1", ts: "2025-05-14T09:05:00", ctx: { prompt_tokens: 500, cached_prompt_tokens: 0, completion_tokens: 200, reasoning_tokens: 0, loop_index: 1, attempts: 0 } },
      // 昨天一条
      { msg: INF, sid: "sess-1", ts: "2025-05-13T10:00:00", ctx: { prompt_tokens: 100, cached_prompt_tokens: 50, completion_tokens: 20, reasoning_tokens: 5, loop_index: 0, attempts: 0 } },
      // 旧版行：没有 token 字段，绝不能进总量
      { msg: INF, sid: "sess-1", ts: "2025-05-14T09:10:00", ctx: { model: "grok-4" } },
      // billing 快照行（周期已过 → stale，不落缓存）
      { msg: "billing: fetched credits config", sid: "sess-1", ts: "2025-05-14T08:00:00",
        ctx: { subscriptionTier: "super", config: { creditUsagePercent: 42.5, currentPeriod: { type: "PERIOD_TYPE_WEEKLY", start: "2025-05-12T00:00:00Z", end: "2025-05-09T00:00:00Z" } } } },
    ]);
    const sessionDir = path.join(root, "sessions", "proj-x", "sess-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "summary.json"), JSON.stringify({
      info: { id: "sess-1" }, updated_at: "2025-05-14T09:30:00", current_model_id: "x-ai/grok-4.6",
    }), "utf8");
    fs.writeFileSync(path.join(sessionDir, "signals.json"), JSON.stringify({
      turnCount: 3, toolCallCount: 7, contextTokensUsed: 55_000, contextWindowTokens: 200_000,
    }), "utf8");
    return root;
  }

  it("token 调用进入 ranges/days，旧版行与 ctx 快照不进入 token 总量", async () => {
    const root = fixture();
    const mod = await loadGrok(root);
    const cache: Record<string, any> = {};
    const r = mod.scanGrok(bounds, cache);

    // today: row1 in=600 cr=400 out=200 reason=100 (=1300) + row2 in=500 out=200 (=700)
    const today = r.ranges.today;
    expect(today.usage_calls).toBe(2);
    expect(today.usage_available).toBe(true);
    expect(today.tokens).toBe(2000);
    expect(today.in).toBe(1100);
    expect(today.cr).toBe(400);
    expect(today.out).toBe(400);
    expect(today.reason).toBe(100);
    // 快照只喂卡片：ctx_used=55000, ctx_window=200000 → ctx=27.5%
    expect(today.ctx_used).toBe(55_000);
    expect(today.ctx_window).toBe(200_000);
    expect(today.ctx).toBeCloseTo(27.5);
    // 项目/回顾日明细只来自 token 行
    expect(Object.keys(r.days).sort()).toEqual(["2025-05-13", "2025-05-14"]);
    expect(r.days["2025-05-14"].tokens).toBe(2000);
    expect(r.days["2025-05-14"].calls).toBe(2);
    expect(r.model).toBe("x-ai/grok-4.6");
  });

  it("只有旧版行时 tokens 回落到快照但 usage_available=false", async () => {
    const root = path.join(tmp, "legacy");
    writeJsonl(path.join(root, "logs", "unified.jsonl"), [
      { msg: INF, sid: "s9", ts: "2025-05-14T09:00:00", ctx: { model: "grok" } },
    ]);
    const mod = await loadGrok(root);
    const r = mod.scanGrok(bounds, {});
    expect(r.ranges.today.usage_available).toBe(false);
    expect(r.ranges.today.usage_calls).toBe(0);
    expect(r.ranges.today.in).toBe(0);
    expect(r.days).toEqual({});
  });

  it("额度：pct/plan/window 来自 billing 日志行，source=log；周期已过则 stale", async () => {
    const root = fixture();
    const mod = await loadGrok(root);
    // fixture 的 end=2025-05-09 已在真实时钟之前 → stale：pct 归零、reset 置空
    const q = mod.scanGrokBillingFromLog()!;
    expect(q.source).toBe("log");
    expect(q.plan).toBe("super");
    expect(q.window).toBe("week");
    expect(q.stale).toBe(true);
    expect(q.pct).toBe(0);
    expect(q.reset).toBeNull();
    // 未过期周期：end 在未来 → pct 原样保留，MONTHLY → window=month
    const futureEnd = Date.now() + 86_400_000;
    const log2 = path.join(tmp, "billing2.jsonl");
    writeJsonl(log2, [
      { msg: "billing: fetched credits config", ts: new Date().toISOString(),
        ctx: { subscriptionTier: "pro", config: { creditUsagePercent: 42.5,
          currentPeriod: { type: "PERIOD_TYPE_MONTHLY", start: "2026-09-01T00:00:00Z", end: new Date(futureEnd).toISOString() } } } },
    ]);
    const q2 = mod.scanGrokBillingFromLog(log2)!;
    expect(q2.pct).toBe(42.5);
    expect(q2.stale).toBe(false);
    expect(q2.window).toBe("month");
    expect(q2.plan).toBe("pro");
    expect(q2.reset).toBe(Math.trunc(futureEnd / 1000));
  });

  it("缓存签名：文件未变则二次扫描复用 records", async () => {
    const root = fixture();
    const mod = await loadGrok(root);
    const cache: Record<string, any> = {};
    mod.scanGrok(bounds, cache);
    const records = cache.grok_usage.records;
    delete cache._dirty;
    mod.scanGrok(bounds, cache);
    expect(cache.grok_usage.records).toBe(records);
  });
});

describe("grok_bot：blob 快照解析", () => {
  async function loadBot(dir?: string) {
    if (dir) process.env.TOKEI_GROK_BOT_DIR = dir; else delete process.env.TOKEI_GROK_BOT_DIR;
    vi.resetModules();
    return await import("../src/collectors/grok_bot");
  }

  function transcriptBlob(entries: Array<Record<string, unknown>>) {
    return { value: { entries } };
  }

  it("responses 按 requestId 去重、user 消息按 entry id 去重；无 token 字段则 in/out 恒 0", async () => {
    const dir = path.join(tmp, "persistence");
    fs.mkdirSync(dir, { recursive: true });
    const tsToday = new Date(2025, 4, 14, 9, 0, 0).getTime();
    fs.writeFileSync(path.join(dir, "a.blob"), JSON.stringify(transcriptBlob([
      { id: "u1", kind: "message", role: "user", timestampMs: tsToday },
      { id: "u1-dup", kind: "message", role: "user", timestampMs: tsToday + 1 }, // 不同 id → 不同 turn
      { id: "u2", kind: "message", role: "user", timestampMs: tsToday + 2 },     // 同 id 重复快照
      { id: "u2", kind: "message", role: "user", timestampMs: tsToday + 3 },
      { id: "r1", kind: "send-message", requestId: "req-1", timestampMs: tsToday + 4 },
      { id: "r2", kind: "send-message", requestId: "req-1", timestampMs: tsToday + 5 }, // 同 requestId → 只算一次
      { id: "t1", kind: "send-message", requestId: "req-2", message: { type: "connector" }, timestampMs: tsToday + 6 },
    ])), "utf8");
    const mod = await loadBot(dir);
    const cache: Record<string, any> = {};
    const r = mod.scanGrokBot(bounds, cache);
    expect(r.ranges.today.turns).toBe(3); // u1, u1-dup, u2（不按文本长度估算任何东西）
    expect(r.ranges.today.calls).toBe(2); // req-1 去重后 + req-2
    expect(r.ranges.today.tools).toBe(1);
    expect(r.ranges.today.in).toBe(0);
    expect(r.ranges.today.out).toBe(0);
    expect(r.quota).toBeNull();
  });

  it("多个持久化键存同一份 transcript → 按首尾 entry 边界去重", async () => {
    const dir = path.join(tmp, "persistence2");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date(2025, 4, 14, 9, 0, 0).getTime();
    const entries = [
      { id: "e1", kind: "message", role: "user", timestampMs: ts },
      { id: "e2", kind: "send-message", requestId: "q1", timestampMs: ts + 1000 },
    ];
    fs.writeFileSync(path.join(dir, "k1.blob"), JSON.stringify(transcriptBlob(entries)), "utf8");
    fs.writeFileSync(path.join(dir, "k2.blob"), JSON.stringify(transcriptBlob(entries)), "utf8");
    const mod = await loadBot(dir);
    const r = mod.scanGrokBot(bounds, {});
    expect(r.ranges.today.turns).toBe(1);
    expect(r.ranges.today.calls).toBe(1);
    expect(r.ranges.today.sessions).toBe(1);
  });

  it("roster 给 transcript 归属会话 id", async () => {
    const dir = path.join(tmp, "persistence3");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date(2025, 4, 14, 9, 0, 0).getTime();
    fs.writeFileSync(path.join(dir, "roster.blob"), JSON.stringify({
      value: { rows: [{ id: "conv-77", lastEntry: { id: "e2" } }] },
    }), "utf8");
    fs.writeFileSync(path.join(dir, "t.blob"), JSON.stringify(transcriptBlob([
      { id: "e1", kind: "message", role: "user", timestampMs: ts },
      { id: "e2", kind: "send-message", requestId: "q1", timestampMs: ts + 1000 },
    ])), "utf8");
    const mod = await loadBot(dir);
    const r = mod.scanGrokBot(bounds, {});
    expect(r.ranges.today.sessions).toBe(1);
    expect(r.ranges.today.turns).toBe(1);
  });

  it("目录不存在 → 键位齐全的空结果", async () => {
    const mod = await loadBot(path.join(tmp, "does-not-exist"));
    const r = mod.scanGrokBot(bounds, {});
    expect(r.quota).toBeNull();
    for (const k of ["today", "yesterday", "week", "last_week", "month", "year", "all"] as const) {
      expect(r.ranges[k]).toEqual({ in: 0, out: 0, sessions: 0, calls: 0, turns: 0, tools: 0, duration: 0 });
    }
  });

  it("坏 JSON / 空文件被忽略而不是抛错", async () => {
    const dir = path.join(tmp, "persistence4");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.blob"), "{not json", "utf8");
    fs.writeFileSync(path.join(dir, "empty.blob"), "", "utf8");
    const mod = await loadBot(dir);
    const r = mod.scanGrokBot(bounds, {});
    expect(r.ranges.today.turns).toBe(0);
  });
});

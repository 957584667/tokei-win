/**
 * qodercli 采集器单测：逐函数对齐 usage.30s.py 的 _qodercli_usage / _merge_qodercli_event /
 * _parse_qodercli_file / _qodercli_usage_days / scan_qodercli 口径（临时目录 + TOKEI_* env 注入）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rangeBounds } from "../src/core/ranges";
import {
  estTokens, isIsoDay, mergeQoderCliEvent, parseQoderCliFile, qoderCliDir,
  qoderCliUsage, qoderCliUsageDays, scanQoderCli, scanQoderCliCn,
} from "../src/collectors/qodercli";
import { useLedgerFile } from "../src/core/ledger";

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["TOKEI_QODERCLI_DIR", "TOKEI_QODERCLI_CN_DIR"];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-qodercli-"));
  // 账本指到临时目录：扫描器接入 ledger 后也绝不写 ~/.tokei
  useLedgerFile(path.join(tmp, "ledger.json"), path.join(tmp, "config.json"));
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 句柄未释放时忽略 */ }
});

// 固定「现在」：2025-05-14（周三），本周起点 05-12，上周 05-05~05-12
const NOW = new Date(2025, 4, 14, 18, 0, 0);

function writeJsonl(file: string, rows: Array<Record<string, unknown> | string>): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n", "utf8");
  return file;
}

function event(over: Record<string, any> = {}) {
  return {
    id: "e", day: "2025-05-14", hour: 10, model: null, est: 0, tools: [] as string[],
    in: 0, out: 0, cr: 0, cw: 0, credits: 0, usage_available: false, request_id: null,
    ...over,
  } as any;
}

describe("_qodercli_usage：四桶 + Credits + request_id", () => {
  it("cache_creation_input_tokens 形状", () => {
    const u = qoderCliUsage({ usage: {
      input_tokens: 1000, cache_read_input_tokens: 400,
      cache_creation_input_tokens: 100, output_tokens: 50,
    } });
    expect(u).toMatchObject({ in: 500, out: 50, cr: 400, cw: 100, usage_available: true });
  });

  it("缺 cache_creation_input_tokens 时退回 cache_creation 的 5m+1h 求和", () => {
    const u = qoderCliUsage({ usage: {
      input_tokens: 600, output_tokens: 10,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 },
    } });
    expect(u.cw).toBe(150);
    expect(u.in).toBe(450);
  });

  it("两种形状同时存在只读顶层，绝不双计", () => {
    const u = qoderCliUsage({ usage: {
      input_tokens: 1000, output_tokens: 0, cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_5m_input_tokens: 700, ephemeral_1h_input_tokens: 700 },
    } });
    expect(u.cw).toBe(200);
    expect(u.in).toBe(800);
  });

  it("in = max(raw_in - cr - cw, 0) 的钳制与 int() 归零", () => {
    expect(qoderCliUsage({ usage: { input_tokens: 100, cache_read_input_tokens: 200 } }).in).toBe(0);
    const negative = qoderCliUsage({ usage: { input_tokens: -50, output_tokens: "12" } });
    expect([negative.in, negative.out]).toEqual([0, 12]);
  });

  it("credits 走 credits ?? original_credits，负值/坏值归 0", () => {
    expect(qoderCliUsage({ usage: { credits: 0.25 } }).credits).toBe(0.25);
    expect(qoderCliUsage({ usage: { original_credits: 1.5 } }).credits).toBe(1.5);
    expect(qoderCliUsage({ usage: { credits: -3, original_credits: 9 } }).credits).toBe(0);
    expect(qoderCliUsage({ usage: { credits: "abc" } }).credits).toBe(0);
    expect(qoderCliUsage({ usage: {} }).credits).toBe(0);
  });

  it("零 token ⇒ usage_available=false；request_id 空串按 Python 视作 None", () => {
    const zero = qoderCliUsage({ usage: { input_tokens: 0, output_tokens: 0, credits: 0.14, request_id: "" } });
    expect(zero.usage_available).toBe(false);
    expect(zero.request_id).toBeNull();
    expect(qoderCliUsage({ usage: { request_id: "r1" } }).request_id).toBe("r1");
    expect(qoderCliUsage({ usage: "nope" })).toMatchObject({ in: 0, credits: 0, usage_available: false });
    expect(qoderCliUsage({})).toMatchObject({ in: 0, out: 0, cr: 0, cw: 0 });
  });
});

describe("_merge_qodercli_event：token 总量高者作基准", () => {
  it("existing 为 None 时返回候选副本；不排序（Python 只做 dict(candidate)）", () => {
    const candidate = event({ tools: ["b", "a"] });
    const merged = mergeQoderCliEvent(null, candidate);
    expect(merged).not.toBe(candidate);
    expect(merged.tools).not.toBe(candidate.tools);
    expect(merged.tools).toEqual(["b", "a"]);
  });

  it("胜者定基线，credits/est 取最大、tools 并集排序、usage_available 取或", () => {
    const big = event({ in: 100, out: 10, credits: 1, est: 3, tools: ["t2"], usage_available: true, model: "m-big" });
    const small = event({ in: 1, credits: 5, est: 9, tools: ["t1", "t1"], usage_available: false, model: "m-small" });
    const merged = mergeQoderCliEvent(small, big);
    expect(merged.in).toBe(100);
    expect(merged.out).toBe(10);
    expect(merged.credits).toBe(5);
    expect(merged.est).toBe(9);
    expect(merged.tools).toEqual(["t1", "t2"]);
    expect(merged.usage_available).toBe(true);
    expect(merged.model).toBe("m-big");
  });

  it("总量相等时保留 existing；胜者 model 为空则回退败者", () => {
    expect(mergeQoderCliEvent(event({ in: 10, model: "keep" }), event({ in: 10, model: "other" })).model).toBe("keep");
    const noModel = mergeQoderCliEvent(event({ in: 1, model: "loser" }), event({ in: 100, model: null }));
    expect([noModel.in, noModel.model]).toEqual([100, "loser"]);
  });

  it("候选胜出时保留候选的 day/hour（日账归属不漂移）", () => {
    const merged = mergeQoderCliEvent(
      event({ id: "r1", day: "2025-05-13", hour: 23, in: 1 }),
      event({ id: "r1", day: "2025-05-14", hour: 1, in: 50 }),
    );
    expect([merged.day, merged.hour]).toEqual(["2025-05-14", 1]);
  });
});

describe("_parse_qodercli_file：请求重键、去重与日账", () => {
  it("message.id 先落盘、request_id 后落盘：prior 被搬走，绝不计两次", () => {
    const file = writeJsonl(path.join(tmp, "p", "s1.jsonl"), [
      { type: "assistant", timestamp: "2025-05-14T10:00:00",
        message: { id: "m1", model: "qfmodel", content: [{ type: "text", text: "abcd" }],
          usage: { input_tokens: 100, output_tokens: 20 } } },
      // 同一响应的第二条落盘：这次带上了 request_id
      { type: "assistant", timestamp: "2025-05-14T10:00:05",
        message: { id: "m1", content: [{ type: "tool_use", id: "t1", input: {} }],
          usage: { request_id: "r1", input_tokens: 100, output_tokens: 20, credits: 0.5 } } },
      // 第三条又回到只有 message.id 的形状：必须沿用 message_requests 的映射
      { type: "assistant", timestamp: "2025-05-14T10:00:06",
        message: { id: "m1", usage: { input_tokens: 100, output_tokens: 20, credits: 0.4 } } },
    ]);
    const parsed = parseQoderCliFile(file);
    // 三行只留一份事件；Python 的合并整份取胜者，所以事件自带的 id 仍是被 pop 出来的
    // message.id（m1），而它挂在 responses 的 r1 键下 —— _requests 索引按 event.id 落键。
    expect(parsed.responses).toHaveLength(1);
    expect(parsed.responses[0].id).toBe("m1");
    expect(parsed.responses[0]).toMatchObject({ in: 100, out: 20, credits: 0.5, tools: ["t1"], model: "qfmodel" });
    const days = qoderCliUsageDays({ _requests: { [parsed.responses[0].id]: parsed.responses[0] } }, false);
    expect(days["2025-05-14"]).toMatchObject({ calls: 1, in: 100, out: 20, usage_calls: 1, est: 1 });
    expect(days["2025-05-14"].hours[10]).toBe(120);
  });

  it("request_id 先到、message.id 后到：同样只留一份事件", () => {
    const file = writeJsonl(path.join(tmp, "p", "s1b.jsonl"), [
      { type: "assistant", timestamp: "2025-05-14T10:00:00",
        message: { id: "m1", usage: { request_id: "r1", input_tokens: 100, output_tokens: 20 } } },
      { type: "assistant", timestamp: "2025-05-14T10:00:01",
        message: { id: "m1", usage: { input_tokens: 100, output_tokens: 20 } } },
    ]);
    const parsed = parseQoderCliFile(file);
    expect(parsed.responses).toHaveLength(1);
    expect(parsed.responses[0].id).toBe("r1");
  });

  it("无 request_id 且无 message.id 时用 文件:行号 兜底", () => {
    const file = writeJsonl(path.join(tmp, "p", "s2.jsonl"), [
      { type: "user", timestamp: "2025-05-14T10:00:00", message: { content: "hello world 请解释" } },
      { type: "assistant", timestamp: "2025-05-14T10:00:01", message: { usage: { input_tokens: 5 } } },
    ]);
    expect(parseQoderCliFile(file).responses.map((e) => e.id)).toEqual([`${file}:2`]);
  });

  it("runtime-config 只认模型；非 user/assistant 整行跳过；坏 JSON 行忽略", () => {
    const file = writeJsonl(path.join(tmp, "p", "s3.jsonl"), [
      { type: "runtime-config", model: "auto" },
      { type: "system", timestamp: "2025-05-14T10:00:00", message: { usage: { input_tokens: 9999, output_tokens: 9999 } } },
      { type: "active-leaf", timestamp: "2025-05-14T10:00:01" },
      "{ 这不是合法 JSON",
      { type: "assistant", timestamp: "2025-05-14T10:00:02",
        message: { model: "auto", usage: { request_id: "r9", credits: 0.1 } } },
      { type: "runtime-config", model: "qwen-max" },
      { type: "assistant", timestamp: "2025-05-14T10:00:03", message: { usage: { request_id: "r10", input_tokens: 7 } } },
    ]);
    const parsed = parseQoderCliFile(file);
    expect(parsed.model).toBe("qwen-max");
    expect(parsed.responses.map((e) => e.id)).toEqual(["r9", "r10"]);
    expect(parsed.responses[0].model).toBe("auto");
    expect(parsed.responses[1].model).toBe("qwen-max");
    expect(parsed.days["2025-05-14"].turns).toBe(0);
  });

  it("user 轮次：isMeta/isSidechain/“<”前缀/空文本都不算，一条记录只 +1", () => {
    const file = writeJsonl(path.join(tmp, "p", "s4.jsonl"), [
      { type: "user", timestamp: "2025-05-14T10:00:00", message: { content: "hello" } },
      { type: "user", isMeta: true, timestamp: "2025-05-14T10:00:01", message: { content: "meta 文本" } },
      { type: "user", isSidechain: true, timestamp: "2025-05-14T10:00:02", message: { content: "sidechain" } },
      { type: "user", timestamp: "2025-05-14T10:00:03", message: { content: "<system-reminder>注入</system-reminder>" } },
      { type: "user", timestamp: "2025-05-14T10:00:04", message: { content: [{ type: "tool_result", content: "x" }] } },
      { type: "user", timestamp: "2025-05-14T10:00:05", message: { content: [{ type: "text", text: "" }, { type: "text", text: "你好 ab" }] } },
    ]);
    const day = parseQoderCliFile(file).days["2025-05-14"];
    expect(day.turns).toBe(2);
    expect(day.est).toBeCloseTo(estTokens("hello") + estTokens("你好 ab"), 10);
  });

  it("活跃间隔只在 0 < gap <= 300 累计，且 prev_ts 每行都前移", () => {
    const file = writeJsonl(path.join(tmp, "p", "s5.jsonl"), [
      { type: "user", timestamp: "2025-05-14T10:00:00", message: { content: "a" } },
      { type: "assistant", timestamp: "2025-05-14T10:01:40", message: { usage: { request_id: "w1" } } },  // +100
      { type: "assistant", timestamp: "2025-05-14T10:01:40", message: { usage: { request_id: "w2" } } },  // gap 0 → 不计
      { type: "assistant", timestamp: "2025-05-14T10:06:40", message: { usage: { request_id: "w3" } } },  // gap 恰 300 → 计入
      { type: "assistant", timestamp: "2025-05-14T10:12:41", message: { usage: { request_id: "w4" } } },  // gap 301 → 不计
      { type: "assistant", timestamp: "2025-05-14T09:00:00", message: { usage: { request_id: "w5" } } },  // 倒序 → 不计
      { type: "assistant", timestamp: "2025-05-14T09:05:00", message: { usage: { request_id: "w6" } } },  // 距上条 300 → 已超？prev=09:00 → gap 300 计入
    ]);
    const parsed = parseQoderCliFile(file);
    // 100 + 300 + 300 = 700（w4 的 301 被拒后 prev 已是 09:00，之后只剩 300）
    expect(parsed.days["2025-05-14"].active).toBeCloseTo(700, 6);
  });
});

describe("scan_qodercli：门控、区间分桶与缓存", () => {
  function fixture(): string {
    const root = path.join(tmp, "projects");
    process.env.TOKEI_QODERCLI_CN_DIR = root;
    writeJsonl(path.join(root, "projA", "s1.jsonl"), [
      { type: "runtime-config", model: "auto" },
      { type: "user", timestamp: "2025-05-14T10:00:00", message: { content: "写点什么" } },
      // 内置路由：零 token 有 credits → 只进 calls/credits，不进 usage_calls
      { type: "assistant", timestamp: "2025-05-14T10:00:10",
        message: { usage: { request_id: "r1", input_tokens: 0, output_tokens: 0, credits: 1.5 } } },
      { type: "assistant", timestamp: "2025-05-14T10:00:20",
        message: { model: "qfmodel", usage: { request_id: "r2", input_tokens: 1000,
          cache_read_input_tokens: 400, cache_creation_input_tokens: 100, output_tokens: 50, credits: 0.2 },
          content: [{ type: "tool_use", id: "t1", input: { a: 1 } }] } },
    ]);
    writeJsonl(path.join(root, "projA", "sess2", "subagents", "a1.jsonl"), [
      { type: "user", timestamp: "2025-05-14T11:00:00", message: { content: "子代理的提问不算会话轮次" } },
      { type: "assistant", timestamp: "2025-05-14T11:00:10",
        message: { usage: { request_id: "r3", input_tokens: 30, output_tokens: 3, credits: 0.5 } } },
    ]);
    return root;
  }

  it("usage_calls 只认落了 token 的请求；turns/sessions 只认非子代理文件", () => {
    const root = fixture();
    const cache: Record<string, any> = {};
    const out = scanQoderCli(rangeBounds(NOW), cache, "qodercli_cn");
    const t = out.ranges.today;
    expect(t.calls).toBe(3);
    expect(t.usage_calls).toBe(2);
    expect(t.usage_available).toBe(true);
    expect(t.in).toBe(530);
    expect(t.out).toBe(53);
    expect(t.cr).toBe(400);
    expect(t.cw).toBe(100);
    expect(t.tools).toBe(1);
    expect(t.sessions).toBe(1);
    expect(t.sub_agents).toBe(1);
    expect(t.turns).toBe(1);
    expect(t.credits).toBeCloseTo(2.2, 6);
    expect(t.duration).toBe(30_000);   // 主会话 20s + 子代理 10s 的相邻间隔
    expect(t.hit).toBeCloseTo((400 / (530 + 400 + 100)) * 100, 6);
    expect(t.ctx).toBe(0);             // ctx_sum/ctx_count 只有 qoderwork 会写
    expect(Object.keys(t).sort()).toEqual([
      "calls", "cr", "credits", "ctx", "cw", "duration", "est", "hit", "in", "models",
      "out", "sessions", "sub_agents", "tools", "turns", "usage_available", "usage_calls",
    ]);
    expect(out.model).toBe("qfmodel");
    expect(qoderCliDir("qodercli_cn")).toBe(path.resolve(root));
    // 零 token 的 r1 也进模型账（credits 非 0 即可），但 token 全 0
    const auto = t.models.find((m: any) => m.model_id === "auto");
    expect(auto.credits).toBeCloseTo(1.5, 6);
    expect(auto.in + auto.out + auto.cr + auto.cw).toBe(0);
  });

  it("真实 Qoder CN 日志的形状：token 全 0 而 credits/est 非 0", () => {
    const root = path.join(tmp, "cn");
    process.env.TOKEI_QODERCLI_CN_DIR = root;
    writeJsonl(path.join(root, "proj", "s.jsonl"), [
      { type: "user", timestamp: "2025-05-14T10:00:00", message: { content: "hello world" } },
      { type: "assistant", timestamp: "2025-05-14T10:00:05",
        message: { usage: { request_id: "r1", input_tokens: 0, output_tokens: 0,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0, credits: 0.14 } } },
    ]);
    const a = scanQoderCliCn(rangeBounds(NOW), {}).ranges.all;
    expect([a.in, a.out, a.cr, a.cw, a.usage_calls, a.hit, a.ctx]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(a.usage_available).toBe(false);
    expect(a.calls).toBe(1);
    expect(a.credits).toBeCloseTo(0.14, 8);
    expect(a.est).toBeGreaterThan(0);
  });

  it("跨刷新：数字不变、不重复解析、_usage_days 未变则不标脏", () => {
    const root = fixture();
    const bounds = rangeBounds(NOW);
    const cache: Record<string, any> = {};
    const first = scanQoderCli(bounds, cache, "qodercli_cn");
    delete cache["_dirty"];
    expect(scanQoderCli(bounds, cache, "qodercli_cn").ranges).toEqual(first.ranges);
    expect(cache["_dirty"]).toBeUndefined();

    const fileKey = path.join(root, "projA", "s1.jsonl");
    expect(Object.keys(cache.qodercli_cn)).toContain(fileKey);
    // 篡改缓存里的日账：只有「不再解析该文件」才会保留这个哨兵
    cache.qodercli_cn[fileKey].days = { "2025-05-14": { turns: 42, est: 0, active: 0 } };
    const again = scanQoderCli(bounds, cache, "qodercli_cn");
    expect(again.ranges.all.turns).toBe(first.ranges.all.turns - 1 + 42);
    expect(again.ranges.all.calls).toBe(first.ranges.all.calls);
    expect(again.ranges.all.in).toBe(first.ranges.all.in);
    // duration 不会掉：接入账本后，日账按高水位取整日快照，篡改缓存让实时值变小也照样保留
    // 上一轮的值（与 macOS 版 ledger_reconcile 一致）
    expect(again.ranges.all.duration).toBe(first.ranges.all.duration);
    expect(Object.keys(cache.qodercli_cn._requests).sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("同一 request_id 跨文件出现只计一次", () => {
    const root = path.join(tmp, "cross");
    process.env.TOKEI_QODERCLI_CN_DIR = root;
    writeJsonl(path.join(root, "proj", "main.jsonl"), [
      { type: "assistant", timestamp: "2025-05-14T10:00:00",
        message: { usage: { request_id: "same", input_tokens: 100, output_tokens: 10, credits: 1 } } },
    ]);
    writeJsonl(path.join(root, "proj", "sess", "subagents", "mirror.jsonl"), [
      { type: "assistant", timestamp: "2025-05-14T10:00:30",
        message: { usage: { request_id: "same", input_tokens: 100, output_tokens: 10, credits: 1 } } },
    ]);
    const out = scanQoderCli(rangeBounds(NOW), {}, "qodercli_cn");
    expect(out.ranges.all.calls).toBe(1);
    expect(out.ranges.all.in).toBe(100);
    expect(out.ranges.all.credits).toBeCloseTo(1, 8);
    expect(out.ranges.all.sessions).toBe(1);
    expect(out.ranges.all.sub_agents).toBe(1);
  });

  it("文件消失后条目被剪掉，但持久 _requests 仍贡献用量（同 Python 不回收请求索引）", () => {
    const root = fixture();
    const bounds = rangeBounds(NOW);
    const cache: Record<string, any> = {};
    scanQoderCli(bounds, cache, "qodercli_cn");
    delete cache["_dirty"];
    const fileKey = path.join(root, "projA", "sess2", "subagents", "a1.jsonl");
    fs.rmSync(fileKey);
    const out = scanQoderCli(bounds, cache, "qodercli_cn");
    expect(Object.keys(cache.qodercli_cn)).not.toContain(fileKey);
    expect(out.ranges.all.calls).toBe(3);
    expect(out.ranges.all.in).toBe(530);
    expect(out.ranges.all.sub_agents).toBe(0);
    expect(cache["_dirty"]).toBe(true);
  });

  it("_parser 版本不符时整块缓存重来", () => {
    const root = fixture();
    const cache: Record<string, any> = {
      qodercli_cn: { _parser: 1, _requests: { ghost: event({ id: "ghost" }) }, junk: 1 },
    };
    scanQoderCli(rangeBounds(NOW), cache, "qodercli_cn");
    expect(Object.keys(cache.qodercli_cn).sort()).toEqual([
      "_model", "_parser", "_requests", "_usage_days",
      path.join(root, "projA", "s1.jsonl"),
      path.join(root, "projA", "sess2", "subagents", "a1.jsonl"),
    ].sort());
    expect(cache.qodercli_cn._requests.ghost).toBeUndefined();
    expect(cache.qodercli_cn._parser).toBe(2);
  });

  it("_qodercli_usage_days 的 use_cached 与按 id 合并兜底", () => {
    const cached = { "2025-05-14": { calls: 99 } };
    expect(qoderCliUsageDays({ _usage_days: cached }, true)).toBe(cached);
    expect(qoderCliUsageDays({ _usage_days: cached }, false)).not.toBe(cached);
    const rebuilt = qoderCliUsageDays({}, false, [
      event({ id: "r", in: 1 }),
      event({ id: "r", in: 9, out: 1, usage_available: true, credits: 2 }),
    ]);
    expect(rebuilt["2025-05-14"]).toMatchObject({ calls: 1, in: 9, out: 1, usage_calls: 1, credits: 2 });
    expect(rebuilt["2025-05-14"].hours[10]).toBe(10);
    // 非法日期键被丢弃（Python 的 date.fromisoformat 校验）
    expect(qoderCliUsageDays({ _requests: { z: event({ day: "2025-13-40" }) } }, false)).toEqual({});
  });

  it("isIsoDay 与 Python date.fromisoformat 同宽窄", () => {
    expect(isIsoDay("2025-05-14")).toBe(true);
    expect(isIsoDay("2025-5-14")).toBe(false);
    expect(isIsoDay("2025-02-30")).toBe(false);
    expect(isIsoDay(undefined)).toBe(false);
  });
});

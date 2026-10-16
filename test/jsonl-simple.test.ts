/**
 * JSONL 简易采集器测试：Pi / Prime / Muse / CmdCode / WorkBuddy / CodeBuddy。
 * 合成 JSONL 写入临时目录，用各采集器支持的 TOKEI_* 环境变量注入根路径。
 * 重点覆盖各工具的 dedupe 规则与「input 是否已含缓存」口径区分。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rangeBounds } from "../src/core/ranges";
import { scanPi } from "../src/collectors/pi";
import { scanPrimeAgent } from "../src/collectors/prime_agent";
import { scanMusecode } from "../src/collectors/musecode";
import { scanCmdcode } from "../src/collectors/cmdcode";
import { scanWorkbuddy, scanWorkbuddyAi } from "../src/collectors/workbuddy";
import { scanCodebuddy } from "../src/collectors/codebuddy";
import { ledgerFlush, useLedgerFile } from "../src/core/ledger";

const ENV_KEYS = [
  "TOKEI_PI_DIR", "TOKEI_PRIME_AGENT_SESSION_DIR", "TOKEI_PRIME_AGENT_DIR",
  "TOKEI_MUSE_DIR", "TOKEI_CMDCODE_DIR", "TOKEI_WORKBUDDY_DIR",
  "TOKEI_WORKBUDDY_AI_DIR", "TOKEI_CODEBUDDY_DIR",
];

// 本文件按用例各自建临时目录、没有单一根，故把账本指到系统临时目录里命名隔离的文件，
// 避免扫描器接入 ledger 后写真实的 ~/.tokei/ledger.json
const LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-jsonl-simple-ledgers-"));
// 每个用例一份空账本：账本按「工具+日」做高水位，共用一份会让上一个用例入账的历史值
// 盖住这一个用例的实时值
let ledgerSeq = 0;
beforeEach(() => {
  useLedgerFile(path.join(LEDGER_DIR, `ledger-${++ledgerSeq}.json`), path.join(LEDGER_DIR, "config.json"));
});
afterAll(() => {
  try {
    fs.rmSync(LEDGER_DIR, { recursive: true, force: true });
  } catch { /* 忽略 */ }
});

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeJsonl(file: string, records: Array<Record<string, any>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  while (tmpDirs.length) {
    try {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch { /* 忽略 */ }
  }
});

function bounds() {
  return rangeBounds(new Date());
}

/** 所有断言都走 all 区间：固定历史日期不受本机时钟/时区影响 */
function all(r: any) {
  return r.ranges.all;
}

describe("pi collector", () => {
  it("input 不含缓存四桶独立，成本优先 usage.cost.total", () => {
    const dir = mkTmp();
    process.env.TOKEI_PI_DIR = dir;
    writeJsonl(path.join(dir, "proj", "s1.jsonl"), [
      { type: "session", id: "sess-1", cwd: "/work/demo" },
      {
        type: "message",
        timestamp: "2026-09-15T08:00:00Z",
        message: {
          role: "assistant", provider: "anthropic", model: "claude-opus-4-8",
          usage: {
            input: 100, output: 50, cacheRead: 20, cacheWrite: 10, reasoning: 5,
            cost: { total: 0.0123, input: 999, output: 999 }, // total 优先，parts 不覆盖
          },
        },
      },
      {
        type: "message",
        timestamp: "2026-09-15T09:00:00Z",
        message: { role: "user", content: "无 usage 的行不计" },
      },
    ]);
    const r = all(scanPi(bounds(), {}));
    expect(r.in).toBe(100); // 独立桶：input 原样，不减缓存
    expect(r.out).toBe(50);
    expect(r.cr).toBe(20);
    expect(r.cw).toBe(10);
    expect(r.reason).toBe(5);
    expect(r.cost).toBeCloseTo(0.0123, 10);
    expect(r.sessions).toBe(1);
  });
});

describe("prime_agent collector", () => {
  it("child_usage_attributed 是 bookkeeping 不重复计入；artifacts 副本按同一会话去重", () => {
    const sessions = mkTmp();
    process.env.TOKEI_PRIME_AGENT_SESSION_DIR = sessions;
    const assistant = {
      type: "message",
      timestamp: "2026-09-15T08:00:00Z",
      id: "evt-1",
      message: {
        role: "assistant", provider: "openai", model: "gpt-5.5",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.001 } },
      },
    };
    const attributed = {
      type: "child_usage_attributed", // 父会话聚合记账，绝不能再算一次
      timestamp: "2026-09-15T08:00:00Z",
      message: { role: "assistant", usage: { input: 99999, output: 99999, cost: { total: 99 } } },
    };
    writeJsonl(path.join(sessions, "sessions", "a.jsonl"), [
      { type: "session", id: "s1", cwd: "/work/p" },
      assistant,
      attributed,
    ]);
    // RLM 子代理日志：独立 session，正常参与统计
    writeJsonl(path.join(sessions, "session-artifacts", "deep", "b.jsonl"), [
      { type: "session", id: "s2-rlm", cwd: "/work/p" },
      {
        type: "message", timestamp: "2026-09-15T08:30:00Z", id: "evt-2",
        message: { role: "assistant", model: "gpt-5.5", usage: { input: 3, output: 1 } },
      },
    ]);
    // 同一逻辑会话 s1 的物理副本（事件更少）→ canonical 只保留 a.jsonl
    writeJsonl(path.join(sessions, "session-artifacts", "copy.jsonl"), [
      { type: "session", id: "s1", cwd: "/work/p" },
      attributed,
    ]);
    const r = all(scanPrimeAgent(bounds(), {}));
    expect(r.in).toBe(13); // 10 + 3，attributed 与副本均不重复计
    expect(r.out).toBe(6);
    expect(r.cr).toBe(2);
    expect(r.cw).toBe(1);
    expect(r.cost).toBeCloseTo(0.001045, 9); // s1 用日志 total 0.001；RLM 无成本字段 → 按价表估
    expect(r.sessions).toBe(2);
  });
});

describe("musecode collector", () => {
  it("input 已含缓存要减掉；source_run_record_id 去重；goal_usage_attribution 不计；same-as-main 回退", () => {
    const root = mkTmp();
    process.env.TOKEI_MUSE_DIR = root;
    const µs = Date.UTC(2026, 8, 15, 8, 0, 0) * 1000; // recorded_at 为微秒
    const completed = (recordId: string, event: Record<string, any>) => ({
      stream: { id: "muse-sess" },
      source_run_record_id: recordId,
      recorded_at: µs,
      payload_type: "runtime.session",
      payload: { kind: "run", run_id: "run-1", event: { kind: "model_completed", ...event } },
    });
    writeJsonl(path.join(root, "sessions", "flat", "session.jsonl"), [
      { stream: { id: "muse-sess" }, payload_type: "runtime.session.metadata", payload: { record: { workspace_root: "/work/muse" } } },
      { payload_type: "run.model.configured", payload: { record: { run_stream: { id: "run-1" }, model_id: "muse-spark-1.3" } } },
      completed("rec-1", {
        model: "same-as-main", // 回退到同 run 的 run.model.configured
        usage: { input_tokens: 1000, cached_tokens: 400, output_tokens: 100, cache_write_tokens: 50, reasoning_tokens: 30 },
      }),
      completed("rec-1", { // 同一 source_run_record_id 的重复副本 → 丢弃
        model: "muse-spark-1.3",
        usage: { input_tokens: 8888, cached_tokens: 0, output_tokens: 8888 },
      }),
      { // 归因账本：不是 model_completed 用量事件，不加计
        payload_type: "goal_usage_attribution",
        payload: { record: { usage: { input_tokens: 7777, output_tokens: 7777 } } },
      },
    ]);
    const r = all(scanMusecode(bounds(), {}));
    expect(r.in).toBe(600); // 1000 - 400：原始 input 已含缓存
    expect(r.cr).toBe(400);
    expect(r.out).toBe(100);
    expect(r.cw).toBe(50);
    expect(r.reason).toBe(30); // 输出子集，单独展示不混进 out
    expect(r.cost).toBe(0); // muse-* 无公开价 → 不估美元
    expect(r.sessions).toBe(1);
    const modelRow = r.models.find((m: any) => String(m.model_id).includes("muse-spark-1.3"));
    expect(modelRow).toBeTruthy(); // same-as-main 已回退为配置的模型
  });
});

describe("cmdcode collector", () => {
  it("四桶独立不减缓存；costUsd 直接采用；跨文件按消息身份+时刻去重；跳过 audit/坏文件", () => {
    const root = mkTmp();
    process.env.TOKEI_CMDCODE_DIR = root;
    const sessionA = path.join(root, "projects", "slug-a");
    const sessionB = path.join(root, "projects", "slug-b");
    const msg = (id: string, costUsd: unknown) => ({
      type: "message",
      sessionId: "cc-1",
      id,
      timestamp: "2026-09-15T08:00:00Z",
      model: "gpt-5.5",
      message: {
        role: "assistant",
        usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 300, cacheWriteTokens: 20, costUsd },
      },
    });
    writeJsonl(path.join(sessionA, "sess-a.jsonl"), [
      { type: "session", id: "cc-1", cwd: "/work/cmd", model: "gpt-5.5" },
      msg("m-1", 0.5),
      msg("m-1", 0.5), // 同文件重复身份 → 计一次
      { type: "checkpoint", message: { role: "assistant", usage: { inputTokens: 9999 } } }, // 非 message 类型跳过
      { type: "message", message: { role: "user", usage: { inputTokens: 5555 } } }, // prompts 跳过
      { type: "message", timestamp: "2026-09-15T08:10:00Z", message: { role: "assistant", usage: { inputTokens: 10, outputTokens: 5, costUsd: -3 } } }, // 负成本视为无效
    ]);
    writeJsonl(path.join(sessionB, "sess-b.jsonl"), [
      { type: "session", id: "cc-2", cwd: "/work/cmd" },
      msg("m-1", 0.5), // 跨文件同消息身份+同时刻 → 不重复
      {
        type: "message", sessionId: "cc-2", id: "m-2", timestamp: "2026-09-15T09:00:00Z",
        message: { role: "assistant", usage: { inputTokens: 7, outputTokens: 8, costUsd: 0.25 } },
      },
    ]);
    // hooks-audit sidecar 与带副后缀的文件不解析
    writeJsonl(path.join(sessionA, "hooks-audit-x.jsonl"), [msg("m-9", 123)]);
    writeJsonl(path.join(sessionA, "sess-a.meta.jsonl"), [msg("m-8", 123)]);
    const cache = {};
    const r = all(scanCmdcode(bounds(), cache));
    expect(r.in).toBe(117); // 100+10+7：input 不含缓存，原样入桶
    expect(r.out).toBe(53);
    expect(r.cr).toBe(300);
    expect(r.cw).toBe(20);
    expect(r.cost).toBeCloseTo(0.75, 10); // 只有正 costUsd 入账，绝不估算
    expect(r.sessions).toBe(2);
  });
});

describe("workbuddy collectors", () => {
  it("工厂生成 workbuddy 与 workbuddy_ai 独立缓存；total==in+out 说明 input 已含缓存需减出", () => {
    const dir = mkTmp();
    process.env.TOKEI_WORKBUDDY_DIR = dir;
    process.env.TOKEI_WORKBUDDY_AI_DIR = mkTmp();
    const item = {
      id: "e1",
      sessionId: "wb-1",
      cwd: "C:/work/wb",
      timestamp: "2026-09-15T08:00:00Z",
      message: {
        role: "assistant",
        model: "glm-4.6",
        // total_tokens == input + output ⇒ 该来源 input 已含缓存
        usage: { input_tokens: 900, output_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 100, total_tokens: 1000 },
      },
      providerData: {
        messageId: "pm-1",
        requestModelName: "glm-4.6",
        usage: { input_tokens: 900, output_tokens: 100 }, // 镜像字段仅补全，不重复累计
      },
    };
    writeJsonl(path.join(dir, "proj", "s1.jsonl"), [item, item]); // 同会话同 messageId 同刻 → 去重一次
    const cache = {};
    const r = all(scanWorkbuddy(bounds(), cache));
    expect(r.in).toBe(200); // 900 - 600 - 100
    expect(r.cr).toBe(600);
    expect(r.cw).toBe(100);
    expect(r.out).toBe(100);
    expect(r.reason).toBe(0); // thinking 已含在 output
    expect(r.sessions).toBe(1);
    // workbuddy_ai 独立键：另一目录无日志不影响 workbuddy 的缓存
    const ai = all(scanWorkbuddyAi(bounds(), cache));
    expect(ai.in).toBe(0);
  });

  it("账本回补（逐会话来源）：删掉一个会话的日志，那天的贡献按来源补回，会话数只认现存日志", () => {
    const dir = mkTmp();
    process.env.TOKEI_WORKBUDDY_DIR = dir;
    const record = (sessionId: string, messageId: string, input: number) => ({
      id: `e-${messageId}`,
      sessionId,
      cwd: "C:/work/wb",
      timestamp: "2026-09-15T08:00:00Z",
      message: {
        role: "assistant",
        model: "glm-4.6",
        usage: { input_tokens: input, output_tokens: 100, cache_read_input_tokens: 600,
          cache_creation_input_tokens: 100, total_tokens: input + 100 },
      },
    });
    writeJsonl(path.join(dir, "proj", "a.jsonl"), [record("wb-a", "pm-a", 900)]);
    const fileB = path.join(dir, "proj", "b.jsonl");
    writeJsonl(fileB, [record("wb-b", "pm-b", 1500)]);
    const first = all(scanWorkbuddy(bounds(), {}));
    expect(first.in).toBe(200 + 800); // (900-600-100) + (1500-600-100)
    expect(first.sessions).toBe(2);

    ledgerFlush(); // compute() 末尾的落盘，测试里手动触发一次
    fs.rmSync(fileB);
    const again = all(scanWorkbuddy(bounds(), {}));
    // 来源级合并：账本里缺席的 wb-b 那份原样保留（不是整天取 max，所以不会重复计数）
    expect(again.in).toBe(first.in);
    expect(again.cr).toBe(first.cr);
    expect(again.cw).toBe(first.cw);
    expect(again.out).toBe(first.out);
    // 会话是实时归属，被清的会话无从再认
    expect(again.sessions).toBe(1);
  });
});

describe("codebuddy collector", () => {
  it("input = prompt 总量 - cache_read - prompt_cache_write；sessionId+messageId 去重而非 requestId；Credit 不折美元", () => {
    const dir = mkTmp();
    process.env.TOKEI_CODEBUDDY_DIR = dir;
    const call = (messageId: string | null, entryId: string, requestId: string, tokens: Record<string, number>, credit: number) => ({
      id: entryId,
      sessionId: "cb-1",
      cwd: "C:/work/cb",
      timestamp: "2026-09-15T08:00:00Z",
      message: { role: "assistant" },
      providerData: {
        messageId,
        conversationRequestId: requestId, // 只关联轮次，绝不做去重键
        requestModelId: "hunyuan-hurricane", // 无精确目录价 → 美元保持 0
        rawUsage: {
          prompt_tokens: tokens.in, completion_tokens: tokens.out,
          cache_read_input_tokens: tokens.cr, prompt_cache_write_tokens: tokens.cw,
          credit,
        },
      },
    });
    const main = call("m-1", "e-1", "req-A", { in: 1000, out: 50, cr: 600, cw: 100 }, 2.5);
    const second = call("m-2", "e-2", "req-A", { in: 400, out: 20, cr: 100, cw: 0 }, 1.5); // 同 requestId 不同 messageId → 都算
    writeJsonl(path.join(dir, "cb-1.jsonl"), [main, second]);
    // subagents 副本：同 sessionId+messageId → 只计一次；无 messageId 回退 entry id
    writeJsonl(path.join(dir, "subagents", "cb-1-sub.jsonl"), [
      main,
      call(null, "e-3", "req-B", { in: 200, out: 10, cr: 0, cw: 0 }, 1),
      call(null, "e-3", "req-C", { in: 200, out: 10, cr: 0, cw: 0 }, 1), // 同 entry id → 去重
    ]);
    // traces/logs 目录不是数据源
    writeJsonl(path.join(dir, "traces", "t.jsonl"), [call("m-9", "e-9", "req-D", { in: 5555, out: 5555, cr: 0, cw: 0 }, 9)]);
    const r = all(scanCodebuddy(bounds(), {}));
    expect(r.in).toBe(300 + 300 + 200); // (1000-600-100) + (400-100-0) + 200
    expect(r.cr).toBe(600 + 100);
    expect(r.cw).toBe(100);
    expect(r.out).toBe(50 + 20 + 10);
    expect(r.credits).toBeCloseTo(2.5 + 1.5 + 1, 10);
    expect(r.cost).toBe(0); // Credit 绝不换算美元，未知模型也不兜底估价
    expect(r.sessions).toBe(1);
  });
});

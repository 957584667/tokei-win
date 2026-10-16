/**
 * SQLite 采集器夹具测试：用 node:sqlite 造真库，经 TOKEI_* env 指到临时目录。
 * 覆盖：hermes v21 合并+去重 / opencode SQLite 优先于 legacy JSON /
 * openclaw 动态 agent 发现与模型名兜底链 / minimax 四桶并列与 turn_id 关联。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "node:module";
// vitest 环境里 node:sqlite 不能静态 import（vite 内置表没有它），与采集器同法
const { DatabaseSync } = createRequire(path.join(process.cwd(), "noop.cjs"))("node:sqlite") as typeof import("node:sqlite");
import { rangeBounds } from "../src/core/ranges";
import { useLedgerFile } from "../src/core/ledger";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-sqlite-test-"));
// 账本指到临时目录：zcode/minimax/devin 接入 ledger 后也绝不写 ~/.tokei。
// 每个用例一份：账本按「工具+日」做高水位，共用会让上一个用例入账的值盖住这一个用例
let ledgerSeq = 0;
beforeEach(() => {
  useLedgerFile(path.join(ROOT, `ledger-${++ledgerSeq}.json`), path.join(ROOT, "config.json"));
});
const NOW_S = Math.floor(Date.now() / 1000);
const bounds = rangeBounds();

const savedEnv: Record<string, string | undefined> = {};
function setEnv(name: string, value: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}

function makeDb(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new DatabaseSync(file);
}

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch { /* Windows 句柄未释放时忽略 */ }
});

// ---------------- Hermes ----------------
describe("hermes v21 合并与去重", () => {
  const dir = path.join(ROOT, "hermes");
  it("合并 v21、按键去重取更大、明细缺失才回退汇总、成本优先 actual", async () => {
    setEnv("TOKEI_HERMES_DIR", dir);
    const db = makeDb(path.join(dir, "state.db"));
    db.exec(`
      CREATE TABLE sessions (id TEXT, started_at REAL, model TEXT, cwd TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        estimated_cost_usd REAL, actual_cost_usd REAL);
      CREATE TABLE session_model_usage_v21 (session_id TEXT, model TEXT,
        billing_provider TEXT, billing_base_url TEXT, billing_mode TEXT, task TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        estimated_cost_usd REAL, actual_cost_usd REAL, first_seen REAL, last_seen REAL);
      CREATE TABLE session_model_usage (session_id TEXT, model TEXT,
        billing_provider TEXT, billing_base_url TEXT, billing_mode TEXT, task TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        estimated_cost_usd REAL, actual_cost_usd REAL, first_seen REAL, last_seen REAL);
    `);
    db.prepare(`INSERT INTO sessions VALUES
      ('s1', ?, 'claude-opus-4-8', '', 9, 9, 0, 0, 0, 0.1, NULL),
      ('s2', ?, 'unknown-model-x', '', 7, 3, 2, 1, 0, 0.4, NULL)`
    ).run(NOW_S, NOW_S);
    // s1 主循环行：v21 与 v22 同键并存，去重保留更大的一行
    const usageCols = 15;
    const insV21 = db.prepare(`INSERT INTO session_model_usage_v21 VALUES (${Array(usageCols).fill("?").join(",")})`);
    insV21.run("s1", "claude-opus-4-8", "anthropic", "https://a", "api", "", 100, 10, 0, 0, 0, 0.5, 0.7, NOW_S, NOW_S);
    insV21.run("s1", "claude-opus-4-8", "anthropic", "https://a", "api", "", 1, 1, 0, 0, 0, 0.0, null, NOW_S, NOW_S); // 升级中断遗留的旧小值
    insV21.run("s1", "claude-opus-4-8", "anthropic", "https://a", "api", "title", 5, 2, 0, 0, 0, 0.02, null, NOW_S, NOW_S); // v21 独有辅助调用
    const insV22 = db.prepare(`INSERT INTO session_model_usage VALUES (${Array(usageCols).fill("?").join(",")})`);
    insV22.run("s1", "claude-opus-4-8", "anthropic", "https://a", "api", "", 200, 20, 30, 4, 6, 0.5, 0.7, NOW_S, NOW_S); // 同键更大 → 替换
    db.close();

    const { scanHermes } = await import("../src/collectors/hermes");
    const cache: Record<string, any> = {};
    const out = scanHermes(bounds, cache);
    const today = out.ranges.today;
    // s1 = 200+20+30+4+6 (去重后新表行) + 5+2 (v21 独有 task 行)；s2 回退汇总 7+3+2+1
    expect(today.in).toBe(200 + 5 + 7);
    expect(today.out).toBe(20 + 2 + 3);
    expect(today.cr).toBe(30 + 2);
    expect(today.cw).toBe(4 + 1);
    expect(today.reason).toBe(6);
    // 成本：s1 用 actual 0.7（一次，去重生效）+ title 0.02；s2 estimated 0.4
    expect(today.cost).toBeCloseTo(0.7 + 0.02 + 0.4, 9);
    // 会话数只来自 sessions 可见行
    expect(today.sessions).toBe(2);
    const models = Object.fromEntries(today.models.map((m: any) => [m.model_id, m]));
    expect(models["anthropic/claude-opus-4.8"].in).toBe(205);
    expect(models["unknown-model-x"].in).toBe(7); // 未知模型保留原名
  });
});

// ---------------- OpenCode ----------------
describe("opencode SQLite 优先于 legacy JSON", () => {
  const dir = path.join(ROOT, "opencode");
  it("同 id 消息不重计，仅 JSON 存在的消息补上", async () => {
    setEnv("OPENCODE_DATA_DIR", dir);
    const dbFile = path.join(dir, "opencode.db");
    const db = makeDb(dbFile);
    db.exec(`CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)`);
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(
      "msg_1", "ses_1", NOW_S * 1000,
      JSON.stringify({
        role: "assistant", modelID: "gpt-5", cost: 0.01,
        tokens: { input: 100, output: 5, reasoning: 2, cache: { read: 10, write: 3 } },
        time: { created: NOW_S * 1000 }, sessionID: "ses_1",
      }),
    );
    db.close();

    const legacy = path.join(dir, "storage", "message");
    fs.mkdirSync(path.join(legacy, "ses_old"), { recursive: true });
    // 与库里同 id：必须被 SQLite 记录压制，不重计
    fs.writeFileSync(path.join(legacy, "ses_old", "msg_1.json"), JSON.stringify({
      id: "msg_1", role: "assistant", modelID: "gpt-5", cost: 9.99,
      tokens: { input: 100, output: 5, cache: {} }, time: { created: NOW_S * 1000 },
    }));
    // 仅 JSON 存在的旧消息：应补上
    fs.writeFileSync(path.join(legacy, "ses_old", "msg_2.json"), JSON.stringify({
      id: "msg_2", role: "assistant", modelID: "gpt-5", cost: 0.002,
      tokens: { input: 40, output: 8, cache: { read: 4 } }, time: { created: NOW_S * 1000 },
      sessionID: "ses_2",
    }));

    const { scanOpencode } = await import("../src/collectors/opencode");
    const out = scanOpencode(bounds, {});
    const today = out.ranges.today;
    expect(today.in).toBe(100 + 40);
    expect(today.out).toBe(5 + 8);
    expect(today.cr).toBe(10 + 4);
    expect(today.cw).toBe(3);
    expect(today.reason).toBe(2);
    expect(today.cost).toBeCloseTo(0.01 + 0.002, 9); // msg_1 的 JSON 副本 cost 9.99 未被采用
    expect(today.sessions).toBe(2);
  });
});

// ---------------- OpenClaw ----------------
describe("openclaw 动态发现与模型兜底链", () => {
  const dir = path.join(ROOT, "openclaw");
  it("agent_databases 相对路径发现、responseModel→model→session_windows、未知不借价、同会话取更完整副本、任务计数", async () => {
    setEnv("OPENCLAW_STATE_DIR", dir);
    // 全局库：注册表用相对路径（相对 state 目录），另带 task_runs
    const state = path.join(dir, "state");
    const regDb = makeDb(path.join(state, "openclaw.sqlite"));
    regDb.exec(`
      CREATE TABLE agent_databases (path TEXT);
      CREATE TABLE task_runs (status TEXT, created_at INTEGER);
    `);
    regDb.prepare("INSERT INTO agent_databases VALUES (?)").run("agents/alpha/openclaw-agent.sqlite");
    regDb.prepare("INSERT INTO task_runs VALUES (?, ?)").run("completed", NOW_S * 1000);
    regDb.prepare("INSERT INTO task_runs VALUES (?, ?)").run("succeeded", NOW_S * 1000);
    regDb.prepare("INSERT INTO task_runs VALUES (?, ?)").run("failed", NOW_S * 1000);
    regDb.close();

    fs.mkdirSync(path.join(dir, "agents", "alpha"), { recursive: true });
    fs.mkdirSync(path.join(dir, "agents", "beta", "sessions"), { recursive: true });
    const agentDb = makeDb(path.join(dir, "agents", "alpha", "openclaw-agent.sqlite"));
    agentDb.exec(`
      CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER);
      CREATE TABLE session_windows (session_id TEXT, model TEXT);
    `);
    agentDb.prepare("INSERT INTO session_windows VALUES (?, ?)").run("ses_w", "gpt-5");
    const ev = (o: unknown) => JSON.stringify(o);
    // 1) responseModel 优先；权威 cost
    agentDb.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run("ses_a", 1, ev({
      id: "e1", timestamp: NOW_S * 1000,
      message: { role: "assistant", responseModel: "claude-opus-4-8", model: "ignored",
        usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 1, reasoningTokens: 2, cost: { total: 0.02 } } },
    }), NOW_S * 1000);
    // 同一 id 重复行 → 去重
    agentDb.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run("ses_a", 2, ev({
      id: "e1", timestamp: NOW_S * 1000,
      message: { role: "assistant", responseModel: "claude-opus-4-8", usage: { input: 10, output: 5 } },
    }), NOW_S * 1000);
    // 2) 无 id 完全相同原文 → 哈希去重；模型走 message.model
    const m2 = ev({
      timestamp: NOW_S * 1000,
      message: { role: "assistant", model: "claude-sonnet-4-6", usage: { input: 1, output: 1, cost: { total: 0.001 } } },
    });
    agentDb.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run("ses_a", 3, m2, NOW_S * 1000);
    agentDb.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run("ses_a", 4, m2, NOW_S * 1000);
    // 3) 无模型字段 → session_windows.model 兜底；未知 "my/model-zz" 无价 → 成本 0 不借价
    agentDb.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run("ses_w", 1, ev({
      id: "e3", timestamp: NOW_S * 1000,
      message: { role: "assistant", usage: { input: 8, output: 2 } },
    }), NOW_S * 1000);
    agentDb.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run("ses_w", 2, ev({
      id: "e4", timestamp: NOW_S * 1000,
      message: { role: "assistant", model: "mycompany/model-zz", usage: { input: 9, output: 3 } },
    }), NOW_S * 1000);
    // 非 usage / 非 assistant 事件不计
    agentDb.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run("ses_a", 5, ev({
      id: "e5", timestamp: NOW_S * 1000, message: { role: "user", content: "hi" },
    }), NOW_S * 1000);
    // 与 JSONL 同会话但更不完整的 SQLite 副本（对账应选 JSONL）
    agentDb.prepare("INSERT INTO transcript_events VALUES (?,?,?,?)").run("ses_b", 1, ev({
      id: "b-sqlite", timestamp: NOW_S * 1000,
      message: { role: "assistant", model: "gpt-5", usage: { input: 1, output: 1, cost: { total: 0.0001 } } },
    }), NOW_S * 1000);
    agentDb.close();

    fs.writeFileSync(path.join(dir, "agents", "beta", "sessions", "ses_b.jsonl"), [
      ev({ id: "ses_b", type: "session", sessionID: "ses_b" }),
      ev({ id: "b1", timestamp: NOW_S * 1000, message: { role: "assistant", model: "gpt-5", usage: { input: 70, output: 9, cacheRead: 5, cacheWrite: 0, cost: { total: 0.5 } } } }),
      ev({ id: "b2", timestamp: NOW_S * 1000, message: { role: "assistant", model: "gpt-5", usage: { input: 5, output: 2, cost: { total: 0.1 } } } }),
    ].join("\n") + "\n");
    // 轨迹日志必须被排除
    fs.writeFileSync(path.join(dir, "agents", "beta", "sessions", "ses_b.trajectory.jsonl"),
      ev({ id: "t1", timestamp: NOW_S * 1000, message: { role: "assistant", model: "gpt-5", usage: { input: 9999, output: 9999 } } }) + "\n");

    const { scanOpenClaw, openclawAgentDbPaths } = await import("../src/collectors/openclaw");
    const discovered = openclawAgentDbPaths();
    expect(discovered.ok).toBe(true);
    expect(discovered.paths.length).toBe(1);
    expect(discovered.paths[0].replace(/\\/g, "/")).toContain("agents/alpha/openclaw-agent.sqlite");

    const out = scanOpenClaw(bounds, {});
    const today = out.ranges.today;
    expect(today.tasks).toBe(3);
    expect(today.completed).toBe(2);
    expect(today.failed).toBe(1);
    // ses_a: 10+5+3+1 + 1+1; ses_w: 8+2 + 9+3; ses_b: 取 JSONL 完整副本 70+9+5 + 5+2（SQLite 的 1+1 不再重复）
    expect(today.in).toBe(10 + 1 + 8 + 9 + 70 + 5);
    expect(today.out).toBe(5 + 1 + 2 + 3 + 9 + 2);
    expect(today.cr).toBe(3 + 0 + 0 + 0 + 5 + 0);
    expect(today.sessions).toBe(3);
    const models = Object.fromEntries(today.models.map((m: any) => [m.model_id, m]));
    expect(models["mycompany/model-zz"].cost).toBe(0); // 未知模型保留原名且不借价
    expect(models["gpt-5"].in).toBe(8 + 75); // session_windows 兜底 + 会话对账取 JSONL 完整副本
    expect(today.cost).toBeCloseTo(0.02 + 0.001 + 0.5 + 0.1, 9);
  });
});

// ---------------- MiniMax ----------------
describe("minimax 四桶并列与 turn_id 关联", () => {
  const dir = path.join(ROOT, "minimax");
  const dbFile = path.join(dir, "sqlite", "runtime-state.sqlite");
  it("四桶直加、reasoning 以 raw.totalTokens 校验、日志轮转后模型不丢", async () => {
    setEnv("TOKEI_MINIMAX_DB", dbFile);
    const db = makeDb(dbFile);
    db.exec(`
      CREATE TABLE local_runtime_token_usage (id INTEGER PRIMARY KEY, session_id TEXT, turn_id TEXT,
        model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, raw TEXT);
    `);
    const ins = db.prepare("INSERT INTO local_runtime_token_usage VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    // r1 四桶并列：100/20/300/50，绝不相减
    ins.run(1, "s1", "t1", null, NOW_S, 100, 20, 0, 300, 50, JSON.stringify({ totalTokens: 470 }));
    // r2 reasoning 与 totalTokens 对得上 → 计入
    ins.run(2, "s1", "t2", null, NOW_S, 10, 5, 4, 2, 1, JSON.stringify({ totalTokens: 22 }));
    // r3 reasoning 对不上（total 少 4）→ 丢弃该桶宁少勿重
    ins.run(3, "s1", "t3", null, NOW_S, 3, 1, 4, 0, 0, JSON.stringify({ totalTokens: 4 }));
    db.close();

    const logDir = path.join(dir, "observability", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "runtime-2026-01-01.log"), [
      `INFO llm_response_identifiers {"session_id":"s1","turn_id":"t1","model":"MiniMax-M3"}`,
      `INFO llm_response_identifiers {"session_id":"s1","turn_id":"t2","model":"MiniMax-M3"}`,
      `INFO llm_response_identifiers {"session_id":"s1","turn_id":"t3","model":"MiniMax-M3"}`,
    ].join("\n") + "\n");

    const { scanMinimax } = await import("../src/collectors/minimax");
    const cache: Record<string, any> = {};
    const first = scanMinimax(bounds, cache).ranges.today;
    expect(first.in).toBe(100 + 10 + 3);
    expect(first.out).toBe(20 + 5 + 1);
    expect(first.cr).toBe(300 + 2);
    expect(first.cw).toBe(50 + 1);
    expect(first.reason).toBe(4); // 仅 r2 通过校验
    expect(first.sessions).toBe(1);
    expect(first.models[0].model_id).toBe("MiniMax-M3"); // turn_id 关联到模型名

    // 日志轮转删除后强制重扫：模型必须来自缓存 runs 而非日志
    fs.rmSync(path.join(logDir, "runtime-2026-01-01.log"));
    const db2 = new DatabaseSync(dbFile);
    db2.prepare("INSERT INTO local_runtime_token_usage VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      4, "s1", "t4", null, NOW_S, 1, 1, 0, 0, 0, JSON.stringify({ totalTokens: 2 }));
    db2.close();
    const second = scanMinimax(bounds, cache).ranges.today;
    expect(second.in).toBe(100 + 10 + 3 + 1);
    expect(new Set(second.models.map((m: any) => m.model_id))).toEqual(new Set(["MiniMax-M3"]));
    // r4 无日志证据，靠会话众数兜底也归到 MiniMax-M3
  });
});

// ---------------- zcode / devin 冒烟 ----------------
describe("zcode 与 devin 基本口径", () => {
  it("zcode 减出 fresh input 与 visible output", async () => {
    const file = path.join(ROOT, "zcode", "db.sqlite");
    setEnv("TOKEI_ZCODE_DB", file);
    const db = makeDb(file);
    db.exec(`CREATE TABLE model_usage (id TEXT, session_id TEXT, model_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
      started_at INTEGER, completed_at INTEGER)`);
    db.prepare("INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?)").run(
      "u1", "sess_1", "GLM-5.3", 1000, 100, 30, 200, 500, NOW_S * 1000, NOW_S * 1000);
    db.close();
    const { scanZcode } = await import("../src/collectors/zcode");
    const today = scanZcode(bounds, {}).ranges.today;
    expect(today.in).toBe(1000 - 500 - 200);
    expect(today.out).toBe(100 - 30);
    expect(today.cr).toBe(500);
    expect(today.cw).toBe(200);
    expect(today.reason).toBe(30);
    expect(today.sessions).toBe(1);
  });

  it("devin 四桶并列不相减、兄弟节点去重", async () => {
    const file = path.join(ROOT, "devin", "sessions.db");
    setEnv("TOKEI_DEVIN_CLI_DB", file);
    const db = makeDb(file);
    db.exec(`CREATE TABLE sessions (id TEXT, model TEXT, working_directory TEXT);
             CREATE TABLE message_nodes (session_id TEXT, node_id TEXT, chat_message TEXT, created_at INTEGER)`);
    const msg = JSON.stringify({
      role: "assistant",
      metadata: { generation_model: "claude-opus-4-8", created_at: NOW_S,
        metrics: { input_tokens: 11486, output_tokens: 254, cache_read_tokens: 6450, cache_creation_tokens: 800 } },
    });
    db.prepare("INSERT INTO message_nodes VALUES (?,?,?,?)").run("s1", "n1", msg, NOW_S);
    db.prepare("INSERT INTO message_nodes VALUES (?,?,?,?)").run("s1", "n2", msg, NOW_S); // 兄弟节点重复
    db.close();
    const { scanDevin } = await import("../src/collectors/devin");
    const today = scanDevin(bounds, {}).ranges.today;
    expect(today.in).toBe(11486); // input 不与缓存相减
    expect(today.out).toBe(254);
    expect(today.cr).toBe(6450);
    expect(today.cw).toBe(800);
    expect(today.sessions).toBe(1);
  });
});

beforeAll(() => { /* env 在 each case 里设置 */ });

/**
 * Qoder 家族采集器单测：临时目录 + TOKEI_* env 注入（与 test_windows_paths.py 同口径）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "node:module";
import { rangeBounds } from "../src/core/ranges";
import { estTokens, scanQoderCli, scanQoderCliCn } from "../src/collectors/qodercli";
import { scanQoderDesktop, emptyQoderDesktop } from "../src/collectors/qoderdesktop";
import { scanQoderWork, qoderWorkLogPath, scanQoderWorkQuota } from "../src/collectors/qoderwork";
import { useLedgerFile } from "../src/core/ledger";

// 与采集器同款绕法：node:sqlite 是 Node 22 实验内置模块，vite 静态解析不支持
const { DatabaseSync } = createRequire(path.join(process.cwd(), "noop.cjs"))("node:sqlite") as typeof import("node:sqlite");

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["TOKEI_QODERCLI_DIR", "TOKEI_QODERCLI_CN_DIR", "TOKEI_QODER_IDE_DB",
  "TOKEI_QODER_IDE_ENABLED", "TOKEI_QODER_DB", "TOKEI_QODERWORK_LOG"];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-qoder-"));
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

// 固定的「现在」：2025-05-14（周三），本周起点 05-12，上周 05-05~05-12
const NOW = new Date(2025, 4, 14, 18, 0, 0);

function writeJsonl(file: string, rows: Array<Record<string, unknown>>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

describe("qodercli estTokens（文本→token 估算器）", () => {
  it("CJK≈1、其余≈1/4，按码点计数且确定", () => {
    expect(estTokens("")).toBe(0);
    expect(estTokens("abcd")).toBe(1);
    expect(estTokens("你好")).toBe(2);
    expect(estTokens("hello 世界")).toBe(2 + 6 / 4);
    // 😀 是代理对：Python len() 按码点=2，length 会是 3
    expect(estTokens("\u{1F600}a")).toBe(Array.from("\u{1F600}a").length / 4);
    const text = "混合 mixed 文本 with tokens";
    expect(estTokens(text)).toBe(estTokens(text));
  });
});

describe("qodercli / qodercli_cn JSONL 扫描", () => {
  function fixture() {
    const root = path.join(tmp, "projects");
    process.env.TOKEI_QODERCLI_CN_DIR = root;
    // 主会话：1 个纯 Credits 请求 + 1 个带 token 请求（含跨行去重）
    writeJsonl(path.join(root, "projA", "s1.jsonl"), [
      { type: "runtime-config", model: "auto" },
      { type: "user", timestamp: "2025-05-14T10:00:00", message: { content: "hello 世界" } },
      { type: "assistant", timestamp: "2025-05-14T10:00:10",
        message: { id: "m1", usage: { request_id: "r1", input_tokens: 0, output_tokens: 0, credits: 1.5 } } },
      { type: "assistant", timestamp: "2025-05-14T10:00:20",
        message: { id: "m2", model: "qoder-max", usage: {
          request_id: "r2", input_tokens: 1000, cache_read_input_tokens: 400,
          cache_creation_input_tokens: 100, output_tokens: 50, credits: 0.2 },
        content: [
          { type: "tool_use", id: "t1", input: { path: "x" } },
          { type: "text", text: "abcd" },
        ] } },
      // 同一 request_id 的重复落盘：calls/tools 合并但只算一次请求
      { type: "assistant", timestamp: "2025-05-14T10:00:25",
        message: { id: "m2b", usage: { request_id: "r2" },
          content: [{ type: "tool_use", id: "t2", input: {} }] } },
      { type: "user", isMeta: true, timestamp: "2025-05-14T10:00:30", message: { content: "系统提示不进 turns" } },
    ]);
    // 上周的会话：只进 last_week/month/year/all
    writeJsonl(path.join(root, "projA", "s2.jsonl"), [
      { type: "user", timestamp: "2025-05-05T09:00:00", message: { content: "你好" } },
    ]);
    // 子代理：计 sub_agents，不计 sessions
    writeJsonl(path.join(root, "projA", "sess-uuid", "subagents", "a1.jsonl"), [
      { type: "assistant", timestamp: "2025-05-14T11:00:00",
        message: { id: "m9", model: "qoder-sub", usage: { request_id: "r3", input_tokens: 10, credits: 0.5 } } },
    ]);
    return root;
  }

  it("会话/请求/工具/Credits/估算 与区间分桶", () => {
    fixture();
    const bounds = rangeBounds(NOW);
    const cache: Record<string, any> = {};
    const out = scanQoderCli(bounds, cache, "qodercli_cn");
    const t = out.ranges.today;
    expect(t.sessions).toBe(1);
    expect(t.sub_agents).toBe(1);
    expect(t.calls).toBe(3);        // r1+r2(去重后)+r3
    expect(t.usage_calls).toBe(2);  // 仅 r2、r3 落了 token
    expect(t.usage_available).toBe(true);
    expect(t.tools).toBe(2);        // t1+t2 并入同一请求
    expect(t.turns).toBe(1);        // isMeta 不算用户轮次
    expect(t.in).toBe(510);         // (1000-400-100) + r3 的 10：子代理请求同样计入用量
    expect(t.out).toBe(50);
    expect(t.cr).toBe(400);
    expect(t.cw).toBe(100);
    expect(t.duration).toBe(30_000); // 相邻事件间隔 ≤300s 计入活跃时长
    expect(t.credits).toBeCloseTo(2.2, 6);
    // est = int(请求侧 4) + int(用户文本 3.5) → 7；纯请求估算与文本估算分别截断
    expect(t.est).toBe(7);

    const w = out.ranges.week;
    expect(w.sessions).toBe(1);
    expect(out.ranges.last_week.sessions).toBe(1);
    expect(out.ranges.month.sessions).toBe(2);
    expect(out.ranges.all.sessions).toBe(2);
    expect(out.ranges.all.turns).toBe(2);
    expect(out.ranges.all.in).toBe(510);
    expect(out.ranges.all.est).toBe(9); // today 7 + s2 的 int(2.0)
    expect(out.ranges.month.credits).toBeCloseTo(2.2, 6);

    // 内置路由不落 token 时只记 Credits：r1 的 auto 行零 token 有 credits
    const auto = t.models.find((m: any) => m.name === "Auto" || m.model_id === "auto");
    expect(auto).toBeTruthy();
    expect(auto.in + auto.out + auto.cr + auto.cw).toBe(0);
    expect(auto.credits).toBeCloseTo(1.5, 6);
    expect(typeof out.model).toBe("string");
  });

  it("缓存命中不重扫且结果确定；CN 与 CLI 缓存互不串数", () => {
    fixture();
    const bounds = rangeBounds(NOW);
    const cache: Record<string, any> = {};
    const first = scanQoderCli(bounds, cache, "qodercli_cn");
    const again = scanQoderCli(bounds, cache, "qodercli_cn");
    expect(again.ranges.today).toEqual(first.ranges.today);
    expect(cache.qodercli_cn._requests.r2.tools).toEqual(["t1", "t2"]);
    expect(cache.qodercli).toBeUndefined(); // CN 独立缓存键
    // 工厂版与 tool 参数版一致
    const viaFactory = scanQoderCliCn(bounds, {});
    expect(viaFactory.ranges.all).toEqual(first.ranges.all);
    // CLI 指向同一目录时数字一致但账本独立
    process.env.TOKEI_QODERCLI_DIR = process.env.TOKEI_QODERCLI_CN_DIR;
    const cli = scanQoderCli(bounds, cache, "qodercli");
    expect(cli.ranges.today).toEqual(first.ranges.today);
    expect(Object.keys(cache)).toContain("qodercli");
  });
});

describe("qoderdesktop local.db（chat_message，只读 SQLite）", () => {
  function fixtureDb(): string {
    const dbFile = path.join(tmp, "local.db");
    const db = new DatabaseSync(dbFile);
    db.exec(`
      CREATE TABLE chat_session(session_id TEXT, session_type TEXT);
      CREATE TABLE chat_message(request_id TEXT, session_id TEXT, gmt_create INTEGER,
                                token_info TEXT, model_info TEXT);
      INSERT INTO chat_session VALUES('s1','agent'),('s2','agent_sub_explore');
    `);
    const t0 = new Date(2025, 4, 14, 12, 0, 0).getTime();
    const ins = db.prepare("INSERT INTO chat_message VALUES(?,?,?,?,?)");
    ins.run("req1", "s1", t0, JSON.stringify({ prompt_tokens: 1000, completion_tokens: 200, cached_tokens: 400 }), JSON.stringify({ model_key: "gpt-lite" }));
    ins.run("req1", "s1", t0 + 5000, "", ""); // 无 token_info 的伴随消息：只用于时长跨度
    ins.run("req2", "s2", t0 + 60000, JSON.stringify({ prompt_tokens: 100, completion_tokens: 10, cached_tokens: 0 }), JSON.stringify({ model_key: "gpt-x" }));
    db.close();
    return dbFile;
  }

  it("默认关闭：无 qoder_ide_enabled 时返回空且不落缓存", () => {
    const dbFile = fixtureDb();
    process.env.TOKEI_QODER_IDE_DB = dbFile;
    process.env.TOKEI_QODER_IDE_ENABLED = "0"; // 显式关闭，避免受真实 ~/.tokei/config.json 影响
    const cache: Record<string, any> = {};
    const out = scanQoderDesktop(rangeBounds(NOW), cache);
    expect(out).toEqual(emptyQoderDesktop());
    expect(cache.qoder_ide).toEqual({});
  });

  it("token/calls/messages/sessions/sub_agents/duration/model 口径", () => {
    const dbFile = fixtureDb();
    process.env.TOKEI_QODER_IDE_DB = dbFile;
    process.env.TOKEI_QODER_IDE_ENABLED = "1";
    const bounds = rangeBounds(NOW);
    const cache: Record<string, any> = {};
    const out = scanQoderDesktop(bounds, cache);
    const t = out.ranges.today;
    // cached 是 prompt 的子集：输入展示非缓存部分（CALCULATION.md：token 目前多为 0，仍照实查询）
    expect(t.in).toBe(700);  // 1100 - 400
    expect(t.out).toBe(210);
    expect(t.cached).toBe(400);
    expect(t.ctx).toBeCloseTo((400 / 1100) * 100, 6);
    expect(t.calls).toBe(2);      // distinct request_id（空 token_info 行不计）
    expect(t.messages).toBe(2);
    expect(t.sessions).toBe(1);
    expect(t.sub_agents).toBe(1); // session_type LIKE 'agent_sub_%'
    expect(t.duration).toBe(5);   // req1 首尾跨度 5000ms → 秒
    expect(t.model ?? out.model).toBe("gpt-x");
    expect(out.model).toBe("gpt-x");
    expect(cache.qoder_ide.data.days["2025-05-14"].hours[12]).toBe(1310);
  });

  it("只读打开：db 文件标为只读仍能扫描，且不产生 WAL/修改", () => {
    const dbFile = fixtureDb();
    const before = fs.readFileSync(dbFile);
    fs.chmodSync(dbFile, 0o444);
    try {
      process.env.TOKEI_QODER_IDE_DB = dbFile;
      process.env.TOKEI_QODER_IDE_ENABLED = "true";
      const out = scanQoderDesktop(rangeBounds(NOW), {});
      expect(out.ranges.today.messages).toBe(2);
    } finally {
      fs.chmodSync(dbFile, 0o666);
    }
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(fs.existsSync(`${dbFile}-wal`)).toBe(false);
  });
});

describe("qoderwork agents.db + main.log userQuota", () => {
  function fixtureDb(): string {
    const dbFile = path.join(tmp, "agents.db");
    const db = new DatabaseSync(dbFile);
    db.exec(`
      CREATE TABLE messages(chat_id TEXT, role TEXT, metadata TEXT, created_at INTEGER);
      CREATE TABLE sub_chats(created_at INTEGER, ext TEXT);
      CREATE TABLE app_settings(key TEXT, value TEXT);
    `);
    const noon = Math.floor(new Date(2025, 4, 14, 12, 0, 0).getTime() / 1000);
    const ins = db.prepare("INSERT INTO messages VALUES(?,?,?,?)");
    ins.run("c1", "assistant", JSON.stringify({ inputTokens: 0, outputTokens: 0, durationMs: 5000, numTurns: 2 }), noon);
    ins.run("c2", "assistant", JSON.stringify({ durationMs: 1500 }), noon + 60);
    ins.run("c2", "user", JSON.stringify({ durationMs: 999 }), noon + 90);   // user 行必须被排除
    ins.run("c3", "assistant", "{}", noon + 100);                             // 空 metadata 排除
    const sub = db.prepare("INSERT INTO sub_chats VALUES(?,?)");
    sub.run(noon, JSON.stringify({ contextUsageSnapshot: { percentage: 40 } }));
    sub.run(noon, "{}");
    db.prepare("INSERT INTO app_settings VALUES('modelLevel','\"auto\"')").run();
    db.close();
    return dbFile;
  }

  it("calls/sessions/duration/turns/sub_agents/ctx 口径（inputTokens 目前为 0，不估算）", () => {
    const dbFile = fixtureDb();
    const logFile = path.join(tmp, "main.log");
    fs.writeFileSync(logFile, [
      '[info] startup',
      '[info] quota {"userQuota":{"totalCredits":300,"usedCredits":123.5,"isQuotaExceeded":false}}',
      '[info] later {"userQuota":{"totalCredits":300,"usedCredits":130,"isQuotaExceeded":false}}',
    ].join("\n"), "utf8");
    process.env.TOKEI_QODER_DB = dbFile;
    process.env.TOKEI_QODERWORK_LOG = logFile;
    const found = qoderWorkLogPath();
    expect(found && path.basename(found)).toBe("main.log");

    const bounds = rangeBounds(NOW);
    const cache: Record<string, any> = {};
    const out = scanQoderWork(bounds, cache);
    const t = out.ranges.today;
    expect(t.calls).toBe(2);
    expect(t.sessions).toBe(2);
    expect(t.in).toBe(0);
    expect(t.out).toBe(0);
    expect(t.duration).toBe(6500);
    expect(t.turns).toBe(2);
    expect(t.sub_agents).toBe(2);
    // 忠实镜像 Python：ctx_sum/ctx_count*100（percentage 已是百分数，双缩放为上游既有口径）
    expect(t.ctx).toBeCloseTo((40 * 2) / 2 * 100, 6);
    expect(out.model).toBe("auto");
    expect(t.ctx).toBe(out.ranges.all.ctx);
    expect(out.ranges.yesterday.calls).toBe(0);
  });

  it("main.log userQuota 取最后一条；缺字段容忍", () => {
    const logFile = path.join(tmp, "m", "main.log");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '{"userQuota":{"totalCredits":10,"usedCredits":1}}\nnot json\n', "utf8");
    const q = scanQoderWorkQuota(logFile);
    expect(q).toEqual({ totalCredits: 10, usedCredits: 1, isQuotaExceeded: false });
    fs.writeFileSync(logFile, '[info] nothing here\n');
    expect(scanQoderWorkQuota(logFile)).toBeNull();
  });

  it("只读打开 agents.db：文件只读时扫描成功且内容不变", () => {
    const dbFile = fixtureDb();
    const before = fs.readFileSync(dbFile);
    fs.chmodSync(dbFile, 0o444);
    try {
      process.env.TOKEI_QODER_DB = dbFile;
      const out = scanQoderWork(rangeBounds(NOW), {});
      expect(out.ranges.today.calls).toBe(2);
    } finally {
      fs.chmodSync(dbFile, 0o666);
    }
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(fs.existsSync(`${dbFile}-wal`)).toBe(false);
  });
});

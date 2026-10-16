/**
 * 按天×按项目桶（usage.30s.py 的 _PROJECT_DAY_SOURCES）夹具测试。
 * hermes / devin / opencode / mimocode / minimax 是「一个库里装着多个项目」的数据库型工具，
 * 逐项目用量必须写进 day.projects[绝对路径]，项目足迹页才有它们的行。
 * 盯四件事：哪个列才是项目目录、什么写法算绝对路径、桶里的总量口径、以及桶不改动 payload。
 *
 * 夹具里的 D:\work\... 依赖 win32 的 path.isAbsolute 语义（反斜杠与正斜杠都算绝对路径），
 * 所以整组用 maybe 包住：非 Windows 上跳过，而不是换成本机路径把判定测歪。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "node:module";
// vitest 环境里 node:sqlite 不能静态 import（vite 内置表没有它），与采集器同法
const { DatabaseSync } = createRequire(path.join(process.cwd(), "noop.cjs"))("node:sqlite") as typeof import("node:sqlite");
import { dayKey, rangeBounds } from "../src/core/ranges";
import { HOME } from "../src/core/paths";
import { PROJECT_BUCKETS_VERSION } from "../src/core/model";
import { projectContributions, projectTrail } from "../src/core/trail";
import { sqliteSignature } from "../src/collectors/zcode";
import { scanHermes } from "../src/collectors/hermes";
import { scanDevin } from "../src/collectors/devin";
import { scanOpencode } from "../src/collectors/opencode";
import { scanMimoCode } from "../src/collectors/mimocode";
import { scanMinimax } from "../src/collectors/minimax";
import { useLedgerFile } from "../src/core/ledger";

const maybe = process.platform === "win32" ? describe : describe.skip;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-buckets-test-"));
// 账本指到临时目录：devin/mimocode/minimax 接入 ledger 后也绝不写 ~/.tokei。
// 每个用例一份：账本按「工具+日」做高水位，共用会让上一个用例入账的值盖住这一个用例
let ledgerSeq = 0;
beforeEach(() => {
  useLedgerFile(path.join(ROOT, `ledger-${++ledgerSeq}.json`), path.join(ROOT, "config.json"));
});
const NOW_S = Math.floor(Date.now() / 1000);
const TODAY = dayKey(new Date(NOW_S * 1000));
const bounds = rangeBounds();

const HERMES_DB = path.join(ROOT, "hermes", "state.db");
const DEVIN_DB = path.join(ROOT, "devin", "sessions.db");
const OPENCODE_DB = path.join(ROOT, "opencode", "opencode.db");
const MIMOCODE_DB = path.join(ROOT, "mimocode", "mimocode.db");
const MINIMAX_DB = path.join(ROOT, "minimax", "v2", "sqlite", "runtime-state.sqlite");

const savedEnv: Record<string, string | undefined> = {};
function setEnv(name: string, value: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}

function open(rel: string): DatabaseSync {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new DatabaseSync(file);
}

/** 每个工具一份夹具库：项目路径故意用不同拼写，最后一组要看它们在足迹里合成同一行 */
function buildFixtures(): void {
  {
    const db = open("hermes/state.db");
    db.exec(`
      CREATE TABLE sessions (id TEXT, started_at REAL, model TEXT, cwd TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        estimated_cost_usd REAL, actual_cost_usd REAL);
    `);
    const ins = db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    ins.run("h_abs", NOW_S, "claude-opus-4-8", "D:\\work\\erp", 100, 10, 5, 2, 1, 0.2, null);
    ins.run("h_slash", NOW_S, "claude-opus-4-8", "D:/work/api", 3, 4, 0, 0, 0, 0.04, null);
    // 相对路径与空 cwd 都不算项目，但用量照旧计入总量
    ins.run("h_rel", NOW_S, "claude-opus-4-8", path.join("work", "relative"), 7, 3, 0, 0, 0, 0.03, null);
    ins.run("h_empty", NOW_S, "claude-opus-4-8", "", 1, 1, 0, 0, 0, 0.01, null);
    db.close();
  }
  {
    const db = open("devin/sessions.db");
    db.exec(`
      CREATE TABLE sessions (id TEXT, model TEXT, working_directory TEXT);
      CREATE TABLE message_nodes (session_id TEXT, node_id INTEGER, chat_message TEXT, created_at INTEGER);
    `);
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("d1", "gpt-5", "D:/work/erp");
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("d2", "totally-unknown-model", path.join("work", "relative"));
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("d3", "totally-unknown-model", "");
    // 消息不带 generation_model：模型从 sessions.model 兜底
    const node = (metrics: Record<string, number>) => JSON.stringify({
      role: "assistant", metadata: { created_at: NOW_S, metrics },
    });
    const ins = db.prepare("INSERT INTO message_nodes VALUES (?,?,?,?)");
    ins.run("d1", 1, node({ input_tokens: 50, output_tokens: 7, cache_read_tokens: 3, cache_creation_tokens: 2 }), NOW_S);
    ins.run("d2", 2, node({ input_tokens: 900, output_tokens: 900, cache_read_tokens: 900, cache_creation_tokens: 900 }), NOW_S);
    ins.run("d3", 3, node({ input_tokens: 5, output_tokens: 5 }), NOW_S);
    db.close();
  }
  {
    const db = open("opencode/opencode.db");
    db.exec(`
      CREATE TABLE session (id TEXT, directory TEXT);
      CREATE TABLE session_v2 (id TEXT, directory TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    db.prepare("INSERT INTO session VALUES (?,?)").run("ses_a", "D:\\work\\erp");
    // 同一 id 两张表都登记：与 Python 的 setdefault 同规则，先查的 session 表赢
    db.prepare("INSERT INTO session_v2 VALUES (?,?)").run("ses_a", "D:/ignored-by-session");
    db.prepare("INSERT INTO session_v2 VALUES (?,?)").run("ses_b", "/tmp/posix-project");
    const msg = (o: Record<string, any>) => JSON.stringify({
      role: "assistant", time: { created: NOW_S * 1000 }, ...o,
    });
    const ins = db.prepare("INSERT INTO message VALUES (?,?,?,?)");
    ins.run("msg_1", "ses_a", NOW_S * 1000, msg({
      sessionID: "ses_a", modelID: "gpt-5", cost: 0.01,
      tokens: { input: 100, output: 5, reasoning: 2, cache: { read: 10, write: 3 } },
    }));
    ins.run("msg_2", "ses_b", NOW_S * 1000, msg({
      sessionID: "ses_b", modelID: "totally-unknown-model",
      tokens: { input: 40, output: 8, cache: { read: 4 } },
    }));
    // 没登记目录的会话：有量，无桶
    ins.run("msg_3", "ses_d", NOW_S * 1000, msg({
      sessionID: "ses_d", modelID: "gpt-5", cost: 0.001, tokens: { input: 1, output: 1 },
    }));
    db.close();
  }
  {
    const db = open("mimocode/mimocode.db");
    db.exec(`
      CREATE TABLE session (id TEXT, directory TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    db.prepare("INSERT INTO session VALUES (?,?)").run("ses_m", "D:\\WORK\\erp");
    db.prepare("INSERT INTO message VALUES (?,?,?,?)").run("msg_m1", "ses_m", NOW_S * 1000, JSON.stringify({
      role: "assistant", sessionID: "ses_m", modelID: "gpt-5", cost: 0.002,
      tokens: { input: 10, output: 2, cache: { read: 5 } }, time: { created: NOW_S * 1000 },
    }));
    db.close();
  }
  {
    const db = open("minimax/v2/sqlite/runtime-state.sqlite");
    db.exec(`
      CREATE TABLE local_runtime_sessions (session_id TEXT, project_workspace_dir TEXT, is_default_workspace INTEGER);
      CREATE TABLE local_runtime_token_usage (
        id INTEGER PRIMARY KEY, session_id TEXT, turn_id TEXT, model TEXT, ts INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, raw TEXT);
    `);
    const insS = db.prepare("INSERT INTO local_runtime_sessions VALUES (?,?,?)");
    insS.run("m1", "D:\\work\\erp", 0);
    insS.run("m2", "D:\\work\\mm-default", 1); // 应用给每个会话开的临时 workspace
    insS.run("m3", path.join(HOME, ".minimax-agent-cn", "projects", "demo"), 0); // 应用自己管的目录
    insS.run("m4", path.join("work", "relative"), 0);
    const insU = db.prepare("INSERT INTO local_runtime_token_usage VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    // 只有 m1 能计价，所以当天成本全部来自它，正好用来对账桶里的成本
    insU.run(1, "m1", "t1", "claude-sonnet-4-6", NOW_S * 1000, 20, 4, 3, 6, 1, JSON.stringify({ totalTokens: 34 }));
    insU.run(2, "m2", "t2", "totally-unknown-model", NOW_S * 1000, 900, 900, 0, 0, 0, null);
    insU.run(3, "m3", "t3", "totally-unknown-model", NOW_S * 1000, 800, 800, 0, 0, 0, null);
    insU.run(4, "m4", "t4", "totally-unknown-model", NOW_S * 1000, 700, 700, 0, 0, 0, null);
    db.close();
  }
}

beforeAll(() => {
  setEnv("TOKEI_HERMES_DIR", path.join(ROOT, "hermes"));
  setEnv("TOKEI_DEVIN_CLI_DB", DEVIN_DB);
  setEnv("OPENCODE_DATA_DIR", path.join(ROOT, "opencode"));
  setEnv("TOKEI_MIMOCODE_DB", MIMOCODE_DB);
  setEnv("TOKEI_MINIMAX_DB", MINIMAX_DB);
  buildFixtures();
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch { /* Windows 句柄未释放时忽略 */ }
});

/** 数据库型工具的缓存都只有一个条目，取 values 免得把缓存键格式写死在断言里 */
function singleEntry(toolCache: Record<string, any>): Record<string, any> {
  const entries = Object.values(toolCache ?? {});
  expect(entries.length).toBe(1);
  return entries[0] as Record<string, any>;
}

function bucketOf(days: Record<string, any>, day: string, proj: string) {
  const target = days[day];
  expect(target, `day ${day}`).toBeTruthy();
  const bucket = target.projects?.[proj];
  expect(bucket, `bucket ${proj}`).toBeTruthy();
  return bucket as { tokens: number; cost: number; models: Record<string, number>; sessions: string[] };
}

maybe("hermes：sessions.cwd 才是项目", () => {
  it("绝对 cwd 成桶，桶带 token/成本/模型/会话；payload 只认日总量", () => {
    const cache: Record<string, any> = {};
    const out = scanHermes(bounds, cache);
    const entry = singleEntry(cache.hermes);
    expect(entry.projects_version).toBe(PROJECT_BUCKETS_VERSION);
    expect(Object.keys(entry.days[TODAY].projects).sort()).toEqual(["D:\\work\\erp", "D:/work/api"].sort());

    const erp = bucketOf(entry.days, TODAY, "D:\\work\\erp");
    expect(erp.tokens).toBe(100 + 10 + 5 + 2 + 1); // 五桶并列，与日总量同口径
    expect(erp.cost).toBe(0.2);
    expect(erp.models).toEqual({ "anthropic/claude-opus-4.8": 118 });
    expect(erp.sessions).toEqual(["h_abs"]);
    expect(bucketOf(entry.days, TODAY, "D:/work/api").tokens).toBe(7);

    const today = out.ranges.today;
    expect(today.in).toBe(111);
    expect(today.out).toBe(18);
    expect(today.cr).toBe(5);
    expect(today.cw).toBe(2);
    expect(today.reason).toBe(1);
    expect(today.cost).toBeCloseTo(0.28, 9);
    expect(today.sessions).toBe(4);
  });

  it("老缓存没带 projects_version 就必须重扫（旧形状根本没有桶）", () => {
    // sig 与 version 都对（HERMES_SCAN_VERSION=2，与采集器同步），只有桶标记缺失
    const cache = {
      hermes: {
        [HERMES_DB]: {
          sig: sqliteSignature(HERMES_DB), version: 2,
          days: {
            [TODAY]: {
              in: 1, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, sessions: 0, models: {},
              hours: new Array(24).fill(0), projects: { 陈旧桶: { tokens: 1, cost: 0, models: {}, sessions: [] } },
            },
          },
        },
      },
    };
    scanHermes(bounds, cache);
    const entry = cache.hermes[HERMES_DB];
    expect(entry.projects_version).toBe(PROJECT_BUCKETS_VERSION);
    expect(Object.keys(entry.days[TODAY].projects)).not.toContain("陈旧桶");
    expect(Object.keys(entry.days[TODAY].projects).length).toBe(2);
  });
});

maybe("devin：sessions.working_directory 才是项目", () => {
  it("桶不加 reasoning；无价会话不成桶，成本全部来自可计价那次", () => {
    const cache: Record<string, any> = {};
    const out = scanDevin(bounds, cache);
    const entry = singleEntry(cache.devin);
    expect(entry.projects_version).toBe(PROJECT_BUCKETS_VERSION);
    const day = entry.days[TODAY];
    expect(Object.keys(day.projects)).toEqual(["D:/work/erp"]);

    const erp = bucketOf(entry.days, TODAY, "D:/work/erp");
    expect(erp.tokens).toBe(50 + 7 + 3 + 2); // 与 Python 一致：Devin 的总量不含 reasoning
    expect(Object.keys(erp.models)).toEqual(["openai/gpt-5.6-sol"]); // sessions.model 兜底后再过目录名
    expect(erp.models["openai/gpt-5.6-sol"]).toBe(62);
    expect(erp.sessions).toEqual(["d1"]);
    expect(erp.cost).toBe(day.cost); // d2/d3 都无价，当天成本全部来自成桶的 d1
    expect(erp.cost).toBeGreaterThan(0);

    const today = out.ranges.today;
    expect(today.in).toBe(50 + 900 + 5);
    expect(today.sessions).toBe(3);
    expect(today.cost).toBe(day.cost);
  });
});

maybe("opencode / mimocode：session 表目录才是项目", () => {
  it("session 先于 session_v2；桶只记美元成本；POSIX 绝对路径也收", () => {
    const cache: Record<string, any> = {};
    const out = scanOpencode(bounds, cache);
    const entry = singleEntry(cache.opencode);
    expect(entry.projects_version).toBe(PROJECT_BUCKETS_VERSION);
    expect(Object.keys(entry.days[TODAY].projects).sort()).toEqual(["/tmp/posix-project", "D:\\work\\erp"]);

    const erp = bucketOf(entry.days, TODAY, "D:\\work\\erp");
    expect(erp.tokens).toBe(100 + 5 + 2 + 10 + 3); // 含 reasoning 与两级缓存
    expect(erp.cost).toBe(0.01); // 消息自带的美元成本
    expect(erp.models).toEqual({ "gpt-5": 120 });
    expect(erp.sessions).toEqual(["ses_a"]);
    expect(bucketOf(entry.days, TODAY, "/tmp/posix-project").cost).toBe(0); // 无价模型不估

    const today = out.ranges.today;
    expect(today.in).toBe(141);
    expect(today.reason).toBe(2);
    expect(today.cost).toBeCloseTo(0.011, 9);
    expect(today.sessions).toBe(3);
  });

  it("mimocode 复用同一套解析：自己的库里也出 day.projects", () => {
    const cache: Record<string, any> = {};
    scanMimoCode(bounds, cache);
    const entry = singleEntry(cache.mimocode);
    expect(entry.projects_version).toBe(PROJECT_BUCKETS_VERSION);
    expect(bucketOf(entry.days, TODAY, "D:\\WORK\\erp").tokens).toBe(17);
    expect(bucketOf(entry.days, TODAY, "D:\\WORK\\erp").sessions).toEqual(["ses_m"]);
  });
});

maybe("minimax：默认工作区不算项目", () => {
  it("is_default_workspace 与 ~/.minimax* 都排除，桶含通过校验的 reasoning", () => {
    const cache: Record<string, any> = {};
    const out = scanMinimax(bounds, cache);
    const entry = singleEntry(cache.minimax);
    expect(entry.projects_version).toBe(PROJECT_BUCKETS_VERSION);
    expect(Object.keys(entry.days[TODAY].projects)).toEqual(["D:\\work\\erp"]);

    const erp = bucketOf(entry.days, TODAY, "D:\\work\\erp");
    expect(erp.tokens).toBe(20 + 4 + 6 + 1 + 3); // 四桶并列 + raw.totalTokens 对得上的 reasoning
    expect(Object.keys(erp.models).length).toBe(1);
    expect(Object.values(erp.models)[0]).toBe(34);
    expect(erp.sessions).toEqual(["m1"]);
    expect(erp.cost).toBe(entry.days[TODAY].cost);
    expect(erp.cost).toBeGreaterThan(0);

    expect(out.ranges.today.in).toBe(20 + 900 + 800 + 700);
    expect(out.ranges.today.reason).toBe(3);
  });
});

maybe("五个工具的桶汇进同一条项目足迹", () => {
  const cache: Record<string, any> = {};

  beforeAll(() => {
    scanHermes(bounds, cache);
    scanDevin(bounds, cache);
    scanOpencode(bounds, cache);
    scanMimoCode(bounds, cache);
    scanMinimax(bounds, cache);
  });

  it("同一项目的不同写法（反斜杠/正斜杠/大小写）跨工具合成一行", () => {
    const list = projectTrail(cache);
    const byName = Object.fromEntries(list.map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(["api", "erp", "posix-project"]);

    const erp = byName.erp;
    expect(erp.tools).toEqual(["devin", "hermes", "mimocode", "minimax", "opencode"]);
    expect(erp.tokens).toBe(118 + 62 + 120 + 17 + 34);
    expect(erp.sessions).toBe(5); // h_abs / d1 / ses_a / ses_m / m1
    expect(erp.last_active).toBe(TODAY);
    // 逐项目模型名带工具后缀，最大那份来自 opencode（120 > 118 hermes）
    expect(erp.top_model).toBe("GPT-5 (OpenCode)");
    expect(byName.api.tokens).toBe(7);
    expect(byName.api.tools).toEqual(["hermes"]);
    expect(byName["posix-project"].tokens).toBe(52);

    const labels = Object.fromEntries([...projectContributions(cache)].map((h) => [h.tool, h.label]));
    expect(labels).toMatchObject({
      devin: "Devin", hermes: "Hermes", minimax: "MiniMax Code",
      mimocode: "MiMoCode", opencode: "OpenCode",
    });
  });
});

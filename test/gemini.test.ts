/**
 * Gemini 采集器 fixture 测试。通过 TOKEI_GEMINI_DIR 注入临时目录，
 * 并把 HOME/APPDATA 指向不存在的临时路径来隔离真实机器数据
 * （src 模块必须在 env 设置之后再动态 import，paths.ts 的 HOME/APPDATA 是模块级常量）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "node:module";
import { ledgerFlush, useLedgerFile } from "../src/core/ledger";

// 与采集器同款绕过：vite-node 不认 node:sqlite 的静态 import
const { DatabaseSync } = createRequire(path.join(process.cwd(), "noop.js"))("node:sqlite") as typeof import("node:sqlite");

let G: typeof import("../src/collectors/gemini");
let recalcCosts: typeof import("../src/core/model").recalcCosts;
let rangeBounds: typeof import("../src/core/ranges").rangeBounds;
let root: string;

// 固定基准：2026-09-29（周二），本周一起 09-28，上周 09-21~09-27
let BOUNDS: any;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-gemini-"));
  // 账本指到临时目录：扫描器接入 ledger 后也绝不写 ~/.tokei
  useLedgerFile(path.join(root, "ledger.json"), path.join(root, "config.json"));
  process.env.HOME = path.join(root, "no-home");
  process.env.USERPROFILE = path.join(root, "no-home");
  process.env.APPDATA = path.join(root, "no-appdata");
  process.env.LOCALAPPDATA = path.join(root, "no-localappdata");
  delete process.env.TOKEI_GEMINI_DIR;
  delete process.env.TOKEI_ANTIGRAVITY_DIR;
  G = await import("../src/collectors/gemini");
  recalcCosts = (await import("../src/core/model")).recalcCosts;
  rangeBounds = (await import("../src/core/ranges")).rangeBounds;
  BOUNDS = rangeBounds(new Date("2026-09-29T12:00:00"));
});

function fixture(name: string): string {
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  process.env.TOKEI_GEMINI_DIR = dir;
  // 每个 fixture 一份账本：账本按「工具+日」做高水位，共用一份会让上一个用例的历史值盖住这一个用例
  useLedgerFile(path.join(dir, "ledger.json"), path.join(dir, "config.json"));
  return dir;
}

function epochSec(localIso: string): number {
  return Math.floor(new Date(localIso).getTime() / 1000);
}

// ---------- protobuf 构造器（测试侧与采集器解码器互为镜像） ----------
function varint(n: number): number[] {
  const bytes: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b += 128;
    bytes.push(b);
  } while (n > 0);
  return bytes;
}
const tag = (fn: number, wt: number) => varint(fn * 8 + wt);
const lenField = (fn: number, payload: number[]) => [...tag(fn, 2), ...varint(payload.length), ...payload];
const vField = (fn: number, v: number) => [...tag(fn, 0), ...varint(v)];

function genRecord(model: string, inp: number, out: number, cached: number, thoughts: number, tsSec: number | null): number[] {
  const tokens = [...vField(2, inp), ...vField(3, out), ...vField(5, cached), ...vField(9, thoughts)];
  const parts = [...lenField(19, [...Buffer.from(model, "utf8")]), ...lenField(4, tokens)];
  if (tsSec !== null) parts.push(...lenField(9, lenField(4, vField(1, tsSec))));
  return lenField(1, parts);
}

function writeAntigravityDb(file: string, rows: Array<{ idx: number; data: number[] }>, steps: Array<{ idx: number; tsSec: number }> = []): void {
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
    db.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB)");
    const ins = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
    for (const r of rows) ins.run(r.idx, Buffer.from(r.data));
    const insStep = db.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)");
    for (const s of steps) insStep.run(s.idx, Buffer.from(lenField(1, vField(1, s.tsSec))));
  } finally {
    db.close();
  }
}

describe("gemini collector", () => {
  it("session-*.json：input 已含 cached 的拆分与命中率", () => {
    const dir = fixture("t1");
    fs.writeFileSync(path.join(dir, "session-a1.json"), JSON.stringify({
      sessionId: "s1",
      lastUpdated: "2026-09-29T11:00:00",
      messages: [
        { id: "m1", type: "gemini", timestamp: "2026-09-29T10:00:00", model: "gemini-3.5-flash", tokens: { input: 1000, output: 100, cached: 400, thoughts: 50 } },
        { id: "m2", type: "user", timestamp: "2026-09-29T10:01:00", tokens: { input: 9999 } },
        { id: "m3", type: "gemini", timestamp: "garbage-ts", tokens: { input: 8888 } },
      ],
    }));
    const { ranges, days } = G.scanGemini(BOUNDS, {});
    expect(ranges.today.in).toBe(600);        // input - cached
    expect(ranges.today.cached).toBe(400);
    expect(ranges.today.out).toBe(100);
    expect(ranges.today.thoughts).toBe(50);
    expect(ranges.today.hit).toBeCloseTo(40, 6); // cached / input(含缓存)
    expect(ranges.today.sessions).toBe(1);
    expect(ranges.today.models).toHaveLength(1);
    expect(ranges.today.models[0].name).toBe("Gemini 3.5 Flash");
    expect(ranges.today.models[0].in).toBe(600);
    expect(ranges.today.models[0].cached).toBe(400);
    expect(days["2026-09-29"].hours[10]).toBe(1000 + 100 + 50); // 小时图不重复加 cached
    expect(ranges.all.in).toBe(600);
  });

  it("thoughts 按输出价计一次：成本由 recalcCosts 补，采集器不算", () => {
    const dir = fixture("t2");
    fs.writeFileSync(path.join(dir, "session-a2.json"), JSON.stringify({
      sessionId: "s2",
      lastUpdated: "2026-09-29T11:00:00",
      messages: [
        { id: "m1", type: "gemini", timestamp: "2026-09-29T10:00:00", model: "gemini-3.5-flash", tokens: { input: 1000, output: 100, cached: 400, thoughts: 50 } },
      ],
    }));
    const result = G.scanGemini(BOUNDS, {});
    expect(result.ranges.today.cost).toBe(0); // 职责切分：collector 留 0，core/recalcCosts 出账
    const payload: any = { gemini: { ranges: result.ranges } };
    recalcCosts(payload);
    const m = payload.gemini.ranges.today.models[0];
    // google/gemini-3.5-flash: in 1.5 / out 9.0 / cache_read 0.15（thoughts 只进 out 一次）
    const expected = (600 * 1.5 + (100 + 50) * 9 + 400 * 0.15) / 1e6;
    expect(m.cost).toBeCloseTo(expected, 12);
    expect(payload.gemini.ranges.today.cost).toBeCloseTo(expected, 12);
    expect(m.pout).toBe(9);
  });

  it("区间分桶：today/yesterday/week/last_week/month/year/all", () => {
    const dir = fixture("t3");
    fs.writeFileSync(path.join(dir, "session-b3.json"), JSON.stringify({
      sessionId: "s3",
      messages: [
        { id: "m1", type: "gemini", timestamp: "2026-09-29T09:00:00", model: "gemini-3.5-flash", tokens: { input: 100, output: 1, cached: 0, thoughts: 0 } },
        { id: "m2", type: "gemini", timestamp: "2026-09-28T09:00:00", model: "gemini-3.5-flash", tokens: { input: 200, output: 2, cached: 0, thoughts: 0 } },
        { id: "m3", type: "gemini", timestamp: "2026-09-21T09:00:00", model: "gemini-3.5-flash", tokens: { input: 400, output: 4, cached: 0, thoughts: 0 } },
      ],
    }));
    const { ranges } = G.scanGemini(BOUNDS, {});
    expect(ranges.today.in).toBe(100);
    expect(ranges.yesterday.in).toBe(200);
    expect(ranges.week.in).toBe(300);      // today + yesterday（本周一 09-28 起）
    expect(ranges.last_week.in).toBe(400); // 09-21 属上周
    expect(ranges.month.in).toBe(700);
    expect(ranges.year.in).toBe(700);
    expect(ranges.all.in).toBe(700);
  });

  it("sid 去重：同一会话的 .db(rank3) 覆盖 session-*.json(rank1)，排除 conversation_summaries.db", () => {
    const dir = fixture("t4");
    fs.writeFileSync(path.join(dir, "session-abc.json"), JSON.stringify({
      sessionId: "abc",
      lastUpdated: "2026-09-29T23:00:00",
      messages: [
        { id: "m1", type: "gemini", timestamp: "2026-09-29T10:00:00", model: "gemini-3.5-flash", tokens: { input: 99999, output: 999, cached: 99999, thoughts: 999 } },
      ],
    }));
    // db 口径：field2 输入不含缓存 → 事件 input = 500+100
    writeAntigravityDb(path.join(dir, "abc.db"), [
      { idx: 1, data: genRecord("gemini-3.5-flash", 500, 20, 100, 5, epochSec("2026-09-29T10:00:00")) },
    ]);
    // 若未被排除会多出独立 sid —— 内容同样合法
    writeAntigravityDb(path.join(dir, "conversation_summaries.db"), [
      { idx: 1, data: genRecord("gemini-3.5-flash", 700000, 7000, 70000, 700, epochSec("2026-09-29T10:00:00")) },
    ]);
    const { ranges } = G.scanGemini(BOUNDS, {});
    expect(ranges.today.sessions).toBe(1);
    expect(ranges.today.in).toBe(500);   // (500+100) - 100
    expect(ranges.today.cached).toBe(100);
    expect(ranges.today.out).toBe(20);
    expect(ranges.today.thoughts).toBe(5);
  });

  it("jsonl：$rewindTo 丢弃回退点之后的消息，消息按 id 覆盖", () => {
    const dir = fixture("t5");
    fs.mkdirSync(path.join(dir, "chats-r"));
    fs.writeFileSync(path.join(dir, "chats-r", "session-r5.jsonl"), [
      JSON.stringify({ sessionId: "r1", lastUpdated: "2026-09-29T12:00:00" }),
      JSON.stringify({ id: "m1", type: "gemini", timestamp: "2026-09-29T09:00:00", model: "gemini-3.5-flash", tokens: { input: 500, output: 10, cached: 0, thoughts: 0 } }),
      JSON.stringify({ $rewindTo: "m1" }),
      JSON.stringify({ id: "m1", type: "gemini", timestamp: "2026-09-29T10:00:00", model: "gemini-3.5-flash", tokens: { input: 300, output: 5, cached: 100, thoughts: 7 } }),
      JSON.stringify({ id: "m2", type: "gemini", timestamp: "2026-09-29T10:30:00", model: "gemini-3.5-flash", tokens: { input: 100, output: 1, cached: 0, thoughts: 0 } }),
    ].join("\n"));
    const { ranges, days } = G.scanGemini(BOUNDS, {});
    expect(ranges.today.in).toBe(300);       // (300+100)-100 + (100-0)
    expect(ranges.today.cached).toBe(100);
    expect(ranges.today.out).toBe(6);
    expect(ranges.today.thoughts).toBe(7);
    expect(days["2026-09-29"].hours[9]).toBe(0); // 被回退的那条不计入
  });

  it("db：一步多记录 + steps.metadata 时间戳兜底", () => {
    const dir = fixture("t6");
    const today = epochSec("2026-09-29T10:00:00");
    const yesterday = epochSec("2026-09-28T15:00:00");
    const withTs = genRecord("gemini-3.5-flash", 100, 10, 20, 3, today);
    // 无自身时间戳 → 通过 field2 packed 引用 step 7 的时间戳兜底
    const noTs = lenField(1, [...lenField(19, [...Buffer.from("gemini-3.1-pro", "utf8")]), ...lenField(4, [...vField(2, 40), ...vField(3, 4)])]);
    writeAntigravityDb(path.join(dir, "d7.db"), [{ idx: 1, data: [...withTs, ...noTs, ...lenField(2, varint(7))] }], [{ idx: 7, tsSec: yesterday }]);
    const { ranges } = G.scanGemini(BOUNDS, {});
    expect(ranges.today.in).toBe(100);
    expect(ranges.today.cached).toBe(20);
    expect(ranges.today.out).toBe(10);
    expect(ranges.today.thoughts).toBe(3);
    expect(ranges.yesterday.in).toBe(40);    // 兜底时间戳落在昨天
    expect(ranges.today.sessions).toBe(1);   // 两份记录同属一个 db 会话
  });

  it("签名缓存：未变化文件不重解析，变化后重扫", () => {
    const dir = fixture("t7");
    const file = path.join(dir, "session-c8.json");
    fs.writeFileSync(file, JSON.stringify({
      sessionId: "s8",
      messages: [{ id: "m1", type: "gemini", timestamp: "2026-09-29T10:00:00", model: "gemini-3.5-flash", tokens: { input: 600, output: 10, cached: 0, thoughts: 0 } }],
    }));
    const cache: Record<string, any> = {};
    const first = G.scanGemini(BOUNDS, cache);
    expect(first.ranges.today.in).toBe(600);
    const second = G.scanGemini(BOUNDS, cache);
    expect(second.ranges.today.in).toBe(600);
    // 追加一条消息（mtime/size 变化 → 签名失效重解析）
    fs.writeFileSync(file, JSON.stringify({
      sessionId: "s8",
      messages: [
        { id: "m1", type: "gemini", timestamp: "2026-09-29T10:00:00", model: "gemini-3.5-flash", tokens: { input: 600, output: 10, cached: 0, thoughts: 0 } },
        { id: "m2", type: "gemini", timestamp: "2026-09-29T10:05:00", model: "gemini-3.5-flash", tokens: { input: 300, output: 5, cached: 0, thoughts: 0 } },
      ],
    }));
    const third = G.scanGemini(BOUNDS, cache);
    expect(third.ranges.today.in).toBe(900);
  });

  it("账本回补：删掉一份日志后当天仍按整日快照出账，会话数只认现存日志", () => {
    const dir = fixture("t9");
    fs.writeFileSync(path.join(dir, "session-c9a.json"), JSON.stringify({
      sessionId: "s9a",
      messages: [{ id: "m1", type: "gemini", timestamp: "2026-09-29T10:00:00", model: "gemini-3.5-flash", tokens: { input: 600, output: 10, cached: 200, thoughts: 4 } }],
    }));
    const fileB = path.join(dir, "session-c9b.json");
    fs.writeFileSync(fileB, JSON.stringify({
      sessionId: "s9b",
      messages: [{ id: "m2", type: "gemini", timestamp: "2026-09-29T11:00:00", model: "gemini-3.5-flash", tokens: { input: 300, output: 5, cached: 0, thoughts: 0 } }],
    }));
    const first = G.scanGemini(BOUNDS, {});
    expect(first.ranges.today.in).toBe(700);
    expect(first.ranges.today.sessions).toBe(2);
    ledgerFlush(); // compute() 末尾的落盘，测试里手动触发一次
    fs.rmSync(fileB);
    const again = G.scanGemini(BOUNDS, {});
    // 天级高水位：账本里那份「两个会话都在」的整日快照兜住被删的那份
    expect(again.ranges.today.in).toBe(first.ranges.today.in);
    expect(again.ranges.today.cached).toBe(first.ranges.today.cached);
    expect(again.ranges.today.out).toBe(first.ranges.today.out);
    expect(again.ranges.today.thoughts).toBe(first.ranges.today.thoughts);
    // 会话是实时归属，账本快照里的 Set 不落盘，所以只剩现存日志那一份
    expect(again.ranges.today.sessions).toBe(1);
  });

  it("目录不存在 → 空结果且清缓存", () => {
    fixture("t8");
    const cache: Record<string, any> = {};
    const r1 = G.scanGemini(BOUNDS, cache);
    expect(r1.ranges.all.in).toBe(0);
    expect(Object.keys(cache.gemini)).toEqual([]);
  });
});

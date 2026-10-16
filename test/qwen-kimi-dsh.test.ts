/**
 * Qwen Code / Kimi Code / DeepSeek Harness 采集器测试。
 * 全部走临时目录 fixture + 采集器支持的 env 注入（QWEN_HOME / QWEN_RUNTIME_DIR /
 * TOKEI_KIMI_DIR / TOKEI_DSH_DIR），断言集中在 all 区间以摆脱本机时钟与时区。
 * 重点覆盖：
 *   - qwencode：逐请求 vs 汇总余额合并（余额不伪造小时、缓存明细更全时不虚增输入）
 *   - kimicode：protocol 1.5 与 protocol 1（SubagentEvent 展开、根 wire 镜像抵扣）、
 *     state.json 会话归并、永不推断 USD 成本
 *   - deepseek_harness：多帧 zstd 解压、(session,turn,step) 跨文件去重、
 *     官方人民币潮汐价与第三方美元渠道价分列（cost / cost_cny 永不互加）
 *   - qwenwork（仅纯函数）：环回 URL 安全校验、MCP 信封拆解、额度归一化
 *     （canonical/别名二选一不双算、未知总额、百分比 clamp）；测试中网络开关恒为关
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { rangeBounds } from "../src/core/ranges";
import { scanQwenCode } from "../src/collectors/qwencode";
import { scanKimiCode } from "../src/collectors/kimicode";
import { scanDeepSeekHarness, decompressZstdFrames, zstdFrameEnd } from "../src/collectors/deepseek_harness";
import {
  qwenworkQuotaEnabled, resolveQwenworkLoopbackUrl, readQwenworkMcpConfig,
  normalizeQwenworkUsage, qwenworkMcpData, scanQwenwork,
} from "../src/collectors/qwenwork";
import { useLedgerFile } from "../src/core/ledger";

const ENV_KEYS = ["QWEN_HOME", "QWEN_RUNTIME_DIR", "TOKEI_KIMI_DIR", "KIMI_CODE_HOME", "KIMI_SHARE_DIR", "TOKEI_DSH_DIR", "TOKEI_QWENWORK_HOME", "TOKEI_QWENWORK_QUOTA"];
const tmpDirs: string[] = [];

// 本文件按用例各自建临时目录、没有单一根，故把账本指到系统临时目录里命名隔离的文件，
// 避免扫描器接入 ledger 后写真实的 ~/.tokei/ledger.json
const LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-qkd-ledgers-"));
// 每个用例一份空账本：账本按「工具+日」做高水位，同文件内共用一份会让上一个用例
// 入账的历史值盖住这一个用例的实时值
let ledgerSeq = 0;
beforeEach(() => {
  useLedgerFile(path.join(LEDGER_DIR, `ledger-${++ledgerSeq}.json`), path.join(LEDGER_DIR, "config.json"));
});
afterAll(() => {
  try {
    fs.rmSync(LEDGER_DIR, { recursive: true, force: true });
  } catch { /* 忽略 */ }
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-qkd-"));
  tmpDirs.push(dir);
  return dir;
}

function writeJsonl(file: string, records: Array<Record<string, any>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/** 本地时刻的毫秒时间戳：collector 全部按本地时区取日/小时 */
function localMs(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi).getTime();
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

/** 所有区间聚合断言都走 all：固定历史日期不受今天是谁的影响 */
function all(r: any) {
  return r.ranges.all;
}

// ---------------- Qwen Code ----------------

describe("qwencode collector", () => {
  it("逐请求优先；汇总只补每模型余额、归汇总日期不伪造小时；输入不重复计", () => {
    const runtime = mkTmp();
    const home = mkTmp();
    process.env.QWEN_RUNTIME_DIR = runtime;
    process.env.QWEN_HOME = home;

    // 逐请求日志：sess-a 两条完整；sess-b 只留了部分请求
    writeJsonl(path.join(runtime, "usage", "token-usage-2026-09.jsonl"), [
      {
        schemaVersion: 1, id: "r1", sessionId: "sess-a", model: "qwen3.8-max",
        timestamp: localMs(2026, 9, 15, 8, 0), localDate: "2026-09-15",
        inputTokens: 1000, cachedTokens: 400, outputTokens: 100, thoughtsTokens: 20,
      },
      {
        schemaVersion: 1, id: "r2", sessionId: "sess-a", model: "qwen3.8-max",
        timestamp: localMs(2026, 9, 15, 9, 0), localDate: "2026-09-15",
        inputTokens: 500, cachedTokens: 0, outputTokens: 50, thoughtsTokens: 0,
      },
      {
        schemaVersion: 1, id: "r3", sessionId: "sess-b", model: "qwen3.8-max",
        timestamp: localMs(2026, 9, 15, 10, 0), localDate: "2026-09-15",
        inputTokens: 600, cachedTokens: 0, outputTokens: 50, thoughtsTokens: 5,
      },
      { schemaVersion: 2, id: "r-x", sessionId: "sess-a", inputTokens: 99999 }, // 版本不符：丢弃
      { schemaVersion: 1, sessionId: "sess-no-id", inputTokens: 99999 },          // 无 id：丢弃
    ]);

    // 旧版汇总：sess-a 恰好等于逐请求（余额=0，不应重复入账）；
    // sess-b 比逐请求更全（缓存明细在汇总里才出现）；sess-c 只有汇总。
    // 同一 sessionId 出现两份快照 → 只取最后一份。
    writeJsonl(path.join(home, "usage_record.jsonl"), [
      {
        version: 1, sessionId: "sess-c", timestamp: localMs(2026, 9, 14, 7, 0),
        models: { "qwen3.8-max": { inputTokens: 10, cachedTokens: 0, outputTokens: 1, thoughtsTokens: 0 } },
      },
      {
        version: 1, sessionId: "sess-a", timestamp: localMs(2026, 9, 15, 23, 0),
        models: { "qwen3.8-max": { inputTokens: 1500, cachedTokens: 400, outputTokens: 150, thoughtsTokens: 20 } },
      },
      {
        version: 1, sessionId: "sess-b", timestamp: localMs(2026, 9, 15, 23, 30),
        models: { "qwen3.8-max": { inputTokens: 1000, cachedTokens: 400, outputTokens: 100, thoughtsTokens: 10 } },
      },
      {
        version: 1, sessionId: "sess-c", timestamp: localMs(2026, 9, 14, 7, 0),
        models: { "qwen3.8-max": { inputTokens: 300, cachedTokens: 100, outputTokens: 30, thoughtsTokens: 0 } },
      },
    ]);

    const r = scanQwenCode(bounds(), {});
    const a = all(r);
    // in = 600 + 500 + 600（逐请求）+ 0（sess-b 余额的非缓存输入；汇总缓存 400 抵扣后 remainingInput=400 全归 cr）
    //     + 200（sess-c 只有汇总：300-100）
    expect(a.in).toBe(600 + 500 + 600 + 200);
    expect(a.cr).toBe(400 + 0 + 400 + 100); // sess-b 的 400 缓存读来自汇总余额
    expect(a.out).toBe(100 + 50 + 50 + 50 + 30); // r1+r2+r3 + sess-b 余额 50 + sess-c 30
    expect(a.reason).toBe(20 + 0 + 5 + 5 + 0); // sess-b 余额思考 5
    expect(a.cw).toBe(0);
    expect(a.sessions).toBe(3);

    // 小时分布：余额（hour=null）归 9-15 当天但绝不落进 23 点；22 点也无数据
    const day = r.days!["2026-09-15"];
    expect(day.hours[8]).toBe(600 + 400 + 100 + 20); // r1: total=in+out+cr+reason
    expect(day.hours[9]).toBe(550); // r2
    expect(day.hours[10]).toBe(655); // r3
    expect(day.hours[23]).toBe(0); // 汇总余额不伪造缺失请求的小时
    const hourSum = day.hours.reduce((s: number, v: number) => s + v, 0);
    const dayTotal = day.in + day.out + day.cr + day.cw + day.reason;
    expect(hourSum).toBeLessThan(dayTotal); // 余额只进日不进小时

    // sess-a 汇总余额恰好为 0：不产生第二条入账（若重复计，in 会远超上面断言）
    expect(r.days!["2026-09-14"].in).toBe(200);
  });
});

// ---------------- Kimi Code ----------------

describe("kimicode collector", () => {
  it("protocol 1.5：多 agent 按 state.json.id 归并；根 wire 镜像抵扣；永不推断 USD", () => {
    const root = mkTmp();
    process.env.TOKEI_KIMI_DIR = root;
    const sessionDir = path.join(root, "sessions", "wd1", "sess1");
    const t = localMs(2026, 9, 15, 8, 0);
    const mainRecord = {
      type: "usage.record", time: t, model: "qwen3.8-max", // 有公开价的模型也不许估成本
      usage: { inputOther: 100, output: 20, inputCacheRead: 300, inputCacheCreation: 40 },
    };
    const subRecord = {
      type: "usage.record", time: t + 1000, model: "qwen3.8-max",
      usage: { inputOther: 50, output: 5, inputCacheRead: 10, inputCacheCreation: 0 },
    };
    writeJsonl(path.join(sessionDir, "agents", "main", "wire.jsonl"), [mainRecord]);
    writeJsonl(path.join(sessionDir, "agents", "sub", "wire.jsonl"), [subRecord]);
    fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify({ id: "sess1", cwd: "D:/proj" }));
    // 根 wire：agent wire 的镜像（同键应被抵扣）+ 一条独有的 protocol 1 StatusUpdate
    writeJsonl(path.join(sessionDir, "wire.jsonl"), [
      mainRecord,
      subRecord,
      {
        type: "message", timestamp: t + 2000,
        message: {
          type: "StatusUpdate",
          payload: {
            message_id: "legacy-only-1",
            token_usage: { input_other: 10, output: 1, input_cache_read: 0, input_cache_creation: 0 },
          },
        },
      },
    ]);

    const r = scanKimiCode(bounds(), {});
    const a = all(r);
    expect(a.in).toBe(100 + 50 + 10); // 镜像抵扣后各计一次
    expect(a.out).toBe(20 + 5 + 1);
    expect(a.cr).toBe(300 + 10);
    expect(a.cw).toBe(40);
    expect(a.cost).toBe(0); // 权威账单缺失 → 不推断 USD（qwen3.8-max 明明在价表里）
    expect(a.sessions).toBe(1); // 两个 agent 归并为 state.json.id 一个会话
    const day = r.days!["2026-09-15"];
    expect(day.projects).toContain("D:/proj"); // 项目取 state.json.cwd
  });

  it("protocol 1（旧 ~/.kimi 布局）：SubagentEvent 在主 wire 内展开；不扫 subagents 目录；message_id 去重", () => {
    const root = mkTmp();
    process.env.TOKEI_KIMI_DIR = root;
    const project = "D:/legacy/proj";
    const hash = crypto.createHash("md5").update(project, "utf8").digest("hex");
    const sessionDir = path.join(root, "sessions", hash, "old1");
    const t = localMs(2026, 9, 14, 9, 0);
    const status = (messageId: string, usage: Record<string, number>) => ({
      type: "StatusUpdate",
      payload: { message_id: messageId, token_usage: usage },
    });
    writeJsonl(path.join(sessionDir, "wire.jsonl"), [
      { type: "message", timestamp: t, message: status("m1", { input_other: 7, output: 2, input_cache_read: 1, input_cache_creation: 0 }) },
      { type: "message", timestamp: t, message: status("m1", { input_other: 7, output: 2, input_cache_read: 1, input_cache_creation: 0 }) }, // 同 message_id → 一次
      {
        type: "message", timestamp: t + 5000,
        message: {
          type: "SubagentEvent",
          payload: {
            agent_id: "agent-a",
            // 子代理的 StatusUpdate 消息内嵌在主 wire：必须被展开计入
            event: status("m2", { input_other: 40, output: 6, input_cache_read: 5, input_cache_creation: 1 }),
          },
        },
      },
    ]);
    // 旧版 session/subagents 目录不是数据源（SubagentEvent 已在主 wire 里）
    writeJsonl(path.join(sessionDir, "subagents", "agent-a", "wire.jsonl"), [
      { type: "message", timestamp: t, message: status("m2", { input_other: 9999, output: 9999, input_cache_read: 9999, input_cache_creation: 9999 }) },
    ]);
    fs.writeFileSync(path.join(root, "kimi.json"), JSON.stringify({ work_dirs: [{ path: project }] }));

    const a = all(scanKimiCode(bounds(), {}));
    expect(a.in).toBe(7 + 40);
    expect(a.out).toBe(2 + 6);
    expect(a.cr).toBe(1 + 5);
    expect(a.cw).toBe(0 + 1);
    expect(a.cost).toBe(0);
    expect(a.sessions).toBe(1);
  });
});

// ---------------- DeepSeek Harness ----------------

function zstdFrames(lines: string[]): Buffer {
  return Buffer.concat(lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + "\n", "utf8"))));
}

describe("deepseek_harness collector", () => {
  it("多帧 zstd：zstdDecompressSync 只解第一帧，按帧切分拼接全部", () => {
    const frames = ["line-one\n", "line-two\n", "line-three\n"].map((s) => zlib.zstdCompressSync(Buffer.from(s, "utf8")));
    const joined = Buffer.concat(frames);
    // 实证：整体喂给 zstdDecompressSync 只得到第一帧
    expect(zlib.zstdDecompressSync(joined).toString("utf8")).toBe("line-one\n");
    expect(decompressZstdFrames(joined).toString("utf8")).toBe("line-one\nline-two\nline-three\n");
    // 帧头解析给出的边界与魔数扫描一致
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    let offset = 0;
    for (const frame of frames) {
      const end = zstdFrameEnd(joined, offset);
      expect(end).toBe(offset + frame.length);
      offset = end;
    }
    // 末帧截断（并发写入未落全）：已解出的部分照常返回
    expect(decompressZstdFrames(joined.subarray(0, joined.length - 3)).toString("utf8")).toContain("line-one");
  });

  it("官方人民币潮汐价与第三方美元价分列不互加；chunk 让位 message；跨文件按 (session,turn,step) 去重", () => {
    const root = mkTmp();
    process.env.TOKEI_DSH_DIR = root;
    const sessionDir = path.join(root, "proj-a", "sess-1");
    const officialTime = Date.UTC(2026, 7, 20, 2, 30); // 周四 UTC02:30 = 北京 10:30 → 高峰
    const sessionLine = JSON.stringify({ type: "session", id: "s-1", cwd: "D:/work/proj-a" });
    const headerLine = JSON.stringify({
      type: "request/header", time: officialTime,
      data: { header: { config: { provider: "openrouter", model: "deepseek-chat" } } },
    });
    const chunkLine = JSON.stringify({
      type: "assistant/chunk", time: officialTime + 500,
      data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 888888, outputTokens: 888888 } } },
    });
    const officialLine = JSON.stringify({
      type: "assistant/message", time: officialTime + 800,
      data: {
        turn: 1, step: 1,
        message: { role: "assistant", source: { provider: "deepseek-official", model: "deepseek-v4-pro" } },
        usage: { inputTokens: 1_000_000, outputTokens: 100_000, reasoningTokens: 30_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 },
      },
    });
    const thirdPartyLine = JSON.stringify({
      type: "assistant/message", time: officialTime + 900,
      data: { turn: 2, step: 1, message: { role: "assistant" }, usage: { inputTokens: 500, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    });
    const lines = [sessionLine, headerLine, chunkLine, officialLine, thirdPartyLine];
    const packed = zstdFrames(lines);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "session.jsonl.zstd"), packed);
    // 同一会话的快照副本（Harness 滚动写 session.vN）：整会话记录不得重复
    fs.writeFileSync(path.join(sessionDir, "session.v3.jsonl.zstd"), zstdFrames([sessionLine, officialLine, thirdPartyLine]));

    const r = scanDeepSeekHarness(bounds(), {});
    const a = all(r);
    // 官方：in=1e6, out=1e5-3e4=7e4(=70000), cr=2e6, reason=3e4；第三方 in=500 out=60
    expect(a.in).toBe(1_000_000 + 500);
    expect(a.out).toBe(70_000 + 60);
    expect(a.cr).toBe(2_000_000);
    expect(a.reason).toBe(30_000);
    expect(a.sessions).toBe(1);

    // CNY/USD 分离：官方 v4-pro 高峰价 in=9/out=27/cache_read=0.3（CNY/1M）
    // cost_cny = (1e6*9 + 1e5*27 + 2e6*0.3)/1e6 = 12.3；美元字段不得混入
    const officialRow = a.models.find((m: any) => String(m.model_id).includes("deepseek-v4-pro"));
    const thirdRow = a.models.find((m: any) => String(m.model_id).includes("deepseek-chat"));
    expect(officialRow).toBeTruthy();
    expect(officialRow.cost).toBe(0);
    expect(officialRow.cost_cny).toBeCloseTo(12.3, 6);
    expect(thirdRow).toBeTruthy();
    expect(thirdRow.cost_cny).toBe(0);
    expect(thirdRow.cost).toBeGreaterThan(0); // 第三方渠道（OpenRouter 等）保留美元渠道价
    expect(a.cost_cny).toBeCloseTo(12.3, 6);
    expect(a.cost).toBeCloseTo(thirdRow.cost, 9); // 两币种永不相加

    // assistant/message（priority 2）遮蔽同 turn/step 的 chunk usage（888888 未混入）
    expect(a.in).toBeLessThan(1_000_000 + 1000);
  });
});

describe("qwenwork 额度归一化与安全校验（纯函数，不发网络）", () => {
  // ---------- 环回 URL 安全边界 ----------
  it("只接受 http://127.0.0.1:<port>，其它一律拒绝", () => {
    expect(resolveQwenworkLoopbackUrl("http://127.0.0.1:8321")).toBe("http://127.0.0.1:8321");
    expect(resolveQwenworkLoopbackUrl(" http://127.0.0.1:8321/ ")).toBe("http://127.0.0.1:8321");
    // 拒绝：任何非纯环回基址
    expect(resolveQwenworkLoopbackUrl("https://127.0.0.1:8321")).toBeNull();
    expect(resolveQwenworkLoopbackUrl("http://localhost:8321")).toBeNull();
    expect(resolveQwenworkLoopbackUrl("http://0.0.0.0:8321")).toBeNull();
    expect(resolveQwenworkLoopbackUrl("http://127.0.0.1:8321.evil.com")).toBeNull();
    expect(resolveQwenworkLoopbackUrl("http://evil.com@127.0.0.1:8321")).toBeNull(); // userinfo 走私
    expect(resolveQwenworkLoopbackUrl("http://user:pw@127.0.0.1:8321")).toBeNull();
    expect(resolveQwenworkLoopbackUrl("http://127.0.0.1:8321/mcp")).toBeNull(); // 任意 path 拒绝
    expect(resolveQwenworkLoopbackUrl("http://127.0.0.1:8321?k=v")).toBeNull();
    expect(resolveQwenworkLoopbackUrl("http://127.0.0.1:8321#frag")).toBeNull();
    expect(resolveQwenworkLoopbackUrl("http://127.0.0.1:0")).toBeNull();
    expect(resolveQwenworkLoopbackUrl("http://127.0.0.1:70000")).toBeNull();
    expect(resolveQwenworkLoopbackUrl("http://127.0.0.1")).toBeNull(); // 缺显式端口
    expect(resolveQwenworkLoopbackUrl("gopher://127.0.0.1:8321")).toBeNull();
    expect(resolveQwenworkLoopbackUrl(null)).toBeNull();
    expect(resolveQwenworkLoopbackUrl(127001)).toBeNull();
  });

  // ---------- MCP 信封拆解 ----------
  it("拆 result.structuredContent / JSON 文本 content，拒绝 ok:false 与错 key", () => {
    const data = { available: true, segments: [{ id: "plan", kind: "plan_credits", total: 100, remaining: 40 }] };
    expect(qwenworkMcpData({ result: { structuredContent: { ok: true, key: "qwenwork.usage", data } } })).toEqual(data);
    expect(qwenworkMcpData({ result: { content: [{ type: "text", text: JSON.stringify({ ok: true, key: null, data }) }] } })).toEqual(data);
    expect(qwenworkMcpData({ result: { structuredContent: { ok: false } } })).toBeNull();
    expect(qwenworkMcpData({ result: { structuredContent: { ok: true, key: "other.key", data } } })).toBeNull();
    // 无 data 包裹、顶层即额度时透传
    expect(qwenworkMcpData({ result: { structuredContent: { ok: true, available: true, planCredits: { total: 5 } } } }))
      .toMatchObject({ available: true, planCredits: { total: 5 } });
    expect(qwenworkMcpData(null)).toBeNull();
    expect(qwenworkMcpData({ error: { code: -32601 } })).toBeNull();
  });

  // ---------- 记账口径 ----------
  it("segments 为 canonical：planCredits/addOnCredits 镜像别名不双算", () => {
    const quota = normalizeQwenworkUsage({
      available: true,
      segments: [
        { id: "plan", kind: "plan_credits", total: 100, used: 60, remaining: 40, unit: "credits", percentageUsed: 60 },
        { id: "booster", kind: "add_on", total: 50, used: 10, remaining: 40, unit: "credits", percentageUsed: 20 },
      ],
      // 恶意镜像：如果与 canonical 相加会翻倍
      planCredits: { total: 100, used: 60, remaining: 40, unit: "credits" },
      addOnCredits: { total: 50, used: 10, remaining: 40, unit: "credits" },
      aggregateRemainingPercent: 80,
    }, { updated: 1000 })!;
    expect(quota.segments).toHaveLength(2);
    expect(quota.remaining).toBe(80); // 40 + 40，只算 canonical
    expect(quota.aggregate_remaining_percent).toBe(80);
    expect(quota.plan_credits!.kind).toBe("plan_credits");
    expect(quota.add_on_credits!.id).toBe("booster");
    expect(quota.available).toBe(true);
    expect(quota.stale).toBe(false);
    expect(quota.updated).toBe(1000);
  });

  it("无 canonical segments 时才用别名生成，且 shared 包不并入个人余额", () => {
    const quota = normalizeQwenworkUsage({
      available: true,
      planCredits: { total: 100, used: 60, remaining: 40, unit: "credits" },
      addOnCredits: { total: 30, used: 0, remaining: 30, unit: "credits" },
      sharedAddOnCredits: { cap: 1000, used: 250, remaining: 750, unit: "credits" },
    }, { updated: 2000 })!;
    expect(quota.segments.map((s) => s.kind)).toEqual(["plan_credits", "add_on_credits"]);
    expect(quota.remaining).toBe(70); // 个人 40+30，不含共享 750
    expect(quota.shared!.total).toBe(1000); // cap 作为 total 回退
    expect(quota.shared!.remaining).toBe(750);
    expect(quota.shared_add_on_credits).toBe(quota.shared);
    // 接口没给 aggregateRemainingPercent → null，绝不从 used 反推
    expect(quota.remaining_pct).toBeNull();
    expect(quota.aggregate_remaining_percent).toBeNull();
  });

  it("total=0 且 remaining>0 是合法未知总额：保留绝对积分、percentage_used 为 null", () => {
    const quota = normalizeQwenworkUsage({
      available: true,
      segments: [{ id: "plan", kind: "plan_credits", total: 0, used: 0, remaining: 1234, percentageUsed: 100, unit: "credits" }],
    }, { updated: 3000 })!;
    expect(quota.segments[0].total).toBe(0);
    expect(quota.segments[0].remaining).toBe(1234);
    expect(quota.segments[0].percentage_used).toBeNull(); // 分母未知 → 假 100% 已用不保留
    expect(quota.remaining).toBe(1234);
  });

  it("aggregateRemainingPercent clamp 到 [0,100]；非额度数据返回 null", () => {
    expect(normalizeQwenworkUsage({ available: true, aggregateRemainingPercent: 250 }, { updated: 1 })!.remaining_pct).toBe(100);
    expect(normalizeQwenworkUsage({ available: true, aggregateRemainingPercent: -3 }, { updated: 1 })!.remaining_pct).toBe(0);
    expect(normalizeQwenworkUsage({ available: false }, { updated: 1 })).toBeNull();
    expect(normalizeQwenworkUsage({}, { updated: 1 })).toBeNull();
    expect(normalizeQwenworkUsage(null, { updated: 1 })).toBeNull();
  });

  // ---------- 开关与配置读取（TOKEI_QWENWORK_HOME 注入临时目录，全程不发网络） ----------
  it("默认关闭；env=0 强制关闭优先于配置", () => {
    expect(qwenworkQuotaEnabled({})).toBe(false); // 默认关闭
    expect(qwenworkQuotaEnabled({ qwenwork_quota_enabled: true })).toBe(true);
    process.env.TOKEI_QWENWORK_QUOTA = "0";
    expect(qwenworkQuotaEnabled({ qwenwork_quota_enabled: true })).toBe(false);
    process.env.TOKEI_QWENWORK_QUOTA = "1";
    expect(qwenworkQuotaEnabled({ qwenwork_quota_enabled: false })).toBe(true);
    // 即使 env=1，scanQwenwork（同步入口）在注入的空 HOME 下也只返回空 payload，绝不建连
    process.env.TOKEI_QWENWORK_HOME = mkTmp();
    const empty = scanQwenwork();
    expect(empty.available).toBe(false);
    expect(empty.segments).toEqual([]);
    expect(empty.remaining).toBeNull();
    expect(empty.shared).toBeNull();
  });

  it("mcp-adaptor.config：非 64 位十六进制 token 或非法 URL 直接拒绝", () => {
    const home = mkTmp();
    process.env.TOKEI_QWENWORK_HOME = home;
    const cfg = path.join(home, "mcp-adaptor.config");
    const good = "0123456789abcdef".repeat(4);
    fs.writeFileSync(cfg, JSON.stringify({ url: "http://127.0.0.1:8321", token: good }), "utf8");
    const read = readQwenworkMcpConfig(cfg)!;
    expect(read.port).toBe(8321);
    expect(read.token).toBe(good);
    fs.writeFileSync(cfg, JSON.stringify({ url: "http://localhost:8321", token: good }), "utf8");
    expect(readQwenworkMcpConfig(cfg)).toBeNull();
    fs.writeFileSync(cfg, JSON.stringify({ url: "http://127.0.0.1:8321", token: "short" }), "utf8");
    expect(readQwenworkMcpConfig(cfg)).toBeNull();
    // 超大配置拒绝
    fs.writeFileSync(cfg, JSON.stringify({ url: "http://127.0.0.1:8321", token: good, pad: "x".repeat(20_000) }), "utf8");
    expect(readQwenworkMcpConfig(cfg)).toBeNull();
    // 缺失文件返回 null 而非抛错
    expect(readQwenworkMcpConfig(path.join(home, "nope.json"))).toBeNull();
  });
});

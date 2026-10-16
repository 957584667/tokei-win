/**
 * 额度详情数据层单测：口径逐条对着 usage.30s.py:15488-15953 钉。
 * 全程走 useQuotaDetailFiles / useLedgerFile 注入临时目录，绝不碰真实的 ~/.tokei，
 * 用例结束再验一遍真实目录没被写过。时间一律用本机时区的墙上时间构造（凌晨 1-4 点是
 * 夏令时切换时段，故意避开），免得换台机器结论就变。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  QUOTA_ANCHOR_JITTER, QUOTA_CYCLE_HISTORY, QUOTA_CYCLE_MIN_USED_PCT, QUOTA_SELF_DEVICE,
  QuotaAnchorTable, QuotaDevice, buildQuotaDetail, isoToEpoch, loadQuotaAnchors,
  mergeQuotaAnchors, quotaAnchorCycles, quotaClaudeEvents, quotaCodexEvents, quotaCycleSpecs,
  quotaDailyFromTools, quotaDayHourBounds, quotaDayTokens, quotaDeviceLedgers, quotaDetailInputs,
  quotaLocalDayRange, quotaPeerBoundary, quotaToolReading, quotaWindowDays, quotaWindowTokens,
  recentQuotaDetailPayload, recordQuotaAnchor, saveQuotaAnchors, syncSnapshotFilename,
  useQuotaDetailFiles, QUOTA_WEEK_HOURS,
} from "../src/core/quotaDetail";
import { useLedgerFile } from "../src/core/ledger";
import { dayKey } from "../src/core/ranges";
import { TOKEI_DIR } from "../src/core/paths";

/** 窗口长度与核心层同源，免得两处各写一遍 7*24*3600 写歪 */
const WEEK = QUOTA_WEEK_HOURS * 3600;

/** 本机时区的「今天中午」：正午离夏令时切换最远，天粒度构造都从它出发 */
const BASE = new Date();
BASE.setHours(12, 0, 0, 0);

function at(dayOffset: number, hour: number, minute = 0, second = 0): number {
  const d = new Date(BASE);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, second, 0);
  return Math.floor(d.getTime() / 1000);
}

const midnight = (offset: number) => at(offset, 0);
const dayOf = (offset: number) => dayKey(new Date(midnight(offset) * 1000));
const NOW = at(0, 12);

let root: string;
let anchorFile: string;
let syncDir: string;
let detailFile: string;
let lastUsageFile: string;
let ledgerFile: string;

/** 真实 ~/.tokei 里这次端口可能碰到的几个文件：用例前后各存一份指纹 */
const WATCHED = ["quota_cycles.json", "quota_detail.json", "last_usage.json", "ledger.json"];

function fingerprint(): string {
  return WATCHED.map((name) => {
    const file = path.join(TOKEI_DIR, name);
    try {
      const stat = fs.statSync(file);
      return `${name}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    } catch {
      return `${name}:-`;
    }
  }).join("|");
}

let realDirBefore: string;
beforeAll(() => {
  realDirBefore = fingerprint();
});
afterAll(() => {
  expect(fingerprint()).toBe(realDirBefore);
});

function writeLedger(tools: Record<string, Record<string, any>>): void {
  fs.writeFileSync(ledgerFile, JSON.stringify({ v: 1, tools }));
}

function peerSnapshot(body: Record<string, any>, name: string): void {
  fs.writeFileSync(path.join(syncDir, name), JSON.stringify(body));
}

function ownDevice(tools: Record<string, any> = {}, snapshot: Record<string, any> | null = null): QuotaDevice {
  return { name: snapshot ? "Air" : QUOTA_SELF_DEVICE, tools, snapshot, daily: quotaDailyFromTools(tools) };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-detail-"));
  anchorFile = path.join(root, "quota_cycles.json");
  syncDir = path.join(root, "sync");
  detailFile = path.join(root, "quota_detail.json");
  lastUsageFile = path.join(root, "last_usage.json");
  ledgerFile = path.join(root, "ledger.json");
  fs.mkdirSync(syncDir, { recursive: true });
  writeLedger({});
  useQuotaDetailFiles({
    anchorFile, syncDir, detailFile,
    configFile: path.join(root, "config.json"), lastUsageFile,
  });
  // 账本缓存是进程内的，换文件必须同时把 memo 清掉
  useLedgerFile(ledgerFile, path.join(root, "config.json"));
});

afterEach(() => {
  useQuotaDetailFiles(null);
  useLedgerFile(null, null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("日 token 口径", () => {
  it("claude 取 in+out+cr+cw，不含 reason", () => {
    expect(quotaDayTokens("claude", { in: 1, out: 2, cr: 3, cw: 4, reason: 9, cached: 100 })).toBe(10);
  });

  it("codex 只取 in+out：账本里的 in 已含 cached，再加就翻倍", () => {
    expect(quotaDayTokens("codex", { in: 5, out: 6, cached: 4, reason: 2, cr: 100 })).toBe(11);
  });

  it("grok 有 tokens 就用 tokens，没有才退回 in+out+cr+reason", () => {
    expect(quotaDayTokens("grok", { tokens: 77, in: 1, out: 2, cr: 3, reason: 4 })).toBe(77);
    // Python 的 `int(entry["tokens"] or 0)`：tokens=0 就是 0，不再看分解字段
    expect(quotaDayTokens("grok", { tokens: 0, in: 1, out: 2, cr: 3, reason: 4 })).toBe(0);
    expect(quotaDayTokens("grok", { in: 1, out: 2, cr: 3, reason: 4 })).toBe(10);
  });

  it("坏形状按 0，不抛异常", () => {
    expect(quotaDayTokens("claude", null)).toBe(0);
    expect(quotaDayTokens("claude", [])).toBe(0);
    expect(quotaDayTokens("claude", { in: "abc", out: 5 })).toBe(5);
  });

  it("日表按工具短键铺开，缺的工具留 0，没有周窗口的工具不进表", () => {
    const daily = quotaDailyFromTools({
      claude: { [dayOf(0)]: { in: 1, out: 1, cr: 1, cw: 1 } },
      codex: { [dayOf(1)]: { in: 7, out: 8 } },
      gemini: { [dayOf(0)]: { tokens: 500 } },
    });
    expect(daily[dayOf(0)]).toEqual({ c: 4, x: 0, g: 0 });
    expect(daily[dayOf(1)]).toEqual({ c: 0, x: 15, g: 0 });
    expect(daily[dayOf(2)]).toBeUndefined();
  });
});

describe("窗口与自然日切分", () => {
  it("整窗对齐到自然日时全是 interior，没有 boundary", () => {
    const [interior, boundary] = quotaWindowDays(midnight(-3), midnight(1));
    expect(boundary).toEqual([]);
    expect([...interior].sort()).toEqual([dayOf(-3), dayOf(-2), dayOf(-1), dayOf(0)]);
  });

  it("掐头去尾：首尾两天进 boundary，中间才是完整日", () => {
    const [interior, boundary] = quotaWindowDays(at(-4, 5), at(2, 8, 30));
    expect([...interior].sort()).toEqual([dayOf(-3), dayOf(-2), dayOf(-1), dayOf(0), dayOf(1)]);
    expect(boundary).toEqual([dayOf(-4), dayOf(2)]);
  });

  it("小时边界：起点取所在小时，终点有分/秒就进一格，贴到日尾算 24", () => {
    expect(quotaDayHourBounds(dayOf(-4), at(-4, 5), at(-3, 0))).toEqual([5, 24]);
    expect(quotaDayHourBounds(dayOf(2), at(1, 0), at(2, 8, 30))).toEqual([0, 9]);
    expect(quotaDayHourBounds(dayOf(2), at(1, 0), at(2, 8, 0))).toEqual([0, 8]);
    expect(quotaDayHourBounds(dayOf(0), midnight(1), midnight(2))).toBeNull();
  });

  it("本地自然日区间就是零点到的零点", () => {
    expect(quotaLocalDayRange(dayOf(0))).toEqual([midnight(0), midnight(1)]);
    expect(quotaLocalDayRange(dayOf(-2))).toEqual([midnight(-2), midnight(-1)]);
  });
});

describe("边界日的 peer 口径", () => {
  it("有 hours[24] 就按小时切，不标折算", () => {
    const hours = new Array(24).fill(0);
    hours[5] = 100;
    hours[6] = 200;
    hours[23] = 7;
    const tools = { claude: { [dayOf(-4)]: { hours } } };
    expect(quotaPeerBoundary(tools, "claude", dayOf(-4), [5, 24], 999)).toEqual([307, false]);
  });

  it("没有 hours 才按覆盖小时数向下折算，并标 approx", () => {
    const tools = { claude: { [dayOf(-4)]: { in: 400, out: 400, cr: 0, cw: 0 } } };
    expect(quotaPeerBoundary(tools, "claude", dayOf(-4), [5, 24], 800)).toEqual([633, true]);
    expect(quotaPeerBoundary({}, "claude", dayOf(-4), [0, 24], 800)).toEqual([800, true]);
  });

  it("hours 不足 24 槽不可信，退回折算", () => {
    const tools = { claude: { [dayOf(-4)]: { hours: [1, 2, 3] } } };
    expect(quotaPeerBoundary(tools, "claude", dayOf(-4), [0, 12], 800)).toEqual([400, true]);
  });
});

describe("窗口合计与多设备", () => {
  it("本机边界日优先用带时间戳的事件；interior 那天的事件不重复相加", () => {
    const own = ownDevice({
      claude: { [dayOf(-4)]: { in: 800, out: 0, cr: 0, cw: 0 }, [dayOf(-3)]: { in: 1000, out: 0, cr: 0, cw: 0 } },
    });
    const result = quotaWindowTokens([own], "claude", "c", at(-4, 5), midnight(1), [
      { epoch: at(-4, 6), day: dayOf(-4), tokens: 42 },
      { epoch: at(-3, 9), day: dayOf(-3), tokens: 12345 },
    ]);
    expect(result).toEqual({
      tokens: 1042, perDevice: { [QUOTA_SELF_DEVICE]: 1042 }, approx: false,
    });
  });

  it("事件空但账本当天有量 = 日志被清过，退回折算并标 approx", () => {
    const own = ownDevice({ claude: { [dayOf(-4)]: { in: 800, out: 0, cr: 0, cw: 0 } } });
    const result = quotaWindowTokens([own], "claude", "c", at(-4, 5), midnight(1), []);
    expect(result.perDevice[QUOTA_SELF_DEVICE]).toBe(633);
    expect(result.approx).toBe(true);
  });

  it("事件与账本都空的那天不产生折算量，也就不算 approx", () => {
    const own = ownDevice({ claude: { [dayOf(-4)]: { in: 0, out: 0, cr: 0, cw: 0 } } });
    const result = quotaWindowTokens([own], "claude", "c", at(-4, 5), midnight(1), []);
    expect(result.tokens).toBe(0);
    expect(result.approx).toBe(false);
  });

  it("self_events 传 null 时本机也走 hours 口径", () => {
    const hours = new Array(24).fill(0);
    hours[7] = 50;
    const own = ownDevice({ claude: { [dayOf(-4)]: { in: 900, out: 0, cr: 0, cw: 0, hours } } });
    const result = quotaWindowTokens([own], "claude", "c", at(-4, 5), midnight(1), null);
    expect(result.perDevice[QUOTA_SELF_DEVICE]).toBe(50);
    expect(result.approx).toBe(false);
  });

  it("peer 只有 hours，逐设备拆量后本机排在前", () => {
    const own = ownDevice({ claude: { [dayOf(-1)]: { in: 10, out: 0, cr: 0, cw: 0 } } });
    const peerHours = new Array(24).fill(0);
    peerHours[3] = 5;
    peerHours[7] = 5;
    const peer = ownDevice({ claude: { [dayOf(-1)]: { in: 0, out: 0, cr: 0, cw: 0 }, [dayOf(-4)]: { hours: peerHours } } });
    peer.name = "Air";
    const result = quotaWindowTokens([own, peer], "claude", "c", at(-4, 5), midnight(1), []);
    expect(Object.keys(result.perDevice)).toEqual([QUOTA_SELF_DEVICE, "Air"]);
    expect(result.perDevice[QUOTA_SELF_DEVICE]).toBe(10);
    // 边界日只认 [5,24) 那几个小时：hours[3] 不在窗口内
    expect(result.perDevice.Air).toBe(5);
    expect(result.tokens).toBe(15);
  });
});

describe("事件缓存", () => {
  it("claude：跨文件同 message 去重、取大的那份，按本机时区落日", () => {
    const event = (atSeconds: number, extra: Record<string, any> = {}) => ({
      // 事件缓存里的 ts 是毫秒（collectors/claude.ts:88），fixture 也按毫秒给
      ts: atSeconds * 1000, in: 10, out: 5, cr: 1, cw: 1, cost: 0, model: "m",
      mid: "m1", request_id: "r1", event_id: null, sidechain: false, ...extra,
    });
    const cache = {
      claude: {
        "a.jsonl": { events: [event(at(-2, 9))] },
        "b.jsonl": { events: [event(at(-2, 9), { in: 100 }), event(at(-2, 10), { mid: "m2" })] },
      },
    };
    const events = quotaClaudeEvents(cache);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ epoch: at(-2, 9), day: dayOf(-2), tokens: 107 });
    expect(events[1].tokens).toBe(17);
  });

  it("claude：坏时间戳的行丢掉", () => {
    const cache = { claude: { "a.jsonl": { events: [{ ts: NaN, in: 1, out: 1, cr: 0, cw: 0, mid: null }] } } };
    expect(quotaClaudeEvents(cache)).toEqual([]);
  });

  it("codex：只认 canonical、跳过 drop_count 回放、行内 idx6+idx8", () => {
    const row = (day: string, hour: number, idx6: number, idx8: number) => [
      `${day}T${String(hour).padStart(2, "0")}:00:00`, day, 0, 0, 0, 0, idx6, 0, idx8, 0, 0, null, null,
    ];
    const cache = {
      codex: {
        "keep.jsonl": {
          event_count: 3, canonical: true, drop_count: 1,
          first_event_ts: `${dayOf(-1)}T00:00:00`, last_event_ts: `${dayOf(-1)}T23:00:00`,
          events: [row(dayOf(-1), 1, 1, 1), row(dayOf(-1), 2, 100, 20), row(dayOf(-1), 3, 5, 5), ["短"]],
        },
        "replay.jsonl": { event_count: 1, canonical: false, events: [row(dayOf(-1), 4, 999, 999)] },
        "empty.jsonl": { event_count: 0, canonical: true, events: [row(dayOf(-1), 5, 999, 999)] },
        "far.jsonl": {
          event_count: 1, canonical: true, events: [row(dayOf(-1), 6, 999, 999)],
          first_event_ts: `${dayOf(30)}T00:00:00`, last_event_ts: `${dayOf(30)}T10:00:00`,
        },
      },
    };
    const events = quotaCodexEvents([[midnight(-2), midnight(0)]], cache);
    expect(events).toEqual([
      { epoch: at(-1, 2), day: dayOf(-1), tokens: 120 },
      { epoch: at(-1, 3), day: dayOf(-1), tokens: 10 },
    ]);
    expect(quotaCodexEvents([], cache)).toEqual([]);
  });
});

describe("锚点记录与抖动合并", () => {
  it("±120 秒内算同一个锚点，max_used 取见过的最大值", () => {
    const anchors: QuotaAnchorTable = {};
    expect(recordQuotaAnchor(anchors, "claude", 1_000_000, 3, 2_000)).toBe(true);
    expect(recordQuotaAnchor(anchors, "claude", 1_000_000 + QUOTA_ANCHOR_JITTER, 8, 2_600)).toBe(true);
    expect(anchors.claude).toHaveLength(1);
    expect(anchors.claude[0]).toEqual({
      reset: 1_000_000, first_seen: 2_000, last_seen: 2_600, max_used: 8, confirmed_reset: true,
    });
    // 更小的 used、更早的 now 都不算变化：落盘该省的一轮就省掉
    expect(recordQuotaAnchor(anchors, "claude", 1_000_000, 1, 1_000)).toBe(false);
    expect(anchors.claude[0].max_used).toBe(8);
    recordQuotaAnchor(anchors, "claude", 1_000_000 + QUOTA_ANCHOR_JITTER + 1, 1, 3_000);
    expect(anchors.claude).toHaveLength(2);
  });

  it("confirmed_reset 的三种证据：本次有消耗、紧邻上一锚点有消耗、显式确认", () => {
    const fresh: QuotaAnchorTable = {};
    recordQuotaAnchor(fresh, "codex", 5_000_000, QUOTA_CYCLE_MIN_USED_PCT, 10);
    expect(fresh.codex[0].confirmed_reset).toBe(true);

    const idle: QuotaAnchorTable = {};
    recordQuotaAnchor(idle, "codex", 5_000_000, 0, 10);
    // 全程空闲时 reset 跟着 now+7d 漂：两头都没消耗 → 不能算开了新周期
    recordQuotaAnchor(idle, "codex", 5_000_000 + WEEK + 10, 0, 20);
    expect(idle.codex[1].confirmed_reset).toBeUndefined();

    const cameBack: QuotaAnchorTable = {};
    recordQuotaAnchor(cameBack, "codex", 5_000_000, 12, 10);
    // 旧窗口有消耗后回到 0%、reset 同时前移 → 提前重置成立
    recordQuotaAnchor(cameBack, "codex", 5_000_000 + WEEK + 10, 0, 20);
    expect(cameBack.codex[1].confirmed_reset).toBe(true);

    const forced: QuotaAnchorTable = {};
    recordQuotaAnchor(forced, "grok", 7_000_000, 0, 10, true);
    expect(forced.grok[0].confirmed_reset).toBe(true);
  });

  it("peer 锚点并进内存：坏字段跳过、未知工具忽略、抖动对齐并成同一条", () => {
    const anchors: QuotaAnchorTable = { claude: [{ reset: 2_000_000, max_used: 30, last_seen: 100 }] };
    mergeQuotaAnchors(anchors, {
      claude: [
        { reset: 2_000_000 + 90, max_used: 42, last_seen: 90 },
        { reset: "123", max_used: 9 },
        { reset: -5 },
        "不是字典",
      ],
      grok: [{ reset: 3_000_000, max_used: 12, last_seen: 200, confirmed_reset: true }],
      zed: [{ reset: 4_000_000, max_used: 80 }],
    });
    expect(anchors.claude).toHaveLength(1);
    expect(anchors.claude[0].max_used).toBe(42);
    expect(anchors.grok).toHaveLength(1);
    expect(anchors.grok[0].confirmed_reset).toBe(true);
    expect(anchors.zed).toBeUndefined();
  });

  it("锚点文件读写：坏了当空，写出去的不裁剪历史", () => {
    expect(loadQuotaAnchors()).toEqual({});
    fs.writeFileSync(anchorFile, "{坏 JSON");
    expect(loadQuotaAnchors()).toEqual({});
    fs.writeFileSync(anchorFile, JSON.stringify({ anchors: { claude: "不是数组" } }));
    expect(loadQuotaAnchors()).toEqual({ claude: "不是数组" });

    const many: QuotaAnchorTable = { claude: [] };
    for (let index = 0; index < QUOTA_CYCLE_HISTORY + 8; index++) {
      many.claude.push({ reset: 1_000_000 + index * (WEEK + 3600), max_used: 5, last_seen: 1 });
    }
    saveQuotaAnchors(many);
    expect(loadQuotaAnchors().claude).toHaveLength(QUOTA_CYCLE_HISTORY + 8);
  });
});

describe("周期切分", () => {
  const table = (rows: Record<string, any>[]): QuotaAnchorTable => ({ claude: rows as any });

  it("重新锚定比 7 天短：上一段的尾巴被下一段的起点减一个窗口截断", () => {
    const first = NOW - WEEK;
    const second = first + 3 * 86400;
    const cycles = quotaAnchorCycles(table([
      { reset: second, max_used: 4, last_seen: NOW },
      { reset: first, max_used: 6, last_seen: NOW - WEEK },
    ]), "claude", WEEK, QUOTA_CYCLE_HISTORY, NOW);
    expect(cycles).toHaveLength(2);
    // 观测顺序乱了也要按 reset 排：最新的一条排在最前
    expect(cycles[0]).toEqual({ start: second - WEEK, end: second, used: 4, current: false });
    expect(cycles[1].start).toBe(first - WEEK);
    expect(cycles[1].end).toBe(second - WEEK);
    expect(cycles[1].end - cycles[1].start).toBe(3 * 86400);
  });

  it("没证据的锚点整批丢掉，只保留最新那一条读数", () => {
    const cycles = quotaAnchorCycles(table([
      { reset: NOW - WEEK, max_used: 0, last_seen: NOW },
      { reset: NOW - 2 * WEEK, max_used: 1.5, last_seen: NOW },
    ]), "claude", WEEK, QUOTA_CYCLE_HISTORY, NOW);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual({ start: NOW - 2 * WEEK, end: NOW - WEEK, used: 0, current: false });
  });

  it("同一个 reset 的重复记录切出零时长，不造空周期", () => {
    const cycles = quotaAnchorCycles(table([
      { reset: 1_000_000, max_used: 10, last_seen: 1 },
      { reset: 1_000_000, max_used: 20, last_seen: 2 },
    ]), "claude", WEEK, QUOTA_CYCLE_HISTORY, NOW);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual({ start: 1_000_000 - WEEK, end: 1_000_000, used: 20, current: false });
  });

  it("52 条封顶、最新在前，current 只给最后一条且要求 reset 还没过", () => {
    const rows: Record<string, any>[] = [];
    for (let index = 0; index < QUOTA_CYCLE_HISTORY + 6; index++) {
      rows.push({ reset: NOW + WEEK - index * (WEEK + 3600), max_used: 20, last_seen: NOW });
    }
    const cycles = quotaAnchorCycles(table(rows), "claude", WEEK, QUOTA_CYCLE_HISTORY, NOW);
    expect(cycles).toHaveLength(QUOTA_CYCLE_HISTORY);
    expect(cycles[0]).toEqual({ start: NOW, end: NOW + WEEK, used: 20, current: true });
    expect(cycles.filter((c) => c.current)).toHaveLength(1);

    const past = quotaAnchorCycles(table([
      { reset: NOW - WEEK, max_used: 20, last_seen: NOW - WEEK },
    ]), "claude", WEEK, QUOTA_CYCLE_HISTORY, NOW);
    expect(past[0].current).toBe(false);
  });
});

describe("读数口径与拒绝规则", () => {
  it("claude：q7 + q7_reset，q7_stale 直接拒", () => {
    expect(quotaToolReading({ claude: { q7: 12, q7_reset: 2_000_000, q_updated: 1_900_000 } }, "claude"))
      .toEqual({ used: 12, reset: 2_000_000, updated: 1_900_000 });
    expect(quotaToolReading({ claude: { q7: 12, q7_reset: 2_000_000, q7_stale: true } }, "claude")).toBeNull();
  });

  it("claude：q7_reset 可以是 ISO 串", () => {
    const reading = quotaToolReading({ claude: { q7: 1, q7_reset: `${dayOf(2)}T00:00:00` } }, "claude");
    expect(reading!.reset).toBe(midnight(2));
  });

  it("codex：pw + rw，pw_stale 直接拒", () => {
    expect(quotaToolReading({ codex: { pw: 40, rw: 3_000_000 } }, "codex"))
      .toEqual({ used: 40, reset: 3_000_000, updated: 0 });
    expect(quotaToolReading({ codex: { pw: 40, rw: 3_000_000, pw_stale: true } }, "codex")).toBeNull();
  });

  it("grok：只认 window=week 且不 stale，月窗口一律不要", () => {
    expect(quotaToolReading({ grok: { pct: 9, reset: 4_000_000, window: "week" } }, "grok"))
      .toEqual({ used: 9, reset: 4_000_000, updated: 0 });
    expect(quotaToolReading({ grok: { pct: 9, reset: 4_000_000, window: "month" } }, "grok")).toBeNull();
    expect(quotaToolReading({ grok: { pct: 9, reset: 4_000_000, window: "week", stale: true } }, "grok")).toBeNull();
  });

  it("reset 缺失、非正、或既不是数字也不是时间串 → 没有读数", () => {
    expect(quotaToolReading({ codex: { pw: 40 } }, "codex")).toBeNull();
    expect(quotaToolReading({ codex: { pw: 40, rw: 0 } }, "codex")).toBeNull();
    expect(quotaToolReading({ codex: { pw: 40, rw: "不是时间" } }, "codex")).toBeNull();
    expect(quotaToolReading(null, "codex")).toBeNull();
  });

  it("isoToEpoch 认时间串与秒，空值给 null", () => {
    expect(isoToEpoch(`${dayOf(1)}T05:00:00`)).toBe(at(1, 5));
    expect(isoToEpoch(null)).toBeNull();
    expect(isoToEpoch("")).toBeNull();
  });
});

describe("同步快照里的 peer", () => {
  it("本机排第一，peer 按文件名排，自己那份按 device_id 跳过", () => {
    writeLedger({ claude: { [dayOf(-1)]: { in: 1, out: 2, cr: 0, cw: 0 } } });
    peerSnapshot({ _device: "重复的我", _ledger: { tools: { claude: { [dayOf(-1)]: { in: 9, out: 9, cr: 0, cw: 0 } } } } }, "own.json");
    peerSnapshot({ _device: "Air", _ledger: { tools: { codex: { [dayOf(-1)]: { in: 5, out: 5 } } } } }, "air.json");
    peerSnapshot({ _ledger: { tools: { grok: { [dayOf(-1)]: { tokens: 30 } } } } }, "surface.json");
    fs.writeFileSync(path.join(syncDir, "README.md"), "不是快照");
    fs.writeFileSync(path.join(syncDir, "broken.json"), "{坏");

    const [devices, peerAnchors] = quotaDeviceLedgers({ device_id: "own", sync_dir: syncDir });
    expect(devices.map((d) => d.name)).toEqual([QUOTA_SELF_DEVICE, "Air", "surface"]);
    expect(devices[0].snapshot).toBeNull();
    expect(devices[0].daily[dayOf(-1)]).toEqual({ c: 3, x: 0, g: 0 });
    expect(devices[1].daily[dayOf(-1)]).toEqual({ c: 0, x: 10, g: 0 });
    expect(devices[2].daily[dayOf(-1)]).toEqual({ c: 0, x: 0, g: 30 });
    expect(peerAnchors).toEqual([]);
  });

  it("锚点不看 _ledger：只有 _quota_anchors 的快照也收下", () => {
    peerSnapshot({ _device: "Air", _quota_anchors: { grok: [{ reset: 5_000_000, max_used: 20 }] } }, "air.json");
    const [devices, peerAnchors] = quotaDeviceLedgers({ device_id: "own", sync_dir: syncDir });
    expect(devices).toHaveLength(1);
    expect(peerAnchors).toHaveLength(1);
  });

  it("_device 缺失时用文件名兜底；非法 device_id 一份都不跳过", () => {
    writeLedger({});
    peerSnapshot({ _ledger: { tools: { claude: { [dayOf(-1)]: { in: 1, out: 1, cr: 1, cw: 1 } } } } }, "DESKTOP-7.json");
    expect(quotaDeviceLedgers({ device_id: "", sync_dir: syncDir })[0].map((d) => d.name))
      .toEqual([QUOTA_SELF_DEVICE, "DESKTOP-7"]);
    expect(syncSnapshotFilename("../evil")).toBeNull();
    expect(syncSnapshotFilename("a/b")).toBeNull();
    expect(syncSnapshotFilename("own")).toBe("own.json");
  });

  it("大小写不同的自己那份也不重复算（Windows 文件系统不区分大小写）", () => {
    writeLedger({});
    peerSnapshot({ _ledger: { tools: { claude: { [dayOf(-1)]: { in: 5, out: 5, cr: 0, cw: 0 } } } } }, "OWN.json");
    expect(quotaDeviceLedgers({ device_id: "own", sync_dir: syncDir })[0]).toHaveLength(1);
  });

  it("sync 目录不存在时只有本机，不抛异常", () => {
    fs.rmSync(syncDir, { recursive: true, force: true });
    expect(quotaDeviceLedgers({ device_id: "own", sync_dir: path.join(root, "没有这个目录") })[0])
      .toHaveLength(1);
  });
});

describe("周期规格与落盘边界", () => {
  const payload = {
    claude: { q7: 25, q7_reset: NOW + 2 * 86400, q_updated: NOW },
    codex: { pw: 60, rw: NOW + 4 * 86400, q_updated: NOW },
    // 月套餐：本机这条路读不出 grok
    grok: { pct: 3, reset: NOW + 86400, window: "month", q_updated: NOW },
  };

  it("本机亲眼读到的落盘，peer 锚点只并到内存", () => {
    const [charted, missing, anchors] = quotaCycleSpecs(payload, [ownDevice()], [
      { grok: [{ reset: NOW - 3 * 86400, max_used: 77, last_seen: NOW - 3 * 86400 }] },
    ], NOW);
    expect(charted).toEqual(["claude", "codex", "grok"]);
    expect(missing).toEqual([]);
    expect(Object.keys(anchors).sort()).toEqual(["claude", "codex", "grok"]);
    const onDisk = loadQuotaAnchors();
    expect(Object.keys(onDisk).sort()).toEqual(["claude", "codex"]);
    expect(onDisk.grok).toBeUndefined();
  });

  it("本机读不到就用 peer 快照里的读数记锚，那份读数也算自己观测到的", () => {
    const peerTools = { claude: { [dayOf(-1)]: { in: 1, out: 1, cr: 1, cw: 1 } } };
    const peer: QuotaDevice = {
      name: "Air", tools: peerTools,
      snapshot: { claude: { q7: 33, q7_reset: NOW + 5 * 86400 } },
      daily: quotaDailyFromTools(peerTools),
    };
    const [charted] = quotaCycleSpecs({ claude: {}, codex: {}, grok: {} }, [ownDevice(), peer], [], NOW);
    expect(charted).toEqual(["claude"]);
    expect(loadQuotaAnchors().claude[0].max_used).toBe(33);
  });

  it("一个锚点都没有才算 missing，读数断了不影响历史周期", () => {
    saveQuotaAnchors({ grok: [{ reset: NOW - 86400, max_used: 40, last_seen: NOW - 86400 }] });
    const [charted, missing] = quotaCycleSpecs({ claude: {}, codex: {}, grok: {} }, [ownDevice()], [], NOW);
    expect(charted).toEqual(["grok"]);
    expect(missing).toEqual(["claude", "codex"]);
  });
});

describe("输入解析：复用最近快照 / 脏了才重算", () => {
  function writeLastUsage(body: Record<string, any>, ageSeconds: number): void {
    fs.writeFileSync(lastUsageFile, JSON.stringify(body));
    const when = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(lastUsageFile, when, when);
  }

  it("60 秒内、三个工具都是字典的快照直接用", () => {
    const snapshot = { claude: { q7: 1 }, codex: { pw: 1 }, grok: { pct: 1 } };
    writeLastUsage(snapshot, 30);
    expect(recentQuotaDetailPayload()).toEqual(snapshot);
    expect(quotaDetailInputs({ cache: {} }).payload).toEqual(snapshot);
  });

  it("超过 60 秒、缺工具键、坏 JSON 都不算可用快照", () => {
    writeLastUsage({ claude: {}, codex: {}, grok: {} }, 61);
    expect(recentQuotaDetailPayload()).toBeNull();
    writeLastUsage({ claude: {}, codex: {} }, 5);
    expect(recentQuotaDetailPayload()).toBeNull();
    writeLastUsage({ claude: {}, codex: {}, grok: "不是字典" }, 5);
    expect(recentQuotaDetailPayload()).toBeNull();
    fs.rmSync(lastUsageFile);
    expect(recentQuotaDetailPayload()).toBeNull();
  });

  it("缓存脏了就重算，重算结果与它那份新缓存一起用", () => {
    writeLastUsage({ claude: {}, codex: {}, grok: {} }, 5);
    const fresh = { payload: { claude: { q7: 9 }, codex: {}, grok: {} }, cache: { marker: 1 } };
    let calls = 0;
    const resolved = quotaDetailInputs({
      cache: { _dirty: true },
      recalculate: () => { calls++; return fresh; },
    });
    expect(calls).toBe(1);
    expect(resolved.payload).toBe(fresh.payload);
    expect(resolved.cache).toBe(fresh.cache);
  });

  it("内存 payload 也按年龄判定，超过 60 秒照样走重算", () => {
    const memory = { claude: { q7: 1 }, codex: {}, grok: {} };
    const fresh = { payload: { claude: { q7: 2 }, codex: {}, grok: {} }, cache: {} };
    expect(quotaDetailInputs({ payload: memory, cache: {}, payloadAgeSeconds: 12 }))
      .toEqual({ payload: memory, cache: {} });
    const resolved = quotaDetailInputs({
      payload: memory, cache: {}, payloadAgeSeconds: 90, recalculate: () => fresh,
    });
    expect(resolved.payload).toBe(fresh.payload);
  });

  it("没给重算回调时退回调用方那份 payload，不抛异常", () => {
    const memory = { claude: {}, codex: {}, grok: {} };
    expect(quotaDetailInputs({ payload: memory, cache: { _dirty: true } }).payload).toBe(memory);
  });
});

describe("buildQuotaDetail 全链路", () => {
  it("本机 + peer 合并日表按天升序，周期按 claude/codex/grok 分组、组内最新在前", () => {
    writeLedger({
      claude: {
        [dayOf(-3)]: { in: 100, out: 50, cr: 0, cw: 0 },
        [dayOf(-2)]: { in: 1, out: 1, cr: 1, cw: 1 },
      },
      codex: { [dayOf(-2)]: { in: 7, out: 3 } },
    });
    peerSnapshot({
      _device: "Air",
      _ledger: {
        tools: {
          claude: { [dayOf(-3)]: { in: 10, out: 0, cr: 0, cw: 0 } },
          grok: { [dayOf(-2)]: { tokens: 200 } },
        },
      },
      _quota_anchors: { grok: [{ reset: NOW + 86400, max_used: 18, last_seen: NOW - 86400 }] },
    }, "air.json");

    const detail = buildQuotaDetail({
      payload: {
        claude: { q7: 22, q7_reset: NOW + 2 * 86400, q_updated: NOW },
        codex: { pw: 55, rw: NOW + 3 * 86400, q_updated: NOW },
        grok: { pct: 7, reset: NOW + 86400, window: "month", q_updated: NOW },
      },
      cache: {},
      config: { device_id: "own", sync_dir: syncDir },
      now: NOW,
    });

    expect(detail.now).toBe(NOW);
    expect(detail.devices).toEqual([QUOTA_SELF_DEVICE, "Air"]);
    expect(detail.missing).toEqual([]);
    expect(detail.daily.map((row) => row.d)).toEqual([dayOf(-3), dayOf(-2)]);
    expect(detail.daily[0]).toEqual({ d: dayOf(-3), c: 160, x: 0, g: 0 });
    expect(detail.daily[1]).toEqual({ d: dayOf(-2), c: 4, x: 10, g: 200 });

    const tools = detail.cycles.map((c) => c.tool);
    expect(tools).toEqual(["claude", "codex", "grok"]);
    // grok 只有 peer 锚点：内存里有、落盘没有
    expect(Object.keys(loadQuotaAnchors()).sort()).toEqual(["claude", "codex"]);

    const claudeCycle = detail.cycles[0];
    expect(claudeCycle.used_pct).toBe(22);
    expect(claudeCycle.current).toBe(true);
    expect(claudeCycle.tokens).toBe(164);
    expect(claudeCycle.devices).toEqual({ [QUOTA_SELF_DEVICE]: 154, Air: 10 });
    expect(claudeCycle.approx).toBe(false);
    expect(claudeCycle.start).toBe(NOW + 2 * 86400 - WEEK);
    expect(claudeCycle.end).toBe(NOW + 2 * 86400);

    const grokCycle = detail.cycles[2];
    expect(grokCycle.used_pct).toBe(18);
    expect(grokCycle.devices).toEqual({ [QUOTA_SELF_DEVICE]: 0, Air: 200 });
    expect(grokCycle.tokens).toBe(200);
  });

  it("缺读数的工具进 missing，且不影响别的工具出周期", () => {
    writeLedger({ claude: { [dayOf(-1)]: { in: 9, out: 1, cr: 0, cw: 0 } } });
    const detail = buildQuotaDetail({
      payload: {
        claude: { q7: 12, q7_reset: NOW + 2 * 86400 },
        codex: { pw: 12, rw: NOW + 2 * 86400, pw_stale: true },
        grok: { pct: 12, reset: NOW + 2 * 86400, window: "month" },
      },
      cache: {},
      config: { device_id: "own", sync_dir: syncDir },
      now: NOW,
    });
    expect(detail.missing).toEqual(["codex", "grok"]);
    expect(detail.cycles.map((c) => c.tool)).toEqual(["claude"]);
    expect(detail.cycles[0].tokens).toBe(10);
  });

  it("本机 boundary 日用事件、peer 同一天用 hours，两边都不标 approx", () => {
    writeLedger({ claude: { [dayOf(-1)]: { in: 600, out: 0, cr: 0, cw: 0 } } });
    const hours = new Array(24).fill(0);
    hours[10] = 30;
    hours[20] = 20;
    peerSnapshot({
      _device: "Air",
      _ledger: { tools: { claude: { [dayOf(-1)]: { in: 0, out: 0, cr: 0, cw: 0, hours } } } },
    }, "air.json");
    const reset = at(-1, 5) + WEEK;
    const cache = {
      claude: {
        "a.jsonl": {
          events: [{
            ts: at(-1, 20) * 1000, in: 11, out: 0, cr: 0, cw: 0,
            mid: "只此一条", request_id: null, event_id: null, sidechain: false, cost: 0, model: "m",
          }],
        },
      },
    };
    const detail = buildQuotaDetail({
      payload: { claude: { q7: 40, q7_reset: reset }, codex: {}, grok: {} },
      cache,
      config: { device_id: "own", sync_dir: syncDir },
      now: NOW,
    });
    const cycle = detail.cycles.find((c) => c.tool === "claude")!;
    expect(cycle.approx).toBe(false);
    expect(cycle.devices[QUOTA_SELF_DEVICE]).toBe(11);
    expect(cycle.devices.Air).toBe(50);
    expect(cycle.tokens).toBe(61);
  });

  it("52 条封顶：一年外的周期不再带回，锚点文件原样不动", () => {
    const rows: Record<string, any>[] = [];
    for (let index = 0; index < QUOTA_CYCLE_HISTORY + 5; index++) {
      rows.push({
        reset: NOW + WEEK - index * (WEEK + 3600), max_used: 30, last_seen: NOW - index * (WEEK + 3600),
      });
    }
    saveQuotaAnchors({ claude: rows as any });
    writeLedger({ claude: { [dayOf(-1)]: { in: 1, out: 1, cr: 1, cw: 1 } } });
    const detail = buildQuotaDetail({
      payload: { claude: {}, codex: {}, grok: {} },
      cache: {},
      config: { device_id: "own", sync_dir: syncDir },
      now: NOW,
    });
    expect(detail.cycles.filter((c) => c.tool === "claude")).toHaveLength(QUOTA_CYCLE_HISTORY);
    expect(detail.missing).toEqual(["codex", "grok"]);
    expect(loadQuotaAnchors().claude).toHaveLength(QUOTA_CYCLE_HISTORY + 5);
  });
});

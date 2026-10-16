/**
 * 额度历史的行为规格：逐条移植自 macOS 的 tests/swift/QuotaHistoryStoreCheck.swift。
 * 时间一律用 epoch 秒钉死，按天消耗那段把时区钉在 UTC（Swift 那份用
 * TimeZone(secondsFromGMT: 0)），免得跑测试那台机器的系统时区改变结论。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  QuotaCapture, QuotaHistoryPoint, QuotaHistoryStore, captureFromPayload,
} from "../src/main/quotaHistory";
import {
  DEFAULT_QUOTA_HISTORY_SPAN, QUOTA_HISTORY_TOOLS, QuotaHistoryProjection,
  buildQuotaHistoryFrame, fixedOffsetCalendar, normalizeQuotaSpan,
} from "../src/core/quotaProjection";

const BASE = 1_800_000_000;

/** 对应 historyPoint(_:_:_:_:activity:)：一个 Claude 三窗口都填齐的快照 */
function claudePoint(
  timestamp: number,
  fiveHour: number,
  week: number,
  fable: number,
  activity: { model: string; tokenDelta: number }[],
): QuotaHistoryPoint {
  return {
    timestamp,
    claudeFiveHourRemaining: fiveHour,
    claudeWeekRemaining: week,
    claudeFableWeekRemaining: fable,
    codexWeekRemaining: 50,
    claudeActivity: activity,
    codexActivity: [],
  };
}

function codexPoint(timestamp: number, remaining: number): QuotaHistoryPoint {
  return {
    timestamp,
    claudeFiveHourRemaining: null,
    claudeWeekRemaining: null,
    claudeFableWeekRemaining: null,
    codexWeekRemaining: remaining,
    claudeActivity: [],
    codexActivity: [],
  };
}

const at = (offsetSeconds: number) => new Date((BASE + offsetSeconds) * 1000);

let ROOT: string;

beforeAll(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-history-"));
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("额度历史快照（QuotaHistoryStore）", () => {
  /** 对应 Swift 那份测试的主体：合并、基线、重载、保留期 */
  it("同分钟合并、跨分钟追加、空扫描不清基线、重载后一致、超保留期裁掉", () => {
    const file = path.join(ROOT, "quota_history.json");
    const store = new QuotaHistoryStore(file);

    store.record(
      {
        claudeFiveHourRemaining: 82,
        claudeWeekRemaining: 61,
        claudeFableWeekRemaining: 17,
        codexWeekRemaining: 49,
        claudeModelTotals: { "claude-opus": 100 },
        codexModelTotals: { "gpt-5": 200 },
      },
      at(0),
    );
    expect(store.points.length).toBe(1);
    // 第一次捕获只立基线，没有「上一次」可比，所以活动必须是空的
    expect(store.points[0].claudeActivity).toEqual([]);

    store.record(
      {
        claudeFiveHourRemaining: 80.5,
        claudeWeekRemaining: 60.5,
        claudeFableWeekRemaining: 16.5,
        codexWeekRemaining: 48.5,
        claudeModelTotals: { "claude-opus": 130 },
        codexModelTotals: { "gpt-5": 225 },
      },
      at(30),
    );
    expect(store.points.length).toBe(1);
    expect(store.points[0].claudeFiveHourRemaining).toBe(80.5);
    expect(store.points[0].claudeFableWeekRemaining).toBe(16.5);
    expect(store.points[0].claudeActivity).toEqual([{ model: "claude-opus", tokenDelta: 30 }]);

    store.record(
      {
        claudeFiveHourRemaining: 79,
        claudeWeekRemaining: 60,
        claudeFableWeekRemaining: 16,
        codexWeekRemaining: 48,
        claudeModelTotals: { "claude-opus": 150, "claude-sonnet": 10 },
        codexModelTotals: { "gpt-5": 240 },
      },
      at(65),
    );
    expect(store.points.length).toBe(2);
    expect(store.points[1].claudeActivity.map((a) => a.model)).toEqual(["claude-opus", "claude-sonnet"]);

    // +125 这一轮扫描器挂了：模型总量为空，不能因此把基线清零
    store.record({ claudeFiveHourRemaining: 78, claudeWeekRemaining: 59, codexWeekRemaining: 47 }, at(125));
    store.record(
      {
        claudeFiveHourRemaining: 77,
        claudeWeekRemaining: 58,
        codexWeekRemaining: 46,
        claudeModelTotals: { "claude-opus": 170, "claude-sonnet": 10 },
        codexModelTotals: { "gpt-5": 260 },
      },
      at(185),
    );
    expect(store.points[store.points.length - 1].claudeActivity).toEqual([
      { model: "claude-opus", tokenDelta: 20 },
    ]);

    const reloaded = new QuotaHistoryStore(file);
    expect(reloaded.points).toEqual(store.points);

    reloaded.record(
      {
        claudeFiveHourRemaining: 100,
        claudeWeekRemaining: 100,
        claudeFableWeekRemaining: 100,
        codexWeekRemaining: 100,
      },
      at(8 * 24 * 60 * 60),
    );
    expect(reloaded.points.length).toBe(1);
  });

  it("读数超出 0..100 时夹紧，非有限值丢掉", () => {
    const store = new QuotaHistoryStore(path.join(ROOT, "clamp.json"));
    store.record({ claudeFiveHourRemaining: 140, claudeWeekRemaining: NaN, codexWeekRemaining: -5 }, at(0));
    expect(store.points[0].claudeFiveHourRemaining).toBe(100);
    expect(store.points[0].claudeWeekRemaining).toBe(null);
    expect(store.points[0].codexWeekRemaining).toBe(0);
  });

  it("什么都没有的一次扫描不落快照", () => {
    const store = new QuotaHistoryStore(path.join(ROOT, "useless.json"));
    store.record({}, at(0));
    expect(store.points).toEqual([]);
  });

  it("版本不认识的旧档整份作废，不半读半写", () => {
    const file = path.join(ROOT, "future.json");
    fs.writeFileSync(file, JSON.stringify({ version: 99, points: [{ timestamp: BASE, codexWeekRemaining: 10 }] }));
    const store = new QuotaHistoryStore(file);
    expect(store.points).toEqual([]);
  });

  it("换天重新立基线：昨天的总量不吃掉今天的增量", () => {
    const store = new QuotaHistoryStore(path.join(ROOT, "midnight.json"));
    store.record({ claudeWeekRemaining: 90, claudeModelTotals: { "claude-opus": 500 } }, at(0));
    // 次日同一分钟位置：基线归零，所以 520 不会算出 +20
    store.record({ claudeWeekRemaining: 88, claudeModelTotals: { "claude-opus": 520 } }, at(24 * 3600));
    expect(store.points.length).toBe(2);
    expect(store.points[1].claudeActivity).toEqual([]);
    // 再扫一次才有增量
    store.record({ claudeWeekRemaining: 87, claudeModelTotals: { "claude-opus": 560 } }, at(24 * 3600 + 60));
    expect(store.points[2].claudeActivity).toEqual([{ model: "claude-opus", tokenDelta: 40 }]);
  });
});

describe("扫描结果转捕获（main.swift 的 recordQuotaHistory）", () => {
  const payload = () => ({
    claude: {
      q5: 20, q7: 40, qf: 60,
      q5_stale: false, q7_stale: true, qf_stale: null,
      ranges: {
        today: {
          models: [
            { name: "Opus 4.8", in: 100, out: 20, cr: 5, cw: 3, reason: 999 },
            { name: "合成", in: 8000, out: 0, cr: 0, cw: 0 },
          ],
        },
      },
    },
    codex: {
      pw: 55, pw_stale: false,
      ranges: { today: { models: [{ name: "GPT-5", in: 7, out: 3, cr: 1, cw: 1, reason: 50 }] } },
    },
  });

  it("额度换成剩余百分比，过期的那一档不写", () => {
    const capture: QuotaCapture = captureFromPayload(payload());
    expect(capture.claudeFiveHourRemaining).toBe(80);
    expect(capture.claudeWeekRemaining).toBe(null);
    expect(capture.claudeFableWeekRemaining).toBe(40);
    expect(capture.codexWeekRemaining).toBe(45);
  });

  it("模型总量只算 in+out+cr+cw，Claude 侧剔掉合成行", () => {
    const capture = captureFromPayload(payload());
    expect(capture.claudeModelTotals).toEqual({ "Opus 4.8": 128 });
    expect(capture.codexModelTotals).toEqual({ "GPT-5": 12 });
  });

  it("只有模型活动时，第二遍扫描才落下快照", () => {
    const store = new QuotaHistoryStore(path.join(ROOT, "activity-only.json"));
    const capture = captureFromPayload(payload());
    store.record({ claudeModelTotals: capture.claudeModelTotals }, at(0));
    // 第一遍只用来立基线：既没有额度读数也没有增量，这条快照没东西可画
    expect(store.points).toEqual([]);
    store.record({ claudeModelTotals: { "Opus 4.8": 228 } }, at(60));
    expect(store.points.length).toBe(1);
    expect(store.points[0].claudeWeekRemaining).toBe(null);
    expect(store.points[0].claudeActivity).toEqual([{ model: "Opus 4.8", tokenDelta: 100 }]);
  });
});

describe("曲线预计算（QuotaHistoryProjection）", () => {
  it("工具标题与窗口标识稳定", () => {
    expect(QUOTA_HISTORY_TOOLS.claude.rawValue).toBe("Claude Code");
    expect(QUOTA_HISTORY_TOOLS.claude.windowNames).toEqual(["5h", "week-all", "week-fable"]);
    expect(QUOTA_HISTORY_TOOLS.codex.windowNames).toEqual(["week"]);
  });

  const points = [
    claudePoint(BASE, 80, 60, 20, []),
    claudePoint(BASE + 60, 80, 60, 20, []),
    claudePoint(BASE + 120, 80, 60, 20, []),
    claudePoint(BASE + 180, 79, 59.5, 19.5, [
      { model: "Claude Opus", tokenDelta: 300 },
      { model: "Claude Fable", tokenDelta: 100 },
    ]),
    claudePoint(BASE + 240, 79, 59.5, 19.5, [
      { model: "Claude Fable", tokenDelta: 200 },
      { model: "Claude Opus", tokenDelta: 600 },
    ]),
    claudePoint(BASE + 300, 79, 59.5, 19.5, []),
  ];
  const projection = new QuotaHistoryProjection(points, QUOTA_HISTORY_TOOLS.claude);

  it("取最新值、每个窗口一个终点标记", () => {
    expect(projection.latestValues["5h"]).toBe(79);
    expect(projection.latestDatumIDs.length).toBe(3);
  });

  it("平台段压实成过渡的两条边，事件与 hover 一个不丢", () => {
    expect(projection.lineData.length).toBe(12);
    expect(projection.markerData.length).toBe(6);
    expect(projection.dropEvents.length).toBe(3);
    expect(projection.activityEvents.length).toBe(2);
    expect(projection.hoverSamples.length).toBe(6);
  });

  it("hover 找到最近的采样分钟，并把三个窗口都列出来", () => {
    const nearest = projection.nearestHoverSample(BASE + 250);
    expect(nearest?.timestamp).toBe(BASE + 240);
    expect(nearest?.rows.map((r) => r.window)).toEqual(["5h", "week-all", "week-fable"]);
    expect(nearest?.activity.map((a) => a.model)).toEqual(["Claude Fable", "Claude Opus"]);
  });

  it("Fable 那条线只归 Fable 的活动", () => {
    const fableMarker = projection.markerData.find((d) => d.window === "week-fable" && d.activity.length > 0);
    expect(fableMarker?.activity.map((a) => a.model)).toEqual(["Claude Fable"]);
  });

  it("掉量按新→旧排，时长至少一分钟", () => {
    expect(projection.dropEvents.every((d) => d.drop === 1 || d.drop === 0.5)).toBe(true);
    expect(projection.dropEvents[0].timestamp).toBe(BASE + 180);
    expect(projection.dropEvents.map((d) => d.durationMinutes)).toEqual([1, 1, 1]);
  });
});

describe("每天用掉多少额度（issue #85）", () => {
  const calendar = fixedOffsetCalendar(0);
  const day = BASE - (BASE % 86_400);
  const hour = 3600;

  it("下降累加、上升不抵扣、回满单独计数、跨零点的空档标约", () => {
    const points = [
      // 第一天：00:30 采到 23:30，82 → 75，用掉 7 个点
      codexPoint(day + hour / 2, 82), codexPoint(day + 10 * hour, 80), codexPoint(day + 23 * hour + hour / 2, 75),
      // 第二天：75 → 72，回满到 97，再用到 90；中间 90 → 91 不算回满也不抵扣
      codexPoint(day + 24 * hour + hour / 2, 75), codexPoint(day + 30 * hour, 72), codexPoint(day + 31 * hour, 97),
      codexPoint(day + 40 * hour, 90), codexPoint(day + 41 * hour, 91), codexPoint(day + 47 * hour + hour / 2, 88),
      // 第三天：只在下午有采样，前一晚到中午的下降都记在这天，标「约」
      codexPoint(day + 62 * hour, 85),
    ];
    const rows = QuotaHistoryProjection.dailyConsumption(points, QUOTA_HISTORY_TOOLS.codex, calendar);
    expect(rows.length).toBe(3);
    expect(rows[2].consumed).toBe(7);
    expect(rows[2].refills).toBe(0);
    expect(rows[2].isComplete).toBe(true);
    expect(rows[1].consumed).toBe(3 + 7 + 3);
    expect(rows[1].refills).toBe(1);
    expect(rows[1].isComplete).toBe(true);
    expect(rows[0].consumed).toBe(3);
    expect(rows[0].isComplete).toBe(false);
  });

  it("夜里没用：空档里额度没动，两天都说得准", () => {
    const rows = QuotaHistoryProjection.dailyConsumption([
      codexPoint(day + hour / 2, 60), codexPoint(day + 18 * hour, 55),
      codexPoint(day + 34 * hour, 55), codexPoint(day + 40 * hour, 50),
    ], QUOTA_HISTORY_TOOLS.codex, calendar);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.isComplete)).toBe(true);
    expect(rows.map((r) => r.consumed)).toEqual([5, 5]);
  });

  it("最早那天之前没有记录，开头缺采样时说不准", () => {
    const rows = QuotaHistoryProjection.dailyConsumption([
      codexPoint(day + 12 * hour, 60), codexPoint(day + 20 * hour, 55),
    ], QUOTA_HISTORY_TOOLS.codex, calendar);
    expect(rows.length).toBe(1);
    expect(rows[0].isComplete).toBe(false);
  });
});

describe("面板帧组装（对应 makeFrame）", () => {
  const hour = 3600;
  const points = [
    claudePoint(BASE - 30 * hour, 90, 90, 90, []),
    claudePoint(BASE - 20 * hour, 70, 80, 70, [{ model: "Claude Opus", tokenDelta: 500 }]),
    claudePoint(BASE - 2 * hour, 40, 60, 50, []),
    claudePoint(BASE - hour, 30, 55, 45, []),
  ];

  it("跨度只认表里那几档，别的值一律退回默认档", () => {
    expect(normalizeQuotaSpan(168)).toBe(168);
    expect(normalizeQuotaSpan("24")).toBe(24);
    expect(normalizeQuotaSpan(999)).toBe(DEFAULT_QUOTA_HISTORY_SPAN);
    expect(normalizeQuotaSpan(undefined)).toBe(DEFAULT_QUOTA_HISTORY_SPAN);
    expect(normalizeQuotaSpan("abc")).toBe(DEFAULT_QUOTA_HISTORY_SPAN);
  });

  it("一帧里两个工具都算好，换工具不用重新取数", () => {
    const frame = buildQuotaHistoryFrame(points.slice(2), points, 24, BASE);
    expect(frame.tools.map((t) => t.id)).toEqual(["claude", "codex"]);
    expect(frame.tools[0].windowNames).toEqual(["5h", "week-all", "week-fable"]);
    expect(frame.tools[1].windowNames).toEqual(["week"]);
    expect(frame).toMatchObject({ span: 24, start: BASE - 24 * hour, end: BASE, sampleCount: 2 });
    expect(frame.tools[0].chart.lineData.length).toBeGreaterThan(0);
    expect(frame.tools[0].chart.markerData.length).toBeGreaterThan(0);
  });

  it("按天消耗吃全量历史，不跟着跨度切片", () => {
    const ranged = points.filter((p) => p.timestamp >= BASE - 2 * hour);
    const frame = buildQuotaHistoryFrame(ranged, points, 2, BASE);
    expect(frame.sampleCount).toBe(ranged.length);
    const curveDays = new Set(frame.tools[0].chart.hoverSamples.map((s) => Math.floor(s.timestamp / 86_400)));
    const dailyDays = new Set(frame.tools[0].daily.map((r) => r.dayStart));
    expect(dailyDays.size).toBeGreaterThan(curveDays.size);
  });
});

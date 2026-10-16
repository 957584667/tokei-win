/**
 * 额度曲线的预计算层：对应 QuotaHistoryStore.swift 里的 QuotaHistoryProjection。
 *
 * 每个刷新周期把「原始分钟快照」一次性换算成图表要用的东西：折线点（平台段压实）、
 * 标记点、掉量事件、模型活动、hover 采样，外加按本地自然日汇总的额度消耗（issue #85）。
 * 放在主进程算，渲染进程只做像素换算，这样同一份曲线逻辑全项目只有一处。
 */
import type { QuotaHistoryPoint, QuotaModelActivity } from "../main/quotaHistory";

export type QuotaHistoryToolId = "claude" | "codex";

/**
 * 窗口是数据的键、不是文案：macOS 用中文字面量当键（Swift 侧标 l10n-ignore）、
 * 显示时再过 L()。Windows 版把标识与文案拆开，id 保持稳定并写进历史 JSON 的系列键，
 * 文案留给界面按语言映射。
 */
export type QuotaWindow = "5h" | "week-all" | "week-fable" | "week";

export interface QuotaHistoryTool {
  id: QuotaHistoryToolId;
  /** 对应 Swift 的 rawValue，也是曲线页的工具标题 */
  rawValue: string;
  windowNames: QuotaWindow[];
}

export const QUOTA_HISTORY_TOOLS: Record<QuotaHistoryToolId, QuotaHistoryTool> = {
  claude: { id: "claude", rawValue: "Claude Code", windowNames: ["5h", "week-all", "week-fable"] },
  codex: { id: "codex", rawValue: "Codex", windowNames: ["week"] },
};

export const QUOTA_HISTORY_TOOL_ORDER: QuotaHistoryTool[] = [QUOTA_HISTORY_TOOLS.claude, QUOTA_HISTORY_TOOLS.codex];

/**
 * 对应 QuotaHistorySpan 的原始值（小时）：1/6/24 小时、1 周、1 月、1 年。
 * 快照只留 7 天，所以月/年这两档不画曲线，改画按天消耗。
 */
export const QUOTA_HISTORY_SPANS: number[] = [1, 6, 24, 168, 720, 8760];
export const DEFAULT_QUOTA_HISTORY_SPAN = 24;

export interface QuotaChartDatum {
  timestamp: number;
  remaining: number;
  window: QuotaWindow;
  activity: QuotaModelActivity[];
  id: string;
}

export interface QuotaDropEvent {
  timestamp: number;
  durationMinutes: number;
  window: QuotaWindow;
  drop: number;
  activity: QuotaModelActivity[];
  id: string;
}

export interface QuotaActivityEvent {
  timestamp: number;
  activity: QuotaModelActivity[];
}

export interface QuotaHoverRow {
  window: QuotaWindow;
  remaining: number;
}

export interface QuotaHoverSample {
  timestamp: number;
  rows: QuotaHoverRow[];
  activity: QuotaModelActivity[];
  id: number;
}

/** 某个本地自然日里，一个额度窗口被用掉了多少个百分点（issue #85） */
export interface QuotaDailyConsumption {
  dayStart: number;
  window: QuotaWindow;
  /** 当天所有下降量之和。回满、滚动窗口里旧用量过期造成的上升都不抵扣 */
  consumed: number;
  /** 当天回满的次数（一次上升至少 refillThreshold 个百分点才算） */
  refills: number;
  /** 这天的数说得准。空档跨零点且期间确实掉了额度时说不清归属，界面标「约」 */
  isComplete: boolean;
  id: string;
}

/** 把 Calendar.current / TimeZone(secondsFromGMT:) 的两件事抽出来，好让测试能钉住时区 */
export interface DayCalendar {
  dayStart(timestamp: number): number;
  nextDayStart(dayStart: number): number;
}

export const localCalendar: DayCalendar = {
  dayStart(timestamp) {
    const d = new Date(timestamp * 1000);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  },
  nextDayStart(dayStart) {
    const d = new Date(dayStart * 1000);
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  },
};

/** 固定 UTC 偏移的日历；偏移 0 就是测试里那个 TimeZone(secondsFromGMT: 0) */
export function fixedOffsetCalendar(offsetSeconds: number): DayCalendar {
  const dayStart = (timestamp: number) => Math.floor((timestamp + offsetSeconds) / 86400) * 86400 - offsetSeconds;
  return { dayStart, nextDayStart: (start) => start + 86400 };
}

function datumId(timestamp: number, window: QuotaWindow): string {
  return `${timestamp}:${window}`;
}

/**
 * 图表帧：投影里除去原始快照的那部分。
 * 保留 7 天的分钟快照能有一万个点，快照本身不必跟着投影再传一份给面板，
 * 界面要的「采样数」由调用侧给（对应 QuotaHistoryView 里的 projection.points.count）。
 */
export interface QuotaChartFrame {
  windowNames: QuotaWindow[];
  lineData: QuotaChartDatum[];
  markerData: QuotaChartDatum[];
  latestValues: Record<string, number>;
  latestDatumIDs: string[];
  dropEvents: QuotaDropEvent[];
  activityEvents: QuotaActivityEvent[];
  hoverSamples: QuotaHoverSample[];
}

/**
 * 一次算完，渲染侧对点数线性。平台段压实不丢任何额度变化、事件或分钟级 hover。
 */
export class QuotaHistoryProjection {
  readonly points: QuotaHistoryPoint[];
  readonly windowNames: QuotaWindow[];
  readonly lineData: QuotaChartDatum[];
  readonly markerData: QuotaChartDatum[];
  readonly latestValues: Record<string, number>;
  readonly latestDatumIDs: string[];
  readonly dropEvents: QuotaDropEvent[];
  readonly activityEvents: QuotaActivityEvent[];
  readonly hoverSamples: QuotaHoverSample[];

  constructor(points: QuotaHistoryPoint[], tool: QuotaHistoryTool) {
    const windows = tool.windowNames;
    this.points = points;
    this.windowNames = windows;

    const seriesByWindow = new Map<QuotaWindow, QuotaChartDatum[]>(windows.map((w) => [w, []]));
    const latestValues: Record<string, number> = {};
    const latestByWindow = new Map<QuotaWindow, QuotaChartDatum>();
    const drops: QuotaDropEvent[] = [];
    const previousByWindow = new Map<QuotaWindow, { point: QuotaHistoryPoint; remaining: number }>();
    const activityEvents: QuotaActivityEvent[] = [];
    const hoverSamples: QuotaHoverSample[] = [];

    for (const point of points) {
      const pointActivity = activityFor(point, tool);
      if (pointActivity.length > 0) {
        activityEvents.push({ timestamp: point.timestamp, activity: pointActivity });
      }

      const hoverRows: QuotaHoverRow[] = [];
      for (const window of windows) {
        const remaining = valueFor(window, point, tool);
        if (remaining === null) continue;
        const windowActivity = activityForWindow(point, window, tool);
        const datum: QuotaChartDatum = {
          timestamp: point.timestamp,
          remaining,
          window,
          activity: windowActivity,
          id: datumId(point.timestamp, window),
        };
        seriesByWindow.get(window)!.push(datum);
        latestValues[window] = remaining;
        latestByWindow.set(window, datum);
        hoverRows.push({ window, remaining });

        const previous = previousByWindow.get(window);
        if (previous) {
          const drop = previous.remaining - remaining;
          if (drop >= 0.05) {
            drops.push({
              timestamp: point.timestamp,
              durationMinutes: Math.max(1, Math.floor((point.timestamp - previous.point.timestamp) / 60)),
              window,
              drop,
              activity: windowActivity,
              id: datumId(point.timestamp, window),
            });
          }
        }
        previousByWindow.set(window, { point, remaining });
      }
      if (hoverRows.length > 0) {
        hoverSamples.push({
          timestamp: point.timestamp,
          rows: hoverRows,
          activity: pointActivity,
          id: Math.floor(point.timestamp / 60),
        });
      }
    }

    const latestDatums = [...latestByWindow.values()];
    const markerByID = new Map<string, QuotaChartDatum>(latestDatums.map((d) => [d.id, d]));
    const lineData: QuotaChartDatum[] = [];
    for (const window of windows) {
      const series = seriesByWindow.get(window) ?? [];
      lineData.push(...compactFlatSegments(series));

      let previousActivitySignature: string | null = null;
      for (const datum of series) {
        const signature = activitySignature(datum.activity);
        if (signature !== null && signature !== previousActivitySignature) markerByID.set(datum.id, datum);
        previousActivitySignature = signature;
      }
    }

    this.latestValues = latestValues;
    this.latestDatumIDs = latestDatums.map((d) => d.id);
    this.lineData = lineData;
    this.markerData = [...markerByID.values()].sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return indexOf(windows, a.window) - indexOf(windows, b.window);
    });
    this.dropEvents = drops.sort((a, b) => b.timestamp - a.timestamp);
    this.activityEvents = activityEvents.reverse();
    this.hoverSamples = hoverSamples;
  }

  /**
   * 对应 nearestHoverSample(to:)：二分找最近的采样分钟。写成静态的，好让
   * 拿着同一份帧数据的调用方（面板那边）复用而不必重算投影。
   */
  static nearestHoverSample(samples: QuotaHoverSample[], timestamp: number): QuotaHoverSample | null {
    if (samples.length === 0) return null;
    let lower = 0;
    let upper = samples.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (samples[middle].timestamp < timestamp) lower = middle + 1;
      else upper = middle;
    }
    if (lower === 0) return samples[0];
    if (lower === samples.length) return samples[samples.length - 1];
    const before = samples[lower - 1];
    const after = samples[lower];
    return Math.abs(before.timestamp - timestamp) <= Math.abs(after.timestamp - timestamp) ? before : after;
  }

  nearestHoverSample(timestamp: number): QuotaHoverSample | null {
    return QuotaHistoryProjection.nearestHoverSample(this.hoverSamples, timestamp);
  }

  /** 交给面板的那份（不含原始快照） */
  chartFrame(): QuotaChartFrame {
    return {
      windowNames: this.windowNames,
      lineData: this.lineData,
      markerData: this.markerData,
      latestValues: this.latestValues,
      latestDatumIDs: this.latestDatumIDs,
      dropEvents: this.dropEvents,
      activityEvents: this.activityEvents,
      hoverSamples: this.hoverSamples,
    };
  }

  /**
   * 按本地自然日汇总每个窗口剩余额度的下降量，新 → 旧（issue #85）。
   *
   * 只用本机已有的分钟快照，不多发任何请求。相邻两个快照之间：下降记为消耗、
   * 记在后一个快照所在的那天；上升不抵扣（Claude 周额度是滚动窗口，旧用量过期时
   * 剩余会慢慢回升，那不是「没用」），一次升够 refillThreshold 才算回满。
   * 只有空档跨过零点、期间又确实掉了额度、且落在离当天首尾超过 edgeTolerance 的位置，
   * 才给受影响的那天标「约」；最早那天之前本来就没记录，它开头缺采样时也标「约」。
   */
  static dailyConsumption(
    points: QuotaHistoryPoint[],
    tool: QuotaHistoryTool,
    calendar: DayCalendar = localCalendar,
    refillThreshold: number = 10,
    edgeTolerance: number = 2 * 3600,
  ): QuotaDailyConsumption[] {
    interface Day {
      consumed: number;
      refills: number;
      first: number;
      last: number;
      uncertain: boolean;
    }
    const days = new Map<QuotaWindow, Map<number, Day>>();
    const previous = new Map<QuotaWindow, { value: number; timestamp: number }>();

    for (const point of [...points].sort((a, b) => a.timestamp - b.timestamp)) {
      const today = calendar.dayStart(point.timestamp);
      for (const window of tool.windowNames) {
        const remaining = valueFor(window, point, tool);
        if (remaining === null) continue;
        let dayMap = days.get(window);
        if (!dayMap) { dayMap = new Map(); days.set(window, dayMap); }
        let day = dayMap.get(today);
        if (!day) day = { consumed: 0, refills: 0, first: Number.MAX_SAFE_INTEGER, last: Number.MIN_SAFE_INTEGER, uncertain: false };
        day.first = Math.min(day.first, point.timestamp);
        day.last = Math.max(day.last, point.timestamp);
        const prior = previous.get(window);
        if (prior) {
          if (remaining < prior.value) {
            day.consumed += prior.value - remaining;
            const priorDay = calendar.dayStart(prior.timestamp);
            if (priorDay !== today) {
              // 这次下降跨过了零点：离当天开头太远，可能有一部分属于前一天
              if (point.timestamp - today > edgeTolerance) day.uncertain = true;
              const priorEnd = calendar.nextDayStart(priorDay);
              if (priorEnd - prior.timestamp > edgeTolerance) {
                const target = dayMap.get(priorDay);
                if (target) target.uncertain = true;
              }
            }
          } else if (remaining - prior.value >= refillThreshold) {
            day.refills += 1;
          }
        }
        dayMap.set(today, day);
        previous.set(window, { value: remaining, timestamp: point.timestamp });
      }
    }

    const rows: QuotaDailyConsumption[] = [];
    for (const [window, byDay] of days) {
      const oldest = Math.min(...byDay.keys());
      for (const [start, day] of byDay) {
        const missingHistory = start === oldest && day.first - start > edgeTolerance;
        rows.push({
          dayStart: start,
          window,
          consumed: day.consumed,
          refills: day.refills,
          isComplete: !day.uncertain && !missingHistory,
          id: `${start}:${window}`,
        });
      }
    }
    return rows.sort((a, b) => {
      if (a.dayStart !== b.dayStart) return b.dayStart - a.dayStart;
      return indexOf(tool.windowNames, a.window) - indexOf(tool.windowNames, b.window);
    });
  }
}

/** 界面传来的跨度只认 QUOTA_HISTORY_SPANS 里那几档，别的值一律退回默认档 */
export function normalizeQuotaSpan(rawSpan: unknown): number {
  const wanted = Number(rawSpan);
  return QUOTA_HISTORY_SPANS.includes(wanted) ? wanted : DEFAULT_QUOTA_HISTORY_SPAN;
}

export interface QuotaHistoryToolFrame {
  id: QuotaHistoryToolId;
  title: string;
  windowNames: QuotaWindow[];
  chart: QuotaChartFrame;
  daily: QuotaDailyConsumption[];
}

export interface QuotaHistoryFrame {
  span: number;
  start: number;
  end: number;
  sampleCount: number;
  tools: QuotaHistoryToolFrame[];
}

/**
 * 对应 QuotaHistoryView 的 makeFrame()：跨度之内的快照喂曲线，
 * 按天消耗取本机留着的全量历史（最多 7 天），不跟着跨度走，
 * 否则选 24h 时只剩今天和半个昨天。两个工具都算好放进同一帧，
 * 换工具因此不用重新取数。
 */
export function buildQuotaHistoryFrame(
  rangedPoints: QuotaHistoryPoint[],
  allPoints: QuotaHistoryPoint[],
  span: number,
  end: number,
): QuotaHistoryFrame {
  return {
    span,
    start: end - span * 3600,
    end,
    sampleCount: rangedPoints.length,
    tools: QUOTA_HISTORY_TOOL_ORDER.map((tool) => ({
      id: tool.id,
      title: tool.rawValue,
      windowNames: tool.windowNames,
      chart: new QuotaHistoryProjection(rangedPoints, tool).chartFrame(),
      daily: QuotaHistoryProjection.dailyConsumption(allPoints, tool),
    })),
  };
}

/**
 * 保留每次数值变化的两侧端点加首尾采样，让阶梯图视觉上依旧精确，
 * 同时不再为分钟级的平台段画出上百个重复标记。
 */
function compactFlatSegments(series: QuotaChartDatum[]): QuotaChartDatum[] {
  if (series.length <= 2) return series;
  const compacted: QuotaChartDatum[] = [series[0]];
  for (let index = 1; index < series.length - 1; index++) {
    const previous = series[index - 1];
    const current = series[index];
    const next = series[index + 1];
    if (current.remaining !== previous.remaining || current.remaining !== next.remaining) {
      compacted.push(current);
    }
  }
  compacted.push(series[series.length - 1]);
  return compacted;
}

function activitySignature(activity: QuotaModelActivity[]): string | null {
  if (activity.length === 0) return null;
  const models = activity
    .map((a) => a.model.trim().toLowerCase())
    .filter((m) => m.length > 0)
    .sort();
  if (models.length === 0) return null;
  return models.join("\u{1F}");
}

function activityFor(point: QuotaHistoryPoint, tool: QuotaHistoryTool): QuotaModelActivity[] {
  return tool.id === "claude" ? point.claudeActivity : point.codexActivity;
}

function activityForWindow(
  point: QuotaHistoryPoint,
  window: QuotaWindow,
  tool: QuotaHistoryTool,
): QuotaModelActivity[] {
  const all = activityFor(point, tool);
  if (tool.id !== "claude" || window !== "week-fable") return all;
  return all.filter((a) => a.model.toLowerCase().includes("fable"));
}

/** 对应 value(for:point:tool:)：工具和窗口不匹配、或那次没有读数时返回 null */
export function valueFor(
  window: QuotaWindow,
  point: QuotaHistoryPoint,
  tool: QuotaHistoryTool,
): number | null {
  if (tool.id === "claude") {
    switch (window) {
      case "5h": return point.claudeFiveHourRemaining;
      case "week-all": return point.claudeWeekRemaining;
      case "week-fable": return point.claudeFableWeekRemaining;
      default: return null;
    }
  }
  return window === "week" ? point.codexWeekRemaining : null;
}

function indexOf(list: QuotaWindow[], value: QuotaWindow): number {
  const i = list.indexOf(value);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

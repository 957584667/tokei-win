/**
 * 额度曲线的数据层：对应 QuotaHistoryStore.swift。
 *
 * 只吃本机已经扫出来的读数（claude q5/q7/qf、codex pw 与今日各模型累计 token），
 * 不发任何请求：每分钟存一个快照点，同一分钟内的多次刷新合并成一点，模型活动按
 * 「当天基线」算增量，保留 168 小时。JSON 键名与 macOS 版完全一致（驼峰、同一套
 * 字段），所以从 macOS 迁移过来的旧档能直接读；macOS 那句 0o600 在 NTFS 上没有
 * 对应物，权限由 %USERPROFILE%\.tokei 的目录 ACL 承担。
 */
import * as path from "path";
import { TOKEI_DIR, loadJson, saveJson } from "../core/paths";

export const QUOTA_HISTORY_FILE = path.join(TOKEI_DIR, "quota_history.json");

/** 对应 QuotaHistoryState.version：结构变了整份作废，不能半读半写 */
const STATE_VERSION = 1;
const DEFAULT_RETENTION_HOURS = 24 * 7;

export interface QuotaModelActivity {
  model: string;
  tokenDelta: number;
}

export interface QuotaHistoryPoint {
  timestamp: number;
  claudeFiveHourRemaining: number | null;
  claudeWeekRemaining: number | null;
  claudeFableWeekRemaining: number | null;
  codexWeekRemaining: number | null;
  claudeActivity: QuotaModelActivity[];
  codexActivity: QuotaModelActivity[];
}

/** 对应 QuotaCapture：一次刷新能给出的额度读数 + 当天各模型的 token 总量 */
export interface QuotaCapture {
  claudeFiveHourRemaining?: number | null;
  claudeWeekRemaining?: number | null;
  claudeFableWeekRemaining?: number | null;
  codexWeekRemaining?: number | null;
  claudeModelTotals?: Record<string, number>;
  codexModelTotals?: Record<string, number>;
}

interface QuotaHistoryState {
  version: number;
  points: QuotaHistoryPoint[];
  lastClaudeModelTotals: Record<string, number>;
  lastCodexModelTotals: Record<string, number>;
  hasClaudeBaseline: boolean;
  hasCodexBaseline: boolean;
  claudeBaselineDay: number | null;
  codexBaselineDay: number | null;
}

function emptyState(): QuotaHistoryState {
  return {
    version: STATE_VERSION,
    points: [],
    lastClaudeModelTotals: {},
    lastCodexModelTotals: {},
    hasClaudeBaseline: false,
    hasCodexBaseline: false,
    claudeBaselineDay: null,
    codexBaselineDay: null,
  };
}

/** 本地自然日零点（秒）。Calendar.current.startOfDay 的等价物。 */
function dayStartEpoch(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function number(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 对应 mergeActivity 的排序：增量大的在前，同增量按模型名字典序 */
function compareActivity(a: QuotaModelActivity, b: QuotaModelActivity): number {
  if (a.tokenDelta !== b.tokenDelta) return b.tokenDelta - a.tokenDelta;
  return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
}

function sameActivity(a: QuotaModelActivity[], b: QuotaModelActivity[]): boolean {
  return a.length === b.length && a.every((x, i) => x.model === b[i].model && x.tokenDelta === b[i].tokenDelta);
}

function samePoint(a: QuotaHistoryPoint, b: QuotaHistoryPoint): boolean {
  return a.timestamp === b.timestamp
    && a.claudeFiveHourRemaining === b.claudeFiveHourRemaining
    && a.claudeWeekRemaining === b.claudeWeekRemaining
    && a.claudeFableWeekRemaining === b.claudeFableWeekRemaining
    && a.codexWeekRemaining === b.codexWeekRemaining
    && sameActivity(a.claudeActivity, b.claudeActivity)
    && sameActivity(a.codexActivity, b.codexActivity);
}

/** 字典内容比较，不看键序（Swift 的 [String: Int] == 就是这个语义） */
function sameTotals(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

function isEmptyTotals(totals: Record<string, number>): boolean {
  return Object.keys(totals).length === 0;
}

/** 读取并归一化：macOS 的编码器会省略 nil 键，所以缺键要补成 null，数组要补成 [] */
function normalizePoint(raw: any): QuotaHistoryPoint {
  const activity = (list: any): QuotaModelActivity[] =>
    Array.isArray(list)
      ? list
        .filter((x: any) => x && typeof x.model === "string" && typeof x.tokenDelta === "number")
        .map((x: any) => ({ model: x.model, tokenDelta: x.tokenDelta }))
      : [];
  return {
    timestamp: Math.floor(number(raw?.timestamp) ?? 0),
    claudeFiveHourRemaining: number(raw?.claudeFiveHourRemaining),
    claudeWeekRemaining: number(raw?.claudeWeekRemaining),
    claudeFableWeekRemaining: number(raw?.claudeFableWeekRemaining),
    codexWeekRemaining: number(raw?.codexWeekRemaining),
    claudeActivity: activity(raw?.claudeActivity),
    codexActivity: activity(raw?.codexActivity),
  };
}

function loadState(file: string): QuotaHistoryState {
  const decoded = loadJson<any>(file, null as any);
  if (!decoded) return emptyState();
  if (decoded.version !== STATE_VERSION) {
    console.error(`[tokei] 额度历史版本不支持: ${decoded.version}`);
    return emptyState();
  }
  const totals = (v: any): Record<string, number> => {
    if (!v || typeof v !== "object") return {};
    const out: Record<string, number> = {};
    for (const [model, raw] of Object.entries<any>(v)) {
      const n = number(raw);
      if (n !== null) out[model] = n;
    }
    return out;
  };
  return {
    version: STATE_VERSION,
    points: Array.isArray(decoded.points) ? decoded.points.map(normalizePoint) : [],
    lastClaudeModelTotals: totals(decoded.lastClaudeModelTotals),
    lastCodexModelTotals: totals(decoded.lastCodexModelTotals),
    hasClaudeBaseline: Boolean(decoded.hasClaudeBaseline),
    hasCodexBaseline: Boolean(decoded.hasCodexBaseline),
    claudeBaselineDay: number(decoded.claudeBaselineDay),
    codexBaselineDay: number(decoded.codexBaselineDay),
  };
}

export class QuotaHistoryStore {
  readonly points: QuotaHistoryPoint[];
  private state: QuotaHistoryState;
  private readonly retentionSeconds: number;

  constructor(
    private readonly file: string = QUOTA_HISTORY_FILE,
    retentionHours: number = DEFAULT_RETENTION_HOURS,
  ) {
    this.retentionSeconds = Math.max(24, retentionHours) * 60 * 60;
    this.state = loadState(this.file);
    this.points = this.state.points.slice().sort((a, b) => a.timestamp - b.timestamp);
  }

  /** 对应 record(_:at:) */
  record(capture: QuotaCapture, at: Date = new Date()): void {
    const minute = Math.floor(at.getTime() / 1000 / 60) * 60;
    const day = dayStartEpoch(at);
    const cutoff = minute - this.retentionSeconds;
    let changed = false;

    const retained = this.points.filter((p) => p.timestamp >= cutoff);
    if (retained.length !== this.points.length) {
      this.points.length = 0;
      this.points.push(...retained);
      changed = true;
    }

    const claudeBaseline = prepareBaseline(
      this.state.lastClaudeModelTotals, this.state.hasClaudeBaseline, this.state.claudeBaselineDay, day);
    const codexBaseline = prepareBaseline(
      this.state.lastCodexModelTotals, this.state.hasCodexBaseline, this.state.codexBaselineDay, day);
    const claudeActivity = diffActivity(
      capture.claudeModelTotals ?? {}, claudeBaseline.previous, claudeBaseline.hasBaseline);
    const codexActivity = diffActivity(
      capture.codexModelTotals ?? {}, codexBaseline.previous, codexBaseline.hasBaseline);

    const nextClaude = updatedBaseline(
      capture.claudeModelTotals ?? {}, claudeBaseline, this.state.claudeBaselineDay, day);
    this.state.lastClaudeModelTotals = nextClaude.totals;
    this.state.hasClaudeBaseline = nextClaude.hasBaseline;
    this.state.claudeBaselineDay = nextClaude.day;

    const nextCodex = updatedBaseline(
      capture.codexModelTotals ?? {}, codexBaseline, this.state.codexBaselineDay, day);
    this.state.lastCodexModelTotals = nextCodex.totals;
    this.state.hasCodexBaseline = nextCodex.hasBaseline;
    this.state.codexBaselineDay = nextCodex.day;

    const incoming: QuotaHistoryPoint = {
      timestamp: minute,
      claudeFiveHourRemaining: clampRemaining(capture.claudeFiveHourRemaining),
      claudeWeekRemaining: clampRemaining(capture.claudeWeekRemaining),
      claudeFableWeekRemaining: clampRemaining(capture.claudeFableWeekRemaining),
      codexWeekRemaining: clampRemaining(capture.codexWeekRemaining),
      claudeActivity,
      codexActivity,
    };

    const hasUsefulData = incoming.claudeFiveHourRemaining !== null
      || incoming.claudeWeekRemaining !== null
      || incoming.claudeFableWeekRemaining !== null
      || incoming.codexWeekRemaining !== null
      || incoming.claudeActivity.length > 0
      || incoming.codexActivity.length > 0;

    if (hasUsefulData) {
      const last = this.points[this.points.length - 1];
      if (last && last.timestamp === minute) {
        const merged = mergePoint(last, incoming);
        if (!samePoint(merged, last)) {
          this.points[this.points.length - 1] = merged;
          changed = true;
        }
      } else {
        this.points.push(incoming);
        changed = true;
      }
    }

    if (changed || nextClaude.changed || nextCodex.changed) {
      this.state.points = this.points;
      this.save();
    }
  }

  /** 对应 points(since:) */
  pointsSince(since: Date): QuotaHistoryPoint[] {
    const cutoff = Math.floor(since.getTime() / 1000);
    return this.points.filter((p) => p.timestamp >= cutoff);
  }

  private save(): void {
    if (!saveJson(this.file, this.state)) {
      console.error(`[tokei] 额度历史写入失败: ${this.file}`);
    }
  }
}

/** 对应 normalized(_:)：NaN/Inf 一律丢弃，读数夹在 0..100 */
function clampRemaining(value: number | null | undefined): number | null {
  const v = number(value);
  if (v === null) return null;
  return Math.min(100, Math.max(0, v));
}

/** 对应 activity(current:previous:hasBaseline:) */
function diffActivity(
  current: Record<string, number>,
  previous: Record<string, number>,
  hasBaseline: boolean,
): QuotaModelActivity[] {
  if (!hasBaseline) return [];
  return Object.entries(current)
    .map(([model, total]) => ({ model, tokenDelta: total - (previous[model] ?? 0) }))
    .filter((a) => a.tokenDelta > 0)
    .sort(compareActivity);
}

/** 对应 prepareBaseline：换天就当作没有基线，别让昨天的总量吃掉今天的增量 */
function prepareBaseline(
  previous: Record<string, number>,
  hasBaseline: boolean,
  baselineDay: number | null,
  currentDay: number,
): { previous: Record<string, number>; hasBaseline: boolean; dayChanged: boolean } {
  const dayChanged = baselineDay !== null && baselineDay !== currentDay;
  if (dayChanged) return { previous: {}, hasBaseline: false, dayChanged: true };
  return { previous, hasBaseline, dayChanged: false };
}

/** 对应 updatedBaseline */
function updatedBaseline(
  current: Record<string, number>,
  prepared: { previous: Record<string, number>; hasBaseline: boolean; dayChanged: boolean },
  existingDay: number | null,
  currentDay: number,
): { totals: Record<string, number>; hasBaseline: boolean; day: number | null; changed: boolean } {
  // 顶层刷新成功也可能带着一个空区间（某个扫描器挂了）。同一天非空的基线要留着，
  // 否则恢复后的第一次增量会把「整天用量」算到一分钟头上。
  const shouldReplace = prepared.dayChanged || !prepared.hasBaseline
    || !isEmptyTotals(current) || isEmptyTotals(prepared.previous);
  if (!shouldReplace) {
    return { totals: prepared.previous, hasBaseline: prepared.hasBaseline, day: existingDay, changed: false };
  }
  const changed = !sameTotals(prepared.previous, current)
    || !prepared.hasBaseline || existingDay !== currentDay;
  return { totals: current, hasBaseline: true, day: currentDay, changed };
}

/** 对应 merge：读数取最后一次，活动量累加 */
function mergePoint(existing: QuotaHistoryPoint, incoming: QuotaHistoryPoint): QuotaHistoryPoint {
  return {
    timestamp: existing.timestamp,
    claudeFiveHourRemaining: incoming.claudeFiveHourRemaining ?? existing.claudeFiveHourRemaining,
    claudeWeekRemaining: incoming.claudeWeekRemaining ?? existing.claudeWeekRemaining,
    claudeFableWeekRemaining: incoming.claudeFableWeekRemaining ?? existing.claudeFableWeekRemaining,
    codexWeekRemaining: incoming.codexWeekRemaining ?? existing.codexWeekRemaining,
    claudeActivity: mergeActivity(existing.claudeActivity, incoming.claudeActivity),
    codexActivity: mergeActivity(existing.codexActivity, incoming.codexActivity),
  };
}

function mergeActivity(
  existing: QuotaModelActivity[],
  incoming: QuotaModelActivity[],
): QuotaModelActivity[] {
  const totals: Record<string, number> = {};
  for (const a of existing) totals[a.model] = (totals[a.model] ?? 0) + a.tokenDelta;
  for (const a of incoming) totals[a.model] = (totals[a.model] ?? 0) + a.tokenDelta;
  return Object.entries(totals)
    .map(([model, tokenDelta]) => ({ model, tokenDelta }))
    .sort(compareActivity);
}

/**
 * 对应 main.swift 的 recordQuotaHistory：额度存「剩余百分比」（100 - 已用），
 * 读数过期（*_stale）就不写这一项，免得曲线画出一段假的平台。
 * 模型总量取今日区间每行 in+out+cr+cw（不含 reason），Claude 侧剔掉「合成」行。
 */
export function captureFromPayload(payload: Record<string, any>): QuotaCapture {
  return {
    claudeFiveHourRemaining: remaining(payload, "claude", "q5", "q5_stale"),
    claudeWeekRemaining: remaining(payload, "claude", "q7", "q7_stale"),
    claudeFableWeekRemaining: remaining(payload, "claude", "qf", "qf_stale"),
    codexWeekRemaining: remaining(payload, "codex", "pw", "pw_stale"),
    claudeModelTotals: modelTotals(payload, "claude"),
    codexModelTotals: modelTotals(payload, "codex"),
  };
}

function remaining(payload: Record<string, any>, tool: string, key: string, staleKey: string): number | null {
  const node = payload?.[tool] ?? {};
  if (node[staleKey] === true) return null;
  const used = number(node[key]);
  return used === null ? null : 100 - used;
}

function modelTotals(payload: Record<string, any>, tool: string): Record<string, number> {
  const rows: any[] = payload?.[tool]?.ranges?.today?.models ?? [];
  const out: Record<string, number> = {};
  for (const row of rows) {
    const name = typeof row?.name === "string" ? row.name : "";
    if (!name || (tool === "claude" && name === "合成")) continue;
    out[name] = (out[name] ?? 0) + (Number(row?.in) || 0) + (Number(row?.out) || 0)
      + (Number(row?.cr) || 0) + (Number(row?.cw) || 0);
  }
  return out;
}

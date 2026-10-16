/**
 * 时间区间与展示口径：对应 usage.30s.py 的 RANGE_KEYS / range_bounds /
 * range_boundaries / classify / classify_date / parse_ts / human / nice_model。
 */

export const RANGE_KEYS = ["today", "yesterday", "week", "last_week", "month", "year", "all"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

/** Python 用本地日期比较，ISO 日期串可按字典序比较。 */
export interface Bounds {
  today: string;
  yesterday: string;
  week: string;
  last_week: string;
  last_week_end: string;
  month: string;
  year: string;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function hourKey(d: Date): number {
  return d.getHours();
}

/** 把 YYYY-MM-DD 解析成本地零点 Date（用于区间比较与图表）。 */
export function parseDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function addDays(key: string, days: number): string {
  const d = parseDay(key);
  d.setDate(d.getDate() + days);
  return dayKey(d);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 对应 range_bounds()：本周从周一起算。 */
export function rangeBounds(now = new Date()): Bounds {
  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  // JS getDay(): 周日=0；Python weekday(): 周一=0
  const mondayOffset = today.getDay() === 0 ? 6 : today.getDay() - 1;
  const week = new Date(today);
  week.setDate(week.getDate() - mondayOffset);
  const lastWeek = new Date(week);
  lastWeek.setDate(lastWeek.getDate() - 7);
  return {
    today: dayKey(today),
    yesterday: dayKey(yesterday),
    week: dayKey(week),
    last_week: dayKey(lastWeek),
    last_week_end: dayKey(week),
    month: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`,
    year: `${today.getFullYear()}-01-01`,
  };
}

/** 对应 classify_date()：一条记录可同时命中多个区间。 */
export function classifyDay(day: string, b: Bounds): RangeKey[] {
  const ks: RangeKey[] = ["all"];
  if (day === b.today) ks.push("today");
  if (day === b.yesterday) ks.push("yesterday");
  if (day >= b.week) ks.push("week");
  if (day >= b.last_week && day < b.last_week_end) ks.push("last_week");
  if (day >= b.month) ks.push("month");
  if (day >= b.year) ks.push("year");
  return ks;
}

export function classifyDate(d: Date, b: Bounds): RangeKey[] {
  return classifyDay(dayKey(d), b);
}

/** 对应 range_boundaries()：多设备同步用的显式日期边界。 */
export function rangeBoundaries(b: Bounds): Record<string, { start: string | null; end: string | null }> {
  const nextMonth = (() => {
    const d = parseDay(b.month);
    return dayKey(new Date(d.getFullYear(), d.getMonth() + 1, 1));
  })();
  const nextYear = `${Number(b.year.slice(0, 4)) + 1}-01-01`;
  return {
    today: { start: b.today, end: addDays(b.today, 1) },
    yesterday: { start: b.yesterday, end: b.today },
    week: { start: b.week, end: addDays(b.week, 7) },
    last_week: { start: b.last_week, end: b.week },
    month: { start: b.month, end: nextMonth },
    year: { start: b.year, end: nextYear },
    all: { start: null, end: null },
  };
}

export interface Timestamp {
  date: Date;
  day: string;
  hour: number;
  epoch: number;
}

/**
 * 对应 parse_ts()：接受 ISO 8601（含 Z / 带偏移 / 裸本地时间）与数字秒/毫秒。
 * 解析失败返回 null。所有下游统计都按本地时区取日和小时。
 */
export function parseTs(raw: unknown): Timestamp | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return fromEpoch(raw);
  const text = String(raw).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return fromEpoch(Number(text));
  const normalized = text.replace(" ", "T").replace(/(\d)Z$/i, "$1+00:00");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return { date, day: dayKey(date), hour: date.getHours(), epoch: date.getTime() / 1000 };
}

function fromEpoch(value: number): Timestamp | null {
  // 与 Python 侧一致：绝对值大于 1e11 视为毫秒
  const seconds = Math.abs(value) >= 100_000_000_000 ? value / 1000 : value;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return { date, day: dayKey(date), hour: date.getHours(), epoch: seconds };
}

/** 对应 human()：1.2M / 340K / 42 */
export function human(n: number): string {
  const value = Number(n) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
}

const GPT_VARIANTS: Array<[RegExp, string]> = [
  [/(?:^|[-_/ ])astra(?:$|[-_/ ])/, "Astra"],
  [/(?:^|[-_/ ])sol(?:$|[-_/ ])/, "Sol"],
  [/(?:^|[-_/ ])luna(?:$|[-_/ ])/, "Luna"],
  [/(?:^|[-_/ ])terra(?:$|[-_/ ])/, "Terra"],
  [/(?:^|[-_/ ])mini(?:$|[-_/ ])/, "Mini"],
  [/(?:^|[-_/ ])pro(?:$|[-_/ ])/, "Pro"],
];

/** 对应 nice_model()：把 canonical id 变成展示名。 */
export function niceModel(m?: string | null): string {
  if (!m || m === "<synthetic>") return "合成";
  if (m === "unknown") return "未知";
  const s = m.toLowerCase();
  for (const [key, disp] of [["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]] as const) {
    if (!s.includes(key)) continue;
    const after = new RegExp(`${key}[-_ ]?(\\d{1,2})(?:[-.](\\d{1,2}))?(?!\\d)`);
    const before = new RegExp(`(\\d{1,2})(?:[-.](\\d{1,2}))?[-_ ]${key}`);
    const mt = s.match(after) ?? s.match(before);
    if (!mt) return disp;
    const major = mt[1];
    const minor = mt[2];
    return minor ? `${disp} ${major}.${minor}` : `${disp} ${major}`;
  }
  if (s.includes("gpt")) {
    if (/(?:^|[-_/ ])reserve(?:$|[-_/ ])/.test(s)) return "Luna Reserve";
    const version = s.match(/gpt[- ]?(\d+(?:\.\d+)?)/)?.[1] ?? "";
    const variants = GPT_VARIANTS.filter(([re]) => re.test(s)).map(([, label]) => label);
    const suffix = variants.length ? ` ${variants.join(" ")}` : "";
    return version ? `GPT-${version}${suffix}` : "GPT";
  }
  if (s.includes("mimo")) {
    const name = m.split("/").pop() ?? m;
    const version = name.replace(/^mimo[- ]?v?/i, "").trim();
    const parts = version.split("-").filter(Boolean);
    if (!parts.length) return "MiMo";
    const head = /^\d/.test(parts[0]) ? `MiMo-V${parts[0]}` : `MiMo-${parts[0]}`;
    return [head, ...parts.slice(1).map(capitalize)].join("-");
  }
  if ((m.split("/").pop() ?? "").startsWith("minimax")) {
    const rest = (m.split("/").pop() ?? "").slice("minimax".length);
    const parts = rest.split(/[-\s]+/).filter(Boolean);
    return ["MiniMax", ...parts.map(capitalize)].join(" ");
  }
  const tail = (m.split("/").pop() ?? m).replace(/[-:](free|preview|latest)$/, "");
  return tail.split("-").map(capitalize).join(" ");
}

function capitalize(word: string): string {
  if (!word) return word;
  return /^[A-Za-z]/.test(word) ? word.slice(0, 1).toUpperCase() + word.slice(1) : word;
}

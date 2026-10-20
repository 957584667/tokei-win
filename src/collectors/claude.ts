/**
 * Claude Code 采集器：对应 usage.30s.py 的 scan_claude / _claude_usage /
 * _claude_event_cost / _dedupe_claude_events / _prefer_claude_event。
 * 口径：input_tokens 仅含非缓存输入；缓存写入按 5m/1h 两档计价。
 */
import * as fs from "fs";
import * as path from "path";
import { HOME, isDirectory } from "../core/paths";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey } from "../core/ranges";
import { CLAUDE_LONG_PROMPT_TIERS, cachedEntryHasPricingChange, priceFor, resolveId } from "../core/price";
import { ledgerFileSources, ledgerReconcile } from "../core/ledger";
import { ClaudeRangeOut, claudeRange } from "../core/model";
import { walkFiles, forEachLine } from "../core/fsutil";

export const CLAUDE_DIR = process.env.TOKEI_CLAUDE_DIR || path.join(HOME, ".claude", "projects");

export interface ClaudeEvent {
  in: number;
  out: number;
  cr: number;
  cw: number;
  cw5: number | null;
  cw1: number | null;
  cost: number;
  model: string;
  mid: string | null;
  request_id: string | null;
  event_id: string | null;
  sidechain: boolean;
  /** 本地时区下的毫秒时间戳 */
  ts: number;
}

interface ModelAgg { in: number; out: number; cr: number; cw: number; cost: number }
interface DayAgg { in: number; out: number; cr: number; cw: number; cost: number; models: Record<string, ModelAgg> }

interface FileEntry {
  sig: string;
  events: ClaudeEvent[];
  proj: string | null;
  days: Record<string, DayAgg>;
  hours: number[];
  day_hours: Record<string, number[]>;
  dh: string[];
}

export interface ClaudeScanResult {
  ranges: Record<RangeKey, ClaudeRangeOut>;
  session_name: string;
  session_total: number;
  days: Record<string, DayAgg & { hours: number[]; projects?: string[] }>;
  hours: number[];
  projects: Record<string, Record<string, DayAgg>>;
}

interface ClaudeBucket {
  in: number; out: number; cr: number; cw: number; cost: number;
  models: Record<string, ModelAgg>;
  sessions: Set<string>;
}
function emptyBucket(): ClaudeBucket {
  return { in: 0, out: 0, cr: 0, cw: 0, cost: 0, models: {}, sessions: new Set<string>() };
}

function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 对应 _claude_event_cost() */
export function claudeEventCost(event: Pick<ClaudeEvent, "model" | "in" | "out" | "cr" | "cw" | "cw5" | "cw1">): number {
  const p = priceFor(event.model);
  const w5 = event.cw5;
  const w1 = event.cw1;
  const writeCost = w5 === null && w1 === null
    ? (int(event.cw) / 1e6) * p.write5m
    : (int(w5) / 1e6) * p.write5m + (int(w1) / 1e6) * p.write1h;
  let cost = (int(event.in) / 1e6) * p.in + (int(event.out) / 1e6) * p.out
    + (int(event.cr) / 1e6) * p.cache_read + writeCost;
  // 长 prompt 档位：提示 = 输入 + 缓存读 + 缓存写，超限后整次请求乘倍数
  const tier = CLAUDE_LONG_PROMPT_TIERS[resolveId(event.model) ?? ""];
  if (tier && int(event.in) + int(event.cr) + int(event.cw) > tier[0]) cost *= tier[1];
  return cost;
}

/** 对应 _claude_usage()：只取 type=assistant 且带 message.usage 的行 */
export function claudeUsageFromRecord(o: Record<string, any>): Omit<ClaudeEvent, "cost"> | null {
  if (!o || o.type !== "assistant") return null;
  const msg = o.message ?? {};
  const u = msg.usage;
  if (!u) return null;
  const ts = localTimestamp(o.timestamp);
  if (ts === null) return null;
  const cc = u.cache_creation;
  const has5m = !!cc && cc.ephemeral_5m_input_tokens != null;
  const has1h = !!cc && cc.ephemeral_1h_input_tokens != null;
  return {
    in: int(u.input_tokens),
    out: int(u.output_tokens),
    cr: int(u.cache_read_input_tokens),
    cw: int(u.cache_creation_input_tokens),
    cw5: has5m ? int(cc.ephemeral_5m_input_tokens) : null,
    cw1: has1h ? int(cc.ephemeral_1h_input_tokens) : null,
    model: msg.model ?? "unknown",
    mid: msg.id ?? null,
    request_id: o.requestId ?? o.request_id ?? null,
    event_id: o.uuid ?? null,
    sidechain: o.isSidechain === true,
    ts,
  };
}

/**
 * 对应 parse_ts(...).astimezone()：UTC(Z) 或带偏移的时间戳换算到本机时区。
 * 无法解析返回 null（Python 侧同样丢弃该行）。
 */
function localTimestamp(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.abs(raw) >= 1e11 ? raw : raw * 1000;
  }
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const date = new Date(text.includes("T") || text.includes("-") ? text.replace(" ", "T") : text);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** 对应 _claude_event_total() */
export function claudeEventTotal(event: Pick<ClaudeEvent, "in" | "out" | "cr" | "cw">): number {
  return int(event.in) + int(event.out) + int(event.cr) + int(event.cw);
}

/** 对应 _prefer_claude_event()：主链优先，其次 token 总量，最后成本 */
function preferEvent(candidate: ClaudeEvent, existing: ClaudeEvent): boolean {
  if (!!candidate.sidechain !== !!existing.sidechain) return !!existing.sidechain;
  const ct = claudeEventTotal(candidate);
  const et = claudeEventTotal(existing);
  if (ct !== et) return ct > et;
  return Number(candidate.cost || 0) > Number(existing.cost || 0);
}

/**
 * 对应 _dedupe_claude_events()：message id + request id 精确去重；
 * 同一 message id 在主链与 sidechain 副本之间只保留一份。
 */
export function dedupeClaudeEvents(fileEvents: Array<[string, ClaudeEvent]>): Array<[string, ClaudeEvent]> {
  const selected: Array<[string, ClaudeEvent]> = [];
  const exact = new Map<string, number>();
  const byMessage = new Map<string, number[]>();

  for (const [source, event] of fileEvents) {
    const messageId = event.mid;
    let index: number | null = null;
    let exactKey: string | null = null;

    if (messageId) {
      exactKey = `message\0${messageId}\0${event.request_id ?? ""}`;
      const hit = exact.get(exactKey);
      index = hit === undefined ? null : hit;
      if (index === null) {
        const candidates = byMessage.get(messageId);
        if (candidates) {
          for (const candidateIndex of candidates) {
            const existing = selected[candidateIndex][1];
            if (event.sidechain || existing.sidechain) {
              index = candidateIndex;
              break;
            }
          }
        }
      }
    } else if (event.event_id) {
      exactKey = `event\0${event.event_id}`;
      const hit = exact.get(exactKey);
      index = hit === undefined ? null : hit;
    }

    if (index !== null) {
      if (preferEvent(event, selected[index][1])) {
        selected[index] = [source, event];
        if (exactKey) exact.set(exactKey, index);
      }
      continue;
    }

    const created = selected.length;
    selected.push([source, event]);
    if (exactKey) exact.set(exactKey, created);
    if (messageId) {
      const list = byMessage.get(messageId);
      if (list) list.push(created);
      else byMessage.set(messageId, [created]);
    }
  }
  return selected;
}

function parseFile(file: string): { events: ClaudeEvent[]; proj: string | null } {
  const events: ClaudeEvent[] = [];
  let proj: string | null = null;
  forEachLine(file, (text) => {
    if (!text.startsWith("{") || !text.includes('"usage"')) return;
    let record: Record<string, any>;
    try {
      record = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = claudeUsageFromRecord(record);
    if (!parsed) return;
    if (!proj && typeof record.cwd === "string") proj = record.cwd;
    events.push({ ...parsed, cost: claudeEventCost(parsed) });
  });
  // 与 Python 一致：文件内部先做一次去重
  return { events: dedupeClaudeEvents(events.map((e) => [file, e] as [string, ClaudeEvent])).map(([, e]) => e), proj };
}

/** 对应 _reprice_claude_events()：只碰命中变更模型的文件，逐事件按新价重算缓存里的 cost。 */
function repriceClaudeEvents(fc: Record<string, FileEntry>, changedModels: Array<string | null>): boolean {
  let changed = false;
  for (const entry of Object.values(fc)) {
    if (!cachedEntryHasPricingChange(entry, changedModels)) continue;
    for (const event of entry.events ?? []) {
      const cost = claudeEventCost(event);
      // Python 用 math.isclose(rel_tol=0, abs_tol=1e-12)：只按绝对容差判"变没变"，
      // 否则浮点最后一位抖一下就把整批事件标脏，下一轮又白算一遍。
      if (Math.abs(Number(event.cost ?? 0) - cost) > 1e-12) {
        event.cost = cost;
        changed = true;
      }
    }
  }
  return changed;
}

/** 对应 scan_claude()：历史账本已接 ledger_reconcile（转录被清理的天用 ~/.tokei/ledger.json 的日快照回补，来源按文件名记账） */
export function scanClaude(bounds: Bounds, cache: Record<string, any>): ClaudeScanResult {
  const fc: Record<string, FileEntry> = (cache.claude ??= {});
  // 对应 scan_claude 开头那段 _pricing_changed 判定：价目表这轮动过，先把缓存里每个文件
  // 预存的事件成本按新价重算，后面无论文件重不重新解析，日账拿到的都是新成本。
  const repriced = !!cache._pricing_changed
    && repriceClaudeEvents(fc, Array.isArray(cache._pricing_changed_models) ? cache._pricing_changed_models : []);
  const buckets = Object.fromEntries(RANGE_KEYS.map((k) => [k, emptyBucket()])) as Record<RangeKey, ClaudeBucket>;

  if (!isDirectory(CLAUDE_DIR)) {
    if (Object.keys(fc).length) {
      for (const key of Object.keys(fc)) delete fc[key];
      cache._dirty = true;
    }
    return {
      ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, claudeRange(emptyBucket())])) as Record<RangeKey, ClaudeRangeOut>,
      session_name: "-", session_total: 0, days: {}, hours: new Array(24).fill(0), projects: {},
    };
  }

  let curFile: string | null = null;
  let curMtime = -1;
  const seen = new Set<string>();

  for (const file of walkFiles(CLAUDE_DIR, [".jsonl"]).map((f) => f.file).sort()) {
    seen.add(file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const mtime = stat.mtimeMs / 1000;
    if (mtime > curMtime) {
      curMtime = mtime;
      curFile = file;
    }
    const sig = `${mtime}:${stat.size}`;
    const entry = fc[file];
    if (!entry || entry.sig !== sig) {
      const parsed = parseFile(file);
      fc[file] = { sig, events: parsed.events, proj: parsed.proj, days: {}, hours: new Array(24).fill(0), day_hours: {}, dh: [] };
    }
  }

  for (const file of Object.keys(fc)) {
    if (!seen.has(file)) delete fc[file];
  }

  // 对应 2594：本轮真的重算过缓存里的事件成本，标脏让下游（额度详情）别复用旧快照
  if (repriced) cache._dirty = true;

  const allEvents: Array<[string, ClaudeEvent]> = [];
  for (const [file, entry] of Object.entries(fc)) {
    for (const event of entry.events ?? []) allEvents.push([file, event]);
  }
  const selectedEvents = dedupeClaudeEvents(allEvents);

  const aggregates = new Map<string, { days: Record<string, DayAgg>; hours: number[]; day_hours: Record<string, number[]>; dh: Set<string>; proj: string | null }>();
  for (const [file, entry] of Object.entries(fc)) {
    aggregates.set(file, { days: {}, hours: new Array(24).fill(0), day_hours: {}, dh: new Set(), proj: entry.proj ?? null });
  }

  for (const [file, event] of selectedEvents) {
    const aggregate = aggregates.get(file);
    if (!aggregate) continue;
    const date = new Date(event.ts);
    const key = dayKey(date);
    const day = (aggregate.days[key] ??= { in: 0, out: 0, cr: 0, cw: 0, cost: 0, models: {} });
    day.in += int(event.in);
    day.out += int(event.out);
    day.cr += int(event.cr);
    day.cw += int(event.cw);
    day.cost += Number(event.cost) || 0;
    const model = event.model || "unknown";
    const modelUsage = (day.models[model] ??= { in: 0, out: 0, cr: 0, cw: 0, cost: 0 });
    modelUsage.in += int(event.in);
    modelUsage.out += int(event.out);
    modelUsage.cr += int(event.cr);
    modelUsage.cw += int(event.cw);
    modelUsage.cost += Number(event.cost) || 0;
    const amount = claudeEventTotal(event);
    const hour = date.getHours();
    aggregate.hours[hour] += amount;
    const dayHours = (aggregate.day_hours[key] ??= new Array(24).fill(0));
    dayHours[hour] += amount;
    aggregate.dh.add(`${key}:${hour}`);
  }

  for (const [file, aggregate] of aggregates) {
    const entry = fc[file];
    entry.days = aggregate.days;
    entry.hours = aggregate.hours;
    entry.day_hours = aggregate.day_hours;
    entry.dh = [...aggregate.dh].sort();
    entry.proj = aggregate.proj;
  }

  const liveDays: Record<string, DayAgg & { hours: number[]; projects?: string[] }> = {};
  const dayProjects = new Map<string, Set<string>>();
  for (const [file, entry] of Object.entries(fc)) {
    const projName = entry.proj ? path.basename(entry.proj.replace(/[\\/]+$/, "")) : "";
    for (const [dk, day] of Object.entries(entry.days ?? {})) {
      const agg = (liveDays[dk] ??= { in: 0, out: 0, cr: 0, cw: 0, cost: 0, models: {}, hours: new Array(24).fill(0) });
      agg.in += day.in;
      agg.out += day.out;
      agg.cr += day.cr;
      agg.cw += day.cw;
      agg.cost += day.cost;
      if (projName) {
        const set = dayProjects.get(dk) ?? new Set<string>();
        set.add(projName);
        dayProjects.set(dk, set);
      }
      for (const [mn, mv] of Object.entries(day.models ?? {})) {
        const mm = (agg.models[mn] ??= { in: 0, out: 0, cr: 0, cw: 0, cost: 0 });
        mm.in += mv.in; mm.out += mv.out; mm.cr += mv.cr; mm.cw += mv.cw; mm.cost += mv.cost;
      }
      // 会话数只能来自现存日志（被清日志无从归属）
      for (const k of classifyDay(dk, bounds)) buckets[k].sessions.add(file);
    }
  }
  // 项目名随天入账本（list 会被快照原样存档，日总量只加数值不受影响），
  // 日志被清理后回顾页仍能回答"那天在干什么"（对应 2049–2052）
  for (const [dk, names] of dayProjects) {
    if (liveDays[dk]) liveDays[dk].projects = [...names].sort().slice(0, 3);
  }

  // 天级高水位对账：对应 ledger_reconcile("claude", live_days,
  // _ledger_file_sources(fc, lambda path, _: os.path.basename(path)))（2054）
  const reconciled = ledgerReconcile(
    "claude", liveDays, ledgerFileSources(fc, (file) => path.basename(file)),
  ) as Record<string, DayAgg & { projects?: string[] }>;
  for (const [dk, day] of Object.entries(reconciled)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
    for (const k of classifyDay(dk, bounds)) {
      const b = buckets[k];
      b.in += day.in ?? 0; b.out += day.out ?? 0; b.cr += day.cr ?? 0; b.cw += day.cw ?? 0;
      b.cost += day.cost ?? 0;
      for (const [mn, mv] of Object.entries(day.models ?? {})) {
        const mm = (b.models[mn] ??= { in: 0, out: 0, cr: 0, cw: 0, cost: 0 });
        mm.in += mv.in ?? 0; mm.out += mv.out ?? 0; mm.cr += mv.cr ?? 0; mm.cw += mv.cw ?? 0; mm.cost += mv.cost ?? 0;
      }
    }
  }

  let curTotal = 0;
  if (curFile && fc[curFile]) {
    for (const day of Object.values(fc[curFile].days ?? {})) {
      curTotal += day.in + day.out + day.cr + day.cw;
    }
  }

  const ranges = Object.fromEntries(RANGE_KEYS.map((k) => [k, claudeRange(buckets[k])])) as Record<RangeKey, ClaudeRangeOut>;

  const hours = new Array(24).fill(0);
  for (const entry of Object.values(fc)) {
    for (let h = 0; h < 24; h++) hours[h] += entry.hours?.[h] ?? 0;
  }

  // 项目维度：对应 --projects / ProjectTrailView 的数据来源
  const projects: Record<string, Record<string, DayAgg>> = {};
  for (const [, entry] of Object.entries(fc)) {
    const name = entry.proj ? path.basename(entry.proj.replace(/[\\/]+$/, "")) : "未知项目";
    const bucket = (projects[name] ??= {});
    for (const [dk, day] of Object.entries(entry.days ?? {})) {
      const target = (bucket[dk] ??= { in: 0, out: 0, cr: 0, cw: 0, cost: 0, models: {} });
      target.in += day.in; target.out += day.out; target.cr += day.cr; target.cw += day.cw; target.cost += day.cost;
      for (const [mn, mv] of Object.entries(day.models ?? {})) {
        const mm = (target.models[mn] ??= { in: 0, out: 0, cr: 0, cw: 0, cost: 0 });
        mm.in += mv.in; mm.out += mv.out; mm.cr += mv.cr; mm.cw += mv.cw; mm.cost += mv.cost;
      }
    }
  }

  return {
    ranges,
    session_name: curFile ? path.basename(curFile).slice(0, 8) : "-",
    session_total: curTotal,
    days: liveDays,
    hours,
    projects,
  };
}

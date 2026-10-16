/**
 * Command Code 采集器：对应 usage.30s.py 的 scan_cmdcode / _scan_cmdcode_session /
 * _cmdcode_*（行 12661–12917）。
 * 口径（CALCULATION.md §2 Command Code）：input/output/cacheRead/cacheWrite 是四个
 * 独立桶（input 不含缓存，与 Claude/Pi 同口径）；成本 = usage.costUsd，
 * 仅接受有限非负值并直接采用，绝不估价（cmdcode 不在 _recalc_costs 名单）。
 * 只读真实会话转录里的 assistant usage：跳过 checkpoints/prompts 与非 message 行，
 * hooks-audit sidecar 文件不解析；按消息身份+时刻跨文件去重。
 * 历史账本已接 ledger_reconcile：转录被清后用 ~/.tokei/ledger.json 的日快照回补，
 * 来源按消息身份逐条入账（对应 _ledger_add_record_source）。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { APPDATA, HOME, LOCALAPPDATA, expandPath, existingDirs } from "../core/paths";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey, parseTs } from "../core/ranges";
import { knownIdOrRaw } from "../core/price";
import { ledgerAddRecordSource, ledgerReconcile, ledgerTouch } from "../core/ledger";
import type { DayRecord } from "../core/ledger";
import {
  Bucket, DayStat, TokenUsageRangeOut, addTokenUsage, emptyBuckets, emptyDay,
  mergeLiveDay, mergeTokenDay, tokenTotal, tokenUsageRange,
} from "../core/model";
import { forEachLine, listDirs, listFiles } from "../core/fsutil";

export interface TokenToolResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  model: string | null;
  days: Record<string, any>;
  projects: Record<string, any>;
}

/** 对应 _cmdcode_roots()：TOKEI_CMDCODE_DIR 优先，默认 ~/.commandcode；
 * Windows 安装若把数据放进 %LOCALAPPDATA% / %APPDATA% 也作为兜底候选 */
export function cmdcodeRoots(): string[] {
  const configured = process.env.TOKEI_CMDCODE_DIR;
  const candidates = configured
    ? [configured]
    : [
      path.join(HOME, ".commandcode"),
      path.join(LOCALAPPDATA, "commandcode"),
      path.join(APPDATA, "commandcode"),
    ];
  return existingDirs(candidates.map((c) => expandPath(c) ?? "").filter(Boolean));
}

function cmdcodeNumber(value: unknown): number {
  if (typeof value === "boolean") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(Math.trunc(n), 0) : 0;
}

/** 对应 _cmdcode_cost()：非有限/负数/异常大额一律视为无效，直接采用不估算 */
function cmdcodeCost(value: unknown): number {
  if (typeof value === "boolean") return 0;
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? n : 0;
}

/** 对应 _cmdcode_datetime()：仅接受 ISO 字符串；Z 与裸时间都按 UTC 解释（JS 默认会把裸串当本地） */
function cmdcodeDatetime(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  let text = value.trim();
  if (!text) return null;
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) text = `${text}Z`;
  const parsed = parseTs(text);
  return parsed ? parsed.date : null;
}

/** Python json.dumps(sort_keys=True) 的等价规范化串（identity 无 message id 时兜底） */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

interface CmdcodeEvent {
  id: string;
  day: string;
  hour: number;
  in: number;
  out: number;
  cr: number;
  cw: number;
  reason: number;
  cost: number;
  model: string | null;
}

interface CmdcodeFileEntry {
  sig: string;
  parser: number;
  events: CmdcodeEvent[];
  days: Record<string, DayStat>;
  sid: string;
  proj: string | null;
}

const CMDCODE_PARSER_VERSION = 3;

/** 对应 _cmdcode_session_files()：projects/<slug>/<session-id>.jsonl，剔除 hooks-audit-* 与带副后缀的文件 */
function cmdcodeSessionFiles(): string[] {
  const out: string[] = [];
  for (const root of cmdcodeRoots()) {
    for (const projDir of listDirs(path.join(root, "projects"))) {
      for (const file of listFiles(projDir)) {
        const name = path.basename(file);
        if (!name.endsWith(".jsonl")) continue;
        const stem = name.slice(0, -".jsonl".length);
        if (stem.startsWith("hooks-audit-") || stem.includes(".")) continue;
        out.push(file);
      }
    }
  }
  return [...new Set(out.map((f) => {
    try {
      return fs.realpathSync(f);
    } catch {
      return f;
    }
  }))].sort();
}

/** 对应 _scan_cmdcode_session()：保留事件身份供跨文件统一去重 */
function scanCmdcodeSession(file: string): { events: CmdcodeEvent[]; sid: string | null; proj: string | null } {
  const events: CmdcodeEvent[] = [];
  const seenMessages = new Set<string>();
  let sid: string | null = null;
  let proj: string | null = null;
  let activeModel: string | null = null;

  forEachLine(file, (text) => {
    if (!text.includes('"assistant"') && !text.includes('"session"') && !text.includes('"model_change"')) return;
    let record: Record<string, any>;
    try {
      record = JSON.parse(text);
    } catch {
      return;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    const recordType = record.type;
    if (recordType === "session") {
      const sessionId = record.id ?? record.sessionId;
      if (sid === null && typeof sessionId === "string" && sessionId) sid = sessionId;
      if (proj === null && typeof record.cwd === "string" && record.cwd) proj = record.cwd;
      if (typeof record.model === "string" && record.model) activeModel = record.model;
      return;
    }
    if (recordType === "model_change") {
      if (typeof record.model === "string" && record.model) activeModel = record.model;
      return;
    }
    // checkpoints / prompts 等其它类型在此被挡掉：只认 (无)type 或 type=message
    const nested = (record.message && typeof record.message === "object") ? record.message : {};
    const role = nested.role ?? record.role;
    if (role !== "assistant" || (recordType !== undefined && recordType !== null && recordType !== "message")) return;
    if (typeof record.sessionId === "string" && record.sessionId && sid === null) sid = record.sessionId;
    let usage = (record.usage && typeof record.usage === "object") ? record.usage : null;
    if (!usage && nested.usage && typeof nested.usage === "object") usage = nested.usage;
    if (!usage) return;
    const inp = cmdcodeNumber(usage.inputTokens);
    const out = cmdcodeNumber(usage.outputTokens);
    const cr = cmdcodeNumber(usage.cacheReadTokens);
    const cw = cmdcodeNumber(usage.cacheWriteTokens);
    const cost = cmdcodeCost(usage.costUsd);
    if (inp + out + cr + cw === 0 && cost === 0) return;
    const timestamp = record.timestamp ?? nested.timestamp;
    const dt = cmdcodeDatetime(timestamp);
    if (!dt) return;
    const messageId = record.id ?? record.messageId ?? nested.id;
    const model = (typeof record.model === "string" && record.model) ? record.model
      : (typeof nested.model === "string" && nested.model) ? nested.model : activeModel;
    const identityText = (typeof messageId === "string" && messageId)
      ? `${messageId}\0${timestamp}`
      : canonicalJson({ timestamp, usage, model: model ?? null });
    const identity = crypto.createHash("sha256").update(identityText, "utf8").digest("hex");
    if (seenMessages.has(identity)) return;
    seenMessages.add(identity);
    events.push({
      id: identity, day: dayKey(dt), hour: dt.getHours(),
      in: inp, out, cr, cw, reason: 0, cost,
      model: model ? knownIdOrRaw(model) : null,
    });
  });
  return { events, sid, proj };
}

export interface CmdcodeScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  model: string | null;
  days: Record<string, DayStat & { projects?: string[]; sessions?: string[] }>;
  projects: Record<string, Record<string, DayStat>>;
}

function emptyResult(): CmdcodeScanResult {
  const buckets = emptyBuckets();
  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])])) as Record<RangeKey, TokenUsageRangeOut>,
    model: null, days: {}, projects: {},
  };
}

/** 对应 scan_cmdcode() */
export function scanCmdcode(bounds: Bounds, cache: Record<string, any>): CmdcodeScanResult {
  ledgerTouch("cmdcode");
  const fc: Record<string, CmdcodeFileEntry> = (cache.cmdcode ??= {});
  const files = cmdcodeSessionFiles();
  if (!files.length && Object.keys(fc).length) {
    for (const k of Object.keys(fc)) delete fc[k];
    cache._dirty = true;
  }

  let changed = false;
  const stale = new Set(Object.keys(fc));
  for (const file of files) {
    stale.delete(file);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const sig = `${st.mtimeMs / 1000}:${st.size}`;
    const entry = fc[file];
    if (entry && entry.sig === sig && entry.parser === CMDCODE_PARSER_VERSION) continue;
    const parsed = scanCmdcodeSession(file);
    fc[file] = {
      sig, parser: CMDCODE_PARSER_VERSION, events: parsed.events, days: {},
      sid: parsed.sid || file, proj: parsed.proj,
    };
    changed = true;
  }
  for (const file of stale) {
    delete fc[file];
    changed = true;
  }

  const buckets = emptyBuckets();
  const liveDays: CmdcodeScanResult["days"] = {};
  const liveSessions = new Map<string, Set<string>>();
  const liveProjects = new Map<string, Set<string>>();
  const projects: Record<string, Record<string, DayStat>> = {};
  const seenEvents = new Set<string>();

  // 跨文件身份去重后按文件重建日聚合，故每次扫描都要重放现存事件
  const sourceDays: Record<string, Record<string, DayRecord>> = {};
  for (const file of Object.keys(fc).sort()) {
    const entry = fc[file];
    const entryDays: Record<string, DayStat> = {};
    for (const event of entry.events ?? []) {
      if (!event.id || seenEvents.has(event.id)) continue;
      seenEvents.add(event.id);
      const day = (entryDays[event.day] ??= emptyDay());
      addTokenUsage(day as unknown as Bucket, event.in, event.out, event.cr, event.cw,
        event.reason, event.cost, event.model);
      if (event.hour >= 0 && event.hour < 24) day.hours[event.hour] += tokenTotal(event);
      // 来源按消息身份逐条入账（对应 _ledger_add_record_source + _CMDCODE_PARSER_VERSION，12890–12891）
      ledgerAddRecordSource(sourceDays, event.id, event.day, event, event.hour);
      sourceDays[event.id][event.day]._accounting_version = CMDCODE_PARSER_VERSION;
    }
    entry.days = entryDays;
    const projName = entry.proj ? path.basename(String(entry.proj).replace(/[\\/]+$/, "")) : "";
    for (const [dk, day] of Object.entries(entryDays)) {
      const live = (liveDays[dk] ??= emptyDay());
      mergeLiveDay(live, day);
      (liveSessions.get(dk) ?? liveSessions.set(dk, new Set()).get(dk)!).add(entry.sid || file);
      if (entry.proj) (liveProjects.get(dk) ?? liveProjects.set(dk, new Set()).get(dk)!).add(entry.proj);
      if (projName) {
        const perDay = (projects[projName] ??= {});
        const target = (perDay[dk] ??= emptyDay());
        mergeLiveDay(target, day);
      }
    }
  }

  // 会话与项目名随天入账本（12903–12905：sorted 列表，不设 [:3] 上限）
  for (const [dk, day] of Object.entries(liveDays)) {
    day.sessions = [...(liveSessions.get(dk) ?? [])].sort();
    day.projects = [...(liveProjects.get(dk) ?? [])].sort();
  }

  // 天级高水位对账：对应 ledger_reconcile("cmdcode", live_days, source_days)（12907）；
  // 会话数只并入现存日志归属（live_sessions），账本兜底的天无从归属
  const reconciled = ledgerReconcile("cmdcode", liveDays, sourceDays) as Record<string, DayStat & { sessions?: string[]; projects?: string[] }>;
  for (const [dk, day] of Object.entries(reconciled)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
    for (const k of classifyDay(dk, bounds)) {
      mergeTokenDay(buckets[k], day);
      for (const sid of liveSessions.get(dk) ?? []) buckets[k].sessions.add(sid);
    }
  }

  let model: string | null = null;
  let best = 0;
  for (const [name, usage] of Object.entries(buckets.all.models)) {
    const t = tokenTotal(usage);
    if (t > best) { best = t; model = name; }
  }

  if (changed) cache._dirty = true;
  return {
    ranges: Object.fromEntries(
      RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])]),
    ) as Record<RangeKey, TokenUsageRangeOut>,
    model, days: liveDays, projects,
  };
}

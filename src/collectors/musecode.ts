/**
 * Muse Code 采集器：对应 usage.30s.py 的 scan_musecode / _scan_muse_session /
 * _muse_roots / _muse_datetime / _muse_event_cost（行 12429–12658）。
 * 口径（CALCULATION.md §2 Muse）：与 Codex 同口径——input_tokens 已包含缓存，
 * in = input_tokens - cached_tokens；cached = cached_tokens(==cache_read_tokens)；
 * cw = cache_write_tokens；reasoning_tokens 视为输出子集单独展示。
 * 只认 model_completed 用量事件，按 source_run_record_id 去重；
 * goal_usage_attribution 是归因账本事件，payload_type 不匹配即跳过，不重复计入。
 * Muse 不在 _recalc_costs 名单 → 采集时按价格表估算的成本即最终值。
 * 历史账本已接 ledger_reconcile：日志被清的天用 ~/.tokei/ledger.json 的日快照回补。
 */
import * as fs from "fs";
import * as path from "path";
import { APPDATA, HOME, LOCALAPPDATA, expandPath, existingDirs } from "../core/paths";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey } from "../core/ranges";
import { ledgerReconcile, ledgerTouch, type LedgerDays } from "../core/ledger";
import { knownIdOrRaw, pricingId, rawPrice } from "../core/price";
import {
  Bucket, DayStat, TokenUsageRangeOut, addTokenUsage, emptyBuckets, emptyDay,
  mergeLiveDay, mergeTokenDay, tokenTotal, tokenUsageRange,
} from "../core/model";
import { walkFiles, forEachLine } from "../core/fsutil";

export interface TokenToolResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  model: string | null;
  days: Record<string, any>;
  projects: Record<string, any>;
}

/** 对应 _muse_roots()：TOKEI_MUSE_DIR 优先，默认 ~/.local/share/muse；
 * Windows 上 XDG 数据目录惯例（%LOCALAPPDATA%）与 %APPDATA% 也作为兜底候选 */
export function museRoots(): string[] {
  const configured = process.env.TOKEI_MUSE_DIR;
  const candidates = configured
    ? [configured]
    : [
      path.join(HOME, ".local", "share", "muse"),
      path.join(LOCALAPPDATA, "muse"),
      path.join(APPDATA, "muse"),
    ];
  return existingDirs(candidates.map((c) => expandPath(c) ?? "").filter(Boolean));
}

function museNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(Math.trunc(n), 0) : 0;
}

/** 对应 _muse_datetime()：recorded_at 为微秒；按量级兼容毫秒/秒 */
function museDatetime(value: unknown): Date | null {
  const epoch = Number(value);
  if (!Number.isFinite(epoch)) return null;
  let seconds = epoch;
  if (epoch > 100_000_000_000_000) seconds = epoch / 1_000_000;
  else if (epoch > 100_000_000_000) seconds = epoch / 1000;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 对应 _muse_event_cost()：无公开价不估美元 */
function museEventCost(model: string, inp: number, out: number, cr: number, cw: number): number {
  const priceId = pricingId(model);
  if (!priceId) return 0;
  const p = rawPrice(priceId);
  return (inp / 1e6) * p.in + (out / 1e6) * p.out + (cr / 1e6) * p.cache_read + (cw / 1e6) * p.cache_write;
}

interface MuseFileEntry {
  sig: string;
  parser: number;
  days: Record<string, DayStat>;
  sid: string | null;
  proj: string | null;
}

const MUSE_PARSER_VERSION = 1;

/** 对应 _scan_muse_session()：单文件内按 source_run_record_id 去重 */
function scanMuseSession(file: string): { days: Record<string, DayStat>; sid: string | null; proj: string | null } {
  const days: Record<string, DayStat> = {};
  const seenRecords = new Set<string>();
  let sid: string | null = null;
  let proj: string | null = null;
  const runModels: Record<string, string> = {};

  forEachLine(file, (text) => {
    if (!text.includes('"model_completed"')
      && !text.includes('"run.model.configured"')
      && !text.includes('"runtime.session.metadata"')) return;
    let record: Record<string, any>;
    try {
      record = JSON.parse(text);
    } catch {
      return;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) return;
    if (sid === null && record.stream && typeof record.stream === "object") {
      const streamId = record.stream.id;
      if (typeof streamId === "string" && streamId) sid = streamId;
    }
    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const payloadType = record.payload_type;
    if (payloadType === "runtime.session.metadata") {
      const meta = payload.record;
      if (meta && typeof meta === "object" && typeof meta.workspace_root === "string" && meta.workspace_root) {
        proj = meta.workspace_root;
      }
      return;
    }
    if (payloadType === "run.model.configured") {
      const meta = payload.record;
      if (meta && typeof meta === "object") {
        const runStream = meta.run_stream;
        const modelId = meta.model_id;
        if (runStream && typeof runStream === "object"
          && typeof modelId === "string" && modelId && modelId !== "same-as-main"
          && typeof runStream.id === "string" && runStream.id) {
          runModels[runStream.id] = modelId;
        }
      }
      return;
    }
    // goal_usage_attribution 等归因账本事件在 payload_type/kind 检查处天然被跳过
    if (payloadType !== "runtime.session" || payload.kind !== "run") return;
    const event = payload.event;
    if (!event || typeof event !== "object" || event.kind !== "model_completed") return;
    const usage = event.usage;
    if (!usage || typeof usage !== "object") return;
    const inputTotal = museNumber(usage.input_tokens);
    let cached = museNumber(usage.cached_tokens ?? usage.cache_read_tokens);
    cached = Math.min(cached, inputTotal);
    const inp = inputTotal - cached; // 原始 input 已含缓存，减去避免双计
    const out = museNumber(usage.output_tokens);
    const cw = museNumber(usage.cache_write_tokens);
    const reason = museNumber(usage.reasoning_tokens);
    if (inp + out + cached + cw + reason === 0) return;
    const recordId = record.source_run_record_id;
    if (typeof recordId === "string" && recordId) {
      if (seenRecords.has(recordId)) return;
      seenRecords.add(recordId);
    }
    let model = event.model;
    if (typeof model !== "string" || !model || model === "same-as-main") {
      model = runModels[payload.run_id ?? ""] ?? "";
    }
    const displayModel = model ? knownIdOrRaw(model) : null;
    const cost = museEventCost(model || "unknown", inp, out, cached, cw);
    const dt = museDatetime(record.recorded_at);
    if (!dt) return;
    const dk = dayKey(dt);
    const day = (days[dk] ??= emptyDay());
    addTokenUsage(day as unknown as Bucket, inp, out, cached, cw, reason, cost, displayModel);
    day.hours[dt.getHours()] += inp + out + cached + cw;
  });
  return { days, sid, proj };
}

/** 对应 _muse_session_files()：两个 glob —— sessions 下第 5 层或第 2 层的 session.jsonl */
function museSessionFiles(): string[] {
  const out = new Set<string>();
  for (const root of museRoots()) {
    const sessionsDir = path.join(root, "sessions");
    for (const found of walkFiles(sessionsDir, [".jsonl"])) {
      if (path.basename(found.file) !== "session.jsonl") continue;
      // 深度 = 相对 sessions 的段数（含文件名）：YYYY/MM/DD/x/sid 或扁平 sid
      const depth = path.relative(sessionsDir, found.file).split(path.sep).length;
      if (depth === 5 || depth === 2) out.add(found.file);
    }
  }
  return [...out].sort();
}

export interface MusecodeScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  model: string | null;
  days: Record<string, DayStat & { projects?: string[]; sessions?: string[] }>;
  projects: Record<string, Record<string, DayStat>>;
}

function emptyResult(): MusecodeScanResult {
  const buckets = emptyBuckets();
  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])])) as Record<RangeKey, TokenUsageRangeOut>,
    model: null, days: {}, projects: {},
  };
}

/** 对应 scan_musecode() */
export function scanMusecode(bounds: Bounds, cache: Record<string, any>): MusecodeScanResult {
  ledgerTouch("musecode");
  const fc: Record<string, MuseFileEntry> = (cache.musecode ??= {});
  const files = museSessionFiles();
  if (!files.length && Object.keys(fc).length) {
    for (const k of Object.keys(fc)) delete fc[k];
    cache._dirty = true;
    return emptyResult();
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
    if (entry && entry.sig === sig && entry.parser === MUSE_PARSER_VERSION) continue;
    const parsed = scanMuseSession(file);
    fc[file] = { sig, parser: MUSE_PARSER_VERSION, days: parsed.days, sid: parsed.sid, proj: parsed.proj };
    changed = true;
  }
  for (const file of stale) {
    delete fc[file];
    changed = true;
  }

  const buckets = emptyBuckets();
  const liveDays: MusecodeScanResult["days"] = {};
  const liveSessions = new Map<string, Set<string>>();
  const liveProjects = new Map<string, Set<string>>();
  const projects: Record<string, Record<string, DayStat>> = {};

  for (const [file, entry] of Object.entries(fc)) {
    const session = entry.sid || file;
    const projName = entry.proj ? path.basename(String(entry.proj).replace(/[\\/]+$/, "")) : "";
    for (const [dk, day] of Object.entries(entry.days ?? {})) {
      const live = (liveDays[dk] ??= emptyDay());
      mergeLiveDay(live, day);
      (liveSessions.get(dk) ?? liveSessions.set(dk, new Set()).get(dk)!).add(session);
      if (entry.proj) (liveProjects.get(dk) ?? liveProjects.set(dk, new Set()).get(dk)!).add(entry.proj);
      if (projName) {
        const perDay = (projects[projName] ??= {});
        const target = (perDay[dk] ??= emptyDay());
        mergeLiveDay(target, day);
      }
    }
  }

  for (const [dk, day] of Object.entries(liveDays)) {
    day.sessions = [...(liveSessions.get(dk) ?? [])].sort();
    const names = liveProjects.get(dk);
    if (names) day.projects = [...names].sort().slice(0, 3);
  }

  // 天级高水位对账：日志被删的天用 ~/.tokei/ledger.json 的快照兜底
  // 会话数随账本 day.sessions 一起回补（账本存的就是 sorted 列表）
  for (const [dk, day] of Object.entries<LedgerDays[string]>(ledgerReconcile("musecode", liveDays))) {
    for (const k of classifyDay(dk, bounds)) {
      mergeTokenDay(buckets[k], day);
      for (const sid of (day.sessions as string[] | undefined) ?? []) buckets[k].sessions.add(sid);
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

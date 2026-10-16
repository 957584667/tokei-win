/**
 * Pi Coding Agent CLI 采集器：对应 usage.30s.py 的 scan_pi / _pi_session_dirs /
 * _pi_model_id / _pi_usage_int / _pi_usage_cost（行 9471–9628）。
 * 口径（CALCULATION.md §2/§4）：input/output/cacheRead/cacheWrite/reasoning 各桶独立，
 * input 不含缓存；成本优先 usage.cost.total，缺失时按 parts 或价格表估算。
 * Pi 不在 _recalc_costs 工具名单里 → 采集时算出的日志成本就是最终值，不被估价覆盖。
 * 历史账本已接 ledger_reconcile：日志被删后用 ~/.tokei/ledger.json 的逐 sid 来源快照回补。
 */
import * as fs from "fs";
import * as path from "path";
import { APPDATA, HOME, LOCALAPPDATA, existingDirs, expandPath } from "../core/paths";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey, parseTs } from "../core/ranges";
import { pricingId, rawPrice } from "../core/price";
import { ledgerFileSources, ledgerReconcile, ledgerTouch, prepareUnpricedCostLedger } from "../core/ledger";
import {
  DayStat, TokenUsageRangeOut, addTokenUsage, emptyBuckets, emptyDay,
  mergeLiveDay, mergeTokenDay, tokenTotal, tokenUsageRange,
} from "../core/model";
import { walkFiles, forEachLine } from "../core/fsutil";
import { Bucket } from "../core/model";

export interface TokenToolResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  model: string | null;
  days: Record<string, any>;
  projects: Record<string, any>;
}

/**
 * 扫描时现算根目录（而非模块加载时），测试才能注入 TOKEI_* 环境变量。
 * 与 _pi_session_dirs() 一致：Pi 与 Oh My Pi (OMP) 折叠进同一次扫描。
 * Windows 安装候选（%LOCALAPPDATA%/%APPDATA%）作为兜底追加，Python 侧的原名环境变量优先。
 */
export function piSessionDirs(): string[] {
  const envAgent = process.env.PI_CODING_AGENT_DIR;
  const agentDirs = envAgent
    ? [expandPath(envAgent) ?? ""]
    : [
      path.join(HOME, ".pi", "agent"),
      path.join(LOCALAPPDATA, "pi", "agent"),
      path.join(APPDATA, "pi", "agent"),
    ];
  const envOmp = process.env.OMP_CODING_AGENT_SESSION_DIR;
  const ompDirs = envOmp
    ? [envOmp]
    : [
      path.join(HOME, ".omp", "agent", "sessions"),
      path.join(LOCALAPPDATA, "omp", "agent", "sessions"),
      path.join(APPDATA, "omp", "agent", "sessions"),
    ];
  const dirs = [
    process.env.TOKEI_PI_DIR ?? "",
    process.env.PI_CODING_AGENT_SESSION_DIR ?? "",
    ...agentDirs.filter(Boolean).map((d) => path.join(d, "sessions")),
    ...ompDirs,
  ].filter(Boolean);
  return existingDirs(dirs.map((d) => expandPath(d) ?? "").filter(Boolean));
}

/** 对应 _pi_model_id()：provider 与裸模型名拼成 canonical id */
export function piModelId(msg: Record<string, any>): string {
  const model = String(msg.model ?? "");
  const provider = String(msg.provider ?? "");
  if (provider && model && !model.includes("/")) return `${provider}/${model}`;
  return model || provider || "unknown";
}

/** 对应 _pi_usage_int()：首个存在且非 null 的字段取 int */
export function piUsageInt(usage: Record<string, any>, ...fields: string[]): number {
  for (const field of fields) {
    if (field in usage && usage[field] !== null && usage[field] !== undefined) {
      const n = Number(usage[field]);
      return Number.isFinite(n) ? Math.trunc(n) : 0;
    }
  }
  return 0;
}

/** 对应 _pi_usage_cost()：日志成本 total > parts 求和 > 价格表估算；无公开价不估美元 */
export function piUsageCost(u: Record<string, any>, model: string): number {
  const costObj = (u.cost && typeof u.cost === "object") ? u.cost : {};
  const total = Number(costObj.total) || 0;
  if (total > 0) return total;
  let parts = 0;
  for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
    const v = Number(costObj[k]);
    parts += Number.isFinite(v) ? v : 0;
  }
  if (parts > 0) return parts;
  const priceId = pricingId(model);
  if (!priceId) return 0;
  const p = rawPrice(priceId);
  const inp = piUsageInt(u, "input");
  const out = piUsageInt(u, "output");
  const cr = piUsageInt(u, "cacheRead", "cache_read");
  const cw = piUsageInt(u, "cacheWrite", "cache_write");
  return (inp / 1e6) * p.in + (out / 1e6) * p.out + (cr / 1e6) * p.cache_read + (cw / 1e6) * p.cache_write;
}

interface PiFileEntry {
  sig: string;
  parser: number;
  days: Record<string, DayStat>;
  proj: string | null;
  sid: string;
}

/** 解析口径版本：改解析规则时 +1 使旧缓存失效 */
const PI_PARSER_VERSION = 1;

function parsePiFile(file: string): { days: Record<string, DayStat>; proj: string | null; sid: string } {
  const days: Record<string, DayStat> = {};
  let proj: string | null = null;
  let sid = path.basename(file);
  forEachLine(file, (text) => {
    if (!text.includes('"usage"') && !text.includes('"type":"session"') && !text.includes('"type": "session"')) return;
    let o: Record<string, any>;
    try {
      o = JSON.parse(text);
    } catch {
      return;
    }
    if (!o || typeof o !== "object") return;
    if (o.type === "session") {
      if (o.id) sid = String(o.id);
      if (o.cwd) proj = String(o.cwd);
      return;
    }
    if (o.type !== "message") return;
    const msg = (o.message && typeof o.message === "object") ? o.message : {};
    if (msg.role !== "assistant") return;
    const u = (msg.usage && typeof msg.usage === "object") ? msg.usage : null;
    if (!u || !Object.keys(u).length) return;
    const parsed = parseTs(o.timestamp || msg.timestamp || "");
    if (!parsed) return;
    const inp = piUsageInt(u, "input");
    const out = piUsageInt(u, "output");
    const cr = piUsageInt(u, "cacheRead", "cache_read");
    const cw = piUsageInt(u, "cacheWrite", "cache_write");
    const reason = piUsageInt(u, "reasoning", "reason", "reasoningTokens");
    const model = piModelId(msg);
    const cost = piUsageCost(u, model);
    if (inp + out + cr + cw + reason === 0 && cost <= 0) return;
    const dk = dayKey(parsed.date);
    const day = (days[dk] ??= emptyDay());
    addTokenUsage(day as unknown as Bucket, inp, out, cr, cw, reason, cost, model);
    day.hours[parsed.hour] += inp + out + cr + cw + reason;
  });
  return { days, proj, sid: String(sid) };
}

export interface PiScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  model: string | null;
  days: Record<string, DayStat & { projects?: string[] }>;
  projects: Record<string, Record<string, DayStat>>;
}

function emptyResult(): PiScanResult {
  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(emptyBuckets()[k])])) as Record<RangeKey, TokenUsageRangeOut>,
    model: null, days: {}, projects: {},
  };
}

/** 对应 scan_pi()（9528-9628） */
export function scanPi(bounds: Bounds, cache: Record<string, any>): PiScanResult {
  // 对应 9529-9530：先清掉旧账本里无公开价模型按 Opus 兜底价估出的成本，再登记工具
  prepareUnpricedCostLedger("pi");
  ledgerTouch("pi");
  const fc: Record<string, PiFileEntry> = (cache.pi ??= {});
  const roots = piSessionDirs();
  if (!roots.length) {
    if (Object.keys(fc).length) {
      for (const k of Object.keys(fc)) delete fc[k];
      cache._dirty = true;
    }
    return emptyResult();
  }

  const seenFiles = new Set<string>();
  for (const root of roots) for (const f of walkFiles(root, [".jsonl"])) seenFiles.add(f.file);

  let changed = false;
  const stale = new Set(Object.keys(fc));
  for (const file of [...seenFiles].sort()) {
    stale.delete(file);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const sig = `${st.mtimeMs / 1000}:${st.size}`;
    const entry = fc[file];
    if (entry && entry.sig === sig && entry.parser === PI_PARSER_VERSION) continue;
    const parsed = parsePiFile(file);
    fc[file] = { sig, parser: PI_PARSER_VERSION, days: parsed.days, proj: parsed.proj, sid: parsed.sid };
    changed = true;
  }
  for (const file of stale) {
    delete fc[file];
    changed = true;
  }

  const buckets = emptyBuckets();
  const liveDays: Record<string, DayStat & { projects?: string[] }> = {};
  const dayProjects = new Map<string, Set<string>>();
  const projects: Record<string, Record<string, DayStat>> = {};

  for (const [file, entry] of Object.entries(fc)) {
    const session = entry.sid || file;
    const projName = entry.proj ? path.basename(entry.proj.replace(/[\\/]+$/, "")) : "";
    for (const [dk, day] of Object.entries(entry.days ?? {})) {
      const live = (liveDays[dk] ??= emptyDay());
      mergeLiveDay(live, day);
      if (projName) {
        (dayProjects.get(dk) ?? dayProjects.set(dk, new Set()).get(dk)!).add(projName);
        const perDay = (projects[projName] ??= {});
        const target = (perDay[dk] ??= emptyDay());
        mergeLiveDay(target, day);
      }
      // 会话数只能来自现存日志（被清日志无从归属）
      for (const k of classifyDay(dk, bounds)) buckets[k].sessions.add(session);
    }
  }

  // 项目归属仍取现存日志（Python 的 scan_pi 不带 projects，这是 TS 侧逐日字段的既有行为）
  for (const [dk, day] of Object.entries(liveDays)) {
    const names = dayProjects.get(dk);
    if (names) day.projects = [...names].sort().slice(0, 3);
  }

  // 天级高水位对账（对应 9619 ledger_reconcile("pi", live_days, _ledger_file_sources(fc, "sid"))）：
  // 日志被删的天用逐 sid 来源快照回补；会话数只来自上面现存日志的循环
  const reconciled = ledgerReconcile("pi", liveDays, ledgerFileSources(fc, "sid")) as Record<string, DayStat>;
  for (const [dk, day] of Object.entries(reconciled)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue; // 对应 9620-9623 的 date.fromisoformat 校验
    for (const k of classifyDay(dk, bounds)) mergeTokenDay(buckets[k], day);
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

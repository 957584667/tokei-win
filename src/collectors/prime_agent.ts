/**
 * Prime Agent 采集器：对应 usage.30s.py 的 scan_prime_agent /
 * _prime_agent_session_dirs / _parse_prime_session_file（行 9631–9792）。
 * Usage 字段与 Pi 完全一致（复用 pi.ts 的取值/成本函数）；
 * child_usage_attributed 是父会话聚合 bookkeeping，type≠message 天然跳过，绝不重复计入；
 * RLM 子代理日志有独立 session id，作为独立会话参与统计。
 * 历史账本已接 ledger_reconcile：日志被清的天用 ~/.tokei/ledger.json 的逐会话快照回补，
 * 会话与项目名随天入账本，被清后仍能答出那天的会话数与「在干什么」。
 */
import * as fs from "fs";
import * as path from "path";
import { APPDATA, HOME, LOCALAPPDATA, existingDirs, expandPath } from "../core/paths";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey, parseTs } from "../core/ranges";
import {
  DayStat, TokenUsageRangeOut, addTokenUsage, emptyBuckets, emptyDay,
  mergeTokenDay, tokenUsageRange, tokenTotal,
} from "../core/model";
import { walkFiles, forEachLine } from "../core/fsutil";
import { Bucket } from "../core/model";
import { DayRecord, ledgerAddRecordSource, ledgerReconcile, ledgerTouch } from "../core/ledger";
import { piModelId, piUsageCost, piUsageInt } from "./pi";

export interface TokenToolResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  model: string | null;
  days: Record<string, any>;
  projects: Record<string, any>;
}

interface PrimeEvent {
  key: string;
  date: string;
  hour: number;
  in: number;
  out: number;
  cr: number;
  cw: number;
  reason: number;
  cost: number;
  model: string;
  ts: number;
}

interface PrimeFileEntry {
  sig: string;
  session: string;
  sid: string;
  proj: string | null;
  events: PrimeEvent[];
  days: Record<string, DayStat>;
}

/**
 * 对应 _prime_agent_session_dirs()：TOKEI_PRIME_AGENT_DIR 指 agent 根，SESSION_DIR 指会话目录。
 * Windows 安装候选（%LOCALAPPDATA%/%APPDATA% 下的 prime/agent）作为兜底追加。
 */
export function primeSessionDirs(): string[] {
  const explicit = process.env.TOKEI_PRIME_AGENT_SESSION_DIR;
  if (explicit) {
    const d = expandPath(explicit);
    return d ? existingDirs([d]) : [];
  }
  const envAgent = process.env.TOKEI_PRIME_AGENT_DIR || process.env.PRIME_AGENT_CODING_AGENT_DIR;
  const agentDirs = envAgent
    ? [expandPath(envAgent) ?? ""]
    : [
      path.join(HOME, ".prime", "agent"),
      path.join(LOCALAPPDATA, "prime", "agent"),
      path.join(APPDATA, "prime", "agent"),
    ].filter(Boolean);
  const sessionOverride = process.env.PRIME_AGENT_SESSION_DIR || process.env.PRIME_AGENT_CODING_AGENT_SESSION_DIR;
  const roots: string[] = [];
  for (const agentDir of agentDirs.filter(Boolean)) {
    roots.push(expandPath(sessionOverride) ?? path.join(agentDir, "sessions"));
    roots.push(path.join(agentDir, "session-artifacts"));
  }
  return existingDirs(roots);
}

/** 对应 _parse_prime_session_file() */
function parsePrimeFile(file: string): Omit<PrimeFileEntry, "sig"> {
  const events: PrimeEvent[] = [];
  let project: string | null = null;
  let sessionId = path.basename(file);
  let modelChange = "";
  forEachLine(file, (text, lineNo) => {
    if (!text.includes('"type"') && !text.includes('"usage"')) return;
    let obj: Record<string, any>;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    if (!obj || typeof obj !== "object") return;
    if (obj.type === "session") {
      if (obj.id) sessionId = String(obj.id);
      if (obj.cwd) project = String(obj.cwd);
      return;
    }
    if (obj.type === "model_change") {
      modelChange = piModelId({ provider: obj.provider, model: obj.modelId });
      return;
    }
    // child_usage_attributed 等记账型事件在此被过滤掉：只统计逐次 assistant usage
    if (obj.type !== "message") return;
    const msg = (obj.message && typeof obj.message === "object") ? obj.message : {};
    if (msg.role !== "assistant") return;
    const usage = (msg.usage && typeof msg.usage === "object") ? msg.usage : null;
    if (!usage || !Object.keys(usage).length) return;
    const parsed = parseTs(obj.timestamp || msg.timestamp || "");
    if (!parsed) return;
    let currentModel = piModelId(msg);
    if (currentModel === "unknown") currentModel = modelChange;
    const inp = piUsageInt(usage, "input");
    const out = piUsageInt(usage, "output");
    const cr = piUsageInt(usage, "cacheRead", "cache_read");
    const cw = piUsageInt(usage, "cacheWrite", "cache_write");
    const reason = piUsageInt(usage, "reasoning", "reason", "reasoningTokens");
    const cost = piUsageCost(usage, currentModel);
    if (inp + out + cr + cw + reason === 0 && cost <= 0) return;
    const eventId = obj.id ?? msg.id ?? msg.responseId;
    const key = eventId ? `${sessionId}:${eventId}` : `${sessionId}:${lineNo}`;
    events.push({
      key, date: dayKey(parsed.date), hour: parsed.hour, ts: parsed.epoch,
      in: inp, out, cr, cw, reason, cost, model: currentModel,
    });
  });
  const days: Record<string, DayStat> = {};
  for (const e of events) {
    const day = (days[e.date] ??= emptyDay());
    addTokenUsage(day as unknown as Bucket, e.in, e.out, e.cr, e.cw, e.reason, e.cost, e.model);
    day.hours[e.hour] += e.in + e.out + e.cr + e.cw + e.reason;
  }
  return { session: sessionId, sid: sessionId, proj: project, events, days };
}

export interface PrimeAgentScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  model: string | null;
  days: Record<string, DayStat & { projects?: string[]; sessions?: string[] }>;
  projects: Record<string, Record<string, DayStat>>;
}

function emptyResult(): PrimeAgentScanResult {
  const buckets = emptyBuckets();
  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])])) as Record<RangeKey, TokenUsageRangeOut>,
    model: null, days: {}, projects: {},
  };
}

/** 对应 scan_prime_agent()（9709） */
export function scanPrimeAgent(bounds: Bounds, cache: Record<string, any>): PrimeAgentScanResult {
  ledgerTouch("prime_agent");
  const fc: Record<string, PrimeFileEntry> = (cache.prime_agent ??= {});
  const seenFiles = new Set<string>();
  for (const root of primeSessionDirs()) {
    for (const f of walkFiles(root, [".jsonl"])) {
      try {
        seenFiles.add(fs.realpathSync(f.file));
      } catch {
        seenFiles.add(f.file);
      }
    }
  }

  const stale = new Set(Object.keys(fc).filter((k) => !k.startsWith("_")));
  let changed = false;
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
    if (entry && entry.sig === sig) continue;
    fc[file] = { sig, ...parsePrimeFile(file) };
    changed = true;
  }
  for (const file of stale) {
    if (fc[file]) {
      delete fc[file];
      changed = true;
    }
  }

  // 同一逻辑会话可能有多份物理文件（artifacts 复制）：保留事件最多的一份
  const canonical = new Map<string, [string, PrimeFileEntry]>();
  for (const [file, entry] of Object.entries(fc)) {
    if (file.startsWith("_") || !entry || typeof entry !== "object") continue;
    const sid = entry.sid || file;
    const old = canonical.get(sid);
    if (!old || entry.events.length > old[1].events.length) canonical.set(sid, [file, entry]);
  }
  const canonicalPaths = new Set([...canonical.values()].map(([f]) => f));
  for (const file of Object.keys(fc)) {
    if (!file.startsWith("_") && !canonicalPaths.has(file)) {
      delete fc[file];
      changed = true;
    }
  }

  const buckets = emptyBuckets();
  const days: PrimeAgentScanResult["days"] = {};
  const used = new Set<string>();
  const ledgerSources: Record<string, Record<string, DayRecord>> = {}; // 对应 ledger_sources（9750）
  const daySessions = new Map<string, Set<string>>();
  const dayProjects = new Map<string, Set<string>>();
  const projects: Record<string, Record<string, DayStat>> = {};

  for (const [file, entry] of canonical.values()) {
    const sid = entry.sid || file;
    const projName = entry.proj ? path.basename(String(entry.proj).replace(/[\\/]+$/, "")) : "";
    for (const e of entry.events) {
      if (used.has(e.key)) continue; // 消息 ID 全局去重
      used.add(e.key);
      // 逐会话来源快照（9765）：日志被清后账本仍能按会话还原当天贡献
      ledgerAddRecordSource(ledgerSources, sid, e.date, e, e.hour);
      const day = (days[e.date] ??= emptyDay());
      addTokenUsage(day as unknown as Bucket, e.in, e.out, e.cr, e.cw, e.reason, e.cost, e.model);
      if (e.hour >= 0 && e.hour < 24) day.hours[e.hour] += tokenTotal(e);
      (daySessions.get(e.date) ?? daySessions.set(e.date, new Set()).get(e.date)!).add(sid);
      if (projName) {
        (dayProjects.get(e.date) ?? dayProjects.set(e.date, new Set()).get(e.date)!).add(projName);
        const perDay = (projects[projName] ??= {});
        const target = (perDay[e.date] ??= emptyDay());
        addTokenUsage(target as unknown as Bucket, e.in, e.out, e.cr, e.cw, e.reason, e.cost, e.model);
      }
    }
    buckets.all.sessions.add(sid);
    void file;
  }

  // 会话与项目名随天入账本（9779-9782）：日志被清后，那天的会话数与「在干什么」仍答得出
  for (const [dk, day] of Object.entries(days)) {
    day.sessions = [...(daySessions.get(dk) ?? [])].sort();
    day.projects = [...(dayProjects.get(dk) ?? [])].sort().slice(0, 3);
  }
  // 天级高水位对账（9784-9791）：日志被清的天用账本快照回补；
  // 本工具的会话 id 随对账后的天带出，账本找回的天依然能计会话（9791）
  const reconciled = ledgerReconcile("prime_agent", days, ledgerSources) as Record<string, PrimeAgentScanResult["days"][string]>;
  for (const [dk, day] of Object.entries(reconciled)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue; // 对应 date.fromisoformat 校验（9785-9788）
    for (const k of classifyDay(dk, bounds)) {
      mergeTokenDay(buckets[k], day);
      for (const sid of day.sessions ?? []) buckets[k].sessions.add(sid);
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
    model, days, projects,
  };
}

/**
 * Kimi Code 采集器：对应 usage.30s.py 的 scan_kimicode(12338) / _kimi_wire_groups(12112) /
 * _kimi_wire_context(12168) / _kimi_events(12210) / _scan_kimi_wire(12243) /
 * _kimi_project_map(12148) / _kimi_credential_files(11849) / _kimi_quota_values(12079)。
 *
 * 口径（CALCULATION.md §2 Kimi Code）：
 *   protocol 1.5 `${KIMI_CODE_HOME:-~/.kimi-code}/sessions/<工作目录>/<会话>/agents/<agent>/wire.jsonl` 的
 *     usage.record：in = usage.inputOther, out = usage.output,
 *     cr = usage.inputCacheRead, cw = usage.inputCacheCreation, 模型来自记录自带 model；
 *   protocol 1 `${KIMI_SHARE_DIR:-~/.kimi}/sessions/<工作目录>/<会话>/wire.jsonl` 的
 *     StatusUpdate.token_usage：input_other / output / input_cache_read / input_cache_creation，
 *     并在主 wire 内递归展开 SubagentEvent（**不再**单独扫 session/subagents，避免重复）。
 * 多个 agent 的 wire 用 state.json.id 归并成同一会话，项目取 state.json.cwd。
 * 根 wire 与 agent wire 并存的会话里，根 wire 是镜像：按 agent wire 的记录键多重集抵扣。
 *
 * 成本：wire 日志不持久化任何账单金额，Kimi 也没有权威计费口径 → **永不推断 USD**
 * （cost 恒 0；src/core/model.ts 的 recalcCosts RECALC_TOOLS 里没有 kimicode，
 * 所以重算阶段也不会给它补价，这里保持 0 即可）。
 * 历史账本已接 ledger_reconcile：wire 日志被删后用 ~/.tokei/ledger.json 的逐 sid 来源快照回补。
 *
 * 额度：`https://api.kimi.com/coding/v1/usages` 是网络调用，本里程碑不实现（OUT OF SCOPE），
 * p5/pw/r5/rw/plan 恒 null；只保留凭据位置与「只读 access_token、绝不用 refresh_token」的规则说明，
 * 见文件末尾 kimiCredential()。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Bounds, RangeKey, RANGE_KEYS, classifyDay, dayKey, parseTs } from "../core/ranges";
import { HOME, expandPath, loadJson } from "../core/paths";
import { forEachLine } from "../core/fsutil";
import { ledgerFileSources, ledgerReconcile, ledgerTouch } from "../core/ledger";
import { Bucket, ModelUsage, addModelUsage, addTokenUsage, emptyBucket, mergeLiveDay, mergeTokenDay, tokenUsageRange, TokenUsageRangeOut } from "../core/model";
import { OPENCODE_COST_VERSION } from "./opencode";

/** 对应 _KIMI_PARSER_VERSION = 3 */
export const KIMI_PARSER_VERSION = 3;

const DEFAULT_DIR = path.join(HOME, ".kimi-code");
const LEGACY_DIR = path.join(HOME, ".kimi");

function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(Math.trunc(n), 0) : 0;
}

/** 对应 _kimi_roots()：显式配置只用一个根，否则新旧两个根都扫 */
export function kimiRoots(): string[] {
  const configured = process.env.TOKEI_KIMI_DIR || process.env.KIMI_CODE_HOME || process.env.KIMI_SHARE_DIR;
  const candidates = configured ? [configured] : [DEFAULT_DIR, LEGACY_DIR];
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const root = expandPath(candidate);
    if (!root) continue;
    let real = root;
    try {
      real = fs.realpathSync(root);
    } catch { /* 目录尚不存在 */ }
    const key = path.normalize(real).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(real);
  }
  return roots;
}

export interface KimiWireGroup {
  agentWires: string[];
  rootWire: string | null;
}

/** 对应 _kimi_wire_groups()：定深遍历 sessions/<工作目录>/<会话>，不碰 server/events 镜像目录 */
export function kimiWireGroups(roots = kimiRoots()): KimiWireGroup[] {
  const groups: KimiWireGroup[] = [];
  for (const root of roots) {
    const sessionsDir = path.join(root, "sessions");
    let workDirs: string[];
    try {
      workDirs = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(sessionsDir, e.name));
    } catch {
      continue;
    }
    for (const workDir of workDirs) {
      let sessionDirs: string[];
      try {
        sessionDirs = fs.readdirSync(workDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(workDir, e.name));
      } catch {
        continue;
      }
      for (const sessionDir of sessionDirs) {
        const agentWires = listDirNames(path.join(sessionDir, "agents"))
          .map((agent) => path.join(sessionDir, "agents", agent, "wire.jsonl"))
          .filter(isFile)
          .sort();
        const rootWire = isFile(path.join(sessionDir, "wire.jsonl")) ? path.join(sessionDir, "wire.jsonl") : null;
        if (agentWires.length || rootWire) groups.push({ agentWires, rootWire });
      }
    }
  }
  return groups;
}

function listDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 对应 _kimi_project_map()：旧版 kimi.json 的 work_dirs 路径按 md5 命名目录 */
export function kimiProjectMap(roots = kimiRoots()): Record<string, string> {
  const result: Record<string, string> = {};
  for (const root of roots) {
    const metadata = loadJson<Record<string, any>>(path.join(root, "kimi.json"), {});
    const items = metadata && Array.isArray(metadata.work_dirs) ? metadata.work_dirs : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const project = item.path;
      if (typeof project !== "string" || !project) continue;
      const digest = crypto.createHash("md5").update(project, "utf8").digest("hex");
      result[digest] = project;
      if (typeof item.kaos === "string" && item.kaos) result[`${item.kaos}_${digest}`] = project;
    }
  }
  return result;
}

export interface KimiWireContext {
  sid: string;
  proj: string | null;
  agent: string;
}

/** 对应 _kimi_wire_context() */
export function kimiWireContext(wirePath: string, legacyProjects: Record<string, string>): KimiWireContext {
  const agentDir = path.dirname(wirePath);
  const agentsDir = path.dirname(agentDir);
  if (path.basename(agentsDir) === "agents") {
    const sessionDir = path.dirname(agentsDir);
    const state = loadJson<Record<string, any>>(path.join(sessionDir, "state.json"), {});
    const safeState = state && typeof state === "object" && !Array.isArray(state) ? state : {};
    const sessionId = safeState.id || path.basename(sessionDir);
    const project = safeState.cwd;
    return {
      sid: String(sessionId),
      proj: typeof project === "string" && project ? project : null,
      agent: path.basename(agentDir),
    };
  }
  const sessionDir = agentDir;
  const workDirHash = path.basename(path.dirname(sessionDir));
  return {
    sid: path.basename(sessionDir),
    proj: legacyProjects[workDirHash] ?? null,
    agent: "main",
  };
}

/** 对应 _kimi_events()：协议 1 在主 wire 里递归展开 SubagentEvent */
export function* kimiEvents(message: Record<string, any> | null | undefined, scope = "main"): Generator<[string, Record<string, any>]> {
  if (!message || typeof message !== "object") return;
  const payload = message.payload;
  if (!payload || typeof payload !== "object") return;
  if (message.type === "SubagentEvent") {
    const agent = payload.agent_id || payload.parent_tool_call_id || payload.task_tool_call_id;
    const childScope = typeof agent === "string" && agent ? `${scope}/${agent}` : scope;
    yield* kimiEvents(payload.event, childScope);
  } else if (message.type === "StatusUpdate") {
    yield [scope, payload];
  }
}

function kimiEpochSeconds(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  const n = Number(value);
  if (Number.isFinite(n)) {
    return n > 100_000_000_000 ? n / 1000 : n;
  }
  if (typeof value === "string") {
    const ts = parseTs(value);
    return ts ? ts.epoch : null;
  }
  return null;
}

function kimiDate(record: Record<string, any>, key: string): Date | null {
  const seconds = kimiEpochSeconds(record[key]);
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

type KimiDay = Bucket & { hours: number[] };

function emptyKimiDay(): KimiDay {
  return { ...emptyBucket(), hours: new Array(24).fill(0) };
}

/** 记录键多重集：根 wire 用它抵扣 agent wire 的镜像 */
type KeyBag = Map<string, number>;

function keyOf(parts: Array<string | number | null>): string {
  return parts.map((p) => (p === null || p === undefined ? "\u0000" : String(p))).join("\u0001");
}

/** 对应 _scan_kimi_wire() */
export function scanKimiWire(
  file: string,
  options: { exclude?: KeyBag; seen?: KeyBag } = {},
): Record<string, KimiDay> {
  const { exclude = null, seen = null } = options;
  const days: Record<string, KimiDay> = {};
  const seenMessages = new Set<string>();
  const track = exclude !== null || seen !== null;
  if (!isFile(file)) return days;

  forEachLine(file, (text) => {
    if (!text.startsWith("{")) return;
    if (!text.includes('"usage.record"') && !text.includes('"StatusUpdate"') && !text.includes('"SubagentEvent"')) return;
    let record: Record<string, any>;
    try {
      record = JSON.parse(text);
    } catch {
      return;
    }
    if (!record || typeof record !== "object") return;

    if (record.type === "usage.record") {
      const usage = record.usage;
      const date = kimiDate(record, "time");
      if (!usage || typeof usage !== "object" || date === null) return;
      const inp = int(usage.inputOther);
      const out = int(usage.output);
      const cr = int(usage.inputCacheRead);
      const cw = int(usage.inputCacheCreation);
      if (inp + out + cr + cw === 0) return;
      const model = typeof record.model === "string" && record.model.trim() ? record.model : null;
      if (track) {
        const key = keyOf(["u", Math.round(date.getTime()), model, inp, out, cr, cw]);
        if (exclude) {
          const left = exclude.get(key) || 0;
          if (left > 0) {
            exclude.set(key, left - 1);
            return;
          }
        }
        if (seen) seen.set(key, (seen.get(key) || 0) + 1);
      }
      const day = (days[dayKey(date)] ??= emptyKimiDay());
      // 成本参数留空：Kimi 不推断 USD
      addTokenUsage(day, inp, out, cr, cw, 0, 0, model);
      day.hours[date.getHours()] += inp + out + cr + cw;
      return;
    }

    const date = kimiDate(record, "timestamp");
    if (date === null) return;
    for (const [scope, payload] of kimiEvents(record.message)) {
      const usage = payload.token_usage;
      if (!usage || typeof usage !== "object") continue;
      const messageId = typeof payload.message_id === "string" && payload.message_id ? payload.message_id : null;
      let dedupId: string | null = null;
      if (messageId) {
        dedupId = `${scope}:${messageId}`;
        if (seenMessages.has(dedupId)) continue;
        seenMessages.add(dedupId);
      }
      const inp = int(usage.input_other);
      const out = int(usage.output);
      const cr = int(usage.input_cache_read);
      const cw = int(usage.input_cache_creation);
      if (inp + out + cr + cw === 0) continue;
      if (track) {
        const key = messageId
          ? keyOf(["m", scope, messageId])
          : keyOf(["t", Math.round(date.getTime()), scope, inp, out, cr, cw]);
        if (exclude) {
          const left = exclude.get(key) || 0;
          if (left > 0) {
            exclude.set(key, left - 1);
            continue;
          }
        }
        if (seen) seen.set(key, (seen.get(key) || 0) + 1);
      }
      const day = (days[dayKey(date)] ??= emptyKimiDay());
      addTokenUsage(day, inp, out, cr, cw, 0, 0, null);
      day.hours[date.getHours()] += inp + out + cr + cw;
    }
  });
  return days;
}

interface KimiFileEntry {
  sig: string;
  days: Record<string, KimiDay>;
  sid: string;
  proj: string | null;
  agent: string;
  parser_version: number;
}

function fileSignature(file: string, extra?: string): string {
  const st = fs.statSync(file);
  const base = `${Math.trunc(st.mtimeMs / 1000)}:${st.size}`;
  return extra ? `${base}:${extra}` : base;
}

/** 对应 _kimi_group_signature() */
function kimiGroupSignature(files: string[]): string {
  const parts = files.map((file) => {
    try {
      const st = fs.statSync(file);
      return `${file}:${Math.trunc(st.mtimeMs / 1000)}:${st.size}`;
    } catch {
      return `${file}:-`;
    }
  });
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

export interface KimiCodeScanResult {
  ranges: Record<RangeKey, TokenUsageRangeOut>;
  p5: number | null;
  pw: number | null;
  r5: number | null;
  rw: number | null;
  q_updated: number | null;
  p5_stale: boolean | null;
  pw_stale: boolean | null;
  plan: string | null;
  /** 逐日明细只留在扫描缓存侧供 Dashboard 复用，不进 payload（见 compute.ts 注释），故可选 */
  days?: Record<string, { in: number; out: number; cr: number; cw: number; reason: number; cost: number; hours: number[]; sessions: string[]; projects: string[]; models: Record<string, ModelUsage> }>;
}

/** live_days 的日账：对应 Python 12404-12407 盖章后的形状（sorted 会话/项目 + 成本缓存版本）；
 *  注意这里的 sessions/projects 是名单数组（账本形状），不是 Bucket 的 Set */
type KimiLiveDay = Omit<KimiDay, "sessions"> & { sessions: string[]; projects: string[]; _cost_version?: number };

/** 对应 scan_kimicode()（12338-12419） */
export function scanKimiCode(bounds: Bounds, cache: Record<string, any>): KimiCodeScanResult {
  ledgerTouch("kimicode"); // 对应 12339；kimicode 不在 _UNPRICED_COST_TOOLS 里，无需 prepare_unpriced_cost_ledger
  const fc: Record<string, KimiFileEntry> = (cache.kimicode ??= {});
  const groups = kimiWireGroups();
  const files: string[] = [];
  const mirrors = new Map<string, string[]>();
  for (const group of groups) {
    for (const file of group.agentWires) files.push(file);
    if (group.rootWire) {
      files.push(group.rootWire);
      if (group.agentWires.length) mirrors.set(group.rootWire, group.agentWires);
    }
  }
  const uniqueFiles = [...new Set(files)].sort();
  if (!uniqueFiles.length && Object.keys(fc).length) {
    for (const key of Object.keys(fc)) delete fc[key];
    cache._dirty = true;
  }

  const projects = kimiProjectMap();
  const keep = new Set(uniqueFiles);
  for (const file of uniqueFiles) {
    let sig: string;
    try {
      sig = fileSignature(file);
    } catch {
      continue;
    }
    const mirrorOf = mirrors.get(file) ?? null;
    // agent wire 一变，根 wire 的镜像抵扣就得重算，否则抵扣错位
    if (mirrorOf) sig = `${sig}:${kimiGroupSignature(mirrorOf)}`;
    const context = kimiWireContext(file, projects);
    const entry = fc[file];
    if (!entry || entry.sig !== sig || entry.parser_version !== KIMI_PARSER_VERSION) {
      let exclude: KeyBag | undefined;
      if (mirrorOf) {
        // 对应 _kimi_record_counts()：把 agent wire 的记录键计成多重集当排除表
        exclude = new Map();
        for (const agentWire of mirrorOf) scanKimiWire(agentWire, { seen: exclude });
      }
      fc[file] = {
        sig,
        days: scanKimiWire(file, exclude ? { exclude } : {}),
        sid: context.sid,
        proj: context.proj,
        agent: context.agent,
        parser_version: KIMI_PARSER_VERSION,
      };
      cache._dirty = true;
    } else if (entry.sid !== context.sid || entry.proj !== context.proj || entry.agent !== context.agent) {
      entry.sid = context.sid;
      entry.proj = context.proj;
      entry.agent = context.agent;
      cache._dirty = true;
    }
  }
  for (const stale of Object.keys(fc)) {
    if (!keep.has(stale)) {
      delete fc[stale];
      cache._dirty = true;
    }
  }

  const liveDays: Record<string, KimiLiveDay> = {};
  for (const [file, entry] of Object.entries(fc)) {
    for (const [dayKeyText, day] of Object.entries(entry.days || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKeyText)) continue;
      const target = (liveDays[dayKeyText] ??= { ...emptyKimiDay(), sessions: [], projects: [] } as any);
      mergeLiveDay(target as any, day as any);
      const session = entry.sid || file;
      if (!target.sessions.includes(session)) target.sessions.push(session);
      const project = entry.proj;
      if (typeof project === "string" && project && !target.projects.includes(project)) target.projects.push(project);
    }
  }

  // 对应 12404-12407：对账之前先给每个实时日盖章（sorted 会话/项目 + 成本缓存版本）
  for (const day of Object.values(liveDays)) {
    day.sessions = [...new Set(day.sessions)].sort();
    day._cost_version = OPENCODE_COST_VERSION;
    day.projects = [...new Set(day.projects)].sort();
  }

  const buckets = Object.fromEntries(RANGE_KEYS.map((k) => [k, emptyBucket()])) as Record<RangeKey, Bucket>;
  // 天级高水位对账（对应 12409 ledger_reconcile("kimicode", live_days, _ledger_file_sources(fc, "sid"))）：
  // wire 日志被删的天用逐 sid 来源快照回补
  const reconciled = ledgerReconcile("kimicode", liveDays, ledgerFileSources(fc, "sid")) as Record<string, KimiLiveDay>;
  for (const [dayKeyText, day] of Object.entries(reconciled)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKeyText)) continue; // 对应 12410-12413 的 date.fromisoformat 校验
    for (const key of classifyDay(dayKeyText, bounds)) {
      mergeTokenDay(buckets[key], day);
      // 对应 12416：会话名单随账本的一天一起回补
      for (const session of day.sessions ?? []) buckets[key].sessions.add(session);
    }
  }

  const days = Object.fromEntries(Object.entries(liveDays).map(([key, day]) => [key, {
    in: day.in, out: day.out, cr: day.cr, cw: day.cw, reason: day.reason, cost: day.cost,
    hours: day.hours, sessions: day.sessions, projects: day.projects, models: day.models,
  }]));

  return {
    ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, tokenUsageRange(buckets[k])])) as Record<RangeKey, TokenUsageRangeOut>,
    // 额度接口是网络调用，本里程碑保持 null
    p5: null, pw: null, r5: null, rw: null, q_updated: null, p5_stale: null, pw_stale: null, plan: null,
    days,
  };
}

// ---------------- 额度（网络，本里程碑 OUT OF SCOPE） ----------------

/**
 * 下一里程碑接入 `GET https://api.kimi.com/coding/v1/usages` 时使用：
 * 凭据由 Kimi Code CLI 自己写入并刷新，位置固定为 `${KIMI_CODE_HOME:-~/.kimi-code}/credentials/kimi-code.json`
 * （旧根 ~/.kimi 同样兼容）。Tokei **只读 access_token，绝不使用同文件里的 refresh_token**：
 * OAuth refresh token 带 rotation，抢先刷新会顶掉 CLI 自己的登录态。
 * access_token 实测约 30 分钟失效，过期就直接跳过这次请求（发出去必然 401）并沿用缓存 + stale 标记。
 * 这里只暴露位置与过期判定，不读取 token 内容，也不发请求。
 */
export function kimiCredentialFiles(roots = kimiRoots()): string[] {
  return roots.map((root) => path.join(root, "credentials", "kimi-code.json"));
}

export interface KimiCredentialState {
  expiresAt: number | null;
  expired: boolean;
  /** 只报告有没有可用凭据，不回传 token 本身 */
  hasAccessToken: boolean;
}

/** 对应 _kimi_auth_context() 的本地部分：仍然绝不调用 refresh_token */
export function kimiCredentialState(nowEpoch = Date.now() / 1000, files = kimiCredentialFiles()): KimiCredentialState | null {
  for (const file of files) {
    const creds = loadJson<Record<string, any>>(file, {});
    if (!creds || typeof creds !== "object") continue;
    const token = creds.access_token;
    if (typeof token !== "string" || !token) continue;
    const expiresAt = kimiEpochSeconds(creds.expires_at);
    return { expiresAt, expired: !!(expiresAt !== null && nowEpoch >= expiresAt), hasAccessToken: true };
  }
  return null;
}

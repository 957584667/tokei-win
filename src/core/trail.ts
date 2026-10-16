/**
 * 项目足迹：把各工具缓存里的「哪次会话在哪个项目哪一天用了多少」汇成一条贡献流，
 * 再按项目路径聚合。对应 usage.30s.py 的 _project_contributions() + projects()。
 *
 * 数据只从扫描缓存里取，不进 payload —— payload 是给卡片用的区间汇总，逐项目明细
 * 只在点开足迹页时算一次（macOS 也是按需 runScript(["--projects"])）。
 *
 * 接入新工具：会话级工具让 scanner 在缓存条目上写 proj（项目绝对路径）；
 * 一个库存多项目的工具写 day.projects[路径]。再在 _FILE_SOURCES / _RECORD_SOURCES /
 * _DAY_SOURCES 对应那张表加一行，两个页面同时生效。
 *
 * session 口径同 Python：
 *   "entry" —— 一个缓存条目就是一次会话，按条目键计数；
 *   "sid"   —— 条目上的 sid 才是会话标识，跨条目去重（一次会话写多个文件）。
 */
import { niceModel } from "./ranges";
import { tokenTotal } from "./model";
import { iterWorkBuddyRecords } from "../collectors/workbuddy";
import { iterCodebuddyRecords } from "../collectors/codebuddy";
import { iterHarnessRecords } from "../collectors/deepseek_harness";
import { grokUsageDays } from "../collectors/grok";

export interface TrailProject {
  path: string;
  name: string;
  last_active: string;
  sessions: number;
  tokens: number;
  cost: number;
  cost_cny?: number;
  top_model: string;
  tools: string[];
}

interface Contribution {
  tool: string;
  label: string;
  path: string;
  day: string;
  tokens: number;
  cost: number;
  costCny: number;
  models: Record<string, number>;
  /** 一个 id，或（数据库型工具）一组 id */
  session: string | string[];
}

type FileSource = {
  tool: string;
  label: string;
  /** 该工具的成本是否可信到能记账（Kimi 的 wire 不落盘真实成本，与卡片口径一致不记） */
  withCost: boolean;
  sidSession: boolean;
  count: (usage: Record<string, any>) => number;
};

/** Muse Code 的推理并进输出，口径与其它工具不同，所以按工具指定计数函数 */
function museTokenTotal(usage: Record<string, any>): number {
  return (usage.in || 0) + (usage.out || 0) + (usage.cr || 0) + (usage.cw || 0);
}

const FILE_SOURCES: FileSource[] = [
  { tool: "claude", label: "Claude", withCost: true, sidSession: false, count: tokenTotal },
  { tool: "codex", label: "Codex", withCost: true, sidSession: false, count: tokenTotal },
  { tool: "pi", label: "Pi", withCost: true, sidSession: false, count: tokenTotal },
  { tool: "prime_agent", label: "Prime Agent", withCost: true, sidSession: false, count: tokenTotal },
  { tool: "kimicode", label: "Kimi Code", withCost: false, sidSession: true, count: tokenTotal },
  { tool: "musecode", label: "Muse Code", withCost: true, sidSession: true, count: museTokenTotal },
  { tool: "cmdcode", label: "Command Code", withCost: true, sidSession: true, count: tokenTotal },
];

type RecordSource = {
  tool: string;
  label: string;
  iterate: (fileCache: Record<string, any>) => Array<[string, any, Record<string, any>]>;
  defaultModel?: string;
};

const RECORD_SOURCES: RecordSource[] = [
  { tool: "workbuddy", label: "WorkBuddy", iterate: iterWorkBuddyRecords },
  { tool: "workbuddy_ai", label: "WorkBuddy Intl.", iterate: iterWorkBuddyRecords },
  { tool: "codebuddy", label: "CodeBuddy", iterate: iterCodebuddyRecords },
  { tool: "deepseek_harness", label: "DeepSeek Harness", iterate: iterHarnessRecords, defaultModel: "deepseek-v4-pro" },
];

const DAY_SOURCES: DaySource[] = [
  { tool: "devin", label: "Devin" },
  { tool: "minimax", label: "MiniMax Code" },
  { tool: "hermes", label: "Hermes" },
  { tool: "opencode", label: "OpenCode" },
  { tool: "mimocode", label: "MiMoCode" },
];

/** 数据库型工具的第三种形状：用量挂在 day.projects[绝对路径] 上 */
type DaySource = {
  tool: string;
  label: string;
};

function projPathOf(entry: any): string {
  const raw = entry?.proj;
  return typeof raw === "string" ? raw : "";
}

function* fileContributions(cache: Record<string, any>): Generator<Contribution> {
  for (const source of FILE_SOURCES) {
    const toolCache = cache[source.tool];
    if (!toolCache || typeof toolCache !== "object") continue;
    for (const [entryKey, raw] of Object.entries(toolCache)) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, any>;
      const proj = projPathOf(entry);
      if (!proj || proj === "?") continue;
      const session = source.sidSession ? String(entry.sid ?? entryKey) : entryKey;
      const days = entry.days;
      if (!days || typeof days !== "object") continue;
      for (const [dayKey, day] of Object.entries<any>(days)) {
        if (!day || typeof day !== "object") continue;
        const models: Record<string, number> = {};
        for (const [name, usage] of Object.entries<any>(day.models ?? {})) {
          models[`${niceModel(name)} (${source.label})`] = source.count(usage ?? {});
        }
        yield {
          tool: source.tool, label: source.label, path: proj, day: dayKey,
          tokens: Math.trunc(source.count(day)), cost: source.withCost ? Number(day.cost) || 0 : 0,
          costCny: 0, models, session,
        };
      }
    }
  }
}

function* recordContributions(cache: Record<string, any>): Generator<Contribution> {
  for (const source of RECORD_SOURCES) {
    const toolCache = cache[source.tool];
    if (!toolCache || typeof toolCache !== "object") continue;
    for (const [entryPath, entry, record] of source.iterate(toolCache)) {
      const proj = projPathOf(entry);
      if (!proj || proj === "?") continue;
      const model = record.model || source.defaultModel || "unknown";
      const tokens = tokenTotal(record);
      yield {
        tool: source.tool, label: source.label, path: proj, day: String(record.date ?? ""),
        tokens, cost: Number(record.cost) || 0, costCny: Number(record.cost_cny) || 0,
        models: { [`${niceModel(model)} (${source.label})`]: tokens },
        session: String(record.session || entry.sid || entryPath),
      };
    }
  }
}

/**
 * 第三种形状：一个库里装着多个项目（数据库型工具），项目挂在「天」上
 *   entry.days[日期].projects[项目路径] = { tokens, cost, models, sessions }
 * 账本归档也会往 day.projects 写名字列表，那一版不是逐项目用量，必须跳过。
 */
function dayProjects(day: any): Record<string, any> | null {
  if (!day || typeof day !== "object") return null;
  const buckets = day.projects;
  if (!buckets || typeof buckets !== "object" || Array.isArray(buckets)) return null;
  return buckets as Record<string, any>;
}

function* dayContributions(cache: Record<string, any>): Generator<Contribution> {
  for (const source of DAY_SOURCES) {
    const toolCache = cache[source.tool];
    if (!toolCache || typeof toolCache !== "object") continue;
    for (const entry of Object.values<any>(toolCache)) {
      if (!entry || typeof entry !== "object") continue;
      for (const [dayKey, day] of Object.entries<any>(entry.days ?? {})) {
        const buckets = dayProjects(day);
        if (!buckets) continue;
        for (const [proj, usage] of Object.entries<any>(buckets)) {
          if (!proj || !usage || typeof usage !== "object") continue;
          const models: Record<string, number> = {};
          for (const [name, amount] of Object.entries(usage.models ?? {})) {
            models[`${niceModel(name)} (${source.label})`] = Math.trunc(Number(amount) || 0);
          }
          const ids = Array.isArray(usage.sessions)
            ? usage.sessions.filter((sid: unknown) => Boolean(sid)).map(String)
            : [];
          yield {
            tool: source.tool, label: source.label, path: proj, day: dayKey,
            tokens: Math.trunc(Number(usage.tokens) || 0), cost: Number(usage.cost) || 0,
            costCny: 0, models, session: ids,
          };
        }
      }
    }
  }
}

/**
 * Grok 的逐项目用量挂在「天」上，由 usage records 现算（与 scanGrok 的会话去重同规则：
 * 同一 sid 只保留 mtime 最新的那份快照）。records 直接取扫描缓存里那份，
 * 不再读第二遍日志 —— 足迹永远在 compute() 之后算，缓存就是本轮的新鲜数据。
 */
function* grokContributions(cache: Record<string, any>): Generator<Contribution> {
  const fileCache = cache.grok;
  if (!fileCache || typeof fileCache !== "object") return;
  const records = cache.grok_usage?.records;
  if (!Array.isArray(records)) return;
  const sessions: Record<string, any> = {};
  let latestMtime = -1;
  let latestModel: string | null = null;
  for (const [summaryPath, raw] of Object.entries(fileCache)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, any>;
    const sid = String(entry.sid || summaryPath);
    const current = sessions[sid];
    if (!current || Number(entry.mtime) > Number(current.mtime)) sessions[sid] = entry;
    if (entry.date && Number(entry.mtime) > latestMtime) {
      latestMtime = Number(entry.mtime);
      latestModel = entry.model || "unknown";
    }
  }
  const days = grokUsageDays(records as Parameters<typeof grokUsageDays>[0], sessions, latestModel);
  for (const [dayKey, day] of Object.entries(days)) {
    for (const [proj, usage] of Object.entries(day.projects)) {
      if (!proj || !usage) continue;
      const models: Record<string, number> = {};
      for (const [name, amount] of Object.entries(usage.models)) {
        models[`${niceModel(name)} (Grok Build)`] = Math.trunc(Number(amount) || 0);
      }
      const ids = [...usage.sessions].filter((sid) => sid);
      yield {
        tool: "grok", label: "Grok Build", path: proj, day: dayKey,
        tokens: Math.trunc(usage.tokens || 0), cost: Number(usage.cost) || 0, costCny: 0,
        models, session: ids.length === 1 ? ids[0] : ids,
      };
    }
  }
}

export function* projectContributions(cache: Record<string, any>): Generator<Contribution> {
  yield* fileContributions(cache);
  yield* recordContributions(cache);
  yield* dayContributions(cache);
  yield* grokContributions(cache);
}

/**
 * 对应 _project_day_names()：{日期: {项目名}}，与足迹页同源（都走贡献流），
 * 供 Wrapped 的「那天在哪个项目」使用。无日期的贡献跳过；名字按字典序返回，
 * 集合本身无序，排序只为让 CLI 输出与缓存快照可复现。
 */
export function projectDayNames(cache: Record<string, any>): Record<string, string[]> {
  const names = new Map<string, Set<string>>();
  for (const hit of projectContributions(cache)) {
    if (!hit.day) continue;
    let set = names.get(hit.day);
    if (!set) { set = new Set(); names.set(hit.day, set); }
    set.add(baseName(hit.path) || hit.path);
  }
  return Object.fromEntries([...names].map(([day, set]) => [day, [...set].sort()]));
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

/**
 * 分组键。Python 用原始路径当键，macOS 的大小写敏感文件系统下没问题；
 * Windows 不区分大小写，同一个 cwd 会被不同工具写成 `D:\\x` / `d:\\x` / `D:/x`，
 * 照抄就会在页面上出现两三行同名项目。所以键统一成正斜杠 + 小写 + 去尾分隔符，
 * 展示与打开用的路径仍取最近一次活跃那份原文（drive 盘符大小写以日志里最新的为准）。
 * 合并不改变 token / 成本总和，只是行不再分裂。
 */
function trailKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 对应 projects()：按项目路径聚合会话数、token、成本、最近活跃与来源工具，
 * 按 last_active 倒序。无日期条目不参与排序键，但仍计入 token。
 */
export function projectTrail(cache: Record<string, any>): TrailProject[] {
  const agg = new Map<string, {
    display: string; displayDay: string;
    tokens: number; cost: number; costCny: number; lastActive: string;
    modelTok: Map<string, number>; tools: Set<string>;
  }>();
  const seenSessions = new Map<string, Set<string>>();

  for (const hit of projectContributions(cache)) {
    const key = trailKey(hit.path);
    let p = agg.get(key);
    if (!p) {
      p = {
        display: hit.path, displayDay: hit.day, tokens: 0, cost: 0, costCny: 0,
        lastActive: "", modelTok: new Map(), tools: new Set(),
      };
      agg.set(key, p);
    } else if (hit.day > p.displayDay) {
      // 同项目不同写法时，展示用最近活跃的那份路径原文
      p.display = hit.path;
      p.displayDay = hit.day;
    }
    p.tools.add(hit.tool);
    p.tokens += hit.tokens;
    p.cost += hit.cost;
    if (hit.costCny) p.costCny += hit.costCny;
    if (hit.day > p.lastActive) p.lastActive = hit.day;
    for (const [name, tokens] of Object.entries(hit.models)) {
      p.modelTok.set(name, (p.modelTok.get(name) ?? 0) + tokens);
    }
    const ids = hit.session;
    if (Array.isArray(ids)) {
      const set = seenSessions.get(key) ?? new Set<string>();
      for (const id of ids) if (id) set.add(id);
      seenSessions.set(key, set);
    } else if (ids) {
      const set = seenSessions.get(key) ?? new Set<string>();
      set.add(ids);
      seenSessions.set(key, set);
    }
  }

  const out: TrailProject[] = [];
  for (const [key, p] of agg) {
    let topModel = "";
    let best = -1;
    for (const [name, tokens] of p.modelTok) {
      if (tokens > best) { best = tokens; topModel = name; }
    }
    const entry: TrailProject = {
      path: p.display,
      name: baseName(p.display),
      last_active: p.lastActive,
      sessions: (seenSessions.get(key)?.size ?? 0),
      tokens: p.tokens,
      cost: Math.round(p.cost * 100) / 100,
      top_model: topModel,
      tools: [...p.tools].sort(),
    };
    if (p.costCny) entry.cost_cny = Math.round(p.costCny * 100) / 100;
    out.push(entry);
  }
  out.sort((a, b) => (a.last_active < b.last_active ? 1 : a.last_active > b.last_active ? -1 : 0));
  return out;
}

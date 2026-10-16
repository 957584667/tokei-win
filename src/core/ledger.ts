/**
 * 持久账本（来源快照 + 旧版每日高水位兼容）：对应 usage.30s.py 的 1064-1500。
 *
 * 目的：CLI（如 Claude Code 默认 30 天清理）删除旧日志后，历史用量不再缩水。
 * 已接入来源标识的扫描器保留每个来源的日快照，缺失来源与新增来源可同时累计；
 * 只有日汇总的旧数据保留无法归属的余额，不能反推升级前已丢失的调用明细。
 * 独立于 scan cache 的版本机制，永不因解析器/缓存升级而失效。
 *
 * 与 Python 的唯一差别是并发保护：原版用 fcntl.flock 护住「读盘-合并-原子写」，
 * 因为 xbar 可能同时拉起多个采集进程。本端口里 compute() 只在 Electron 主进程跑，
 * 而主进程被 app.requestSingleInstanceLock() 锁成单实例，没有对手，故省掉文件锁，
 * 保留「每次都从磁盘重新读一遍再合并」这个语义。
 */
import * as crypto from "crypto";
import * as path from "path";
import { TOKEI_DIR, loadJson, saveJson } from "./paths";
import { dayKey } from "./ranges";
import { pricingId } from "./price";
import { REASON_INSIDE_OUTPUT } from "./model";

/** 对应 _LEDGER_FILE。注意这里不走 _writable_path：账本永远在 ~/.tokei 下 */
export const LEDGER_FILE = path.join(TOKEI_DIR, "ledger.json");
/** 对应 _TOKEI_CONFIG：账本损坏时从同步仓自愈要读的两个键在这里 */
export const LEDGER_CONFIG_FILE = path.join(TOKEI_DIR, "config.json");
const LEDGER_VERSION = 1;
/** 对应 _LEDGER_SOURCES_RETAIN_DAYS：_sources 只保留 45 天，合计值原样留着 */
const LEDGER_SOURCES_RETAIN_DAYS = 45;
/** 对应 _LEDGER_TOKEN_FIELDS：cached 不在其中，它永远是 in 的子集 */
const LEDGER_TOKEN_FIELDS = ["in", "out", "cr", "cw", "reason", "thoughts"] as const;
/** 对应 _UNPRICED_COST_TOOLS / _UNPRICED_COST_SCHEMA */
const UNPRICED_COST_TOOLS = ["workbuddy", "workbuddy_ai", "pi", "qwencode"];
const UNPRICED_COST_SCHEMA = 1;
/** 对应 _QODERCLI_DIRS 的键：这两个工具的账本做过整体迁移 */
const QODERCLI_TOOLS = ["qodercli", "qodercli_cn"];
/**
 * 对应 _CODEX_ACCOUNTING_VERSION（806）。与 collectors/codex.ts 里导出的同名常量
 * 是同一个数，两处必须一起改；这里不 import 是为了避开 ledger ←→ codex 的循环依赖。
 */
const CODEX_ACCOUNTING_VERSION = 7;
/** 对应 ledger_reconcile 里 "2025-01-01" <= dk 的下界：比这更早的天不入账 */
const LEDGER_MIN_DAY = "2025-01-01";

export type DayRecord = Record<string, any>;
export type LedgerDays = Record<string, DayRecord>;
export type LedgerTools = Record<string, LedgerDays>;

export interface Ledger {
  v: number;
  tools: LedgerTools;
  [schema: string]: any;
}

/** 对应 _LEDGER_CACHE：一轮扫描只在末尾 flush 一次 */
const memo: { data: Ledger | null; dirty: boolean } = { data: null, dirty: false };

let ledgerFile = LEDGER_FILE;
let configFile = LEDGER_CONFIG_FILE;

/** 测试注入口：把账本与配置指到临时目录，避免写真实的 ~/.tokei/ledger.json */
export function useLedgerFile(file?: string | null, config?: string | null): void {
  ledgerFile = file ?? LEDGER_FILE;
  configFile = config ?? LEDGER_CONFIG_FILE;
  memo.data = null;
  memo.dirty = false;
}

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDict(value: unknown): value is DayRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Set);
}

/** 对应 _ledger_record_version：_ledger_version 优先，回落到旧的 _cost_version */
export function ledgerRecordVersion(day: unknown): number {
  if (!isDict(day)) return 0;
  const value = day._ledger_version !== undefined ? day._ledger_version : day._cost_version;
  return isNum(value) ? Math.trunc(value) : 0;
}

/** 对应 _ledger_day_total：字段无关的当日体量，cost 类与下划线元数据不算 */
export function ledgerDayTotal(day: unknown): number {
  if (!isDict(day)) return 0;
  let sum = 0;
  for (const [key, value] of Object.entries(day)) {
    if (typeof value === "boolean") continue;
    if (!isNum(value) || key === "cost" || key === "cost_cny" || key.startsWith("_")) continue;
    sum += value;
  }
  return sum;
}

/** 对应 _ledger_token_sum：reason 对某些工具是 out 的子集，不能重复相加 */
export function ledgerTokenSum(day: unknown, tool?: string | null): number {
  if (!isDict(day)) return 0;
  let tokens = 0;
  for (const field of LEDGER_TOKEN_FIELDS) {
    if (tool && REASON_INSIDE_OUTPUT.has(tool) && field === "reason") continue;
    const value = day[field];
    if (isNum(value)) tokens += Math.trunc(value);
  }
  return tokens;
}

function toArray(value: unknown): any[] {
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value;
  return [];
}

/**
 * 对应 Python 的 `a != b`：字典比较只看键值，不看插入顺序。
 * JSON.stringify 那种「序列化后比字符串」的写法会在键顺序不同时报假差异，
 * 让账本每轮都被标脏、整份重写。采集器（codex 的混合账本迁移）也用同一个比较。
 */
export function ledgerSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Set || b instanceof Set) {
    const aa = new Set(toArray(a).map((v) => JSON.stringify(v)).sort());
    const bb = new Set(toArray(b).map((v) => JSON.stringify(v)).sort());
    return aa.size === bb.size && [...aa].every((v) => bb.has(v));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => ledgerSameValue(item, b[i]));
  }
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => ledgerSameValue(a[k], b[k]));
  }
  return false;
}

/**
 * 对应 _ledger_values：合并 JSON 日账（含 models/hours 明细），元数据永不相加。
 * subtract 用于「旧总量减掉还能重新看到的部分」，得到无法归属的 legacy 余额。
 */
export function ledgerValues(left: DayRecord, right: DayRecord, subtract = false): DayRecord {
  const result: DayRecord = {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (key === "_sources") continue;
    const a = left[key];
    const b = right[key];
    if (isDict(a) || isDict(b)) {
      result[key] = ledgerValues(isDict(a) ? a : {}, isDict(b) ? b : {}, subtract);
    } else if (key.startsWith("_")) {
      result[key] = Math.max(a || 0, b || 0);
    } else if (isNum(a) || isNum(b)) {
      const diff = (a || 0) - (b || 0);
      result[key] = subtract ? Math.max(diff, 0) : (a || 0) + (b || 0);
    } else if (key === "hours") {
      const aa: number[] = Array.isArray(a) && a.length ? a : new Array(24).fill(0);
      const bb: number[] = Array.isArray(b) && b.length ? b : new Array(24).fill(0);
      const len = Math.min(aa.length, bb.length);
      const merged: number[] = [];
      for (let i = 0; i < len; i++) merged.push(subtract ? Math.max(aa[i] - bb[i], 0) : aa[i] + bb[i]);
      result[key] = merged;
    } else if (a instanceof Set || b instanceof Set || Array.isArray(a) || Array.isArray(b)) {
      const aa = toArray(a);
      const bb = toArray(b);
      if (subtract) {
        const drop = new Set(bb);
        result[key] = [...new Set(aa)].filter((item) => !drop.has(item)).sort();
      } else {
        result[key] = [...new Set([...aa, ...bb])].sort();
      }
    } else if (a !== undefined && a !== null || b !== undefined && b !== null) {
      result[key] = subtract ? a : (b !== undefined && b !== null ? b : a);
    }
  }
  return result;
}

/** 对应 _ledger_source_preferred：先看记账版本，再看体量，平局取新的 */
export function ledgerSourcePreferred(candidate: DayRecord, kept: DayRecord | null | undefined): boolean {
  if (kept === null || kept === undefined) return true;
  const revision = (value: DayRecord) => [Number(value._accounting_version || 0), ledgerRecordVersion(value)];
  const mine = revision(candidate);
  const theirs = revision(kept);
  const greater = mine[0] > theirs[0] || (mine[0] === theirs[0] && mine[1] > theirs[1]);
  if (greater) return true;
  return mine[0] === theirs[0] && mine[1] === theirs[1]
    && ledgerDayTotal(candidate) >= ledgerDayTotal(kept);
}

/** 对应 _codex_legacy_day：保留历史总量，但不给旧余额编造归属 */
export function codexLegacyDay(input: DayRecord): DayRecord {
  const day: DayRecord = { ...input };
  const inp = Number(day.in || 0);
  const out = Number(day.out || 0);
  day.cached = Math.min(Number(day.cached || 0), inp);
  day.reason = Math.min(Number(day.reason || 0), out);
  const expected: Record<string, number> = {
    in: inp - day.cached, out, cr: day.cached, cw: 0, reason: day.reason, cost: Number(day.cost || 0),
  };
  const models: Record<string, any> = isDict(day.models) ? day.models : {};
  const names = Object.keys(models);
  const mismatch = (["in", "out", "cr", "cw", "reason"] as const).some((field) => {
    const summed = names.reduce((acc, name) => acc + Number(models[name]?.[field] || 0), 0);
    return summed !== expected[field];
  });
  if (mismatch) day.models = inp + out || expected.cost ? { unknown: expected } : {};
  const hours: number[] = toArray(day.hours);
  if (hours.reduce((a, b) => a + Number(b || 0), 0) > inp + out) day.hours = new Array(24).fill(0);
  return day;
}

/** 对应 _ledger_merge_sources：保留缺席来源、替换已知来源，绝不对整天取 max */
export function ledgerMergeSources(
  kept: DayRecord | null | undefined,
  current: Record<string, DayRecord>,
  tool?: string | null,
): DayRecord {
  const base: DayRecord = isDict(kept) ? kept! : {};
  const sources: Record<string, DayRecord> = { ...(isDict(base._sources) ? base._sources : {}) };
  if (base._sources === undefined && Object.keys(base).length) {
    let live: DayRecord = {};
    for (const snapshot of Object.values(current)) live = ledgerValues(live, snapshot);
    // v1 没有 provenance：只保住它那笔无法归属的余额，而不是旧总量 + 全部现存会话
    sources.legacy = ledgerValues(base, live, true);
  }
  for (const [source, snapshot] of Object.entries(current)) {
    const authoritativeCodexSource = !!tool && (tool === "codex" || tool === "codex_reserve")
      && Number(snapshot._accounting_version || 0) >= CODEX_ACCOUNTING_VERSION;
    if (authoritativeCodexSource || ledgerSourcePreferred(snapshot, sources[source])) {
      sources[source] = snapshot;
    }
  }
  // 余额已经被完整重建出来，就不该再有按 token 计的成本；
  // 这同时修掉早期「美元折算成人民币」迁移留下的孤儿 USD
  const currentValues = Object.values(current);
  if (tool === "deepseek_harness" && sources.legacy && currentValues.length
    && currentValues.some((day) => Number(day.cost_cny || 0) > 0)
    && ledgerTokenSum(base, tool) > 0 && ledgerTokenSum(sources.legacy, tool) === 0) {
    const legacy = (sources.legacy = { ...sources.legacy });
    legacy.cost = 0.0;
    legacy.cost_cny = 0.0;
    legacy.models = {};
  }
  if (tool === "codex" && sources.legacy) sources.legacy = codexLegacyDay(sources.legacy);
  let result: DayRecord = {};
  for (const snapshot of Object.values(sources)) result = ledgerValues(result, snapshot);
  result._sources = sources;
  return result;
}

/** 对应 _ledger_file_sources：扫描器去重后的逐文件贡献，逻辑 ID 能扛住文件移动 */
export function ledgerFileSources(
  fileCache: Record<string, any>,
  identityField?: string | ((file: string, entry: DayRecord) => any),
  accountingVersion = 1,
): Record<string, Record<string, DayRecord>> {
  const sources: Record<string, Record<string, DayRecord>> = {};
  for (const [file, entry] of Object.entries(fileCache)) {
    if (!isDict(entry) || !isDict(entry.days) || !Object.keys(entry.days).length) continue;
    const identity = typeof identityField === "function" ? identityField(file, entry)
      : identityField ? entry[identityField] : undefined;
    const target = (sources[String(identity ?? file)] ??= {});
    const dayHours = isDict(entry.day_hours) ? entry.day_hours : {};
    for (const [dk, day] of Object.entries<DayRecord>(entry.days)) {
      target[dk] = ledgerValues(target[dk] ?? {}, day);
      if (dayHours[dk] !== undefined) target[dk].hours = [...dayHours[dk]];
      target[dk]._accounting_version = accountingVersion;
    }
  }
  return sources;
}

/** 对应 _ledger_add_record_source：按「一条记录」累计来源贡献 */
export function ledgerAddRecordSource(
  sources: Record<string, Record<string, DayRecord>>,
  identity: unknown,
  dk: string,
  record: DayRecord,
  hour?: number | null,
): void {
  const days = (sources[String(identity)] ??= {});
  const contribution: DayRecord = {};
  for (const field of ["in", "out", "cr", "cw", "reason", "cost", "cost_cny", "credits"]) {
    contribution[field] = record[field] ?? 0;
  }
  // Python 用真值判断：空 models 走「按模型名单建一份」的分支
  if (record.models && Object.keys(record.models).length) contribution.models = record.models;
  else if (record.model) contribution.models = { [String(record.model)]: { ...contribution } };
  if (typeof hour === "number" && Number.isInteger(hour) && hour >= 0 && hour < 24) {
    contribution.hours = new Array(24).fill(0);
    contribution.hours[hour] = recordTokenTotal(record);
  }
  days[dk] = ledgerValues(days[dk] ?? {}, contribution);
}

/**
 * 对应 token_total：注意这里用的是 TOKEN_FIELDS（不含 thoughts），
 * 与 ledgerTokenSum 的白名单不是一回事。
 */
function recordTokenTotal(record: DayRecord): number {
  return ["in", "out", "cr", "cw", "reason"].reduce((sum, field) => sum + Number(record[field] || 0), 0);
}

function tomorrow(): string {
  return shiftDay(dayKey(new Date()), 1);
}

/** 对应 _load_ledger_from_disk：本地账本坏了就从同步仓的本机快照 _ledger 恢复 */
function loadLedgerFromDisk(): Ledger {
  const onDisk = loadJson<Ledger | null>(ledgerFile, null);
  if (onDisk && onDisk.v === LEDGER_VERSION && typeof onDisk.tools === "object" && onDisk.tools !== null) return onDisk;
  try {
    const cfg = loadJson<Record<string, any>>(configFile, {});
    const device = String(cfg.device_id || "").trim();
    const syncDir = String(cfg.sync_dir || "").trim();
    if (device && syncDir) {
      const backup = loadJson<{ _ledger?: Ledger } | null>(path.join(syncDir, `${device}.json`), null);
      const restored = backup?._ledger;
      if (restored && restored.v === LEDGER_VERSION && restored.tools && Object.keys(restored.tools).length) {
        saveLedger(restored);
        return restored;
      }
    }
  } catch {
    /* 自愈失败就用空账本重扫 */
  }
  return { v: LEDGER_VERSION, tools: {} };
}

/** 对应 _load_ledger：进程内只读一次盘 */
export function loadLedger(): Ledger {
  if (memo.data !== null) return memo.data;
  memo.data = loadLedgerFromDisk();
  return memo.data;
}

/** 对应 _prune_ledger_sources：过保留期的天只丢来源明细，合计不动 */
export function pruneLedgerSources(ledger: Ledger, today?: string): boolean {
  const anchor = today ?? dayKey(new Date());
  const cutoff = shiftDay(anchor, -LEDGER_SOURCES_RETAIN_DAYS);
  let pruned = false;
  for (const days of Object.values(ledger.tools || {})) {
    if (!isDict(days)) continue;
    for (const [dk, day] of Object.entries(days)) {
      if (dk >= cutoff || !isDict(day)) continue;
      if (day._sources !== undefined) {
        delete day._sources;
        pruned = true;
      }
    }
  }
  return pruned;
}

function shiftDay(anchor: string, days: number): string {
  const [y, m, d] = anchor.split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  date.setDate(date.getDate() + days);
  return dayKey(date);
}

/** 对应 _save_ledger：先收拢来源，再原子写 */
export function saveLedger(ledger: Ledger): void {
  pruneLedgerSources(ledger);
  saveJson(ledgerFile, ledger);
}

/** 对应 _ledger_schema_keys：需要整体迁移的工具账本，迁移后成本可能更低，不能被磁盘高水位合回去 */
function ledgerSchemaKeys(): [string, string][] {
  return [
    ...QODERCLI_TOOLS.map((tool) => [`${tool}_schema`, tool] as [string, string]),
    ...UNPRICED_COST_TOOLS.map((tool) => [`${tool}_unpriced_schema`, tool] as [string, string]),
  ];
}

/** 对应 ledger_flush()：短锁内与磁盘最新状态做天级高水位合并后原子写 */
export function ledgerFlush(): void {
  if (!memo.dirty || memo.data === null) return;
  const fresh = loadLedgerFromDisk();
  const cache = memo.data;
  for (const [schemaKey, schemaTool] of ledgerSchemaKeys()) {
    const memoSchema = Number(cache[schemaKey] || 0);
    if (memoSchema > Number(fresh[schemaKey] || 0)) {
      (fresh.tools ??= {})[schemaTool] = { ...(cache.tools?.[schemaTool] || {}) };
      fresh[schemaKey] = memoSchema;
    }
  }
  for (const [tool, days] of Object.entries(cache.tools || {})) {
    const stored = (fresh.tools ??= {})[tool] ??= {};
    for (const [dk, day] of Object.entries(days || {})) {
      const kept = stored[dk];
      if (tool === "codex" && kept && ledgerRecordVersion(day) > ledgerRecordVersion(kept)) {
        // Reserve 归属升级会把 Codex 总量调低，得在来源合并重新造出余额之前先替换旧的混合天
        stored[dk] = day;
      } else if (day._sources !== undefined && day._sources !== null) {
        stored[dk] = ledgerMergeSources(kept, day._sources, tool);
        for (const key of ["projects", "sessions"]) {
          if (Array.isArray(day[key]) || day[key] instanceof Set) {
            const merged = new Set([...toArray(stored[dk][key]), ...toArray(day[key])]);
            stored[dk][key] = [...merged].sort();
          }
        }
      } else if (tool === "opencode" && kept && ledgerTokenSum(kept, tool) > ledgerTokenSum(day, tool)) {
        continue; // 并发的历史快照也要保住
      } else if (tool === "codex" && kept && kept._sources === undefined) {
        stored[dk] = codexLegacyDay(ledgerSourcePreferred(day, kept) ? day : kept);
      } else if (kept === undefined
        || ledgerRecordVersion(day) > ledgerRecordVersion(kept)
        || (ledgerRecordVersion(day) === ledgerRecordVersion(kept)
          && ledgerDayTotal(day) > ledgerDayTotal(kept))) {
        stored[dk] = day;
      }
    }
  }
  saveLedger(fresh);
  memo.data = fresh;
  memo.dirty = false;
}

/** 对应 _drop_unpriced_costs：清掉没有公开价模型被按 Opus 兜底猜出来的成本 */
export function dropUnpricedCosts(day: DayRecord): void {
  const models = day.models;
  if (isDict(models)) {
    for (const [name, usage] of Object.entries(models)) {
      if (isDict(usage) && Number(usage.cost || 0) > 0 && !pricingId(name)) {
        day.cost = Math.max(Number(day.cost || 0) - Number(usage.cost), 0.0);
        usage.cost = 0.0;
      }
    }
  }
  for (const source of Object.values(isDict(day._sources) ? day._sources : {})) {
    if (isDict(source)) dropUnpricedCosts(source);
  }
}

/** 对应 _prepare_unpriced_cost_ledger */
export function prepareUnpricedCostLedger(tool: string): void {
  const ledger = loadLedger();
  const schemaKey = `${tool}_unpriced_schema`;
  if (ledger[schemaKey] === UNPRICED_COST_SCHEMA) return;
  for (const day of Object.values(ledger.tools?.[tool] || {})) {
    if (isDict(day)) dropUnpricedCosts(day);
  }
  ledger[schemaKey] = UNPRICED_COST_SCHEMA;
  memo.dirty = true;
}

/**
 * 对应 ledger_reconcile()：对账。
 * - 实时值 >= 账本值的天：以实时为准，并把账本刷新到实时（高水位上移）
 * - 实时值 < 账本值的天（日志被部分/全部清理）：返回账本存档值
 * - 账本独有的天（日志已整体消失）：账本兜底
 * 天级整取整用，不做字段级混合，天然避免重复计数。纯内存操作；
 * 落盘由 compute() 末尾的 ledgerFlush() 统一完成。
 */
export function ledgerReconcile(
  tool: string,
  liveDays: LedgerDays,
  sourceDays?: Record<string, Record<string, DayRecord>> | null,
): LedgerDays {
  const ledger = loadLedger();
  const stored = (ledger.tools ??= {})[tool] ??= {};
  let dirty = false;
  const merged: LedgerDays = {};
  const maxDay = tomorrow();

  if (sourceDays !== null && sourceDays !== undefined) {
    const byDay: Record<string, Record<string, DayRecord>> = {};
    for (const [source, days] of Object.entries(sourceDays)) {
      const sourceId = crypto.createHash("sha256").update(String(source)).digest("hex");
      for (const [dk, day] of Object.entries(days)) {
        (byDay[dk] ??= {})[sourceId] = ledgerValues({}, day);
      }
    }
    for (const dk of new Set([...Object.keys(stored), ...Object.keys(liveDays), ...Object.keys(byDay)])) {
      const kept = stored[dk];
      const current = byDay[dk] ?? {};
      if (!Object.keys(current).length) {
        let value = kept !== undefined && kept !== null ? kept : (liveDays[dk] ?? {});
        if (tool === "codex" && kept) {
          value = kept._sources !== undefined ? ledgerMergeSources(kept, {}, tool) : codexLegacyDay(kept);
          if (!ledgerSameValue(value, kept)) {
            stored[dk] = value;
            dirty = true;
          }
        }
        merged[dk] = value;
        continue;
      }
      const value = ledgerMergeSources(kept, current, tool);
      // 扫描器给出的非计数归属（项目、会话）要保住
      for (const key of ["projects", "sessions"]) {
        const live = liveDays[dk]?.[key];
        if (Array.isArray(live) || live instanceof Set) {
          value[key] = [...new Set([...toArray(value[key]), ...toArray(live)])].sort();
        }
      }
      merged[dk] = value;
      if (LEDGER_MIN_DAY <= dk && dk <= maxDay && !ledgerSameValue(kept, value)) {
        stored[dk] = value;
        dirty = true;
      }
    }
    if (dirty) memo.dirty = true;
    return merged;
  }

  for (const [dk, live] of Object.entries(liveDays)) {
    const kept = stored[dk];
    const keptVersion = ledgerRecordVersion(kept);
    const liveVersion = ledgerRecordVersion(live);
    // OpenCode 的聚合天分不清「重新定价」和「日志被删」，token 总量回来之前先守住旧快照
    if (tool === "opencode" && kept && ledgerTokenSum(kept, tool) > ledgerTokenSum(live, tool)) {
      merged[dk] = kept;
      continue;
    }
    if (kept && keptVersion > liveVersion
      || (kept && keptVersion === liveVersion && ledgerDayTotal(kept) > ledgerDayTotal(live))) {
      merged[dk] = kept;
    } else {
      merged[dk] = live;
      if (!(LEDGER_MIN_DAY <= dk && dk <= maxDay)) continue;
      const snapshot: DayRecord = {};
      for (const [k, v] of Object.entries(live)) if (!(v instanceof Set)) snapshot[k] = v;
      if (!ledgerSameValue(kept, snapshot)) {
        stored[dk] = snapshot;
        dirty = true;
      }
    }
  }
  for (const [dk, kept] of Object.entries(stored)) {
    if (!(dk in merged)) merged[dk] = kept; // 日志已整体消失的天：账本兜底
  }
  if (dirty) memo.dirty = true;
  return merged;
}

/** 对应 ledger_touch()：确保账本里有该工具的键（暂无数据写空占位），标记扫描器已接入 */
export function ledgerTouch(tool: string): void {
  const ledger = loadLedger();
  if (!(tool in (ledger.tools ??= {}))) {
    ledger.tools[tool] = {};
    memo.dirty = true;
  }
}

/** 对应 _prepare_qodercli_ledger：qodercli 系列换过解析口径，旧账本整份作废重扫 */
export function prepareQoderCliLedger(tool: string, schema = 1): void {
  const ledger = loadLedger();
  const schemaKey = `${tool}_schema`;
  if (ledger[schemaKey] === schema) return;
  (ledger.tools ??= {})[tool] = {};
  ledger[schemaKey] = schema;
  memo.dirty = true;
}

/** 测试与扫描周期收尾用：读当前内存账本（不落盘） */
export function ledgerMemo(): { data: Ledger | null; dirty: boolean } {
  return memo;
}

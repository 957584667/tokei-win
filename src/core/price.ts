/**
 * 定价层：对应 usage.30s.py 的 _DEFAULT_PRICES / _FAMILY / _normalize /
 * _resolve_id / _raw_price / price_for / gemini_price / DeepSeek 官方潮汐价。
 * 查找优先级：pricing_overrides.json > pricing.json > 内置兜底。
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { loadJson, writablePath, TOKEI_DIR } from "./paths";
import { expandPath } from "./paths";

export interface PriceFields {
  in: number;
  out: number;
  cache_read: number;
  cache_write: number;
  write1h?: number;
}
export type Price = PriceFields;
export type ClaudePrice = { in: number; out: number; cache_read: number; write5m: number; write1h: number };

export const _DEFAULT_PRICES: Record<string, PriceFields> = {
  "anthropic/claude-fable-5.1": { in: 10.0, out: 50.0, cache_read: 0.25, cache_write: 12.5, write1h: 20.0 },
  "anthropic/claude-sonnet-5": { in: 2.0, out: 10.0, cache_read: 0.2, cache_write: 2.5 },
  "anthropic/claude-sonnet-5.5": { in: 2.0, out: 10.0, cache_read: 0.2, cache_write: 2.5 },
  "anthropic/claude-opus-4.8": { in: 5.0, out: 25.0, cache_read: 0.5, cache_write: 6.25 },
  "anthropic/claude-sonnet-4.6": { in: 3.0, out: 15.0, cache_read: 0.3, cache_write: 3.75 },
  "anthropic/claude-haiku-4.5": { in: 1.0, out: 5.0, cache_read: 0.1, cache_write: 1.25 },
  "openai/gpt-5.6-sol": { in: 4.0, out: 20.0, cache_read: 0.4, cache_write: 5.0 },
  "openai/gpt-5.6-terra": { in: 2.0, out: 12.0, cache_read: 0.2, cache_write: 2.5 },
  "openai/gpt-5.6-luna": { in: 0.2, out: 1.2, cache_read: 0.02, cache_write: 0.25 },
  "openai/gpt-5.5": { in: 5.0, out: 30.0, cache_read: 0.5, cache_write: 0.0 },
  "openai/gpt-6-astra": { in: 10.0, out: 50.0, cache_read: 1.0, cache_write: 12.5 },
  "openai/gpt-6-sol": { in: 2.0, out: 10.0, cache_read: 0.2, cache_write: 2.5 },
  "openai/gpt-6.1-sol": { in: 2.0, out: 10.0, cache_read: 0.1, cache_write: 2.5 },
  "openai/gpt-6-luna": { in: 0.1, out: 0.5, cache_read: 0.01, cache_write: 0.125 },
  "qwen/qwen3.8-max": { in: 2.0, out: 6.0, cache_read: 0.25, cache_write: 2.5 },
  "qwen/qwen3.7-max": { in: 1.25, out: 3.75, cache_read: 0.25, cache_write: 1.5625 },
  "deepseek/deepseek-v4-pro": { in: 0.66, out: 1.98, cache_read: 0.022, cache_write: 0.0 },
  "google/gemini-3.5-flash": { in: 1.5, out: 9.0, cache_read: 0.15, cache_write: 0.0833 },
  "google/gemini-3.1-pro-preview": { in: 2.0, out: 12.0, cache_read: 0.2, cache_write: 0.375 },
  "x-ai/grok-4.6": { in: 2.0, out: 6.0, cache_read: 0.5, cache_write: 0.0 },
  "x-ai/grok-4.5": { in: 2.0, out: 6.0, cache_read: 0.3, cache_write: 0.0 },
  "tencent/hy3": { in: 0.14, out: 0.58, cache_read: 0.035, cache_write: 0.0 },
  "tencent/hy3-preview": { in: 0.063, out: 0.21, cache_read: 0.021, cache_write: 0.0 },
};

const _DEEPSEEK_LEGACY: Record<string, PriceFields> = {
  "deepseek-v4-pro": { in: 3.0, out: 6.0, cache_read: 0.025, cache_write: 0.0 },
  "deepseek-v4-flash": { in: 1.0, out: 2.0, cache_read: 0.02, cache_write: 0.0 },
};
const _DEEPSEEK_CURRENT: Record<string, { off_peak: PriceFields; peak: PriceFields }> = {
  "deepseek-v4-pro": {
    off_peak: { in: 4.5, out: 13.5, cache_read: 0.15, cache_write: 0.0 },
    peak: { in: 9.0, out: 27.0, cache_read: 0.3, cache_write: 0.0 },
  },
  "deepseek-v4-flash": {
    off_peak: { in: 1.5, out: 4.5, cache_read: 0.05, cache_write: 0.0 },
    peak: { in: 3.0, out: 9.0, cache_read: 0.1, cache_write: 0.0 },
  },
};
const _DEEPSEEK_FLASH_20260910: { off_peak: PriceFields; peak: PriceFields } = {
  off_peak: { in: 1.0, out: 4.0, cache_read: 0.02, cache_write: 0.0 },
  peak: { in: 2.0, out: 8.0, cache_read: 0.04, cache_write: 0.0 },
};
const _DEEPSEEK_FLASH_20260910_START = Date.UTC(2026, 8, 10, 4) / 1000;
const _DEEPSEEK_NEW_PRICING_START = Date.UTC(2026, 7, 16, 16) / 1000;

/** 对应 _CLAUDE_LONG_PROMPT_TIERS：提示（输入+缓存读+缓存写）超上限后整次请求按倍数计价。 */
export const CLAUDE_LONG_PROMPT_TIERS: Record<string, [number, number]> = {
  "anthropic/claude-haiku-5.5": [100_000, 5.0],
};

const _FAMILY: Array<[string, string]> = [
  ["fable", "anthropic/claude-fable-5.1"],
  ["opus", "anthropic/claude-opus-4.8"],
  ["sonnet", "anthropic/claude-sonnet-5"],
  ["haiku", "anthropic/claude-haiku-4.5"],
  ["gpt-5", "openai/gpt-5.6-sol"],
  ["qwen", "qwen/qwen3.8-max"],
  ["deepseek", "deepseek/deepseek-v4-pro"],
  ["grok", "x-ai/grok-4.6"],
  ["glm", "z-ai/glm-5.2"],
  ["mimo", "xiaomi/mimo-v2.5-pro"],
  ["hy3", "tencent/hy3"],
];

const _BUILTIN_OVERRIDE_MODELS: Record<string, PriceFields> = {
  ...Object.fromEntries(
    ["openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6.1-sol", "openai/gpt-6-luna"].map((m) => [
      m,
      { ..._DEFAULT_PRICES[m] },
    ]),
  ),
  "openai/gpt-5.6-sol": { in: 4.0, out: 20.0, cache_read: 0.4, cache_write: 5.0 },
};
const _BUILTIN_OVERRIDE_ALIASES: Record<string, string> = {
  "gpt-5.6": "openai/gpt-5.6-sol",
  "qwen3.8-max-0902": "qwen/qwen3.8-max",
  "qwen3.8-max-2026-09-02": "qwen/qwen3.8-max",
  "qwen3.8-max-preview": "qwen/qwen3.8-max",
  "qwen3.8:27b": "qwen/qwen3.8-27b",
};

/**
 * 对应 _BUILTIN_REPRICE_MODELS / _BUILTIN_REPRICE_MULTIPLIERS：缓存里没留过上一版价目表时
 * （首次见到快照），这批模型按「价可能变过」处理，倍率表用来缩放无法重算的日账。
 */
export const BUILTIN_REPRICE_MODELS: ReadonlySet<string> = new Set([
  ...Object.keys(_BUILTIN_OVERRIDE_MODELS),
  ...Object.keys(_BUILTIN_OVERRIDE_ALIASES),
  ...Object.values(_BUILTIN_OVERRIDE_ALIASES),
  "anthropic/claude-fable-5.1", "anthropic/claude-sonnet-5",
  "qwen/qwen3.8-max", "qwen/qwen3.8-27b", "x-ai/grok-4.6",
  "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp",
]);
export const BUILTIN_REPRICE_MULTIPLIERS: Readonly<Record<string, number>> = {
  // OpenRouter 早年是 2/10/0.2，现在 OpenAI 直连价每一档都正好是它的 2 倍。
  "openai/gpt-5.6-sol": 2.0,
};

let _PRICING_DB: Record<string, Partial<PriceFields>> = {};
let _OV_MODELS: Record<string, Partial<PriceFields>> = {};
let _OV_ALIASES: Record<string, string> = { ..._BUILTIN_OVERRIDE_ALIASES };
let _initialized = false;

/** 对应 _CATALOG_INDEX：suffix 按模型名找条目，lines 按版本线找上一个版本。 */
let _CATALOG_INDEX: CatalogIndex | null = null;

/** 热重载记账：资源目录 + 两份价目文件的 mtime/大小指纹 + 生效价目表与指纹的备忘。 */
let _RESOURCE_DIR = "";
let _PRICING_STAMP: string | null = null;
let _EFFECTIVE_MEMO: Record<string, EffectivePrice> | null = null;
let _FINGERPRINT_MEMO: string | null = null;

/** 对应 _make_pricing_fingerprint 里的两份价目文件路径（~/.tokei 副本优先，与 initPricing 同源）。 */
function pricingFilePaths(): string[] {
  return [writablePath("pricing.json", _RESOURCE_DIR), writablePath("pricing_overrides.json", _RESOURCE_DIR)];
}

function pricingStamp(): string {
  return pricingFilePaths().map((file) => {
    try {
      const stat = fs.statSync(file);
      // 用浮点 mtimeMs 而不是取整：一次抓价可能连着写两次文件，毫秒取整会把第二次盖掉
      return `${file}|${stat.mtimeMs}|${stat.size}`;
    } catch {
      return `${file}|absent`;
    }
  }).join(";");
}

/** resourceDir 为打包内资源目录；pricing.json 优先取 ~/.tokei 下的可写副本。 */
export function initPricing(resourceDir: string): void {
  const pricingFile = writablePath("pricing.json", resourceDir);
  const overridesFile = writablePath("pricing_overrides.json", resourceDir);
  _PRICING_DB = loadJson<Record<string, any>>(pricingFile, {})?.models ?? {};
  const overrides = loadJson<Record<string, any>>(overridesFile, {});
  _OV_MODELS = { ..._BUILTIN_OVERRIDE_MODELS, ...(isObj(overrides.models) ? overrides.models : {}) };
  _OV_ALIASES = { ...(isObj(overrides.aliases) ? overrides.aliases : {}), ..._BUILTIN_OVERRIDE_ALIASES };
  _initialized = true;
  _CATALOG_INDEX = null;
  _RESOURCE_DIR = resourceDir;
  _PRICING_STAMP = pricingStamp();
  _EFFECTIVE_MEMO = null;
  _FINGERPRINT_MEMO = null;
}

/**
 * Python 每轮刷新都是新进程，价目文件天然每轮重读；我们是个长跑进程且只在启动时读一次，
 * 所以这里按 mtime+大小补上「文件改了就读一遍」。返回是否真的重读，重读会让指纹变化。
 * 记的是文件路径本身，所以用户后来新建 ~/.tokei/pricing.json 副本也照样能认出来。
 */
export function reloadPricingIfChanged(): boolean {
  ensureInit();
  const stamp = pricingStamp();
  if (stamp === _PRICING_STAMP) return false;
  initPricing(_RESOURCE_DIR);
  return true;
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function ensureInit() {
  if (!_initialized) initPricing(path.join(TOKEI_DIR, "missing"));
}

/** 对应 _effective_pricing_map 的一条：五个计价字段 + 长 prompt 档位（档位变了成本也得重算）。 */
export interface EffectivePrice {
  in: number;
  out: number;
  cache_read: number;
  cache_write: number;
  write1h: number;
  long_prompt?: [number, number];
}

/**
 * 对应 _effective_pricing_map()：把「当前这份价目表实际会算出什么价」摊平成一张可对比的表。
 * 字段一律缺省 0.0 —— 这里刻意没有 rawPrice() 那条 anthropic 1h 写 = 2×输入 的兜底，
 * 因为指纹只要求自比：上一版和这一版用同一个口径摊平，变化才不会被兜底规则吃掉。
 */
export function effectivePricingMap(catalog?: Record<string, any>): Record<string, EffectivePrice> {
  ensureInit();
  const fields = ["in", "out", "cache_read", "cache_write", "write1h"] as const;
  const db = isObj(catalog) ? catalog : _PRICING_DB;
  const modelIds = new Set([...Object.keys(_DEFAULT_PRICES), ...Object.keys(db), ...Object.keys(_OV_MODELS)]);
  const result: Record<string, EffectivePrice> = {};
  for (const model of modelIds) {
    const value = {
      ...(_DEFAULT_PRICES[model] ?? {}),
      ...(isObj(db[model]) ? db[model] : {}),
      ...(isObj(_OV_MODELS[model]) ? _OV_MODELS[model] : {}),
    } as Record<string, unknown>;
    const priced = {} as EffectivePrice;
    for (const field of fields) priced[field] = num(value[field]);
    const tier = CLAUDE_LONG_PROMPT_TIERS[model];
    if (tier) priced.long_prompt = [tier[0], tier[1]];
    result[model] = priced;
  }
  return result;
}

/** 生效价目表与指纹的备忘：Python 在导入时算一次，我们在每次重读价目文件后重算。 */
function effectivePricing(): Record<string, EffectivePrice> {
  ensureInit();
  if (_EFFECTIVE_MEMO === null) _EFFECTIVE_MEMO = effectivePricingMap();
  return _EFFECTIVE_MEMO;
}

/** json.dumps(sort_keys=True, separators=(",", ":")) 的等价物：键名递归排序、无空格。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObj(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * 对应 _make_pricing_fingerprint()。哈希值本身不要求和 Python 一致——它只跟缓存里上一轮
 * 自己盖的那一枚比，对不上就说明价目表动过，缓存里预存的成本全部要重算。
 */
export function pricingFingerprint(): string {
  ensureInit();
  if (_FINGERPRINT_MEMO === null) {
    const payload = {
      prices: effectivePricing(),
      aliases: _OV_ALIASES,
      deepseek_legacy: _DEEPSEEK_LEGACY,
      deepseek_current: _DEEPSEEK_CURRENT,
      deepseek_flash_20260910: _DEEPSEEK_FLASH_20260910,
      deepseek_flash_20260910_start: _DEEPSEEK_FLASH_20260910_START,
    };
    _FINGERPRINT_MEMO = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
  }
  return _FINGERPRINT_MEMO;
}

/** 对应 _pricing_model_keys()：原名、规范化、解析后的 id 三个键都算命中。 */
export function pricingModelKeys(model?: string | null): Set<string> {
  const raw = (model ?? "").trim();
  if (!raw) return new Set();
  const candidates = new Set([raw.toLowerCase()]);
  const normalized = normalize(raw);
  if (normalized) candidates.add(normalized.toLowerCase());
  const resolved = resolveId(raw);
  if (resolved) candidates.add(String(resolved).toLowerCase());
  return candidates;
}

/** 对应 _model_has_pricing_change()。 */
export function modelHasPricingChange(model: string | null | undefined, changedModels: Array<string | null>): boolean {
  const changed = new Set(changedModels.filter((v) => !!v).map((v) => String(v).trim().toLowerCase()));
  for (const key of pricingModelKeys(model)) if (changed.has(key)) return true;
  return false;
}

/** 对应 _pricing_change_multiplier()：拿不到倍率返回 null，调用方据此放弃缩放这条路。 */
export function pricingChangeMultiplier(model: string | null | undefined, multipliers: Record<string, number>): number | null {
  const normalizedKeys = new Map<string, unknown>();
  for (const [key, value] of Object.entries(multipliers ?? {})) normalizedKeys.set(String(key).trim().toLowerCase(), value);
  for (const key of pricingModelKeys(model)) {
    if (!normalizedKeys.has(key)) continue;
    const value = normalizedKeys.get(key);
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 对应 _cached_entry_has_pricing_change()：active_model、日账里的模型名先查，
 * 一处模型都没有才退到事件明细。Codex 的事件是定长数组不是对象，所以那一路天然不参与。
 */
export function cachedEntryHasPricingChange(entry: unknown, changedModels: Array<string | null>): boolean {
  if (!isObj(entry)) return false;
  const models = new Set<string | null>();
  const active = (entry as any).active_model;
  if (active) models.add(String(active));
  for (const field of ["days", "deduped_days"]) {
    const days = (entry as any)[field];
    if (!isObj(days)) continue;
    for (const day of Object.values(days) as any[]) {
      if (day && isObj(day.models)) for (const model of Object.keys(day.models)) models.add(model);
    }
  }
  if (models.size === 0 && Array.isArray((entry as any).events)) {
    for (const event of (entry as any).events) if (isObj(event) && event.model) models.add(String(event.model));
  }
  for (const model of models) if (modelHasPricingChange(model, changedModels)) return true;
  return false;
}

/**
 * 对应 _load_scan_cache() 里 1209-1232 那段指纹比对：这一版的指纹和缓存里盖过的不一样，
 * 就把变更模型摊进 _pricing_changed_models，由各家扫描器自己重算缓存里的成本。
 * 缓存里没留过生效价目表快照时（老缓存）没法逐模型比，只能整批按内置名单 + 倍率处理。
 */
export function markPricingChanges(cache: Record<string, any>): void {
  ensureInit();
  if (cache._pricing_fingerprint === pricingFingerprint()) return;
  const pending = new Set<string>((Array.isArray(cache._pricing_changed_models) ? cache._pricing_changed_models : [])
    .filter((v) => !!v).map(String));
  const effective = effectivePricing();
  const previous = cache._pricing_effective;
  const multipliers: Record<string, number> = { ...(isObj(cache._pricing_cost_multipliers) ? cache._pricing_cost_multipliers : {}) };
  if (isObj(previous)) {
    for (const model of new Set([...Object.keys(previous), ...Object.keys(effective)])) {
      if (canonicalJson((previous as any)[model] ?? null) !== canonicalJson(effective[model] ?? null)) pending.add(model);
    }
  } else {
    for (const model of BUILTIN_REPRICE_MODELS) pending.add(model);
    for (const [model, value] of Object.entries(BUILTIN_REPRICE_MULTIPLIERS)) multipliers[model] = value;
  }
  const previousAliases = cache._pricing_aliases;
  if (isObj(previousAliases)) {
    for (const alias of new Set([...Object.keys(previousAliases), ...Object.keys(_OV_ALIASES)])) {
      const oldTarget = (previousAliases as any)[alias];
      const newTarget = _OV_ALIASES[alias];
      if (oldTarget !== newTarget) {
        for (const value of [alias, oldTarget, newTarget]) if (value) pending.add(String(value));
      }
    }
  }
  cache._pricing_changed = true;
  cache._pricing_changed_models = [...pending].sort();
  cache._pricing_cost_multipliers = multipliers;
  cache._dirty = true;
}

/** 对应扫描收尾那段（14746-14752）：本轮重算过就把这一版的快照盖回缓存，标记清掉。 */
export function finishPricingPass(cache: Record<string, any>): void {
  if (!cache._pricing_changed) return;
  // 对应 cache.pop("_pricing_changed", False)：标记本身也要吃掉，不然下一轮所有采集器
  // 还以为价目表刚变过，每 30 秒把缓存重算一遍。
  delete cache._pricing_changed;
  delete cache._pricing_changed_models;
  delete cache._pricing_cost_multipliers;
  cache._pricing_fingerprint = pricingFingerprint();
  cache._pricing_effective = effectivePricing();
  cache._pricing_aliases = _OV_ALIASES;
  cache._dirty = true;
}

/**
 * 对应 update_prices() 里那三行新旧对比（usage.30s.py:15579-15584）：只比「摊平后的生效价」，
 * 所以纯新增（老表里没有的模型、retired 标记）不会算成变更。抓价进程用它决定该重算谁。
 */
export function changedPricingModels(previousCatalog: Record<string, any>, nextCatalog: Record<string, any>): string[] {
  const before = effectivePricingMap(previousCatalog);
  const after = effectivePricingMap(nextCatalog);
  const changed: string[] = [];
  for (const model of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (canonicalJson(before[model] ?? null) !== canonicalJson(after[model] ?? null)) changed.push(model);
  }
  return changed.sort();
}

/** 版本线：前缀 + 主.次版本 + 档位后缀。minimax-m3.1-flash → ["minimax-m", [3,1], "-flash"] */
const _MODEL_LINE_RE = /^(.*?)(\d+)(?:\.(\d+))?((?:-[a-z][a-z0-9.]*)*)$/;
/** preview / 日期这类不稳定后缀不算档位，也不算正式版 */
const _UNSTABLE_SUFFIX_RE = /(?:-(?:preview|latest|exp|\d{8}|\d{4}-\d{2}-\d{2}|\d{4}))+$/;

type Version = [number, number];
/** [前缀, 版本, 档位后缀, 是否正式版] */
type ModelLine = [string, Version, string, boolean];
/** [厂商, 版本, 档位后缀, 是否正式版, 价目表 id] */
type CatalogLine = [string, Version, string, boolean, string];
interface CatalogIndex {
  suffix: Map<string, Set<string>>;
  lines: Map<string, Set<CatalogLine>>;
}

function modelLine(name: string): ModelLine | null {
  const base = name.replace(_UNSTABLE_SUFFIX_RE, "");
  const match = _MODEL_LINE_RE.exec(base);
  if (!match) return null;
  const version: Version = [Number(match[2]), match[3] === undefined ? 0 : Number(match[3])];
  return [match[1], version, match[4], base === name];
}

function cmpVersion(a: Version, b: Version): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

function nonNegative(v: unknown): boolean {
  return typeof v !== "number" || !(v < 0);
}

/** 对应 _catalog_index()：OpenRouter 的路由占位（openrouter/auto）、:batch 变体与负价不参与。 */
function catalogIndex(): CatalogIndex {
  ensureInit();
  if (_CATALOG_INDEX === null) {
    const suffix = new Map<string, Set<string>>();
    const lines = new Map<string, Set<CatalogLine>>();
    for (const catalog of [_DEFAULT_PRICES as Record<string, any>, _PRICING_DB, _OV_MODELS]) {
      for (const [modelId, price] of Object.entries(catalog)) {
        if (!modelId.includes("/") || modelId.includes(":")
          || modelId.startsWith("openrouter/") || !isObj(price)) continue;
        if (!nonNegative(price.in) || !nonNegative(price.out)) continue;
        const slash = modelId.toLowerCase().lastIndexOf("/");
        const provider = modelId.toLowerCase().slice(0, slash);
        const name = modelId.toLowerCase().slice(slash + 1);
        if (!suffix.has(name)) suffix.set(name, new Set());
        suffix.get(name)!.add(modelId);
        const line = modelLine(name);
        if (!line) continue;
        const key = line[0];
        if (!lines.has(key)) lines.set(key, new Set());
        lines.get(key)!.add([provider, line[1], line[2], line[3], modelId]);
      }
    }
    _CATALOG_INDEX = { suffix, lines };
  }
  return _CATALOG_INDEX;
}

/** 对应 _catalog_id_for_bare_name()：裸模型名只认唯一匹配，两家同宁可不认。 */
export function catalogIdForBareName(name: string): string | null {
  const matches = catalogIndex().suffix.get(name);
  if (!matches || matches.size !== 1) return null;
  return matches.values().next().value ?? null;
}

/**
 * 对应 _predecessor_pricing_id()：价目表里没有这个模型时沿用同一版本线上一个版本的价。
 * 先找同档位里版本不高于它的最近一个，没有再找同版本线的基础款；同版本时正式版优先。
 * 不带厂商前缀的名字只在所有候选来自同一家时才认。
 */
export function predecessorPricingId(normalized?: string | null): string | null {
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  const slash = lower.lastIndexOf("/");
  const provider = slash < 0 ? "" : lower.slice(0, slash);
  const line = modelLine(slash < 0 ? lower : lower.slice(slash + 1));
  if (!line) return null;
  const [prefix, version, tier] = line;
  const candidates = [...(catalogIndex().lines.get(prefix) ?? [])].filter(
    (c) => cmpVersion(c[1], version) <= 0 && (!provider || c[0] === provider),
  );
  if (!provider && new Set(candidates.map((c) => c[0])).size > 1) return null;
  for (const wanted of [tier, ""]) {
    const sameTier = candidates.filter((c) => c[2] === wanted);
    if (!sameTier.length) continue;
    const best = sameTier.reduce((a, c) => {
      const d = cmpVersion(c[1], a[1]);
      return d > 0 || (d === 0 && c[3] && !a[3]) ? c : a;
    });
    return best[4];
  }
  return null;
}

/** 对应 _normalize()：本地模型名 → OpenRouter canonical id。 */
export function normalize(model?: string | null): string | null {
  let m = (model || "").trim().toLowerCase();
  if (!m || m === "<synthetic>") return null;
  m = m.replace(/^custom[\w-]*:/, "");
  m = m.replace(/\s+/g, "-");
  m = m.replace(/[:\-]free$/, "");
  const seg = m.split("/").pop() ?? m;
  if (seg.startsWith("muse-")) return `meta/${seg}`;
  if (m.includes("/")) return m;
  if (m.startsWith("claude")) {
    // 日期快照与 -latest 同基础版一个价：claude-opus-5-5-20260921 → claude-opus-5-5
    m = m.replace(/-(?:\d{8}|latest)$/, "");
    m = m.replace(/-(\d+)-(\d+)$/, "-$1.$2");
    return `anthropic/${m}`;
  }
  if (/^(gpt|o\d|chatgpt)/.test(m)) return `openai/${m}`;
  if (m.startsWith("gemini")) return `google/${m}`;
  if (m.startsWith("grok")) return `x-ai/${m}`;
  if (m.startsWith("qwen")) return `qwen/${m}`;
  if (m.startsWith("deepseek")) return `deepseek/${m}`;
  if (m.startsWith("glm")) return `z-ai/${m}`;
  if (m.startsWith("muse-")) return `meta/${m}`;
  if (m.startsWith("mimo")) return `xiaomi/${m}`;
  if (m.startsWith("minimax")) return `minimax/${m}`;
  if (m === "hy3") return "tencent/hy3";
  if (m === "hy3-preview" || m === "hy3 preview") return "tencent/hy3-preview";
  // 其余不带厂商前缀的，按名字到价目表（OpenRouter 为主）里找
  return catalogIdForBareName(m) ?? m;
}

/** 对应 _override_alias()：用户与内置别名表都算，命中就返回规范 id。 */
export function overrideAlias(model: string): string | null {
  ensureInit();
  const value = (model || "").trim();
  return _OV_ALIASES[value] ?? _OV_ALIASES[value.toLowerCase()] ?? null;
}

function inCatalog(id: string): boolean {
  ensureInit();
  return id in _OV_MODELS || id in _PRICING_DB || id in _DEFAULT_PRICES;
}

/** 对应 _resolveId()：未知模型按家族回退，最终兜底 Opus（保守上限）。 */
export function resolveId(model?: string | null): string | null {
  const s = (model || "").trim();
  if (!s || s.toLowerCase() === "<synthetic>") return null;
  const alias = overrideAlias(s);
  if (alias) return alias;
  const norm = normalize(s);
  if (norm && inCatalog(norm)) return norm;
  const predecessor = predecessorPricingId(norm);
  if (predecessor) return predecessor;
  const low = s.toLowerCase();
  if (low.includes("gemini")) return low.includes("pro") ? "google/gemini-3.1-pro-preview" : "google/gemini-3.5-flash";
  for (const [kw, rep] of _FAMILY) if (low.includes(kw)) return rep;
  return "anthropic/claude-opus-4.8";
}

/** 对应 _knownIdOrRaw()：未知模型保留原名，不套 Opus 兜底。 */
export function knownIdOrRaw(model?: string | null): string | null {
  const s = (model || "").trim();
  if (!s || s.toLowerCase() === "<synthetic>") return null;
  const alias = overrideAlias(s);
  if (alias) return alias;
  const norm = normalize(s);
  if (norm && inCatalog(norm)) return norm;
  const low = s.toLowerCase();
  if (low.includes("gemini")) return low.includes("pro") ? "google/gemini-3.1-pro-preview" : "google/gemini-3.5-flash";
  for (const [kw, rep] of _FAMILY) if (low.includes(kw)) return rep;
  return s;
}

/** 对应 _modelIdentityId()：只认精确目录身份，绝不猜家族。 */
export function modelIdentityId(model?: string | null): string | null {
  const s = (model || "").trim();
  if (!s || s.toLowerCase() === "<synthetic>") return null;
  const alias = overrideAlias(s);
  if (alias) return alias;
  const norm = normalize(s);
  if (norm && inCatalog(norm)) return norm;
  for (const [id, entry] of Object.entries(_PRICING_DB)) {
    const slug = (entry as any)?.canonical_slug;
    if (typeof slug === "string" && normalize(slug) === norm) return id;
  }
  return s;
}

/** 对应 _exactPricingId()：不做家族回退。 */
export function exactPricingId(model?: string | null): string | null {
  ensureInit();
  if (model && inCatalog(model)) return model;
  return null;
}

/** 对应 _pricing_id()：别名 → 规范化 → 前驱版本 → 家族代表，含 GLM 5.2 → 5.1 的临时映射。 */
export function pricingId(model?: string | null): string | null {
  ensureInit();
  const alias = overrideAlias((model || "").trim());
  if (alias && inCatalog(alias)) return alias;
  const normalized = normalize(model);
  if (normalized && inCatalog(normalized)) return normalized;
  // 价目表里没有：先沿用同一版本线上一个版本的价，再退到按家族的粗略代表
  const predecessor = predecessorPricingId(normalized);
  if (predecessor) return predecessor;
  const canonical = knownIdOrRaw(model);
  if (canonical && inCatalog(canonical)) return canonical;
  // ZCode 报的 GLM-5.2 还没有公开价，先按官方等价的 GLM-5.1 计
  if (normalized === "z-ai/glm-5.2" && "z-ai/glm-5.1" in _PRICING_DB) return "z-ai/glm-5.1";
  return null;
}

export function hasKnownPrice(model?: string | null): boolean {
  return pricingId(model) !== null;
}

/** 对应 _is_exact_match()：有没有「精确价」，靠家族代表或前驱版本兜底的不算。 */
export function isExactMatch(model?: string | null): boolean {
  ensureInit();
  const s = (model || "").trim();
  if (!s || s.toLowerCase() === "<synthetic>") return true;
  if (overrideAlias(s)) return true;
  const norm = normalize(model);
  return !!norm && inCatalog(norm);
}

/** 对应 _estimate_from_sibling() 的返回：四条价 + 抄自哪一条。 */
export interface SiblingEstimate extends PriceFields {
  source: string;
}

/**
 * 对应 _estimate_from_sibling()：同家族、同档位里挑一条现成的价。
 * 候选按 id 倒序排（原版 sort(key=cid, reverse=True)），所以取到的是字典序最大的那条。
 */
export function estimateFromSibling(model?: string | null): SiblingEstimate | null {
  ensureInit();
  const low = (model || "").toLowerCase();
  const tiers = ["max", "plus", "flash", "lite", "turbo", "pro", "mini"];
  const tier = tiers.find((t) => low.includes(t));
  if (!tier) return null;
  const all: Record<string, Partial<PriceFields>> = { ..._PRICING_DB, ..._OV_MODELS };
  const candidates = Object.entries(all)
    .filter(([cid, price]) => cid.toLowerCase().includes(tier) && isObj(price)
      && _FAMILY.some(([kw]) => low.includes(kw) && cid.toLowerCase().includes(kw)));
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  const [source, price] = candidates[0];
  return {
    source,
    in: price.in ?? 0,
    out: price.out ?? 0,
    cache_read: price.cache_read ?? 0,
    cache_write: price.cache_write ?? 0,
  };
}

/** 对应 _rawPrice()。 */
export function rawPrice(model?: string | null): Price {
  ensureInit();
  const cid = resolveId(model);
  if (!cid) return { in: 0, out: 0, cache_read: 0, cache_write: 0 };
  const p: Record<string, number> = { ...(_DEFAULT_PRICES[cid] ?? {}), ...(_PRICING_DB[cid] ?? {}), ...(_OV_MODELS[cid] ?? {}) };
  const out: Price = {
    in: num(p.in),
    out: num(p.out),
    cache_read: num(p.cache_read),
    cache_write: num(p.cache_write),
  };
  if ("write1h" in p) out.write1h = num(p.write1h);
  else if (cid.startsWith("anthropic/")) out.write1h = out.in * 2;
  return out;
}

/** 对应 price_for()：Claude 成本用的两档缓存写入价。 */
export function priceFor(model?: string | null): ClaudePrice {
  const p = rawPrice(model);
  return { in: p.in, out: p.out, cache_read: p.cache_read, write5m: p.cache_write, write1h: p.write1h ?? p.cache_write };
}

/** 对应 gemini_price()。 */
export function geminiPrice(model?: string | null): Price {
  return rawPrice(model);
}

function deepseekOfficialModelId(model?: string | null): string | null {
  const id = (normalize(model) || "").split("/").pop() || "";
  if (id === "deepseek-v4-pro" || id === "deepseek-v4-pro-0813") return "deepseek-v4-pro";
  if (["deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v4-flash-vision-exp", "deepseek-flash", "deepseek-v4.1-flash"].includes(id))
    return "deepseek-v4-flash";
  return null;
}

/** 对应 _deepseek_official_price()：按调用时刻取官方人民币价（CNY / 1M token）。 */
export function deepseekOfficialPrice(model?: string | null, at?: Date | number | null): PriceFields | null {
  const modelId = deepseekOfficialModelId(model);
  if (!modelId) return null;
  let when: Date;
  if (at === null || at === undefined) when = new Date();
  else if (typeof at === "number") {
    const seconds = Math.abs(at) >= 100_000_000_000 ? at / 1000 : at;
    when = new Date(seconds * 1000);
  } else when = at;
  if (Number.isNaN(when.getTime())) return null;
  const epoch = when.getTime() / 1000;
  if (epoch < _DEEPSEEK_NEW_PRICING_START) {
    const legacy = _DEEPSEEK_LEGACY[modelId];
    return legacy ? { ...legacy } : null;
  }
  // 北京时间工作日高峰：UTC 01-04 与 06-10，周一到周五
  const utcDay = when.getUTCDay();
  const utcHour = when.getUTCHours();
  const peak = utcDay >= 1 && utcDay <= 5 && ((utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10));
  let schedule: { off_peak: PriceFields; peak: PriceFields } | undefined = _DEEPSEEK_CURRENT[modelId];
  if (modelId === "deepseek-v4-flash" && epoch >= _DEEPSEEK_FLASH_20260910_START) schedule = _DEEPSEEK_FLASH_20260910;
  const price = schedule?.[peak ? "peak" : "off_peak"];
  return price ? { ...price } : null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function pricingMeta(resourceDir: string): { updated_at: string; count: number } {
  const file = writablePath("pricing.json", resourceDir);
  const meta = loadJson<Record<string, any>>(file, {})?._meta ?? {};
  return { updated_at: meta.updated_at ?? "", count: meta.count ?? 0 };
}

export { expandPath };

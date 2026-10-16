/**
 * 定价层：对应 usage.30s.py 的 _DEFAULT_PRICES / _FAMILY / _normalize /
 * _resolve_id / _raw_price / price_for / gemini_price / DeepSeek 官方潮汐价。
 * 查找优先级：pricing_overrides.json > pricing.json > 内置兜底。
 */
import * as path from "path";
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

let _PRICING_DB: Record<string, Partial<PriceFields>> = {};
let _OV_MODELS: Record<string, Partial<PriceFields>> = {};
let _OV_ALIASES: Record<string, string> = { ..._BUILTIN_OVERRIDE_ALIASES };
let _initialized = false;

/** resourceDir 为打包内资源目录；pricing.json 优先取 ~/.tokei 下的可写副本。 */
export function initPricing(resourceDir: string): void {
  const pricingFile = writablePath("pricing.json", resourceDir);
  const overridesFile = writablePath("pricing_overrides.json", resourceDir);
  _PRICING_DB = loadJson<Record<string, any>>(pricingFile, {})?.models ?? {};
  const overrides = loadJson<Record<string, any>>(overridesFile, {});
  _OV_MODELS = { ..._BUILTIN_OVERRIDE_MODELS, ...(isObj(overrides.models) ? overrides.models : {}) };
  _OV_ALIASES = { ...(isObj(overrides.aliases) ? overrides.aliases : {}), ..._BUILTIN_OVERRIDE_ALIASES };
  _initialized = true;
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function ensureInit() {
  if (!_initialized) initPricing(path.join(TOKEI_DIR, "missing"));
}

/** 对应 _normalize()：本地模型名 → OpenRouter canonical id。 */
export function normalize(model?: string | null): string | null {
  let m = (model || "").trim().toLowerCase();
  if (!m || m === "<synthetic>") return null;
  m = m.replace(/\s+/g, "-");
  m = m.replace(/[:\-]free$/, "");
  const seg = m.split("/").pop() ?? m;
  if (seg.startsWith("muse-")) return `meta/${seg}`;
  if (m.includes("/")) return m;
  if (m.startsWith("claude")) {
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
  return m;
}

function overrideAlias(model: string): string | null {
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

/** 对应 _pricingId()：含 GLM 5.2 → 5.1 的临时映射。 */
export function pricingId(model?: string | null): string | null {
  ensureInit();
  const canonical = knownIdOrRaw(model);
  if (canonical && inCatalog(canonical)) return canonical;
  const norm = normalize(model);
  if (norm === "z-ai/glm-5.2" && "z-ai/glm-5.1" in _PRICING_DB) return "z-ai/glm-5.1";
  return null;
}

export function hasKnownPrice(model?: string | null): boolean {
  return pricingId(model) !== null;
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

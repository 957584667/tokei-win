/**
 * 联网额度取数的公共底座：对应 usage.30s.py 的 5670-6004。
 *
 * 这里只做「不联网的那一半」：开关判定、数值归一化、按天用量汇总、缓存文件读写。
 * 真正的 HTTP 在 src/main/quota/http.ts，各 provider 的取数在 src/main/quota/*.ts。
 *
 * 缓存文件 ~/.tokei/provider_quota_cache.json 结构 {version:1, providers:{name:{marker,
 * fetched_at, quota, attempted_at, attempt_result}}}：marker 是凭据的 sha256，换了账号
 * 旧读数就不给用（否则 A 号的余额会显示成 B 号的）；attempt_* 记录失败尝试，让 30 秒
 * 一轮的采集不必每次失败都重试一遍网络。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { TOKEI_DIR, loadJson, saveJson } from "./paths";
import { Bounds, RANGE_KEYS, classifyDay, dayKey, parseTs, rangeBounds, niceModel } from "./ranges";

/** 对应 _PROVIDER_QUOTA_TTL：同一凭据 5 分钟内的读数直接复用 */
export const PROVIDER_QUOTA_TTL = 300;
/** 对应 _PROVIDER_QUOTA_FALLBACK_TTL：请求失败时退回 1 小时内的旧读数，并标 stale */
export const PROVIDER_QUOTA_FALLBACK_TTL = 3600;
/** 对应 _PROVIDER_QUOTA_MAX_RESPONSE_BYTES：响应超过 2MiB 直接判定异常 */
export const PROVIDER_QUOTA_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** 对应 _PROVIDER_QUOTA_ENV：环境变量取值 "0" 关、"1" 开，其它值按未设置处理 */
export const PROVIDER_QUOTA_ENV: Record<string, string> = {
  cursor: "TOKEI_CURSOR_QUOTA",
  grok_bot: "TOKEI_GROK_BOT_QUOTA",
  zed: "TOKEI_ZED_QUOTA",
  sub2api: "TOKEI_SUB2API_QUOTA",
  zai: "TOKEI_ZAI_QUOTA",
  antigravity: "TOKEI_ANTIGRAVITY_QUOTA",
  devin: "TOKEI_DEVIN_QUOTA",
  minimax: "TOKEI_MINIMAX_QUOTA",
};

/** 对应 _provider_quota_enabled 的 default：只有这两路默认开 */
const DEFAULT_ON = new Set(["antigravity", "devin"]);

/** 环境/配置的读取口：单测注入 fixture 用，默认读 process.env 与 ~/.tokei/config.json */
export interface QuotaEnvAccess {
  env(key: string): string | undefined;
  config(): Record<string, any>;
}

let configFile = path.join(TOKEI_DIR, "config.json");
let cacheFile = path.join(TOKEI_DIR, "provider_quota_cache.json");

/** 测试注入口：把配置与缓存指到临时目录，绝不写真实的 ~/.tokei */
export function useProviderQuotaFiles(file?: string | null, config?: string | null): void {
  cacheFile = file ?? path.join(TOKEI_DIR, "provider_quota_cache.json");
  configFile = config ?? path.join(TOKEI_DIR, "config.json");
}

export function providerQuotaCacheFile(): string {
  return cacheFile;
}

function readConfig(): Record<string, any> {
  const cfg = loadJson<unknown>(configFile, {});
  return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? (cfg as Record<string, any>) : {};
}

export const defaultEnvAccess: QuotaEnvAccess = {
  env: (key) => process.env[key],
  config: readConfig,
};

function access(part?: Partial<QuotaEnvAccess>): QuotaEnvAccess {
  return { ...defaultEnvAccess, ...part };
}

/** 对应 _provider_quota_enabled */
export function providerQuotaEnabled(provider: string, part?: Partial<QuotaEnvAccess>): boolean {
  const envKey = PROVIDER_QUOTA_ENV[provider];
  const env = envKey ? access(part).env(envKey) : undefined;
  if (env === "0") return false;
  if (env === "1") return true;
  const value = access(part).config()[`${provider}_quota_enabled`];
  return Boolean(value ?? DEFAULT_ON.has(provider));
}

/** 对应 _provider_config_string：环境变量优先，空白串等同未设置 */
export function providerConfigString(
  envKey: string, configKey: string, part?: Partial<QuotaEnvAccess>,
): string | null {
  const raw = access(part).env(envKey);
  const fromEnv = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  if (fromEnv) return fromEnv;
  const value = access(part).config()[configKey];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 对应 _provider_number：布尔与字符串数字都收，非有限值一律 null */
export function providerNumber(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  let number: number;
  if (typeof value === "number") number = value;
  else if (typeof value === "string") {
    number = Number(value.trim());
    if (value.trim() === "") return null;
  } else return null;
  return Number.isFinite(number) ? number : null;
}

/** 对应 _provider_integer */
export function providerInteger(value: unknown): number | null {
  const number = providerNumber(value);
  return number !== null && Number.isInteger(number) ? Math.trunc(number) : null;
}

/** 对应 _provider_percent：夹到 0-100，保留 6 位小数 */
export function providerPercent(value: unknown): number | null {
  const number = providerNumber(value);
  if (number === null) return null;
  return round6(Math.max(0, Math.min(100, number)));
}

/** 对应 _provider_epoch：大于 1e11 视为毫秒；否则按 parse_ts 解析字符串 */
export function providerEpoch(value: unknown): number | null {
  const number = providerNumber(value);
  if (number !== null) {
    const seconds = number > 100_000_000_000 ? number / 1000 : number;
    return seconds > 0 ? Math.trunc(seconds) : null;
  }
  if (typeof value === "string") {
    const parsed = parseTs(value);
    return parsed ? Math.trunc(parsed.epoch) : null;
  }
  return null;
}

/** 对应 _provider_money：USD 用 $1,234.56，其它币种写在数字后面 */
export function providerMoney(value: unknown, unit = "USD"): string | null {
  const number = providerNumber(value);
  if (number === null) return null;
  const text = number.toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const currency = String(unit || "USD").toUpperCase();
  return currency === "USD" ? `$${text}` : `${text} ${currency}`;
}

const USAGE_FIELDS = ["in", "out", "cr", "cw", "reason"] as const;

/** 对应 _provider_usage_int：负数与非法值按 0 */
export function providerUsageInt(value: unknown): number {
  const number = providerInteger(value);
  return number !== null && number >= 0 ? number : 0;
}

export interface ProviderModelUsage {
  name: string;
  tokens: number;
  in: number;
  out: number;
  cr: number;
  cw: number;
  reason: number;
  cost: number;
}

export interface ProviderUsageRange {
  tokens: number;
  in: number;
  out: number;
  cr: number;
  cw: number;
  reason: number;
  cost: number;
  requests: number;
  hit: number;
  models: ProviderModelUsage[];
  coverage?: string;
}

export interface ProviderUsage {
  ranges: Record<string, ProviderUsageRange>;
  days: Record<string, any>;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** 只认严格的 YYYY-MM-DD：对应 date.fromisoformat(str(day_key)[:10]) 的失败即跳过 */
function strictDayKey(raw: unknown): string | null {
  const text = String(raw ?? "").slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (dayKey(d) !== text) return null;
  return text;
}

/** 对应 _provider_usage_from_days */
export function providerUsageFromDays(
  days: unknown,
  opts?: { bounds?: Bounds; limitedCoverage?: string | null } & Partial<QuotaEnvAccess>,
): ProviderUsage {
  const bounds = opts?.bounds ?? rangeBounds();
  const limitedCoverage = opts?.limitedCoverage ?? undefined;
  type Bucket = Omit<ProviderUsageRange, "hit" | "models"> & {
    models: Record<string, ProviderModelUsage>;
  };
  const buckets = {} as Record<string, Bucket>;
  for (const key of RANGE_KEYS) {
    buckets[key] = {
      tokens: 0, in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, requests: 0, models: {},
    };
  }
  const cleanDays = (days && typeof days === "object" && !Array.isArray(days) ? days : {}) as Record<string, any>;

  for (const [rawKey, day] of Object.entries(cleanDays)) {
    if (!day || typeof day !== "object" || Array.isArray(day)) continue;
    const key = strictDayKey(rawKey);
    if (!key) continue;
    const components = {} as Record<(typeof USAGE_FIELDS)[number], number>;
    for (const field of USAGE_FIELDS) components[field] = providerUsageInt(day[field]);
    const total = providerUsageInt(day.tokens) || USAGE_FIELDS.reduce((s, f) => s + components[f], 0);
    let cost = providerNumber(day.cost) ?? 0;
    if (cost < 0) cost = 0;
    const requests = providerUsageInt(day.requests);
    const models = (day.models && typeof day.models === "object" && !Array.isArray(day.models))
      ? day.models as Record<string, any> : {};
    for (const rangeKey of classifyDay(key, bounds)) {
      const bucket = buckets[rangeKey];
      bucket.tokens += total;
      bucket.cost += cost;
      bucket.requests += requests;
      for (const field of USAGE_FIELDS) bucket[field] += components[field];
      for (const [rawName, rawUsage] of Object.entries(models)) {
        if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) continue;
        const name = String(rawName ?? "unknown");
        const model = (bucket.models[name] ??= {
          name, tokens: 0, in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0,
        });
        const modelComponents = {} as Record<(typeof USAGE_FIELDS)[number], number>;
        for (const field of USAGE_FIELDS) modelComponents[field] = providerUsageInt(rawUsage[field]);
        model.tokens += providerUsageInt(rawUsage.tokens)
          || USAGE_FIELDS.reduce((s, f) => s + modelComponents[f], 0);
        for (const field of USAGE_FIELDS) model[field] += modelComponents[field];
        const modelCost = providerNumber(rawUsage.cost) ?? 0;
        if (modelCost >= 0) model.cost += modelCost;
      }
    }
  }

  const ranges = {} as Record<string, ProviderUsageRange>;
  for (const rangeKey of RANGE_KEYS) {
    const bucket = buckets[rangeKey];
    const formatted: Record<string, ProviderModelUsage> = {};
    for (const [rawName, usage] of Object.entries(bucket.models)) {
      const displayName = niceModel(rawName);
      const model = (formatted[displayName] ??= {
        name: displayName, tokens: 0, in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0,
      });
      for (const field of MODEL_SUM_FIELDS) model[field] += usage[field];
      model.cost += usage.cost;
    }
    const row: ProviderUsageRange = {
      tokens: bucket.tokens, in: bucket.in, out: bucket.out, cr: bucket.cr, cw: bucket.cw,
      reason: bucket.reason, requests: bucket.requests, hit: 0, cost: round6(bucket.cost), models: [],
    };
    const inputTotal = row.in + row.cr + row.cw;
    row.hit = inputTotal ? (row.cr / inputTotal) * 100 : 0;
    row.models = Object.values(formatted).sort(
      (a, b) => (b.tokens - a.tokens) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const model of row.models) model.cost = round6(model.cost);
    if (limitedCoverage && (rangeKey === "year" || rangeKey === "all")) row.coverage = limitedCoverage;
    ranges[rangeKey] = row;
  }
  return { ranges, days: cleanDays };
}

function usageFields(): (typeof USAGE_FIELDS)[number][] {
  return ["in", "out", "cr", "cw", "reason"];
}

/** 对应 ("tokens",) + _PROVIDER_USAGE_FIELDS：模型条目相加时并入 tokens */
const MODEL_SUM_FIELDS = ["tokens", "in", "out", "cr", "cw", "reason"] as const;

export interface ProviderWindow {
  id: string;
  title: string;
  used_pct: number | null;
  reset: number | null;
  window_minutes: number | null;
  detail: string | null;
  usage_known: boolean;
}

/** 对应 _provider_window */
export function providerWindow(
  windowId: unknown, title: unknown, usedPct?: unknown, reset?: unknown,
  windowMinutes?: unknown, detail?: unknown, usageKnown = true,
): ProviderWindow {
  const minutes = typeof windowMinutes === "number" && Number.isFinite(windowMinutes) && windowMinutes > 0
    ? Math.trunc(windowMinutes) : null;
  return {
    id: String(windowId),
    title: String(title),
    used_pct: providerPercent(usedPct),
    reset: providerEpoch(reset),
    window_minutes: minutes,
    detail: detail ? String(detail) : null,
    usage_known: Boolean(usageKnown),
  };
}

/** 对应 _provider_credential_marker：凭据换了就当没有缓存 */
export function providerCredentialMarker(provider: string, ...parts: unknown[]): string {
  const material = [provider, ...parts].map((p) => String(p ?? "")).join("\0");
  return crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

interface CacheEntry {
  marker?: unknown;
  fetched_at?: unknown;
  quota?: unknown;
  attempted_at?: unknown;
  attempt_result?: unknown;
}

function readCacheRoot(): Record<string, any> {
  const root = loadJson<unknown>(cacheFile, {});
  return root && typeof root === "object" && !Array.isArray(root) ? root as Record<string, any> : {};
}

function cacheEntry(provider: string, root?: Record<string, any>): CacheEntry | null {
  const data = root ?? readCacheRoot();
  const providers = data.providers;
  const entry = providers && typeof providers === "object" ? (providers as Record<string, any>)[provider] : undefined;
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry as CacheEntry : null;
}

function epochNow(nowEpoch?: number): number {
  return Math.trunc(nowEpoch !== undefined ? nowEpoch : Date.now() / 1000);
}

/** 当前 epoch 秒：fetcher 归一化「现在」时用 */
export function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** 对应 _cached_provider_quota：marker 必须一致，未来时间（偏差 5 分钟以上）不要 */
export function cachedProviderQuota(
  provider: string, marker: string, maxAge: number, nowEpoch?: number, stale = false,
): Record<string, any> | null {
  return takeQuota(cacheEntry(provider), marker, maxAge, nowEpoch, stale, true);
}

/** 对应 _latest_cached_provider_quota：不看 marker，只取该 provider 最新聚合 */
export function latestCachedProviderQuota(
  provider: string, maxAge?: number | null, nowEpoch?: number, stale = false,
): Record<string, any> | null {
  return takeQuota(cacheEntry(provider), null, maxAge ?? null, nowEpoch, stale, false);
}

function takeQuota(
  entry: CacheEntry | null, marker: string | null, maxAge: number | null,
  nowEpoch: number | undefined, stale: boolean, requireMarker: boolean,
): Record<string, any> | null {
  if (!entry) return null;
  if (requireMarker && entry.marker !== marker) return null;
  const fetchedAt = providerNumber(entry.fetched_at);
  const quota = entry.quota;
  if (fetchedAt === null || !quota || typeof quota !== "object" || Array.isArray(quota)) return null;
  const age = epochNow(nowEpoch) - Math.trunc(fetchedAt);
  if (age < -300 || (maxAge !== null && age > maxAge)) return null;
  const out = structuredClone(quota) as Record<string, any>;
  if (stale) {
    out.stale = true;
    out.source = "cache";
  }
  return out;
}

/** 对应 _save_provider_quota_cache：没额度、又没有任何用量的读数不入缓存 */
export function saveProviderQuotaCache(
  provider: string, marker: string, quota: unknown, fetchedAt?: number,
): void {
  const usage = quota && typeof quota === "object" ? (quota as any).usage : null;
  const usageRanges = usage && typeof usage === "object" ? usage.ranges : null;
  const hasUsage = Boolean(usageRanges && typeof usageRanges === "object" && !Array.isArray(usageRanges)
    && Object.values(usageRanges as Record<string, any>).some((row) => row && typeof row === "object"
      && (providerUsageInt(row.tokens) > 0 || providerUsageInt(row.requests) > 0)));
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return;
  if (!(quota as any).available && !hasUsage) return;
  const root = readCacheRoot();
  const providers = (root.providers && typeof root.providers === "object" && !Array.isArray(root.providers))
    ? root.providers as Record<string, any> : {};
  providers[provider] = {
    marker,
    fetched_at: epochNow(fetchedAt),
    quota,
  };
  writeCacheRoot({ version: 1, providers });
}

/** 对应 _provider_quota_recent_attempt_result：近期失败/空结果不重复联网 */
export function providerQuotaRecentAttemptResult(
  provider: string, marker: string, maxAge: number, nowEpoch?: number,
): string | null {
  const entry = cacheEntry(provider);
  if (!entry || entry.marker !== marker) return null;
  const attemptedAt = providerNumber(entry.attempted_at);
  if (attemptedAt === null) return null;
  const age = epochNow(nowEpoch) - Math.trunc(attemptedAt);
  if (!(age >= -300 && age <= maxAge)) return null;
  const result = entry.attempt_result;
  return result === "empty" || result === "failed" ? result : "failed";
}

/** 对应 _save_provider_quota_attempt */
export function saveProviderQuotaAttempt(
  provider: string, marker: string, attemptedAt?: number, result: "empty" | "failed" = "failed",
): void {
  const root = readCacheRoot();
  const providers = (root.providers && typeof root.providers === "object" && !Array.isArray(root.providers))
    ? root.providers as Record<string, any> : {};
  const previous = providers[provider];
  const keep: Record<string, any> = previous && typeof previous === "object"
    && (previous as CacheEntry).marker === marker ? { ...(previous as Record<string, any>) } : {};
  keep.marker = marker;
  keep.attempted_at = epochNow(attemptedAt);
  keep.attempt_result = result === "empty" || result === "failed" ? result : "failed";
  providers[provider] = keep;
  writeCacheRoot({ version: 1, providers });
}

function writeCacheRoot(root: Record<string, any>): void {
  if (!saveJson(cacheFile, root)) return;
  try {
    fs.chmodSync(cacheFile, 0o600);
  } catch {
    // Windows 上没有 POSIX 权限位，失败就算了
  }
}

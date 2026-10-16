/**
 * Codex 联网额度：对应 usage.30s.py 的 2151-2569（_window_from_codex_live ~
 * fetch_codex_reset_cards 的完整区间）。
 *
 * Python 消费点（接线用，均已核对行号）：
 * - scan_codex：4166 `live = fetch_codex_live_limits()`；4168 解包三元组
 *   (live_limits, live_plan, live_updated)；4169 用 _codex_live_snapshot_is_current
 *   (2219) 比对 live 抓取时刻与日志里 selected_limits_ts，live 更新才覆盖
 *   latest_limits / plan_type / limits_updated（4170-4172）；随后 4176
 *   `_codex_quota_values(latest_limits, now_epoch=0)`（对应 collectors/codex.ts 的
 *   codexQuotaValues）消费 limits。4184-4187 在 _codex_is_custom_provider 时把
 *   latest_limits / reserve_limits / plan_type 全部置空。
 * - 主 payload：13462-13463 `_safe_scan("codex_reset_cards", fetch_codex_reset_cards,
 *   lambda: {}, errors)`；13484 `"reset_cards": cards if cards.get("count",0) > 0 else None`
 *   —— 即 count 为 0 时上层要把它转成 null，fetchCodexResetCards 本身保持返回 {}。
 *
 * 与 zed.ts 的骨架不同之处（照 Python 原样）：这一路不用 provider_quota_cache.json，
 * 各有各的缓存文件 codex_quota_cache.json / codex_reset_cards_cache.json（Python
 * 238-239 行 _writable_path），所以本模块自带路径注入口 useCodexLiveFiles。
 *
 * 网络层复用 quota/http.ts 的 requestJson（经 deps.request 注入）。语义差异：
 * Python urlopen 会跟随重定向、只在最终 URL 不是 https://chatgpt.com 时抛错；
 * requestJson 出于凭据安全根本不跟随 3xx（http.ts 第 5 行注释的规则 1）。等价结论：
 * 服务端只要发生任何重定向，两条路径都会以失败收尾（Python 是校验拦截、这里是
 * 直接 HttpError），失败退避行为一致；差异只在 Python 允许「重定向后仍回 chatgpt.com」
 * 这种理想情况成功，我们则记为一次失败。未照抄 redirect 校验是刻意为之。
 *
 * 失败退避（5 分钟不再联网，Python 2351-2368）与 account_key/auth_key 失效逻辑是
 * 承重的，逐行照搬，见 fetchCodexLiveLimits 内注释。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { HOME, TOKEI_DIR, firstExistingFile, loadJson, pathCandidates, saveJson } from "../../core/paths";
import { parseTs } from "../../core/ranges";
// 复用采集器里已经移植好的 provider 判定（对应 _codex_config + _codex_is_custom_provider，
// Python 2244-2284；采集器版本只认第一个 [section] 之前的顶层 model_provider，比 Python
// 3.9 回退正则更严格，行为一致且已在测试中验证，这里直接引用不再复制一份）。
import { codexIsCustomProvider } from "../../collectors/codex";
import { QuotaDeps } from "./context";

// ---------- Python 2125-2132 的常量，名字与数值逐一对应 ----------
/** 对应 _CODEX_QUOTA_TTL */
export const CODEX_QUOTA_TTL = 300;
/** 对应 _CODEX_QUOTA_FALLBACK_TTL（注意：这条路失败回退窗口也是 300，且要求窗口未过气） */
export const CODEX_QUOTA_FALLBACK_TTL = 300;
/** 对应 _CODEX_USAGE_URL */
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** 对应 _CODEX_USAGE_MAX_RESPONSE_BYTES */
export const CODEX_USAGE_MAX_RESPONSE_BYTES = 256 * 1024;
/** 对应 _CODEX_RESET_CARDS_URL */
export const CODEX_RESET_CARDS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
/** 对应 _CODEX_RESET_CARDS_REFRESH_INTERVAL */
export const CODEX_RESET_CARDS_REFRESH_INTERVAL = 6 * 3600;
/** 对应 _CODEX_RESET_CARDS_RETRY_INTERVAL */
export const CODEX_RESET_CARDS_RETRY_INTERVAL = 6 * 3600;
/** 对应 _CODEX_RESET_CARDS_MAX_RESPONSE_BYTES */
export const CODEX_RESET_CARDS_MAX_RESPONSE_BYTES = 256 * 1024;
/** 失败退避秒数：Python 2362 的 < 300 硬编码 */
export const CODEX_LIVE_FAILURE_BACKOFF = 300;

// ---------- 路径（Python 103-104、238-239）+ 测试注入口 ----------
// Python 的 CODEX_AUTH/CODEX_CONFIG 钉死在 ~/.codex；Codex CLI 是 Rust 写的，
// Windows 上也用 ~/.codex（HOME = %USERPROFILE%），另外支持 CODEX_HOME 覆盖。
// 环境变量沿用采集器的 TOKEI_CODEX_* 命名族（TOKEI_CODEX_CONFIG 已由采集器提供）。

const DEFAULT_CODEX_DIR = path.join(HOME, ".codex");

interface CodexLiveFiles {
  quotaCache?: string | null;
  resetCardsCache?: string | null;
  authFile?: string | null;
}
let injectedFiles: CodexLiveFiles | null = null;

/** 测试注入口：null 恢复默认。绝不许单测写真实 ~/.tokei 或 ~/.codex */
export function useCodexLiveFiles(files?: CodexLiveFiles | null): void {
  injectedFiles = files ?? null;
}

/** 对应 CODEX_QUOTA_CACHE（_writable_path("codex_quota_cache.json")）。 */
export function codexQuotaCachePath(): string {
  return injectedFiles?.quotaCache
    ?? path.join(TOKEI_DIR, "codex_quota_cache.json");
}

/** 对应 CODEX_RESET_CARDS_CACHE */
export function codexResetCardsCachePath(): string {
  return injectedFiles?.resetCardsCache
    ?? path.join(TOKEI_DIR, "codex_reset_cards_cache.json");
}

/**
 * 对应 CODEX_AUTH（Python 103 行固定 ~/.codex/auth.json）。
 * 端口新增候选顺序：注入路径 → TOKEI_CODEX_AUTH（多根，沿用采集器 env 覆盖惯例）
 * → %CODEX_HOME%\\auth.json → ~/.codex/auth.json；取第一个真实存在的文件。
 */
export function codexAuthPath(): string {
  if (injectedFiles?.authFile) return injectedFiles.authFile;
  if (process.env.TOKEI_CODEX_AUTH) {
    const hit = firstExistingFile(pathCandidates("TOKEI_CODEX_AUTH"));
    if (hit) return hit;
  }
  const candidates: string[] = [];
  if (process.env.CODEX_HOME) candidates.push(path.join(process.env.CODEX_HOME, "auth.json"));
  candidates.push(path.join(DEFAULT_CODEX_DIR, "auth.json"));
  return firstExistingFile(candidates) ?? candidates[candidates.length - 1];
}

// ---------- 通用小工具 ----------

function isDict(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Python 的真值语义：0、""、null、undefined、false、空数组/空对象都算 falsy */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/** Python ValueError 的替身：让「转换炸了」和外层失败退避走同一条 except 路径 */
class ValueError extends Error {}

/** 对应 Python 的 float(x)：数字原样、布尔换算、字符串走 Number，null/对象/空串/NaN 一律抛错 */
function toFloatStrict(value: unknown): number {
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw new TypeError("float() of nan-like value");
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new ValueError("could not convert string to float");
    const n = Number(trimmed);
    if (Number.isNaN(n)) throw new ValueError("could not convert string to float");
    return n;
  }
  throw new TypeError(`float() unsupported operand: ${typeof value}`);
}

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------- 额度读数归一化（Python 2151-2228）----------

export interface CodexLiveWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

export interface CodexLiveLimits {
  limit_id: "codex";
  limit_name: null;
  primary: CodexLiveWindow | null;
  secondary: CodexLiveWindow | null;
  credits: any;
  plan_type: any;
  rate_limit_reached_type: any;
}

/**
 * fetch_codex_live_limits 的返回：Python 是 None 或三元组 (limits, plan, fetched_at)，
 * 这里用 [limits, plan, fetched_at] 元组，None 对应 null。上层按 4168 行方式解包。
 */
export type CodexLiveResult = [limits: CodexLiveLimits, plan: any, fetchedAt: number];

/** 对应 _window_from_codex_live(2151)。now 用于 reset_after 兜底换算（Python 用 datetime.now()，这里可注入） */
export function windowFromCodexLive(
  window: unknown, now: number,
): CodexLiveWindow | null {
  if (!isDict(window)) return null;
  const used = window.used_percent;
  let resetAt = window.reset_at;
  const resetAfter = window.reset_after_seconds;
  if ((resetAt === null || resetAt === undefined) && resetAfter !== null && resetAfter !== undefined) {
    // Python 2158：int(now + float(reset_after))，float 抛错会一路冒到 fetch 的失败分支
    resetAt = Math.trunc(now + toFloatStrict(resetAfter));
  }
  const out: CodexLiveWindow = {};
  if (used !== null && used !== undefined) out.used_percent = toFloatStrict(used);
  if (window.limit_window_seconds !== null && window.limit_window_seconds !== undefined) {
    // Python 2163 用 int(round(...))，round 是四舍六入五取偶；见 roundHalfEven
    out.window_minutes = Math.trunc(roundHalfEven(toFloatStrict(window.limit_window_seconds) / 60));
  }
  if (resetAt !== null && resetAt !== undefined) out.resets_at = Math.trunc(toFloatStrict(resetAt));
  return Object.keys(out).length ? out : null;
}

/** Python round() 的半偶舍入：30/60=0.5 → 0、90/60=1.5 → 2，和 JS Math.round 不同 */
function roundHalfEven(value: number): number {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** 对应 _codex_live_to_limits(2169) */
export function codexLiveToLimits(data: unknown, now: number): CodexLiveLimits | null {
  const root = isDict(data) ? data : {};
  const rl = isDict(root.rate_limit) ? root.rate_limit : {};
  const primary = windowFromCodexLive(rl.primary_window, now);
  const secondary = windowFromCodexLive(rl.secondary_window, now);
  if (!primary && !secondary) return null;
  return {
    limit_id: "codex",
    limit_name: null,
    primary: primary ?? null,
    secondary: secondary ?? null,
    credits: (isDict(data) ? data : {}).credits ?? null,
    plan_type: (isDict(data) ? data : {}).plan_type ?? null,
    rate_limit_reached_type: rl.rate_limit_reached_type ?? null,
  };
}

/** 对应 _codex_limits_have_active_window(2186)：任一窗口 resets_at 还在未来就算活跃 */
export function codexLimitsHaveActiveWindow(limits: unknown, now: number): boolean {
  if (!isDict(limits)) return false;
  for (const slotName of ["primary", "secondary"] as const) {
    const slot = isDict(limits[slotName]) ? limits[slotName] : {};
    const reset = slot.resets_at;
    try {
      if (reset !== null && reset !== undefined && toFloatStrict(reset) > now) return true;
    } catch {
      continue;
    }
  }
  return false;
}

interface CachedOptions {
  allowActiveWindow?: boolean;
  accountKey?: string | null;
}

/** 对应 _cached_codex_live_limits(2199)：读 codex_quota_cache.json 本体 */
export function cachedCodexLiveLimits(
  maxAge: number, opts?: CachedOptions, now?: number,
): CodexLiveResult | null {
  const cached = readCodexQuotaCache();
  let fetchedAt = cached.fetched_at;
  const limits = cached.limits;
  if (!pyTruthy(fetchedAt) || !pyTruthy(limits)) return null;
  const cachedAccountKey = cached.account_key;
  if (pyTruthy(opts?.accountKey) && pyTruthy(cachedAccountKey) && cachedAccountKey !== opts!.accountKey) {
    return null;
  }
  try {
    fetchedAt = toFloatStrict(fetchedAt);
  } catch {
    return null;
  }
  const age = (now ?? Date.now() / 1000) - fetchedAt;
  if (age > maxAge && !(opts?.allowActiveWindow
    && codexLimitsHaveActiveWindow(limits, now ?? Date.now() / 1000))) {
    return null;
  }
  return [limits, cached.plan ?? null, fetchedAt as number];
}

/** 对应 _codex_live_snapshot_is_current(2219)：live 读数不早于日志里那条才算新 */
export function codexLiveSnapshotIsCurrent(liveUpdated: unknown, localUpdated: unknown): boolean {
  if (liveUpdated === null || liveUpdated === undefined || !pyTruthy(localUpdated)) return true;
  const parsed = parseTs(localUpdated);
  const localEpoch = parsed ? parsed.epoch : null;
  if (localEpoch === null) return true;
  try {
    return toFloatStrict(liveUpdated) >= localEpoch;
  } catch {
    return false;
  }
}

// ---------- 凭据上下文（Python 2231-2320）----------

/** 对应 _decode_jwt_claims(2231)：只取 payload 段，坏 token 一律 {} */
export function decodeJwtClaims(token: unknown): Record<string, any> {
  if (typeof token !== "string" || (token.match(/\./g) ?? []).length < 2) return {};
  try {
    let payload = token.split(".")[1];
    payload += "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isDict(decoded) ? decoded : {};
  } catch {
    return {};
  }
}

export interface CodexAuthContext {
  access_token?: string;
  account_id?: string | null;
  account_key?: string;
  auth_key?: string;
}

/** 对应 _codex_auth_context(2287)：account_key/auth_key 是缓存失效判定的锚点 */
export function codexAuthContext(auth: unknown): CodexAuthContext {
  if (!isDict(auth)) return {};
  const tokens = isDict(auth.tokens) ? auth.tokens : {};

  const value = (...names: string[]): string | null => {
    for (const source of [tokens, auth]) {
      for (const name of names) {
        const item = (source as Record<string, any>)[name];
        if (typeof item === "string" && item) return item;
      }
    }
    return null;
  };

  const accessToken = value("access_token", "accessToken");
  if (!accessToken) return {};
  const idToken = value("id_token", "idToken");
  const claims = decodeJwtClaims(accessToken);
  const idClaims = decodeJwtClaims(idToken);
  const authClaim = isDict(claims["https://api.openai.com/auth"])
    ? claims["https://api.openai.com/auth"] : {};
  const idAuthClaim = isDict(idClaims["https://api.openai.com/auth"])
    ? idClaims["https://api.openai.com/auth"] : {};
  let accountId = value("account_id", "accountId");
  accountId = accountId
    ?? (authClaim.chatgpt_account_id != null && authClaim.chatgpt_account_id !== ""
      ? String(authClaim.chatgpt_account_id) : null)
    ?? (idAuthClaim.chatgpt_account_id != null && idAuthClaim.chatgpt_account_id !== ""
      ? String(idAuthClaim.chatgpt_account_id) : null);
  const identity = accountId || claims.sub || idClaims.sub || accessToken;
  return {
    access_token: accessToken,
    account_id: accountId !== null ? String(accountId) : null,
    account_key: sha256Hex(String(identity)),
    auth_key: sha256Hex(accessToken),
  };
}

// ---------- 额度缓存文件读写（Python 用 _load_json/_atomic_write_json）----------

function readCodexQuotaCache(): Record<string, any> {
  const data = loadJson<unknown>(codexQuotaCachePath(), {});
  return isDict(data) ? data : {};
}

// ---------- fetch_codex_live_limits（Python 2323-2414）----------

/**
 * 对应 fetch_codex_live_limits(2323)。消费点：scan_codex 4166-4176。
 * 返回 null（Python 的 None）或 [limits, plan, fetched_at] 三元组。
 */
export async function fetchCodexLiveLimits(deps: QuotaDeps): Promise<CodexLiveResult | null> {
  // 2324：环境变量 "0" 直接掐死这一路，其它值不拦
  if (deps.env("TOKEI_CODEX_LIVE_QUOTA") === "0") return null;

  // 2330-2336：切到第三方 provider（cc Switch 之类）时官方额度无意义，
  // 顺手删掉旧的官方额度缓存，让面板只剩 token 用量。
  if (codexIsCustomProvider()) {
    try {
      fs.rmSync(codexQuotaCachePath(), { force: true });
    } catch {
      // Python 同样吞掉删除失败
    }
    return null;
  }

  const now = deps.now();

  // 2337：不带 account_key 的第一道缓存（缓存里没存过账号 key 时也能命中）
  let cached = cachedCodexLiveLimits(CODEX_QUOTA_TTL, undefined, now);
  if (cached) return cached;

  const auth = loadJson<unknown>(codexAuthPath(), {});
  const context = codexAuthContext(auth);
  const accessToken = context.access_token;
  const accountKey = context.account_key;
  const authKey = context.auth_key ?? null;
  // 2345：没 access_token 或认不出账号就整个跳过
  if (!accessToken || !accountKey) return null;

  const cacheState = readCodexQuotaCache();
  // 2348：这次带上 account_key，换账号的旧缓存不再算命中
  cached = cachedCodexLiveLimits(CODEX_QUOTA_TTL, { accountKey }, now);
  if (cached) return cached;

  // 2351-2368 失败退避（承重，逐句对应）：
  // 网络挂了（比如公司代理拦截）就 5 分钟内不再联网，否则每轮 30s 刷新白等 6s 超时。
  let lastFailure = cacheState.last_failure_at ?? 0;
  const stateAccountKey = cacheState.account_key;
  // 缓存里的失败是别的账号记的 —— 不作废当前账号，直接清零重探
  if (stateAccountKey !== null && stateAccountKey !== undefined && stateAccountKey !== accountKey) {
    lastFailure = 0;
  }
  // 同账号但 token 换过了（Codex 自己刷新了凭据）：旧失败不算数，立刻重试
  if (stateAccountKey === accountKey) {
    const stateAuthKey = cacheState.auth_key;
    if (stateAuthKey !== null && stateAuthKey !== undefined && stateAuthKey !== authKey) {
      lastFailure = 0;
    }
  }
  let failureIsRecent = false;
  try {
    failureIsRecent = pyTruthy(lastFailure)
      && now - toFloatStrict(lastFailure) < CODEX_LIVE_FAILURE_BACKOFF;
  } catch {
    failureIsRecent = false;
  }
  if (failureIsRecent) {
    // 退避期内：只放行「窗口还没翻篇」的旧读数（allow_active_window）
    return cachedCodexLiveLimits(
      CODEX_QUOTA_FALLBACK_TTL, { allowActiveWindow: true, accountKey }, now);
  }

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "Tokei",
      // Python 用 add_unredirected_header 防凭据随重定向外流；requestJson 本来就不跟
      // 随重定向（3xx 直接 HttpError），两条路径都不会把 Bearer 送到别的域。
      Authorization: `Bearer ${accessToken}`,
    };
    if (context.account_id) headers["ChatGPT-Account-Id"] = context.account_id;
    // timeout=3、256KiB 上限都和 Python 2379-2385 对齐
    const data = await deps.request(CODEX_USAGE_URL, {
      headers,
      timeoutSeconds: 3,
      maxBytes: CODEX_USAGE_MAX_RESPONSE_BYTES,
    });
    const limits = codexLiveToLimits(data, now);
    // 2388：没解析出任何窗口就当响应无效，走失败分支
    if (!limits) throw new ValueError("invalid Codex usage response");
    const plan = isDict(data) ? (data.plan_type ?? null) : null;
    const fetchedAt = deps.now();
    // 2392-2399：整文件覆盖写；account_key/auth_key 是后面失效判定的锚点。
    // saveJson 不抛错只返 false，这里显式抛，复刻 Python「写失败也算这次请求失败」。
    if (!saveJson(codexQuotaCachePath(), {
      fetched_at: fetchedAt,
      limits,
      plan,
      account_key: accountKey,
      auth_key: authKey,
      source: "live",
    })) {
      throw new Error(`cannot write ${codexQuotaCachePath()}`);
    }
    return [limits, plan, fetchedAt];
  } catch {
    // 2401-2414：记失败时间戳供退避；别的账号写的缓存状态整个作废（state = {}），
    // 但本账号的旧 limits 要留着（Python 是在原 dict 上打补丁）。
    try {
      let state = readCodexQuotaCache();
      const stateAccountKey = state.account_key;
      if (stateAccountKey !== null && stateAccountKey !== undefined && stateAccountKey !== accountKey) {
        state = {};
      }
      state.last_failure_at = deps.now();
      state.account_key = accountKey;
      state.auth_key = authKey;
      if (!saveJson(codexQuotaCachePath(), state)) throw new Error("cache write failed");
    } catch {
      // 写失败就算了（Python 2410 同款）
    }
    return cachedCodexLiveLimits(
      CODEX_QUOTA_FALLBACK_TTL, { allowActiveWindow: true, accountKey }, now);
  }
}

// ---------- 续卡（reset cards）：Python 2417-2569 ----------

/**
 * 续卡读数。updated 允许是缓存里带出来的任意原始值（Python 2456 直接透传
 * cards.get("updated")，可能为 None），所以类型留 unknown。
 */
export interface CodexResetCards {
  count: number;
  expires: number[];
  updated: unknown;
}

/**
 * Python 的 fetch_codex_reset_cards 在开关关闭/凭据缺失时返回空 dict {}（不是卡片
 * 结构），上层 13484 行按 .get("count", 0) 容错读取，这里用 union 原样保留两种形态。
 */
export type CodexResetCardsResult = CodexResetCards | Record<string, never>;

/**
 * 对应 _normalize_codex_reset_cards(2417)。承重过滤条件（逐条照搬）：
 * 只要 status=="available"、is_supported_by_plan 不为 false（缺字段算支持）、
 * expires_at 能解析且在未来；升序去重排序由 sorted 保证。
 */
export function normalizeCodexResetCards(data: unknown, nowEpoch: number): CodexResetCards | null {
  if (!isDict(data) || !Array.isArray(data.credits)) return null;
  const expires: number[] = [];
  for (const credit of data.credits) {
    if (!isDict(credit) || credit.status !== "available") continue;
    if (credit.is_supported_by_plan === false) continue;
    const parsed = parseTs(credit.expires_at ? String(credit.expires_at) : "");
    if (!parsed) continue;
    const epoch = Math.trunc(parsed.epoch);
    if (epoch > nowEpoch) expires.push(epoch);
  }
  const ordered = expires.sort((a, b) => a - b);
  return { count: ordered.length, expires: ordered, updated: Math.trunc(nowEpoch) };
}

/** 对应 _cached_codex_reset_cards(2440)：过期卡直接消失，updated 原样透传 */
export function cachedCodexResetCards(state: unknown, nowEpoch: number): CodexResetCards {
  const cards = isDict(state) && isDict(state.cards) ? state.cards : null;
  if (!cards) return { count: 0, expires: [], updated: null };
  const expires: number[] = [];
  const rawExpires = Array.isArray(cards.expires) ? cards.expires : [];
  for (const value of rawExpires) {
    try {
      const epoch = Math.trunc(toFloatStrict(value));
      if (epoch > nowEpoch) expires.push(epoch);
    } catch {
      continue;
    }
  }
  expires.sort((a, b) => a - b);
  return { count: expires.length, expires, updated: cards.updated };
}

/** 对应 _codex_reset_cards_next_attempt(2460)：下一次到期前 60 秒就再来拿 */
export function codexResetCardsNextAttempt(cards: CodexResetCards, nowEpoch: number): number {
  const nextDaily = Math.trunc(nowEpoch + CODEX_RESET_CARDS_REFRESH_INTERVAL);
  const expires: number[] = [];
  for (const value of cards.expires ?? []) {
    try {
      const epoch = Math.trunc(toFloatStrict(value));
      if (epoch > nowEpoch) expires.push(epoch);
    } catch {
      continue;
    }
  }
  if (!expires.length) return nextDaily;
  return Math.min(nextDaily, Math.min(...expires) + 60);
}

/** 对应 _save_codex_reset_cards_state(2473)：失败静默，权限收紧到 600 */
function saveCodexResetCardsState(state: Record<string, any>): void {
  try {
    if (!saveJson(codexResetCardsCachePath(), state)) throw new Error("write failed");
    try {
      fs.chmodSync(codexResetCardsCachePath(), 0o600);
    } catch {
      // Windows 没有 POSIX 权限位，失败就算了
    }
  } catch {
    // Python 2477 同款吞异常
  }
}

/**
 * 对应 fetch_codex_reset_cards(2481)。消费点：主 payload 13462-13463，
 * 13484 处由上层把 count==0 转成 null。nowEpoch 可注入（Python 形参同款）。
 *
 * 续卡是 OpenAI 账号级资产，不随 CLI 当前 provider 变化 —— Python 2485-2486 特意
 * 说明这里不按 _codex_is_custom_provider 屏蔽，端口保持一致。
 */
export async function fetchCodexResetCards(
  deps: QuotaDeps, nowEpoch?: number,
): Promise<CodexResetCardsResult> {
  if (deps.env("TOKEI_CODEX_LIVE_QUOTA") === "0") return {};
  const now = Math.trunc(nowEpoch !== undefined && nowEpoch !== null ? nowEpoch : deps.now());

  const auth = loadJson<unknown>(codexAuthPath(), {});
  const context = codexAuthContext(auth);
  const accessToken = context.access_token;
  const accountKey = context.account_key;
  const authKey = context.auth_key;
  // 2493：这一路三个 key 少一个都不行（auth_key 参与换 token 重试判定）
  if (!accessToken || !accountKey || !authKey) return {};

  let state: Record<string, any> = (() => {
    const raw = loadJson<unknown>(codexResetCardsCachePath(), {});
    return isDict(raw) ? raw : {};
  })();
  if (state.account_key !== accountKey) {
    // 2497-2498：换账号 = 从头开始，旧 cards/next_attempt 都不带
    state = { account_key: accountKey, auth_key: authKey };
  } else if (pyTruthy(state.auth_key) && state.auth_key !== authKey) {
    // 2499-2502：同账号换了 token（Codex 自己刷过登录态），立刻重试一次
    state.next_attempt_at = 0;
    delete state.last_error;
  }
  state.auth_key = authKey;
  const cached = cachedCodexResetCards(state, now);

  let nextAttemptAt = 0;
  try {
    nextAttemptAt = pyTruthy(state.next_attempt_at) ? Math.trunc(toFloatStrict(state.next_attempt_at)) : 0;
  } catch {
    nextAttemptAt = 0;
  }
  let lastSuccessAt = 0;
  try {
    // 2512：fetched_at 优先，其次卡片自带的 updated（Python 的 or 链）
    const raw = pyTruthy(state.fetched_at)
      ? state.fetched_at
      : (pyTruthy(cached.updated) ? cached.updated : 0);
    lastSuccessAt = Math.trunc(toFloatStrict(raw));
  } catch {
    lastSuccessAt = 0;
  }
  // 2509-2519：老版本曾成功缓存 24 小时，升级后把截止时间夹到 6 小时窗口内，
  // 新发的卡不用等一整个旧周期。
  if (nextAttemptAt && lastSuccessAt) {
    nextAttemptAt = Math.min(nextAttemptAt, lastSuccessAt + CODEX_RESET_CARDS_REFRESH_INTERVAL);
  }
  if (now < nextAttemptAt) return cached;

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "Tokei",
      Authorization: `Bearer ${accessToken}`,
    };
    if (context.account_id) headers["ChatGPT-Account-Id"] = String(context.account_id);
    const data = await deps.request(CODEX_RESET_CARDS_URL, {
      headers,
      timeoutSeconds: 3,
      maxBytes: CODEX_RESET_CARDS_MAX_RESPONSE_BYTES,
    });
    const cards = normalizeCodexResetCards(data, now);
    if (!cards) throw new ValueError("invalid Codex reset-card response");
    state = {
      account_key: accountKey,
      auth_key: authKey,
      fetched_at: now,
      last_attempt_at: now,
      next_attempt_at: codexResetCardsNextAttempt(cards, now),
      cards,
    };
    saveCodexResetCardsState(state);
    return cards;
  } catch (error) {
    // 2553-2569：按 HTTP 状态码分类记账。Python 读 urllib HTTPError.code；
    // 我们的传输层错误是 quota/http.ts 的 HttpError.status（socket 错误没有状态码，
    // 落进 "request"）。401/403 认 auth、404/410 认 unsupported，其余 request。
    const status: number | null = (error as any)?.code ?? (error as any)?.status ?? null;
    const unsupported = status === 404 || status === 410;
    state.last_error = status === 401 || status === 403 ? "auth" : unsupported ? "unsupported" : "request";
    state.last_attempt_at = now;
    state.next_attempt_at = now
      + (unsupported ? CODEX_RESET_CARDS_REFRESH_INTERVAL : CODEX_RESET_CARDS_RETRY_INTERVAL);
    saveCodexResetCardsState(state);
    return cached;
  }
}

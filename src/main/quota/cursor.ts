/**
 * Cursor 额度：对应 usage.30s.py 的 6006-6318（会话 + 归一化 + 翻页取事件）与 6515-6576（fetch/scan）。
 * 6319-6598 那段 _grok_bot_* helper 也落在这里：按交付的行号切分，6006-6600 归本文件，
 * 而且 fetch_cursor_quota 直接调 _normalize_grok_bot_quota —— helper 留这一侧，
 * grokBot.ts 才能单向 import 本文件，避开 CommonJS 循环依赖。
 *
 * 凭据两条来源，照原版：
 * 1) Cursor 桌面端登录后写进 SQLite（state.vscdb 的 ItemTable，键 cursorAuth/accessToken，
 *    值是个 JWT）；从 JWT 里取 sub / email / exp，过期或 sub 非法就当没有会话；
 * 2) 用户手工粘贴的 Cookie（TOKEI_CURSOR_COOKIE / cursor_cookie，或 DPAPI 里存的 cursor_cookie）。
 * 两条都没有 → 返回 {}，一个请求都不发。
 *
 * Windows 化：macOS 的两条候选路径原样保留（同一份代码在 mac 上也能跑测试），
 * 另加 %APPDATA%\Cursor\User\globalStorage\state.vscdb；环境变量名仍是 TOKEI_CURSOR_AUTH_DB。
 */
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "node:module";
import { spawnSync } from "child_process";
import type { DatabaseSync } from "node:sqlite";
import {
  APPDATA, HOME, LOCALAPPDATA, TOKEI_DIR, expandPath, firstExistingFile, isFile, loadJson, pathCandidates,
} from "../../core/paths";
import { Bounds, dayKey, rangeBounds } from "../../core/ranges";
import {
  PROVIDER_QUOTA_FALLBACK_TTL, PROVIDER_QUOTA_MAX_RESPONSE_BYTES, PROVIDER_QUOTA_TTL, ProviderUsage,
  cachedProviderQuota, epochSeconds, providerCredentialMarker, providerEpoch, providerInteger, providerMoney,
  providerNumber, providerPercent, providerQuotaEnabled, providerUsageFromDays, providerUsageInt,
  providerWindow, saveProviderQuotaCache,
} from "../../core/providerQuota";
import { QuotaDeps, secretValue } from "./context";

/** 对应 _CURSOR_USAGE_PAGE_SIZE / _CURSOR_USAGE_MAX_PAGES */
export const CURSOR_USAGE_PAGE_SIZE = 1000;
export const CURSOR_USAGE_MAX_PAGES = 200;

// node:sqlite 在 Node 22 是实验内置模块、不在 builtinModules 清单里，
// vitest/vite 的静态导入解析会失败，故运行时经 createRequire 获取构造器
const { DatabaseSync: DatabaseSyncCtor } = createRequire(path.join(process.cwd(), "noop.cjs"))("node:sqlite") as typeof import("node:sqlite");

/** 对应 _cursor_session() / _cursor_app_session() 返回的那个 dict */
export interface CursorSession {
  cookie: string;
  account: string | null;
  subject: string | null;
  user_id: string | null;
  marker: string;
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 对应 _decode_jwt_claims：只解 payload 段（第二段），base64url + 补等号。
 * 原版要求 `token.count(".") >= 2`（三段式），签名不校验——额度接口本来就信服务端。
 * Node 的 base64url 解码比 Python 宽松（标准字母表也能读），只影响畸形 token 的容忍度。
 */
export function decodeJwtClaims(token: unknown): Record<string, any> {
  if (typeof token !== "string" || token.split(".").length < 3) return {};
  const payload = token.split(".")[1];
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    const parsed = JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

/**
 * 对应 _cursor_app_auth_paths（TOKEI_CURSOR_AUTH_DB 支持 path.delimiter 分隔多路径）。
 * 注入优先：deps.env 给了 TOKEI_CURSOR_AUTH_DB 就只用它（单测靠这条把路径钉死在临时目录，
 * 绝不去翻真实机器上装着的 Cursor），没给才回落到 pathCandidates 的默认候选。
 */
export function cursorAppAuthPaths(deps?: Pick<QuotaDeps, "env"> | null): string[] {
  const defaults = [
    path.join(HOME, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    path.join(HOME, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    path.join(APPDATA, "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
  const fromEnv = deps ? deps.env("TOKEI_CURSOR_AUTH_DB") : undefined;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.split(path.delimiter).map(expandPath).filter((p): p is string => Boolean(p));
  }
  const candidates = [...pathCandidates("TOKEI_CURSOR_AUTH_DB", ...defaults)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of candidates) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * 从 state.vscdb 读 cursorAuth/accessToken。
 * 原版用 `file:...?mode=ro` 只读 URI + timeout 0.25 秒：Cursor 正在写库时不能把它的写锁抢走，
 * 也绝不能在用户的数据文件上留下任何改动。node:sqlite 用 { readOnly, timeout } 表达同一意图。
 * 读失败（文件被锁、没有 ItemTable、值不是文本）一律返回 null，跟 Python 的 except sqlite3.Error 一致。
 */
function readCursorAccessToken(dbPath: string): string | null {
  let conn: DatabaseSync | null = null;
  try {
    conn = new DatabaseSyncCtor(dbPath, { readOnly: true, timeout: 250 });
    const row = conn.prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1")
      .get("cursorAuth/accessToken") as { value?: unknown } | undefined;
    if (!row || row.value === undefined || row.value === null) return null;
    const value = row.value;
    // SQLite 的 BLOB 到 Node 是 Uint8Array：原版 bytes → decode("utf-8","ignore")
    if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
    if (typeof value === "string") return value;
    return null;
  } catch {
    return null;
  } finally {
    try {
      conn?.close();
    } catch {
      /* 已经读不到值了，关不掉也不影响结果 */
    }
  }
}

/** 对应 _cursor_app_session：JWT 里的 exp 必须还有效（留 60 秒余量），否则不认这个会话 */
export function cursorAppSession(
  deps: QuotaDeps, options: { path?: string | null; now?: number | null } = {},
): CursorSession | null {
  const dbPath = options.path ?? firstExistingFile(cursorAppAuthPaths(deps));
  if (!dbPath || !isFile(dbPath)) return null;
  const rawToken = readCursorAccessToken(dbPath);
  const token = trimmedString(rawToken);
  if (!token) return null;
  const claims = decodeJwtClaims(token);
  const subject = typeof claims.sub === "string" ? claims.sub : null;
  const userId = subject ? (subject.split("|").pop() ?? null) : null;
  if (!userId || !/^[A-Za-z0-9._-]+$/.test(userId)) return null;
  const expiration = providerNumber(claims.exp);
  const now = Math.trunc(options.now ?? deps.now());
  if (expiration === null || expiration <= now + 60) return null;
  const email = typeof claims.email === "string" ? claims.email : null;
  return {
    // 原版用 %3A%3A（"::" 的转义）拼 Cookie，直接写死，不靠 encodeURIComponent 的差别
    cookie: `WorkosCursorSessionToken=${userId}%3A%3A${token}`,
    account: email && email.trim() ? email.trim() : subject,
    subject,
    user_id: userId,
    marker: providerCredentialMarker("cursor", subject, token),
  };
}

/**
 * 对应 _cursor_cookie_session：手工 Cookie 里没有 WorkosCursorSessionToken 也照样返回会话
 * （账号信息全 null），原版就是这么写的 —— 有 Cookie 就能问接口，身份只是顺带显示。
 */
export function cursorCookieSession(cookie: unknown): CursorSession | null {
  const text = typeof cookie === "string" ? cookie : "";
  if (!text.trim()) return null;
  let account: string | null = null;
  let subject: string | null = null;
  let userId: string | null = null;
  for (const component of text.split(";")) {
    const [name, separator, value] = splitCookiePair(component.trim());
    if (separator && name === "WorkosCursorSessionToken") {
      const token = decodeURIComponent(value).split("::").pop() ?? "";
      const claims = decodeJwtClaims(token);
      subject = typeof claims.sub === "string" ? claims.sub : null;
      userId = subject ? (subject.split("|").pop() ?? null) : null;
      const email = claims.email;
      account = typeof email === "string" && email.trim() ? email.trim() : subject;
      break;
    }
  }
  return {
    cookie: text.trim(),
    account,
    subject,
    user_id: userId,
    marker: providerCredentialMarker("cursor", text.trim()),
  };
}

/** 对应 str.partition("=")：只切第一个等号，值里允许再出现等号 */
function splitCookiePair(component: string): [string, boolean, string] {
  const index = component.indexOf("=");
  if (index < 0) return [component, false, ""];
  return [component.slice(0, index), true, component.slice(index + 1)];
}

/** 对应 _cursor_session：手工 Cookie 优先，其次读桌面端的 SQLite */
export function cursorSession(deps: QuotaDeps): CursorSession | null {
  // Cookie 是「存起来的凭据」，所以走 secretValue：环境变量 → DPAPI → config.json
  const manual = secretValue(deps, "TOKEI_CURSOR_COOKIE", "cursor_cookie", "cursor_cookie");
  return manual ? cursorCookieSession(manual) : cursorAppSession(deps);
}

const PLAN_NAMES: Record<string, string> = {
  enterprise: "Enterprise", express: "Start", free: "Free",
  free_trial: "Pro Trial", hobby: "Hobby", pro: "Pro",
  pro_student: "Pro", pro_plus: "Pro+", team: "Team", ultra: "Ultra",
};

/** 对应 _cursor_plan_name：映射表命中就用中文名，否则原样，最后统一加 Cursor 前缀 */
export function cursorPlanName(raw: unknown): string | null {
  const value = trimmedString(raw);
  if (!value) return null;
  const mapped = PLAN_NAMES[value.toLowerCase()];
  return `Cursor ${mapped ?? value}`;
}

interface CursorUsageDay {
  tokens: number;
  in: number;
  out: number;
  cr: number;
  cw: number;
  reason: number;
  cost: number;
  requests: number;
  models: Record<string, { tokens: number; in: number; out: number; cr: number; cw: number; reason: number; cost: number }>;
  hours: number[];
}

/**
 * 对应 _normalize_cursor_usage_events：把 dashboard 的逐条事件按本地日聚合，
 * 再交给 providerUsageFromDays 切成 today/week/month/... 各区间。
 * 事件时间戳既可能是秒也可能是毫秒（>1e11 判毫秒），全零 token 的事件直接丢。
 */
export function normalizeCursorUsageEvents(
  events: unknown, options: { bounds?: Bounds | null } = {},
): ProviderUsage {
  const days: Record<string, CursorUsageDay> = {};
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const row = event as Record<string, any>;
    const timestamp = providerNumber(row.timestamp);
    const usage = row.tokenUsage;
    if (timestamp === null || timestamp <= 0 || !usage || typeof usage !== "object" || Array.isArray(usage)) continue;
    const seconds = timestamp > 100_000_000_000 ? timestamp / 1000 : timestamp;
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) continue;
    const tokens = usage as Record<string, any>;
    const components = {
      in: providerUsageInt(tokens.inputTokens),
      out: providerUsageInt(tokens.outputTokens),
      cr: providerUsageInt(tokens.cacheReadTokens),
      cw: providerUsageInt(tokens.cacheWriteTokens),
      reason: 0,
    };
    const total = components.in + components.out + components.cr + components.cw + components.reason;
    if (total <= 0) continue;
    const cents = providerNumber(tokens.totalCents);
    const cost = cents !== null && cents >= 0 ? cents / 100 : 0;
    const modelName = trimmedString(row.model) ?? "unknown";
    const key = dayKey(date);
    const day = (days[key] ??= {
      tokens: 0, in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, requests: 0, models: {},
      hours: new Array(24).fill(0),
    });
    day.tokens += total;
    day.cost += cost;
    day.requests += 1;
    day.hours[date.getHours()] += total;
    for (const field of ["in", "out", "cr", "cw", "reason"] as const) day[field] += components[field];
    const model = (day.models[modelName] ??= { tokens: 0, in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0 });
    model.tokens += total;
    model.cost += cost;
    for (const field of ["in", "out", "cr", "cw", "reason"] as const) model[field] += components[field];
  }
  return providerUsageFromDays(days, { bounds: options.bounds ?? rangeBounds() });
}

/**
 * 稳定序列化的事件串：Python 用 dict 相等来比页边界、用 json.dumps(sort_keys=True) 去重，
 * 这里统一成一个「键排序后的 JSON」同时服务两件事。
 */
function stableEventKey(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** 对应 _cursor_boundary_overlap：上一页尾部与本页头部重叠多少条（接口翻页会重复返回边界事件） */
export function cursorBoundaryOverlap(previous: unknown[], current: unknown[]): number {
  const limit = Math.min(previous.length, current.length);
  for (let count = limit; count > 0; count -= 1) {
    let same = true;
    for (let index = 0; index < count; index += 1) {
      if (stableEventKey(previous[previous.length - count + index]) !== stableEventKey(current[index])) {
        same = false;
        break;
      }
    }
    if (same) return count;
  }
  return 0;
}

/** 对应 _fetch_cursor_usage_events：从当年 1 月 1 日起逐页拉事件，页数与条数都有硬校验 */
export async function fetchCursorUsageEvents(
  deps: QuotaDeps, session: CursorSession, now?: number | null,
): Promise<any[]> {
  const nowSeconds = Math.trunc(now ?? deps.now());
  const nowDate = new Date(nowSeconds * 1000);
  // 原版把起点钉在「本地时区当年 1 月 1 日 00:00」，不是滚动窗口
  const start = new Date(nowDate.getFullYear(), 0, 1, 0, 0, 0, 0);
  const headers = { Cookie: session.cookie, Origin: "https://cursor.com" };
  const pages: any[][] = [];
  let expectedTotal: number | null = null;
  let completed = false;
  for (let pageNumber = 1; pageNumber <= CURSOR_USAGE_MAX_PAGES; pageNumber += 1) {
    const payload = await deps.request(
      "https://cursor.com/api/dashboard/get-filtered-usage-events",
      {
        headers,
        method: "POST",
        timeoutSeconds: 15,
        maxBytes: 16 * 1024 * 1024,
        body: {
          page: pageNumber,
          pageSize: CURSOR_USAGE_PAGE_SIZE,
          startDate: String(Math.trunc(start.getTime())),
          endDate: String(nowSeconds * 1000),
        },
      },
    );
    const reported = payload && typeof payload === "object" && !Array.isArray(payload)
      ? providerInteger((payload as Record<string, any>).totalUsageEventsCount) : null;
    if (reported !== null && reported < 0) throw new Error("cursor usage event count cannot be negative");
    if (reported !== null) {
      if (expectedTotal !== null && reported !== expectedTotal) throw new Error("cursor usage pagination count changed");
      expectedTotal = reported;
    }
    const events = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, any>).usageEventsDisplay : null;
    if (!Array.isArray(events)) throw new Error("cursor usage events response was invalid");
    if (!events.length) {
      completed = true;
      break;
    }
    pages.push(events);
    if (events.length < CURSOR_USAGE_PAGE_SIZE) {
      completed = true;
      break;
    }
  }
  if (!completed) throw new Error("cursor usage pagination did not complete");
  const raw = pages.flat();
  if (expectedTotal === null) return raw;
  if (raw.length < expectedTotal) throw new Error("cursor usage pagination was incomplete");
  if (raw.length === expectedTotal) return raw;
  // 多出来的只能是被重复返回的边界事件：逐页从头去重掉，凑不满就判不一致
  let removals = raw.length - expectedTotal;
  const reconciled: any[] = pages.length ? [...pages[0]] : [];
  for (let index = 1; index < pages.length; index += 1) {
    const overlap = Math.min(cursorBoundaryOverlap(pages[index - 1], pages[index]), removals);
    reconciled.push(...pages[index].slice(overlap));
    removals -= overlap;
  }
  if (removals || reconciled.length !== expectedTotal) throw new Error("cursor usage pagination was inconsistent");
  return reconciled;
}

export interface CursorQuotaInput {
  requestUsage?: unknown;
  /** 原版收下但不用 sandUsage 参与 Cursor 额度计算（它只喂 grok bot 那条路） */
  sandUsage?: unknown;
  userInfo?: unknown;
  identity?: unknown;
  updated?: number | null;
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** 对应 _normalize_cursor_quota */
export function normalizeCursorQuota(summary: unknown, input: CursorQuotaInput = {}): Record<string, any> {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return {};
  const data = summary as Record<string, any>;
  const individual = asObject(data.individualUsage);
  const team = asObject(data.teamUsage);
  const plan = asObject(individual.plan);
  const overall = asObject(individual.overall);
  const pooled = asObject(team.pooled);

  let planUsed = providerNumber(plan.used) ?? 0;
  let planLimit = providerNumber(plan.limit) ?? 0;
  const autoPct = providerPercent(plan.autoPercentUsed);
  const apiPct = providerPercent(plan.apiPercentUsed);
  let totalPct = providerPercent(plan.totalPercentUsed);
  if (totalPct === null && autoPct !== null && apiPct !== null) totalPct = providerPercent((autoPct + apiPct) / 2);
  if (totalPct === null) totalPct = apiPct !== null ? apiPct : autoPct;
  if (totalPct === null && planLimit > 0) totalPct = providerPercent((planUsed / planLimit) * 100);
  if (totalPct === null) {
    // plan 里啥百分比都没有时，退回个人/团队资金池的 used+limit，并把口径整体换成这一对数
    for (const block of [overall, pooled]) {
      const used = providerNumber(block.used);
      const limit = providerNumber(block.limit);
      if (used !== null && limit !== null && limit > 0) {
        totalPct = providerPercent((used / limit) * 100);
        planUsed = used;
        planLimit = limit;
        break;
      }
    }
  }
  totalPct = totalPct ?? 0;

  const requestBlock = asObject(asObject(input.requestUsage)["gpt-4"]);
  const requestsUsed = providerNumber(
    requestBlock.numRequestsTotal !== undefined && requestBlock.numRequestsTotal !== null
      ? requestBlock.numRequestsTotal : requestBlock.numRequests);
  const requestsLimit = providerNumber(requestBlock.maxRequestUsage);
  const legacy = requestsUsed !== null && requestsLimit !== null && requestsLimit > 0;

  const cycleStart = providerEpoch(data.billingCycleStart);
  const cycleEnd = providerEpoch(data.billingCycleEnd);
  const windowMinutes = cycleStart && cycleEnd && cycleEnd > cycleStart
    ? Math.trunc((cycleEnd - cycleStart) / 60) : null;
  let spendDetail: string | null = null;
  const windows: ReturnType<typeof providerWindow>[] = [];
  if (legacy) {
    // 老式「按请求数」套餐：百分比直接由请求数算，金额口径全部让位
    totalPct = providerPercent((requestsUsed! / requestsLimit!) * 100) ?? 0;
    windows.push(providerWindow(
      "cursor-total", "总额度", totalPct, cycleEnd, windowMinutes,
      `${Math.trunc(requestsUsed!)} / ${Math.trunc(requestsLimit!)} requests`));
  } else {
    // $70 是 Other Models 池。plan.used 经常是套餐面额，跟总百分比对不上时按 apiPercentUsed 折算。
    let spend = planUsed;
    if (planLimit > 0 && Math.abs((planUsed / planLimit) * 100 - totalPct) > 5) {
      const spendPct = apiPct !== null ? apiPct : totalPct;
      spend = (planLimit * spendPct) / 100;
    }
    spendDetail = planLimit > 0
      ? `${providerMoney(spend / 100)} / ${providerMoney(planLimit / 100)}` : null;
    if (autoPct !== null) windows.push(providerWindow("cursor-auto", "Cursor 模型", autoPct, cycleEnd, windowMinutes));
    if (apiPct !== null) windows.push(providerWindow("cursor-api", "第三方模型", apiPct, cycleEnd, windowMinutes));
  }

  const details: Array<Record<string, string>> = [];
  if (planLimit > 0 && !legacy) {
    details.push({
      label: "套餐用量",
      value: spendDetail ?? `${providerMoney(planUsed / 100)} / ${providerMoney(planLimit / 100)}`,
    });
  }
  const onDemand = asObject(individual.onDemand);
  const teamOnDemand = asObject(team.onDemand);
  let onUsed = providerNumber(onDemand.used) ?? 0;
  let onLimit = providerNumber(onDemand.limit);
  if (!onLimit || onLimit <= 0) {
    const teamLimit = providerNumber(teamOnDemand.limit);
    if (teamLimit && teamLimit > 0) {
      onUsed = providerNumber(teamOnDemand.used) ?? 0;
      onLimit = teamLimit;
    }
  }
  if (onLimit && onLimit > 0) {
    details.push({
      label: "按量预算",
      value: `${providerMoney(onUsed / 100)} / ${providerMoney(onLimit / 100)}`,
    });
  }

  const userInfo = asObject(input.userInfo);
  const identity = asObject(input.identity);
  return {
    available: true,
    plan: cursorPlanName(data.membershipType),
    account: userInfo.email || identity.account || null,
    windows,
    details,
    source: "cursor-api",
    // 原版是 int(updated or now)，数字串也要能吃：providerNumber 负责这一步
    updated: Math.trunc(providerNumber(input.updated) ?? epochSeconds()),
    stale: false,
  };
}

/**
 * 对应 _normalize_grok_bot_quota：sand usage 是 Cursor 后端代理 Grok Build 的额度接口。
 * usagePercent 缺失、或 hasNonZeroIncludedLimit 明确为 false（免费池没额度）都算没有额度。
 * 原版的 user_info / identity 参数不参与计算（account 恒 null），照留签名以免调用点写歪。
 */
export function normalizeGrokBotQuota(
  sandUsage: unknown,
  input: { userInfo?: unknown; identity?: unknown; updated?: number | null; source?: string } = {},
): Record<string, any> {
  if (!sandUsage || typeof sandUsage !== "object" || Array.isArray(sandUsage)) return {};
  const data = sandUsage as Record<string, any>;
  const usedPct = providerPercent(data.usagePercent);
  if (usedPct === null || data.hasNonZeroIncludedLimit === false) return {};
  const periodStart = providerEpoch(data.currentPeriodStart);
  const reset = providerEpoch(data.nextResetTimestampUtc);
  const windowMinutes = periodStart && reset && reset > periodStart
    ? Math.trunc((reset - periodStart) / 60) : null;
  const plan = trimmedString(data.grokPlanLabel ?? data.planLabel ?? data.plan);
  return {
    available: true,
    plan,
    account: null,
    windows: [providerWindow("grok-bot-period", "本周期额度", usedPct, reset, windowMinutes)],
    details: [],
    source: input.source ?? "cursor-sand-api",
    updated: Math.trunc(providerNumber(input.updated) ?? epochSeconds()),
    stale: false,
  };
}

/**
 * 对应 _grok_bot_quota_from_cursor：cursor 额度里若带了 cursor-grok-bot 窗口（Grok Build 走
 * Cursor 后端的那条形态），就把它改头换面成 grok bot 自己的周期窗口。没有就返回 {}。
 * detail（原样是套餐名）转成 plan，其余字段（used_pct / reset / window_minutes…）整份搬过去。
 */
export function grokBotQuotaFromCursor(cursorQuota: unknown): Record<string, any> {
  if (!cursorQuota || typeof cursorQuota !== "object" || Array.isArray(cursorQuota)) return {};
  const data = cursorQuota as Record<string, any>;
  const windows = Array.isArray(data.windows) ? data.windows : [];
  const source = windows.find((window) => window && typeof window === "object"
    && !Array.isArray(window) && (window as Record<string, any>).id === "cursor-grok-bot");
  if (!source) return {};
  const { detail, ...rest } = source as Record<string, any>;
  return {
    available: true,
    plan: detail ?? null,
    account: null,
    windows: [{ ...rest, id: "grok-bot-period", title: "本周期额度" }],
    details: [],
    source: "cursor-sand-api",
    updated: data.updated ?? null,
    stale: Boolean(data.stale),
  };
}

// ---- Grok Bot 本机侧helper（Python 6319-6598，仍属 cursor 这段区间）----

/**
 * 对应 GROK_BOT_SECRET_PATHS：TOKEI_GROK_BOT_SECRETS 优先，其次三个系统位置。
 * Windows 走 %APPDATA%/%LOCALAPPDATA%\Grok Bot\sand-secrets.json，macOS 的两条留着做兼容。
 */
export function grokBotSecretPaths(): string[] {
  return pathCandidates(
    "TOKEI_GROK_BOT_SECRETS",
    path.join(HOME, "Library", "Application Support", "Grok Bot", "sand-secrets.json"),
    path.join(APPDATA, "Grok Bot", "sand-secrets.json"),
    path.join(LOCALAPPDATA, "Grok Bot", "sand-secrets.json"),
    path.join(HOME, ".config", "Grok Bot", "sand-secrets.json"),
  );
}

/** 对应 GROK_BOT_AUTH_MARKER：本机 Keychain 授权标记文件，默认 ~/.tokei/grok_bot_keychain_authorized */
export function grokBotAuthMarker(): string | null {
  return expandPath(process.env.TOKEI_GROK_BOT_AUTH_MARKER
    ?? path.join(TOKEI_DIR, "grok_bot_keychain_authorized"));
}

/**
 * 对应 _grok_bot_active_account_id：sand-secrets.json 里 cursor-accounts 是一段被字符串化的 JSON，
 * 先读外层拿到字符串、再二次 JSON.parse 拿 container，active 必须是 64 位十六进制且落在 accounts 里。
 * 双层大小都限制在 2MiB 内，防越界读取。任何异常都吞掉返回 null。
 */
export function grokBotActiveAccountId(file?: string | null): string | null {
  const secretsPath = file ?? firstExistingFile(grokBotSecretPaths());
  if (!secretsPath || !isFile(secretsPath)) return null;
  let container: unknown;
  try {
    if (fs.statSync(secretsPath).size > PROVIDER_QUOTA_MAX_RESPONSE_BYTES) return null;
    const outer = asObject(loadJson<unknown>(secretsPath, {}));
    const encoded = outer["cursor-accounts"];
    if (typeof encoded !== "string" || encoded.length > PROVIDER_QUOTA_MAX_RESPONSE_BYTES) return null;
    container = JSON.parse(encoded);
  } catch {
    return null;
  }
  const parsed = asObject(container);
  const active = parsed.active;
  if (typeof active !== "string" || !/^[0-9a-f]{64}$/.test(active)) return null;
  const accounts = parsed.accounts;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return null;
  const entry = (accounts as Record<string, any>)[active];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? active : null;
}

/**
 * 对应 _grok_bot_authorization_generation：用标记文件的 mtime_ns 当「授权代次」。
 * 文件被重新授权就会刷新 mtime，旧的 grok_bot 缓存 marker 于是失效。lstat（不跟随符号链接）
 * 与原版 follow_symlinks=False 对齐；JS 用 mtimeMs*1e6 近似的 mtimeNs 当不透明串即可。
 */
export function grokBotAuthorizationGeneration(file?: string | null): string | null {
  const marker = file ?? grokBotAuthMarker();
  if (!marker) return null;
  try {
    const stat = fs.lstatSync(marker);
    return stat.isFile() ? String(stat.mtimeMs * 1000) : null;
  } catch {
    return null;
  }
}

/**
 * 对应 _grok_bot_helper_path：只有 TOKEI_GROK_BOT_HELPER 指向的可执行文件才用。
 * Windows 上没有 macOS 那个 Tokei.app，darwin 分支直接跳过；没配环境变量就返回 null，
 * 于是 grok bot 走「复用 cursor 会话」这条回退路（fetch_grok_bot_quota 后半段）。
 */
export function grokBotHelperPath(): string | null {
  const configured = process.env.TOKEI_GROK_BOT_HELPER;
  const candidates = typeof configured === "string" && configured.trim() ? [configured] : [];
  for (const item of candidates) {
    const expanded = expandPath(item);
    if (!expanded) continue;
    try {
      fs.accessSync(expanded, fs.constants.X_OK);
      if (fs.statSync(expanded).isFile()) return expanded;
    } catch {
      /* 不可执行或不存在，跳过 */
    }
  }
  return null;
}

/** 对应 _grok_bot_helper_sand_usage：把 helper 的 --grok-bot-data-json 标准输出读成 JSON dict */
export function grokBotHelperSandUsage(): Record<string, any> | null {
  const helper = grokBotHelperPath();
  if (!helper) return null;
  let result: { status: number | null; stdout: Buffer };
  try {
    result = spawnSync(helper, ["--grok-bot-data-json"], { timeout: 35_000, windowsHide: true });
  } catch {
    return null;
  }
  if (result.status !== 0 || !result.stdout || result.stdout.length > 16 * 1024 * 1024) return null;
  try {
    const payload = JSON.parse(result.stdout.toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** 对应 _grok_bot_repair_authorization_marker：helper --grok-bot-verify 成功且标记回来了才算修好 */
export function grokBotRepairAuthorizationMarker(): boolean {
  const helper = grokBotHelperPath();
  if (!helper) return false;
  try {
    const result = spawnSync(helper, ["--grok-bot-verify"], { timeout: 5_000, windowsHide: true });
    return result.status === 0 && grokBotAuthorizationGeneration() !== null;
  } catch {
    return false;
  }
}

/**
 * 对应 _grok_bot_usage_from_bridge：桥接负载里 usageFetched 必须是布尔 true，
 * 事件按稳定序列化去重后交给 cursor 的按天聚合，再把 all 区间标注成「本年」覆盖。
 */
export function grokBotUsageFromBridge(payload: unknown): ProviderUsage | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const data = payload as Record<string, any>;
  if (data.usageFetched !== true) return null;
  const events = data.usageEventsDisplay;
  if (!Array.isArray(events)) return null;
  const unique: any[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    let key: string;
    try {
      key = stableEventKey(event);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  const usage = normalizeCursorUsageEvents(unique);
  // 桥接只给到本年数据，长跨度区间要显式打「本年」覆盖标记，免得 UI 把它当全量
  if (usage.ranges.all) usage.ranges.all.coverage = "本年";
  return usage;
}

/** 对应 _grok_bot_provider_data：桥接负载同时带额度(sandUsage)与用量(usageEvents)两半 */
export function grokBotProviderData(payload: unknown, options: { updated?: number | null } = {}): Record<string, any> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const data = payload as Record<string, any>;
  const isBridge = "quotaFetched" in data || "usageFetched" in data;
  const sandUsage = isBridge ? data.sandUsage : payload;
  const quota = normalizeGrokBotQuota(sandUsage, {
    updated: options.updated ?? null, source: "grok-bot-api",
  });
  const usage = isBridge ? grokBotUsageFromBridge(payload) : null;
  const ranges = usage && typeof usage === "object" ? usage.ranges : null;
  const hasUsage = Boolean(ranges && Object.values(ranges as Record<string, any>).some(
    (row) => row && typeof row === "object" && !Array.isArray(row)
      && (providerUsageInt(row.tokens) > 0 || providerUsageInt(row.requests) > 0)));
  if (hasUsage) {
    if (!Object.keys(quota).length) {
      // 没额度但有用量：拼一个 available=false 的空壳把 usage 挂上去，卡面还能显示用量
      Object.assign(quota, {
        available: false,
        plan: null,
        account: null,
        windows: [],
        details: [],
        source: "grok-bot-api",
        updated: Math.trunc(providerNumber(options.updated) ?? epochSeconds()),
        stale: false,
      });
    }
    quota.usage = usage;
  }
  return quota;
}

export interface CursorQuotaOptions {
  session?: CursorSession | null;
  /** 对应 force=True：grok bot 复用 cursor 会话时要跳过 cursor 自己的 5 分钟缓存 */
  force?: boolean;
}

/** 对应 fetch_cursor_quota */
export async function fetchCursorQuota(
  deps: QuotaDeps, options: CursorQuotaOptions = {},
): Promise<Record<string, any>> {
  const session = options.session ?? cursorSession(deps);
  if (!session) return {};
  const marker = providerCredentialMarker("cursor-usage-v1", session.marker);
  const now = Math.trunc(deps.now());
  if (!options.force) {
    const cached = cachedProviderQuota("cursor", marker, PROVIDER_QUOTA_TTL, now);
    if (cached) return cached;
  }
  const headers = { Cookie: session.cookie };
  const base = "https://cursor.com";
  try {
    const summary = await deps.request(`${base}/api/usage-summary`, { headers });
    let userInfo: any = null;
    try {
      userInfo = await deps.request(`${base}/api/auth/me`, { headers });
    } catch {
      /* 身份接口挂了不影响额度，只是少一行账号显示 */
    }
    let requestUsage: any = null;
    let userId = typeof userInfo?.sub === "string" ? userInfo.sub : undefined;
    userId = userId || session.subject || session.user_id || undefined;
    if (typeof userId === "string" && userId) {
      const tail = userId.split("|").pop() ?? "";
      try {
        requestUsage = await deps.request(`${base}/api/usage?user=${queryEscape(tail)}`, { headers });
      } catch {
        /* 老式「按请求数」口径拿不到就走金额口径 */
      }
    }
    let sandUsage: any = null;
    try {
      sandUsage = await deps.request(`${base}/api/dashboard/get-sand-usage-status`, {
        headers: { ...headers, Origin: base }, method: "POST", body: {},
      });
    } catch {
      /* Grok Build 代理额度可有可无 */
    }
    // 原版用 datetime.now() 定「今年 1 月 1 日」与 updated；这里统一走 deps.now()，
    // 单测才能把时钟钉死，真实运行两者只差一次取整。
    const bounds = rangeBounds(new Date(now * 1000));
    let usage = providerUsageFromDays({}, { bounds });
    try {
      usage = normalizeCursorUsageEvents(await fetchCursorUsageEvents(deps, session, now), { bounds });
    } catch {
      /* 明细拉不全就只报额度，用量区间留空而不是整张卡消失 */
    }
    const quota = normalizeCursorQuota(summary, {
      requestUsage, sandUsage, userInfo, identity: session, updated: now,
    });
    quota.usage = usage;
    saveProviderQuotaCache("cursor", marker, quota, deps.now());
    const grokBotQuota = normalizeGrokBotQuota(sandUsage, { userInfo, identity: session, updated: now });
    if (Object.keys(grokBotQuota).length) {
      saveProviderQuotaCache("grok_bot", marker, grokBotQuota, deps.now());
    }
    return quota;
  } catch (error) {
    const fallback = cachedProviderQuota("cursor", marker, PROVIDER_QUOTA_FALLBACK_TTL, now, true);
    if (fallback) return fallback;
    throw error;
  }
}

/** 对应 urllib.parse.quote(user_id, safe="")：把 encodeURIComponent 放过的 !'()* 也转义掉 */
function queryEscape(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 对应 scan_cursor_quota */
export async function scanCursorQuota(deps: QuotaDeps): Promise<Record<string, any>> {
  if (!providerQuotaEnabled("cursor", deps)) return {};
  return fetchCursorQuota(deps);
}

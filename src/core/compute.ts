/**
 * compute()：装配输出 payload。对应 usage.30s.py 的 compute() + _recalc_costs +
 * main_json()。输出键位与 macOS 版 Model.swift 的 Usage 解码结构一致 —— 缺键会让
 * Swift 侧整份解码失败，所以即使某工具本机没有数据，也必须给出结构完整的空值。
 */
import { Bounds, RangeKey, RANGE_KEYS, rangeBounds } from "./ranges";
import {
  ClaudeRangeOut, GeminiRangeOut, HermesRangeOut, TokenUsageRangeOut, claudeRange,
  emptyBucket, recalcCosts, tokenUsageRange,
} from "./model";
import { scanClaude, ClaudeScanResult } from "../collectors/claude";
import { scanClaudePlan, ClaudeQuota } from "../collectors/claude.quota";
import { scanCodex, CodexLiveResult } from "../collectors/codex";
import { scanGemini } from "../collectors/gemini";
import { scanQoderCli, scanQoderCliCn } from "../collectors/qodercli";
import { scanQoderDesktop } from "../collectors/qoderdesktop";
import { scanQoderWork } from "../collectors/qoderwork";
import { scanPi } from "../collectors/pi";
import { scanPrimeAgent } from "../collectors/prime_agent";
import { scanMusecode } from "../collectors/musecode";
import { scanCmdcode } from "../collectors/cmdcode";
import { scanWorkbuddy, scanWorkbuddyAi } from "../collectors/workbuddy";
import { scanCodebuddy } from "../collectors/codebuddy";
import { scanZcode } from "../collectors/zcode";
import { scanHermes } from "../collectors/hermes";
import { scanOpencode } from "../collectors/opencode";
import { scanMimoCode } from "../collectors/mimocode";
import { scanOpenClaw } from "../collectors/openclaw";
import { scanGrok } from "../collectors/grok";
import { scanGrokBot } from "../collectors/grok_bot";
import { scanQwenCode } from "../collectors/qwencode";
import { scanDevin } from "../collectors/devin";
import { scanMinimax } from "../collectors/minimax";
import { scanKimiCode } from "../collectors/kimicode";
import { emptyQwenworkPayload, QwenworkQuotaPayload, scanQwenwork } from "../collectors/qwenwork";
import { scanDeepSeekHarness } from "../collectors/deepseek_harness";
import { ledgerFlush } from "./ledger";
import { providerUsageFromDays } from "./providerQuota";
import {
  CURSOR_PROVIDER_DAYS_CACHE_KEY, GEMINI_DAYS_CACHE_KEY, GROK_BOT_PROVIDER_DAYS_CACHE_KEY,
  GROK_DAYS_CACHE_KEY, ZAI_PROVIDER_DAYS_CACHE_KEY,
  cacheDashboardDays, mergeDashboardDays, priceGeminiDays,
} from "./dashboard";

export const TOOL_IDS = [
  "claude", "codex", "gemini", "grok", "grok_bot", "qoderwork", "qoder", "qodercli", "qodercli_cn",
  "hermes", "zcode", "mimocode", "openclaw", "pi", "prime_agent", "workbuddy", "workbuddy_ai",
  "codebuddy", "deepseek_harness", "opencode", "qwencode", "qwenwork", "kimicode", "musecode",
  "cmdcode", "devin", "minimax", "antigravity", "cursor", "zed", "sub2api", "zai",
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/** Swift 侧必需字段：缺一个就整份解码失败 */
export const REQUIRED_TOOLS: ToolId[] = ["claude", "codex", "gemini", "grok", "hermes", "openclaw", "opencode"];

export interface ScanContext {
  bounds: Bounds;
  cache: Record<string, any>;
  errors: Record<string, string>;
}

/** 对应 _safe_scan()：单个工具异常不影响整体 */
function safeScan<T>(name: string, fn: () => T, fallback: () => T, errors: Record<string, string>): T {
  try {
    return fn();
  } catch (e: any) {
    errors[name] = `${e?.name ?? "Error"}: ${e?.message ?? e}`;
    return fallback();
  }
}

function mapRanges<T>(make: (k: RangeKey) => T): Record<RangeKey, T> {
  return Object.fromEntries(RANGE_KEYS.map((k) => [k, make(k)])) as Record<RangeKey, T>;
}

function emptyTokenRanges(): Record<RangeKey, TokenUsageRangeOut> {
  return mapRanges(() => tokenUsageRange(emptyBucket()));
}

function emptyClaudeRanges(): Record<RangeKey, ClaudeRangeOut> {
  return mapRanges(() => claudeRange({
    in: 0, out: 0, cr: 0, cw: 0, cost: 0, models: {}, sessions: new Set<string>(),
  }));
}

function emptyGeminiRanges(): Record<RangeKey, GeminiRangeOut> {
  return mapRanges(() => ({
    hit: 0, in: 0, out: 0, cached: 0, thoughts: 0, cost: 0, sessions: 0, models: [],
  }));
}

function emptyHermesRanges(): Record<RangeKey, HermesRangeOut> {
  return mapRanges(() => tokenUsageRange(emptyBucket()));
}

/** Codex 区间在采集器里已序列化，空值只需补齐字段 */
function emptyCodexRanges(): Record<RangeKey, any> {
  return mapRanges(() => ({
    hit: 0, in: 0, cached: 0, out: 0, reason: 0, cost: 0, sessions: 0, models: [],
  }));
}

function emptyGrokRanges(): Record<RangeKey, any> {
  return mapRanges(() => ({
    tokens: 0, hit: 0, in: 0, out: 0, cr: 0, reason: 0, cost: 0, models: [],
    usage_available: false, usage_calls: 0, usage_sessions: 0, sessions: 0,
    turns: 0, tools: 0, duration: 0, ctx_used: 0, ctx_window: 0, ctx: 0,
    errors: 0, cancellations: 0, ttft: 0, response: 0,
  }));
}

function emptyQoderRanges(): Record<RangeKey, any> {
  return mapRanges(() => ({
    in: 0, out: 0, sessions: 0, calls: 0, sub_agents: 0, turns: 0, duration: 0, ctx: 0,
  }));
}

function emptyGrokBotRanges(): Record<RangeKey, any> {
  return mapRanges(() => ({
    in: 0, out: 0, sessions: 0, calls: 0, turns: 0, tools: 0, duration: 0,
  }));
}

function emptyQoderCliRanges(): Record<RangeKey, any> {
  return mapRanges(() => ({
    in: 0, out: 0, sessions: 0, calls: 0, sub_agents: 0, turns: 0, duration: 0, ctx: 0,
    cr: 0, cw: 0, credits: 0, usage_calls: 0, usage_available: false, hit: 0, models: [], tools: 0, est: 0,
  }));
}

function emptyClaude(): ClaudeScanResult {
  return {
    ranges: emptyClaudeRanges(), session_name: "-", session_total: 0,
    days: {}, hours: new Array(24).fill(0), projects: {},
  };
}

/** 对应 _kimi_quota_values + payload 的 kimi 段（13437-13439、13572-13578） */
export interface KimiLiveQuota {
  p5: number | null;
  pw: number | null;
  r5: number | null;
  rw: number | null;
  q_updated: number | null;
  p5_stale: boolean | null;
  pw_stale: boolean | null;
  plan: string | null;
}

/**
 * 主进程每轮联网取回的额度读数。core 不能反向 import main，所以这里只声明形状，
 * 由 src/main/quota/index.ts 的 collectQuotas() 产出同款对象再传进来。
 */
export interface LiveQuotas {
  /** scan_provider_quotas() 的 8 个键 */
  providerQuotas?: Record<string, Record<string, any>>;
  /** fetch_codex_live_limits() 的三元组，覆盖日志里的额度读数 */
  codexLive?: CodexLiveResult;
  /** fetch_codex_reset_cards() 的续卡列表 */
  codexResetCards?: Record<string, any> | null;
  /** scan_grok_quota() 的实时/日志合成读数 */
  grokQuota?: Record<string, any> | null;
  /** scan_qwenwork_quota() 的本机 MCP 读数；不给就只吃缓存 */
  qwenwork?: QwenworkQuotaPayload | null;
  kimi?: KimiLiveQuota | null;
}

export function compute(cache: Record<string, any> = {}, now = new Date(), live: LiveQuotas = {}):
  { payload: Record<string, any>; bounds: Bounds; errors: Record<string, string> } {
  const bounds = rangeBounds(now);
  const errors: Record<string, string> = {};
  const ctx: ScanContext = { bounds, cache, errors };
  const scan = <T>(id: string, fn: () => T, fallback: () => T) => safeScan(id, fn, fallback, errors);
  // 联网额度读数的落点：provider 那 8 路 + codex live。没有传进来就按「本轮没联网」处理，
  // 键位仍然齐全（空对象），面板显示为无数据而不是缺字段。
  // 浅拷贝一份：grok bot 的日账兜底要往这张表里写重建后的用量，别改调用方传进来的对象。
  const providerQuotas: Record<string, Record<string, any>> = { ...(live.providerQuotas ?? {}) };
  const providerQuota = (name: string): Record<string, any> => providerQuotas[name] ?? {};

  const claude = scan("claude", () => scanClaude(bounds, cache), emptyClaude);
  // 对应 _safe_scan("claude_plan", scan_claude_plan)：读 Claude Desktop 落下的 /usage 缓存
  const plan = scan("claude_plan", () => scanClaudePlan(Math.floor(now.getTime() / 1000)), () => ({}) as ClaudeQuota);
  const codex = scan("codex", () => scanCodex(bounds, cache, live.codexLive ?? null), () => ({
    ranges: emptyCodexRanges(), reserve_ranges: emptyCodexRanges(), reserve_quota: null,
    plan: null, p5: null, pw: null, r5: null, rw: null, limits_updated: null, q_updated: null,
    p5_stale: null, pw_stale: null,
  } as any));
  const gemini = scan("gemini", () => scanGemini(bounds, cache), () => ({ ranges: emptyGeminiRanges(), days: {} }));
  const qoderWork = scan("qoderwork", () => scanQoderWork(bounds, cache), () => ({ ranges: emptyQoderRanges(), model: null, quota: null, days: {} }));
  const qoderIde = scan("qoder_ide", () => scanQoderDesktop(bounds, cache), () => ({ ranges: emptyQoderRanges(), model: null, days: {} }));
  const qoderCli = scan("qodercli", () => scanQoderCli(bounds, cache, "qodercli"), () => ({ ranges: emptyQoderCliRanges(), model: null, days: {}, projects: {} }));
  const qoderCliCn = scan("qodercli_cn", () => scanQoderCliCn(bounds, cache), () => ({ ranges: emptyQoderCliRanges(), model: null, days: {}, projects: {} }));
  const hermes = scan("hermes", () => scanHermes(bounds, cache), () => ({ ranges: emptyHermesRanges() }));
  const zcode = scan("zcode", () => scanZcode(bounds, cache), () => ({ ranges: emptyTokenRanges() }));
  const mimocode = scan("mimocode", () => scanMimoCode(bounds, cache), () => ({ ranges: emptyTokenRanges() }));
  const openclaw = scan("openclaw", () => scanOpenClaw(bounds, cache), () => ({ ranges: mapRanges<any>(() => ({
    tasks: 0, completed: 0, failed: 0, ...tokenUsageRange(emptyBucket()),
  })) }));
  const pi = scan("pi", () => scanPi(bounds, cache), () => ({ ranges: emptyTokenRanges(), model: null, days: {}, projects: {} }));
  const prime = scan("prime_agent", () => scanPrimeAgent(bounds, cache), () => ({ ranges: emptyTokenRanges(), model: null, days: {}, projects: {} }));
  const workbuddy = scan("workbuddy", () => scanWorkbuddy(bounds, cache), () => ({ ranges: emptyTokenRanges(), model: null, days: {}, projects: {} }));
  const workbuddyAi = scan("workbuddy_ai", () => scanWorkbuddyAi(bounds, cache), () => ({ ranges: emptyTokenRanges(), model: null, days: {}, projects: {} }));
  const codebuddy = scan("codebuddy", () => scanCodebuddy(bounds, cache), () => ({ ranges: emptyTokenRanges(), model: null, days: {}, projects: {} }));
  const opencode = scan("opencode", () => scanOpencode(bounds, cache), () => ({ ranges: emptyTokenRanges() }));
  const musecode = scan("musecode", () => scanMusecode(bounds, cache), () => ({ ranges: emptyTokenRanges(), model: null, days: {}, projects: {} }));
  const cmdcode = scan("cmdcode", () => scanCmdcode(bounds, cache), () => ({ ranges: emptyTokenRanges(), model: null, days: {}, projects: {} }));
  const grok = scan("grok", () => scanGrok(bounds, cache), () => ({
    ranges: emptyGrokRanges(), model: null, pct: null, reset: null, plan: null, products: [],
    window: null, source: null, q_updated: null, stale: null, auth_expired: false, days: {},
  }));
  const grokBot = scan("grok_bot", () => scanGrokBot(bounds, cache), () => ({ ranges: emptyGrokBotRanges(), quota: null }));
  const qwencode = scan("qwencode", () => scanQwenCode(bounds, cache), () => ({ ranges: emptyTokenRanges(), model: null, days: {}, hours: new Array(24).fill(0) }));
  const devin = scan("devin", () => scanDevin(bounds, cache), () => ({ ranges: emptyTokenRanges() }));
  const minimax = scan("minimax", () => scanMinimax(bounds, cache), () => ({ ranges: emptyTokenRanges() }));
  const kimicode = scan("kimicode", () => scanKimiCode(bounds, cache), () => ({
    ranges: emptyTokenRanges(), p5: null, pw: null, r5: null, rw: null,
    q_updated: null, p5_stale: null, pw_stale: null, plan: null, days: {},
  }));
  // 千问办公：实时那一路由主进程发本机 MCP 请求（对应 scan_qwenwork_quota），
  // 没传进来就只吃它落下的缓存（CLI 与单测走这条）
  const qwenwork = live.qwenwork ?? scan("qwenwork_quota", () => scanQwenwork(), emptyQwenworkPayload);
  const deepseekHarness = scan("deepseek_harness",
    () => scanDeepSeekHarness(bounds, cache), () => ({ ranges: emptyTokenRanges() }));

  // Dashboard 的逐日明细留在扫描缓存里复用（对应 13254-13255）。
  // gemini 的日账在这里补成本：采集器把成本留给 recalcCosts，而 Dashboard 直接读日账。
  cacheDashboardDays(cache, GEMINI_DAYS_CACHE_KEY, priceGeminiDays(gemini.days ?? {}));
  cacheDashboardDays(cache, GROK_DAYS_CACHE_KEY, grok.days ?? {});
  // 账号级用量日账（对应 13441-13449）：cursor / zai 每轮覆盖，grok bot 用合并版，
  // 断网那一轮也能留住历史天；再由日账重建 grok bot 的区间用量（13450-13460），
  // 让面板的账号级模型在额度取数失败时仍有数据。
  const providerDays = (name: string): Record<string, any> => {
    const usage = providerQuota(name).usage;
    return usage && typeof usage === "object" && !Array.isArray(usage)
      ? (usage as Record<string, any>).days ?? {} : {};
  };
  cacheDashboardDays(cache, CURSOR_PROVIDER_DAYS_CACHE_KEY, providerDays("cursor"));
  cacheDashboardDays(cache, ZAI_PROVIDER_DAYS_CACHE_KEY, providerDays("zai"));
  mergeDashboardDays(cache, GROK_BOT_PROVIDER_DAYS_CACHE_KEY, providerDays("grok_bot"));
  const grokBotDays = cache[GROK_BOT_PROVIDER_DAYS_CACHE_KEY];
  if (grokBotDays && typeof grokBotDays === "object" && !Array.isArray(grokBotDays)
    && Object.keys(grokBotDays).length) {
    const grokBotQuota: Record<string, any> = { ...providerQuota("grok_bot") };
    if (!Object.keys(grokBotQuota).length) {
      Object.assign(grokBotQuota, {
        available: false, plan: null, account: null,
        windows: [], details: [], source: "cache",
        updated: null, stale: true,
      });
    }
    grokBotQuota.usage = providerUsageFromDays(grokBotDays);
    providerQuotas.grok_bot = grokBotQuota;
  }

  // 所有扫描器都跑完后统一落盘账本（对应 scan_* 之后的 ledger_flush()）：
  // 落盘前会在锁内重读磁盘再合并，多个进程并发也不会互相盖掉高水位
  ledgerFlush();

  // provider 额度（scan_provider_quotas）与实时读数都来自 live 参数：
  // 联网只发生在主进程，装配 payload 这一层不再发请求
  const grokQuota = live.grokQuota ?? null;
  const grokReadings = grokQuota ?? {
    pct: grok.pct, reset: grok.reset, plan: grok.plan, products: grok.products,
    window: grok.window, updated: grok.q_updated, stale: grok.stale,
    auth_expired: grok.auth_expired,
  };
  const kimiQuota = live.kimi ?? null;
  const kimiReadings = kimiQuota ?? {
    p5: kimicode.p5, pw: kimicode.pw, r5: kimicode.r5, rw: kimicode.rw,
    q_updated: kimicode.q_updated, p5_stale: kimicode.p5_stale, pw_stale: kimicode.pw_stale,
    plan: kimicode.plan,
  };
  const resetCards = live.codexResetCards;
  const result: Record<string, any> = {
    claude: {
      ranges: claude.ranges,
      session_name: claude.session_name,
      session_total: claude.session_total,
      // 套餐额度来自 Claude Desktop 的本地缓存，见 collectors/claude.quota.ts
      q5: plan.q5 ?? null, q5_reset: plan.q5_reset ?? null,
      q7: plan.q7 ?? null, q7_reset: plan.q7_reset ?? null,
      qf: plan.qf ?? null, qf_reset: plan.qf_reset ?? null,
      q_updated: plan.q_updated ?? null,
      q5_stale: plan.q5_stale ?? null, q7_stale: plan.q7_stale ?? null, qf_stale: plan.qf_stale ?? null,
    },
    codex: {
      ranges: codex.ranges,
      reserve_ranges: codex.reserve_ranges,
      reserve_quota: codex.reserve_quota ?? null,
      p5: codex.p5 ?? null, pw: codex.pw ?? null,
      r5: codex.r5 ?? null, rw: codex.rw ?? null,
      q_updated: codex.limits_updated ?? codex.q_updated ?? null,
      p5_stale: codex.p5_stale ?? null, pw_stale: codex.pw_stale ?? null,
      plan: codex.plan ?? null,
      // 对应 payload 的 reset_cards（13484）：一张卡都没有就当没有
      reset_cards: resetCards && Number(resetCards.count) > 0 ? resetCards : null,
    },
    gemini: { ranges: gemini.ranges },
    antigravity: providerQuota("antigravity"),
    devin: { ranges: devin.ranges, quota: providerQuota("devin") },
    minimax: { ranges: minimax.ranges, quota: providerQuota("minimax") },
    cursor: providerQuota("cursor"),
    zed: providerQuota("zed"),
    sub2api: providerQuota("sub2api"),
    zai: providerQuota("zai"),
    grok: {
      ranges: grok.ranges, model: grok.model,
      pct: grokReadings.pct ?? null, reset: grokReadings.reset ?? null,
      plan: grokReadings.plan ?? null, products: grokReadings.products ?? [],
      window: grokReadings.window ?? null, source: grokReadings.source ?? null,
      q_updated: grokReadings.updated ?? null, stale: grokReadings.stale ?? null,
      auth_expired: Boolean(grokReadings.auth_expired),
    },
    grok_bot: { ranges: grokBot.ranges, quota: providerQuota("grok_bot") },
    qwenwork,
    qoderwork: { ranges: qoderWork.ranges, model: qoderWork.model ?? null },
    qoder: { ranges: qoderIde.ranges, model: qoderIde.model ?? null },
    qodercli: { ranges: qoderCli.ranges, model: qoderCli.model ?? null },
    qodercli_cn: { ranges: qoderCliCn.ranges, model: qoderCliCn.model ?? null },
    hermes: { ranges: hermes.ranges },
    zcode: { ranges: zcode.ranges },
    mimocode: { ranges: mimocode.ranges },
    openclaw: { ranges: openclaw.ranges },
    pi: { ranges: pi.ranges },
    prime_agent: { ranges: prime.ranges },
    workbuddy: { ranges: workbuddy.ranges },
    workbuddy_ai: { ranges: workbuddyAi.ranges },
    codebuddy: { ranges: codebuddy.ranges },
    deepseek_harness: { ranges: deepseekHarness.ranges },
    opencode: { ranges: opencode.ranges },
    qwencode: { ranges: qwencode.ranges },
    kimicode: {
      ranges: kimicode.ranges,
      p5: kimiReadings.p5 ?? null, pw: kimiReadings.pw ?? null,
      r5: kimiReadings.r5 ?? null, rw: kimiReadings.rw ?? null,
      q_updated: kimiReadings.q_updated ?? null,
      p5_stale: kimiReadings.p5_stale ?? null, pw_stale: kimiReadings.pw_stale ?? null,
      plan: kimiReadings.plan ?? null,
    },
    musecode: { ranges: musecode.ranges },
    cmdcode: { ranges: cmdcode.ranges },
  };

  // 逐日/逐小时明细不进 payload：Python 也只把它们留在扫描缓存里供 Dashboard 复用
  if (Object.keys(errors).length) result._errors = errors;
  recalcCosts(result);
  return { payload: result, bounds, errors };
}

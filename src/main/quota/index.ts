/**
 * 联网额度的编排层：对应 usage.30s.py 的 scan_provider_quotas（7870-7916）
 * 以及主扫描里那几路 _safe_scan 的实时额度（codex live / reset cards / grok / kimi，
 * 13433-13463）。
 *
 * 原版用 ThreadPoolExecutor 并发，这里用 Promise 并发，语义一致：
 * - 每一路失败只写 errors["<name>_quota"]，不影响别的路；
 * - cursor 与 grok_bot 打包成一路（grok bot 的兜底要复用 cursor 的会话，
 *   分两路就会把同一份 cookie 读两次、请求两次）；
 * - 开关关掉的路直接给空对象，不发请求。
 *
 * 凭据只在这一层之上被读到（deps.secret 由主进程接 DPAPI），渲染进程拿不到明文。
 */
import { providerQuotaEnabled } from "../../core/providerQuota";
import { baseDeps, QuotaDeps } from "./context";
import { scanAntigravityQuota } from "./antigravity";
import { cursorSession, fetchCursorQuota } from "./cursor";
import { scanDevinQuota } from "./devin";
import { fetchGrokBotQuota } from "./grokBot";
import { scanMinimaxQuota } from "./minimax";
import { scanSub2ApiQuota } from "./sub2api";
import { scanZedQuota } from "./zed";
import { scanZaiQuota } from "./zai";
import { CodexLiveResult, fetchCodexLiveLimits, fetchCodexResetCards } from "./codexLive";
import { scanGrokQuota } from "./grokLive";
import { fetchKimiLiveLimits, KimiLiveResult } from "./kimiLive";
import { emptyQwenworkPayload, QwenworkQuotaPayload, scanQwenworkQuota } from "../../collectors/qwenwork";

export type QuotaErrors = Record<string, string>;

/** 对应 scan_provider_quotas 返回的那张表，键顺序与 Python 的 result 一致 */
export interface ProviderQuotaTable {
  [name: string]: Record<string, any>;
}

/** 主扫描要并进来的一组实时额度 */
export interface QuotaBundle {
  providerQuotas: ProviderQuotaTable;
  /** 对应 fetch_codex_live_limits：Python 在 scan_codex 内部调用，命中就覆盖日志里的读数 */
  codexLive: CodexLiveResult | null;
  /** 对应 fetch_codex_reset_cards：payload 那层再把 count==0 转成 null */
  codexResetCards: Record<string, any>;
  grokQuota: Record<string, any>;
  /** 对应 scan_qwenwork_quota：只连千问办公自己的 127.0.0.1 MCP，默认关闭 */
  qwenwork: QwenworkQuotaPayload;
  kimiLive: KimiLiveResult;
}

/**
 * 真实运行的依赖：环境变量 + ~/.tokei/config.json + 主进程给的 DPAPI 凭据读取器 + node http。
 * secret 由调用方注入，这一层不 import electron（否则单测一 import 就炸）。
 */
export function makeQuotaDeps(
  secret: (name: string) => string | null, part: Partial<QuotaDeps> = {},
): QuotaDeps {
  return baseDeps({ secret, ...part });
}

/** 对应 Python 的 f"{type(error).__name__}: {error}" */
function describeError(error: any): string {
  return `${error?.name ?? "Error"}: ${error?.message ?? error}`;
}

/** 对应 scan_provider_quotas */
export async function scanProviderQuotas(
  deps: QuotaDeps, errors?: QuotaErrors,
): Promise<ProviderQuotaTable> {
  const scans: Record<string, () => Promise<Record<string, any>>> = {
    zed: () => scanZedQuota(deps),
    sub2api: () => scanSub2ApiQuota(deps),
    zai: () => scanZaiQuota(deps),
    antigravity: () => scanAntigravityQuota(deps),
    devin: () => Promise.resolve(scanDevinQuota(deps)),
    minimax: () => scanMinimaxQuota(deps),
  };
  const result: ProviderQuotaTable = {};
  for (const name of [...Object.keys(scans), "cursor", "grok_bot"]) result[name] = {};

  const enabled = Object.fromEntries(
    Object.keys(scans).map((name) => [name, providerQuotaEnabled(name, deps)]),
  ) as Record<string, boolean>;
  const cursorEnabled = providerQuotaEnabled("cursor", deps);
  const grokBotEnabled = providerQuotaEnabled("grok_bot", deps);

  const tasks: Array<[string, () => Promise<any>]> = Object.entries(scans)
    .filter(([name]) => enabled[name])
    .map(([name, run]) => [name, run]);

  if (cursorEnabled || grokBotEnabled) {
    // 对应 cursor_bundle：一次会话读两路额度，grok bot 的原生授权永远先试，
    // 拿不到才回落到 cursor（fetchGrokBotQuota 内部自己再取会话，与原版一致）
    tasks.push(["cursor_bundle", async () => {
      const session = cursorSession(deps);
      const cursorQuota = cursorEnabled && session ? await fetchCursorQuota(deps, { session }) : {};
      const grokBotQuota = grokBotEnabled ? await fetchGrokBotQuota(deps) : {};
      return [cursorQuota, grokBotQuota] as const;
    }]);
  }
  if (!tasks.length) return result;

  const settled = await Promise.allSettled(tasks.map(([, run]) => run()));
  settled.forEach((outcome, index) => {
    const name = tasks[index][0];
    if (outcome.status !== "fulfilled") {
      if (errors) {
        const errorName = name === "cursor_bundle" ? "cursor" : name;
        errors[`${errorName}_quota`] = describeError(outcome.reason);
      }
      return;
    }
    const value = outcome.value;
    if (name === "cursor_bundle") {
      const [cursorQuota, grokBotQuota] = value as readonly Record<string, any>[];
      if (cursorEnabled) result.cursor = cursorQuota ?? {};
      if (grokBotEnabled) result.grok_bot = grokBotQuota ?? {};
      return;
    }
    result[name] = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  });
  return result;
}

/**
 * 一轮采集的全部额度读数。provider 那 8 路与 codex/grok/qwenwork/kimi 几路互不依赖，
 * 并发跑；每路失败只记自己的 errors 键（对应各处 _safe_scan 的名字）。
 */
export async function collectQuotas(
  deps: QuotaDeps, errors: QuotaErrors = {},
): Promise<QuotaBundle> {
  const [providerQuotas, codexLive, codexResetCards, grokQuota, qwenwork, kimiLive] = await Promise.all([
    scanProviderQuotas(deps, errors),
    // Python 是在 scan_codex 里直接调用的，抛错会连整份 codex 扫描一起丢；
    // 这里记错后继续，至少日志里的用量还在
    fetchCodexLiveLimits(deps).catch((error) => {
      errors.codex = describeError(error);
      return null;
    }),
    fetchCodexResetCards(deps).catch((error) => {
      errors.codex_reset_cards = describeError(error);
      return {};
    }),
    scanGrokQuota(deps).catch((error) => {
      errors.grok_quota = describeError(error);
      return {};
    }),
    // 对应 _safe_scan("qwenwork_quota", scan_qwenwork_quota, lambda: {}, errors)
    scanQwenworkQuota().catch((error) => {
      errors.qwenwork_quota = describeError(error);
      return emptyQwenworkPayload();
    }),
    fetchKimiLiveLimits(deps).catch((error) => {
      errors.kimi_quota = describeError(error);
      return null;
    }),
  ]);
  return { providerQuotas, codexLive, codexResetCards, grokQuota, qwenwork, kimiLive };
}

export type { QuotaDeps };

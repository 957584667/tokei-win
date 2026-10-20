/**
 * 抓价的进程外壳：core 的 updatePrices() 只管换算与落盘，这里接上共享 HTTP 底座，
 * 并实现启动时那趟「超过 24 小时没更新就自动抓一次」（对应 main.swift:542-560 autoFetchPricing）。
 * 同一条路上还有本地那半：runUnknownUpdate() 对应「查漏补缺」，只读日志，不碰网络。
 *
 * 这个文件不许 import electron —— dist/cli.js 要直接 require 它跑 `--update-prices` 与 `--update-unknown`。
 */
import { updateUnknown, UpdateUnknownResult } from "../core/unknownPricing";
import { pricingFetchStale, updatePrices, UpdatePricesResult } from "../core/priceUpdate";
import { requestJson } from "./quota/http";

/**
 * 响应上限 16MiB：OpenRouter 的模型列表把 description 也一并返回，两三兆是常态，
 * 直接套额度接口那 2MiB 的口径会把整张价目表判成异常。原版 urlopen 没有上限，
 * 这里只兜住「接口哪天开始吐大文件」这种情况。
 */
const MODELS_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface PriceFetchDeps {
  request?: (url: string) => Promise<any>;
  now?: () => number;
}

/** 手动「全量更新」与自动抓价共用的那一步。 */
export function runPriceUpdate(
  resourceDir: string,
  cache: Record<string, any> | null = null,
  deps: PriceFetchDeps = {},
): Promise<UpdatePricesResult> {
  return updatePrices({
    resourceDir,
    cache,
    // 30 秒是原版 urlopen(timeout=30) 的口径，别用额度那种 5 秒。
    // 走 requestJson 而不是裸的 providerJsonRequest：这套代码里有一个全局传输注入口，
    // 单测和 CLI 冒烟都靠它把 OpenRouter 换成 fixture，真网络只在注入口为空时才发生。
    // 原版不带任何请求头（连 User-Agent 都是 urllib 默认的），这个公开接口也不需要，
    // 所以这里同样不加 —— 加了指望服务端按来源放行，反而是条没人维护的隐藏依赖。
    request: deps.request ?? ((url) => requestJson(url, {
      timeoutSeconds: 30,
      maxBytes: MODELS_MAX_RESPONSE_BYTES,
    })),
    now: new Date((deps.now?.() ?? Date.now())),
  });
}

/**
 * 手动「查漏补缺」：对应 runPriceUpdate("--update-unknown")（PV:4190-4218）。
 * 这条路只读本地日志与两份价目表，一次网络请求都不发，所以没有注入传输的余地。
 */
export function runUnknownUpdate(resourceDir: string, models?: Iterable<string>): UpdateUnknownResult {
  return updateUnknown({ resourceDir, models });
}

/**
 * 启动时跑一次：pricing.json 的 mtime 距今不足 24 小时就什么都不做。
 * 原版无论抓没抓到都会 `store.refresh()` 一轮（抓价改了价目表，读数得跟上新价），
 * 只有真跑过网络才刷，跳过水位时不折腾采集。
 */
export async function autoFetchPricing(
  resourceDir: string,
  cache: Record<string, any> | null,
  deps: PriceFetchDeps = {},
  onSettled: (result: UpdatePricesResult | null) => void = () => {},
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  if (!pricingFetchStale(resourceDir, now)) return onSettled(null);
  const result = await runPriceUpdate(resourceDir, cache, deps);
  onSettled(result);
}

/**
 * 自动抓价：对应 usage.30s.py 的 update_prices()（15539-15596）与 _record_pricing_changes()
 * （15522-15536）。
 *
 * 这一层只有换算、比对与落盘，不碰网络 —— 传输由调用方注入：主进程给共享 HTTP 底座，
 * 单测给 fixture，谁都不必真联网。
 */
import * as fs from "fs";
import * as path from "path";
import { loadJson, writablePath } from "./paths";
import { changedPricingModels, PriceFields } from "./price";

/** 原版唯一的取价来源（usage.30s.py:15543），没有第二个域名。 */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** 对应 _PRICING_FILE 里一条模型记录。retired 是本地字段：在线下架了但本机历史用过。 */
export interface CatalogEntry extends PriceFields {
  name?: string;
  canonical_slug?: string;
  owned_by?: string;
  retired?: boolean;
}

export interface UpdatePricesResult {
  /** 对应 Python 的返回码：0 成功、1 失败（失败只把原因打到 stderr） */
  code: 0 | 1;
  message: string;
  file: string;
  activeCount: number;
  retainedCount: number;
  changedModels: string[];
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * 对应 mtok()：OpenRouter 给的是「每 token 多少美元」的字符串，乘 1e6 换成每 1M 美元，
 * 保留 6 位小数；不是数的一律当 0（原版 catch TypeError/ValueError）。
 */
export function mtok(pricing: Record<string, any> | null | undefined, key: string): number {
  const value = Number(pricing?.[key] ?? 0);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e6 * 1e6) / 1e6;
}

/** 对应 datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S%z")。 */
export function localTimestamp(at: Date): string {
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");
  const offsetMinutes = -at.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const date = [at.getFullYear(), pad(at.getMonth() + 1), pad(at.getDate())].join("-");
  const time = [pad(at.getHours()), pad(at.getMinutes()), pad(at.getSeconds())].join(":");
  return `${date} ${time}${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}${pad(Math.abs(offsetMinutes) % 60)}`;
}

/**
 * json.dump(..., ensure_ascii=False, indent=1, sort_keys=True) 的等价写法：键名逐层排序、
 * 每层缩进一个空格、不转义非 ASCII。文件格式跟 macOS 版保持一致，两边同步目录时
 * 同一份价目表不会只因排版不同就整篇冲突。
 */
function stringifyCatalog(value: unknown): string {
  const render = (v: unknown, depth: number): string => {
    const pad = " ".repeat(depth + 1);
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      return `[\n${v.map((item) => `${pad}${render(item, depth + 1)}`).join(",\n")}\n${" ".repeat(depth)}]`;
    }
    if (isObj(v)) {
      const keys = Object.keys(v).sort();
      if (!keys.length) return "{}";
      return `{\n${keys.map((k) => `${pad}${JSON.stringify(k)}: ${render(v[k], depth + 1)}`).join(",\n")}\n${" ".repeat(depth)}}`;
    }
    return JSON.stringify(v ?? null);
  };
  return render(value, 0);
}

/**
 * 对应 _record_pricing_changes()。原版是「另起一个 python3 进程抓价」，所以它把标记写进磁盘上的
 * 扫描缓存，等下一轮采集进程 _load_scan_cache() 时认领；我们抓价和采集在同一个进程里，
 * 直接标在内存缓存上就行，下一轮 compute() 就把这些模型预存的成本重算掉。
 * 指纹比对（markPricingChanges）自己也会认出新价表，这里只是让抓价当轮就落下标记，
 * 口径与原版一致：与已有名单取并集、排序、置 _dirty。
 */
export function recordPricingChanges(cache: Record<string, any> | null | undefined, models: Iterable<unknown>): void {
  if (!cache) return;
  const changed = new Set<string>();
  for (const model of models) if (model) changed.add(String(model));
  if (!changed.size) return;
  const pending = new Set<string>(
    (Array.isArray(cache._pricing_changed_models) ? cache._pricing_changed_models : []).filter((v) => !!v).map(String),
  );
  for (const model of changed) pending.add(model);
  cache._pricing_changed = true;
  cache._pricing_changed_models = [...pending].sort();
  cache._dirty = true;
}

/**
 * 对应 autoFetchPricing 的水位判断（main.swift:542-560）：pricing.json 的 mtime 距今不足 24 小时
 * 就直接跳过。原版量的是 ~/.tokei/pricing.json；我们量 writablePath() 真正会写的那一份，
 * 免得开发模式下「查一个文件、写另一个文件」永远查不出水位。
 */
export function pricingFetchStale(resourceDir: string, nowMs: number = Date.now()): boolean {
  try {
    return nowMs - fs.statSync(writablePath("pricing.json", resourceDir)).mtimeMs > 24 * 3600_000;
  } catch {
    return true;
  }
}

/** 对应 update_prices()：拉在线价目表刷 pricing.json，全程不动 pricing_overrides.json。 */
export async function updatePrices(options: {
  resourceDir: string;
  request: (url: string) => Promise<any>;
  cache?: Record<string, any> | null;
  now?: Date;
}): Promise<UpdatePricesResult> {
  // 副本在这里落地：首次调用会把资源目录里那份复制到 ~/.tokei（见 writablePath）
  const pricingFile = writablePath("pricing.json", options.resourceDir);
  const failed = (error: unknown): UpdatePricesResult => ({
    // 原版的失败文案：print(f"更新失败:{e}", file=sys.stderr)，不带空格、不带句号
    message: `更新失败:${error instanceof Error ? error.message : String(error)}`,
    code: 1,
    file: pricingFile,
    activeCount: 0,
    retainedCount: 0,
    changedModels: [],
  });

  let rows: unknown[];
  try {
    rows = (await options.request(OPENROUTER_MODELS_URL))?.data;
    if (!Array.isArray(rows)) throw new Error("返回里没有 data 数组");
  } catch (error) {
    return failed(error);
  }

  const models: Record<string, CatalogEntry> = {};
  for (const item of rows) {
    if (!isObj(item) || typeof item.id !== "string" || !item.id) continue;
    const pricing = isObj(item.pricing) ? item.pricing : {};
    const input = mtok(pricing, "prompt");
    const output = mtok(pricing, "completion");
    if (!input && !output) continue; // 跳过无价(免费/路由占位)条目
    const entry: CatalogEntry = {
      in: input,
      out: output,
      cache_read: mtok(pricing, "input_cache_read"),
      cache_write: mtok(pricing, "input_cache_write"),
    };
    for (const field of ["name", "canonical_slug", "owned_by"] as const) {
      const value = item[field];
      if (typeof value === "string" && value.trim()) entry[field] = value.trim();
    }
    models[item.id] = entry;
  }
  const activeCount = Object.keys(models).length;

  const oldCatalog = loadJson<Record<string, any>>(pricingFile, {})?.models;
  const oldModels: Record<string, CatalogEntry> = isObj(oldCatalog) ? oldCatalog : {};
  // 下架不等于删：本地日志里还有历史用量，条目留着并标 retired，价格维持最后一版
  let retainedCount = 0;
  for (const [model, entry] of Object.entries(oldModels)) {
    if (model in models || !isObj(entry)) continue;
    models[model] = { ...entry, retired: true };
    retainedCount++;
  }

  const changedModels = changedPricingModels(oldModels, models);
  const payload = {
    _meta: {
      source: "openrouter/api/v1/models",
      updated_at: localTimestamp(options.now ?? new Date()),
      count: Object.keys(models).length,
      active_count: activeCount,
      retained_count: retainedCount,
    },
    models,
  };
  try {
    fs.mkdirSync(path.dirname(pricingFile), { recursive: true });
    // 原版是 open(...,"w") 直写，写一半被断电会把整张价目表截断；这里走先临时文件再改名，
    // 失败的代价只是「这一版没生效」，不是「价目表没了」。
    const tmp = `${pricingFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, stringifyCatalog(payload), "utf8");
    fs.renameSync(tmp, pricingFile);
  } catch (error) {
    return failed(error);
  }

  recordPricingChanges(options.cache, changedModels);
  const suffix = retainedCount ? `，保留 ${retainedCount} 个历史模型` : "";
  return {
    code: 0,
    message: `已更新 ${activeCount} 个在线模型${suffix} → ${pricingFile}`,
    file: pricingFile,
    activeCount,
    retainedCount,
    changedModels,
  };
}

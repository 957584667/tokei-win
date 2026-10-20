/**
 * 自动抓价测试（core/priceUpdate.ts ← usage.30s.py 的 update_prices / _record_pricing_changes /
 * mtok / _writable_path，main.swift:542-560 的 24 小时水位）。
 * 网络一律用注入的假 transport，价目表与 HOME 都写在临时目录，绝不碰真实的 ~/.tokei。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type PriceModule = typeof import("../src/core/price");
type PriceUpdateModule = typeof import("../src/core/priceUpdate");

let root: string;
let home: string;
let res: string;
let tokeiDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** OpenRouter 的一条模型记录：真实响应里还有一堆 description/architecture，这里按会被读的字段给 */
function row(id: string, pricing: Record<string, any>, extra: Record<string, any> = {}) {
  return { id, pricing, ...extra };
}

let price: PriceModule;
let update: PriceUpdateModule;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-price-"));
  home = path.join(root, "home");
  res = path.join(root, "resources");
  tokeiDir = path.join(home, ".tokei");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(res, { recursive: true });
  setEnv("HOME", home);
  setEnv("USERPROFILE", home);
  vi.resetModules();
  // paths.ts 在导入时就把 HOME 定下来了，所以必须在改完 env 之后再取模块
  price = await import("../src/core/price");
  update = await import("../src/core/priceUpdate");
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function seedCatalog(models: Record<string, any>): void {
  fs.writeFileSync(path.join(res, "pricing.json"), JSON.stringify({ models }));
  fs.writeFileSync(path.join(res, "pricing_overrides.json"), JSON.stringify({ models: {}, aliases: {} }));
}

function readUserCatalog(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(tokeiDir, "pricing.json"), "utf8")).models;
}

function run(rows: any[], cache: Record<string, any> | null = null) {
  return update.updatePrices({
    resourceDir: res,
    cache,
    request: async () => ({ data: rows }),
  });
}

describe("writablePath 的副本落地", () => {
  it("第一次读就把资源里那份复制到 ~/.tokei，并带上源的 mtime", () => {
    seedCatalog({ "test/alpha-1": { in: 1, out: 2, cache_read: 0.1, cache_write: 0.3 } });
    const source = path.join(res, "pricing.json");
    const stamp = new Date(Date.UTC(2026, 8, 1, 3, 4, 5));
    fs.utimesSync(source, stamp, stamp);
    const target = path.join(tokeiDir, "pricing.json");
    expect(fs.existsSync(target)).toBe(false);
    // 24 小时水位读的就是这个 mtime：副本要是按「复制的那一刻」算，新装完要白等一天
    price.initPricing(res);
    expect(fs.existsSync(target)).toBe(true);
    expect(Math.abs(fs.statSync(target).mtimeMs - stamp.getTime())).toBeLessThan(2000);
  });
});

describe("mtok 与时间戳", () => {
  it("每 token 的字符串价换成每 1M 美元，认不出的一律 0", () => {
    expect(update.mtok({ prompt: "0.000003" }, "prompt")).toBe(3);
    expect(update.mtok({ prompt: "0.0000006" }, "prompt")).toBe(0.6);
    expect(update.mtok({ prompt: null }, "prompt")).toBe(0);
    expect(update.mtok({ prompt: "" }, "prompt")).toBe(0);
    expect(update.mtok({ prompt: "abc" }, "prompt")).toBe(0);
    expect(update.mtok({}, "prompt")).toBe(0);
    expect(update.mtok(null, "prompt")).toBe(0);
  });

  it("updated_at 是本地时间的 %Y-%m-%d %H:%M:%S%z", () => {
    const text = update.localTimestamp(new Date("2026-10-20T01:02:03Z"));
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{4}$/);
    expect(text.slice(0, 10)).toMatch(/^\d{4}-10-2[01]$/);
  });
});

describe("update_prices", () => {
  beforeEach(() => {
    seedCatalog({ "test/alpha-1": { in: 2, out: 8, cache_read: 0.2, cache_write: 0.5 } });
    price.initPricing(res);
  });

  it("按四个价字段建条目，免费/占位与没有 id 的行不要", async () => {
    const result = await run([
      row("a/one", { prompt: "0.000002", completion: "0.000008", input_cache_read: "0.0000002", input_cache_write: "0.0000005" },
        { name: "  一个模型  ", owned_by: " a ", description: "很长的一段介绍不进价目表" }),
      row("a/free", { prompt: "0", completion: "0" }),
      row("a/auto", { prompt: "-1", completion: "-1" }),
      row("", { prompt: "0.000002" }),
      { pricing: { prompt: "0.000002" } },
      "不是对象",
    ]);
    expect(result.code).toBe(0);
    expect(result.activeCount).toBe(2);
    const models = readUserCatalog();
    // a/auto 的 completion 缺 → 0，但 prompt=-1 非零，原版的 `if not in and not out` 拦不住它，
    // 于是这条负价照样进了价目表（占位行就是这么漏进来的，不是我们改写的行为）
    expect(Object.keys(models).sort()).toEqual(["a/auto", "a/one", "test/alpha-1"]);
    expect(models["test/alpha-1"].retired).toBe(true); // 夹具老表里那条留下的历史条目
    expect(models["a/free"]).toBeUndefined();
    expect(models["a/one"]).toMatchObject({ in: 2, out: 8, cache_read: 0.2, cache_write: 0.5, name: "一个模型", owned_by: "a" });
    expect(models["a/one"].description).toBeUndefined();
  });

  it("_meta 报条数与活跃数，文件写的是排序缩进版、能被 initPricing 读回", async () => {
    const result = await run([row("test/alpha-1", { prompt: "0.000002", completion: "0.000008" })], null);
    const raw = fs.readFileSync(path.join(tokeiDir, "pricing.json"), "utf8");
    const written = JSON.parse(raw);
    expect(written._meta).toMatchObject({ source: "openrouter/api/v1/models", count: 1, active_count: 1, retained_count: 0 });
    expect(written._meta.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{4}$/);
    // indent=1 + sort_keys：顶层键 _meta 在前、models 在后，键都排过序
    expect(raw.indexOf('"_meta"')).toBeLessThan(raw.indexOf('"models"'));
    expect(raw).toContain('\n "models": {\n  "test/alpha-1": {\n   "cache_read"');
    price.initPricing(res);
    expect("test/alpha-1" in price.effectivePricingMap()).toBe(true);
    expect(result.message.startsWith("已更新 1 个在线模型 → ")).toBe(true);
  });

  it("下架的模型留着标 retired，但纯下架不算价目变更", async () => {
    const result = await run([row("other/new-1", { prompt: "0.000004", completion: "0.000016" })], null);
    const models = readUserCatalog();
    expect(models["test/alpha-1"]).toMatchObject({ in: 2, out: 8, retired: true });
    expect(result.retainedCount).toBe(1);
    expect(result.changedModels).toEqual(["other/new-1"]);
    expect(result.message).toContain("，保留 1 个历史模型");
  });

  it("价格真的变了才进变更名单，并把标记落进缓存", async () => {
    const cache: Record<string, any> = {};
    // 先把当前这一版盖进缓存，模拟「上一轮采集结束时指纹与快照已落盘」
    price.markPricingChanges(cache);
    price.finishPricingPass(cache);
    const stamped = cache._pricing_fingerprint;
    expect(stamped).toBe(price.pricingFingerprint());
    expect(cache._pricing_changed).toBeUndefined();
    const before = price.effectivePricingMap()["test/alpha-1"].in;
    const result = await run([row("test/alpha-1", { prompt: "0.000003", completion: "0.000008" })], cache);
    expect(before).toBe(2);
    expect(result.changedModels).toEqual(["test/alpha-1"]);
    expect(cache._pricing_changed).toBe(true);
    expect(cache._pricing_changed_models).toEqual(["test/alpha-1"]);
    expect(cache._dirty).toBe(true);
    // 重读文件后指纹必须变，下一轮 compute() 的 markPricingChanges 才认得出价表动过
    expect(price.reloadPricingIfChanged()).toBe(true);
    expect(price.pricingFingerprint()).not.toBe(stamped);
  });

  it("抓价失败：返回码 1、原文案带原因、旧价目表一个字没动", async () => {
    const old = fs.readFileSync(path.join(tokeiDir, "pricing.json"), "utf8");
    const result = await update.updatePrices({
      resourceDir: res,
      request: async () => { throw new Error("timed out"); },
    });
    expect(result.code).toBe(1);
    expect(result.message).toBe("更新失败:timed out");
    expect(fs.readFileSync(path.join(tokeiDir, "pricing.json"), "utf8")).toBe(old);
  });

  it("响应里没有 data 数组同样算失败，不许静默写一张空价目表", async () => {
    const result = await update.updatePrices({ resourceDir: res, request: async () => ({ error: "rate limited" }) });
    expect(result.code).toBe(1);
    expect(result.message).toContain("更新失败:");
    expect(readUserCatalog()).toEqual({ "test/alpha-1": { in: 2, out: 8, cache_read: 0.2, cache_write: 0.5 } });
  });
});

describe("record_pricing_changes 与 24 小时水位", () => {
  it("与已有名单取并集再排序，空名单什么都不做", () => {
    const cache: Record<string, any> = { _pricing_changed_models: ["zeta/9", "alpha/1"], _dirty: false };
    update.recordPricingChanges(cache, ["mid/5", "", null, "alpha/1"]);
    expect(cache._pricing_changed_models).toEqual(["alpha/1", "mid/5", "zeta/9"]);
    expect(cache._pricing_changed).toBe(true);
    expect(cache._dirty).toBe(true);
    const quiet: Record<string, any> = {};
    update.recordPricingChanges(quiet, [null, ""]);
    expect(Object.keys(quiet)).toEqual([]);
    update.recordPricingChanges(null, ["a/1"]);
  });

  it("pricing.json 的 mtime 决定这趟要不要联网", () => {
    fs.mkdirSync(tokeiDir, { recursive: true });
    const file = path.join(tokeiDir, "pricing.json");
    const now = Date.UTC(2026, 9, 20, 12);
    expect(update.pricingFetchStale(res, now)).toBe(true); // 文件还没有
    fs.writeFileSync(file, "{}");
    expect(update.pricingFetchStale(res, now)).toBe(false);
    const old = new Date(now - 25 * 3600_000);
    fs.utimesSync(file, old, old);
    expect(update.pricingFetchStale(res, now)).toBe(true);
    const justUnder = new Date(now - 23.5 * 3600_000);
    fs.utimesSync(file, justUnder, justUnder);
    expect(update.pricingFetchStale(res, now)).toBe(false);
  });
});

describe("主进程外壳 runPriceUpdate / autoFetchPricing", () => {
  type Main = typeof import("../src/main/pricingFetch");
  type Http = typeof import("../src/main/quota/http");
  let main: Main;
  let http: Http;
  let seen: { url: string; opts: any }[];

  beforeEach(async () => {
    seen = [];
    main = await import("../src/main/pricingFetch");
    http = await import("../src/main/quota/http");
    seedCatalog({ "test/alpha-1": { in: 2, out: 8, cache_read: 0.2, cache_write: 0.5 } });
  });

  afterEach(() => http.setProviderTransport(null));

  it("默认传输走 requestJson 注入口：URL、30 秒超时、16MiB 上限，且不带任何请求头", async () => {
    http.setProviderTransport(async (url, opts) => {
      seen.push({ url, opts });
      return { data: [row("a/one", { prompt: "0.000003", completion: "0.000009" })] };
    });
    const result = await main.runPriceUpdate(res);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(update.OPENROUTER_MODELS_URL);
    expect(seen[0].opts.timeoutSeconds).toBe(30);
    expect(seen[0].opts.maxBytes).toBe(16 * 1024 * 1024);
    expect(seen[0].opts.headers).toBeUndefined();
    expect(result.code).toBe(0);
    expect(readUserCatalog()["a/one"].in).toBe(3);
  });

  it("水位没过 24 小时一个请求都不发，过期才抓；抓价挂了也只回错误、不动文件", async () => {
    const file = path.join(tokeiDir, "pricing.json");
    // 副本刚落地（mtime 跟着资源走，这里把资源压成 1 小时前）：该跳过
    const recent = new Date(Date.now() - 3600_000);
    fs.utimesSync(path.join(res, "pricing.json"), recent, recent);
    let calls = 0;
    http.setProviderTransport(async () => { calls++; return { data: [] }; });
    let settled: any = "没回调";
    await main.autoFetchPricing(res, {}, {}, (r) => { settled = r; });
    expect(calls).toBe(0);
    expect(settled).toBeNull();

    // 压成 25 小时前：该抓一次
    fs.writeFileSync(path.join(res, "pricing.json"), JSON.stringify({ models: {} }));
    price.initPricing(res);
    const stale = new Date(Date.now() - 25 * 3600_000);
    fs.utimesSync(file, stale, stale);
    http.setProviderTransport(async () => { calls++; return { data: [row("a/one", { prompt: "0.000003", completion: "0.000009" })] }; });
    settled = "没回调";
    const cache: Record<string, any> = {};
    await main.autoFetchPricing(res, cache, {}, (r) => { settled = r; });
    expect(calls).toBe(1);
    expect(settled.code).toBe(0);
    expect(readUserCatalog()["a/one"].in).toBe(3);

    // 再压回 25 小时前，让传输直接抛：文件维持上一版，一个字节都不能动
    const before = fs.readFileSync(file, "utf8");
    fs.utimesSync(file, stale, stale);
    http.setProviderTransport(async () => { throw new Error("timed out"); });
    settled = "没回调";
    await main.autoFetchPricing(res, cache, {}, (r) => { settled = r; });
    expect(settled.code).toBe(1);
    expect(settled.message).toBe("更新失败:timed out");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

/**
 * 自动抓价的真机验证（全程不碰网络）：用打包资源里的真实价目表造一份 OpenRouter 形状的响应，
 * 按 1.5 倍价灌进 updatePrices()，再看 compute() 有没有把缓存里预存的成本跟着新价走。
 * HOME 指到临时目录：写出去的是临时目录里的 pricing.json，用户真实那份一个字都不动。
 * 转录是只读的，取的是本机真实 Claude/Codex 日志。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const realHome = os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-fetch-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TOKEI_CLAUDE_DIR = path.join(realHome, ".claude", "projects");
process.env.TOKEI_CODEX_DIR = path.join(realHome, ".codex", "sessions");
process.env.TOKEI_CODEX_ARCHIVED_DIR = path.join(realHome, ".codex", "archived_sessions");

const { compute } = require("../dist/core/compute");
const price = require("../dist/core/price");
const { updatePrices, pricingFetchStale } = require("../dist/core/priceUpdate");
const resourceDir = path.resolve(__dirname, "..", "resources");

const tokeiDir = path.join(home, ".tokei");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function claudeCosts(cache) {
  const out = [];
  for (const [file, entry] of Object.entries(cache.claude ?? {})) {
    for (const event of entry.events ?? []) if (event.cost > 0) out.push({ file: path.basename(file), ref: event, model: event.model });
  }
  return out;
}

(async () => {
  // 1) 副本落地与水位
  price.initPricing(resourceDir);
  const copy = path.join(tokeiDir, "pricing.json");
  const bundled = fs.statSync(path.join(resourceDir, "pricing.json"));
  console.log(`副本：${fs.existsSync(copy) ? "已建" : "没建"} mtime 差 ${Math.abs(fs.statSync(copy).mtimeMs - bundled.mtimeMs)}ms`
    + ` 资源文件 mtime ${new Date(bundled.mtimeMs).toISOString().slice(0, 10)}`);
  const copyMtime = fs.statSync(copy).mtimeMs;
  console.log(`水位：装完 1 小时=${pricingFetchStale(resourceDir, copyMtime + 3600_000)} 现刻=${pricingFetchStale(resourceDir)}`
    + `（副本跟着资源走，资源 mtime ${new Date(bundled.mtimeMs).toISOString().slice(0, 10)}，所以首次启动就该抓一次）`);

  const before = JSON.parse(fs.readFileSync(copy, "utf8"));
  const models = before.models ?? {};
  const priced = Object.keys(models).filter((id) => Number(models[id].in) > 0);
  console.log(`本机价目表：${Object.keys(models).length} 条，其中有价 ${priced.length} 条`);

  // 2) 先拿真实转录把缓存焐热
  const cache = {};
  const first = compute(cache);
  const events = claudeCosts(cache);
  const picked = events.slice(0, 3).map((e) => ({ ...e, before: e.ref.cost }));
  const codexTotal = () => {
    let total = 0;
    for (const entry of Object.values(cache.codex ?? {})) {
      for (const day of Object.values(entry.days ?? {})) for (const m of Object.values(day.models ?? {})) total += Number(m.cost) || 0;
    }
    return total;
  };
  console.log(`第一轮 claude all=$${Number(first.payload.claude?.ranges?.all?.cost ?? 0).toFixed(4)}`
    + ` codex 日账合计 $${codexTotal().toFixed(6)} 缓存条目=claude:${Object.keys(cache.claude ?? {}).length}/codex:${Object.keys(cache.codex ?? {}).length}`);

  // 3) 造一份 OpenRouter 形状的响应：在用模型的 in/out 一律 ×1.5，再塞两条新模型和一条免费行
  const inUse = new Set();
  for (const entry of Object.values(cache.claude ?? {})) for (const e of entry.events ?? []) if (e.model) inUse.add(price.resolveId(e.model));
  for (const entry of Object.values(cache.codex ?? {})) {
    if (entry.active_model) inUse.add(price.resolveId(entry.active_model));
    for (const day of Object.values(entry.days ?? {})) for (const m of Object.keys(day.models ?? {})) inUse.add(price.resolveId(m));
  }
  inUse.add("openai/gpt-5.5"); // Codex 里没公开价的模型借这条的价（_codex_price_model）
  const rows = [];
  const scaled = [];
  for (const id of inUse) {
    const p = models[id];
    if (!p || !(Number(p.in) > 0) || !(Number(p.out) > 0)) continue;
    scaled.push(id);
    rows.push({ id, pricing: { prompt: String(Number(p.in) * 1.5 / 1e6), completion: String(Number(p.out) * 1.5 / 1e6),
      input_cache_read: String(Number(p.cache_read ?? 0) / 1e6), input_cache_write: String(Number(p.cache_write ?? 0) / 1e6) },
      name: `${id} 改名`, description: "一长段说明不该进价目表" });
  }
  const gone = Object.keys(models).find((id) => Number(models[id].in) > 0 && Number(models[id].out) > 0
    && !inUse.has(id) && !String(id).startsWith("openrouter/"));
  const dropped = { ...models };
  delete dropped[gone];
  for (const [id, p] of Object.entries(dropped)) {
    // 其余模型照抄本机价（含缓存价），这样「变更」名单该只剩被翻价的那几条 + 新模型
    if (scaled.includes(id) || !(Number(p.in) > 0)) continue;
    rows.push({ id, pricing: { prompt: String(Number(p.in) / 1e6), completion: String(Number(p.out ?? 0) / 1e6),
      input_cache_read: String(Number(p.cache_read ?? 0) / 1e6), input_cache_write: String(Number(p.cache_write ?? 0) / 1e6) } });
  }
  rows.push({ id: "brand/new-1", pricing: { prompt: "0.000001", completion: "0.000004" }, owned_by: "brand" });
  rows.push({ id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } });
  rows.push({ id: "brand/free", pricing: { prompt: "0", completion: "0" } });
  console.log(`夹具：翻价 ${scaled.length} 条，故意下架 ${gone}，另加 3 条（新模型/占位/免费）`);

  const result = await updatePrices({
    resourceDir,
    cache,
    // 桩：延迟 30ms 再返回，让启动/手动那条路的异步性也走一遍
    request: () => sleep(30).then(() => ({ data: rows })),
  });
  console.log(`抓价：code=${result.code} ${result.message}`);
  const expected = new Set([...scaled, "brand/new-1", "openrouter/auto"]);
  const unexpected = result.changedModels.filter((id) => !expected.has(id));
  console.log(`  active=${result.activeCount} retained=${result.retainedCount} 变更模型 ${result.changedModels.length} 个`
    + `（翻价 ${scaled.length} + 新模型/占位，名单外的意外变更 ${unexpected.length} 个${unexpected.length ? "：" + unexpected.slice(0, 5).join(", ") : ""}）`);
  const written = JSON.parse(fs.readFileSync(copy, "utf8"));
  console.log(`  落盘 _meta=${JSON.stringify(written._meta)} retired=${written.models[gone]?.retired}`
    + ` 免费行=${"brand/free" in written.models ? "混进来了" : "没进来"} 说明字段=${written.models[scaled[0]].description ? "混进来了" : "没进来"}`
    + ` 名字字段=${JSON.stringify(written.models[scaled[0]].name)}`);
  console.log(`水位（抓完价）：现刻=${pricingFetchStale(resourceDir)} 十五天后=${pricingFetchStale(resourceDir, Date.now() + 15 * 86400_000)}`);

  // 4) 同一份缓存再来一轮：条目数不变（没重解析），成本按新价走
  const second = compute(cache);
  const after = claudeCosts(cache);
  console.log(`第二轮 claude all=$${Number(second.payload.claude?.ranges?.all?.cost ?? 0).toFixed(4)}`
    + ` codex 日账合计 $${codexTotal().toFixed(6)} 缓存条目=claude:${Object.keys(cache.claude ?? {}).length}/codex:${Object.keys(cache.codex ?? {}).length}`);
  for (const item of picked) console.log(`  同一对象再读 ${item.model}：$${item.before.toFixed(6)} → $${item.ref.cost.toFixed(6)}`);
  console.log(`  标记残留=${["_pricing_changed", "_pricing_changed_models", "_pricing_cost_multipliers"]
    .filter((k) => k in cache).join(",") || "无"} 指纹=${cache._pricing_fingerprint?.slice(0, 12) ?? "未盖"}`);

  // 5) 价目不动再跑一轮：该完全没重算
  const beforeThird = after.map((e) => e.ref.cost);
  const third = compute(cache);
  const churned = after.filter((e, i) => e.ref.cost !== beforeThird[i]).length;
  console.log(`第三轮 claude all=$${Number(third.payload.claude?.ranges?.all?.cost ?? 0).toFixed(4)} 成本被改写的条数=${churned}`);

  // 6) 启动钩子那条路（main/pricingFetch.autoFetchPricing）：水位没过不发请求，过期抓一次，挂了不动文件
  const { autoFetchPricing } = require("../dist/main/pricingFetch");
  let hookCalls = 0;
  const stub = () => { hookCalls++; return sleep(5).then(() => ({ data: rows })); };
  const failing = () => { hookCalls++; return Promise.reject(new Error("timed out")); };
  const settled = [];
  await autoFetchPricing(resourceDir, cache, { request: stub }, (r) => settled.push(r === null ? "跳过" : `code=${r.code}`));
  const dayOld = new Date(Date.now() - 25 * 3600_000);
  fs.utimesSync(copy, dayOld, dayOld);
  await autoFetchPricing(resourceDir, cache, { request: stub }, (r) => settled.push(r === null ? "跳过" : `code=${r.code} 变更 ${r.changedModels.length} 个`));
  fs.utimesSync(copy, dayOld, dayOld);
  const snapshot = fs.readFileSync(copy, "utf8");
  await autoFetchPricing(resourceDir, cache, { request: failing }, (r) => settled.push(r === null ? "跳过" : `code=${r.code} ${r.message}`));
  console.log(`启动钩子 请求次数=${hookCalls} 回调=[${settled.join(" | ")}]`);
  console.log(`  抓完再算一轮 claude all=$${Number(compute(cache).payload.claude?.ranges?.all?.cost ?? 0).toFixed(4)}`
    + ` 失败后文件=${fs.readFileSync(copy, "utf8") === snapshot ? "一模一样" : "被改动了"}`);
  fs.rmSync(home, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exitCode = 1; });

/**
 * 价目表变更重算的真机验证：拿本机真实 Claude/Codex 转录跑两轮 compute()，
 * 中间只改价目文件、不碰转录。缓存里那份条目 sig 不变（不会重新解析），
 * 成本却跟着新价走 —— 这就是指纹那条路。
 * HOME 指到临时目录：账本、快照都写临时目录，绝不写用户真实的 ~/.tokei。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const realHome = os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-reprice-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TOKEI_CLAUDE_DIR = path.join(realHome, ".claude", "projects");
process.env.TOKEI_CODEX_DIR = path.join(realHome, ".codex", "sessions");
process.env.TOKEI_CODEX_ARCHIVED_DIR = path.join(realHome, ".codex", "archived_sessions");

const { compute } = require("../dist/core/compute");
const { initPricing, pricingFingerprint, rawPrice, resolveId } = require("../dist/core/price");
const resourceDir = path.resolve(__dirname, "..", "resources");
initPricing(resourceDir);

const tokeiDir = path.join(home, ".tokei");
fs.mkdirSync(tokeiDir, { recursive: true });

const cache = {};
function roundCosts() {
  // 缓存条目里现存的读数：claude 看事件 cost（重计价是就地改这个对象），
  // codex 看日账里各模型的 cost 合计（重建那条路会换掉日账对象，只能从缓存重新取）
  const events = [];
  for (const [file, entry] of Object.entries(cache.claude ?? {})) {
    for (const event of entry.events ?? []) {
      if (event.cost > 0) events.push({ file: path.basename(file), model: event.model, ref: event });
    }
  }
  let codexTotal = 0;
  let codexDays = 0;
  for (const entry of Object.values(cache.codex ?? {})) {
    for (const day of Object.values(entry.days ?? {})) {
      codexDays++;
      for (const detail of Object.values(day.models ?? {})) codexTotal += Number(detail.cost) || 0;
    }
  }
  return { events, codexTotal, codexDays };
}

function snapshot(label) {
  const { payload, errors } = compute(cache);
  const r = (tool) => {
    const ranges = payload[tool]?.ranges ?? {};
    return ["today", "week", "month", "all"]
      .map((k) => `${k}=$${Number(ranges[k]?.cost ?? 0).toFixed(4)}`)
      .join(" ");
  };
  console.log(`[${label}] 指纹=${pricingFingerprint().slice(0, 12)} `
    + `缓存条目=claude:${Object.keys(cache.claude ?? {}).length}/codex:${Object.keys(cache.codex ?? {}).length} `
    + `区间读数 claude:${r("claude")} codex:${r("codex")} 错误=${Object.keys(errors).join(",") || "无"}`);
  return roundCosts();
}

const first = snapshot("第一轮 基线价");
const picked = first.events.slice(0, 4);
console.log(`  缓存里有成本的 claude 事件 ${first.events.length} 条，codex 日账模型合计 $${first.codexTotal.toFixed(6)}`);
for (const item of picked) console.log(`  探针 ${item.file} ${item.model} → $${item.ref.cost.toFixed(6)}（原价 in=${rawPrice(item.model).in}）`);

// 从缓存里取出本机真实用到的模型 id（这才改得动读数），逐个把输入价翻倍写进本地覆盖表：
// ~/.tokei/pricing_overrides.json 是查找链的最高优先级，builtin 覆盖也压得过它。
const used = new Set();
for (const entry of Object.values(cache.claude ?? {})) for (const e of entry.events ?? []) if (e.model) used.add(e.model);
const codexModels = new Set();
for (const entry of Object.values(cache.codex ?? {})) {
  if (entry.active_model) used.add(entry.active_model);
  for (const day of Object.values(entry.days ?? {})) {
    for (const model of Object.keys(day.models ?? {})) {
      codexModels.add(model);
      used.add(model);
    }
  }
}
// Codex 的单价来自 _codex_price_model()：没有公开价的（codex-auto-review 这类）借 openai/gpt-5.5 的价，
// 所以名单里要连这个参照价一起翻，否则日账重算了、算出来的还是同一个数。
used.add("openai/gpt-5.5");
console.log(`codex 日账里的模型键：${[...codexModels].join(", ") || "无"}`);
const overrides = { models: {} };
for (const model of used) {
  // 覆盖表按"实际查到哪个价"的 id 写：日志里的原始名不一定就是价目表 id。
  // in 与 out 一起翻倍：Codex 的用量常年全命中缓存，只动 in 的话成本公式里那一项是 0，
  // 看不出重算有没有发生（不是没重算，是这一项本来就不参与）。
  const id = resolveId(model);
  const price = rawPrice(model);
  if (!id || !(price.in > 0) || !(price.out > 0)) continue;
  overrides.models[id] = { in: price.in * 2, out: price.out * 2 };
}
fs.writeFileSync(path.join(tokeiDir, "pricing_overrides.json"), JSON.stringify(overrides));
console.log(`真实用到 ${used.size} 个模型，翻倍价的：${Object.keys(overrides.models).join(", ") || "无"}`);

const second = snapshot("第二轮 新价（转录与 sig 都没变）");
for (const item of picked) console.log(`  同一对象再读 ${item.model} → $${item.ref.cost.toFixed(6)}`);
console.log(`  codex 日账模型合计 $${first.codexTotal.toFixed(6)} → $${second.codexTotal.toFixed(6)}（日账数 ${second.codexDays}）`);

// 第三轮：价目表不再动。指纹已在第二轮末尾盖进缓存，这一轮该完全没标记、也没人重算成本。
const before = second.events.map((item) => item.ref.cost);
snapshot("第三轮 价目未变（应无重算）");
const churned = second.events.filter((item, i) => item.ref.cost !== before[i]).length;
console.log(`  成本被改写的条数=${churned} 残留标记=${[
  "_pricing_changed", "_pricing_changed_models", "_pricing_cost_multipliers"].filter((k) => k in cache).join(",") || "无"
} 指纹=${cache._pricing_fingerprint?.slice(0, 12) ?? "未盖"}`);
fs.rmSync(home, { recursive: true, force: true });

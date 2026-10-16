const { compute } = require("../dist/core/compute");
const { projectContributions, projectTrail } = require("../dist/core/trail");
const { initPricing } = require("../dist/core/price");
// 与 cli.js 同法先把价表加载进来，否则 compute() 的补价只会用回退价，成本对不上
initPricing(require("path").resolve(__dirname, "..", "resources"));
const cache = {};
compute(cache);

const wb = cache.workbuddy;
const wbKey = Object.keys(wb)[0];
console.log("workbuddy entry keys:", Object.keys(wb[wbKey]));
console.log("workbuddy record keys:", Object.keys(wb[wbKey].records[0]));

const dh = cache.deepseek_harness;
const dhKey = Object.keys(dh).find((k) => dh[k] && Array.isArray(dh[k].records) && dh[k].records.length);
console.log("deepseek entry:", dhKey && Object.keys(dh[dhKey]), dhKey && JSON.stringify(dh[dhKey].records[0]));

const byTool = {};
for (const c of projectContributions(cache)) {
  const t = (byTool[c.tool] = byTool[c.tool] || { n: 0, tokens: 0, cost: 0, costCny: 0, proj: new Set() });
  t.n++;
  t.tokens += c.tokens;
  t.cost += c.cost;
  t.costCny += c.costCny;
  t.proj.add(c.path);
}
const rows = projectTrail(cache);
for (const [tool, t] of Object.entries(byTool)) {
  console.log(tool.padEnd(16), "contrib", String(t.n).padStart(4), "tokens", String(t.tokens).padStart(12),
    "cost", t.cost.toFixed(2).padStart(8), "cny", t.costCny.toFixed(2).padStart(7), "projects", t.proj.size);
}
const sum = (key) => Object.values(byTool).reduce((a, t) => a + t[key], 0);
console.log("trail rows:", rows.length,
  "| tokens", rows.reduce((a, p) => a + p.tokens, 0), "==", sum("tokens"),
  "| cost", rows.reduce((a, p) => a + p.cost, 0).toFixed(2), "vs", sum("cost").toFixed(2),
  "| cny", rows.reduce((a, p) => a + (p.cost_cny ?? 0), 0).toFixed(2), "vs", sum("costCny").toFixed(2));

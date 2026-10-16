// 临时：按 grok_bot 日账缓存的真实形状造一份 days，喂 providerUsageFromDays 看 range 键与 models 形状
const path = require("path");
const pq = require(path.join(process.cwd(), "dist", "core", "providerQuota.js"));
console.log("导出:", Object.keys(pq).join(", "));
const day = {
  tokens: 1200000, in: 400000, out: 120000, cr: 600000, cw: 0, reason: 80000,
  cost: 3.21, requests: 42,
  models: {
    "grok-4": { name: "grok-4", tokens: 800000, in: 300000, out: 90000, cr: 400000, cw: 0, reason: 10000, cost: 2.1 },
    "grok-code-fast-一个长到要缩字号的模型名": {
      name: "grok-code-fast-一个长到要缩字号的模型名", tokens: 400000, in: 100000, out: 30000,
      cr: 200000, cw: 0, reason: 0, cost: 1.11,
    },
  },
};
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const days = {};
for (let i = 0; i < 400; i += 7) {
  const d = new Date();
  d.setDate(d.getDate() - i);
  days[iso(d)] = day;
}
const usage = pq.providerUsageFromDays(days);
console.log("range 键:", Object.keys(usage.ranges).join(", "));
const all = usage.ranges.all;
console.log("all 顶层:", Object.keys(all).join(", "));
console.log("all.models 是数组吗:", Array.isArray(all.models), JSON.stringify(all.models).slice(0, 300));
console.log("today 有吗:", !!usage.ranges.today, JSON.stringify(usage.ranges.today && usage.ranges.today.models).slice(0, 120));

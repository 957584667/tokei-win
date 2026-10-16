// 临时探路：先用真缓存造一遍面板快照，确认四档区间各有多少内容可量。
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const ENV = { ...process.env, TOKEI_RESOURCE_DIR: `${ROOT.replace(/\\/g, "/")}/resources` };
const r = spawnSync(process.execPath, ["dist/cli.js"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, env: ENV });
const text = r.stdout;
const pay = JSON.parse(text.slice(text.indexOf("{")));
const { buildDashboard } = require(path.join(ROOT, "dist", "core", "dashboard.js"));
for (const p of ["all", "365d", "30d", "7d", "1d"]) {
  const d = buildDashboard(pay, p, new Date(2026, 8, 22, 12, 0, 0));
  console.log(p, "daily=" + d.daily.length, "models=" + d.models.length, "prov=" + d.provider_models.length,
    "tok=" + Math.round(d.wrapped.total_tokens), "active=" + d.wrapped.active_days,
    "proj=" + d.wrapped.projects.length, "ach=" + d.wrapped.achievements.length,
    "first=" + d.wrapped.first_day, "peaks=" + d.wrapped.peak_days.length,
    "tools=" + [...new Set(d.models.map((m) => m.tool))].join("/"));
}
console.log("grok_bot?", !!pay.grok_bot, "keys=" + Object.keys(pay).length);
const all = buildDashboard(pay, "all", new Date(2026, 8, 22, 12, 0, 0));
const nonzero = {};
for (const row of all.daily) {
  for (const [k, v] of Object.entries(row)) if (typeof v === "number" && v > 0) nonzero[k] = (nonzero[k] || 0) + 1;
}
console.log("非零字段:", JSON.stringify(nonzero));
console.log("hours:", all.wrapped.hours.join(","));
console.log("ach:", all.wrapped.achievements.slice(0, 12).map((a) => a.icon + "|" + a.title).join(" / "));

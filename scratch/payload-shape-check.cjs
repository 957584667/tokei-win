/**
 * 临时自检：确认本机 claude/codex 的区间节点到底长什么样 ——
 * ranges.today.models 为空是「真的没数据」还是「字段口径接错」。
 */
const path = require("path");
const { compute } = require("../dist/core/compute");
const { initPricing } = require("../dist/core/price");

initPricing(path.resolve(__dirname, "..", "resources"));
const cache = {};
const { payload, errors } = compute(cache);
console.log("采集异常:", JSON.stringify(errors));

for (const tool of ["claude", "codex"]) {
  const node = payload[tool] ?? {};
  console.log(`\n== ${tool} ==`);
  console.log("区间键:", Object.keys(node.ranges ?? {}).join(","));
  for (const r of ["today", "week", "all"]) {
    const rr = node.ranges?.[r] ?? {};
    console.log(`  ${r}: 键=${Object.keys(rr).join("/")} in=${rr.in} out=${rr.out} `
      + `行 models=${(rr.models ?? []).length} sessions=${rr.sessions}`);
    for (const m of (rr.models ?? []).slice(0, 3)) {
      console.log(`     行: name=${m.name} in=${m.in} out=${m.out} cr=${m.cr} cw=${m.cw}`);
    }
  }
  console.log("  days 天数:", Object.keys(node.days ?? {}).length);
  const days = Object.entries(node.days ?? {}).slice(-3);
  for (const [d, v] of days) {
    console.log(`     ${d}: in=${v?.in} out=${v?.out} 模型数=${Object.keys(v?.models ?? {}).length}`);
  }
}

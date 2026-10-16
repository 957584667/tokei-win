// 一次性核对脚本：把各工具 month 区间的数字打成一页，方便和 Python 版对照
const { spawnSync } = require("child_process");
const r = spawnSync(process.execPath, ["dist/cli.js", "--errors"], { encoding: "utf8", maxBuffer: 1 << 28 });
const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
const money = v => (typeof v === "number" ? (v >= 1000 ? v.toFixed(0) : v.toFixed(2)) : String(v));
const num = v => String(v === undefined ? "-" : v);
for (const [tool, block] of Object.entries(payload)) {
  if (tool.startsWith("_")) continue;
  if (!block) { console.log(`${tool.padEnd(18)} -`); continue; }
  const m = block.ranges && block.ranges.month;
  if (!m) { console.log(`${tool.padEnd(18)} (no ranges) ${Object.keys(block).join(",")}`); continue; }
  if (m.cr === undefined) console.log(`${tool.padEnd(18)} RANGE KEYS: ${Object.keys(m).join(",")}`);
  console.log(`${tool.padEnd(18)} in=${num(m.in).padStart(10)} out=${num(m.out).padStart(9)} cr=${num(m.cr).padStart(11)} cw=${num(m.cw).padStart(9)} sess=${num(m.sessions).padStart(4)} cost=$${money(m.cost)}`);
}
console.log("--- meta ---");
for (const [k, v] of Object.entries(payload)) if (k.startsWith("_")) console.log(k, JSON.stringify(v));
console.log("--- errors ---");
console.log((r.stderr || "").trim() || "(none)");

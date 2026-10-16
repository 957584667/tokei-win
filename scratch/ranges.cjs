const { spawnSync } = require("child_process");
const r = spawnSync(process.execPath, ["dist/cli.js"], { encoding: "utf8", maxBuffer: 1 << 28 });
const p = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
const show = t => {
  const b = p[t];
  if (!b || !b.ranges) { console.log(`${t}: ${JSON.stringify(b).slice(0, 220)}`); return; }
  console.log(`=== ${t} ===`);
  for (const [k, v] of Object.entries(b.ranges)) console.log(`  ${k.padEnd(10)} ${JSON.stringify(v).slice(0, 160)}`);
  console.log(`  days: ${JSON.stringify(b.days ?? {}).slice(0, 300)}`);
};
show("deepseek_harness");
show("qodercli_cn");
show("qodercli");

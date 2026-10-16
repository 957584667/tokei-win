const { compute } = require("../dist/core/compute");
const { displayTokenTotal } = require("../dist/core/model");
const { payload } = compute();
const n = v => Number(v) || 0;
for (const range of ["today", "all"]) {
  let old = 0, now = 0;
  for (const [key, node] of Object.entries(payload)) {
    if (key.startsWith("_") || !node?.ranges) continue;
    const r = node.ranges[range];
    if (!r) continue;
    old += n(r.in) + n(r.out) + n(r.cr) + n(r.cw) + n(r.reason);
    now += displayTokenTotal(r, key);
  }
  console.log(`${range.padEnd(6)} 旧口径=${old.toLocaleString()}  新口径(Swift)=${now.toLocaleString()}  差=${(now - old).toLocaleString()}`);
}

const { compute } = require("../dist/core/compute");
const { displayTokenTotal } = require("../dist/core/model");
const { payload } = compute();
let sumOld = 0, sumNew = 0;
for (const [key, node] of Object.entries(payload)) {
  if (key.startsWith("_") || !node?.ranges) continue;
  const r = node.ranges.month || {};
  const reason = Number(r.reason) || 0;
  if (!reason) continue;
  const n = v => Number(v) || 0;
  const old = n(r.in) + n(r.out) + n(r.cr) + n(r.cw) + reason;
  const now = displayTokenTotal(r, key);
  sumOld += old; sumNew += now;
  console.log(`${key.padEnd(16)} reason=${String(reason).padStart(9)}  含reason=${String(old).padStart(10)}  Swift口径=${String(now).padStart(10)}`);
}
console.log(`合计 含reason=${sumOld}  Swift口径=${sumNew}  差=${sumOld - sumNew}`);

/**
 * 读 scratch/dom-tray-raster.txt 的出图取证结果，逐用例列出画布尺寸与真实墨迹范围，
 * 用来核对「数字没被裁、圆点/沙漏落在数字的哪一格、防休眠角标占了多少位」。
 * 用法：node scratch/tray-geometry-read.cjs [用例名前缀…]
 */
const fs = require("fs");
const path = require("path");
const dom = fs.readFileSync(path.resolve(__dirname, "../scratch/dom-tray-raster.txt"), "utf8");
const body = /id="out">([\s\S]*?)<\/div>/.exec(dom);
if (!body) {
  console.log("探针没写出结果（DOM 里没有 #out）");
  process.exit(1);
}
const lines = body[1].split("\n").map((s) => s.replace(/\r/g, "")).filter(Boolean);
const rows = [];
for (const line of lines) {
  const m = /^(\S+)\s+ok .*画布=(\d+)x(\d+) 墨迹=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\.\.+(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?) 亮像素=(\d+)/.exec(line);
  if (!m) { rows.push({ name: line.split(" ")[0], bad: line }); continue; }
  const [, name, w, h, x0, y0, x1, y1, lit] = m;
  rows.push({ name, w: +w, h: +h, x0: +x0, y0: +y0, x1: +x1, y1: +y1, lit: +lit });
}
const prefixes = process.argv.slice(2);
const picked = prefixes.length ? rows.filter((r) => prefixes.some((p) => r.name.startsWith(p))) : rows;
for (const r of picked) {
  if (r.bad) { console.log("异常 ", r.bad); continue; }
  const 越界 = r.x0 <= 0 || r.x1 >= r.w - 1 ? " ⚠横向贴边" : "";
  console.log(`${r.name.padEnd(40)} 画布 ${String(r.w).padStart(3)}x${r.h}  墨迹 x ${r.x0}..${r.x1}  y ${r.y0}..${r.y1}  亮像素 ${r.lit}${越界}`);
}
console.log(`用例 ${picked.length} / 共 ${rows.length}`);

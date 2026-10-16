/**
 * 出图验证台：把 traySvg() 的真实产物走一遍「data URL → Image → canvas → PNG」，
 * 用 headless Edge（和 Electron 同一个 Chromium）确认解得开、画得出、尺寸对。
 * DRAW 与 src/main/trayRaster.ts 里那份是同一实现（这里不能 require 它，会连带 require('electron')）。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { traySvg } = require("../dist/main/trayIcon.js");

const DRAW = `(async (spec) => {
  const img = new Image();
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(spec.svg);
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("svg decode failed"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = spec.width;
  canvas.height = spec.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, spec.width, spec.height);
  return canvas.toDataURL("image/png");
})`;

const METRICS = [
  { source: "claude5h", remaining: 72, value: "72", color: "#eb8566", window: "hour" },
  { source: "codex5h", remaining: 41, value: "41", color: "#6badfa", window: "hour" },
  { source: "claudeWeek", remaining: 8, value: "8", color: "#eb8566", window: "week" },
];
const STYLES = ["system", "color", "symbols", "dots", "compact", "artistic", "palm"];
const DENSITIES = ["full", "lowest", "icon"];

const cases = [];
for (const style of STYLES) {
  for (const density of DENSITIES) {
    for (const [theme, name] of [["dark", "d"], ["light", "l"]]) {
      const svg = traySvg({
        style, density,
        metrics: density === "icon" ? [] : METRICS.slice(0, density === "full" ? 2 : 1),
        keepAwake: true, scaleFactor: 2,
        theme: name === "d"
          ? { text: "#e8e8ee", glyph: "#ffffff", separator: "#9a9aa4" }
          : { text: "#1f1f24", glyph: "#141416", separator: "#6a6a72" },
      });
      const box = { width: Math.ceil(Number(/width="(\d+(?:\.\d+)?)"/.exec(svg)[1])),
                    height: Math.ceil(Number(/height="(\d+(?:\.\d+)?)"/.exec(svg)[1])) };
      cases.push({ id: `${style}-${density}-${name}`, svg, ...box });
    }
  }
}

const spec = cases.map((c) => ({ id: c.id, width: c.width, height: c.height, svg: c.svg }));
const html = `<!doctype html><meta charset="utf-8"><body><div id="imgs"></div><pre id="out"></pre>
<script>
const CASES = ${JSON.stringify(spec)};
const DRAW = ${DRAW};
(async () => {
  const rows = [];
  for (const c of CASES) {
    try {
      const dataUrl = await DRAW(c);
      const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // 读回 PNG 头，确认尺寸和预期一致（IHDR 的 width/height 在 16/20 字节处）
      const view = new DataView(bytes.buffer);
      rows.push({ id: c.id, want: c.width + "x" + c.height,
        got: view.getUint32(16) + "x" + view.getUint32(20), bytes: bytes.length, b64 });
      const img = new Image();
      img.src = dataUrl;
      img.title = c.id;
      document.getElementById("imgs").appendChild(img);
    } catch (e) { rows.push({ id: c.id, error: String(e && e.message || e) }); }
  }
  document.getElementById("out").textContent = "RASTER " + JSON.stringify(rows);
})();
</script>`;

const page = path.join(__dirname, "raster-check.html");
fs.writeFileSync(page, html);
const dump = path.join(__dirname, "raster-dom.txt");
const res = spawnSync(
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ["--headless=old", "--disable-gpu", "--user-data-dir=" + path.join(__dirname, "edge-profile2"),
   "--virtual-time-budget=15000", "--window-size=900,700", "--dump-dom", "file:///" + page.replace(/\\/g, "/")],
  { encoding: "utf8", maxBuffer: 1 << 28 },
);
fs.writeFileSync(dump, res.stdout || "");
const m = /RASTER (\[[\s\S]*?\])<\/pre>/.exec(res.stdout || "");
if (!m) { console.log("没抓到 RASTER 输出；status=", res.status, "stderr=", (res.stderr || "").slice(0, 300)); process.exit(1); }
const rows = JSON.parse(m[1]);
let bad = 0;
for (const r of rows) {
  if (r.error) { console.log(`${r.id.padEnd(22)} 失败 ${r.error}`); bad++; continue; }
  const ok = r.want === r.got && r.bytes > 200;
  if (!ok) bad++;
  if (!process.argv.includes("--all")) fs.writeFileSync(path.join(__dirname, `raster-${r.id}.png`), Buffer.from(r.b64, "base64"));
  console.log(`${r.id.padEnd(22)} 期望 ${r.want.padEnd(9)} 实际 ${r.got.padEnd(9)} ${String(r.bytes).padStart(6)}B ${ok ? "OK" : "不对"}`);
}
console.log(bad ? `失败 ${bad} 例` : `${rows.length} 例全部出图成功`);

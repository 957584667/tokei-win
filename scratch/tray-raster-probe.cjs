/**
 * 托盘出图链路取证（不启动 Electron）：把 traySvg() 真实产物交给 headless Edge，
 * 用 trayRaster.ts 里那份一字不差的绘制函数画进 canvas 并导出 PNG，
 * 看这条「隐藏渲染进程出图」的路在 Chromium 里到底走不走得通、七档各画出多大的图。
 */
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const T = require(path.join(root, "dist/main/trayIcon.js"));

const theme = { text: "#dddddd", separator: "#8a8a8a", glyph: "#ffffff", background: null };
const metrics = [
  { source: "claude5h", remaining: 62, value: "62", color: "#eb8566", window: "hour" },
  { source: "codexWeek", remaining: 31, value: "31", color: "#10b981", window: "week" },
];
// 过期读数（变淡）、窗口翻篇（「—」）、扫描没回来（「…」）：这三档都要出图取证
const staleMetrics = [
  { ...metrics[0], stale: true },
  { ...metrics[1], stale: true },
];
const resetMetrics = [
  { source: "claude5h", remaining: null, value: "—", color: "#eb8566", window: "hour", stale: true },
  { source: "codexWeek", remaining: null, value: "—", color: "#10b981", window: "week", stale: true },
];
const totalMetrics = [{ source: "total", remaining: null, value: "…", color: "#8a8a8a", window: null }];
const sets = { 新鲜: metrics, 失真: staleMetrics, 重置: resetMetrics, 省略号: totalMetrics };
const cases = [];
for (const density of ["full", "icon"]) {
  for (const style of ["system", "color", "symbols", "dots", "compact", "artistic", "palm"]) {
    for (const [setLabel, set] of Object.entries(sets)) {
      // 防休眠态也要出图：刻度环/圆点/数字三档在数字前多一枚签名角标，占位是新的
      for (const keepAwake of [false, true]) {
        for (const scaleFactor of [1, 1.5]) {
          const svg = T.traySvg({ style, density, metrics: set, keepAwake, scaleFactor, theme });
          const w = /width="([\d.]+)"/.exec(svg)[1], h = /height="([\d.]+)"/.exec(svg)[1];
          cases.push({ name: `${style}/${density}/${setLabel}/${keepAwake ? "防休眠" : "常规"}/x${scaleFactor}`, svg, width: Math.ceil(Number(w)), height: Math.ceil(Number(h)) });
        }
      }
    }
  }
}

// 与 src/main/trayRaster.ts 的 DRAW 保持一致：data URL → Image → canvas → toDataURL
// MEASURE 只做取证：把导出的 PNG 再解一遍，扫出真实墨迹范围，用来核对有没有被画布裁掉
const html = `<!doctype html><html><body><div id="out">pending</div><script>
const CASES = ${JSON.stringify(cases)};
const DRAW = ${(async (spec) => {
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
}).toString()};
const MEASURE = ${(async (dataUrl, width, height) => {
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("png decode failed"));
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, width, height);
  const d = ctx.getImageData(0, 0, width, height).data;
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, lit = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (d[(y * width + x) * 4 + 3] > 24) {
        lit++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  // 横向贴边才是真问题（数字被裁）；纵向只报数，图形本来就贴着任务栏上下沿画
  const clipped = maxX >= width - 1 || minX <= 0;
  return lit ? { box: minX + "," + minY + ".." + maxX + "," + maxY, lit, clipped } : { box: "空白", lit: 0, clipped: false };
}).toString()};
(async () => {
  const lines = [];
  for (const c of CASES) {
    try {
      const u = await eval(DRAW)({ svg: c.svg, width: c.width, height: c.height });
      const comma = u.indexOf(",");
      const b64 = comma < 0 ? "" : u.slice(comma + 1);
      const bytes = atob(b64);
      const sig = [...bytes.slice(0, 8)].map((x) => x.charCodeAt(0).toString(16)).join(" ");
      const m = await eval(MEASURE)(u, c.width, c.height);
      lines.push(c.name + " ok b64=" + b64.length + " png8=" + sig + (sig.startsWith("89 50 4e 47") ? "" : " 非PNG")
        + " 画布=" + c.width + "x" + c.height + " 墨迹=" + m.box + " 亮像素=" + m.lit
        + (m.clipped ? " ⚠贴边" : ""));
    } catch (e) {
      lines.push(c.name + " 失败: " + (e && e.message || e));
    }
  }
  document.getElementById("out").textContent = "\\n" + lines.join("\\n") + "\\n";
})();
</script></body></html>`;
const file = path.join(root, "scratch/panel-tray-raster.html");
fs.writeFileSync(file, html);
console.log(file, "用例=" + cases.length);

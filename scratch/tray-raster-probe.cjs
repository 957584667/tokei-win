/**
 * 托盘出图链路取证（不启动 Electron）：把 traySvg() 真实产物交给 headless Edge，
 * 用 trayRaster.ts 里那份一字不差的绘制函数画进 canvas 并导出 PNG，
 * 看这条「隐藏渲染进程出图」的路在 Chromium 里到底走不走得通、七档各画出多大的图。
 */
const fs = require("fs");
const path = require("path");
const root = "D:/work/ai_code/tokei-win";
const T = require(path.join(root, "dist/main/trayIcon.js"));

const theme = { text: "#dddddd", separator: "#8a8a8a", glyph: "#ffffff", background: null };
const metrics = [
  { source: "claude5h", remaining: 62, value: "62", color: "#eb8566", window: "5h" },
  { source: "codexWeek", remaining: 31, value: "31", color: "#10b981", window: "week" },
];
const cases = [];
for (const density of ["full", "icon"]) {
  for (const style of ["system", "color", "symbols", "dots", "compact", "artistic", "palm"]) {
    for (const scaleFactor of [1, 1.5]) {
      const svg = T.traySvg({ style, density, metrics, keepAwake: false, scaleFactor, theme });
      const w = /width="([\d.]+)"/.exec(svg)[1], h = /height="([\d.]+)"/.exec(svg)[1];
      cases.push({ name: `${style}/${density}/x${scaleFactor}`, svg, width: Math.ceil(Number(w)), height: Math.ceil(Number(h)) });
    }
  }
}

// 与 src/main/trayRaster.ts 的 DRAW 保持一致：data URL → Image → canvas → toDataURL
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
(async () => {
  const lines = [];
  for (const c of CASES) {
    try {
      const u = await eval(DRAW)({ svg: c.svg, width: c.width, height: c.height });
      const comma = u.indexOf(",");
      const b64 = comma < 0 ? "" : u.slice(comma + 1);
      const bytes = atob(b64);
      const sig = [...bytes.slice(0, 8)].map((x) => x.charCodeAt(0).toString(16)).join(" ");
      // 非空判定：PNG 解出来的像素里只要有一个不透明就算画上了
      lines.push(c.name + " ok b64=" + b64.length + " png8=" + sig + (sig.startsWith("89 50 4e 47") ? "" : " 非PNG"));
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

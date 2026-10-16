/**
 * 托盘合成预览：把 trayIcon.traySvg 的所有 style × density 组合写进 HTML，
 * 再用无头 Edge 截图，用来在不能启动 Electron 的环境里逐元素量几何。
 * 只读 dist/，不改动应用代码。每个额度集合出一页，方便分屏截图看清 16px 细节。
 */
const fs = require("fs");
const path = require("path");
const { traySvg, DARK_THEME, LIGHT_THEME } = require("./tsc/main/trayIcon.js");

const STYLES = ["system", "color", "symbols", "dots", "compact", "artistic", "palm"];
const DENSITIES = ["full", "lowest", "icon"];
const STYLE_LABEL = {
  system: "经典白", color: "彩色", symbols: "刻度", dots: "圆点",
  compact: "数字", artistic: "星轨", palm: "椰影",
};

const META = {
  claude5h: { color: "#eb8566", window: "hour" },
  claudeWeek: { color: "#eb8566", window: "week" },
  claudeFable: { color: "#f5ae38", window: "week" },
  codex5h: { color: "#6badfa", window: "hour" },
  codexWeek: { color: "#6badfa", window: "week" },
  kimi5h: { color: "#33c7a8", window: "hour" },
  kimiSubscription: { color: "#33c7a8", window: null },
  grok: { color: "#a6adbf", window: null },
};

// 顺序即 QUOTA_SOURCE_ORDER；数值刻意拉开，方便看出「最紧的那个」有没有被选中
const VALUES = [97, 62, 8, 45, 33, 71, 12, 55];

function metrics(order) {
  // 「今日总量」是额度全为空时的兜底项，没有剩余额度也没有窗口符号
  if (order.length === 1 && order[0] === "total") {
    return [{ source: "total", remaining: null, value: "12.3M", color: DARK_THEME.separator, window: null }];
  }
  return order.map((id) => {
    const remaining = VALUES[Object.keys(META).indexOf(id)];
    return {
      source: id,
      remaining,
      value: String(Math.round(remaining)),
      color: META[id].color,
      window: META[id].window,
    };
  });
}

const SETS = [
  ["默认两项 claude5h+codexWeek", ["claude5h", "codexWeek"]],
  ["全部八项", Object.keys(META)],
  ["紧张 8%+12%", ["claudeFable", "kimiSubscription"]],
  ["单项 100%", ["claude5h"]],
  ["今日总量兜底（本机无额度读数）", ["total"]],
  ["无额度", []],
];

const HEAD = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:12px/1.4 "Segoe UI",sans-serif;background:#1b1b1e;color:#ddd}
h1{margin:10px;font-size:14px;color:#8ab4f8}
.row{display:grid;grid-template-columns:70px 1fr;align-items:center;border-top:1px solid #333}
.name{padding:2px 8px;font-size:11px;color:#9ad}
.strip{display:flex;align-items:center;gap:14px;padding:5px 8px}
.dark{background:#2b2b2f}.light{background:#f3f3f3}
.cell{display:flex;align-items:center;gap:4px}
.cell b{font:9px/1 monospace;color:#666;font-weight:400}
svg{display:block}
</style></head><body>`;

SETS.forEach(([title, order], index) => {
  let html = HEAD + `<h1>${title}</h1>`;
  for (const style of STYLES) {
    html += `<div class="row"><div class="name">${style}<br>${STYLE_LABEL[style]}</div><div>`;
    for (const scale of [1, 2]) {
      const cell = (theme) => DENSITIES.map((density) => {
        const svg = traySvg({ style, density, metrics: metrics(order), keepAwake: false, scaleFactor: scale, theme });
        const width = Number((/width="(\d+(?:\.\d+)?)"/.exec(svg) || [, "0"])[1]);
        return `<div class="cell"><b>${density[0]}·${width}</b>${svg}</div>`;
      }).join("");
      html += `<div class="strip dark">${cell(DARK_THEME)}</div>`;
      html += `<div class="strip light">${cell(LIGHT_THEME)}</div>`;
    }
    html += "</div></div>";
  }
  html += "</body></html>";
  const file = path.join(__dirname, `tray-preview-${index}.html`);
  fs.writeFileSync(file, html, "utf8");
  console.log(file);
});

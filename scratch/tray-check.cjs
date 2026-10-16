/**
 * 离线核对：七种托盘样式在「本机没有额度读数、只有今日总量」时是否真的互不相同。
 * 对应线上链路 updateTray() → traySvg()，这里直接调编译产物，不启动 Electron。
 */
const { traySvg, DARK_THEME } = require("../dist/main/trayIcon.js");

const STYLES = ["system", "color", "symbols", "dots", "compact", "artistic", "palm"];
const DENSITIES = ["full", "lowest", "icon"];

const total = [{ source: "total", remaining: null, value: "12.3M", color: DARK_THEME.separator, window: null }];
const quotas = [
  { source: "claude5h", remaining: 62, value: "62", color: "#eb8566", window: "hour" },
  { source: "codexWeek", remaining: 18, value: "18", color: "#6badfa", window: "week" },
];

function report(label, metrics) {
  const seen = new Map();
  const dup = [];
  for (const style of STYLES) {
    for (const density of DENSITIES) {
      const svg = traySvg({ style, density, metrics, keepAwake: false, theme: DARK_THEME });
      const key = `${style}/${density}`;
      const hash = svg.length + ":" + svg.slice(0, 400);
      if (seen.has(hash)) dup.push(`${key} == ${seen.get(hash)}`);
      else seen.set(hash, key);
    }
  }
  console.log(`${label}：${STYLES.length * DENSITIES.length} 个样式×信息量组合里互不相同的张数 = ${seen.size}`
    + (dup.length ? "；重复：" + dup.join("、") : "（无重复）"));
}

report("今日总量兜底（本机现状）", total);
report("有额度读数（联网后）", quotas);
report("全空（来源全关）", []);

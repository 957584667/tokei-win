/**
 * 分享卡几何取证：用真实的 dist/core/shareCard.js 组 spec，塞进 renderer/share.html 的画法，
 * 在 headless Edge 里量卡片的逐元素几何（宽度、内边距、网格、溢出），并推出 2x 出图像素。
 * 不打开 Electron、不写剪贴板。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const { buildShareSpec } = require(path.join(ROOT, "dist/core/shareCard.js"));
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

function payload() {
  return {
    claude: { ranges: { today: { in: 4820000, out: 910000, cr: 31200000, cw: 640000, cost: 12.34, sessions: 42, hit: 87 } } },
    codex: {
      ranges: { today: { in: 220000, cached: 1800000, out: 130000, reason: 9000, cost: 3.21, sessions: 9, hit: 91 } },
      reserve_ranges: { today: { in: 20000, cached: 90000, out: 9000, reason: 0, cost: 0.4, sessions: 2, hit: 80 } },
    },
    gemini: { ranges: { today: { in: 7000, out: 8000, cached: 9000, thoughts: 1000, cost: 0.2, sessions: 2, hit: 56 } } },
    grok: { ranges: { today: { usage_available: true, in: 1000, out: 2000, cr: 3000, reason: 400, usage_calls: 9, usage_sessions: 3, sessions: 2, cost: 0.7, hit: 30 } } },
    kimicode: { ranges: { today: { in: 100000, out: 200000, cr: 300000, cw: 4000, reason: 0, cost: 9, cost_cny: 60, sessions: 5, hit: 70 } } },
    qoder: { ranges: { today: { in: 4000, cached: 6000, out: 2000, calls: 7, sessions: 1, ctx: 42 } } },
    zcode: { ranges: { today: { in: 1000, out: 2000, cr: 3000, cw: 4000, reason: 0, cost: 0.2, cost_cny: 1.4, sessions: 1, hit: 0 } } },
    minimax: { ranges: { today: { in: 5000000, out: 900000, cr: 1000000, cw: 70000, reason: 12000, cost: 66.6, cost_cny: 480.5, sessions: 12, hit: 64 } } },
  };
}

const CASES = [
  ["overview", { payload: payload(), range: "today", kind: "overview", updated: "更新 09:41:07" }],
  ["overview-empty", { payload: {}, range: "today", kind: "overview" }],
  ["tool", { payload: payload(), range: "today", kind: "tool", toolId: "claude", updated: "更新 09:41:07" }],
  ["tool-big", { payload: payload(), range: "today", kind: "tool", toolId: "minimax", fontScale: 1.12, updated: "更新 09:41:07" }],
];

const PROBE = `
(() => {
  const lines = [];
  const pre = document.createElement("pre");
  pre.id = "probe";
  try {
    const spec = window.__SPEC__;
    const size = window.__renderShare(spec);
    const card = document.querySelector(".share");
    const rect = (n) => { const r = n.getBoundingClientRect(); return "@" + r.left.toFixed(1) + ".." + r.right.toFixed(1) + " " + r.width.toFixed(1) + "x" + r.height.toFixed(1); };
    const clip = (n) => (n.scrollWidth > n.clientWidth + 1 ? "(裁" + n.scrollWidth + "/" + n.clientWidth + ")" : "");
    lines.push("card " + rect(card) + " pad=" + getComputedStyle(card).padding + " 圆角=" + getComputedStyle(card).borderRadius);
    lines.push("size 测量=" + size.width + "x" + size.height + " 出图=" + Math.round(size.width * (window.devicePixelRatio || 1)) + "x" + Math.round(size.height * (window.devicePixelRatio || 1)) + " dpr=" + window.devicePixelRatio);
    const head = card.querySelector(".head");
    lines.push("head " + rect(head) + " 标题=" + getComputedStyle(card.querySelector(".title")).fontSize + " 副标题=" + getComputedStyle(card.querySelector(".sub")).fontSize + clip(card.querySelector(".title")));
    const tools = [...card.querySelectorAll(".tool")];
    lines.push("tools 张数=" + tools.length + " " + tools.map((t) => rect(t)).join(" | "));
    for (const t of tools) {
      const g = t.querySelector(".grid");
      const items = [...t.querySelectorAll(".metric")];
      const h = t.querySelector(".headline b");
      lines.push("  tool '" + t.querySelector(".tool-name").textContent + "' 网格=" + (g ? rect(g) + " 列=" + getComputedStyle(g).gridTemplateColumns : "无")
        + " 指标=" + items.length + (items.length ? " 格宽=" + items.map((i) => i.getBoundingClientRect().width.toFixed(0)).join(",") : "")
        + " 溢出=" + (items.some((i) => i.scrollWidth > i.clientWidth + 1) ? "是" : "否")
        + (h ? " 大数=" + getComputedStyle(h).fontSize : ""));
    }
    const totals = card.querySelector(".totals");
    if (totals) {
      const items = [...totals.querySelectorAll(".metric")];
      lines.push("totals " + rect(totals) + " 指标=" + items.length + " 溢出=" + (items.some((i) => i.scrollWidth > i.clientWidth + 1) ? "是" : "否"));
    }
    const foot = card.querySelector(".foot");
    lines.push("foot " + rect(foot) + " 更新='" + (foot.querySelector(".updated") || { textContent: "" }).textContent + "'");
    const empty = card.querySelector(".empty");
    if (empty) lines.push("empty " + rect(empty) + " '" + empty.textContent + "'");
  } catch (e) {
    lines.push("PROBE-ERROR " + e.message + " @" + (e.stack || "").split("\\n")[1]);
  }
  pre.textContent = lines.join("\\n");
  document.body.appendChild(pre);
})();
`;

let failed = 0;
for (const [name, specInput] of CASES) {
  const spec = buildShareSpec(specInput);
  // 探针页不加 CSP：它要内联 spec 与量测脚本（生产版 share.html 的 CSP 照旧，且同目录加载 share.js）
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<link rel="stylesheet" href="share.css" />
<script>window.__SPEC__ = ${JSON.stringify(spec)};</script>
</head><body><div id="root"></div>
<script src="share.js"></script>
<script>${PROBE}</script>
</body></html>`;
  // 页面必须和 share.js/share.css 同目录加载：file:// 下 CSP 的 'self' 只认同目录，
  // 放到 scratch/ 里引 ../renderer/share.js 会被拦掉（生产环境 share.html 本来就在 renderer/）。
  const file = path.join(ROOT, "renderer", `share-probe-${name}.html`);
  fs.writeFileSync(file, html, "utf8");
  const run = spawnSync(EDGE, [
    "--headless=old", "--disable-gpu", "--no-first-run",
    `--user-data-dir=${path.join(__dirname, `ep-share-${name}`)}`,
    "--virtual-time-budget=8000", "--window-size=900,2400",
    "--dump-dom", `file:///${file.replace(/\\/g, "/")}`,
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  fs.rmSync(path.join(__dirname, `ep-share-${name}`), { recursive: true, force: true });
  if (!process.env.SHARE_KEEP) fs.rmSync(file, { force: true });
  const dom = run.stdout || "";
  const m = /<pre id="probe">([\s\S]*?)<\/pre>/.exec(dom);
  console.log(`=== ${name} ===`);
  if (!m) { console.log("（没有 probe：页面可能没跑起来）"); failed++; continue; }
  console.log(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}
process.exit(failed ? 1 : 0);

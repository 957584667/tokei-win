/**
 * 分享卡的渲染页（UsageShareImage.swift 的版式）：主进程把 core/shareCard.ts 组好的 spec
 * 用 executeJavaScript 传进来，这里只负责画，返回 CSS 像素尺寸让主进程定窗口大小、capturePage。
 *
 * 所有尺寸乘 --r：--r = 2 / devicePixelRatio，所以无论屏幕是多少 DPI，出图都恒为逻辑尺寸的 2 倍。
 * 字号再乘 --fs（面板「字体大小」倍率），对应 Swift 里 Theme.fontSize 跟着面板设置走。
 *
 * 内容全部来自我们自己的 spec（固定工具名、数字、固定色板），仍然统一走 escapeHtml。
 */
const ICONS = {
  timer: '<circle cx="8" cy="9.2" r="4.8"/><path d="M8 6.6v2.6l1.9 1.4M6.3 2.6h3.4M8 2.6v1.8"/>',
  "dollarsign.circle": '<circle cx="8" cy="8" r="5.6"/><path d="M10.1 5.6c-.3-.8-1.2-1.2-2.1-1.2-1.1 0-1.9.6-1.9 1.4 0 2 3.9 1.4 3.9 3.3 0 .9-.9 1.5-2 1.5-1 0-1.8-.5-2.1-1.3M8 3v1.4M8 11.6V13"/>',
  "arrow.down": '<path d="M8 3.2v9.4M4.5 9.1 8 12.6l3.5-3.5"/>',
  "arrow.up": '<path d="M8 12.6V3.2M4.5 6.7 8 3.2l3.5 3.5"/>',
  "bolt.fill": '<path class="fill" d="M9.6 2 4 9.3h3.2l-.9 4.7L12.4 6.5H8.9z"/>',
  "square.stack.3d.up.fill": '<path class="fill" d="M8 2 13.6 4.9 8 7.8 2.4 4.9z"/><path d="M2.5 7.6 8 10.5l5.5-2.9M2.5 10.7 8 13.6l5.5-2.9"/>',
  brain: '<path d="M7.4 3.5a2.1 2.1 0 0 0-3.3 1.6 2 2 0 0 0-.5 3.4 2.1 2.1 0 0 0 1.5 3.3c.8 0 1.6-.4 2.3-1.1M8.6 3.5a2.1 2.1 0 0 1 3.3 1.6 2 2 0 0 1 .5 3.4 2.1 2.1 0 0 1-1.5 3.3c-.8 0-1.6-.4-2.3-1.1M8 3.3v9.8"/>',
  waveform: '<path d="M2 8h1.5L5 3.8l2.4 8.4L9.8 6l1.3 4H14"/>',
  "square.grid.2x2": '<path class="fill" d="M2.6 2.6h4.5v4.5H2.6zM8.9 2.6h4.5v4.5H8.9zM2.6 8.9h4.5v4.5H2.6zM8.9 8.9h4.5v4.5H8.9z"/>',
  "bubble.left.and.bubble.right": '<path d="M2.4 4.6A1.5 1.5 0 0 1 3.9 3.1h5.4a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5H5.4z"/><path d="M8.9 9.9h3.6l2.2 2.2v-4a1.5 1.5 0 0 0-1.5-1.5h-1"/>',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function icon(name) {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

/** 对应 Fmt.human：中文按亿进位，其他语言用 B */
function human(value) {
  const v = Number(value) || 0;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${Math.round(v / 1e3)}K`;
  return `${Math.round(v)}`;
}

/** 对应 nativeMoney：美元恒显示，人民币只在 >0 时并列；不到 1 分写 <$0.01 */
function nativeMoney(usd, cny) {
  const u = Number(usd) || 0;
  const c = Number(cny) || 0;
  const amount = (symbol, value) => (value > 0 && value < 0.005 ? `<${symbol}0.01` : `${symbol}${value.toFixed(2)}`);
  const parts = [];
  if (u > 0 || c <= 0) parts.push(amount("$", u));
  if (c > 0) parts.push(amount("¥", c));
  return parts.join(" + ");
}

function tintAlpha(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return `rgba(255, 255, 255, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function pill(text, tint) {
  return `<span class="pill" style="--tint:${tint};background:${tintAlpha(tint, 0.14)};color:${tint}">${escapeHtml(text)}</span>`;
}

function metricCell(iconName, label, value, tint) {
  return `<div class="metric" style="--ic-bg:${tintAlpha(tint, 0.10)}">`
    + `<span class="ic" style="color:${tint}">${icon(iconName)}</span>`
    + `<span class="mv"><span class="ml">${escapeHtml(label)}</span>`
    + `<span class="val">${escapeHtml(value)}</span></span></div>`;
}

function ringCell(value, label, tint) {
  return `<div class="metric" style="--tint:${tint}">`
    + `<span class="ring" style="--p:${Math.max(0, Math.min(100, Number(value) || 0))}"></span>`
    + `<span class="mv"><span class="ml">${escapeHtml(label)}</span>`
    + `<span class="val">${Math.round(Number(value) || 0)}%</span></span></div>`;
}

function headline(value, caption, tint) {
  return `<div class="headline" style="color:${tint}"><b>${escapeHtml(value)}</b><span>${escapeHtml(caption)}</span></div>`;
}

function toolMetrics(line) {
  const cells = [];
  const money = nativeMoney(line.cost, line.costCny);
  if ((Number(line.cost) || 0) > 0 || (Number(line.costCny) || 0) > 0) {
    cells.push(metricCell("dollarsign.circle", "≈成本", money, line.tint));
  }
  if ((Number(line.hit) || 0) > 0) cells.push(ringCell(line.hit, "Cache Hit", line.tint));
  if ((line.input || 0) > 0) cells.push(metricCell("arrow.down", "输入", human(line.input), line.tint));
  if ((line.output || 0) > 0) cells.push(metricCell("arrow.up", "输出", human(line.output), line.tint));
  if ((line.cacheRead || 0) > 0) cells.push(metricCell("bolt.fill", "缓存读", human(line.cacheRead), line.tint));
  if ((line.cacheWrite || 0) > 0) cells.push(metricCell("square.stack.3d.up.fill", "缓存写", human(line.cacheWrite), line.tint));
  if ((line.reason || 0) > 0) cells.push(metricCell("brain", "推理", human(line.reason), line.tint));
  if ((line.calls || 0) > 0) cells.push(metricCell("waveform", "调用", String(line.calls), line.tint));
  return cells.length ? `<div class="grid">${cells.join("")}</div>` : "";
}

function toolCard(line, rangeLabel, compact) {
  const tint = line.tint;
  const sessions = (Number(line.sessions) || 0) > 0 ? pill(String(line.sessions), tint) : "";
  return `<div class="tool${compact ? "" : " single"}" style="--tint:${tint};--edge:${tintAlpha(tint, 0.35)};--glow:${tintAlpha(tint, 0.55)}">`
    + `<div class="tool-head"><span class="tool-dot"></span>`
    + `<span class="tool-name">${escapeHtml(line.name)}</span>${sessions}</div>`
    + ((line.tokens || 0) > 0 ? headline(human(line.tokens), `${rangeLabel} 总量`, tint) : "")
    + toolMetrics(line)
    + "</div>";
}

function totalsCard(totals, rangeLabel) {
  const cells = [];
  const money = nativeMoney(totals.cost, totals.costCny);
  if (totals.cost > 0 || totals.costCny > 0) cells.push(metricCell("dollarsign.circle", "≈成本", money, "#eb8566"));
  cells.push(metricCell("square.grid.2x2", "工具", String(totals.tools), "#6badfa"));
  if (totals.sessions > 0) cells.push(metricCell("bubble.left.and.bubble.right", "会话", String(totals.sessions), "#9e85eb"));
  if (totals.calls > 0) cells.push(metricCell("waveform", "调用", String(totals.calls), "#a6adbf"));
  if (totals.input > 0) cells.push(metricCell("arrow.down", "输入", human(totals.input), "#eb8566"));
  if (totals.output > 0) cells.push(metricCell("arrow.up", "输出", human(totals.output), "#6badfa"));
  if (totals.cacheRead > 0) cells.push(metricCell("bolt.fill", "缓存读", human(totals.cacheRead), "#66d199"));
  if (totals.cacheWrite > 0) cells.push(metricCell("square.stack.3d.up.fill", "缓存写", human(totals.cacheWrite), "#bd94f2"));
  if (totals.reason > 0) cells.push(metricCell("brain", "推理", human(totals.reason), "#9e85eb"));
  return `<div class="totals"><span class="totals-title">合计明细</span>`
    + (totals.tokens > 0 ? headline(human(totals.tokens), `${rangeLabel} 总量`, "#eb8566") : "")
    + `<div class="grid">${cells.join("")}</div></div>`;
}

function header(spec) {
  const tint = spec.kind === "tool" ? (spec.lines[0]?.tint || "#eb8566") : "#eb8566";
  const sessions = (Number(spec.sessions) || 0) > 0 ? pill(String(spec.sessions), tint) : "";
  return `<div class="head"><span style="color:${tint}">${icon("timer")}</span>`
    + `<div class="text"><div class="row"><span class="title">${escapeHtml(spec.title)}</span>${sessions}</div>`
    + `<span class="sub">${escapeHtml(spec.subtitle)}</span></div></div>`;
}

function footer(spec) {
  return `<div class="foot">`
    + (spec.updatedLine ? `<span class="updated">${escapeHtml(spec.updatedLine)}</span>` : "")
    + `<span class="brand">Tokei · 知度</span></div>`;
}

window.__renderShare = function renderShare(spec) {
  const ratio = 2 / (window.devicePixelRatio || 1);
  const root = document.documentElement;
  root.style.setProperty("--r", String(ratio));
  root.style.setProperty("--fs", String(spec.fontScale || 1));

  const lines = Array.isArray(spec.lines) ? spec.lines : [];
  let body = "";
  if (spec.kind === "tool") {
    body = toolCard(lines[0] || { name: spec.title, tint: "#eb8566" }, spec.rangeLabel, false);
  } else if (!lines.length) {
    body = `<div class="empty">当前范围无可分享的用量</div>`;
  } else {
    body = `<div class="tools" style="display:flex;flex-direction:column;gap:calc(10px * var(--r))">`
      + lines.map((line) => toolCard(line, spec.rangeLabel, true)).join("")
      + "</div>"
      + (spec.totals ? totalsCard(spec.totals, spec.rangeLabel) : "");
  }

  const card = document.createElement("div");
  card.className = "share";
  card.style.width = `${Math.round(spec.width * ratio)}px`;
  card.innerHTML = header(spec) + body + footer(spec);
  document.getElementById("root").replaceChildren(card);

  const rect = card.getBoundingClientRect();
  return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
};

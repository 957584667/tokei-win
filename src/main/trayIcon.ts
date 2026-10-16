/**
 * 托盘图标绘制。对应 macOS 版 MenuBarArtwork / MenuBarTitleRenderer（MenuBarStyle.swift）。
 *
 * Windows 差异：任务栏托盘不支持在图标旁排 NSAttributedString，所以「图标 + 剩余额度数字」
 * 整体合成一张位图 SVG 交给 nativeImage；数字仍是等宽、仍是「剩余百分比」而非已用。
 * 绘制顺序、颜色、沙漏/横块两种窗口符号、额度刻度环都按原版几何移植。
 */
import { MenuBarDensity, MenuBarStyle, QuotaSourceId } from "./settings";

export const TOOL_COLORS: Record<string, string> = {
  claude: "#eb8566",
  codex: "#6badfa",
  gemini: "#9e85eb",
  grok: "#a6adbF".toLowerCase(),
  grok_bot: "#f26aa3",
  qoder: "#e6bf59",
  qoderwork: "#bfa64d",
  qodercli: "#f5d673",
  qodercli_cn: "#fa9e59",
  hermes: "#66d199",
  pi: "#b994f2",
  opencode: "#8cbfe6",
  kimicode: "#33c7a8",
};

export interface Metric {
  /** 「今日总量」是额度全为空时的兜底项，对应 MenuBarMetricKind.total */
  source: QuotaSourceId | "total";
  /** 剩余百分比 0-100，刻度环按它画弧；总量项没有剩余额度，给 null（原版也是 nil） */
  remaining: number | null;
  /** 显示文本，原版是 "%.0f" */
  value: string;
  color: string;
  /** 5 小时窗口画沙漏，周窗口画横块；Kimi 订阅与 Grok 没有确定窗口，给 null */
  window: "hour" | "week" | null;
}

const HEIGHT = 16;
const GLYPH = 18;
const FONT_SIZE = 11;
/** Segoe UI 11px 的数字宽度实测约 6.2px；测试里用它核对不溢出 */
const DIGIT_WIDTH = 6.4;
const SPACING = 3;

function rgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 沙漏 = 5 小时窗口；横块 = 周窗口。几何来自 drawWindowMark */
function windowMark(window: "hour" | "week", cx: number, cy: number, scale: number, color: string): string {
  if (window === "hour") {
    const hw = 1.15 * scale, hh = 2.3 * scale, waist = 0.22 * scale;
    const p = [
      [cx - hw, cy - hh], [cx + hw, cy - hh], [cx + waist, cy],
      [cx + hw, cy + hh], [cx - hw, cy + hh], [cx - waist, cy],
    ].map(([x, y]) => `${round(x)},${round(y)}`).join(" ");
    return `<polygon points="${p}" fill="${color}"/>`;
  }
  const hw = 2.2 * scale, hh = 1.35 * scale;
  return `<rect x="${round(cx - hw)}" y="${round(cy - hh)}" width="${round(hw * 2)}" height="${round(hh * 2)}" fill="${color}"/>`;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 刻度环：底环 22% 透明 + 从 12 点顺时针的剩余弧。progress 下限 0.04 与原版一致 */
function gauge(m: Metric, cx: number, cy: number, size: number, showWindow: boolean): string {
  const scale = size / 11;
  const r = 4.0 * scale;
  const sw = 1.45 * scale;
  const progress = Math.min(Math.max((m.remaining ?? 100) / 100, 0.04), 1);
  const end = { x: cx + r * Math.sin(progress * 2 * Math.PI), y: cy - r * Math.cos(progress * 2 * Math.PI) };
  const large = progress > 0.999 ? 0 : progress > 0.5 ? 1 : 0;
  // progress≈1 时终点与起点重合会画不出整圈，用两段拼
  const arc = progress > 0.999
    ? `M ${round(cx)},${round(cy - r)} A ${round(r)},${round(r)} 0 1 1 ${round(cx)},${round(cy + r)} A ${round(r)},${round(r)} 0 1 1 ${round(cx)},${round(cy - r)}`
    : `M ${round(cx)},${round(cy - r)} A ${round(r)},${round(r)} 0 ${large} 1 ${round(end.x)},${round(end.y)}`;
  const parts = [
    `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(r)}" fill="none" stroke="${rgba(m.color, 0.22)}" stroke-width="${round(sw)}"/>`,
    `<path d="${arc}" fill="none" stroke="${m.color}" stroke-width="${round(sw)}" stroke-linecap="round"/>`,
  ];
  if (showWindow && m.window) parts.push(windowMark(m.window, cx, cy, scale, m.color));
  return parts.join("");
}

/** 圆点样式用的独立窗口符号，不带圆环（windowGlyph） */
function standaloneGlyph(m: Metric, cx: number, cy: number, size: number): string {
  if (!m.window) return `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(size * 0.3)}" fill="${m.color}"/>`;
  return windowMark(m.window, cx, cy, size / 11 * 1.7, m.color);
}

/** ribbonT：横杆贝塞尔 + 竖干贝塞尔。Swift 的 y 轴向上，这里整体翻转 */
function ribbonT(color: string, active: boolean, layered: boolean): string {
  const crossbar = `M 3.85,12.55 C 6.0,15.15 12.0,15.15 14.15,12.55`;
  const stem = `M 9.15,13.65 C 8.65,10.8 9.35,7.35 8.65,5.3`;
  const ink = "#262138";
  const stroke = (d: string, c: string, w: number) =>
    `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  let body: string;
  if (layered) {
    body = [
      stroke(crossbar, ink, 3.55),
      `<defs><linearGradient id="tk-cross" x1="3.85" y1="0" x2="14.15" y2="0" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="#e94a6e"/><stop offset="0.5" stop-color="#f5ae38"/><stop offset="1" stop-color="#29b894"/></linearGradient></defs>`,
      stroke(crossbar, "url(#tk-cross)", 2.0),
      stroke(stem, ink, 3.55),
      stroke(stem, "#f5ae38", 2.0),
    ].join("");
  } else {
    body = stroke(crossbar, color, 2.2) + stroke(stem, color, 2.2);
  }
  const dot = active ? `<circle cx="15.1" cy="2.9" r="1.1" fill="${layered ? "#faeed1" : color}"/>` : "";
  // 翻转后再套 1.18 的放大，与 Swift 的 translate/scale 序列等价
  return `<g transform="translate(0 ${GLYPH}) scale(1 -1)"><g transform="translate(9 9) scale(1.18) translate(-9 -9)">${body}${dot}</g></g>`;
}

function brand(color: string, active: boolean): string {
  return ribbonT(color, active, false);
}
function signature(active: boolean): string {
  return ribbonT("#000", active, true);
}

/** starTrail：两条轨道 + 四角星 + 卫星点。原版是 template 图，这里由主题决定描边色 */
function starTrail(active: boolean, ink = "#000"): string {
  const orbitA = `M 2.55,10.65 C 3.35,4.15 10.85,1.55 14.75,5.35`;
  const orbitB = `M 15.55,7.25 C 15.35,13.35 7.75,16.45 2.85,11.85`;
  const star = `M 9,4.7 C 9.4,7.35 10.65,8.6 13.3,9 C 10.65,9.4 9.4,10.65 9,13.3 C 8.6,10.65 7.35,9.4 4.7,9 C 7.35,8.6 8.6,7.35 9,4.7 Z`;
  const sat = active ? 2.9 : 2.25;
  const extra = active ? `<circle cx="2.75" cy="11.9" r="1.1"/>` : "";
  return `<g transform="translate(0 ${GLYPH}) scale(1 -1)" fill="${ink}" stroke="${ink}">
<path d="${orbitA}" fill="none" stroke-width="1.35" stroke-linecap="round"/>
<path d="${orbitB}" fill="none" stroke-width="1.35" stroke-linecap="round"/>
<path d="${star}" stroke-width="0"/>${extra}
<circle cx="15.05" cy="6.25" r="${round(sat / 2)}" stroke-width="0"/></g>`;
}

const PALM = {
  ink: "#082623", jade: "#63e6a6", teal: "#21b897", gold: "#fdb845", copper: "#f26950", cream: "#faeed1",
};

/** palm：树干 + 5 片叶 + 2 颗椰子。几何按 MenuBarArtwork.palm 原样移植 */
function palm(active: boolean): string {
  const trunk = `M 5.9,1.65 C 6.45,4.5 7.05,8.05 8.75,10.45 C 9.2,10.65 9.65,10.55 10.0,10.35 C 9.1,7.65 8.45,4.0 7.75,1.55 Z`;
  const highlight = `M 7.1,2.35 C 7.35,4.45 7.8,7.0 8.65,8.75`;
  const leaves: Array<[string, string]> = [
    [`M 9.25,10.65 C 7.15,12.9 4.15,13.0 2.05,10.95 C 4.25,11.05 7.15,10.0 9.25,10.65 Z`, PALM.teal],
    [`M 9.25,10.65 C 7.95,13.05 6.0,15.1 5.15,15.75 C 6.55,14.1 8.35,11.6 9.25,10.65 Z`, PALM.jade],
    [`M 9.3,10.7 C 9.85,13.0 11.1,15.25 12.05,15.7 C 11.05,14.0 9.65,11.75 9.3,10.7 Z`, PALM.teal],
    [`M 9.35,10.7 C 11.45,13.15 14.35,13.45 16.05,11.75 C 14.15,11.65 11.5,10.15 9.35,10.7 Z`, PALM.jade],
    [`M 9.4,10.6 C 11.85,11.0 14.15,9.65 14.65,8.25 C 13.35,9.0 11.35,9.65 9.4,10.6 Z`, PALM.teal],
  ];
  const coconuts: Array<[number, number]> = [[8.7, 10.25], [10.25, 10.05]];
  const leafMarkup = leaves.map(([d, c]) =>
    `<path d="${d}" fill="${c}" stroke="${PALM.ink}" stroke-width="0.6" stroke-linejoin="round"/>`).join("");
  const nutMarkup = coconuts.map(([x, y]) =>
    `<circle cx="${x}" cy="${y}" r="1.13" fill="${PALM.ink}"/><circle cx="${x}" cy="${y}" r="0.69" fill="${PALM.copper}"/>`).join("");
  const dot = active ? `<circle cx="15.525" cy="3.425" r="1.075" fill="${PALM.cream}"/>` : "";
  return `<g transform="translate(0 ${GLYPH}) scale(1 -1)">
<path d="${trunk}" fill="${PALM.gold}" stroke="${PALM.ink}" stroke-width="0.75" stroke-linejoin="round"/>
${leafMarkup}${nutMarkup}
<path d="${highlight}" fill="none" stroke="${rgba(PALM.cream, 0.72)}" stroke-width="0.48" stroke-linecap="round"/>
${dot}</g>`;
}

export interface TrayRenderInput {
  style: MenuBarStyle;
  density: MenuBarDensity;
  metrics: Metric[];
  keepAwake: boolean;
  /** 比例缩放：Windows 托盘 100% 时 16px，200% 时 32px */
  scaleFactor?: number;
  /** 任务栏配色；缺省按深色底。原版靠 NSImage.isTemplate 自动反色，Windows 托盘没有这个机制 */
  theme?: TrayTheme;
}

export interface TrayTheme {
  /** 额度数字 */
  text: string;
  /** 品牌图形与「星轨」这种单色描边 */
  glyph: string;
  /** 两个额度之间的分隔点 */
  separator: string;
}

export const DARK_THEME: TrayTheme = { text: "#e8e8ee", glyph: "#ffffff", separator: "#9a9aa4" };
export const LIGHT_THEME: TrayTheme = { text: "#1f1f24", glyph: "#141416", separator: "#6a6a72" };

/**
 * 与 MenuBarTitleRenderer.render 相同的分支：先按 density 裁剪要显示的几个额度，
 * 再按 style 决定「环/点/纯数字/带品牌图」的组合。
 */
export function layout(input: TrayRenderInput): { width: number; parts: string[] } {
  const scale = Math.max(1, input.scaleFactor ?? 1);
  const theme = input.theme ?? DARK_THEME;
  const visible = visibleMetrics(input.metrics, input.density);
  const focused = focusMetric(input.metrics);
  const parts: string[] = [];
  let x = 2 * scale;
  const cy = HEIGHT * scale / 2;

  const text = (value: string, fill: string) => {
    const w = value.length * DIGIT_WIDTH * scale;
    parts.push(`<text x="${round(x)}" y="${round(cy + FONT_SIZE * scale * 0.36)}" font-family='Segoe UI, Microsoft YaHei, sans-serif' font-size="${round(FONT_SIZE * scale)}" font-weight="600" fill="${fill}">${escapeXml(value)}</text>`);
    x += w;
  };
  const gap = () => { x += SPACING * scale; };
  const glyphBox = GLYPH * scale;

  if (input.density === "icon") {
    x = iconOnly(parts, input, focused, x, cy, scale, glyphBox, theme);
    return { width: Math.ceil(x + 2 * scale), parts };
  }

  // 「彩色」「数字」两档按工具色上色，其余跟随任务栏配色（原版是 template 图自动反色）
  const tint = (m: Metric) => (input.style === "color" || input.style === "compact" ? m.color : theme.text);
  const leading = (image: string) => { parts.push(place(image, x, cy, glyphBox, scale)); x += glyphBox; if (visible.length) gap(); };
  const numberRow = () => visible.forEach((m, i) => { if (i) text(" · ", theme.separator); text(m.value, tint(m)); });

  switch (input.style) {
    case "system":
      leading(brand(theme.glyph, input.keepAwake));
      numberRow();
      break;
    case "color":
      leading(signature(input.keepAwake));
      numberRow();
      break;
    case "artistic":
      leading(starTrail(input.keepAwake, theme.glyph));
      numberRow();
      break;
    case "palm":
      leading(palm(input.keepAwake));
      numberRow();
      break;
    case "symbols":
      visible.forEach((m, i) => {
        if (i) gap();
        const size = 11 * scale;
        parts.push(gauge(m, x + size / 2, cy, size, true));
        x += size; gap();
        text(m.value, tint(m));
      });
      break;
    case "dots":
      visible.forEach((m, i) => {
        if (i) gap();
        const size = 9 * scale;
        // 有窗口的画沙漏/横块，没有窗口的（Kimi 订阅、Grok）退化成圆点
        parts.push(m.window
          ? standaloneGlyph(m, x + size / 2, cy, size)
          : `<circle cx="${round(x + size / 2)}" cy="${round(cy)}" r="${round(2.5 * scale)}" fill="${m.color}"/>`);
        x += size; gap();
        text(m.value, tint(m));
      });
      break;
    case "compact":
      if (input.keepAwake) leading(signature(true));
      numberRow();
      break;
  }

  // 没有任何额度可画时（额度来源全关、或今日总量也是 0）：原版只在
  // 经典白/刻度/圆点/数字 四档退回品牌图（MenuBarStyle.swift:678 的 fallbackIcon 分支），
  // 彩色/星轨/椰影 在更早的分支里就带着自己的图形 return 了，所以换样式看得出变化。
  if (!visible.length && input.style !== "color" && input.style !== "artistic" && input.style !== "palm") {
    parts.length = 0;
    x = 2 * scale;
    parts.push(place(brand(theme.glyph, input.keepAwake), x, cy, glyphBox, scale));
    return { width: Math.ceil(x + glyphBox + 2 * scale), parts };
  }
  return { width: Math.ceil(x + 2 * scale), parts };
}

function iconOnly(parts: string[], input: TrayRenderInput, focused: Metric | null, x: number, cy: number, scale: number, glyphBox: number, theme: TrayTheme): number {
  const style = input.style;
  if (style === "artistic") { parts.push(place(starTrail(input.keepAwake, theme.glyph), x, cy, glyphBox, scale)); return x + glyphBox; }
  if (style === "palm") { parts.push(place(palm(input.keepAwake), x, cy, glyphBox, scale)); return x + glyphBox; }
  if (input.keepAwake) {
    if (style === "color") { parts.push(place(signature(true), x, cy, glyphBox, scale)); return x + glyphBox; }
    parts.push(place(brand(style === "system" ? theme.glyph : (focused?.color ?? theme.glyph), true), x, cy, glyphBox, scale));
    return x + glyphBox;
  }
  switch (style) {
    case "system": parts.push(place(brand(theme.glyph, false), x, cy, glyphBox, scale)); return x + glyphBox;
    case "compact": parts.push(place(brand(theme.glyph, false), x, cy, glyphBox, scale)); return x + glyphBox;
    case "color": parts.push(place(signature(false), x, cy, glyphBox, scale)); return x + glyphBox;
    case "symbols": parts.push(gauge(focused ?? { source: "claude5h", remaining: 100, value: "", color: theme.glyph, window: null }, x + 8 * scale, cy, 16 * scale, true)); return x + 16 * scale;
    case "dots": {
      const size = 10 * scale;
      if (focused?.window) { parts.push(standaloneGlyph(focused, x + size / 2, cy, size)); return x + size; }
      parts.push(`<circle cx="${round(x + size / 2)}" cy="${round(cy)}" r="${round(3 * scale)}" fill="${focused?.color ?? theme.glyph}"/>`);
      return x + size;
    }
    default: parts.push(place(brand(theme.glyph, false), x, cy, glyphBox, scale)); return x + glyphBox;
  }
}

/** density=full 显示前两个；lowest/icon 显示「最紧的那个」（剩余最少），对应 focusedMetric */
export function visibleMetrics(metrics: Metric[], density: MenuBarDensity): Metric[] {
  if (density === "full") return metrics.slice(0, 2);
  const focused = focusMetric(metrics);
  return focused ? [focused] : metrics.slice(0, 1);
}

export function focusMetric(metrics: Metric[]): Metric | null {
  // 只有「剩余百分比」可比的项参与选最紧的；今日总量项没有剩余额度（原版 focusedMetric 只看 quota）
  const quotas = metrics.filter((m): m is Metric & { remaining: number } => typeof m.remaining === "number");
  if (quotas.length) return quotas.reduce((a, b) => (a.remaining < b.remaining ? a : b));
  return metrics[0] ?? null;
}

/** 18 单位高的图形放进以 (x, cy) 为左上、边长 box 的格子里 */
function place(inner: string, x: number, cy: number, box: number, _scale: number): string {
  return `<g transform="translate(${round(x)} ${round(cy - box / 2)}) scale(${round(box / GLYPH)})">${inner}</g>`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] as string));
}

export function traySvg(input: TrayRenderInput): string {
  const scale = Math.max(1, input.scaleFactor ?? 1);
  const { width, parts } = layout(input);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(HEIGHT * scale)}" `
    + `viewBox="0 0 ${width} ${Math.round(HEIGHT * scale)}">${parts.join("")}</svg>`;
}

/**
 * 托盘出图。Windows 的 nativeImage 没有 SVG 解码器（Electron 只在 macOS 走 NSImage 那条路），
 * 直接把 SVG 文本喂给 createFromBuffer 会得到一张空图，任务栏上就是空白块。
 * 这里用一个隐藏的渲染进程把同一份 traySvg() 画进 canvas，导出 PNG 再交给 Tray，
 * 好处是字形（Segoe UI 数字）和描边都由 Chromium 光栅化，不用自己实现渲染。
 *
 * 出图窗是全进程复用的：它一旦卡死或悄悄失败，托盘就永远停在初始那张品牌图上，
 * 换样式、换信息量都看不出差别。所以每条出口都设超时、失败即弃窗重建，
 * 并把最后一次成败留个凭据给设置页的诊断段看，不再静默吞异常。
 */
import { BrowserWindow } from "electron";

/** 等就绪 / 单次绘制的上限：宁可这一轮退回上一张图，也不能让后续更新全排在死 promise 后面 */
const READY_TIMEOUT_MS = 2000;
const DRAW_TIMEOUT_MS = 3000;

/** 在页面里跑的绘制函数；参数用 JSON 传，返回值是 PNG 的 data URL */
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

/** 在途的建窗 promise 与现役窗要一起清：只清一个就会留下谁也等不到的 promise */
let inflight: Promise<BrowserWindow | null> | null = null;
let current: BrowserWindow | null = null;
/** 最后一次出图的结论，只给诊断段用：ok 尺寸 字节数 / 失败: 原因 */
let lastStatus = "尚未出图";

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

/** 弃窗：下一次更新自然重建，失败不能是永久的 */
function drop(win: BrowserWindow | null): void {
  inflight = null;
  current = null;
  if (win && !win.isDestroyed()) win.destroy();
}

/**
 * 建一次性出图窗。窗口创建时自带的就是 about:blank 这份文档，所以这里不再 loadURL：
 * 同一个 URL 再导航一次不保证再发一遍 did-finish-load，靠那一个事件等就绪就可能永远等下去，
 * promise 一卡死，托盘就一辈子停在初始那张品牌图上（换样式毫无变化）。
 * 现在只「尽力等」任意一个就绪信号，等不到也照样往下画——executeJavaScript 真不行就抛，
 * 抛了弃窗重建，最坏也就是这一次不出图。
 */
async function openWindow(): Promise<BrowserWindow | null> {
  const win = new BrowserWindow({
    width: 80, height: 80, show: false, skipTaskbar: true, focusable: false,
    webPreferences: { backgroundThrottling: false, sandbox: true },
  });
  current = win;
  win.once("closed", () => { if (current === win) drop(null); });
  const ready = new Promise<"ready">((resolve) => {
    if (win.webContents.isDestroyed()) return;
    const done = () => resolve("ready");
    win.webContents.once("dom-ready", done);
    win.webContents.once("did-finish-load", done);
    win.webContents.once("did-stop-loading", done);
  });
  const outcome = await Promise.race([ready, delay(READY_TIMEOUT_MS)]);
  if (outcome !== "ready" && !win.isDestroyed()) {
    // 超时不判死：照样带着这张窗去画，成不成由 executeJavaScript 自己说
    lastStatus = `等就绪超过 ${READY_TIMEOUT_MS}ms，直接尝试绘制`;
  }
  return win;
}

function rasterWindow(): Promise<BrowserWindow | null> {
  if (!inflight) {
    inflight = openWindow().catch((e: unknown) => {
      lastStatus = `失败: 建窗异常 ${(e as Error)?.message || e}`;
      drop(current);
      return null;
    });
  }
  return inflight;
}

/** 成功返回 PNG 缓冲，失败返回 null（调用方保留上一张图，别让托盘变空） */
export async function rasterizeTray(svg: string, width: number, height: number): Promise<Buffer | null> {
  try {
    const win = await rasterWindow();
    if (!win) return null;
    if (win.isDestroyed()) {
      lastStatus = "失败: 出图窗已关闭";
      drop(null);
      return null;
    }
    const raced = await Promise.race([
      win.webContents.executeJavaScript(`${DRAW}(${JSON.stringify({ svg, width, height })})`),
      delay(DRAW_TIMEOUT_MS),
    ]);
    if (raced === "timeout") {
      lastStatus = `失败: 绘制超过 ${DRAW_TIMEOUT_MS}ms`;
      drop(win);
      return null;
    }
    const dataUrl = String(raced ?? "");
    const comma = dataUrl.indexOf(",");
    if (comma < 0) {
      lastStatus = "失败: 返回值不是 data URL";
      drop(win);
      return null;
    }
    const png = Buffer.from(dataUrl.slice(comma + 1), "base64");
    if (!png.length) {
      lastStatus = "失败: PNG 为空";
      drop(win);
      return null;
    }
    lastStatus = `ok ${width}x${height} ${png.length}B`;
    return png;
  } catch (e) {
    lastStatus = `失败: ${(e as Error)?.message || e}`;
    // 异常多半出在窗口本身，弃窗重建，别让下一次更新继续排队
    drop(current);
    return null;
  }
}

/** 诊断段用：这一路最后一次到底成没成 */
export function trayRasterStatus(): string {
  return lastStatus;
}

export function closeRasterWindow(): void {
  drop(current);
}

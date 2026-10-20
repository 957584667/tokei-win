/**
 * 分享卡的出图（对应 UsageShareImage 的 ImageRenderer + NSPasteboard 那一段）。
 *
 * Windows 没有 SwiftUI 的 ImageRenderer，这里开一个隐藏窗口加载 renderer/share.html，
 * 把 core/shareCard.ts 组好的 spec 交给页面画，再 capturePage 拿图写剪贴板。
 * 页面自己按 2/devicePixelRatio 换算倍率，所以不管屏幕缩放多少，出来的都是逻辑尺寸的 2 倍
 * （Swift 的 renderScale = 2）。
 *
 * 每次复制只开一个窗口、完事就销毁：分享是低频操作，不值得为它维护一个常驻进程。
 */
import { BrowserWindow, clipboard, ClipboardItem } from "electron";
import * as path from "path";
import { ShareSpec } from "../core/shareCard";

const SHARE_HTML = path.resolve(__dirname, "..", "..", "renderer", "share.html");
/** 画一帧的上限：超时就当这一发失败，用户再点一次 */
const RENDER_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/** 同一时刻只开一个出图窗：连点两下不该叠两个隐藏窗口 */
let busy = false;

export async function copyShareImage(spec: ShareSpec): Promise<boolean> {
  if (busy) return false;
  busy = true;
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({
      width: Math.ceil(spec.width * 2),
      height: 800,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 隐藏窗口默认会被降频，卡片画不完就 capture 会拿到空白
        backgroundThrottling: false,
      },
    });
    await win.loadFile(SHARE_HTML);
    const draw = `window.__renderShare(${JSON.stringify(spec)})`;
    const size = await withTimeout(win.webContents.executeJavaScript(draw), RENDER_TIMEOUT_MS);
    const width = Math.ceil(Number(size?.width) || 0);
    const height = Math.ceil(Number(size?.height) || 0);
    if (width <= 0 || height <= 0) return false;

    win.setContentSize(width, height);
    // 等一次重排与绘制：setContentSize 之后的同一帧里 capture 会拿到旧尺寸的画面
    await new Promise((resolve) => setTimeout(resolve, 40));
    const settled = await withTimeout(win.webContents.executeJavaScript(draw), RENDER_TIMEOUT_MS);
    const finalHeight = Math.ceil(Number(settled?.height) || 0);
    if (finalHeight > 0 && finalHeight !== height) {
      win.setContentSize(width, finalHeight);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) return false;
    // Electron 44 的剪贴板是 Web 标准那套：PNG 字节包成 Blob 再写（writeImage 已不存在）
    await clipboard.write([new ClipboardItem({
      "image/png": new Blob([image.toPNG()], { type: "image/png" }),
    })]);
    return true;
  } catch (e: any) {
    console.error(`[tokei] 分享卡出图失败 ${e?.name ?? "Error"}: ${e?.message ?? e}`);
    return false;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    busy = false;
  }
}

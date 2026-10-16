/**
 * 任务栏配色探测。macOS 的菜单栏会自己反色（NSImage.isTemplate），Windows 托盘位图不会，
 * 所以浅色任务栏下必须换成深色墨迹，否则整条图标看不见。
 * 读 HKCU 的 Themes\\Personalize：Win11 任务栏跟随 AppsUseLightTheme，
 * Win10 跟随 SystemUsesLightTheme；两个都拿不到时按深色处理。
 */
import { execFile } from "child_process";
import { DARK_THEME, LIGHT_THEME, TrayTheme } from "./trayIcon";

const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
const TTL = 60_000;

let cached: { theme: TrayTheme; at: number } | null = null;

function readDword(name: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("reg.exe", ["query", KEY, "/v", name], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
      resolve(m ? parseInt(m[1], 16) : null);
    });
  });
}

/** 异步刷新缓存；失败保持上次的值，首次失败按深色 */
export async function refreshTaskbarTheme(): Promise<TrayTheme> {
  const [apps, system] = await Promise.all([readDword("AppsUseLightTheme"), readDword("SystemUsesLightTheme")]);
  const light = apps ?? system ?? 0;
  cached = { theme: light ? LIGHT_THEME : DARK_THEME, at: Date.now() };
  return cached.theme;
}

export function taskbarTheme(): TrayTheme {
  if (!cached) return DARK_THEME;
  return cached.theme;
}

export function taskbarThemeStale(): boolean {
  return !cached || Date.now() - cached.at > TTL;
}

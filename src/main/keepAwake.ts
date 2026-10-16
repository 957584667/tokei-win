/**
 * 防休眠：对应 KeepAwake.swift。macOS 用两条 IOPMAssertion，Windows 用 powerSaveBlocker 等价：
 * 保持亮屏 = 防关屏(prevent-display-sleep) + 防系统睡眠(prevent-app-suspension)，
 * 允许关屏 = 仅防系统空闲睡眠。
 *
 * 开启状态和定时不落盘（原版重启后就是关的），只有低电量保护开关持久化。
 * 这里不 import electron，断言与电量都由外部注入，方便在无 Electron 的环境里单测。
 */

import { execFile } from "child_process";

export type BlockerType = "prevent-display-sleep" | "prevent-app-suspension";

export interface KeepAwakeSnapshot {
  active: boolean;
  /** 定时到点的本地毫秒时间戳；无限期为 null */
  endsAt: number | null;
  /** false=保持亮屏  true=允许关屏 */
  allowDisplaySleep: boolean;
  lowBatteryGuard: boolean;
}

export interface KeepAwakeDeps {
  startBlocker: (type: BlockerType) => number;
  stopBlocker: (id: number) => void;
  /** 读不到电池（台式机）时返回 null */
  readBattery: () => Promise<{ pct: number; charging: boolean } | null>;
  lowBatteryGuard: () => boolean;
  onChange: () => void;
}

/** 阈值与轮询间隔同 KeepAwake.swift：60 秒查一次，未充电且 ≤20% 就自动停 */
const LOW_BATTERY_PCT = 20;
const BATTERY_POLL_MS = 60_000;

export function createKeepAwake(deps: KeepAwakeDeps) {
  let displayID: number | null = null;
  let systemID: number | null = null;
  let endsAt: number | null = null;
  let allowDisplaySleep = false;
  let deadline: NodeJS.Timeout | null = null;
  let batteryTimer: NodeJS.Timeout | null = null;

  function isActive(): boolean {
    return displayID !== null || systemID !== null;
  }

  function snapshot(): KeepAwakeSnapshot {
    return { active: isActive(), endsAt, allowDisplaySleep, lowBatteryGuard: deps.lowBatteryGuard() };
  }

  function clear() {
    if (displayID !== null) { deps.stopBlocker(displayID); displayID = null; }
    if (systemID !== null) { deps.stopBlocker(systemID); systemID = null; }
    if (deadline) { clearTimeout(deadline); deadline = null; }
    stopBatteryPoll();
  }

  function startBatteryPoll() {
    if (batteryTimer || !deps.lowBatteryGuard()) return;
    batteryTimer = setInterval(() => void checkBattery(), BATTERY_POLL_MS);
  }

  function stopBatteryPoll() {
    if (batteryTimer) { clearInterval(batteryTimer); batteryTimer = null; }
  }

  async function checkBattery(): Promise<void> {
    if (!deps.lowBatteryGuard() || !isActive()) return;
    const st = await deps.readBattery();
    if (st && !st.charging && st.pct <= LOW_BATTERY_PCT) stop();
  }

  function start(minutes: number | null) {
    clear();
    if (!allowDisplaySleep) displayID = deps.startBlocker("prevent-display-sleep");
    systemID = deps.startBlocker("prevent-app-suspension");
    if (minutes && minutes > 0) {
      endsAt = Date.now() + minutes * 60_000;
      // 定时上限只有 2 小时，不需要担心 setTimeout 的 32 位溢出
      deadline = setTimeout(() => stop(), minutes * 60_000);
    } else {
      endsAt = null;
    }
    startBatteryPoll();
    deps.onChange();
  }

  function stop() {
    clear();
    endsAt = null;
    deps.onChange();
  }

  function toggle() {
    if (isActive()) stop(); else start(null);
  }

  /** 切换模式：运行中就用新选项重建断言，保留剩余时长（KA:88-95） */
  function setMode(nextAllowDisplaySleep: boolean) {
    allowDisplaySleep = nextAllowDisplaySleep;
    if (isActive()) {
      const mins = endsAt === null ? null : Math.max(1, Math.floor((endsAt - Date.now()) / 60_000));
      start(mins);
    } else {
      deps.onChange();
    }
  }

  function setLowBatteryGuard(on: boolean) {
    if (on) startBatteryPoll(); else stopBatteryPoll();
    if (on) void checkBattery();
    deps.onChange();
  }

  return { snapshot, start, stop, toggle, setMode, setLowBatteryGuard, checkBattery, dispose: clear };
}

export type KeepAwake = ReturnType<typeof createKeepAwake>;

/**
 * 电池读数：Electron 不暴露剩余电量，等价 macOS 的 IOPS 快照只能问系统。
 * Win32_Battery 在台式机上查不到，返回 null 表示「没有电池，不设限」。
 */
export function readWindowsBattery(): Promise<{ pct: number; charging: boolean } | null> {
  const script = "$(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue "
    + "| Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress)";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: true, timeout: 5000 },
      (err: Error | null, stdout: string) => {
        if (err || !stdout) return resolve(null);
        let raw: any;
        try {
          raw = JSON.parse(stdout.trim());
        } catch {
          return resolve(null);
        }
        if (Array.isArray(raw)) raw = raw[0];
        const pct = Number(raw?.EstimatedChargeRemaining);
        if (!Number.isFinite(pct)) return resolve(null);
        // BatteryStatus:1=放电 2=交流 3=充满 4=低 5=严重
        const status = Number(raw?.BatteryStatus);
        return resolve({ pct: Math.round(pct), charging: status === 2 || status === 3 });
      });
  });
}

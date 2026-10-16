/** 面板渲染进程的唯一入口：把主进程 IPC 挂到 window.tokei 上 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("tokei", {
  getUsage: () => ipcRenderer.invoke("get-usage"),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSettings: (patch: Record<string, any>) => ipcRenderer.invoke("set-settings", patch),
  refreshNow: () => ipcRenderer.invoke("refresh-now"),
  hidePanel: () => ipcRenderer.invoke("hide-panel"),
  setPanelWidth: (width: number) => ipcRenderer.invoke("set-panel-width", width),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  getProjects: () => ipcRenderer.invoke("get-projects"),
  getQuotaHistory: (spanHours: number) => ipcRenderer.invoke("get-quota-history", spanHours),
  // 额度详情：契约是 Promise<QuotaDetailPayload | null>；进「额度」页要传 force=true
  // 绕开主进程那 30 秒新鲜期，否则会被上一轮的快照顶回去
  getQuotaDetail: (force?: boolean) => ipcRenderer.invoke("get-quota-detail", force === true),
  // 面板数据：契约是 Promise<DashboardPayload | null>；切区间或刚扫完要传 force=true 绕开新鲜期
  getDashboard: (period?: string, force?: boolean) => ipcRenderer.invoke("get-dashboard", period ?? "all", force === true),
  openProject: (projectPath: string, target: string) => ipcRenderer.invoke("open-project", projectPath, target),
  copyProjectPath: (projectPath: string) => ipcRenderer.invoke("copy-project-path", projectPath),
  // 诊断段：起一份 dist/cli.js 跑全量扫描，拿回原版那份逐行报告
  runDiagnostics: () => ipcRenderer.invoke("run-diagnostics"),
  copyText: (text: string) => ipcRenderer.invoke("copy-text", text),
  homeDir: () => ipcRenderer.invoke("home-dir"),
  credentialStatus: () => ipcRenderer.invoke("credential-status"),
  saveProviderSettings: (input: Record<string, any>) => ipcRenderer.invoke("provider-save", input),
  clearProviderSecret: (provider: string) => ipcRenderer.invoke("provider-clear", provider),
  appVersion: () => ipcRenderer.invoke("app-version"),
  quitApp: () => ipcRenderer.invoke("quit-app"),
  keepAwakeStatus: () => ipcRenderer.invoke("keep-awake-status"),
  keepAwakeStart: (minutes: number | null) => ipcRenderer.invoke("keep-awake-start", minutes),
  keepAwakeStop: () => ipcRenderer.invoke("keep-awake-stop"),
  keepAwakeMode: (allowDisplaySleep: boolean) => ipcRenderer.invoke("keep-awake-mode", allowDisplaySleep),
  keepAwakeLowBattery: (on: boolean) => ipcRenderer.invoke("keep-awake-low-battery", on),
  sitTest: () => ipcRenderer.invoke("sit-test"),
  copyPanelImage: () => ipcRenderer.invoke("copy-panel-image"),
  copyCardImage: (rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("copy-card-image", rect),
  onUsage: (handler: (payload: any) => void) => {
    const listener = (_e: unknown, payload: any) => handler(payload);
    ipcRenderer.on("usage", listener);
    return () => ipcRenderer.removeListener("usage", listener);
  },
  onKeepAwake: (handler: (status: any) => void) => {
    const listener = (_e: unknown, status: any) => handler(status);
    ipcRenderer.on("keep-awake", listener);
    return () => ipcRenderer.removeListener("keep-awake", listener);
  },
});

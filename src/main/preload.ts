/** 面板渲染进程的唯一入口：把主进程 IPC 挂到 window.tokei 上 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("tokei", {
  getUsage: () => ipcRenderer.invoke("get-usage"),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSettings: (patch: Record<string, any>) => ipcRenderer.invoke("set-settings", patch),
  refreshNow: () => ipcRenderer.invoke("refresh-now"),
  hidePanel: () => ipcRenderer.invoke("hide-panel"),
  // 高度省略 = 只改宽度（换页先落宽度让布局重排，下一帧再量高度发第二发）
  setPanelSize: (width: number, height?: number) => ipcRenderer.invoke("set-panel-size", width, height ?? null),
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
  // 价格表段「全量更新」：主进程联网抓 OpenRouter 价目表，返回 {code, message}
  updatePrices: () => ipcRenderer.invoke("update-prices"),
  // 价格表段「查漏补缺」：起子进程扫本机日志补价，同样只返回 {code, message}
  updateUnknown: () => ipcRenderer.invoke("update-unknown"),
  copyText: (text: string) => ipcRenderer.invoke("copy-text", text),
  homeDir: () => ipcRenderer.invoke("home-dir"),
  credentialStatus: () => ipcRenderer.invoke("credential-status"),
  saveProviderSettings: (input: Record<string, any>) => ipcRenderer.invoke("provider-save", input),
  clearProviderSecret: (provider: string) => ipcRenderer.invoke("provider-clear", provider),
  appVersion: () => ipcRenderer.invoke("app-version"),
  // 更新器：检查/下载/安装都在主进程，渲染进程只拿状态与触发动作
  updateState: () => ipcRenderer.invoke("update-state"),
  checkUpdate: (userInitiated?: boolean) => ipcRenderer.invoke("update-check", userInitiated === true),
  applyUpdate: () => ipcRenderer.invoke("update-apply"),
  quitApp: () => ipcRenderer.invoke("quit-app"),
  keepAwakeStatus: () => ipcRenderer.invoke("keep-awake-status"),
  loginItemStatus: () => ipcRenderer.invoke("get-login-item"),
  keepAwakeStart: (minutes: number | null) => ipcRenderer.invoke("keep-awake-start", minutes),
  keepAwakeStop: () => ipcRenderer.invoke("keep-awake-stop"),
  keepAwakeMode: (allowDisplaySleep: boolean) => ipcRenderer.invoke("keep-awake-mode", allowDisplaySleep),
  keepAwakeLowBattery: (on: boolean) => ipcRenderer.invoke("keep-awake-low-battery", on),
  sitTest: () => ipcRenderer.invoke("sit-test"),
  // 分享卡：只传「哪一页 / 哪个区间 / 哪个工具」，数据由主进程从 payload 组（UsageShareImage）
  copyShareImage: (req: { kind: "overview" | "tool"; range: string; toolId?: string | null }) =>
    ipcRenderer.invoke("copy-share-image", req),
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
  onLoginItem: (handler: (status: any) => void) => {
    const listener = (_e: unknown, status: any) => handler(status);
    ipcRenderer.on("login-item", listener);
    return () => ipcRenderer.removeListener("login-item", listener);
  },
  // 重试那一档没有 payload 可推，主进程只发这一小条（对应 store.lastUpdated = "加载中…(N)"）
  onLoadStatus: (handler: (status: any) => void) => {
    const listener = (_e: unknown, status: any) => handler(status);
    ipcRenderer.on("load-status", listener);
    return () => ipcRenderer.removeListener("load-status", listener);
  },
  onUpdate: (handler: (state: any) => void) => {
    const listener = (_e: unknown, state: any) => handler(state);
    ipcRenderer.on("update", listener);
    return () => ipcRenderer.removeListener("update", listener);
  },
});

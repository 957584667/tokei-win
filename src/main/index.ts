/**
 * Electron 主进程：托盘图标 + 面板窗口 + 刷新循环。
 * 对应 macOS 版 Sources/Tokei/main.swift（NSStatusItem + NSPopover）与 DataLoader.swift。
 *
 * Windows 差异：任务栏托盘不能在图标旁排文字，所以「图标+剩余额度」整体合成一张 SVG，
 * 再交给隐藏渲染进程光栅化成 PNG（nativeImage 在 Windows 解不了 SVG，见 trayRaster.ts）；
 * 悬浮提示承担 tooltip；息屏抑制用 powerSaveBlocker（等价 IOPMAssertion）；
 * 自启用 setLoginItemSettings（等价 SMAppService）；久坐用 powerMonitor.getSystemIdleTime
 * （等价 IOHIDSystem HIDIdleTime）。
 */
import { app, BrowserWindow, Tray, Menu, Notification, ipcMain, screen, shell, powerSaveBlocker, powerMonitor, safeStorage, nativeImage, clipboard, ClipboardItem } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { KimiLiveQuota, LiveQuotas, compute } from "../core/compute";
import { initPricing } from "../core/price";
import { TOKEI_DIR, loadJson, saveJson } from "../core/paths";
import { displayTokenTotal } from "../core/model";
import { traySvg, Metric, TrayTheme, LIGHT_THEME } from "./trayIcon";
import { closeRasterWindow, rasterizeTray, trayRasterStatus } from "./trayRaster";
import { refreshTaskbarTheme, taskbarTheme, taskbarThemeStale } from "./theme";
import { MenuBarStyle, MenuBarDensity, QuotaSourceId, Settings, defaultSettings, loadSettings, saveSettings, quotaSourceEnabled, QUOTA_SOURCE_ORDER, configFlag } from "./settings";
import {
  PROVIDER_SECRETS, ProviderSecret, ZAI_REGIONS, clean, isProviderSecret, providerQuotaFlags, validSub2APIBaseURL,
} from "./providers";
import { makeTrailOps } from "./trailOps";
import { collectorEntry, formatDiagnostics, runCollectorScript } from "./diagnostics";
import { collectQuotas, makeQuotaDeps } from "./quota";
import { KimiLiveResult, kimiQuotaValues } from "./quota/kimiLive";
import { createKeepAwake, readWindowsBattery } from "./keepAwake";
import { QuotaHistoryStore, captureFromPayload } from "./quotaHistory";
import { QuotaDetailStore } from "./quotaDetailStore";
import { DashboardStore, isDashboardPeriod } from "./dashboardStore";
import {
  buildQuotaHistoryFrame, normalizeQuotaSpan, type QuotaHistoryFrame,
} from "../core/quotaProjection";

const RESOURCE_DIR = path.resolve(__dirname, "..", "..", "resources");
const RENDERER_HTML = path.resolve(__dirname, "..", "..", "renderer", "index.html");
const LAST_USAGE_FILE = path.join(TOKEI_DIR, "last_usage.json");
/** SitReminder.swift:12 的 idleAwayThreshold：空闲满 5 分钟算离开电脑，连续用机计时清零 */
const SIT_AWAY_SECONDS = 300;

const SOURCE_META: Record<QuotaSourceId, { label: string; color: string; window: "hour" | "week" | null }> = {
  claude5h: { label: "Claude 5h", color: "#eb8566", window: "hour" },
  claudeWeek: { label: "Claude 周", color: "#eb8566", window: "week" },
  claudeFable: { label: "Claude Fable", color: "#f5ae38", window: "week" },
  codex5h: { label: "Codex 5h", color: "#6badfa", window: "hour" },
  codexWeek: { label: "Codex 周", color: "#6badfa", window: "week" },
  kimi5h: { label: "Kimi 5h", color: "#33c7a8", window: "hour" },
  kimiSubscription: { label: "Kimi 订阅", color: "#33c7a8", window: null },
  grok: { label: "Grok", color: "#a6adbf", window: null },
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  boot();
}

interface Runtime {
  tray: Tray | null;
  panel: BrowserWindow | null;
  payload: Record<string, any> | null;
  errors: Record<string, string>;
  refreshInFlight: boolean;
  refreshPending: boolean;
  lastRefreshMs: number;
  timer: ReturnType<typeof setInterval> | null;
  visible: boolean;
  scanFailed: boolean;
  traySeq: number;
}

function boot(): void {
  const state: Runtime = {
    tray: null, panel: null, payload: null, errors: {},
    refreshInFlight: false, refreshPending: false, lastRefreshMs: 0, timer: null,
    visible: false, scanFailed: false, traySeq: 0,
  };
  const scanCache: Record<string, any> = {};
  const trailOps = makeTrailOps();
  const quotaHistory = new QuotaHistoryStore();
  /**
   * 额度详情：payload/扫描缓存都在主进程内存里（Python 那两份磁盘缓存在这里没有对应物），
   * 所以详情构建只能由主进程把这两样喂给核心层。payloadAgeSeconds 复刻
   * _recent_quota_detail_payload 的 mtime 判定：快照落盘超过 60 秒就不算这一轮的读数。
   */
  const quotaDetail = new QuotaDetailStore({
    payload: () => state.payload,
    cache: () => scanCache,
    payloadAgeSeconds: () => {
      try {
        return Math.floor(Date.now() / 1000) - Math.floor(fs.statSync(LAST_USAGE_FILE).mtimeMs / 1000);
      } catch {
        return null; // 还没写过快照：交给内存里那一份，别让年龄判定把有效读数判死
      }
    },
  });
  let settings: Settings = defaultSettings();
  let lastRun = Date.now();
  /**
   * 面板数据（Dashboard）：逐日成本、模型排行与「Tokei 回顾」。数据源同样是主进程内存里
   * 的那份扫描缓存，compute() 每轮会把 gemini / grok / 三家账号级日账写进去，
   * 所以这里只在渲染进程进「面板」页时算，30 秒新鲜期内复用。
   */
  const dashboard = new DashboardStore({ cache: () => scanCache });
  // 对应 main.swift 的 dashboardPrewarmStarted：整轮扫描结束后只焐一次，之后交给页面自己按区间要
  let dashboardPrewarmStarted = false;
  // 防休眠：断言活在主进程，面板关掉也继续生效（对应 macOS 的 KeepAwake 单例）
  const keepAwake = createKeepAwake({
    startBlocker: (type) => powerSaveBlocker.start(type),
    stopBlocker: (id) => powerSaveBlocker.stop(id),
    readBattery: readWindowsBattery,
    lowBatteryGuard: () => settings.keep_awake_low_battery,
    onChange: () => {
      updateTray();
      applyEnabledTools();
      if (state.panel && !state.panel.isDestroyed()) {
        state.panel.webContents.send("keep-awake", keepAwake.snapshot());
      }
    },
  });
  // 久坐提醒的连续用机起点；0 表示还没开始计（离开过电脑或被关掉提醒就清零）
  let sitWorkStart = 0;

  app.on("second-instance", () => showPanel());

  /** 面板可见 10s，空闲 30s；再按上一轮耗时退避，避免扫描堆积 */
  function targetInterval(): number {
    const wanted = state.visible ? 10_000 : 30_000;
    return Math.max(wanted, state.lastRefreshMs * 2);
  }

  async function refresh(retries = 3): Promise<void> {
    if (state.refreshInFlight) {
      state.refreshPending = true;
      return;
    }
    state.refreshInFlight = true;
    const started = Date.now();
    let payload: Record<string, any> | null = null;
    // 联网额度先取：本地扫描是同步的，取数失败只写各自的 errors 键，不影响这一轮 payload
    const quotaErrors: Record<string, string> = {};
    let live: LiveQuotas = {};
    try {
      const quotas = await collectQuotas(makeQuotaDeps(loadCredential), quotaErrors);
      live = {
        providerQuotas: quotas.providerQuotas,
        codexLive: quotas.codexLive,
        codexResetCards: quotas.codexResetCards,
        grokQuota: quotas.grokQuota,
        qwenwork: quotas.qwenwork,
        kimi: kimiLiveQuota(quotas.kimiLive),
      };
    } catch (e: any) {
      console.error(`[tokei] 联网额度取数失败 ${e?.name ?? "Error"}: ${e?.message ?? e}`);
    }
    try {
      const result = compute(scanCache, undefined, live);
      payload = result.payload;
      state.errors = { ...result.errors, ...quotaErrors };
      // compute 只在自有错误非空时挂 _errors；这里把联网那几路的错误并进来
      if (Object.keys(state.errors).length) payload._errors = state.errors;
      else delete payload._errors;
      state.scanFailed = false;
    } catch (e: any) {
      state.scanFailed = true;
      console.error(`[tokei] 扫描失败 ${e?.name ?? "Error"}: ${e?.message ?? e}`);
    } finally {
      state.lastRefreshMs = Date.now() - started;
      state.refreshInFlight = false;
    }

    if (!payload) {
      // 对应 macOS 版连续 3 次失败才提示：托盘不闪、面板保留旧数据
      if (retries > 0) {
        setTimeout(() => refresh(retries - 1), 3_000);
        return;
      }
      payload = state.payload ?? loadJson<Record<string, any>>(LAST_USAGE_FILE, null as any);
    } else {
      // 对应 main.swift 的 recordQuotaHistory(local)：只有真扫出来的这一轮才留快照，
      // 失败回退到缓存那份不能重复灌进曲线，否则空档会被填成平台。
      quotaHistory.record(captureFromPayload(payload));
      state.payload = payload;
      payload._refresh_ms = state.lastRefreshMs;
      payload._device = { id: settings.device_id, platform: "win32", os_version: `${os.platform()} ${os.release()}` };
      // 这一轮的成败与完成时刻：面板的表头读数（更新 HH:mm:ss / 缓存数据 · 等待刷新）靠这两个键，
      // 所以要让「显示时补发缓存」的那两条路径也带着真实扫描时间，而不是收到推送就当现在是更新时间。
      payload._ok = true;
      payload._at = Date.now();
      saveJson(LAST_USAGE_FILE, payload);
      // 面板开着时把详情缓存焐在 30 秒新鲜期内：权威触发仍是渲染进程进「额度」页那一发
      // getQuotaDetail(true)（对应 app.js 里 loadCurve 的那几处），这里只负责让它一发就拿到
      // 算好的那份，而不是在用户面前才开始读账本与 sync 快照。必须排在 state.payload 赋值
      // 与快照落盘之后，否则算的是上一轮的读数、mtime 年龄还会判成过期。
      if (state.visible) void quotaDetail.load(false);
    }

    updateTray();
    // 面板数据只在没有排队刷新时预热一次（对应 main.swift 的 dashboardPrewarmStarted）：
    // 排在 compute() 之后才拿得到这一轮写进缓存的日账，排在 pending 判断之前会白算一遍。
    if (!state.refreshPending && !dashboardPrewarmStarted) {
      dashboardPrewarmStarted = true;
      void dashboard.load("all", true);
    }
    if (state.panel && !state.panel.isDestroyed()) {
      // _ok/_at 只给面板定表头文案用（成功盖时间戳、失败退回「缓存数据 · 等待刷新」），
      // 不落盘：写进 last_usage.json 的那一份是扫描产物，不带读数的成败。
      state.panel.webContents.send("usage", { ...payload, _ok: !state.scanFailed, _at: Date.now() });
    }
    if (state.refreshPending) {
      state.refreshPending = false;
      setTimeout(() => refresh(), 500);
    }
  }

  /**
   * 对应 MenuBarQuotaSource.metrics(in:)：按 allCases 顺序取「已勾选 + 读数新鲜」的窗口，
   * 并把「已用百分比」换成「剩余百分比」。
   */
  function quotaMetrics(payload: Record<string, any> | null, theme: TrayTheme): Metric[] {
    if (!payload) return [];
    const out: Metric[] = [];
    for (const id of QUOTA_SOURCE_ORDER) {
      if (!quotaSourceEnabled(settings, id)) continue;
      const reading = readingOf(payload, id);
      if (!reading) continue;
      const meta = SOURCE_META[id];
      out.push({
        source: id,
        remaining: Math.max(0, Math.min(100, 100 - reading.used)),
        value: String(Math.round(100 - reading.used)),
        color: meta.color,
        window: meta.window,
      });
    }
    if (out.length) return out;
    // 对应 main.swift:398-446：额度来源全关 → 任务栏只留图标；
    // 有来源开着但一个读数都没有（本机没登录、或该来源要联网）→ 退回今日 token 总量。
    if (!QUOTA_SOURCE_ORDER.some((id) => quotaSourceEnabled(settings, id))) return [];
    const total = summarize("today").tokens;
    // 总量项没有剩余额度，也没有窗口符号；颜色用次级色，与 .secondaryLabelColor 同档
    return total > 0
      ? [{ source: "total", remaining: null, value: formatTokens(total, localeIsChinese(settings.locale)), color: theme.separator, window: null }]
      : [];
  }

  function readingOf(payload: Record<string, any>, id: QuotaSourceId): { used: number } | null {
    const claude = payload.claude ?? {};
    const codex = payload.codex ?? {};
    const kimi = payload.kimicode ?? {};
    const grok = payload.grok ?? {};
    const pick = (used: any, stale: any): { used: number } | null =>
      typeof used === "number" && !stale ? { used } : null;
    switch (id) {
      case "claude5h": return pick(claude.q5, claude.q5_stale);
      case "claudeWeek": return pick(claude.q7, claude.q7_stale);
      case "claudeFable": return pick(claude.qf, claude.qf_stale);
      case "codex5h": return pick(codex.p5, codex.p5_stale);
      case "codexWeek": return pick(codex.pw, codex.pw_stale);
      case "kimi5h": return pick(kimi.p5, kimi.p5_stale);
      case "kimiSubscription": return pick(kimi.pw, kimi.pw_stale);
      case "grok": return pick(grok.pct, grok.stale);
    }
  }

  /** 最近一次真正交给托盘的请求，诊断段用它判断「样式有没有走到出图这一步」 */
  let lastTrayRequest = "";

  function updateTray(): void {
    if (!state.tray) return;
    const theme = taskbarTheme();
    const metrics = quotaMetrics(state.payload, theme);
    const svg = traySvg({
      style: settings.menu_style,
      density: settings.menu_density,
      metrics,
      keepAwake: keepAwake.snapshot().active,
      scaleFactor: displayScaleFactor(),
      theme,
    });
    // 渲染尺寸必须跟 SVG 自己的宽高一致，写死 20×16 会把「图标+数字」整条压扁、数字糊成一团
    const box = svgSize(svg);
    lastTrayRequest = `${settings.menu_style}/${settings.menu_density} ${box.width}x${box.height}`;
    state.tray.setToolTip(trayTooltip(state.payload, metrics));
    void paintTray(svg, box.width, box.height);
  }

  /** 出图是异步的：只让最后一次请求落到托盘，别让旧图盖掉新图 */
  async function paintTray(svg: string, width: number, height: number): Promise<void> {
    const seq = ++state.traySeq;
    let png = await rasterizeTray(svg, width, height);
    // 出图窗可能刚被弃掉（首次启动赶在就绪之前、或上一轮超时），这一轮就补一次：
    // 用户点完样式不该等到下一轮定时刷新才看得见变化。
    if (!png) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (seq === state.traySeq) png = await rasterizeTray(svg, width, height);
    }
    if (seq !== state.traySeq || !state.tray) return;
    // 光栅化失败就退回预生成的品牌图，不能把托盘留成空白块
    state.tray.setImage(png ? nativeImage.createFromBuffer(png) : fallbackIcon());
  }

  function svgSize(svg: string): { width: number; height: number } {
    const w = /width="(\d+(?:\.\d+)?)"/.exec(svg);
    const h = /height="(\d+(?:\.\d+)?)"/.exec(svg);
    return { width: Math.ceil(Number(w?.[1] ?? 16)), height: Math.ceil(Number(h?.[1] ?? 16)) };
  }

  /** 种子图 / 兜底图：resources 里预先光栅化好的 PNG，墨色跟任务栏主题走 */
  function fallbackIcon(): Electron.NativeImage {
    const file = taskbarTheme() === LIGHT_THEME ? "tray-fallback-black.png" : "tray-fallback-white.png";
    return nativeImage.createFromPath(path.join(RESOURCE_DIR, file));
  }

  function displayScaleFactor(): number {
    try {
      return Math.max(1, Math.min(3, screen.getPrimaryDisplay().scaleFactor));
    } catch {
      return 1;
    }
  }

  function trayTooltip(payload: Record<string, any> | null, metrics: Metric[]): string {
    if (!payload) return "Tokei · 正在扫描…";
    const lines: string[] = [];
    const zh = localeIsChinese(settings.locale);
    // macOS 把提示语放在额度前面（main.swift 的 summaryParts.insert(at: 0)）
    if (keepAwake.snapshot().active) lines.push("保持唤醒已开启");
    const today = summarize("today");
    lines.push(`Tokei · 今日 ${formatTokens(today.tokens, zh)} tokens / ${formatUsd(today.cost, today.costCny)}`);
    const all = summarize("all");
    lines.push(`累计 ${formatTokens(all.tokens, zh)} tokens / ${formatUsd(all.cost, all.costCny)}`);
    // 总量项没有剩余额度，按原版只报「今日 12.3M」（main.swift:476-483）
    for (const m of metrics) lines.push(m.remaining === null
      ? `今日 ${m.value}`
      : `${SOURCE_META[m.source as QuotaSourceId].label} 剩余 ${m.remaining.toFixed(0)}%`);
    const running = payload.claude?.session_name && payload.claude.session_name !== "-"
      ? `当前会话 ${payload.claude.session_name} · ${formatTokens(payload.claude.session_total || 0, zh)}`
      : null;
    if (running) lines.push(running);
    const failing = Object.keys(state.errors);
    if (failing.length) lines.push(`采集异常 ${failing.length} 个：${failing.slice(0, 3).join("、")}`);
    return lines.join("\n");
  }

  function summarize(range: string): { tokens: number; cost: number; costCny: number } {
    const acc = { tokens: 0, cost: 0, costCny: 0 };
    if (!state.payload) return acc;
    const disabled = new Set(settings.disabled_tools ?? []);
    for (const [key, node] of Object.entries<any>(state.payload)) {
      if (key.startsWith("_") || disabled.has(key)) continue;
      const r = node?.ranges?.[range];
      if (!r) continue;
      acc.tokens += displayTokenTotal(r, key);
      acc.cost += Number(r.cost) || 0;
      acc.costCny += Number(r.cost_cny) || 0;
    }
    return acc;
  }

  function enabledToolIds(): string[] {
    if (!state.payload) return [];
    const disabled = new Set(settings.disabled_tools ?? []);
    return Object.keys(state.payload).filter((key) =>
      !key.startsWith("_") && state.payload?.[key]?.ranges && !disabled.has(key));
  }

  function applyEnabledTools(): void {
    if (!state.tray) return;
    const menu = Menu.buildFromTemplate([
      { label: "打开面板", click: () => showPanel() },
      { label: "立即刷新", click: () => refresh() },
      { type: "separator" },
      {
        label: "菜单栏信息量",
        submenu: (["full", "lowest", "icon"] as MenuBarDensity[]).map((density) => ({
          label: density === "full" ? "双额度" : density === "lowest" ? "单额度" : "仅图标",
          type: "radio" as const,
          checked: settings.menu_density === density,
          click: () => setSettings({ menu_density: density }),
        })),
      },
      {
        label: "菜单栏样式",
        submenu: (["system", "color", "symbols", "dots", "compact", "artistic", "palm"] as MenuBarStyle[]).map((style) => ({
          label: STYLE_LABEL[style],
          type: "radio" as const,
          checked: settings.menu_style === style,
          click: () => setSettings({ menu_style: style }),
        })),
      },
      {
        label: "状态栏额度",
        submenu: QUOTA_SOURCE_ORDER.map((id) => ({
          label: SOURCE_META[id].label,
          type: "checkbox" as const,
          checked: quotaSourceEnabled(settings, id),
          click: (item: any) => setSettings({
            menu_quota_enabled: { ...settings.menu_quota_enabled, [id]: item.checked },
          }),
        })),
      },
      { type: "separator" },
      {
        label: "开机自启",
        type: "checkbox",
        checked: settings.autostart,
        click: (item: any) => setSettings({ autostart: item.checked }),
      },
      {
        // 面板关掉后托盘是唯一入口，这一项等价于 footer 咖啡钮的左键（无限期）
        label: "防休眠",
        type: "checkbox",
        checked: keepAwake.snapshot().active,
        click: (item: any) => (item.checked ? keepAwake.start(null) : keepAwake.stop()),
      },
      { type: "separator" },
      { label: "退出 Tokei", click: () => app.quit() },
    ]);
    state.tray.setContextMenu(menu);
  }

  const STYLE_LABEL: Record<MenuBarStyle, string> = {
    system: "经典白", color: "彩色", symbols: "刻度", dots: "圆点",
    compact: "数字", artistic: "星轨", palm: "椰影",
  };

  function setSettings(patch: Partial<Settings>): void {
    settings = { ...settings, ...patch };
    saveSettings(settings);
    // 面板里的开关和托盘菜单走同一条路：存了就要生效，不能只落盘
    if (patch.autostart !== undefined) app.setLoginItemSettings({ openAtLogin: settings.autostart });
    // 对应 sitReminder.updateRunning()：改「启用」或改「间隔」都重新起算连续用机时长
    if (patch.sit_reminder_enabled !== undefined || patch.sit_reminder_minutes !== undefined) sitWorkStart = 0;
    // 对应 PV:3353-3363 每个额度开关的 .onChange { store.refresh() }：这三个键决定这一轮
    // 扫不扫网，改完立刻重扫才会马上见到新读数；只落盘的话要等下一轮定时刷新才对得上开关。
    // 设置与采集器共用 ~/.tokei/config.json，重扫时读到的就是刚存下去的这份。
    if (patch.grok_live_quota_enabled !== undefined || patch.qwenwork_quota_enabled !== undefined
      || patch.grok_bot_quota_enabled !== undefined) void refresh();
    updateTray();
    applyEnabledTools();
  }

  function showPanel(): void {
    if (!state.panel || state.panel.isDestroyed()) createPanel();
    const panel = state.panel;
    if (!panel) return;
    positionPanel();
    panel.show();
    panel.focus();
    state.visible = true;
  }

  function createPanel(): void {
    // 对应 Design.swift:77-81（渐变底）+ 6-28（NSVisualEffectView .hudWindow 的实时模糊）。
    // Windows 侧只有 Win11 22H2（build 22621）起有系统亚克力材质；Chromium 里 alpha 只在
    // transparent:true 的窗口上生效，所以材质与渐变要一起吃掉这一个开关。更旧的 Windows
    // 退回渐变中值的实色，避免材质缺失时透出黑底。
    const build = Number(os.release().split(".")[2] || "0");
    const backdrop = process.platform === "win32" && build >= 22621;
    state.panel = new BrowserWindow({
      width: 420,
      height: 640,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      transparent: backdrop,
      backgroundColor: backdrop ? "#00000000" : "#282b34",
      ...(backdrop ? { backgroundMaterial: "acrylic" as const } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    state.panel.loadFile(RENDERER_HTML);
    state.panel.setMenuBarVisibility(false);
    // 对应 macOS 的失焦即收：面板没有常驻开关，失去焦点就关闭
    state.panel.on("blur", () => {
      state.panel?.hide();
      state.visible = false;
    });
    state.panel.on("hide", () => { state.visible = false; });
    const panel = state.panel;
    state.panel.on("show", () => {
      state.visible = true;
      if (state.payload) panel.webContents.send("usage", state.payload);
    });
    panel.webContents.on("did-finish-load", () => {
      if (state.payload) panel.webContents.send("usage", state.payload);
    });
  }

  /** 对应 PanelPlacement.swift：贴着托盘所在的显示器工作区右上角弹出 */
  function positionPanel(): void {
    if (!state.panel) return;
    const bounds = state.tray?.getBounds?.();
    const anchor = bounds ? { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y } : null;
    const display = anchor ? screen.getDisplayNearestPoint(anchor) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const [width, height] = state.panel.getSize();
    const x = Math.round(area.x + area.width - width - 8);
    const y = Math.round(area.y + 8);
    state.panel.setBounds({ x, y, width, height });
  }

  /**
   * 对应 PanelView 的 pageWidth(for: mode) + layout.pageDidChange：宽页（额度曲线、设置）
   * 与窄页（用量、项目）尺寸不同，换页时由主进程改尺寸并按新的宽度重新贴右摆放。
   */
  function setPanelWidth(width: number): void {
    if (!state.panel || state.panel.isDestroyed()) return;
    const wanted = Math.max(320, Math.min(900, Math.round(Number(width)) || 420));
    const [current, height] = state.panel.getSize();
    if (current === wanted) return;
    // resizable:false 在 Windows 上会把窗口的最小/最大尺寸钉死在当前值，直接 setSize 会被夹回去；
    // 改尺寸的瞬间放开、改完再锁回，用户那边依旧拖不动边框。
    state.panel.setResizable(true);
    state.panel.setSize(wanted, height);
    state.panel.setResizable(false);
    positionPanel();
  }

  /**
   * 对应 QuotaHistoryView 的 makeFrame()：跨度、喂曲线的快照切片在这里定，
   * 帧本身由核心层组装（面板几何测量台复用同一个函数，免得两处各算一遍）。
   */
  function quotaHistoryFrame(rawSpan: unknown): QuotaHistoryFrame {
    const span = normalizeQuotaSpan(rawSpan);
    const end = Math.floor(Date.now() / 1000);
    const ranged = quotaHistory.pointsSince(new Date((end - span * 3600) * 1000));
    return buildQuotaHistoryFrame(ranged, quotaHistory.points, span, end);
  }

  ipcMain.handle("get-usage", () => state.payload ?? loadJson<Record<string, any>>(LAST_USAGE_FILE, null as any));
  ipcMain.handle("get-settings", () => settings);
  ipcMain.handle("set-settings", (_e, patch: Record<string, any>) => {
    setSettings(patch as Partial<Settings>);
    return settings;
  });
  ipcMain.handle("refresh-now", async () => { await refresh(); return state.payload; });
  ipcMain.handle("hide-panel", () => { state.panel?.hide(); state.visible = false; });
  ipcMain.handle("set-panel-width", (_e, width: unknown) => setPanelWidth(Number(width)));
  ipcMain.handle("open-external", (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  // 项目足迹按需取数：清单不进 payload，点开这一页才聚合一次（同 macOS 的 --projects）
  ipcMain.handle("get-projects", async () => {
    if (!state.payload) await refresh();
    return trailOps.list(scanCache);
  });
  ipcMain.handle("open-project", (_e, rawPath: unknown, target: unknown) => trailOps.run(rawPath, target));
  ipcMain.handle("copy-project-path", (_e, rawPath: unknown) => {
    if (!trailOps.has(rawPath)) return false;
    clipboard.writeText(String(rawPath));
    return true;
  });
  // 设置页两处「复制到剪贴板」（诊断报告 PV:4052、copyBlock PV:4691）：
  // 原版直接写 NSPasteboard，渲染进程没有剪贴板权限，只能过这一道
  ipcMain.handle("copy-text", (_e, text: unknown) => {
    clipboard.writeText(String(text ?? ""));
    return true;
  });
  // 诊断段（PV:4074-4086）：起子进程跑采集引擎，8 秒超时，报告在主进程拼好再给界面。
  // 末尾多一行 tray:：托盘出图靠一张隐藏的渲染进程，静默失败时任务栏会一直停在初始品牌图，
  // 光看采集报告查不出来，所以把最后一次出图的结论也带进去。
  ipcMain.handle("run-diagnostics", async () =>
    `${formatDiagnostics(await runCollectorScript(collectorEntry(), process.execPath), collectorEntry())}
tray: 最近请求 ${lastTrayRequest || "(还没画过)"} / 出图 ${trayRasterStatus()}`);
  // 额度曲线：跨度决定画多远的快照，按天消耗始终吃全量历史（同 macOS 的 makeFrame）
  ipcMain.handle("get-quota-history", (_e, spanHours: unknown) => quotaHistoryFrame(spanHours));
  // 额度详情：进「额度」页由渲染进程带 force=true 拉一次（与 loadCurve 同一路），
  // 这里只做 30 秒新鲜期内的复用与重入保护，契约是 Promise<QuotaDetailPayload | null>
  ipcMain.handle("get-quota-detail", (_e, force: unknown) => quotaDetail.load(force === true));
  // 面板数据：区间由渲染进程传进来（回顾页切区间就换一份），同样只走 30 秒新鲜期与重入保护。
  // 认不出的区间退回 all —— 与 Swift 那边 WrappedPeriod.rawValue 只有五个取值同语义。
  ipcMain.handle("get-dashboard", (_e, period: unknown, force: unknown) =>
    dashboard.load(isDashboardPeriod(period) ? period : "all", force === true));
  // 路径缩写（~\xxx）由渲染进程做，与原版的客户端侧一致，所以只给主目录
  ipcMain.handle("home-dir", () => os.homedir());
  // 渲染进程只能问「存没存」，拿不到明文：面板用 innerHTML 铺数据，
  // 把密钥交给渲染进程等于给一次注入就等于泄露。
  ipcMain.handle("credential-status", () => providerCredentialStatus());
  ipcMain.handle("provider-save", (_e, input: Record<string, any>) => saveProviderSettings(input));
  ipcMain.handle("provider-clear", (_e, provider: unknown) => clearProviderSecret(provider));
  ipcMain.handle("app-version", () => app.getVersion());
  ipcMain.handle("quit-app", () => { app.quit(); });
  // 防休眠：每个动作都把最新快照还给面板，省一次往返
  ipcMain.handle("keep-awake-status", () => keepAwake.snapshot());
  ipcMain.handle("keep-awake-start", (_e, minutes: unknown) => {
    keepAwake.start(Number.isFinite(Number(minutes)) && Number(minutes) > 0 ? Math.round(Number(minutes)) : null);
    return keepAwake.snapshot();
  });
  ipcMain.handle("keep-awake-stop", () => { keepAwake.stop(); return keepAwake.snapshot(); });
  ipcMain.handle("keep-awake-mode", (_e, allowDisplaySleep: unknown) => {
    keepAwake.setMode(allowDisplaySleep === true);
    return keepAwake.snapshot();
  });
  ipcMain.handle("keep-awake-low-battery", (_e, on: unknown) => {
    setSettings({ keep_awake_low_battery: on === true });
    keepAwake.setLowBatteryGuard(on === true);
    return keepAwake.snapshot();
  });
  // 久坐提醒的「测试提醒」：对应 PanelView.swift:3578 那颗按钮，立刻弹一条通知验证通路
  ipcMain.handle("sit-test", () => { notifySit(true); return true; });
  // 对应 macOS footer 的「复制用量图」：原版用 ImageRenderer 画分享卡，Windows 没有等价渲染器，
  // 这里等价地截面板自己 —— 截到的就是当前这块面板，宽度随页面切换变。
  ipcMain.handle("copy-panel-image", async () => {
    const panel = state.panel;
    if (!panel || panel.isDestroyed()) return false;
    return writeImage(await panel.webContents.capturePage());
  });
  // 单张卡的复制：矩形由渲染进程按卡片在视口里的位置给出（CSS 像素），坐标系与 capturePage 一致
  ipcMain.handle("copy-card-image", async (_e, raw: unknown) => {
    const panel = state.panel;
    if (!panel || panel.isDestroyed() || !raw || typeof raw !== "object") return false;
    const box = raw as Record<string, unknown>;
    const width = Math.round(Number(box.width) || 0);
    const height = Math.round(Number(box.height) || 0);
    if (width <= 0 || height <= 0) return false;
    const image = await panel.webContents.capturePage({
      x: Math.max(0, Math.round(Number(box.x) || 0)),
      y: Math.max(0, Math.round(Number(box.y) || 0)),
      width,
      height,
    });
    return writeImage(image);
  });

  app.whenReady().then(() => {
    initPricing(RESOURCE_DIR);
    settings = loadSettings();
    app.setLoginItemSettings({ openAtLogin: settings.autostart });
    // 防休眠不跨重启恢复（macOS 的 KeepAwake 也从不落盘），所以这里只还原自启

    state.tray = new Tray(fallbackIcon());
    state.tray.on("click", () => (state.panel?.isVisible() ? state.panel.hide() : showPanel()));
    state.tray.on("double-click", () => showPanel());
    state.tray.on("right-click", () => state.tray?.popUpContextMenu());

    updateTray();
    applyEnabledTools();
    refresh();
    // 任务栏配色不是事件可订阅的，60s 轮询一次足够（用户切主题后一分钟内跟上）
    void refreshTaskbarTheme().then(() => updateTray());

    // 对应 main.swift 的 2 秒 tick Timer（.common 模式）
    state.timer = setInterval(() => {
      if (taskbarThemeStale()) void refreshTaskbarTheme().then(() => updateTray());
      if (Date.now() - lastRun >= targetInterval()) {
        lastRun = Date.now();
        refresh();
      }
    }, 2_000);

    // 久坐提醒：对应 SitReminder.swift 的 30 秒 tick。空闲满 5 分钟算「离开电脑」→ 连续用机清零；
    // 没离开就一直累计，累计满设定分钟数弹一次，然后重新起算。
    setInterval(sitTick, 30_000);
  });

  /** IOHIDSystem 的 HIDIdleTime 在 Windows 侧的等价物是 powerMonitor.getSystemIdleTime（秒） */
  function sitTick(): void {
    if (!settings.sit_reminder_enabled) { sitWorkStart = 0; return; }
    if (powerMonitor.getSystemIdleTime() >= SIT_AWAY_SECONDS) { sitWorkStart = 0; return; }
    const now = Date.now();
    if (!sitWorkStart) { sitWorkStart = now; return; }
    if (now - sitWorkStart >= settings.sit_reminder_minutes * 60_000) {
      sitWorkStart = now;
      notifySit(false);
    }
  }

  function notifySit(test: boolean): void {
    new Notification({
      title: "久坐提醒",
      body: test ? "测试提醒：久坐提醒已就绪 ✅" : `已连续用机 ${settings.sit_reminder_minutes} 分钟，起来活动一下 🧍`,
    }).show();
  }

  /** 面板只需要知道哪些 Provider 存了密钥 */
  function providerCredentialStatus(): Record<ProviderSecret, boolean> {
    const out = {} as Record<ProviderSecret, boolean>;
    for (const p of PROVIDER_SECRETS) out[p] = loadCredential(p) !== null;
    return out;
  }

  function providerReply(ok: boolean, result: string) {
    return { ok, result, settings, stored: providerCredentialStatus() };
  }

  /**
   * 对应 saveProviderSettings（PanelView.swift:3199-3227）：URL 不合法整批不写，
   * 空 Key 表示「保持原值」，成功后清掉输入框并刷新。
   */
  function saveProviderSettings(input: Record<string, any>) {
    const url = clean(input?.sub2api_base_url);
    if (url && !validSub2APIBaseURL(url)) return providerReply(false, "Sub2API URL 仅支持 HTTPS 或本机 HTTP");
    const region = (ZAI_REGIONS as readonly string[]).includes(clean(input?.zai_region).toLowerCase())
      ? clean(input?.zai_region).toLowerCase() : "global";
    const keys = input?.keys && typeof input.keys === "object" ? input.keys : {};
    for (const name of Object.keys(keys)) {
      if (!isProviderSecret(name)) return providerReply(false, "保存失败");
    }
    const patch: Partial<Settings> = { sub2api_base_url: url, zai_region: region };
    for (const p of PROVIDER_SECRETS) {
      const value = clean(keys[p]);
      if (value && !saveCredential(p, value)) return providerReply(false, "保存失败");
    }
    setSettings(patch);
    setSettings(providerQuotaFlags(providerCredentialStatus(), settings));
    void refresh();
    return providerReply(true, "已保存");
  }

  /** 对应 clearProviderToken（PanelView.swift:3229-3240）：清完同步关掉该 Provider 的联网开关 */
  function clearProviderSecret(provider: unknown) {
    if (!isProviderSecret(provider)) return providerReply(false, "清除失败");
    if (!clearCredential(provider)) return providerReply(false, "清除失败");
    setSettings(providerQuotaFlags(providerCredentialStatus(), settings));
    void refresh();
    return providerReply(true, "已清除");
  }

  void enabledToolIds;
  void configFlag;

  app.on("window-all-closed", (e?: any) => {
    // 托盘应用不随窗口关闭退出
    e?.preventDefault?.();
  });
  app.on("quit", () => {
    if (state.timer) clearInterval(state.timer);
    keepAwake.dispose();
    closeRasterWindow();
  });
}

/**
 * Electron 44 的剪贴板换成了 Web 标准那套（`clipboard.write(ClipboardItem[])`），
 * 老写法 `writeImage` 已经不存在：PNG 字节包成 Blob 再写。
 */
async function writeImage(image: Electron.NativeImage): Promise<boolean> {
  if (image.isEmpty()) return false;
  await clipboard.write([new ClipboardItem({
    "image/png": new Blob([image.toPNG()], { type: "image/png" }),
  })]);
  return true;
}

/** Fmt.human：中文按「亿」进位，其他语言用 B；K 档不保留小数 */
function formatTokens(n: number, chinese = true): string {
  const v = Number(n) || 0;
  if (chinese && Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (!chinese && Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${Math.round(v / 1e3)}K`;
  return String(Math.round(v));
}

/** nativeMoney：美元恒 $%.2f，人民币只在 >0 时以「 + 」并列，不做汇率换算 */
function formatUsd(usd: number, cny = 0): string {
  const u = Number(usd) || 0, c = Number(cny) || 0;
  const parts: string[] = [];
  if (u > 0 || c <= 0) parts.push(`$${u.toFixed(2)}`);
  if (c > 0) parts.push(`¥${c.toFixed(2)}`);
  return parts.join(" + ");
}

function localeIsChinese(locale: string): boolean {
  if (locale && locale !== "auto") return locale.toLowerCase().startsWith("zh");
  return (app.getLocale() || "zh-CN").toLowerCase().startsWith("zh");
}

// ---- 联网额度：把 kimi 的 live 三元组换成卡片用的 p5/pw/r5/rw ----
/**
 * 对应 13437-13439 与 13572-13578：_kimi_quota_values(limits, updated_at) 加
 * 「q_updated 仅在有时间时给」的规则。没有 live 读数（未开启或取不到）返回 null，
 * payload 那层就退回采集器的日志口径。
 */
function kimiLiveQuota(result: KimiLiveResult): KimiLiveQuota | null {
  if (!result) return null;
  const [limits, plan, updated] = result;
  return {
    ...kimiQuotaValues(limits, { updatedAt: updated }),
    q_updated: updated ? Math.trunc(Number(updated)) : null,
    plan: typeof plan === "string" ? plan : plan ?? null,
  };
}

// ---- 凭据存储：等价 macOS Keychain，Windows 走 DPAPI（Electron safeStorage）----
const CRED_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function credFile(name: string): string {
  return path.join(TOKEI_DIR, `cred-${name}.json`);
}

function saveCredential(name: string, value: string): boolean {
  if (!CRED_NAME.test(name)) return false;
  try {
    const encrypted = safeStorage.isEncryptionAvailable();
    const data = encrypted
      ? safeStorage.encryptString(value).toString("base64")
      : Buffer.from(value, "utf8").toString("base64");
    return saveJson(credFile(name), { v: 1, encrypted, data });
  } catch {
    return false;
  }
}

function loadCredential(name: string): string | null {
  if (!CRED_NAME.test(name)) return null;
  const file = loadJson<{ v: number; encrypted: boolean; data: string }>(credFile(name), null as any);
  if (!file?.data) return null;
  try {
    return file.encrypted && safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(file.data, "base64"))
      : Buffer.from(file.data, "base64").toString("utf8");
  } catch {
    // DPAPI 解不开通常是换了 Windows 账户，而不是文件坏了
    return null;
  }
}

function clearCredential(name: string): boolean {
  if (!CRED_NAME.test(name)) return false;
  try {
    require("fs").rmSync(credFile(name), { force: true });
    return true;
  } catch {
    return false;
  }
}

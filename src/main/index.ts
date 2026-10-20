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
import { app, BrowserWindow, Tray, Menu, Notification, ipcMain, screen, shell, powerSaveBlocker, powerMonitor, safeStorage, nativeImage, clipboard } from "electron";
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
import { MenuBarStyle, MenuBarDensity, QuotaSourceId, Settings, defaultSettings, loadSettings, saveSettings, quotaSourceEnabled, QUOTA_SOURCE_ORDER, configFlag, PANEL_FONT_SCALE } from "./settings";
import {
  PROVIDER_SECRETS, ProviderSecret, ZAI_REGIONS, clean, isProviderSecret, quotaMirror, validSub2APIBaseURL,
} from "./providers";
import { makeTrailOps } from "./trailOps";
import { collectorEntry, formatDiagnostics, runCollectorScript, runPriceUpdateScript } from "./diagnostics";
import { autoFetchPricing, runPriceUpdate } from "./pricingFetch";
import { LAST_USAGE_FILE, loadCachedUsage } from "./usageCache";
import { ActivityReporter } from "./activityReporter";
import { UPDATE_CHECK_INTERVAL, Updater } from "./updater";
import { PANEL_PROVISIONAL, fitPanelSize } from "./panelPlacement";
import { copyShareImage } from "./shareImage";
import { buildShareSpec } from "../core/shareCard";
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
/** SitReminder.swift:12 的 idleAwayThreshold：空闲满 5 分钟算离开电脑，连续用机计时清零 */
const SIT_AWAY_SECONDS = 300;

const SOURCE_META: Record<QuotaSourceId, { label: string; color: string; window: "hour" | "week" | null }> = {
  claude5h: { label: "Claude 5h", color: "#eb8566", window: "hour" },
  claudeWeek: { label: "Claude 周", color: "#eb8566", window: "week" },
  // Fable 与 Claude 周同为周窗口，只能靠颜色分开，所以用系统橙（与面板额度行同色，见 app.js 的 quotaRow）
  claudeFable: { label: "Claude Fable", color: "#ff9f0a", window: "week" },
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
  /** 对应 store.retryCount：只在手上还没有任何数据时累加，扫成功一轮就归零 */
  retryCount: number;
  /** 对应 store.quotaDetailPrewarmPending：打开面板那一发刷新完要把额度详情焐上 */
  quotaPrewarmPending: boolean;
  /** 登录项回读失败的原因，空串表示正常（对应 LoginItemManager.errorMessage） */
  loginError: string;
  /** 手上这份读数来自上一轮落盘的缓存、还没被本轮扫描覆盖（对应 primeCachedUsage 那句「后台更新中」） */
  primed: boolean;
}

function boot(): void {
  const state: Runtime = {
    tray: null, panel: null, payload: null, errors: {},
    refreshInFlight: false, refreshPending: false, lastRefreshMs: 0, timer: null,
    visible: false, scanFailed: false, traySeq: 0,
    retryCount: 0, quotaPrewarmPending: false, loginError: "", primed: false,
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
  // 对应 ActivityReporter.shared：每次启动只试一次，开关关掉时连请求都不建
  const activity = new ActivityReporter();
  /**
   * 对应 Updater.shared：启动查一次，之后每 6 小时一次（main.swift:353/371）。
   * 下载并校验通过后交给系统安装器，随后退出本进程。本地验证版（TOKEI_LOCAL_BUILD=1）
   * 只允许手动检查——和 macOS 的 TokeiLocalBuild 同一个用意，别被线上旧包悄悄换掉。
   */
  const updater = new Updater({
    currentVersion: app.getVersion(),
    isLocalBuild: process.env.TOKEI_LOCAL_BUILD === "1",
    launchInstaller: async (file) => {
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
    },
    onQuit: () => app.quit(),
    onState: (next) => {
      if (state.panel && !state.panel.isDestroyed()) state.panel.webContents.send("update", next);
    },
  });
  let updateTimer: ReturnType<typeof setInterval> | null = null;
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

  /** 重试那一档的表头文案来源（对应 store.lastUpdated = "加载中…(N)"）：没有 payload 可推时单独发 */
  function pushLoadStatus(status: { retry?: number; failed?: boolean }): void {
    if (state.panel && !state.panel.isDestroyed()) state.panel.webContents.send("load-status", status);
  }

  /**
   * 对应 prewarmQuotaDetailIfReady(main.swift:158)：只在「面板开着」且这一发被
   * 打开面板那一刻点过名时取，重入由 QuotaDetailStore 自己的门闩挡。
   */
  function consumeQuotaPrewarm(): void {
    if (!state.quotaPrewarmPending || !state.visible) return;
    state.quotaPrewarmPending = false;
    void quotaDetail.load(true);
  }

  /** 对应 main.swift 的 retryCount < 3：重试三发，每发间隔 3 秒 */
  const RETRY_LIMIT = 3;

  /**
   * 对应 primeCachedUsage（main.swift:55-70）：起进程先把上一轮落盘的读数垫进内存，
   * 托盘从第一秒起就有数字，不用干等第一趟扫描（首刷在数据量大的机器上要走十几秒）。
   * 原版排在启动序列的最后一环之前、refresh() 之前，垫完只重画托盘。
   *
   * 垫之前先把 `_` 开头的内部键全删掉、并重算 Claude 那三路额度的过期标记，
   * 这两件都在 loadCachedUsage() 里做（对应 DataLoader.loadCachedUsage）。
   *
   * 副作用和原版一样：usage 不再是 nil，第一趟扫描失败时 willRetry 判假，直接落到
   * 「缓存数据 · 等待刷新」沿用旧读数，而不是重试三发。同步那半段（loadPeers + merge）
   * 在 Git 多设备同步接上之前没有对应物，见任务 #27。
   */
  function primeCachedUsage(): void {
    if (state.payload) return;
    const cached = loadCachedUsage(LAST_USAGE_FILE);
    if (!cached) return;
    state.payload = cached;
    state.primed = true;
  }

  async function refresh(): Promise<void> {
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
    // 这一发有结果了（成或败都算）：表头从「后台更新中」交回给下面三条分支的文案，
    // 对应 performRefresh 回调里每一次 lastUpdated 赋值都会盖掉 prime 那一句。
    state.primed = false;

    if (!payload) {
      // 对应 main.swift:104-118：只有手上还没有任何数据才重试（有旧读数就安静沿用），
      // 连续 3 次都没扫出来才提示失败；重试期间表头写「加载中…(N)」，托盘不闪。
      const willRetry = !state.payload && state.retryCount < RETRY_LIMIT;
      if (willRetry) {
        state.retryCount += 1;
        pushLoadStatus({ retry: state.retryCount });
        // 已经排着一发（refreshPending）就让它接着重试，别再排第二遍
        if (!state.refreshPending) setTimeout(() => void refresh(), 3_000);
        consumeQuotaPrewarm();
        return;
      }
      payload = state.payload ?? loadCachedUsage(LAST_USAGE_FILE);
      if (!payload) {
        // 一个读数都没有：面板整页落到失败态。这里不能推一份空对象过去，
        // 否则渲染进程会把「没有数据」当成「有缓存」显示成「缓存数据 · 等待刷新」。
        pushLoadStatus({ failed: true });
        consumeQuotaPrewarm();
        updateTray();
        return;
      }
    } else {
      state.retryCount = 0;
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
    consumeQuotaPrewarm();

    updateTray();
    // 面板数据只在没有排队刷新时预热一次（对应 main.swift 的 dashboardPrewarmStarted）：
    // 排在 compute() 之后才拿得到这一轮写进缓存的日账，排在 pending 判断之前会白算一遍。
    if (!state.refreshPending && !dashboardPrewarmStarted) {
      dashboardPrewarmStarted = true;
      void dashboard.load("all", true);
    }
    if (state.panel && !state.panel.isDestroyed()) {
      // _ok/_at 只给面板定表头文案用（成功盖时间戳、失败退回「缓存数据 · 等待刷新」）。
      // 成功那一支是先在 payload 上盖好才落盘的，磁盘那份因此带着上一轮的时刻；
      // 读回来时 loadCachedUsage() 把 `_` 开头的键全剥掉，垫进内存的那份不会把旧时刻冒充本轮。
      state.panel.webContents.send("usage", { ...payload, _ok: !state.scanFailed, _at: Date.now() });
    }
    if (state.refreshPending) {
      state.refreshPending = false;
      setTimeout(() => refresh(), 500);
    }
  }

  /**
   * 对应 MenuBarQuotaSource.metrics(in:)：按 allCases 顺序取「已勾选 + 有读数」的窗口，
   * 并把「已用百分比」换成「剩余百分比」。过期读数照常占位（画淡），不再整项消失。
   */
  function quotaMetrics(payload: Record<string, any> | null, theme: TrayTheme): Metric[] {
    // 扫描还没回来：状态栏先画一个省略号，不能是空白（main.swift:448-450）
    if (!payload) return [{ source: "total", remaining: null, value: "…", color: theme.separator, window: null }];
    const out: Metric[] = [];
    for (const id of QUOTA_SOURCE_ORDER) {
      if (!quotaSourceEnabled(settings, id)) continue;
      const reading = readingOf(payload, id);
      if (!reading) continue;
      const meta = SOURCE_META[id];
      // 读数失真且窗口已经翻篇：那串百分比属于上一个窗口，不能当剩余显示，
      // 也不能按回满算——网页和别的设备都在用同一份额度（SubscriptionQuotaState.swift:26）。
      if (reading.stale && hasResetSinceReading(payload, id)) {
        out.push({ source: id, remaining: null, value: "—", color: meta.color, window: meta.window, stale: true });
        continue;
      }
      // 超额时原版就直接是负数，不做 0-100 钳位（刻度环自己在画法里钳）
      const remaining = 100 - reading.used;
      out.push({
        source: id,
        remaining,
        value: String(Math.round(remaining)),
        color: meta.color,
        window: meta.window,
        stale: reading.stale,
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

  function readingOf(payload: Record<string, any>, id: QuotaSourceId): { used: number; stale: boolean } | null {
    const pick = (used: any, stale: any): { used: number; stale: boolean } | null =>
      typeof used === "number" && Number.isFinite(used) ? { used, stale: !!stale } : null;
    switch (id) {
      case "claude5h": return pick(payload.claude?.q5, payload.claude?.q5_stale);
      case "claudeWeek": return pick(payload.claude?.q7, payload.claude?.q7_stale);
      case "claudeFable": return pick(payload.claude?.qf, payload.claude?.qf_stale);
      case "codex5h": return pick(payload.codex?.p5, payload.codex?.p5_stale);
      case "codexWeek": return pick(payload.codex?.pw, payload.codex?.pw_stale);
      case "kimi5h": return pick(payload.kimicode?.p5, payload.kimicode?.p5_stale);
      case "kimiSubscription": return pick(payload.kimicode?.pw, payload.kimicode?.pw_stale);
      case "grok": return pick(payload.grok?.pct, payload.grok?.stale);
    }
  }

  /** 该窗口在 usage.json 里的重置时刻（unix 秒）；采集器给的可能是 ISO 串，统一换算 */
  function resetOf(payload: Record<string, any>, id: QuotaSourceId): number | null {
    const raw = ({
      claude5h: payload.claude?.q5_reset, claudeWeek: payload.claude?.q7_reset, claudeFable: payload.claude?.qf_reset,
      codex5h: payload.codex?.r5, codexWeek: payload.codex?.rw,
      kimi5h: payload.kimicode?.r5, kimiSubscription: payload.kimicode?.rw, grok: payload.grok?.reset,
    } as Record<QuotaSourceId, unknown>)[id];
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    if (typeof raw === "string") {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
      const parsed = Date.parse(raw);
      return Number.isNaN(parsed) ? null : parsed / 1000;
    }
    return null;
  }

  function hasResetSinceReading(payload: Record<string, any>, id: QuotaSourceId): boolean {
    const reset = resetOf(payload, id);
    return reset !== null && reset <= Date.now() / 1000;
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
    // 逐额度一行（main.swift:479-489）：总量项只报「今日 12.3M」，失真读数要说明是上次读到的，
    // 窗口翻篇那项干脆没有百分比，只说「已重置，等下一次读数」。
    for (const m of metrics) {
      const label = m.source === "total" ? "今日" : SOURCE_META[m.source].label;
      if (m.remaining === null) lines.push(m.stale ? `${label} 已重置，等下一次读数` : `${label} ${m.value}`);
      else lines.push(`${label} ${m.stale ? "上次读到剩余" : "剩余"} ${m.value}%`);
    }
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

  /**
   * 分享卡页脚那句「更新 HH:mm:ss」（对应 store.lastUpdated 经 formatUpdatedLine 处理）。
   * 失败/垫进来的缓存没有本轮时刻，就返回 null——分享卡上不写一句假时间。
   */
  function updatedStamp(): string | null {
    const payload = state.payload;
    if (!payload || payload._ok === false) return null;
    const at = Number(payload._at);
    if (!Number.isFinite(at) || at <= 0) return null;
    const d = new Date(at);
    const pad = (v: number) => String(v).padStart(2, "0");
    return `更新 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

  /** 面板能写的设置键；Provider 的 {provider}_quota_enabled、qoder_ide_enabled、设备与同步键都不在这里 */
  const PANEL_SETTING_KEYS: (keyof Settings)[] = [
    "disabled_tools", "menu_style", "menu_density", "menu_quota_enabled", "panel_tab",
    "autostart", "keep_awake_low_battery", "sit_reminder_enabled", "sit_reminder_minutes",
    "grok_live_quota_enabled", "grok_bot_quota_enabled", "qwenwork_quota_enabled",
    "panel_font_size", "locale", "share_basic_activity",
  ];

  /** 只挑出白名单里的键：渲染进程拿到一次注入也改不动联网开关之外的那批配置 */
  function allowedPatch(raw: Record<string, any>): Partial<Settings> {
    const out: Record<string, any> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const key of PANEL_SETTING_KEYS) {
        if (raw[key] !== undefined) out[key] = raw[key];
      }
    }
    return out as Partial<Settings>;
  }

  function setSettings(patch: Partial<Settings>, remirror = false): void {
    const before = settings;
    settings = { ...settings, ...patch };
    // 卡片显隐、Sub2API 的 Base URL 一动，config.json 里那 8 个开关就得跟着重算
    //（对应 PV:3128-3158 每个 .onChange 里的 setProviderQuotaEnabled / setQoderIdeEnabled）；
    // 存/清凭据这两条路是调用方自己点名要重算的（remirror），因为设置项本身没变。
    if (remirror || patch.disabled_tools !== undefined || patch.sub2api_base_url !== undefined) {
      settings = { ...settings, ...quotaMirror(providerCredentialStatus(), settings) };
    }
    saveSettings(settings);
    // 面板里的开关和托盘菜单走同一条路：存了就要生效，不能只落盘
    if (patch.autostart !== undefined) setLoginItem(settings.autostart);
    // 对应 PV:3471 的 .onChange(of: activityStatisticsEnabled) { ActivityReporter.preferencesChanged() }：
    // 关掉时掐断在跑的那一发；重新打开要等下次启动才发（一个进程只试一次）
    if (patch.share_basic_activity !== undefined) activity.preferencesChanged(settings.share_basic_activity);
    // 对应 sitReminder.updateRunning()：改「启用」或改「间隔」都重新起算连续用机时长
    if (patch.sit_reminder_enabled !== undefined || patch.sit_reminder_minutes !== undefined) sitWorkStart = 0;
    // 对应 PV:3353-3363 每个额度开关的 .onChange { store.refresh() }：这些键决定这一轮
    // 扫不扫网、扫不扫 Qoder 的本机库，改完立刻重扫才会马上见到新读数；只落盘的话要等
    // 下一轮定时刷新才对得上开关。设置与采集器共用 ~/.tokei/config.json，重扫时读到的
    // 就是刚存下去的这份。
    if (RESCAN_KEYS.some((key) => before[key] !== settings[key])) void refresh();
    updateTray();
    applyEnabledTools();
  }

  /** 动过这些键就得重扫：卡片显隐镜像出来的 8 个开关 + 隐私段那三个联网开关 */
  const RESCAN_KEYS: (keyof Settings)[] = [
    "antigravity_quota_enabled", "devin_quota_enabled", "cursor_quota_enabled", "zed_quota_enabled",
    "sub2api_quota_enabled", "zai_quota_enabled", "minimax_quota_enabled", "qoder_ide_enabled",
    "grok_live_quota_enabled", "qwenwork_quota_enabled", "grok_bot_quota_enabled",
  ];

  /**
   * 开机自启：写一次再读回来确认，对应 LoginItemManager 那句「状态以系统为准」（LI:166）。
   * Windows 这边是注册表 Run 键，没有 macOS 的「需要在系统设置中允许」审批态（LI:189-241），
   * 所以回读对不上就当成失败，把原因交给面板那一行红字（PV:3082-3087）。
   */
  function setLoginItem(enabled: boolean): void {
    state.loginError = "";
    try {
      app.setLoginItemSettings({ openAtLogin: enabled });
      if (app.getLoginItemSettings().openAtLogin !== enabled) {
        state.loginError = enabled
          ? "开机自启没能生效，可能被组策略或安全软件拦下"
          : "开机自启没能取消，请手动检查登录时的启动项";
      }
    } catch (e: any) {
      state.loginError = `登录项设置失败：${e?.message ?? e}`;
    }
    pushLoginItem();
  }

  function loginItemSnapshot(): { enabled: boolean; error: string } {
    let enabled = settings.autostart;
    try {
      enabled = app.getLoginItemSettings().openAtLogin;
    } catch { /* 读不到就退回设置里那一份 */ }
    return { enabled, error: state.loginError };
  }

  function pushLoginItem(): void {
    if (state.panel && !state.panel.isDestroyed()) {
      state.panel.webContents.send("login-item", loginItemSnapshot());
    }
  }

  function showPanel(): void {
    if (!state.panel || state.panel.isDestroyed()) createPanel();
    const panel = state.panel;
    if (!panel) return;
    // 屏幕可能在两次打开之间换过（拔掉外接屏、改缩放）：先按当前的屏夹一遍高度再摆
    clampPanelToScreen();
    positionPanel();
    panel.show();
    panel.focus();
    state.visible = true;
    // 对应 main.swift:587 那句 store.refresh(prewarmQuotaDetail: true)：开面板先补一轮，
    // 扫完顺手把额度详情焐上，别让曲线页对着上次缓存；登录项是系统态，也在这时回读一次。
    state.quotaPrewarmPending = true;
    pushLoginItem();
    void refresh();
  }

  function createPanel(): void {
    // 对应 Design.swift:77-81（渐变底）+ 6-28（NSVisualEffectView .hudWindow 的实时模糊）。
    // Windows 侧只有 Win11 22H2（build 22621）起有系统亚克力材质；Chromium 里 alpha 只在
    // transparent:true 的窗口上生效，所以材质与渐变要一起吃掉这一个开关。更旧的 Windows
    // 退回渐变中值的实色，避免材质缺失时透出黑底。
    const build = Number(os.release().split(".")[2] || "0");
    const backdrop = process.platform === "win32" && build >= 22621;
    state.panel = new BrowserWindow({
      // 对应 PanelPlacement.provisionalSize：面板真正打开前一定会按内容重量一次，
      // 这只是个不至于太离谱的起点（渲染进程 boot 末尾就会发来真实尺寸）。
      width: PANEL_PROVISIONAL.width,
      height: PANEL_PROVISIONAL.height,
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
      panel.webContents.send("update", updater.state);
    });
  }

  /** 托盘所在的那块屏：没有托盘坐标就按主屏（对应 anchorVisibleFrame ?? fallbackVisibleFrame） */
  function panelDisplay() {
    const bounds = state.tray?.getBounds?.();
    const anchor = bounds ? { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y } : null;
    return anchor ? screen.getDisplayNearestPoint(anchor) : screen.getPrimaryDisplay();
  }

  /** 面板当前尺寸按这块屏的上限夹一遍（对应 PanelPlacement.maximumHeight） */
  function clampPanelToScreen(): void {
    const panel = state.panel;
    if (!panel || panel.isDestroyed()) return;
    const [width, height] = panel.getSize();
    const fit = fitPanelSize({ width, height }, panelDisplay().workArea.height);
    if (fit.width === width && fit.height === height) return;
    // resizable:false 在 Windows 上会把窗口的最小/最大尺寸钉死在当前值，直接 setSize 会被夹回去；
    // 改尺寸的瞬间放开、改完再锁回，用户那边依旧拖不动边框。
    panel.setResizable(true);
    panel.setSize(fit.width, fit.height);
    panel.setResizable(false);
  }

  /** 对应 PanelPlacement.swift：贴着托盘所在的显示器工作区右上角弹出 */
  function positionPanel(): void {
    if (!state.panel) return;
    const display = panelDisplay();
    const area = display.workArea;
    const [width, height] = state.panel.getSize();
    const x = Math.round(area.x + area.width - width - 8);
    const y = Math.round(area.y + 8);
    state.panel.setBounds({ x, y, width, height });
  }

  /**
   * 对应 PanelView 的 pageWidth(for: mode) + PanelLayoutContext.pageDidChange：宽页（额度曲线、设置）
   * 与窄页（用量、项目）宽度不同，高度按内容自然高度给、再夹进屏高 0.88；换页时由主进程改尺寸
   * 并按新的尺寸重新贴右摆放。
   *
   * height 省略（undefined）表示「这一趟只改宽度」：渲染进程换页时先落宽度让布局按新宽度重排，
   * 下一帧再量高度发第二发；直接用旧宽度下量到的高度会把长页裁短一截。
   */
  function setPanelSize(width: unknown, height?: unknown): void {
    if (!state.panel || state.panel.isDestroyed()) return;
    const [currentWidth, currentHeight] = state.panel.getSize();
    const measured = height === null || height === undefined ? undefined : Number(height);
    const fit = fitPanelSize(
      { width: Number(width) || 0, height: Number.isFinite(measured) && (measured as number) > 0 ? (measured as number) : 0 },
      panelDisplay().workArea.height,
    );
    const wantedWidth = fit.width;
    const wantedHeight = measured !== undefined && Number.isFinite(measured) && measured > 0 ? fit.height : currentHeight;
    if (wantedWidth === currentWidth && wantedHeight === currentHeight) return;
    state.panel.setResizable(true);
    state.panel.setSize(wantedWidth, wantedHeight);
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

  // 面板开机时问一次「手上有没有读数」。垫进来的那一份要带上 _primed，
  // 表头才写「缓存数据 · 后台更新中」而不是「等待刷新」（primeCachedUsage 里那句 L(...)）。
  ipcMain.handle("get-usage", () => {
    const payload = state.payload ?? loadCachedUsage(LAST_USAGE_FILE);
    if (!payload) return payload;
    return state.primed ? { ...payload, _primed: true } : payload;
  });
  ipcMain.handle("get-settings", () => settings);
  ipcMain.handle("set-settings", (_e, patch: Record<string, any>) => {
    // 面板只能写 UI 设置这一层：联网开关里只有「隐私段」那三项由用户点，
    // 卡片显隐与 Sub2API 地址由主进程镜像出其余键；Provider 的 *_quota_enabled、
    // 设备标识、同步目录这些留给采集器的键不接受面板写入，免得注入进去。
    setSettings(allowedPatch(patch) as Partial<Settings>);
    return settings;
  });
  ipcMain.handle("refresh-now", async () => { await refresh(); return state.payload; });
  ipcMain.handle("hide-panel", () => { state.panel?.hide(); state.visible = false; });
  ipcMain.handle("set-panel-size", (_e, width: unknown, height: unknown) => setPanelSize(width, height));
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
  // 价格表段那两个按钮（PV:3589-3618 + runPriceUpdate PV:4190-4218）：抓价在主进程做，
  // 渲染进程只拿摘要文本。原版取的是子进程的 stdout —— 失败信息打在 stderr，界面上只显示
  // 空串（也就是什么都不显示），这里照抄这个口径，只把 code 一起带回去供按钮复位。
  ipcMain.handle("update-prices", async () => {
    const result = await runPriceUpdate(RESOURCE_DIR, scanCache);
    // 原版跑完无条件 store.refresh()：价目表换了，缓存里预存的成本要按新价重算
    await refresh();
    return { code: result.code, message: result.code === 0 ? result.message : "" };
  });
  // 价格表段第二个按钮「查漏补缺」（PV:3597-3600）：扫本机日志补未知模型的价，全程不联网。
  // 文本口径照抄视图层那段（PV:4209-4214）：认得出 JSON 就按 count 出「补全 N 个模型」或
  // 「所有模型已匹配 ✓」，认不出就退回把 stdout 原样去空白后显示；子进程崩了 stdout 是空串，
  // 界面跟抓价失败一样什么都不显示。
  ipcMain.handle("update-unknown", async () => {
    const result = await runPriceUpdateScript(collectorEntry(), process.execPath, "--update-unknown");
    let count = 0;
    let message = "";
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Number.isInteger(parsed.count)) {
        count = parsed.count;
        message = count > 0 ? `补全 ${count} 个模型` : "所有模型已匹配 ✓";
      } else {
        message = result.stdout.trim();
      }
    } catch {
      message = result.stdout.trim();
    }
    // 对应 _remove_scan_cache_files() + _remove_codex_event_cache_dir()（15760-15763，只在有新增时）：
    // 我们的扫描缓存是内存版，删文件在这里就等于清空它，下一轮从头重扫
    if (count > 0) for (const key of Object.keys(scanCache)) delete scanCache[key];
    await refresh();
    return { code: result.exitCode, message };
  });
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
  // 更新器：检查与安装都只在主进程跑，渲染进程只拿状态、只发动作
  ipcMain.handle("update-state", () => updater.state);
  ipcMain.handle("update-check", (_e, userInitiated: unknown) => {
    void updater.checkForUpdate(userInitiated === true);
    return updater.state;
  });
  ipcMain.handle("update-apply", () => {
    void updater.performUpdate();
    return updater.state;
  });
  ipcMain.handle("quit-app", () => { app.quit(); });
  // 防休眠：每个动作都把最新快照还给面板，省一次往返
  ipcMain.handle("keep-awake-status", () => keepAwake.snapshot());
  // 登录项的真实状态由系统保管，面板每次进设置页先拉一次、之后接推送（对应 LoginItemManager）
  ipcMain.handle("get-login-item", () => loginItemSnapshot());
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
  // 对应 footer 的「复制」（copyUsageImage，PV:2642-2658）与卡头的单张复制（PV:2661-2685）：
  // 原版不是截屏，而是用 ImageRenderer 按 UsageShareImage 的版式单独画一张卡。
  // 这里同样单独出图；数据由主进程从手上的 payload 组（core/shareCard.ts），不经渲染进程。
  ipcMain.handle("copy-share-image", async (_e, raw: unknown) => {
    if (!state.payload) return false;
    const req = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    return copyShareImage(buildShareSpec({
      payload: state.payload,
      range: typeof req.range === "string" ? req.range : "today",
      disabled: settings.disabled_tools,
      kind: req.kind === "tool" ? "tool" : "overview",
      toolId: typeof req.toolId === "string" ? req.toolId : null,
      updated: updatedStamp(),
      fontScale: PANEL_FONT_SCALE[settings.panel_font_size] ?? 1,
    }));
  });

  app.whenReady().then(() => {
    initPricing(RESOURCE_DIR);
    settings = loadSettings();
    // 对应那四个 syncXxxConfigOnLaunch（PV:3547-3587）：启动时先做一次卡片显隐/凭据的镜像。
    // 面板的 onChange 在启动那一刻不会触发，原版特意写了这句注释说明「不补这一发
    // qoder_ide_enabled 就永远没人写」；这里同一批把 8 个键都对齐。
    settings = { ...settings, ...quotaMirror(providerCredentialStatus(), settings) };
    saveSettings(settings);
    setLoginItem(settings.autostart);
    // 防休眠不跨重启恢复（macOS 的 KeepAwake 也从不落盘），所以这里只还原自启

    state.tray = new Tray(fallbackIcon());
    state.tray.on("click", () => (state.panel?.isVisible() ? state.panel.hide() : showPanel()));
    state.tray.on("double-click", () => showPanel());
    state.tray.on("right-click", () => state.tray?.popUpContextMenu());

    // 对应 store.primeCachedUsage() 排在 store.refresh() 之前（main.swift:350-351）：
    // 先用上一轮的读数把托盘垫上，再开第一趟扫描。垫完要重画一次，对应那句 applyDisplayMode。
    primeCachedUsage();
    updateTray();
    applyEnabledTools();
    refresh();
    // 任务栏配色不是事件可订阅的，60s 轮询一次足够（用户切主题后一分钟内跟上）
    void refreshTaskbarTheme().then(() => updateTray());

    // 对应 main.swift:352-353 的 ActivityReporter.reportLaunchIfNeeded(appVersion: Updater.releaseTag)：
    // 排在启动序列里，一次进程只试一次；关掉开关时连状态文件都不碰。
    void activity.reportLaunchIfNeeded(app.getVersion(), settings.share_basic_activity);

    // 对应 main.swift:353 与 371：启动查一次，之后每 6 小时一次
    void updater.checkForUpdate();
    updateTimer = setInterval(() => { void updater.checkForUpdate(); }, UPDATE_CHECK_INTERVAL);

    // 对应 autoFetchPricing（main.swift:542-560，启动序列的最后一环）：pricing.json 的 mtime
    // 距今不足 24 小时就一趟都不跑；跑过（不管成没成）都补一轮采集，因为价目表一改，
    // 缓存里预存的成本要按新价重算，托盘和面板得跟着变。
    // 原版在 utility 队列上同步 waitUntilExit，这里挂到事件循环上——启动不该被网络拖住。
    void autoFetchPricing(RESOURCE_DIR, scanCache, {}, (result) => {
      if (!result) return;
      // 原版把 stdout/stderr 全丢进 nullDevice，失败连一行日志都不留；这里至少让人查得到
      if (result.code !== 0) console.error(result.message);
      refresh();
    });

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
    setSettings(patch, true);
    void refresh();
    return providerReply(true, "已保存");
  }

  /** 对应 clearProviderToken（PanelView.swift:3229-3240）：清完同步关掉该 Provider 的联网开关 */
  function clearProviderSecret(provider: unknown) {
    if (!isProviderSecret(provider)) return providerReply(false, "清除失败");
    if (!clearCredential(provider)) return providerReply(false, "清除失败");
    // 凭据变了但设置项没变，让 setSettings 强制重算一遍镜像
    setSettings({}, true);
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
    if (updateTimer) clearInterval(updateTimer);
    updater.dispose();
    keepAwake.dispose();
    closeRasterWindow();
  });
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

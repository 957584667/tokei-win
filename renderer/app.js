/* 面板渲染进程。数据全部来自主进程 IPC，这里只负责展示与设置回写。 */
"use strict";

/** 对应 RangeKey.displayCases（Model.swift:6）：「全部」只在数据结构里，段控件不显示 */
const RANGES = [
  { key: "today", label: "今日" },
  { key: "yesterday", label: "昨日" },
  { key: "week", label: "本周" },
  { key: "last_week", label: "上周" },
  { key: "month", label: "本月" },
  { key: "year", label: "本年" },
];

/** 对应 PanelView 的卡片顺序：固定顺序，不按成本排序（Swift 侧就是这个数组序） */
const PANEL_ORDER = [
  "claude", "codex", "gemini", "cursor", "zed", "sub2api", "zai",
  "grok", "grok_bot", "qoder", "qoderwork", "qodercli", "qodercli_cn",
  "hermes", "zcode", "mimocode", "openclaw", "pi", "prime_agent",
  "workbuddy", "workbuddy_ai", "codebuddy", "deepseek_harness", "opencode",
  "qwencode", "qwenwork", "devin", "minimax", "kimicode", "musecode", "cmdcode",
];

/**
 * 对应 Design.swift:36-66 的 Theme 色板 + PanelView.swift:427-561 的 ToolCardItem 表。
 * name 是设置「显示卡片」列表与「未检测到本地数据」行用的名字；
 * title 只有与 name 不同时才写（cardHead 上的标题），省略时取 name。
 */
const TOOL_META = {
  claude: { name: "Claude", title: "Claude Code", color: "#eb8566" },
  codex: { name: "Codex", color: "#6badfa" },
  gemini: { name: "Gemini", title: "Gemini / Antigravity", color: "#9e85eb" },
  cursor: { name: "Cursor", color: "#b8c4e6" },
  zed: { name: "Zed", color: "#ed614d" },
  sub2api: { name: "Sub2API", color: "#2ec7d9" },
  zai: { name: "z.ai / GLM", color: "#61abfa" },
  grok: { name: "Grok", color: "#a6adbf" },
  grok_bot: { name: "Grok Bot", color: "#f266a3" },
  qoder: { name: "Qoder Desktop", color: "#e6bf59" },
  qoderwork: { name: "QoderWork", color: "#bfa64d" },
  qodercli: { name: "Qoder CLI", color: "#f5d673" },
  qodercli_cn: { name: "Qoder CN", color: "#fa9e59" },
  hermes: { name: "Hermes", color: "#66d199" },
  zcode: { name: "ZCode", color: "#85cc57" },
  mimocode: { name: "MiMoCode", color: "#f28042" },
  openclaw: { name: "OpenClaw", color: "#d973ad" },
  pi: { name: "Pi", title: "Pi Coding Agent", color: "#bd94f2" },
  prime_agent: { name: "Prime Agent", color: "#f59447" },
  workbuddy: { name: "WorkBuddy", color: "#40c7b8" },
  workbuddy_ai: { name: "WorkBuddy Intl.", color: "#5ca8f0" },
  codebuddy: { name: "CodeBuddy", color: "#7594f5" },
  deepseek_harness: { name: "DeepSeek Harness", color: "#2e94f0" },
  opencode: { name: "OpenCode", color: "#8cbfe6" },
  qwencode: { name: "Qwen Code", color: "#7a8cf2" },
  qwenwork: { name: "千问办公", color: "#3db8ad" },
  devin: { name: "Devin", color: "#6b78fa" },
  minimax: { name: "MiniMax Code", color: "#e84066" },
  kimicode: { name: "Kimi Code", color: "#33c7a8" },
  musecode: { name: "Muse Code", color: "#1a6beb" },
  cmdcode: { name: "Command Code", color: "#38ad52" },
};

/** cardHead 的标题：ToolCardItem 的 name 与卡片上的标题在四处不同，统一走这里 */
function cardTitle(id) {
  const meta = TOOL_META[id];
  return (meta && (meta.title || meta.name)) || String(id);
}

const state = {
  payload: null,
  settings: null,
  range: "today",
  tab: "usage",
  expanded: new Set(),
  /** 本轮渲染里被用户「点开」的披露键：整页 innerHTML 重建，动画只能靠这个标记挂一次性类 */
  animKeys: new Set(),
  /** 对应 store.lastUpdated / store.loadError：表头表尾的读数与整页空态都看这两个 */
  refreshing: true,
  updated: null,
  loadError: "",
  /** 哪些 Provider 存了密钥（渲染进程只拿状态，拿不到明文） */
  stored: {},
  providerDraft: { sub2api_base_url: "", zai_region: "global", keys: { sub2api: "", zai: "", minimax: "" } },
  providerResult: "",
  providerResultOk: false,
  /** 项目足迹：按需取数，null=还没取过 */
  trail: null,
  trailLoading: false,
  trailQuery: "",
  pinned: new Set(),
  home: "",
  /** 额度轨迹：同样按需取数，只有曲线页会读快照 */
  curve: null,
  curveLoading: false,
  curveError: "",
  /** 取数请求的代数：只有最新一次的回执能落到画面上 */
  curveSeq: 0,
  /** 防休眠：断言与定时都在主进程，这里只缓存快照画 footer（KA:8-11） */
  keepAwake: { active: false, endsAt: null, allowDisplaySleep: false, lowBatteryGuard: true },
  curveTool: "claude",
  curveSpan: 24,
  /** 周额度与每日消耗（QuotaDetailRepository）：周期卡和 1月/1年 两档都吃这份快照 */
  detail: null,
  /** 取数在途：对应 Swift 那边的 refreshing，副标题标「更新中」；首帧还没有快照时画占位 */
  detailLoading: false,
  detailError: "",
  detailSeq: 0,
  /** 对应 cycleTool：null = 三个工具各摆一块，选中就只看那一个 */
  cycleTool: null,
  /** 对应 expandedCycleHistory：按工具记住谁展开了更早的周期 */
  expandedCycles: new Set(),
  /** 数据面板（DashboardRepository）：进这一页才取数，null = 还没拿到过快照 */
  dashboard: null,
  dashboardLoading: false,
  dashboardSeq: 0,
  /** 对应 wrappedPeriod：回顾段和模型/项目/热力全都跟着它换区间 */
  dashPeriod: "all",
  /** 对应 heatRange：0=周（weekStrip）1=月（35 天）2=年（371 天），Swift 的默认值是 2 */
  heatRange: 2,
  /** 对应 selectedCell：点格子看单日下钻，再点同一格收回 */
  heatDate: null,
  /** 对应 @AppStorage("hideProjects")：Windows 没有 UserDefaults，这份收起来的状态落 localStorage */
  hideProjects: localStorage.getItem("hideProjects") === "1",
  /** 对应 WrappedView 的 @State achievementsExpanded：一次性状态，离开页面就收回 */
  achExpanded: false,
  /** 对应 @State funSeed：hero 那行彩蛋每次进页重新摇（0 咖啡 / 1 火锅 / 2 字数） */
  funSeed: 0,
  /** 对应 ConfettiView 的一次性开关：新成就或新里程碑进页时撒一次 */
  dashConfetti: false,
  /** 对应 onAppear 只跑一次：切走再切回来要重新判定「首次可见」 */
  dashAppeared: false,
  /** 诊断段三个 @State（PV:152-156）：报告全文 / 在跑 / 展开全文开没开 */
  diagOutput: "",
  diagRunning: false,
  diagExpanded: false,
};

/** 对应 macOS 设置里的「Provider 额度」段（PanelView.swift:3039-3159）；Zed 的 Keychain 授权是 macOS 专属，不移植 */
const PROVIDERS = [
  { id: "sub2api", name: "Sub2API", color: "#7f8fa6", hasUrl: true, keyPlaceholder: "Group API Key" },
  { id: "zai", name: "z.ai / GLM", color: "#c084fc", hasRegion: true, keyPlaceholder: "Z_AI_API_KEY" },
  { id: "minimax", name: "MiniMax Code", color: "#ff8fa3",
    note: "填 Token Plan 的 Key（sk-cp-…），中国区与国际区由服务端自动识别。",
    keyPlaceholder: "Token Plan Key" },
];

const $ = (id) => document.getElementById(id);

/** 对应 L10n.isChinese：locale=auto 时看系统语言 */
function isChinese() {
  const locale = state.settings?.locale || "auto";
  if (locale === "auto") return (navigator.language || "zh-CN").toLowerCase().startsWith("zh");
  return locale.toLowerCase().startsWith("zh");
}

function human(n) {
  const v = Number(n) || 0;
  // Fmt.human：中文按亿进位，其他语言用 B；1.5e9 不能写成 1500.0M
  if (isChinese() && Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (!isChinese() && Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${Math.round(v / 1e3)}K`;
  return `${Math.round(v)}`;
}

/** Fmt.grouped（Model.swift:1092）：千位分隔，分隔符恒为英文逗号 */
function grouped(n) {
  return `${Math.round(Number(n) || 0)}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Fmt.credits：整数不带小数，否则两位并去掉尾随 0 */
function credits(n) {
  const v = Number(n) || 0;
  if (Math.abs(Math.round(v) - v) < 1e-6) return String(Math.round(v));
  return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** nativeMoney：美元恒显示 $%.2f，人民币只在 >0 时以「 + 」并列，不做汇率换算 */
function nativeMoney(usd, cny) {
  const u = Number(usd) || 0, c = Number(cny) || 0;
  const parts = [];
  if (u > 0 || c <= 0) parts.push(`$${u.toFixed(2)}`);
  if (c > 0) parts.push(`¥${c.toFixed(2)}`);
  return parts.join(" + ");
}

/** reason 已含在 out 里的工具，相加会重复计数（src/core/model.ts 的同一份白名单） */
const REASON_INSIDE_OUTPUT = new Set(["codex", "codex_reserve", "openclaw", "musecode"]);

/** 各工具的「总量」口径互不相同，照 Swift 的计算属性来，别统一相加 */
function fieldTokens(toolId, r) {
  const n = (v) => Number(v) || 0;
  if (!r) return 0;
  if (n(r.tokens) > 0) return n(r.tokens);                     // GrokRange / TokenUsageRange
  if (r.cached !== undefined && r.thoughts !== undefined) return n(r.in) + n(r.out) + n(r.cached) + n(r.thoughts); // Gemini
  if (r.cached !== undefined) return n(r.in) + n(r.out) + n(r.cached);                                            // Codex / Qoder IDE
  const reason = REASON_INSIDE_OUTPUT.has(toolId) ? 0 : n(r.reason);                                              // OpenClaw / Muse
  return n(r.in) + n(r.out) + n(r.cr) + n(r.cw) + reason;
}

/** Fmt.reset：epoch 秒 → MM-dd HH:mm */
function resetText(epoch) {
  if (epoch === null || epoch === undefined) return "?";
  const d = new Date(Number(epoch) * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Fmt.countdown（Model.swift:1124）：epoch 秒 → 3h12m / 45m / 即将重置 */
function countdown(epoch) {
  if (epoch === null || epoch === undefined) return "?";
  const s = Math.floor(Number(epoch) - Date.now() / 1000);
  if (s <= 0) return "即将重置";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/** Fmt.beijingTime（Model.swift:1115）：写死东八区，跟本机时区无关 */
function beijingText(epoch, full) {
  const f = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const x of f.formatToParts(new Date(Number(epoch) * 1000))) p[x.type] = x.value;
  const short = `${p.month}-${p.day} ${p.hour}:${p.minute}`;
  return full ? `${p.year}-${short}:${p.second}` : short;
}

/** Fmt.relativeDate 的日差：按日历天算，不是 24 小时倍数（跨夏令时靠取整兜住） */
function daysAgo(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return null;
  const then = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - then) / 86400000);
}

/** Model.swift:1151-1161 */
function relativeDate(iso) {
  const days = daysAgo(iso);
  if (days === null) return String(iso || "");
  if (days < 0) return String(iso);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (days <= 7) return `${days}天前`;
  if (days <= 30) return `${Math.floor(days / 7)}周前`;
  return `${Math.floor(days / 30)}月前`;
}

function toolRange(toolId, rangeKey) {
  const node = state.payload?.[toolId];
  return node?.ranges?.[rangeKey] || null;
}

function toolNode(id) {
  return state.payload?.[id] ?? null;
}

/** 对应 toolVisibility：设置里勾掉的工具整张卡都不画，也不进「未检测到本地数据」 */
function cardVisible(id) {
  return !(state.settings?.disabled_tools || []).includes(id);
}

function rangeLabel(key) {
  const hit = RANGES.find((r) => r.key === key);
  return hit ? hit.label : String(key);
}

/** 本区间选中的标签，等价于 Swift 的 sel.label */
function selLabel() {
  return rangeLabel(state.range);
}

/**
 * SegmentedTabs（Design.swift:315-375）：macOS 的高亮是一块 matchedGeometryEffect 底在段间滑动
 * （spring response .32 / damping .82）。整段重建会让那块底跟着消失，所以按钮只建一次，
 * 之后只切类名并把常驻的 .seg-pill 挪到当前段的矩形上。
 */
let segBuilt = false;
let segBoxWidth = -1;

function renderRangeControl() {
  const box = $("range-control");
  if (!segBuilt) {
    box.innerHTML = "";
    for (const r of RANGES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "seg";
      b.dataset.range = r.key;
      b.textContent = r.label;
      b.setAttribute("role", "tab");
      b.onclick = () => { state.range = r.key; render(); };
      box.appendChild(b);
    }
    const pill = document.createElement("span");
    pill.className = "seg-pill";
    pill.id = "seg-pill";
    box.appendChild(pill);
    segBuilt = true;
  }
  for (const b of box.querySelectorAll(".seg")) {
    const on = b.dataset.range === state.range;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", String(on));
  }
  const active = box.querySelector(".seg.is-active");
  const pill = $("seg-pill");
  if (!active || !pill) return;
  // 面板窗口起初是隐藏的、rAF 会被暂停，所以「跳过动画」只能用强制回流的同步写法
  const jumped = Math.abs(box.clientWidth - segBoxWidth) > 0.5 || pill.style.width === "";
  if (jumped) pill.style.transition = "none";
  pill.style.top = `${active.offsetTop}px`;
  pill.style.left = `${active.offsetLeft}px`;
  pill.style.height = `${active.offsetHeight}px`;
  pill.style.width = `${active.offsetWidth}px`;
  if (jumped) {
    void pill.offsetWidth;
    pill.style.transition = "";
  }
  segBoxWidth = box.clientWidth;
}

// ---------------- 卡片构件 ----------------
// 对应 Design.swift 的 MetricCell / RingMetricCell / MiniBar 与 PanelView 的
// cardHead / CostHeadline / metricGrid / quotaRow / quotaStateNotice 这些复用片段。

/**
 * SF Symbols 的等价线性图标：16 网格、描边跟 currentColor，class="fill" 的路径走实心。
 * 键名保持 Swift 里写的符号名，逐处对照时不用翻译。
 */
const ICONS = {
  "dollarsign.circle": '<circle cx="8" cy="8" r="5.6"/><path d="M10.1 5.6c-.3-.8-1.2-1.2-2.1-1.2-1.1 0-1.9.6-1.9 1.4 0 2 3.9 1.4 3.9 3.3 0 .9-.9 1.5-2 1.5-1 0-1.8-.5-2.1-1.3M8 3v1.4M8 11.6V13"/>',
  "arrow.down": '<path d="M8 3.2v9.4M4.5 9.1 8 12.6l3.5-3.5"/>',
  "arrow.up": '<path d="M8 12.6V3.2M4.5 6.7 8 3.2l3.5 3.5"/>',
  "bolt.fill": '<path class="fill" d="M9.6 2 4 9.3h3.2l-.9 4.7L12.4 6.5H8.9z"/>',
  "square.stack.3d.up.fill": '<path class="fill" d="M8 2 13.6 4.9 8 7.8 2.4 4.9z"/><path d="M2.5 7.6 8 10.5l5.5-2.9M2.5 10.7 8 13.6l5.5-2.9"/>',
  brain: '<path d="M7.4 3.5a2.1 2.1 0 0 0-3.3 1.6 2 2 0 0 0-.5 3.4 2.1 2.1 0 0 0 1.5 3.3c.8 0 1.6-.4 2.3-1.1M8.6 3.5a2.1 2.1 0 0 1 3.3 1.6 2 2 0 0 1 .5 3.4 2.1 2.1 0 0 1-1.5 3.3c-.8 0-1.6-.4-2.3-1.1M8 3.3v9.8"/>',
  waveform: '<path d="M2 8h1.5L5 3.8l2.4 8.4L9.8 6l1.3 4H14"/>',
  "arrow.triangle.2.circlepath": '<path d="M13.1 7.6a5.2 5.2 0 0 0-9-3.2M2.9 8.4a5.2 5.2 0 0 0 9 3.2"/><path d="M13.5 3.4v3.6H9.9M2.5 12.6V9h3.6"/>',
  // SF 那颗是实心圆里挖出箭头；线性图标做不到挖色，10px 下用「圆圈 + 顺时针箭头」等价
  "arrow.clockwise.circle.fill": '<circle cx="8" cy="8" r="6.2"/><path d="M10.6 5.9A3.2 3.2 0 1 0 11.2 9.1"/><path d="M11.4 3.3v2.8H8.6"/>',
  "wrench.and.screwdriver": '<path d="M12.7 3.3a3.1 3.1 0 0 1-4 4.1L4.5 11.6a1.7 1.7 0 1 1-2.4-2.4L6.4 5a3.1 3.1 0 0 1 4.1-4l-2 2 1.5 1.5z"/>',
  clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.5 1.7"/>',
  "clock.arrow.circlepath": '<path d="M13.2 6.2A5.6 5.6 0 1 0 13.4 9.8"/><path d="M13.6 2.4v3.8H9.8M8 5.2V8l2.2 1.5"/>',
  "chart.bar.fill": '<path class="fill" d="M2.9 8.4h2.3V13H2.9zM6.9 4.2h2.3V13H6.9zM10.9 9.6h2.3V13h-2.3z"/>',
  // SF 的 chart.bar.xaxis：三根柱子底下压一条 x 轴
  "chart.bar.xaxis": '<path d="M2.2 13.6h11.6"/><path class="fill" d="M3.6 8.2h1.9V12H3.6zM7.1 4.6H9V12H7.1zM10.6 9.4h1.9V12h-1.9z"/>',
  timer: '<circle cx="8" cy="9.2" r="4.8"/><path d="M8 6.6v2.6l1.9 1.4M6.3 2.6h3.4M8 2.6v1.8"/>',
  calendar: '<rect x="2.2" y="3.6" width="11.6" height="10" rx="1.8"/><path d="M2.2 6.6h11.6M5.4 2.2v2.4M10.6 2.2v2.4"/>',
  speedometer: '<path d="M2.6 11.4a6 6 0 1 1 10.8 0"/><path d="M8 11.2 11 6.6"/>',
  "exclamationmark.triangle": '<path d="M8 2.6 14.4 13.2H1.6z"/><path d="M8 6.4v3.4M8 11.5v.6"/>',
  "exclamationmark.triangle.fill": '<path class="fill" d="M8 2.2 15 13.6H1zM7.3 6.2h1.4v3.4H7.3zM7.3 10.6h1.4v1.4H7.3z"/>',
  "xmark.circle": '<circle cx="8" cy="8" r="5.6"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
  terminal: '<rect x="2" y="3.2" width="12" height="9.6" rx="1.6"/><path d="M4.7 7 6.3 8.6 4.7 10.2M8.2 10.4h3.3"/>',
  "person.2": '<circle cx="6.1" cy="6" r="2.4"/><path d="M2.3 13.2c.3-2.3 1.8-3.6 3.8-3.6 1.3 0 2.4.5 3.1 1.5"/><circle cx="11.5" cy="6.6" r="1.9"/><path d="M10.7 10c1.7.2 2.8 1.4 3.1 3.2"/>',
  "point.3.connected.trianglepath.dotted": '<circle cx="8" cy="3.4" r="1.5"/><circle cx="3.4" cy="12.2" r="1.5"/><circle cx="12.6" cy="12.2" r="1.5"/><path d="M7.1 4.7 4.3 10.9M8.9 4.7l2.8 6.2M4.9 12.2h6.2"/>',
  "bubble.left.and.bubble.right": '<path d="M2.4 4.6A1.5 1.5 0 0 1 3.9 3.1h5.4a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5H5.4z"/><path d="M8.9 9.9h3.6l2.2 2.2v-4a1.5 1.5 0 0 0-1.5-1.5h-1"/>',
  "bubble.left": '<path d="M2.4 4A1.6 1.6 0 0 1 4 2.4h7.6A1.6 1.6 0 0 1 13.2 4v4.4a1.6 1.6 0 0 1-1.6 1.6H6.2z"/><path d="M6.2 13.4V10"/>',
  sparkles: '<path class="fill" d="M5.8 2.2 6.9 5.2l3 1.1-3 1.1-1.1 3-1.1-3-3-1.1 3-1.1z"/><path d="M11.5 9.2l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  checklist: '<path d="M2.3 4.4 3.7 5.8 6.2 3.2M2.3 9.2 3.7 10.6 6.2 8M8.9 4.6h4.8M8.9 9.4h4.8M8.9 13h4.8"/>',
  "circle.hexagongrid.fill": '<path class="fill" d="M8 2.2 13 5.1v5.8L8 13.8 3 10.9V5.1z"/><path d="M8 5.4l2.4 1.4v2.4L8 10.6 5.6 9.2V6.8z"/>',
  "chart.pie.fill": '<path class="fill" d="M8 2.2a5.8 5.8 0 1 0 5.8 5.8z"/><path d="M9.4 2.6A5.4 5.4 0 0 1 13.4 6.6"/>',
  "chevron.right": '<path d="M6 3.6 10.4 8 6 12.4"/>',
  "chevron.down": '<path d="M3.6 5.8 8 10.2l4.4-4.4"/>',
  "chevron.up": '<path d="M3.6 10.2 8 5.8l4.4 4.4"/>',
  // 诊断钮的两种状态（PV:3500）：没读数/在跑是瓢虫，有读数是「向上」的圆钮
  ladybug: '<path d="M8 3.6a3.3 3.3 0 0 1 3.3 3.3v2.5A3.3 3.3 0 0 1 8 12.7a3.3 3.3 0 0 1-3.3-3.3V6.9A3.3 3.3 0 0 1 8 3.6z"/><path d="M8 4.2v8.2M4.9 7.3h6.2M5.2 9.7h5.6M4.9 5.7 3.3 4.3M11.1 5.7l1.6-1.4"/>',
  "chevron.up.circle": '<circle cx="8" cy="8" r="5.8"/><path d="M5.6 9.2 8 6.8l2.4 2.4"/>',
  "photo.on.rectangle": '<rect x="5" y="2.6" width="9.4" height="7.6" rx="1.5"/><path d="M11 14.2H3a1.4 1.4 0 0 1-1.4-1.4V5.6"/>',
  checkmark: '<path d="M3 8.6 6.3 11.9 13 4.5"/>',
  "info.circle": '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.2v3.9M8 4.9v.6"/>',
  // ↓ 数据面板页要用到的（WrappedView 的连续/成就徽章、DashboardView 的项目眼、热力明细关闭钮）
  "flame.fill": '<path class="fill" d="M8.4 1.7c2.3 2.5 3.9 4.2 3.9 6.5A4.3 4.3 0 0 1 8 12.5a4.3 4.3 0 0 1-4.3-4.3c0-1.3.5-2.5 1.4-3.6.2 1 .8 1.7 1.6 2-.4-2.5.6-4.4 1.7-4.9z"/>',
  eye: '<path d="M1.7 8S4 4.1 8 4.1 14.3 8 14.3 8 12 11.9 8 11.9 1.7 8 1.7 8Z"/><circle cx="8" cy="8" r="1.9"/>',
  "eye.slash.fill": '<path d="M3 5.6C4.7 4.6 6.3 4.1 8 4.1c4 0 6.3 3.9 6.3 3.9s-1 1.6-2.6 2.7M4.4 7.2 2 9.4M5.9 11.4C6.6 11.7 7.3 11.9 8 11.9c1 0 1.8-.3 2.5-.8"/><path d="M2.6 2.6l10.8 10.8"/>',
  "crown.fill": '<path class="fill" d="M2.3 5.4 4.9 7.3 8 3.3l3.1 4 2.6-1.9-1.3 6.4H3.6z"/><path class="fill" d="M3.4 12.2h9.2v1.5H3.4z"/>',
  "hexagon.fill": '<path class="fill" d="M8 1.8 13.4 5v6L8 14.2 2.6 11V5z"/>',
  "diamond.fill": '<path class="fill" d="M8 1.9 14.1 8 8 14.1 1.9 8z"/>',
  diamond: '<path d="M8 2.4 13.6 8 8 13.6 2.4 8z"/>',
  banknote: '<rect x="1.7" y="4.2" width="12.6" height="7.6" rx="1.4"/><circle cx="8" cy="8" r="1.9"/>',
  "square.grid.2x2.fill": '<path class="fill" d="M2.6 2.6h4.5v4.5H2.6zM8.9 2.6h4.5v4.5H8.9zM2.6 8.9h4.5v4.5H2.6zM8.9 8.9h4.5v4.5H8.9z"/>',
  "square.grid.3x3.fill": '<path class="fill" d="M2.1 2.1h3.1v3.1H2.1zM6.5 2.1h3.1v3.1H6.5zM10.9 2.1h3.1v3.1h-3.1zM2.1 6.5h3.1v3.1H2.1zM6.5 6.5h3.1v3.1H6.5zM10.9 6.5h3.1v3.1h-3.1zM2.1 10.9h3.1v3.1H2.1zM6.5 10.9h3.1v3.1H6.5zM10.9 10.9h3.1v3.1h-3.1z"/>',
  "rectangle.3.group.fill": '<path class="fill" d="M1.7 4.4h3.7v7.2H1.7zM6.2 4.4h3.7v7.2H6.2zM10.7 4.4h3.6v7.2h-3.6z"/>',
  scope: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="1.5"/><path d="M8 1.3v2.2M8 12.5v2.2M1.3 8h2.2M12.5 8h2.2"/>',
  "clock.badge.checkmark.fill": '<circle cx="6.7" cy="7.5" r="4.8"/><path d="M6.7 5.1v2.5l1.6 1"/><path d="M10.7 12.2l1.5 1.5 2.6-2.8"/>',
  "repeat.circle": '<circle cx="8" cy="8" r="6.2"/><path d="M5.6 6.5h5.1l-1.4-1.6M10.4 9.5H5.3l1.4 1.6"/>',
  "moon.stars.fill": '<path class="fill" d="M8.9 3.1a4.6 4.6 0 1 0 4.4 6.2 5.5 5.5 0 0 1-4.4-6.2z"/><path class="fill" d="M12.4 1.8l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z"/>',
  "sunrise.fill": '<path class="fill" d="M5.1 10.7a2.9 2.9 0 0 1 5.8 0z"/><path d="M8 2.2v2.4M4 5.4 5.4 6.8M12 5.4l-1.4 1.4M1.8 12.6h12.4"/>',
  "beach.umbrella.fill": '<path class="fill" d="M2.1 8.2a5.9 5.9 0 0 1 11.8 0z"/><path d="M8 8.2v6.2a1.6 1.6 0 0 1-3.1.4"/>',
};

/** SF 的实心档是「填满的圆里挖出符号」，线性描边做不到挖色，这几枚按
 *  arrow.clockwise.circle.fill 那条注释建立的等价做法退回线性档。 */
ICONS["dollarsign.circle.fill"] = ICONS["dollarsign.circle"];
ICONS["banknote.fill"] = ICONS.banknote;
ICONS["repeat.circle.fill"] = ICONS["repeat.circle"];

function icon(name, cls) {
  return `<svg viewBox="0 0 16 16"${cls ? ` class="${cls}"` : ""} aria-hidden="true">${ICONS[name] || ICONS["info.circle"]}</svg>`;
}

/** cardHead / cardHeadPlain：卡头不是按钮，展开「按模型」由披露行自己负责 */
function cardHead(title, sessions, toolID) {
  return `<div class="card-head">
    <span class="head-dot"></span>
    <span class="head-title">${escapeHtml(title)}</span>
    ${sessions > 0 ? `<span class="head-sessions">${Number(sessions)}</span>` : ""}
    <span class="filler"></span>
    ${toolID ? `<button type="button" class="head-copy" data-copy-tool="${escapeHtml(toolID)}"
      title="复制此工具用量图" aria-label="复制此工具用量图">${icon("photo.on.rectangle")}</button>` : ""}
  </div>`;
}

/** CostHeadline：大号数值 + 10 号说明 */
function costHeadline(value, caption) {
  return `<div class="headline"><b>${escapeHtml(String(value))}</b><span>${escapeHtml(caption)}</span></div>`;
}

/** Metric 是 [图标, 标签, 数值] 三元组 */
function metricCell(m) {
  return `<div class="metric"><span class="m-ic">${icon(m[0])}</span><span class="m-body">`
    + `<span class="m-label">${escapeHtml(m[1])}</span><span class="m-value">${escapeHtml(m[2])}</span></span></div>`;
}

/** RingMetricCell：21 圆环、线宽 2.5、从 12 点顺时针；标签恒为 Cache Hit */
function ringCell(hit) {
  const r = (21 - 2.5) / 2;
  const c = 2 * Math.PI * r;
  const arc = c * Math.max(0.001, Math.min(1, hit / 100));
  return `<div class="metric"><span class="m-ring"><svg viewBox="0 0 21 21" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="${r}" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="2.5"/>
      <circle cx="10.5" cy="10.5" r="${r}" fill="none" stroke="var(--tint)" stroke-width="2.5" stroke-linecap="round"
        stroke-dasharray="${arc.toFixed(2)} ${(c - arc).toFixed(2)}" transform="rotate(-90 10.5 10.5)"/>
    </svg></span><span class="m-body"><span class="m-label">Cache Hit</span>`
    + `<span class="m-value">${Math.round(hit)}%</span></span></div>`;
}

/** metricGrid：top → 命中环 → extra，两列 */
function metricGrid(top, hit, extra) {
  const cells = [...(top || []), ...(hit > 0 ? [null] : []), ...(extra || [])]
    .map((m) => (m === null ? ringCell(hit) : metricCell(m)));
  return `<div class="metrics">${cells.join("")}</div>`;
}

function thinDiv() {
  return `<div class="thin-div"></div>`;
}

/** 一行额度；pct 传「剩余百分比」。title 承接 macOS 的 .help()（PV:2458-2461） */
function quotaRow(opts) {
  const { title, pct, detail, reset, stale, tint } = opts;
  const clamped = Math.min(100, Math.max(0, Number(pct) || 0));
  const low = clamped <= 15 && !stale;
  // SubscriptionQuotaPresentation.hasResetSinceReading：窗口已翻篇就只写「已重置」，不画条
  const resetPassed = !!stale && reset != null && Number(reset) * 1000 <= Date.now();
  const value = resetPassed
    ? `<span class="q-done">已重置</span>`
    : `<span class="q-value">${clamped < 0.5 ? "已用尽" : `${Math.round(clamped)}%`}</span>`
      + (reset == null ? "" : `<span class="q-reset">· ${escapeHtml(resetText(reset))}</span>`);
  // 「即将重置」拼进「%@ 后重置」会得到 macOS 原样的「即将重置 后重置」，这里不替它改词
  const help = resetPassed ? `窗口已在 ${resetText(reset)} 重置，还没读到新窗口的额度`
    : stale ? "上次读到的额度，尚未刷新"
      : reset == null ? "" : `${countdown(reset)} 后重置`;
  return `<div class="q-row${low ? " is-low" : ""}${stale ? " is-stale" : ""}"${tint ? ` style="--tint:${tint}"` : ""}`
    + `${help ? ` title="${escapeHtml(help)}"` : ""}>
    <div class="q-top"><span class="q-title">${escapeHtml(title)}</span>
      ${detail ? `<span class="q-detail">${escapeHtml(detail)}</span>` : ""}
      <span class="filler"></span>${value}</div>
    ${resetPassed ? "" : `<div class="q-bar"><i style="width:max(3px,${clamped.toFixed(1)}%)"></i></div>`}
  </div>`;
}

/** 额度落款：「额度更新 · …」/「上次读到 · …」；help 对应 macOS 落款上的 .help() */
function qStamp(text, icon2, help, warning) {
  return `<div class="q-stamp${warning ? " is-warn" : ""}"${help ? ` title="${escapeHtml(help)}"` : ""}>${icon(icon2 || "clock")}`
    + `<span>${escapeHtml(text)}</span></div>`;
}

/** quotaStateNotice：状态块；warning 走橙色 */
function quotaStateNotice(opts) {
  const { title, detail, source, updated, warning } = opts;
  const label = updated == null ? "尚无更新时间" : `上次更新 ${resetText(updated)}`;
  return `<div class="notice"${warning ? ' style="--tint:#ff9f0a"' : ""}>
    <div class="nt">${icon(warning ? "exclamationmark.triangle" : "info.circle")}<span>${escapeHtml(title)}</span></div>
    <div class="nd">${escapeHtml(detail)}</div>
    <div class="ns">${icon("clock")}<span>${escapeHtml(`${source} · ${label}`)}</span></div>
  </div>`;
}

/**
 * providerQuotaContent（PV:1062-1144）：联网 Provider 额度的通用模板。
 * Swift 里这些元素是卡片 VStack(spacing 11) 的兄弟节点，所以这里不套外层容器，逐段平铺。
 */
function providerQuotaContent(q) {
  if (!q || q.available !== true) return "";
  const html = [];
  if (q.plan || q.account) {
    html.push(`<div class="pq-head">`
      + (q.plan ? `<span class="p-pill">${escapeHtml(String(q.plan))}</span>` : "")
      + (q.account ? `<span class="pq-account">${escapeHtml(String(q.account))}</span>` : "")
      + `<span class="filler"></span></div>`);
  }
  for (const w of (q.windows || [])) {
    const title = String(w.title || w.id || "");
    if (w.usage_known !== false && w.used_pct != null) {
      html.push(quotaRow({
        title, pct: Math.min(100, Math.max(0, 100 - Number(w.used_pct))),
        detail: w.detail, reset: w.reset,
      }));
    } else {
      html.push(`<div class="pq-unknown"><span class="q-title">${escapeHtml(title)}</span>`
        + `<span class="filler"></span><span class="pq-note">${escapeHtml(String(w.detail || "额度比例未知"))}</span></div>`);
    }
  }
  const details = (q.details || []).slice(0, 12);
  if (details.length) {
    html.push(thinDiv());
    html.push(`<div class="pq-details">${details.map((d) => {
      const label = String(d.label || "");
      // providerQuotaDetailValue（PV:1155-1161）：标签写「到期」时值其实是 epoch 秒
      const value = label.includes("到期") && /^\d+$/.test(String(d.value))
        ? resetText(Number(d.value)) : String(d.value || "");
      return `<div class="pd-row"><span class="pd-label">${escapeHtml(label)}</span><span class="filler"></span>`
        + `<span class="pd-right"><span class="pd-value">${escapeHtml(value)}</span>`
        + (d.secondary ? `<span class="pd-second">${escapeHtml(String(d.secondary))}</span>` : "") + "</span></div>";
    }).join("")}</div>`);
  }
  if (q.stale === true) {
    html.push(qStamp(`上次读到 · ${q.updated == null ? "更新时间未知" : resetText(q.updated)}`,
      "clock.arrow.circlepath", "当前展示最近一次成功结果；登录态或网络恢复后会自动刷新。"));
  } else if (q.updated != null) {
    html.push(`<div class="pq-stamp">${icon("clock")}<span>额度更新于 ${escapeHtml(resetText(q.updated))}</span></div>`);
  }
  return html.join("");
}

/** modelBadge / plan 胶囊 */
function badgeRow(label, value) {
  return `<div class="badge-row"><span class="bl">${escapeHtml(label)}</span><span class="filler"></span>`
    + `<span class="bv">${escapeHtml(value)}</span></div>`;
}

function emptyHint() {
  return `<p class="hint-empty">暂无数据</p>`;
}

/**
 * usageEmptyHint：刷新中 / 真的没有必须能分辨（UsageEmptyState）。
 * recent 只在选中的是「今日」且更早区间确实有用量时才有值。
 */
function usageEmptyHint(recent) {
  if (state.refreshing) return `<div class="hint-stack"><span>正在刷新${rangeLabel(state.range)}用量…</span></div>`;
  return `<div class="hint-stack"><span>${rangeLabel(state.range)}暂无用量，额度状态如下</span>`
    + (recent ? `<span>最近一次 · ${escapeHtml(recent)}</span>` : "") + "</div>";
}

/** UsageEmptyState.resolve 的 today 旁证：今日为零时拿最近一个有用量的区间作证 */
function recentUsageHint(tokensOf) {
  if (state.refreshing || state.range !== "today") return null;
  if (tokensOf(state.range) > 0) return null;
  for (const key of ["yesterday", "week", "month"]) {
    const n = tokensOf(key);
    if (n > 0) return `${rangeLabel(key)} ${human(n)}`;
  }
  return null;
}

/** 各窗口 (value, stale) 折成一个状态；对应 SubscriptionQuotaState.resolve */
function quotaState(windows) {
  const has = windows.filter((w) => w[0] != null);
  if (!has.length) return "unavailable";
  const stale = has.filter((w) => w[1] === true).length;
  if (stale === 0) return "available";
  return stale === has.length ? "expired" : "partially";
}

/** Claude：额度窗全空时，有用量也要说明「只有用量、没有额度」 */
function claudeBlock(card, n) {
  const r = toolRange("claude", state.range) || emptyRange("claude");
  const state_ = quotaState([[n.q5, n.q5_stale], [n.q7, n.q7_stale], [n.qf, n.qf_stale]]);
  const html = [cardHead("Claude Code", r.sessions, "claude")];
  if (r.sessions > 0) {
    html.push(costHeadline(human(r.in + r.out + r.cr + r.cw), `${selLabel()} 总量`));
    html.push(metricGrid(
      [["dollarsign.circle", "≈成本", `$${(Number(r.cost) || 0).toFixed(2)}`]], r.hit, [
        ["arrow.down", "输入", human(r.in)],
        ["arrow.up", "输出", human(r.out)],
        ["bolt.fill", "缓存读", human(r.cr)],
        ["square.stack.3d.up.fill", "缓存写", human(r.cw)],
      ]));
    const rows = claudeModelRows(r);
    if (rows.length) html.push(modelDisclosure(rows, "claude"));
  } else if (state_ !== "unavailable") {
    html.push(usageEmptyHint(recentUsageHint((key) => {
      const x = toolRange("claude", key) || emptyRange("claude");
      return x.in + x.out + x.cr + x.cw;
    })));
  }
  if (state_ !== "unavailable") {
    html.push(thinDiv());
    if (n.q5 != null) html.push(quotaRow({ title: "5h 剩余", pct: 100 - n.q5, reset: n.q5_reset, stale: n.q5_stale === true }));
    if (n.q7 != null) html.push(quotaRow({ title: "周 · 全部剩余", pct: 100 - n.q7, reset: n.q7_reset, stale: n.q7_stale === true }));
    if (n.qf != null) html.push(quotaRow({ title: "周 · Fable 剩余", pct: 100 - n.qf, reset: n.qf_reset, stale: n.qf_stale === true, tint: "#ff9f0a" }));
    const fresh = (n.q5 != null && n.q5_stale !== true) || (n.q7 != null && n.q7_stale !== true) || (n.qf != null && n.qf_stale !== true);
    // claudeQuotaStatus（PV:2464-2485）：只要还有一档是新的就写「额度更新」，全过期才落实款
    html.push(fresh
      ? qStamp(`额度更新 · ${n.q_updated == null ? "更新时间未知" : resetText(n.q_updated)}`, "clock",
        "来自 Claude Code CLI 或 Desktop")
      : qStamp(`上次读到 · ${n.q_updated == null ? "更新时间未知" : resetText(n.q_updated)}`, "clock.arrow.circlepath",
        "Claude Code 或 Claude 桌面端下次读到额度时自动刷新"));
  } else if (r.sessions > 0) {
    html.push(thinDiv());
    html.push(quotaStateNotice({
      title: "暂未获取到额度数据",
      detail: state.settings?.claude_cli_quota_enabled
        ? "用量统计不受影响；登录态或网络恢复后会自动重试。"
        : "仅使用 CLI 时，可在「隐私与额度」开启 Claude Code CLI 额度查询。",
      source: "Claude Code 额度缓存",
      updated: n.q_updated,
    }));
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

/** claudeRange 的模型行：命中率 = cr / (cr+cw+in)，「合成」这类占位模型不上卡 */
function claudeModelRows(r) {
  return (r.models || []).filter((m) => m.name !== "合成").map((m) => {
    const denom = (m.cr || 0) + (m.cw || 0) + (m.in || 0);
    return {
      name: m.name, total: (m.in || 0) + (m.out || 0) + (m.cr || 0) + (m.cw || 0),
      hit: denom ? (m.cr || 0) / denom * 100 : 0, fixedCost: m.cost, hasBreakdown: true,
      tokIn: m.in, tokOut: m.out, tokCR: m.cr, tokCW: m.cw,
      pin: m.pin, pout: m.pout, pcr: m.pcr, priceRef: m.pref,
    };
  });
}

/** Codex：5h / 周 / Reserve 三档额度常驻，Reserve 只出按模型 */
function codexBlock(card, n) {
  const r = toolRange("codex", state.range) || emptyRange("codex");
  const cards = n.reset_cards;
  // PV:673-674：重置卡要按 count 判存在，网络抓取失败时是 null、拿到空批次是 count 0，两者都不算有额度。
  const hasQuotaData = n.p5 != null || n.pw != null || n.reserve_quota != null
    || (cards != null && Number(cards.count) > 0);
  const html = [cardHead("Codex", r.sessions, "codex")];
  if (r.sessions > 0) {
    html.push(costHeadline(human(r.in + r.cached + r.out), `${selLabel()} 总量`));
    const extra = [
      ["arrow.down", "输入", human(r.in)],
      ["bolt.fill", "缓存读", human(r.cached)],
      ["arrow.up", "输出", human(r.out)],
    ];
    if (r.reason > 0) extra.push(["brain", "推理", human(r.reason)]);
    html.push(metricGrid([["dollarsign.circle", "≈成本", `$${(Number(r.cost) || 0).toFixed(2)}`]], r.hit, extra));
    if ((r.models || []).length) html.push(tokenModelDisclosure(r.models, "codex", { reasonIncludedInOutput: true }));
  } else if (hasQuotaData) {
    html.push(usageEmptyHint(recentUsageHint((key) => {
      const x = toolRange("codex", key) || emptyRange("codex");
      return x.in + x.out + x.reason;
    })));
  }
  if (hasQuotaData) html.push(thinDiv());
  if (n.p5 != null) html.push(quotaRow({ title: "5h 剩余", pct: 100 - n.p5, reset: n.r5, stale: n.p5_stale === true }));
  if (n.pw != null) html.push(quotaRow({ title: "周剩余", pct: 100 - n.pw, reset: n.rw, stale: n.pw_stale === true }));
  // PV:710-714：Reserve 额度行与 5h/周排在同一段，中间不插分隔线。
  const rq = n.reserve_quota;
  if (rq != null && rq.used_percent != null) {
    html.push(quotaRow({
      title: "Reserve 剩余", pct: 100 - Number(rq.used_percent), detail: "常规额度外",
      reset: rq.resets_at, stale: rq.stale === true,
    }));
  }
  // PV:715-718：Reserve 明细只有「按模型」一行，且没有 models 非空守卫（会话数才是判据）。
  const rr = (n.reserve_ranges || {})[state.range];
  if (rr != null && Number(rr.sessions) > 0) {
    html.push(tokenModelDisclosure(rr.models || [], "codex-reserve", { reasonIncludedInOutput: true }));
  }
  if (n.p5_stale === true || n.pw_stale === true || (rq != null && rq.stale === true)) {
    html.push(qStamp(
      `上次读到 · ${n.q_updated == null ? "更新时间未知" : resetText(n.q_updated)}`,
      "clock.arrow.circlepath",
      "窗口重置后本机又用过 Codex，旧读数不再准确；等下一条额度记录更新。"));
  }
  if (cards != null && Number(cards.count) > 0) html.push(codexResetCardsRow(cards));
  if (n.plan) html.push(badgeRow("plan", n.plan));
  if (r.sessions > 0 && !hasQuotaData) {
    html.push(thinDiv());
    html.push(quotaStateNotice({
      title: "暂未获取到额度数据",
      detail: "用量统计不受影响；检测到订阅周期后会自动展示。",
      source: "Codex 本地状态",
      updated: null,
    }));
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

/**
 * Codex 重置卡披露：对应 PV:814-881。
 * 收起时是一行「图标 + 重置卡 + N 张 + 最近到期 + chevron」，展开后是到期时间表。
 * expires 为 epoch 秒，展示一律折成东八区（Fmt.beijingTime）。
 */
function codexResetCardsRow(cards) {
  const expires = (cards.expires || []).slice().sort((a, b) => Number(a) - Number(b));
  const open = state.expanded.has("disc:codex-reset");
  const nearest = expires.length
    ? `<span class="reset-nearest">最近 ${escapeHtml(beijingText(expires[0], false))} · 北京时间</span>` : "";
  const head = `<button type="button" class="disc is-reset" data-disc="codex-reset"`
    + ` aria-expanded="${open}" title="查看重置卡到期时间">`
    + `${icon("arrow.clockwise.circle.fill", "reset-ic")}<span class="reset-name">重置卡</span>`
    + `<span class="reset-count">${Number(cards.count)} 张</span><span class="filler"></span>${nearest}`
    + `${icon(open ? "chevron.down" : "chevron.right", "chev")}</button>`;
  if (!open) return head;
  const rows = expires.map((t, i) => `<div class="reset-item"><span class="reset-idx">${i + 1}</span>`
    + `<span class="reset-kind">完整重置</span><span class="filler"></span>`
    + `<span class="reset-time">${escapeHtml(beijingText(t, true))}</span></div>`).join("");
  return head + `<div class="reset-panel${animIn("disc:codex-reset")}"><div class="reset-head">`
    + `<span class="rh-title">到期时间</span><span class="filler"></span>`
    + `<span class="rh-tz">北京时间 UTC+8</span></div>${rows}</div>`;
}

/** Kimi Code：额度来自官方 usages，登录态一过期就必须能表达「读数已过期」 */
function kimiCodeBlock(card, n) {
  const r = toolRange("kimicode", state.range) || emptyRange("kimicode");
  const hasQuota = n.p5 != null || n.pw != null;
  const hasStaleQuota = n.p5_stale === true || n.pw_stale === true;
  const html = [cardHead("Kimi Code", r.sessions, "kimicode")];
  if (r.sessions > 0) {
    html.push(costHeadline(human(fieldTokens("kimicode", r)), `${selLabel()} 总量`));
    html.push(metricGrid([], r.hit, tokenUsageMetrics(r)));
    if ((r.models || []).length) html.push(tokenModelDisclosure(r.models, "kimicode"));
  } else if (hasQuota) {
    html.push(usageEmptyHint(recentUsageHint((key) => fieldTokens("kimicode", toolRange("kimicode", key) || emptyRange("kimicode")))));
  } else {
    html.push(emptyHint());
  }
  if (hasQuota || hasStaleQuota) html.push(thinDiv());
  if (n.p5 != null) html.push(quotaRow({ title: "5h 剩余", pct: 100 - n.p5, reset: n.r5, stale: n.p5_stale === true }));
  // 接口只给了这一档的重置时刻，没说周期是周还是月，所以标题不写周期名。
  if (n.pw != null) html.push(quotaRow({ title: "订阅额度剩余", pct: 100 - n.pw, reset: n.rw, stale: n.pw_stale === true }));
  if (hasStaleQuota) html.push(qStamp(`上次读到 · ${n.q_updated == null ? "更新时间未知" : resetText(n.q_updated)}`,
    "clock.arrow.circlepath",
    "Kimi Code 的登录态很快到期,过期后 Tokei 不再查询官方额度,也不会代它刷新。在 Kimi Code 里发一条消息即可让它自行刷新,额度随后恢复更新。"));
  if (n.plan) html.push(badgeRow("plan", String(n.plan).replace(/LEVEL_/g, "")));
  if (r.sessions > 0 && !hasQuota && !hasStaleQuota) {
    html.push(thinDiv());
    html.push(quotaStateNotice({
      title: "暂未获取到额度数据",
      detail: "用量统计不受影响；登录 Kimi Code 后会自动展示官方额度。",
      source: "Kimi Code 本地登录态",
      updated: null,
    }));
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

/** Gemini / Antigravity：只有真有用量才画卡头，缓存字段叫「缓存」而不叫「缓存读」 */
function geminiBlock(card, n) {
  const r = toolRange("gemini", state.range) || emptyRange("gemini");
  const rows = (r.models || []).map((m) => {
    const denom = (m.cached || 0) + (m.in || 0);
    return {
      name: m.name, total: (m.in || 0) + (m.out || 0) + (m.cached || 0) + (m.thoughts || 0),
      hit: denom ? (m.cached || 0) / denom * 100 : 0, fixedCost: m.cost, hasBreakdown: true,
      // 上游把 thoughts 放进了「缓存写」那一格，这里跟着一致，不自行改名
      tokIn: m.in, tokOut: m.out, tokCR: m.cached, tokCW: m.thoughts,
      pin: m.pin, pout: m.pout, pcr: m.pcr, priceRef: m.pref,
    };
  });
  // PV:902 与 Model.swift:220：Gemini 卡整张以 hasUsage 为闸门，没有用量就什么都不画（也没有卡头）。
  const hasUsage = Number(r.sessions) > 0 || fieldTokens("gemini", r) > 0;
  if (!hasUsage) return;
  card.insertAdjacentHTML("beforeend", [
    cardHead("Gemini / Antigravity", r.sessions, "gemini"),
    costHeadline(human(fieldTokens("gemini", r)), `${selLabel()} 总量`),
    metricGrid([["dollarsign.circle", "≈成本", `$${(Number(r.cost) || 0).toFixed(2)}`]], r.hit, (() => {
      const extra = [
        ["arrow.down", "输入", human(r.in)],
        ["arrow.up", "输出", human(r.out)],
        ["bolt.fill", "缓存", human(r.cached)],
      ];
      if (r.thoughts > 0) extra.push(["brain", "推理", human(r.thoughts)]);
      return extra;
    })()),
    rows.length ? modelDisclosure(rows, "gemini") : "",
    // PV:928-931：Gemini 的联网额度接在用量之后，没有额度就不插分隔线。
    n.quota && n.quota.available ? thinDiv() + providerQuotaContent(n.quota) : "",
  ].join(""));
}

/** Hermes 与 tokenUsage 族的差别：缓存写不进度量行 */
function hermesBlock(card, n) {
  const r = toolRange("hermes", state.range) || emptyRange("hermes");
  const html = [cardHead("Hermes", r.sessions, "hermes")];
  if (r.sessions > 0) {
    html.push(costHeadline(human(fieldTokens("hermes", r)), `${selLabel()} 总量`));
    const extra = [
      ["arrow.down", "输入", human(r.in)],
      ["arrow.up", "输出", human(r.out)],
      ["bolt.fill", "缓存读", human(r.cr)],
    ];
    if (r.reason > 0) extra.push(["brain", "推理", human(r.reason)]);
    html.push(metricGrid([["dollarsign.circle", "≈成本", `$${(Number(r.cost) || 0).toFixed(2)}`]], r.hit, extra));
    if ((r.models || []).length) html.push(tokenModelDisclosure(r.models, "hermes"));
  } else {
    html.push(emptyHint());
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

/** OpenClaw：没 token 只有任务时也有一张卡（任务/完成/失败三格） */
function openclawBlock(card, n) {
  const r = toolRange("openclaw", state.range) || emptyRange("openclaw");
  const html = [cardHead("OpenClaw", r.sessions, "openclaw")];
  if (fieldTokens("openclaw", r) > 0) {
    html.push(costHeadline(human(r.in + r.out + r.cr + r.cw), `${selLabel()} 总量`));
    const extra = [
      ["arrow.down", "输入", human(r.in)],
      ["arrow.up", "输出", human(r.out)],
      ["bolt.fill", "缓存读", human(r.cr)],
    ];
    if (r.reason > 0) extra.push(["brain", "推理", human(r.reason)]);
    if (r.tasks > 0) extra.push(["checklist", "任务", String(r.tasks)]);
    html.push(metricGrid([["dollarsign.circle", "≈成本", `$${(Number(r.cost) || 0).toFixed(2)}`]], r.hit, extra));
    if ((r.models || []).length) html.push(tokenModelDisclosure(r.models, "openclaw", { reasonIncludedInOutput: true }));
  } else if (r.tasks > 0) {
    html.push(taskTally([["任务", r.tasks, ""], ["完成", r.completed, "is-ok"], ["失败", r.failed, "is-bad"]]));
  } else {
    html.push(emptyHint());
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

/** macOS 那边是三段 VStack(标签 10 号三级色 / 数值 16 号粗体)，等价成一横排 */
function taskTally(items) {
  return `<div class="tally">${items.filter((i) => i[1] > 0).map(([label, value, cls]) =>
    `<div class="tally-cell"><span class="tally-label">${escapeHtml(label)}</span>`
    + `<strong class="tally-value${cls ? " " + cls : ""}">${Number(value)}</strong></div>`).join("")}</div>`;
}

/** Qoder Desktop（IDE 的 SQLite 口径）：cardHeadPlain，没有命中环 */
function qoderIdeBlock(card, n) {
  const r = toolRange("qoder", state.range) || emptyRange("qoder");
  const total = (r.in || 0) + (r.cached || 0) + (r.out || 0);
  const html = [cardHead("Qoder Desktop", 0, "qoder")];
  if (r.calls > 0 || total > 0) {
    if (total > 0) html.push(costHeadline(human(total), `${selLabel()} 总量`));
    const items = [
      ["terminal", "模型调用", String(r.calls)],
      ["person.2", "会话", String(r.sessions)],
    ];
    if (r.sub_agents > 0) items.push(["point.3.connected.trianglepath.dotted", "子agent", String(r.sub_agents)]);
    if (r.messages > 0) items.push(["bubble.left.and.bubble.right", "消息数", human(r.messages)]);
    if (r.ctx > 0) items.push(["chart.bar.fill", "缓存命中", `${Math.round(r.ctx)}%`]);
    if (r.duration > 0) items.push(["clock", "耗时", durationText(r.duration * 1000)]);
    if (r.in > 0) items.push(["arrow.down", "输入", human(r.in)]);
    if (r.out > 0) items.push(["arrow.up", "输出", human(r.out)]);
    if (r.cached > 0) items.push(["bolt.fill", "缓存读", human(r.cached)]);
    html.push(metricGrid(items, 0, []));
    if (n.model) html.push(badgeRow("model", n.model));
  } else {
    html.push(emptyHint());
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

/** QoderWork：任务/会话/耗时打底，其余按有无追加 */
function qoderworkBlock(card, n) {
  const r = toolRange("qoderwork", state.range) || emptyRange("qoderwork");
  const html = [cardHead("QoderWork", 0, "qoderwork")];
  if (r.calls > 0 || fieldTokens("qoderwork", r) > 0) {
    const total = fieldTokens("qoderwork", r);
    if (total > 0) html.push(costHeadline(human(total), `${selLabel()} 总量`));
    const items = [
      ["terminal", "任务", String(r.calls)],
      ["person.2", "会话", String(r.sessions)],
      ["clock", "耗时", durationText(r.duration)],
    ];
    if (r.in > 0) items.push(["arrow.down", "输入", human(r.in)]);
    if (r.out > 0) items.push(["arrow.up", "输出", human(r.out)]);
    if (r.sub_agents > 0) items.push(["point.3.connected.trianglepath.dotted", "子agent", String(r.sub_agents)]);
    if (r.turns > 0) items.push(["bubble.left.and.bubble.right", "模型调用", human(r.turns)]);
    if (r.ctx > 0) items.push(["chart.bar.fill", "平均深度", `${Math.round(r.ctx)}%`]);
    html.push(metricGrid(items, 0, []));
    if (n.model) html.push(badgeRow("model", n.model));
  } else {
    html.push(emptyHint());
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

/** Qoder CLI / Qoder CN：内置路由不落 token 时，Credits 就是唯一的计量 */
function qodercliBlock(card, n, name, id) {
  const r = toolRange(id, state.range) || emptyRange(id);
  const exactTokens = !!r.usage_available && fieldTokens(id, r) > 0;
  const html = [cardHead(name, 0, id)];
  if (r.calls > 0 || fieldTokens(id, r) > 0) {
    if (exactTokens) html.push(costHeadline(human(fieldTokens(id, r)), `${selLabel()} 总量`));
    else if (r.credits > 0) html.push(costHeadline(credits(r.credits), `${selLabel()} Credits`));
    const top = exactTokens && r.credits > 0 ? [["circle.hexagongrid.fill", "Credits", credits(r.credits)]] : [];
    const extra = [
      ["terminal", "模型调用", String(r.calls)],
      ["person.2", "会话", String(r.sessions)],
      ["bubble.left.and.bubble.right", "消息数", human(r.turns)],
      ["clock", "活跃", durationText(r.duration)],
    ];
    if (r.usage_available) {
      extra.push(["arrow.down", "输入", human(r.in)], ["arrow.up", "输出", human(r.out)]);
      if (r.cr > 0) extra.push(["bolt.fill", "缓存读", human(r.cr)]);
      if (r.cw > 0) extra.push(["square.stack.3d.up.fill", "缓存写", human(r.cw)]);
    }
    if (r.tools > 0) extra.push(["wrench.and.screwdriver", "工具调用", human(r.tools)]);
    if (r.sub_agents > 0) extra.push(["point.3.connected.trianglepath.dotted", "子agent", String(r.sub_agents)]);
    html.push(metricGrid(top, r.hit, extra));
    if ((r.models || []).length) html.push(tokenModelDisclosure(r.models, id));
    else if (n.model) html.push(badgeRow("model", n.model));
  } else {
    html.push(emptyHint());
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

/** Grok Build：真实用量优先，没有 usage 时画上下文快照 */
function grokBlock(card, n) {
  const r = toolRange("grok", state.range) || emptyRange("grok");
  const hasUsage = r.sessions > 0 || r.usage_calls > 0;
  const state_ = quotaState([[n.pct, n.stale]]);
  const periodEnded = n.stale === true && n.reset != null && Number(n.reset) * 1000 <= Date.now();
  const html = [cardHead("Grok", r.sessions, "grok")];
  if (hasUsage) {
    html.push(costHeadline(human(r.tokens), `${selLabel()} ${r.usage_available ? "真实用量" : "上下文快照"}`));
    const items = [];
    if (r.usage_available) {
      if (r.cost > 0) items.push(["dollarsign.circle", "≈成本", `$${(Number(r.cost) || 0).toFixed(2)}`]);
      items.push(
        ["arrow.down", "输入", human(r.in)],
        ["bolt.fill", "缓存读", human(r.cr)],
        ["arrow.up", "输出", human(r.out)]);
      if (r.reason > 0) items.push(["brain", "推理", human(r.reason)]);
      items.push(["waveform", "调用", String(r.usage_calls)]);
    }
    items.push(["arrow.triangle.2.circlepath", "轮次", String(r.turns || 0)], ["wrench.and.screwdriver", "工具", String(r.tools || 0)]);
    if (r.duration > 0) items.push(["clock", "耗时", durationText(r.duration * 1000)]);
    if (r.ctx > 0) items.push(["chart.bar.fill", "窗口", `${Math.round(r.ctx)}%`]);
    if (r.ttft > 0) items.push(["timer", "首字", `${(r.ttft / 1000).toFixed(1)}s`]);
    if (r.response > 0) items.push(["speedometer", "响应", `${(r.response / 1000).toFixed(1)}s`]);
    if (r.errors > 0) items.push(["exclamationmark.triangle", "错误", String(r.errors)]);
    if (r.cancellations > 0) items.push(["xmark.circle", "取消", String(r.cancellations)]);
    html.push(metricGrid([], r.usage_available ? r.hit : 0, items));
    if (r.usage_available && (r.models || []).length) html.push(tokenModelDisclosure(r.models, "grok"));
    else if (n.model) html.push(badgeRow("model", n.model));
    html.push(`<p class="hint-wrap">${escapeHtml(r.usage_available
      ? (r.cost > 0
        ? "来自 Grok Build 本地推理日志；成本按 API 价估算，订阅实付不按此。"
        : "来自 Grok Build 本地推理日志；当前模型未匹配到公开价格。")
      : "旧版日志未保存真实用量，当前仅展示上下文与执行指标。")}</p>`);
  } else if (state_ !== "unavailable") {
    html.push(usageEmptyHint(recentUsageHint((key) => {
      const x = toolRange("grok", key) || emptyRange("grok");
      return x.in + x.out + x.cr + x.reason;
    })));
  }
  if (n.pct != null) {
    html.push(thinDiv());
    html.push(quotaRow({
      title: n.window === "month" ? "月剩余" : "周剩余",
      pct: 100 - n.pct, reset: n.reset, stale: n.stale === true,
    }));
    if (!periodEnded) {
      for (const p of (n.products || []).filter((x) => x.pct != null)) {
        html.push(grokShareRow(grokProductLabel(p.name), p.pct, grokProductHelp(p.name)));
      }
    }
    if (n.plan) html.push(badgeRow("plan", n.plan));
    html.push(qStamp(`额度来源 ${grokSourceLabel(n.source)} · ${n.q_updated == null ? "更新时间未知" : resetText(n.q_updated)}`,
      "clock",
      n.source === "live"
        ? "已开启 Grok 实时额度查询。Grok Build / API 等为同一周额度池内的占用拆分，共享上方重置时间。"
        : "默认只读 ~/.grok 本地日志，不访问网络"));
    if (n.auth_expired === true) html.push(grokAuthNotice(n));
  } else if (n.auth_expired === true) {
    if (hasUsage) html.push(thinDiv());
    html.push(grokAuthNotice(n));
  } else if (hasUsage) {
    html.push(thinDiv());
    html.push(quotaStateNotice({
      title: "暂未获取到额度数据",
      detail: "用量统计不受影响；检测到订阅周期后会自动展示。",
      source: grokSourceLabel(n.source),
      updated: n.q_updated,
    }));
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

function grokSourceLabel(source) {
  return source === "live" ? "Grok 实时接口" : source === "cache" ? "Grok 本地缓存" : "Grok 本地日志";
}

/** grokProductLabel（PV:1390-1397）：账单 product 字段换成可读名 */
function grokProductLabel(raw) {
  const k = String(raw || "").toLowerCase();
  if (k === "grokbuild") return "Grok Build（本机 CLI）";
  if (k === "api") return "开放 API（api.x.ai）";
  if (k === "grokchat") return "Grok 网页聊天";
  return String(raw || "");
}

/** grokProductHelp（PV:1400-1411）：悬停说明的是「池内占用」，不是独立额度 */
function grokProductHelp(raw) {
  const k = String(raw || "").toLowerCase();
  if (k === "grokbuild") return "Grok Build / 本机 CLI 编程消耗，占用本周统一额度池的比例。";
  if (k === "api") return "通过 xAI 开放 API（api.x.ai / Console 密钥）调用模型的消耗，与 CLI 共用同一周额度池。";
  if (k === "grokchat") return "grok.com 网页聊天消耗，与 CLI / 开放 API 共用同一周额度池。";
  return "该产品在本周统一额度池中的占用比例（与周剩余共用同一重置时间）。";
}

/**
 * grokProductShareRow（PV:1414-1430）：条上显示的是「还剩多少」，所以 MiniBar 传 100-占用。
 * 名称在 macOS 是 lineLimit(1)+minimumScaleFactor(.78)（放不下先缩字号），
 * CSS 没有缩放档位，这里退化成单行省略号——只有名字长到超过半行宽才会看出来。
 */
function grokShareRow(name, usedPct, help) {
  const v = Math.max(0, Math.min(100, 100 - Number(usedPct)));
  return `<div class="share-row"${help ? ` title="${escapeHtml(help)}"` : ""}>`
    + `<div class="sh-top"><span class="sh-name">${escapeHtml(name)}</span><span class="filler"></span>`
    + `<span class="sh-value">占用 ${Math.round(Number(usedPct))}%</span></div>`
    + `<div class="q-bar"><i style="width:max(3px,${v.toFixed(1)}%)"></i></div></div>`;
}

function grokAuthNotice(n) {
  return quotaStateNotice({
    title: "Grok 登录已过期",
    detail: "实时额度暂停查询，先显示本地日志里的额度。运行一次 grok 续期后自动恢复。",
    source: grokSourceLabel(n.source),
    updated: n.q_updated,
    warning: true,
  });
}

/** Grok Bot：Windows 不查官方接口，只有本地活动这一条分支 */
function grokBotBlock(card, n) {
  const r = toolRange("grok_bot", state.range) || emptyRange("grok_bot");
  const html = [cardHead("Grok Bot", r.sessions, "grok_bot")];
  if (r.sessions > 0 || r.calls > 0 || r.turns > 0) {
    html.push(costHeadline(human(r.calls > 0 ? r.calls : r.turns), `${selLabel()} 响应`));
    const items = [
      ["bubble.left", "你的消息", human(r.turns)],
      ["sparkles", "响应", human(r.calls)],
    ];
    if (r.tools > 0) items.push(["wrench.and.screwdriver", "工具调用", human(r.tools)]);
    if (r.duration > 0) items.push(["clock", "活跃", durationText(r.duration * 1000)]);
    html.push(metricGrid(items, 0, []));
    html.push(`<p class="hint-wrap">${escapeHtml("本地活动 · 授权后显示官方 Token、模型和成本")}</p>`);
  } else {
    html.push(emptyHint());
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

/** 千问办公：纯额度卡，没有任何本地 token 可画 */
function qwenWorkBlock(card, n) {
  const html = [cardHead("千问办公", 0, "qwenwork")];
  const hasData = n.available === true || n.remaining != null || (n.segments || []).length > 0 || n.shared != null;
  if (hasData) {
    if (n.exceeded) html.push(`<div class="q-over">${icon("exclamationmark.triangle.fill")}`
      + `<span>官方额度状态：已用尽</span></div>`);
    if (n.remaining != null) {
      html.push(costHeadline(credits(n.remaining), n.is_team ? "团队账号个人可用积分" : "个人可用积分"));
    }
    if (n.remaining_pct != null) {
      html.push(quotaRow({ title: "综合剩余比例", pct: n.remaining_pct, reset: null }));
    }
    if (n.expires_at != null) html.push(qwenDateRow("额度有效期", n.expires_at));
    if (n.plan_expiration != null && n.plan_expiration !== n.expires_at) {
      html.push(qwenDateRow("套餐有效期", n.plan_expiration));
    }
    if ((n.segments || []).length) {
      html.push(thinDiv());
      html.push(`<div class="q-sec-title">个人积分明细</div>`);
      for (const s of n.segments) html.push(qwenSegmentRow(s));
    }
    if (n.shared != null) {
      html.push(thinDiv());
      html.push(qwenSharedBlock(n.shared));
    }
    html.push(qwenQuotaStatus(n));
  } else if (state.settings?.qwenwork_quota_enabled) {
    html.push(`<p class="hint-wrap">未读取到额度。请确认千问办公已登录并保持运行。</p>`);
  } else {
    html.push(`<p class="hint-wrap">在设置的「隐私与额度」中开启查询后显示。</p>`);
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

/** qwenWorkSegmentLabel（PV:1616-1624）：id 优先，空则退回 kind，连字符归一成下划线 */
function qwenSegmentLabel(s) {
  const id = String(s.id == null ? "" : s.id);
  const raw = id === "" ? String(s.kind == null ? "" : s.kind) : id;
  const key = raw.toLowerCase().replace(/-/g, "_");
  if (key === "plan" || key === "plan_credits") return "套餐积分";
  if (key === "addon" || key === "add_on" || key === "add_on_credits") return "加购积分";
  if (key === "shared_addon" || key === "shared_add_on" || key === "shared_add_on_credits") return "共享加购积分";
  return key === "" ? "积分" : key;
}

/** qwenWorkSegmentRow（PV:1504-1545）：右侧是「剩余 X 单位」，条旁带百分比，续期优先于到期 */
function qwenSegmentRow(s) {
  const total = Number(s.total) || 0;
  const pct = total > 0 && s.percentage_used != null
    ? Math.min(100, Math.max(0, 100 - Number(s.percentage_used))) : null;
  const parts = ['<div class="q-seg">',
    `<div class="qs-head"><span class="qs-title is-seg">${escapeHtml(qwenSegmentLabel(s))}</span><span class="filler"></span>`
    + (s.remaining != null
      ? `<span class="qs-left">剩余 ${escapeHtml(credits(s.remaining))} ${escapeHtml(qwenUnitLabel(s.unit))}</span>` : "")
    + "</div>"];
  if (total > 0) {
    parts.push(`<p class="qs-used">已用 ${escapeHtml(s.used == null ? "?" : credits(s.used))} / 总量 ${escapeHtml(credits(total))}</p>`);
  }
  if (pct != null) parts.push(qsBarLine(pct));
  if (s.renews_at != null) parts.push(qwenDateRow("续期", s.renews_at));
  else if (s.expires_at != null) parts.push(qwenDateRow("到期", s.expires_at));
  parts.push("</div>");
  return parts.join("");
}

/** 条 + 百分比行（PV:1529-1536 / 1572-1579）：MiniBar 吃剩余比例，<=15 才转红 */
function qsBarLine(pct) {
  const low = pct <= 15;
  return `<div class="qs-bar"><div class="q-bar"><i${low ? ' class="is-low"' : ""}`
    + ` style="width:max(3px,${pct.toFixed(1)}%)"></i></div>`
    + `<span class="qs-pct${low ? " is-low" : ""}">${Math.round(pct)}%</span></div>`;
}

/** qwenWorkUnitLabel（PV:1626-1629）：credit/credits 都写成「积分」，其余原样 */
function qwenUnitLabel(unit) {
  const u = String(unit || "");
  if (!u) return "积分";
  const k = u.toLowerCase();
  return k === "credit" || k === "credits" ? "积分" : u;
}

/** qwenWorkDateRow（PV:1586-1595）：日历图标 8.5 + 「标签 · 日期」9.5 mono，三级色 */
function qwenDateRow(label, epoch) {
  return `<div class="q-date">${icon("calendar")}`
    + `<span>${escapeHtml(`${label} · ${resetText(epoch)}`)}</span></div>`;
}

/**
 * qwenWorkSharedBlock（PV:1547-1584）：团队共享资源包独立成段，不参与上方个人积分。
 * 条上画的还是「还剩多少」，所以传 100-percentage_used；<=15 才转红。
 */
function qwenSharedBlock(sh) {
  const total = Number(sh.total) || 0;
  const remainingPct = total > 0 && sh.percentage_used != null
    ? Math.min(100, Math.max(0, 100 - Number(sh.percentage_used))) : null;
  const head = `<div class="qs-head"><span class="qs-title">团队共享资源包</span><span class="filler"></span>`
    + (sh.remaining != null
      ? `<span class="qs-left">剩余 ${escapeHtml(credits(sh.remaining))} ${escapeHtml(qwenUnitLabel(sh.unit))}</span>` : "")
    + `</div>`;
  const parts = [`<div class="q-shared">`, head,
    `<p class="qs-note">共享包独立展示，不计入上方个人积分</p>`];
  if (total > 0) {
    parts.push(`<p class="qs-used">已用 ${escapeHtml(sh.used == null ? "?" : credits(sh.used))} / 总量 ${escapeHtml(credits(total))}</p>`);
  }
  if (remainingPct != null) parts.push(qsBarLine(remainingPct));
  if (sh.expires_at != null) parts.push(qwenDateRow("共享包到期", sh.expires_at));
  parts.push("</div>");
  return parts.join("");
}

/** qwenWorkQuotaStatus（PV:1597-1614）：来源决定文案，缓存过期换成橙色警告三角 */
function qwenQuotaStatus(n) {
  const src = n.source === "mcp" || n.source === "local_mcp" ? "本机 QwenWork 接口"
    : n.source === "cache" ? "本地缓存" : "额度数据";
  const stale = n.stale === true;
  return qStamp(`${stale ? "缓存可能已过期" : src} · ${n.updated == null ? "更新时间未知" : resetText(n.updated)}`,
    stale ? "exclamationmark.triangle.fill" : "clock",
    "Tokei 仅通过千问办公桌面端的本机 QwenWork 接口读取额度，不读取或保存登录凭据。",
    stale);
}

/**
 * Devin / MiniMax Code：本地 token 与联网额度互不相干，任何一半有数据就画那一半。
 * Windows 端 quota 恒空（还没接联网取数），所以只剩 token 与提示。
 */
function tokenAndQuotaBlock(card, opts) {
  const r = toolRange(opts.id, state.range) || emptyRange(opts.id);
  const hasUsage = r.sessions > 0;
  const html = [cardHead(opts.title, r.sessions, opts.id)];
  if (hasUsage) {
    html.push(costHeadline(human(fieldTokens(opts.id, r)), `${selLabel()} 总量`));
    html.push(metricGrid([["dollarsign.circle", "≈成本", nativeMoney(r.cost, r.cost_cny)]], r.hit, tokenUsageMetrics(r)));
    if ((r.models || []).length) html.push(tokenModelDisclosure(r.models, opts.id));
  }
  const q = toolNode(opts.id)?.quota;
  if (q && q.available === true) {
    if (hasUsage) html.push(thinDiv());
    html.push(providerQuotaContent(q));
  } else if (!hasUsage) {
    html.push(`<p class="hint-wrap">${escapeHtml(opts.emptyHint)}</p>`);
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

/** tokenUsageBlock 的度量行：inclusiveIO 时输入/输出是含缓存的口径，明细改标「其中」 */
function tokenUsageMetrics(r, inclusiveIO) {
  if (inclusiveIO) {
    const items = [
      ["arrow.down", "输入", human((r.in || 0) + (r.cr || 0) + (r.cw || 0))],
      ["arrow.up", "输出", human((r.out || 0) + (r.reason || 0))],
    ];
    if (r.cr > 0) items.push(["bolt.fill", "其中缓存读", human(r.cr)]);
    if (r.reason > 0) items.push(["brain", "其中推理", human(r.reason)]);
    if (r.cw > 0) items.push(["square.stack.3d.up.fill", "其中缓存写", human(r.cw)]);
    return items;
  }
  const items = [
    ["arrow.down", "输入", human(r.in)],
    ["arrow.up", "输出", human(r.out)],
    ["bolt.fill", "缓存读", human(r.cr)],
    ["square.stack.3d.up.fill", "缓存写", human(r.cw)],
  ];
  if (r.reason > 0) items.push(["brain", "推理", human(r.reason)]);
  return items;
}

/** 通用 token 卡：ZCode / MiMoCode / Pi / Prime Agent / WorkBuddy / OpenCode / Qwen Code / Muse / Command / DeepSeek Harness / CodeBuddy */
function tokenUsageBlock(card, opts) {
  const r = toolRange(opts.id, state.range) || emptyRange(opts.id);
  const html = [cardHead(opts.title, r.sessions, opts.id)];
  if (r.sessions > 0) {
    const total = (r.in || 0) + (r.out || 0) + (r.cr || 0) + (r.cw || 0)
      + (opts.reasonIncludedInOutput ? 0 : (r.reason || 0));
    html.push(costHeadline(human(total), `${selLabel()} 总量`));
    const top = opts.showsCost === false ? []
      : [["dollarsign.circle", "≈成本", nativeMoney(r.cost, r.cost_cny)]];
    const creditMetrics = opts.showsCredits && r.credits > 0
      ? [["circle.hexagongrid.fill", "Credits", credits(r.credits)]] : [];
    html.push(metricGrid(top, r.hit, [...creditMetrics, ...tokenUsageMetrics(r, opts.inclusiveIO)]));
    if ((r.models || []).length) {
      html.push(tokenModelDisclosure(r.models, opts.id,
        { reasonIncludedInOutput: opts.reasonIncludedInOutput, inclusiveIO: opts.inclusiveIO }));
    }
  } else {
    html.push(emptyHint());
  }
  card.insertAdjacentHTML("beforeend", html.join(""));
}

/** 各工具的空区间零值节点；缺键会让下面每一处都算成 NaN，所以逐族补齐 */
function emptyRange(id) {
  if (id === "claude") return { hit: 0, in: 0, out: 0, cr: 0, cw: 0, cost: 0, sessions: 0, models: [] };
  if (id === "codex") return { hit: 0, in: 0, cached: 0, out: 0, reason: 0, cost: 0, sessions: 0, models: [] };
  if (id === "gemini") return { hit: 0, in: 0, out: 0, cached: 0, thoughts: 0, cost: 0, sessions: 0, models: [] };
  if (id === "grok") return { tokens: 0, hit: 0, in: 0, out: 0, cr: 0, reason: 0, cost: 0, models: [], usage_available: false, usage_calls: 0, sessions: 0, turns: 0, tools: 0, duration: 0, ctx: 0, ttft: 0, response: 0, errors: 0, cancellations: 0 };
  if (id === "grok_bot") return { in: 0, out: 0, sessions: 0, calls: 0, turns: 0, tools: 0, duration: 0 };
  if (id === "qoder") return { in: 0, out: 0, cached: 0, sessions: 0, calls: 0, sub_agents: 0, messages: 0, ctx: 0, duration: 0 };
  if (id === "qoderwork") return { in: 0, out: 0, sessions: 0, calls: 0, sub_agents: 0, turns: 0, duration: 0, ctx: 0 };
  if (id === "qodercli" || id === "qodercli_cn") return { in: 0, out: 0, cr: 0, cw: 0, sessions: 0, calls: 0, sub_agents: 0, turns: 0, duration: 0, ctx: 0, credits: 0, usage_available: false, usage_calls: 0, hit: 0, models: [], tools: 0 };
  if (id === "openclaw") return { tasks: 0, completed: 0, failed: 0, hit: 0, in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, cost_cny: 0, credits: 0, sessions: 0, models: [] };
  return { hit: 0, in: 0, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, cost_cny: 0, credits: 0, sessions: 0, models: [] };
}

/** Fmt.duration 收毫秒 */
function durationText(ms) {
  const s = Math.floor((Number(ms) || 0) / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${s}s`;
}

/** String(format:"%.2g")：单价只要两位有效数字，3.0 写成 3、0.30 写成 0.3 */
function g(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return String(x);
  if (v === 0) return "0";
  return String(Number(v.toPrecision(2)));
}

/**
 * 「按模型」披露：卡头不再折叠整张卡，展开的是模型明细，每行还能再点开单价胶囊。
 * rows 是各 block 归一化后的模型行，与 Swift 的 ModelRow / TokenModelStat 两条入口对齐。
 */
function toggleExpanded(key) {
  if (state.expanded.has(key)) { state.expanded.delete(key); return; }
  state.expanded.add(key);
  state.animKeys.add(key);
}

/**
 * 披露面板的一次性入场类：SwiftUI 用 withAnimation(.easeInOut(0.2)) + .move(edge:.top)，
 * 这里只有用户刚点开的那个键会挂类，数据刷新重建时不会重播。
 */
function animIn(key) {
  return state.animKeys.has(key) ? " anim-in" : "";
}

function modelDisclosure(rows, ns, periodLabel) {
  const open = state.expanded.has(`disc:${ns}`);
  const head = `<button type="button" class="disc" data-disc="${escapeHtml(ns)}" aria-expanded="${open}">`
    + `${icon("chart.pie.fill", "pie")}<span class="label">按模型 (${rows.length})</span>`
    + `${icon(open ? "chevron.down" : "chevron.right", "chev")}<span class="filler"></span></button>`;
  if (!open) return head;
  const body = rows.map((m) => modelRow(m, ns)).join("");
  return head + `<div class="disc-panel${animIn(`disc:${ns}`)}"><div class="disc-title">按模型 · `
    + `${escapeHtml(periodLabel || selLabel())}</div>${body}</div>`;
}

function modelRow(m, ns) {
  const key = `row:${ns}:${m.name}`;
  const opened = state.expanded.has(key);
  const breakdown = !!m.hasBreakdown;
  const right = [];
  if (m.total > 0) right.push(`<span class="m-total">${human(m.total)}</span>`);
  if (m.hit > 0) right.push(`<span class="m-hit">${Math.round(m.hit)}%</span>`);
  if (m.cost > 0 || (m.cost_cny || 0) > 0) right.push(`<span class="m-cost">${escapeHtml(nativeMoney(m.cost, m.cost_cny))}</span>`);
  else if (m.fixedCost != null) right.push(`<span class="m-cost">$${Number(m.fixedCost).toFixed(2)}</span>`);
  if (m.credits > 0) right.push(`<span class="m-cost">${escapeHtml(credits(m.credits))} C</span>`);
  return `<div>${breakdown
    ? `<button type="button" class="mrow is-clickable" data-model="${escapeHtml(key)}" aria-expanded="${opened}">`
      + `<span class="chevbox">${icon(opened ? "chevron.down" : "chevron.right")}</span>`
    : `<div class="mrow"><span class="chevbox"></span>`}
    <span class="mdot"></span><span class="mname">${escapeHtml(m.name)}</span>
    <span class="mright">${right.join("")}</span>${breakdown ? "</button>" : "</div>"}
    ${breakdown && opened ? modelDetail(m, key) : ""}</div>`;
}

/** 展开后的明细胶囊：缩进 20 是 chevron 8 + 间距 7 + 圆点 5 */
function modelDetail(m, key) {
  const tags = [];
  const p = (label, glyph, value) => `<span class="tag"><span class="l">${escapeHtml(label)}</span>`
    + `<span class="v">${glyph} ${human(value)}</span></span>`;
  const pre = m.subtotals ? "其中" : "";
  tags.push(p("输入", "↓", m.tokIn));
  tags.push(p("输出", "↑", m.tokOut));
  if (m.tokCR > 0) tags.push(p(`${pre}缓存读`, "⚡", m.tokCR));
  if (m.tokCW > 0) tags.push(p(`${pre}缓存写`, "✎", m.tokCW));
  if (m.tokReason > 0) tags.push(p(`${pre}推理`, "◉", m.tokReason));
  if (m.hit > 0) tags.push(`<span class="tag"><span class="l">命中</span><span class="v">${Math.round(m.hit)}%</span></span>`);
  if (m.pin > 0 || m.pout > 0) {
    // 没有公开价、借别的模型估算的加「≈」；缓存读常占大头，单价必须一并写出
    tags.push(`<span class="tag price" title="${escapeHtml(m.priceRef
      ? `没有公开价格，按 ${m.priceRef} 的单价估算` : "每百万 token 的输入 / 输出单价，读 = 缓存读")}">`
      + `<span class="cur">${m.priceRef ? "≈$" : "$"}</span>`
      + `<span class="v">${g(m.pin || 0)}/${g(m.pout || 0)}</span>`
      + (m.pcr > 0 ? `<span class="sep">·</span><span class="l">读</span><span class="v">${g(m.pcr)}</span>` : "")
      + "</span>");
  }
  return `<div class="m-detail${animIn(key)}">${tags.join("")}</div>`;
}

/** TokenModelStat 口径的模型行：total 优先取 tokens，命中率恒为 cr/(cr+cw+in) */
function tokenModelDisclosure(models, ns, opts = {}) {
  const rows = (models || []).map((m) => {
    const total = (m.tokens || 0) > 0 ? m.tokens
      : (m.in || 0) + (m.out || 0) + (m.cr || 0) + (m.cw || 0) + (opts.reasonIncludedInOutput ? 0 : (m.reason || 0));
    const denom = (m.cr || 0) + (m.cw || 0) + (m.in || 0);
    return {
      name: m.name, total, hit: denom ? (m.cr || 0) / denom * 100 : 0,
      cost: m.cost, cost_cny: m.cost_cny, credits: m.credits,
      tokIn: opts.inclusiveIO ? (m.in || 0) + (m.cr || 0) + (m.cw || 0) : m.in,
      tokOut: opts.inclusiveIO ? (m.out || 0) + (m.reason || 0) : m.out,
      tokCR: m.cr, tokCW: m.cw, tokReason: m.reason,
      pin: m.pin, pout: m.pout, pcr: m.pcr, priceRef: m.pref, subtotals: !!opts.inclusiveIO,
      hasBreakdown: (m.in || 0) + (m.out || 0) + (m.cr || 0) + (m.cw || 0) + (m.reason || 0) > 0
        || (m.cost || 0) > 0 || (m.credits || 0) > 0 || (m.pin || 0) > 0 || (m.pout || 0) > 0,
    };
  });
  return modelDisclosure(rows, ns, opts.periodLabel);
}

/** ToolCardItem.active：本机没数据、又没接到额度来源的工具不占格子 */
function toolActive(id, n, r) {
  if (!n) return false;
  switch (id) {
    case "claude": return r.sessions > 0 || n.q5 != null || n.q7 != null || n.qf != null;
    // PV:433-434：active 不含 reserve_quota，重置卡按 count 判（对象没有 length，别拿数组写法糊过去）
    case "codex": return r.sessions > 0 || n.p5 != null || n.pw != null
      || (n.reset_cards != null && Number(n.reset_cards.count) > 0);
    case "gemini": return r.sessions > 0 || fieldTokens("gemini", r) > 0;
    case "grok": return r.sessions > 0 || (r.usage_calls || 0) > 0 || n.pct != null;
    case "grok_bot": return r.sessions > 0 || (r.calls || 0) > 0 || (r.turns || 0) > 0;
    case "qoder": return (r.calls || 0) > 0 || (r.in || 0) + (r.cached || 0) + (r.out || 0) > 0;
    case "openclaw": return (r.tasks || 0) > 0 || fieldTokens("openclaw", r) > 0;
    case "codebuddy": return r.sessions > 0 || fieldTokens("codebuddy", r) > 0 || (r.credits || 0) > 0;
    case "kimicode": return r.sessions > 0 || n.p5 != null || n.pw != null || n.p5_stale === true || n.pw_stale === true;
    case "devin": case "minimax": return r.sessions > 0 || !!n.quota;
    case "qwenwork": return !!state.settings?.qwenwork_quota_enabled || n.available === true
      || n.remaining != null || (n.segments || []).length > 0 || n.shared != null;
    case "qoderwork": case "qodercli": case "qodercli_cn":
      return (r.calls || 0) > 0 || fieldTokens(id, r) > 0;
    default: return r.sessions > 0;
  }
}

const BLOCKS = {
  claude: claudeBlock, codex: codexBlock, kimicode: kimiCodeBlock, gemini: geminiBlock,
  hermes: hermesBlock, openclaw: openclawBlock, qoder: qoderIdeBlock, qoderwork: qoderworkBlock,
  qodercli: (card, n) => qodercliBlock(card, n, "Qoder CLI", "qodercli"),
  qodercli_cn: (card, n) => qodercliBlock(card, n, "Qoder CN", "qodercli_cn"),
  grok: grokBlock, grok_bot: grokBotBlock, qwenwork: qwenWorkBlock,
  devin: (card, n) => tokenAndQuotaBlock(card, {
    id: "devin", title: "Devin",
    emptyHint: "请打开一次 Devin 桌面端并登录，它会把套餐额度写入本地；Token 统计来自 Devin CLI 的会话库。",
  }),
  minimax: (card, n) => tokenAndQuotaBlock(card, {
    id: "minimax", title: "MiniMax Code",
    emptyHint: "Token 统计来自 MiniMax Code 桌面端的本地数据库；在设置 → Provider 额度 填入 Token Plan Key 可显示 5 小时与周额度。",
  }),
};

/** tokenUsageBlock 族的逐工具开关，照 ToolCardItem 表里的参数来 */
const TOKEN_USAGE_OPTS = {
  codebuddy: { showsCost: false, showsCredits: true },
  deepseek_harness: { inclusiveIO: true },
  musecode: { reasonIncludedInOutput: true },
};

/** 卡片顺序 = PANEL_ORDER 的数组序，不按成本重排 */
function cardDescriptors() {
  return PANEL_ORDER.map((id) => ({
    id,
    name: TOOL_META[id].name,
    tint: TOOL_META[id].color,
    visible: cardVisible(id),
    active: toolActive(id, toolNode(id), toolRange(id, state.range) || emptyRange(id)),
    // compactStatus 只属于额度型紧凑卡（Cursor/Zed/Sub2API/z.ai、只有额度的 Grok Bot），
    // Windows 端这些工具还没有额度来源，因此没有紧凑桶。
    compact: false,
  }));
}

function appendGrid(box, list, columns) {
  if (!list.length) return;
  const grid = document.createElement("div");
  grid.className = "tool-grid" + (columns === 1 ? " is-single" : "");
  box.appendChild(grid);
  for (const c of list) {
    const card = document.createElement("section");
    card.className = "card";
    card.dataset.tool = c.id;
    card.style.setProperty("--tint", c.tint);
    grid.appendChild(card);
    const node = toolNode(c.id) || {};
    const block = BLOCKS[c.id];
    if (block) block(card, node);
    else tokenUsageBlock(card, { id: c.id, title: cardTitle(c.id), ...(TOKEN_USAGE_OPTS[c.id] || {}) });
  }
}

/**
 * 对应 toolCardsLayout：窄页把 compact 排在 standard 前面串成一列；
 * 宽页两个桶各自成网格，单张 compact 卡独占一行（columns: count==1 ? 1 : 2）。
 */
function renderCards() {
  const box = $("tool-cards");
  box.innerHTML = "";
  const cards = cardDescriptors();
  const shown = cards.filter((c) => c.visible && c.active);
  const compact = shown.filter((c) => c.compact);
  const standard = shown.filter((c) => !c.compact);
  if (visibleToolCount() > 2) {
    appendGrid(box, compact, compact.length === 1 ? 1 : 2);
    appendGrid(box, standard, 2);
  } else {
    appendGrid(box, compact.concat(standard), 1);
  }
  // inactiveToolsLine：本区间没数据不等于统计坏了，把缺谁写在卡片下面
  const idle = cards.filter((c) => c.visible && !c.active).map((c) => c.name);
  const line = $("idle-tools");
  line.textContent = idle.length ? `未检测到本地数据: ${idle.join(" · ")}` : "";
  line.hidden = !idle.length;
  // 入场类只活一轮：这一帧已经挂到面板上，下一帧（含数据刷新）就不再挂
  state.animKeys.clear();
}

/** 整页的 90pt 加载 / 失败态（panelContent 的 else 分支） */
function renderPageState() {
  const box = $("tool-cards");
  box.innerHTML = state.loadError
    ? `<div class="page-state">${icon("exclamationmark.triangle")}`
      + `<span class="msg">${escapeHtml(state.loadError)}</span></div>`
    : `<div class="page-state"><span class="spin"></span><span class="msg">加载中…</span></div>`;
  $("idle-tools").hidden = true;
}


// ---------------- 额度轨迹（QuotaHistoryView.swift） ----------------

/**
 * 窗口标识到文案：主进程的历史与投影都用稳定 id（"5h" 等），macOS 侧是拿中文字面量
 * 当键再走 L()，这里等价地查这张表。
 */
const CURVE_WINDOW_LABEL = { "5h": "5 小时", "week-all": "周 · 全部", "week-fable": "周 · Fable", "week": "周" };
const CURVE_TINT = { claude: "#eb8566", codex: "#6badfa" };
/** 六档跨度（QuotaHistorySpan）：1月/1年 画的是账本里的每日真实 token 消耗，不是额度% 曲线 */
const CURVE_SPANS = [[1, "1h"], [6, "6h"], [24, "24h"], [168, "1周"], [720, "1月"], [8760, "1年"]];
/** 对应 QuotaHistorySpan.showsDailyTokens：额度% 快照只留 7 天，再长的跨度没有曲线可画 */
function spanShowsDaily(hours) {
  return hours === 720 || hours === 8760;
}
/** 对应 QuotaHistorySpan.days = max(rawValue / 24, 1)，Swift 那里是整数除法 */
function spanDays(hours) {
  return Math.max(Math.floor(hours / 24), 1);
}
/** 对应 seriesColor(for:)：Claude 三条线各一色，Codex 用工具色 */
const CURVE_COLORS = {
  claude: { "5h": "#ff6e47", "week-all": "#a88cff", "week-fable": "#ffb829" },
  codex: { week: "#6badfa" },
};
/** 对应 QuotaHistorySpan.axisStride（小时） */
const CURVE_STRIDE = { 1: 1, 6: 2, 24: 6, 168: 24 };
/**
 * Swift Charts 那 235 点高的图被拆成：图例 18 + 间距 6 + SVG 211（上留白 6 + 绘图区 189 + x 轴标签 16）。
 * y 轴标签在左侧（AxisMarks(position: .leading)），所以绘图区从 26 点起画。
 */
const CURVE_CHART = { legend: 18, gap: 6, svgHeight: 211, top: 6, plot: 189, axisBottom: 16, axisLeft: 26, axisRight: 4 };

const CURVE_FOOTNOTE = "额度曲线来自本机定时快照；每日用量是当天剩余额度下降之和，回满不抵扣，"
  + "当天有一头没采到的标「约」；模型标记来自同一分钟内本地会话 token 增量，仅表示相关活动，"
  + "不等同于官方逐模型扣费归因。";
/** 长跨度那一份（QuotaHistoryView.swift:165） */
const DAILY_FOOTNOTE = "长跨度画的是每日真实 token 消耗，已合并所有设备的账本（CLI 清理旧日志也不缩水）；"
  + "额度百分比快照只保留 7 天，画不了这么长。";

function curveLabel(window) {
  return CURVE_WINDOW_LABEL[window] || window;
}

function curveColor(toolId, window) {
  return (CURVE_COLORS[toolId] || {})[window] || CURVE_TINT[toolId];
}

function hhmm(ts) {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function mmdd(ts) {
  const d = new Date(ts * 1000);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 对应 activityText：模型 +增量，一行显示不下就截 */
function curveActivity(activity) {
  return (activity || []).map((a) => `${a.model} +${human(a.tokenDelta)}`).join(" · ");
}

/** 对应 nearestHoverSample(to:)：hoverSamples 按时间升序，二分取最近的一分钟 */
function nearestCurveSample(samples, ts) {
  if (!samples || !samples.length) return null;
  let low = 0, high = samples.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (samples[mid].timestamp < ts) low = mid + 1; else high = mid;
  }
  if (low === 0) return samples[0];
  if (low === samples.length) return samples[samples.length - 1];
  const before = samples[low - 1], after = samples[low];
  return Math.abs(before.timestamp - ts) <= Math.abs(after.timestamp - ts) ? before : after;
}

/** x 轴刻度：从整点起按 stride 小时走，用 Date 推进以跟住本地时区的夏令时 */
function curveTicks(start, end, strideHours) {
  const first = new Date(start * 1000);
  first.setMinutes(0, 0, 0);
  if (first.getTime() < start * 1000) first.setHours(first.getHours() + 1);
  const out = [];
  const cursor = new Date(first);
  while (cursor.getTime() / 1000 <= end) {
    out.push(Math.floor(cursor.getTime() / 1000));
    cursor.setHours(cursor.getHours() + strideHours);
  }
  return out;
}

function curveSummaryHtml(toolFrame, sampleCount) {
  const chart = toolFrame.chart;
  const parts = toolFrame.windowNames.map((w) => {
    const value = chart.latestValues[w];
    const has = typeof value === "number";
    // 剩余额度低于 15% 时全线转红（Swift 侧的 value <= 15 ? .red : tint）
    const color = has ? (value <= 15 ? "#e94a6e" : curveColor(toolFrame.id, w)) : "var(--text-3)";
    const title = w === "5h" ? "5h 剩余" : `${curveLabel(w)}剩余`;
    return `<div class="curve-stat"><span>${title}</span>`
      + `<strong style="color:${color}">${has ? `${value.toFixed(1)}%` : "—"}</strong></div>`;
  });
  parts.push(`<div class="curve-stat"><span>采样点</span><strong>${sampleCount}</strong></div>`);
  const largest = (chart.dropEvents || []).reduce(
    (best, e) => (!best || e.drop > best.drop ? e : best), null);
  if (largest) {
    parts.push(`<div class="curve-stat curve-largest"><span>最大区间下降</span>`
      + `<strong class="curve-mono" style="font-size:12px;color:${curveColor(toolFrame.id, largest.window)}">`
      + `-${largest.drop.toFixed(1)}% / ${largest.durationMinutes}min</strong></div>`);
  }
  return `<div class="curve-summary">${parts.join("")}</div>`;
}

function curveEmptyHtml(toolId) {
  return `<div class="curve-empty" style="color:${CURVE_TINT[toolId]}">
    <span class="curve-empty-mark">╱╲</span>
    <strong>正在开始记录额度轨迹</strong>
    <p>Tokei 每 30 秒刷新，曲线按分钟聚合。保持应用运行后，这里会逐步出现数据。</p>
  </div>`;
}

/** 折线 + 标记 + 坐标轴，几何按 macOS 的 Swift Charts 配置逐值取 */
function curveChartHtml(toolFrame, start, end, span, width) {
  const g = CURVE_CHART;
  const chart = toolFrame.chart;
  const plotX = g.axisLeft;
  const plotW = Math.max(10, width - g.axisLeft - g.axisRight);
  const plotY = g.top;
  const plotH = g.plot;
  const span100 = Math.max(1, end - start);
  const X = (t) => plotX + ((t - start) / span100) * plotW;
  const Y = (v) => plotY + (1 - Math.max(0, Math.min(100, v)) / 100) * plotH;

  const grid = [0, 25, 50, 75, 100].map((v) => {
    const y = Y(v).toFixed(1);
    return `<line x1="${plotX}" y1="${y}" x2="${plotX + plotW}" y2="${y}" stroke="rgba(255,255,255,.08)"/>`
      + `<text x="${plotX - 5}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end" font-size="8.5" fill="#7d8089">${v}%</text>`;
  }).join("");

  const showsDate = span >= 168;
  const ticks = curveTicks(start, end, CURVE_STRIDE[span] || 24).map((t) => {
    const x = X(t).toFixed(1);
    return `<line x1="${x}" y1="${plotY}" x2="${x}" y2="${plotY + plotH}" stroke="rgba(255,255,255,.06)"/>`
      + `<line x1="${x}" y1="${plotY + plotH}" x2="${x}" y2="${plotY + plotH + 3}" stroke="rgba(255,255,255,.18)"/>`
      + `<text x="${x}" y="${plotY + plotH + 12}" text-anchor="middle" font-size="8.5" fill="#7d8089">`
      + `${showsDate ? mmdd(t) : hhmm(t)}</text>`;
  }).join("");

  // stepEnd：水平走到下一个变化点的 x，再垂直落到它的值；压实过的平台段两头都在
  const lines = toolFrame.windowNames.map((w) => {
    const series = chart.lineData.filter((d) => d.window === w).sort((a, b) => a.timestamp - b.timestamp);
    if (!series.length) return "";
    let path = "";
    series.forEach((p, i) => {
      const x = X(p.timestamp).toFixed(1);
      const y = Y(p.remaining).toFixed(1);
      path += i === 0 ? `M${x} ${y}` : ` H${x} V${y}`;
    });
    return `<path d="${path}" fill="none" stroke="${curveColor(toolFrame.id, w)}" stroke-width="2.2"
      stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("");

  const latest = new Set(chart.latestDatumIDs);
  const dots = chart.markerData.map((d) => {
    const isLatest = latest.has(d.id);
    // symbolSize 是面积：16 → r≈2.3，8 → r≈1.6
    return `<circle cx="${X(d.timestamp).toFixed(1)}" cy="${Y(d.remaining).toFixed(1)}" r="${isLatest ? 2.3 : 1.6}"
      fill="${curveColor(toolFrame.id, d.window)}" opacity="${isLatest ? 1 : 0.62}"/>`;
  }).join("");

  const legend = toolFrame.windowNames.map((w) =>
    `<span><i class="curve-dot" style="background:${curveColor(toolFrame.id, w)}"></i> ${curveLabel(w)}</span>`).join("");

  return `<div class="curve-legend">${legend}</div>
    <div class="curve-plot" style="margin-top:${g.gap}px">
      <svg width="${width}" height="${g.svgHeight}" data-curve-plot="${toolFrame.id}">${grid}${ticks}${lines}${dots}</svg>
      <div class="curve-guide" hidden style="left:0;top:${plotY}px;height:${plotH}px"></div>
      <div class="curve-bubble" hidden></div>
    </div>`;
}

/** 每天用了多少额度（issue #85）：Codex 看周额度，Claude 看周 · 全部 */
function curveDailyHtml(toolFrame) {
  const windowKey = toolFrame.id === "codex" ? "week" : "week-all";
  const rows = (toolFrame.daily || []).filter((r) => r.window === windowKey).slice(0, 7);
  if (!rows.length) return "";
  const largest = Math.max(...rows.map((r) => r.consumed), 0.1);
  const color = curveColor(toolFrame.id, windowKey);
  const todayKey = new Date(); todayKey.setHours(0, 0, 0, 0);
  const body = rows.map((r) => {
    const label = r.dayStart === Math.floor(todayKey.getTime() / 1000) ? "今天" : mmdd(r.dayStart);
    const width = Math.max(2, 96 * (r.consumed / largest));
    const value = r.isComplete ? `${r.consumed.toFixed(1)}%` : `约 ${r.consumed.toFixed(1)}%`;
    return `<div class="curve-time curve-mono">${escapeHtml(label)}</div>
      <div class="curve-daily-bar"><i style="width:${width.toFixed(1)}px;background:${color};opacity:${r.isComplete ? .85 : .4}"></i></div>
      <div class="curve-value curve-mono">${escapeHtml(value)}</div>
      <div class="curve-refill">${r.refills > 0 ? `回满 ×${r.refills}` : ""}</div>`;
  }).join("");
  return `<div class="curve-section">
    <div><strong class="curve-section-title">每天用了多少额度</strong>
      <span style="font-size:9.5px;font-weight:600;color:${CURVE_TINT[toolFrame.id]};margin-left:6px">${curveLabel(windowKey)}</span></div>
    <div class="curve-rows" style="grid-template-columns:40px 96px 64px auto">${body}</div>
  </div>`;
}

function curveChangesHtml(toolFrame) {
  const events = toolFrame.chart.dropEvents.slice(0, 8);
  const body = events.length
    ? events.map((e) => `<div class="curve-time curve-mono">${hhmm(e.timestamp)}</div>
        <div class="curve-window" style="color:${CURVE_TINT[toolFrame.id]}">${curveLabel(e.window)}</div>
        <div class="curve-value curve-mono">-${e.drop.toFixed(1)}%</div>
        <div class="curve-duration">${e.durationMinutes} 分钟</div>
        <div class="curve-activity curve-mono">${escapeHtml(curveActivity(e.activity))}</div>`).join("")
    : `<div class="curve-activity" style="grid-column:1/-1;font-size:10px;color:var(--text-3)">当前时间范围内还没有检测到额度下降</div>`;
  // 窗口名那一列按本列最宽的格子定尺寸（Swift 侧用隐藏的 ZStack 撑开，这里等价交给 max-content）
  return `<div class="curve-section">
    <strong class="curve-section-title">最近额度变化</strong>
    <div class="curve-rows" style="grid-template-columns:40px max-content 54px auto minmax(0,1fr)">${body}</div>
  </div>`;
}

function curveActivitySectionHtml(toolFrame) {
  const events = toolFrame.chart.activityEvents.slice(0, 8);
  const body = events.length
    ? events.map((e) => `<div class="curve-time curve-mono">${hhmm(e.timestamp)}</div>
        <div class="curve-activity curve-mono">${escapeHtml(curveActivity(e.activity))}</div>`).join("")
    : `<div style="font-size:10px;color:var(--text-3)">尚未检测到该工具的模型 token 增量</div>`;
  return `<div class="curve-section">
    <strong class="curve-section-title">模型活动标记</strong>
    <div class="curve-rows" style="grid-template-columns:40px minmax(0,1fr)">${body}</div>
  </div>`;
}

// ---------------- 周额度周期卡（QuotaHistoryView.swift:174-463） ----------------

/** 对应 cycleTint / cycleName：三块 harness 各自的品牌色与显示名（Theme.claude/codex/grok） */
const CYCLE_TINT = { claude: "#eb8566", codex: "#6badfa", grok: "#a6adbf" };
const CYCLE_NAME = { claude: "Claude Code", codex: "Codex", grok: "Grok" };
/** 对应 collapsedCycleLimit：更早的周期默认收起来 */
const CYCLE_COLLAPSED = 8;

function cycleName(tool) { return CYCLE_NAME[tool] || CYCLE_NAME.codex; }
function cycleTint(tool) { return CYCLE_TINT[tool] || CYCLE_TINT.codex; }

/** 对应 cycleTools：按固定顺序排有数据的工具，免得刷新一次卡片就换个位置 */
function cycleToolsPresent() {
  const present = new Set((state.detail?.cycles || []).map((c) => c.tool));
  return ["claude", "codex", "grok"].filter((t) => present.has(t));
}

/** 对应 QuotaCycle.durationDays：重锚会把周期截短，不一定是整 7 天 */
function cycleDurationDays(c) {
  return (Number(c.end) - Number(c.start)) / 86400;
}

/** 对应 QuotaCycle.projectedTotal：太早期外推没意义，used_pct 拿不到或不足 3% 就不画 */
function cycleProjected(c) {
  const used = c.used_pct;
  if (used === null || used === undefined || used < 3) return null;
  const tokens = Number(c.tokens) || 0;
  if (tokens <= 0) return null;
  return Math.floor((tokens / used) * 100);
}

/** 对应 QuotaCycle.deviceBreakdown：丢掉 0 的那几台，按用量从大到小 */
function cycleDevices(c) {
  return Object.entries(c.devices || {})
    .filter(([, tokens]) => Number(tokens) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([name, tokens]) => ({ name, tokens: Number(tokens) }));
}

/** 对应 cycleSubtitle */
function cycleSubtitleText() {
  let text = "从上次额度回满算到下次回满";
  const devices = state.detail?.devices || [];
  if (devices.length > 1) text += ` · ${devices.length} 台设备已合并`;
  // 首屏是上次落盘的缓存，刷新完会自己变，标出来免得误当成实时值。
  if (state.detail && state.detailLoading) text += " · 更新中";
  return text;
}

/** 对应 missingHint：切不出周期的工具得告诉用户怎么把额度读数找回来 */
function cycleMissingHint(tool) {
  if (tool === "claude") {
    return "Claude Code 还没有周额度卡片：可打开 Claude Desktop 的 Usage 页面，"
      + "或在设置的「隐私与额度」开启 Claude Code CLI 额度查询。";
  }
  if (tool === "grok") return "Grok 还没有周额度卡片：登录一次 grok.com 让 Tokei 抓到额度读数。";
  return "Codex 还没有周额度卡片：跑一次 codex 让它刷新额度读数。";
}

/** 对应 cycleHeader：标题 + 副标题 +（多于一个工具时）工具筛选 */
function cycleHeaderHtml(tools) {
  const filter = tools.length > 1
    ? `<div class="segmented cycle-filter" style="width:${54 * (tools.length + 1) + 24}px"
        role="tablist" aria-label="周期工具">
        <button class="seg${state.cycleTool ? "" : " is-active"}" role="tab"
          aria-selected="${!state.cycleTool}" data-cycle-tool="">全部</button>
        ${tools.map((t) => `<button class="seg${state.cycleTool === t ? " is-active" : ""}" role="tab"
            aria-selected="${state.cycleTool === t}" data-cycle-tool="${t}">${cycleName(t)}</button>`).join("")}
      </div>`
    : "";
  return `<div class="cycle-header">
    <div class="cycle-titles"><strong class="cycle-title">一个周额度用了多少</strong>
      <span class="cycle-sub">${escapeHtml(cycleSubtitleText())}</span></div>${filter}</div>`;
}

/** 对应 cycleProgress：胶囊进度条 + 右侧「已用 N%」 */
function cycleProgressHtml(used, tint) {
  const ratio = Math.min(Math.max(Number(used) || 0, 0), 100) / 100;
  return `<div class="cycle-progress">
    <div class="cycle-track"><i style="width:${(ratio * 100).toFixed(2)}%;background:${tint}"></i></div>
    <span class="cycle-used curve-mono">已用 ${Math.round(Number(used) || 0)}%</span></div>`;
}

/** 对应 cycleCard：当前周期那一块 */
function cycleCardHtml(c) {
  const tint = cycleTint(c.tool);
  const projected = cycleProjected(c);
  const devices = cycleDevices(c);
  const used = c.used_pct;
  return `<div class="cycle-card">
    <div class="cycle-top"><strong style="color:${tint}">${cycleName(c.tool)} 周额度</strong>
      <span>${escapeHtml(countdown(c.end))} 后回满</span></div>
    ${used === null || used === undefined ? "" : cycleProgressHtml(used, tint)}
    <div class="cycle-tokens">
      <div class="cycle-used-block"><span>这个周期已经用了</span>
        <div class="cycle-big"><strong>${escapeHtml((c.approx ? "≈" : "") + human(c.tokens))}</strong>
          <span class="cycle-unit">tokens</span></div>
        <span class="cycle-grouped curve-mono">${grouped(c.tokens)}</span></div>
      ${projected === null ? "" : `<div class="cycle-project"><span>照这个用法，整个周期约</span>
        <strong>${escapeHtml(human(projected))}</strong></div>`}
    </div>
    ${devices.length > 1
      ? `<div class="cycle-devices curve-mono">${escapeHtml(
        devices.map((d) => `${d.name} ${human(d.tokens)}`).join("  ·  "))}</div>` : ""}
  </div>`;
}

/** 对应 completedCyclesSection：过去几个周期的横条 */
function completedCyclesHtml(tool, cycles, compactTitle) {
  const peak = Math.max(...cycles.map((c) => Number(c.tokens) || 0), 1);
  const uneven = cycles.some((c) => cycleDurationDays(c) < 6.5);
  const expanded = state.expandedCycles.has(tool);
  const visible = expanded ? cycles : cycles.slice(0, CYCLE_COLLAPSED);
  const hidden = Math.max(0, cycles.length - CYCLE_COLLAPSED);
  const rows = visible.map((c) => {
    const used = c.used_pct;
    const ratio = Math.max(Number(c.tokens) || 0, 0) / peak;
    return `<div class="cycle-row">
      <span class="cycle-range curve-mono">${mmdd(c.start)} → ${mmdd(c.end)}</span>
      <span class="cycle-length curve-mono">${cycleDurationDays(c).toFixed(1)}天</span>
      <span class="cycle-bar"><i style="width:${(ratio * 100).toFixed(2)}%"></i></span>
      <span class="cycle-tokens-value">${escapeHtml((c.approx ? "≈" : "") + human(c.tokens))}</span>
      <span class="cycle-pct"><span class="curve-mono">用到100%</span>
        <span class="curve-mono">${used === null || used === undefined ? "—" : `用到${Math.round(Number(used))}%`}</span></span>
    </div>`;
  }).join("");
  const more = hidden > 0
    ? `<button type="button" class="cycle-more" data-cycle-expand="${tool}">
        ${icon(expanded ? "chevron.up" : "chevron.down")}
        <span>${expanded ? "收起更早周期" : `查看更早的 ${hidden} 个周期`}</span>
        <span class="filler"></span></button>` : "";
  return `<div class="cycle-history">
    <strong>${escapeHtml(compactTitle ? "过去几个周期" : `${cycleName(tool)} 过去几个周期`)}</strong>
    ${uneven ? `<p class="cycle-uneven">不足 7 天的是重置时间被提前重锚，额度提前回满，长度不一样不能直接比。</p>` : ""}
    ${rows}${more}</div>`;
}

/** 对应 cycleGroup：一个 harness 一块，当前周期和历史周期共用同一张卡片 */
function cycleGroupHtml(tool) {
  const all = (state.detail?.cycles || []).filter((c) => c.tool === tool);
  const current = all.find((c) => c.current);
  const past = all.filter((c) => !c.current).sort((a, b) => Number(b.start) - Number(a.start));
  const tint = cycleTint(tool);
  if (current) {
    return `<div class="curve-card" style="--tint:${tint}"><div class="cycle-group">`
      + cycleCardHtml(current)
      + (past.length
        ? `<div class="cycle-divider"></div>${completedCyclesHtml(tool, past, true)}` : "")
      + `</div></div>`;
  }
  if (!past.length) return "";
  return `<div class="curve-card" style="--tint:${tint}">${completedCyclesHtml(tool, past, false)}</div>`;
}

/** 对应 cycleSection（QuotaHistoryView.swift:174） */
function cycleSectionHtml() {
  const tools = cycleToolsPresent();
  const visible = state.cycleTool && tools.includes(state.cycleTool) ? [state.cycleTool] : tools;
  let cards;
  if (!state.detail) {
    cards = `<div class="curve-card" style="--tint:${CYCLE_TINT.codex}"><div class="cycle-placeholder">`
      + `${escapeHtml(state.detailError || "正在读取周额度…")}</div></div>`;
  } else if (!visible.length) {
    cards = `<div class="curve-card" style="--tint:${CYCLE_TINT.codex}"><div class="cycle-placeholder">`
      + `所有订阅的额度重置时间都拿不到，定位不了周期</div></div>`;
  } else {
    cards = visible.map(cycleGroupHtml).join("");
  }
  // 只在「全部」那一档提示：选中某个工具时，另一个工具 missing 不该插在这一屏中间
  const hints = !state.cycleTool && state.detail
    ? (state.detail.missing || []).map((t) => `<p class="cycle-missing">${escapeHtml(cycleMissingHint(t))}</p>`).join("")
    : "";
  return `<div class="cycle-section">${cycleHeaderHtml(tools)}${cards}${hints}</div>`;
}

// ---------------- 长跨度每日消耗（QuotaHistoryView.swift:465-528 + QuotaDailyChart） ----------------

/** 对应 QuotaDailyChart 的三色：与周期卡同源 */
const DAILY_SERIES = [["Claude Code", "c", CYCLE_TINT.claude], ["Codex", "x", CYCLE_TINT.codex], ["Grok", "g", CYCLE_TINT.grok]];

/** 对应 recentDailyPoints：账本只存有用量的日子，必须按日期截断而不是按行数取 */
function recentDailyPoints() {
  const days = spanDays(state.curveSpan);
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const p = (x) => String(x).padStart(2, "0");
  const key = `${cutoff.getFullYear()}-${p(cutoff.getMonth() + 1)}-${p(cutoff.getDate())}`;
  return (state.detail?.daily || []).filter((r) => String(r.d) >= key);
}

/** y 轴上界：Swift Charts 自己挑刻度，这里等价地取一个能整除的整齐值 */
function dailyAxisMax(value) {
  if (!(value > 0)) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (value <= m * base) return m * base;
  return 10 * base;
}

/** 区间峰值（y 轴上界的原始值）：三工具里最大的那天 */
function dailyPeak(points) {
  return Math.max(...points.map((p) => Math.max(Number(p.c) || 0, Number(p.x) || 0, Number(p.g) || 0)), 0);
}

/**
 * 每日那档的 y 轴标签是 human 缩号（「25.0M」「5.0亿」），比曲线那档的百分比宽得多。
 * Swift Charts 的 AxisMarks(position:.leading) 会自动给标签留位，这里按最宽标签估个像素宽，
 * 否则标签超出 svg 左缘就被自己的视口裁掉（根 svg 默认 overflow:hidden）。
 */
function dailyAxisLeft(points) {
  const peak = dailyAxisMax(dailyPeak(points));
  const width = (text) => [...String(text)]
    .reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 8.6 : 5.2), 0);
  return Math.ceil(Math.max(CURVE_CHART.axisLeft,
    ...[0, 0.25, 0.5, 0.75, 1].map((f) => width(f === 0 ? "0" : human(peak * f)) + 5)));
}

/** "yyyy-MM-dd" → 该日的序号（UTC 毫秒/86400000，只用来数天数差，不涉及时区） */function dayIndex(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key));
  if (!m) return 0;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

/** 对应 QuotaDailyChart：每天三根柱子并排，几何仍用 CURVE_CHART 那 235 点的拆分 */
function dailyChartHtml(points, width) {
  const g = CURVE_CHART;
  const plotX = dailyAxisLeft(points);
  const plotW = Math.max(10, width - plotX - g.axisRight);
  const plotY = g.top;
  const plotH = g.plot;
  const first = dayIndex(points[0].d);
  const last = dayIndex(points[points.length - 1].d);
  const totalDays = Math.max(last - first + 1, 1);
  const slot = plotW / totalDays;
  const peak = dailyAxisMax(dailyPeak(points));
  const X = (dayKey) => plotX + (dayIndex(dayKey) - first) * slot;
  const Y = (v) => plotY + (1 - Math.max(0, Math.min(peak, Number(v) || 0)) / peak) * plotH;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const value = peak * f;
    const y = Y(value).toFixed(1);
    return `<line x1="${plotX}" y1="${y}" x2="${plotX + plotW}" y2="${y}" stroke="rgba(255,255,255,.08)"/>`
      + `<text x="${plotX - 5}" y="${(Y(value) + 3).toFixed(1)}" text-anchor="end" font-size="8.5" fill="#7d8089">`
      + `${f === 0 ? "0" : human(value)}</text>`;
  }).join("");

  // .stride(by: .day, count: max(points.count / 8, 1))：刻度从区间首日按天推进
  const strideDays = Math.max(Math.floor(points.length / 8), 1);
  const ticks = [];
  for (let k = 0; k * strideDays < totalDays; k += 1) ticks.push(first + k * strideDays);
  const axis = ticks.map((index) => {
    const x = (plotX + (index - first) * slot).toFixed(1);
    const d = new Date(index * 86400000);
    const p = (v) => String(v).padStart(2, "0");
    return `<line x1="${x}" y1="${plotY}" x2="${x}" y2="${plotY + plotH}" stroke="rgba(255,255,255,.06)"/>`
      + `<text x="${x}" y="${plotY + plotH + 12}" text-anchor="middle" font-size="8.5" fill="#7d8089">`
      + `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}</text>`;
  }).join("");

  const bar = Math.max(slot * 0.9 / DAILY_SERIES.length, 0.4);
  const bars = points.map((point) => {
    const x0 = X(point.d) + (slot - bar * DAILY_SERIES.length) / 2;
    return DAILY_SERIES.map(([name, key, color], i) => {
      const value = Number(point[key]) || 0;
      if (value <= 0) return "";
      const x = x0 + i * bar;
      const y = Y(value);
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(1)}" width="${bar.toFixed(2)}"
        height="${Math.max(0, plotY + plotH - y).toFixed(1)}" fill="${color}"
        data-daily-day="${escapeHtml(point.d)}" data-daily-tool="${escapeHtml(name)}" data-daily-tokens="${value}"/>`;
    }).join("");
  }).join("");

  const legend = DAILY_SERIES.map(([name, , color]) =>
    `<span><i class="curve-dot" style="background:${color}"></i> ${name}</span>`).join("");

  return `<div class="curve-legend">${legend}</div>
    <div class="curve-plot" style="margin-top:${g.gap}px">
      <svg width="${width}" height="${g.svgHeight}" data-daily-plot="1">${grid}${axis}${bars}</svg>
      <div class="curve-bubble daily-bubble" hidden></div>
    </div>`;
}

/** 对应 dailyStat */
function dailyStatHtml(title, tokens, tint) {
  return `<div class="daily-stat"><span>${escapeHtml(title)}</span>
    <strong style="color:${tint}">${escapeHtml(human(tokens))}</strong>
    <span class="daily-exact curve-mono">${grouped(tokens)}</span></div>`;
}

/** 对应 dailyEmpty */
function dailyEmptyHtml() {
  return `<div class="daily-empty" style="--tint:${CYCLE_TINT.codex}">
    ${icon("chart.bar.xaxis")}<strong>账本里还没有这个区间的用量</strong></div>`;
}

/** 对应 dailyTokensSection */
function dailyTokensSectionHtml() {
  const points = recentDailyPoints();
  const sum = (key) => points.reduce((total, p) => total + (Number(p[key]) || 0), 0);
  const claude = sum("c"), codex = sum("x"), grok = sum("g");
  return `<div class="curve-card" style="--tint:${CYCLE_TINT.codex}"><div class="daily-wrap">
    <div class="daily-stats">
      ${dailyStatHtml("Claude Code", claude, CYCLE_TINT.claude)}
      ${dailyStatHtml("Codex", codex, CYCLE_TINT.codex)}
      ${dailyStatHtml("Grok", grok, CYCLE_TINT.grok)}
      ${dailyStatHtml("合计", claude + codex + grok, "var(--text)")}
    </div>
    <div class="curve-slot"></div></div></div>`;
}

/** hover：命中的是「哪一天」而不是最近一分钟，那天没数据就不出气泡（nearestPoint(to:)） */
function bindDailyHover(points) {
  const svg = document.querySelector("[data-daily-plot]");
  if (!svg) return;
  const plot = svg.parentElement;
  const bubble = plot.querySelector(".daily-bubble");
  const g = CURVE_CHART;
  const rect = svg.getBoundingClientRect();
  // 左内缩与画图时同一套算法，否则 hover 命中的日期会整体偏一列
  const plotX = dailyAxisLeft(points);
  const plotW = Math.max(1, rect.width - plotX - g.axisRight);
  const first = dayIndex(points[0].d);
  const last = dayIndex(points[points.length - 1].d);
  const slot = plotW / Math.max(last - first + 1, 1);

  plot.onmousemove = (ev) => {
    const x = ev.clientX - rect.left;
    if (x < plotX || x > plotX + plotW) { bubble.hidden = true; return; }
    const index = first + Math.floor((x - plotX) / slot);
    const key = (() => {
      const d = new Date(index * 86400000);
      const p = (v) => String(v).padStart(2, "0");
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    })();
    const point = points.find((r) => String(r.d) === key);
    if (!point) { bubble.hidden = true; return; }
    bubble.hidden = false;
    // 气泡贴在绘图区左上（plot.minX+6, plot.minY+4），Swift 那边不跟着光标夹取
    bubble.style.left = `${plotX + 6}px`;
    bubble.style.top = `${g.top + 4}px`;
    const total = (Number(point.c) || 0) + (Number(point.x) || 0) + (Number(point.g) || 0);
    bubble.innerHTML = `<time class="curve-mono">${escapeHtml(point.d)}</time>`
      + DAILY_SERIES.map(([name, key2, color]) => `<div class="curve-brow">
          <i class="curve-dot" style="background:${color}"></i><span>${name}</span>
          <strong class="curve-mono">${escapeHtml(human(point[key2]))}</strong></div>`).join("")
      + `<div class="daily-sum curve-mono">合计 ${grouped(total)}</div>`;
  };
  plot.onmouseleave = () => { bubble.hidden = true; };
}

function renderCurve() {
  const box = $("quota-curve");
  if (!box) return;
  const showsDaily = spanShowsDaily(state.curveSpan);
  const frame = state.curve;
  const toolFrame = frame
    ? (frame.tools.find((t) => t.id === state.curveTool) || frame.tools[0]) : null;

  // controls 里那一行工具选择在长跨度下不收（Swift:541），但周期节和跨度选择器照摆
  const controls = `<div class="curve-controls">
    <div class="curve-titles">
      <strong class="curve-title">额度轨迹</strong>
      <span class="curve-sub">${showsDaily ? "按天聚合 · 真实 token 消耗" : "按分钟聚合 · 剩余额度"}</span>
    </div>
    ${showsDaily || !frame ? "" : `<div class="segmented curve-tool" role="tablist" aria-label="工具">
      ${frame.tools.map((t) => `<button class="seg${t.id === toolFrame.id ? " is-active" : ""}" role="tab"
        aria-selected="${t.id === toolFrame.id}" data-curve-tool="${t.id}">${escapeHtml(t.title)}</button>`).join("")}
    </div>`}
    <div class="segmented curve-span" role="tablist" aria-label="时间跨度">
      ${CURVE_SPANS.map(([hours, label]) => `<button class="seg${hours === state.curveSpan ? " is-active" : ""}" role="tab"
        aria-selected="${hours === state.curveSpan}" data-curve-span="${hours}">${label}</button>`).join("")}
    </div>
  </div>`;

  let middle;
  if (showsDaily) {
    middle = dailyTokensSectionHtml();
  } else if (state.curveLoading && !frame) {
    middle = `<p class="empty">正在读取额度轨迹…</p>`;
  } else if (!frame) {
    middle = `<p class="empty">${escapeHtml(state.curveError)}</p>`;
  } else {
    const tint = CURVE_TINT[toolFrame.id];
    middle = `<div class="curve-card" style="--tint:${tint}">`
      + `${curveSummaryHtml(toolFrame, frame.sampleCount)}<div class="curve-slot"></div></div>`
      + curveDailyHtml(toolFrame) + curveChangesHtml(toolFrame) + curveActivitySectionHtml(toolFrame);
  }

  box.innerHTML = cycleSectionHtml() + controls + middle
    + `<p class="curve-footnote">${showsDaily ? DAILY_FOOTNOTE : CURVE_FOOTNOTE}</p>`;

  // 卡片左右各 13 内边距、再加 1 圈描边，画布的可用宽度就按这个扣。
  // 宽度要等骨架进 DOM 之后再量：先量的话这一页还没撑出滚动条，量到的多出 8 个像素，图就顶到卡片边框。
  const slot = box.querySelector(".curve-slot");
  if (!slot) return;
  const width = Math.max(240, box.clientWidth - 28);
  if (showsDaily) {
    const points = recentDailyPoints();
    // 空的这一档只有 210 点高（dailyEmpty），比图表矮，占位框先按图的尺寸摆
    slot.outerHTML = points.length ? dailyChartHtml(points, width) : dailyEmptyHtml();
    if (points.length) bindDailyHover(points);
    return;
  }
  slot.outerHTML = toolFrame.chart.lineData.length
    ? curveChartHtml(toolFrame, frame.start, frame.end, frame.span, width)
    : curveEmptyHtml(toolFrame.id);
  bindCurveHover(toolFrame, frame);
}

/** hover：把像素 x 换算回时间，找最近的一分钟，画引导线与气泡 */
function bindCurveHover(toolFrame, frame) {
  const svg = document.querySelector("[data-curve-plot]");
  if (!svg) return;
  const plot = svg.parentElement;
  const guide = plot.querySelector(".curve-guide");
  const bubble = plot.querySelector(".curve-bubble");
  const g = CURVE_CHART;
  const rect = svg.getBoundingClientRect();
  const plotX = g.axisLeft;
  const plotW = Math.max(1, rect.width - g.axisLeft - g.axisRight);
  const start = frame.start, end = frame.end;

  const hide = () => { guide.hidden = true; bubble.hidden = true; };
  plot.onmousemove = (ev) => {
    const x = ev.clientX - rect.left;
    if (x < plotX || x > plotX + plotW) { hide(); return; }
    const ts = start + ((x - plotX) / plotW) * (end - start);
    const sample = nearestCurveSample(toolFrame.chart.hoverSamples, ts);
    if (!sample || !sample.rows.length) { hide(); return; }
    const snapX = plotX + ((sample.timestamp - start) / (end - start)) * plotW;
    guide.hidden = false;
    guide.style.left = `${Math.round(snapX)}px`;
    // 气泡宽 154，夹在绘图区内：贴着左右边界时不再溢出（macOS 的 anchor 夹取）
    const anchor = Math.min(Math.max(snapX - 77, plotX), plotX + plotW - 154);
    bubble.hidden = false;
    bubble.style.left = `${Math.round(anchor)}px`;
    bubble.style.top = `${g.top + 4}px`;
    bubble.innerHTML = `<time class="curve-mono">${hhmm(sample.timestamp)}</time>`
      + sample.rows.map((r) => `<div class="curve-brow"><i class="curve-dot"
          style="background:${curveColor(toolFrame.id, r.window)}"></i><span>${curveLabel(r.window)}</span>
          <strong class="curve-mono">${r.remaining.toFixed(1)}%</strong></div>`).join("")
      + (sample.activity && sample.activity.length
        ? `<div class="curve-bact curve-mono">${escapeHtml(curveActivity(sample.activity))}</div>` : "");
  };
  plot.onmouseleave = hide;
}

/**
 * 取数用「最新一次请求胜出」：跨度连点或刷新推送撞上来时，早发的回执要丢掉，
 * 否则画面会停在先到的那一档上，而按钮已经指向后选的那一档。
 * 已有画面时不清空重画占位，只让它静默换帧 —— 曲线每 30 秒跟一次刷新，闪整块很难看。
 */
async function loadCurve() {
  // 1月/1年 两档画的是每日真实 token 消耗，用不到曲线帧；
  // 而主进程的 normalizeQuotaSpan 只认 1/6/24/168，传 720 会被夹回 24 再扫一遍，白跑一趟。
  if (spanShowsDaily(state.curveSpan)) {
    state.curveSeq += 1;   // 在途的那一轮曲线结果别再回头重绘这一档
    state.curveLoading = false;
    renderCurve();
    return;
  }
  const seq = ++state.curveSeq;
  state.curveLoading = true;
  if (!state.curve) renderCurve();
  try {
    const frame = await window.tokei.getQuotaHistory(state.curveSpan);
    if (seq !== state.curveSeq) return;
    state.curve = frame;
    state.curveError = "";
  } catch (e) {
    if (seq !== state.curveSeq) return;
    state.curve = null;
    state.curveError = `取额度轨迹失败：${e?.message ?? e}`;
  } finally {
    if (seq === state.curveSeq) {
      state.curveLoading = false;
      renderCurve();
    }
  }
}

/**
 * 周额度与每日消耗（对应 QuotaDetailRepository.load）。主进程那一发 await 到建完才回，
 * 所以按「最新一次请求胜出」收口：进页、每轮刷新推送、手动刷新都可能撞上同一次取数，
 * 早发的回执要丢掉，否则画面停在旧的一轮、副标题的「更新中」却已经熄了。
 * 回执为空或抛错都留着上一份快照 —— 空白页比旧数据更容易被误读成「额度没了」。
 * force 只有进页那一发用（同 main.swift:92 的 load(force: true)）；每轮推送走 false，
 * 接住主进程刚在 refresh 里焐热的那份（index.ts:189），不再重算第二遍。
 */
async function loadDetail(force) {
  const seq = ++state.detailSeq;
  state.detailLoading = true;
  if (!state.detail) renderCurve();
  try {
    const payload = await window.tokei.getQuotaDetail(Boolean(force));
    if (seq !== state.detailSeq) return;
    if (payload) {
      state.detail = payload;
      state.detailError = "";
    }
  } catch (e) {
    if (seq !== state.detailSeq) return;
    state.detailError = `取周额度失败：${e?.message ?? e}`;
  } finally {
    if (seq === state.detailSeq) {
      state.detailLoading = false;
      renderCurve();
    }
  }
}

// ---------------- 项目足迹（ProjectTrailView.swift） ----------------
/** 对应 ProjectTrailView 的分组：置顶 / 今天 / 本周 / 更早 / 沉睡 */
const TRAIL_GROUPS = ["pinned", "today", "week", "earlier", "dormant"];
const TRAIL_GROUP_LABEL = { pinned: "置顶", today: "今天", week: "本周", earlier: "更早", dormant: "沉睡" };

function trailGroup(p) {
  if (state.pinned.has(p.path)) return "pinned";
  const days = daysAgo(p.last_active);
  if (days === null) return "dormant";
  if (days === 0) return "today";
  if (days <= 7) return "week";
  if (days > 14) return "dormant";
  return "earlier";
}

/** ~ 前缀缩写：Windows 路径大小写不敏感，主目录可能以不同大小写出现在日志里 */
function abbreviatePath(p) {
  const home = state.home;
  if (home && p.length > home.length && p.slice(0, home.length).toLowerCase() === home.toLowerCase()) {
    return "~" + p.slice(home.length);
  }
  return p;
}

function trailFiltered() {
  const all = state.trail || [];
  const q = state.trailQuery.toLowerCase();
  const hits = q
    ? all.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    : all;
  return [...hits].sort((a, b) => {
    const ap = state.pinned.has(a.path) ? 1 : 0;
    const bp = state.pinned.has(b.path) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (a.last_active !== b.last_active) return a.last_active < b.last_active ? 1 : -1;
    return 0;
  });
}

/** Swift 侧路径是 lineLimit(1)+truncationMode(.middle)；CSS 的 ellipsis 只会砍尾部，
 *  而尾部正是项目目录名，所以在 JS 里居中截断。 */
function middleTruncate(s, max) {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function trailRow(p) {
  const dots = (p.tools || []).map((t) => {
    const color = TOOL_META[t]?.color || "#7d8089";
    return `<i class="trail-dot" style="background:${color}"></i>`;
  }).join("");
  const model = p.top_model ? `<span class="trail-model">${escapeHtml(p.top_model)}</span>` : "";
  const shown = middleTruncate(abbreviatePath(p.path), 62);
  return `
    <div class="trail-row" data-path="${escapeHtml(p.path)}" title="${escapeHtml(p.path)}">
      <div class="trail-main">
        <div class="trail-title">
          <svg class="trail-folder" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 3.6h4.1l1.3 1.7h7.4v7.3a.9.9 0 0 1-.9.9H2.5a.9.9 0 0 1-.9-.9z"/></svg>
          <span class="trail-name">${escapeHtml(p.name)}</span>
          ${dots}
        </div>
        <div class="trail-path">${escapeHtml(shown)}</div>
        <div class="trail-meta">
          <span>${escapeHtml(relativeDate(p.last_active))}</span><span class="trail-sep">·</span>
          <span>${Number(p.sessions) || 0} sessions</span><span class="trail-sep">·</span>
          <span class="trail-cost">${escapeHtml(nativeMoney(p.cost, p.cost_cny))}</span>
          ${model}
        </div>
      </div>
      <button class="trail-pin${state.pinned.has(p.path) ? " is-pinned" : ""}" data-pin="${escapeHtml(p.path)}"
        title="${state.pinned.has(p.path) ? "取消置顶" : "置顶"}" aria-label="置顶">${state.pinned.has(p.path) ? "★" : "☆"}</button>
    </div>`;
}

function renderProjects() {
  const box = $("trail-list");
  const foot = $("trail-footer");
  if (state.trailLoading || state.trail === null) {
    box.innerHTML = `<p class="empty">载入中…</p>`;
    foot.innerHTML = "";
    return;
  }
  const list = trailFiltered();
  if (!list.length) {
    box.innerHTML = `<p class="empty">无匹配项目</p>`;
    foot.innerHTML = "";
    return;
  }
  const byGroup = new Map();
  for (const p of list) {
    const g = trailGroup(p);
    (byGroup.get(g) ?? byGroup.set(g, []).get(g)).push(p);
  }
  let html = "";
  for (const g of TRAIL_GROUPS) {
    const items = byGroup.get(g);
    if (!items || !items.length) continue;
    html += `<div class="trail-group${g === "dormant" ? " is-dormant" : ""}">`
      + `${g === "dormant" ? '<span class="trail-zzz">💤</span>' : ""}`
      + `<span>${TRAIL_GROUP_LABEL[g]}</span></div>`;
    html += items.map(trailRow).join("");
  }
  box.innerHTML = html;

  const dates = (state.trail || []).map((p) => p.last_active).filter((d) => daysAgo(d) !== null).sort();
  foot.innerHTML = `<span class="muted">共 ${state.trail.length} 个项目 · 最远 ${escapeHtml(dates[0] || "?")}</span>`;
}

async function loadTrail() {
  state.trailLoading = true;
  renderProjects();
  try {
    state.trail = (await window.tokei.getProjects()) || [];
  } catch (e) {
    state.trail = [];
    showTrailNote(`取项目足迹失败：${e?.message ?? e}`);
  } finally {
    state.trailLoading = false;
    renderProjects();
  }
}

function showTrailNote(text) {
  const el = $("trail-note");
  el.textContent = text;
  el.hidden = !text;
  clearTimeout(showTrailNote.timer);
  if (text) showTrailNote.timer = setTimeout(() => { el.hidden = true; }, 4000);
}

function togglePin(path) {
  if (state.pinned.has(path)) state.pinned.delete(path); else state.pinned.add(path);
  // 与 macOS 的 @AppStorage("pinnedProjects") 同格式：排序后按行拼接
  localStorage.setItem("pinnedProjects", [...state.pinned].sort().join("\n"));
  renderProjects();
}

async function runTrailAction(path, action) {
  if (action === "copy") {
    const ok = await window.tokei.copyProjectPath(path);
    if (!ok) showTrailNote("该路径不在当前项目清单里");
    return;
  }
  const reply = await window.tokei.openProject(path, action);
  if (reply && !reply.ok) showTrailNote(reply.message || "打开失败");
}

function hideTrailMenu() {
  $("trail-menu").hidden = true;
}

function showTrailMenu(path, x, y) {
  const menu = $("trail-menu");
  menu.dataset.path = path;
  menu.hidden = false;
  // 面板只有 420 宽，贴着光标弹会把菜单推出窗外
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

// ---------------- 数据面板（DashboardView.swift + WrappedView.swift） ----------------

/** 对应 WrappedPeriod：键就是 core/dashboard.ts 的 period，标签照 Swift 的五档 */
const DASH_PERIODS = [
  ["1d", "今日"], ["7d", "本周"], ["30d", "本月"], ["365d", "今年"], ["all", "全部"],
];

/** 对应 DashboardView.providerRangeKey（Swift:305-313）：回顾区间映射到额度窗口键 */
const DASH_RANGE_KEY = { "1d": "today", "7d": "week", "30d": "month", "365d": "year", all: "all" };

/** 对应 DashboardView.heatColors（Swift:628-634）：L0 只在图例里露脸，格子零活动走 primary .04 */
const HEAT_COLORS = [
  "rgb(46, 51, 61)", "rgb(115, 82, 56)", "rgb(184, 107, 64)", "rgb(230, 140, 77)", "rgb(250, 184, 89)",
];
const HEAT_EMPTY = "rgba(255, 255, 255, .04)";

/** ConfettiView 的调色板（Swift:417-419），顺序照 Swift，色值取自 TOOL_META */
const CONFETTI_TINTS = [
  "claude", "qoder", "qoderwork", "qodercli", "hermes", "deepseek_harness",
  "codex", "gemini", "zcode", "mimocode", "codebuddy", "openclaw",
].map((id) => TOOL_META[id].color);

/** 对应 Fmt.weekdayLabels（Model.swift:1142）：中文「一…日」，其余语言用系统缩写；这里带中英两档 */
function weekdayLabels() {
  return isChinese()
    ? ["一", "二", "三", "四", "五", "六", "日"]
    : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
}

/** 对应 heatColor(activity:max:)（Swift:636-644） */
function heatColor(activity, max) {
  if (!(activity > 0) || !(max > 0)) return HEAT_EMPTY;
  const ratio = Math.min(activity / max, 1);
  if (ratio < 0.15) return HEAT_COLORS[1];
  if (ratio < 0.35) return HEAT_COLORS[2];
  if (ratio < 0.60) return HEAT_COLORS[3];
  return HEAT_COLORS[4];
}

/** 对应 modelTint(_:)（DashboardView.swift:408-442）：兜底档是 Theme.claude，codex_reserve 借 Codex 的蓝 */
function modelTint(tool) {
  if (tool === "codex_reserve") return TOOL_META.codex.color;
  return TOOL_META[tool]?.color || TOOL_META.claude.color;
}

/** 对应 Swift 的 DateFormatter("yyyy-MM-dd")：按本地日历日，toISOString 走 UTC 会错一天 */
function dashDayStr(d) {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ModelCost.tokens ?? (in + out)：Swift 两处排行都这么兜 */
function dashRowTokens(m) {
  const t = Number(m?.tokens);
  return Number.isFinite(t) && t !== 0 ? t : (Number(m?.in) || 0) + (Number(m?.out) || 0);
}

/** Design.swift:212-239 的 StatBar：条宽 = sqrt(占比) × 可用宽，下限 5pt（CSS 用 min-width 兜）。
 *  右侧两个数字包一层 sb-right，那 8pt 是 Spacer(minLength:8)，不是 HStack 的 6pt 间距。 */
function statBarHtml(name, tokens, cost, costCny, maxTokens, tint) {
  const ratio = maxTokens > 0 ? Math.sqrt(Math.max(Number(tokens) || 0, 0) / maxTokens) : 0;
  return `<div class="stat-bar" style="--tint:${tint}">
    <div class="sb-line"><span class="sb-name">${escapeHtml(name)}</span>
      <span class="sb-right"><span class="sb-tok">${escapeHtml(human(tokens))}</span>
        <span class="sb-cost">${escapeHtml(nativeMoney(cost, costCny))}</span></span></div>
    <span class="sb-bar" style="width:${(Math.min(ratio, 1) * 100).toFixed(2)}%"></span>
  </div>`;
}

/** 对应 WrappedView.statChips 里的 chip（Swift:175-188） */
function dashChip(label, value, tint, iconName) {
  return `<div class="dw-chip" style="--tint:${tint}">
    <span class="dw-chip-label">${escapeHtml(label)}</span>
    <span class="dw-chip-value">${iconName ? icon(iconName, "dw-chip-ic") : ""}<b class="fit">${escapeHtml(value)}</b></span>
  </div>`;
}

/** 对应 WrappedView.periodPicker（Swift:313-338）：五枚胶囊，选中那枚铺 claude 渐变 */
function dashPeriodPicker() {
  return `<div class="dw-period" role="tablist" aria-label="回顾区间">${
    DASH_PERIODS.map(([value, label]) => `<button type="button" role="tab" aria-selected="${value === state.dashPeriod}"
      class="dw-capsule${value === state.dashPeriod ? " is-active" : ""}" data-dash-period="${value}">${label}</button>`).join("")
  }</div>`;
}

/** 对应 WrappedView.hero（Swift:113-157） */
function dashHero(w) {
  const firstDay = String(w.first_day || "");
  const since = firstDay
    ? `<span class="dw-since">${escapeHtml(state.dashPeriod === "all" ? `自 ${firstDay}` : firstDay)}</span>` : "";
  const days = Number(w.active_days) > 0 ? `<span class="dw-since">· ${Number(w.active_days)} 天活跃</span>` : "";
  const fun = Number(w.total_cost) > 0 ? `<p class="dw-fun">💡 ${escapeHtml(dashFunFact(w))}</p>` : "";
  return `<section class="dw-hero">
    <div class="dw-hero-top"><span class="dw-spark">${icon("sparkles")}</span>
      <strong class="dw-kicker">回顾</strong><span class="filler"></span>${dashPeriodPicker()}</div>
    <div class="dw-since-row">${since}${days}</div>
    <div class="dw-total"><b class="dw-big">${escapeHtml(human(w.total_tokens))}</b>
      <span class="dw-unit">tokens</span></div>${fun}
  </section>`;
}

/** 对应 WrappedView.funFactText（Swift:342-350）：三档随机，成本换算成咖啡 / 火锅 / 字数 */
function dashFunFact(w) {
  const cost = Number(w.total_cost) || 0;
  if (state.funSeed === 0) return `这些花费 ≈ ${grouped(Math.round(cost / 4))} 杯咖啡 ☕`;
  if (state.funSeed === 1) return `这些花费 ≈ ${grouped(Math.round(cost / 40))} 顿火锅 🍲`;
  return `这些 token ≈ 码了 ${human(Math.round((Number(w.total_tokens) || 0) * 0.6))} 字 ✍️`;
}

/** 对应 WrappedView.statChips（Swift:160-168）：五枚等宽胶囊，日均 = 总成本 / 活跃天数 */
function dashChips(w) {
  const days = Number(w.active_days) || 0;
  const cost = Number(w.total_cost) || 0;
  const cny = Number(w.cost_cny) || 0;
  return `<div class="dw-chips">
    ${dashChip("总成本", nativeMoney(cost, cny), TOOL_META.claude.color)}
    ${dashChip("连续", `${Number(w.streak_cur) || 0} 天`, TOOL_META.hermes.color, "flame.fill")}
    ${dashChip("日均", nativeMoney(days > 0 ? cost / days : 0, cny / Math.max(days, 1)), TOOL_META.gemini.color)}
    ${dashChip("峰值日", dashShortDate(w.busiest?.date), "rgba(255, 59, 48, .85)")}
    ${dashChip("本命模型", String(w.top_model?.name || "-"), TOOL_META.codex.color)}
  </div>`;
}

/** 对应 WrappedView.shortDate（Swift:352）：满 10 位的 ISO 日砍尾 5 位 */
function dashShortDate(s) {
  const v = String(s || "");
  return v.length >= 10 ? v.slice(-5) : v;
}

/** 对应 WrappedView.peakDaysSection（Swift:232-268）：只画前三，第一名吃 claude 实心档 */
function dashPeakDays(peaks) {
  const rows = peaks.slice(0, 3).map((p, i) => {
    const projs = (p.projects || []).filter(Boolean);
    return `<div class="dw-peak"><span class="dw-rank${i === 0 ? " is-first" : ""}">${i + 1}</span>
      <span class="dw-peak-date">${escapeHtml(dashPeakDate(p.date))}</span>
      <span class="dw-peak-tok">${escapeHtml(human(p.tokens))}</span><span class="filler"></span>
      ${projs.length ? `<span class="dw-peak-projs">${escapeHtml(projs.join(" · "))}</span>` : ""}</div>`;
  }).join("");
  return `<section class="dw-block"><h3 class="dw-title">巅峰日</h3>
    <div class="dw-peak-list">${rows}</div></section>`;
}

/** 对应 WrappedView.peakDate（Swift:270-275）：「2026-07-21」→「7月21日」，异常输入原样返回 */
function dashPeakDate(s) {
  const parts = String(s || "").split("-");
  if (parts.length !== 3) return String(s || "");
  const m = Number(parts[1]), d = Number(parts[2]);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return String(s || "");
  return `${m}月${d}日`;
}

/** 对应 WrappedView.achievementsSection（Swift:191-228）：两列网格，超过 10 枚先收着 */
function dashAchievements(w) {
  const list = w.achievements || [];
  const limit = 10;
  const hasMore = list.length > limit;
  const shown = state.achExpanded || !hasMore ? list : list.slice(0, limit);
  const seen = dashSeen();
  return `<section class="dw-block"><div class="dw-ach-head">
    <h3 class="dw-title">成就</h3><span class="dw-count">${list.length}</span><span class="filler"></span>
    ${hasMore ? `<button type="button" class="dw-more" data-ach-toggle><span>${state.achExpanded ? "收起" : "展开全部"}</span>
      ${icon(state.achExpanded ? "chevron.up" : "chevron.down", "dw-more-ic")}</button>` : ""}
  </div><div class="dw-ach-grid">${shown.map((a, i) => dashBadge(a, !seen.includes(a.title), i)).join("")}</div></section>`;
}

/** 对应 BadgeView（Swift:360-411）：新解锁的那枚按时序做一次性金光扫过 */
function dashBadge(a, isNew, i) {
  return `<div class="dw-badge${isNew ? " is-new" : ""}" style="--delay:${(i * 0.07).toFixed(2)}s">
    <span class="dw-badge-ic">${icon(a.icon)}</span>
    <span class="dw-badge-txt"><strong>${escapeHtml(a.title)}</strong>
      <em>${escapeHtml(dashAchievementDesc(a))}</em></span></div>`;
}

/** 对应 WrappedAchievement.displayDesc（WrappedView.swift:11-17）：带「亿」的档位在非中文界面按 K/M/B 重写 */
function dashAchievementDesc(a) {
  if (!isChinese() && a.tokens && a.tokens_template) {
    return String(a.tokens_template).replace("%@", human(a.tokens));
  }
  return String(a.desc || "");
}

/** 对应 WrappedView.rhythmSection（Swift:278-310）：24 根柱，最高的那根吃 claude 渐变 */
function dashRhythm(w) {
  const hours = Array.isArray(w.hours) ? w.hours : [];
  const maxH = Math.max(hours.length ? Math.max(...hours) : 1, 1);
  const peak = hours.length ? hours.indexOf(Math.max(...hours)) : -1;
  const bars = [];
  for (let h = 0; h < 24; h += 1) {
    const v = h < hours.length ? Number(hours[h]) || 0 : 0;
    bars.push(`<span class="dw-hour${h === peak ? " is-peak" : ""}"
      style="height:${Math.max(2, 48 * (v / maxH)).toFixed(1)}px"></span>`);
  }
  const ticks = [0, 6, 12, 18, 23]
    .map((h, i, arr) => `<span class="dw-hour-tick">${h}</span>${i < arr.length - 1 ? '<span class="filler"></span>' : ""}`)
    .join("");
  return `<section class="dw-block"><div class="dw-rhythm-head">
    <h3 class="dw-title">活跃时段</h3><span class="filler"></span>
    ${peak >= 0 ? `<span class="dw-peak-label">高峰 ${String(peak).padStart(2, "0")}:00</span>` : ""}
  </div><div class="dw-hours">${bars.join("")}</div><div class="dw-hour-axis">${ticks}</div></section>`;
}

/** 对应 DashboardView.modelSection（Swift:364-380）：按 token 取前 8，条长按最大值开方 */
function dashModelSection(models) {
  const top = [...models].sort((a, b) => dashRowTokens(b) - dashRowTokens(a)).slice(0, 8);
  const maxTok = dashRowTokens(top[0]) || 1;
  return `<section class="dw-block"><h3 class="dw-title">模型用量</h3>${
    top.map((m) => statBarHtml(m.name, dashRowTokens(m), m.cost, m.cost_cny, maxTok, modelTint(m.tool))).join("")
  }</section>`;
}

/** 对应 DashboardView.providerModelSection（Swift:382-406）：账号级行不带人民币那一栏 */
function dashProviderSection(rows) {
  const top = [...rows].sort((a, b) => dashRowTokens(b) - dashRowTokens(a)).slice(0, 8);
  const maxTok = dashRowTokens(top[0]) || 1;
  return `<section class="dw-block"><h3 class="dw-title">账号 Provider 模型</h3>
    <p class="dw-sub">账号级统计单独展示，不并入本地工具总计</p>${
    top.map((m) => statBarHtml(m.name, dashRowTokens(m), m.cost, undefined, maxTok, modelTint(m.tool))).join("")
  }</section>`;
}

/** 对应 DashboardView.projectsSection（Swift:444-470）：标题行整个是开关，收起后只报数量 */
function dashProjectsSection(projects) {
  const maxTok = Number(projects[0]?.tokens) || 1;
  const body = state.hideProjects
    ? `<p class="dw-hidden-line">已隐藏 ${projects.length} 个项目</p>`
    : projects.map((p) => statBarHtml(p.name, p.tokens, p.cost, p.cost_cny, maxTok, TOOL_META.claude.color)).join("");
  return `<section class="dw-block"><button type="button" class="dw-eye-head" data-hide-toggle>
    <span class="dw-title">项目排行</span>${icon(state.hideProjects ? "eye.slash.fill" : "eye", "dw-eye-ic")}
    <span class="filler"></span>${icon(state.hideProjects ? "chevron.down" : "chevron.up", "dw-eye-ic")}</button>
    <div class="dw-eye-body">${body}</div></section>`;
}

/**
 * 对应 DashboardView.heatmapSection（Swift:474-489）：周档是 7 行横条，月/年档是方格墙。
 * 方格墙横向滚动并停在最新一列（Swift:600-620 的 scrollTo("heatEnd")）。
 */
function dashHeatmap(daily) {
  const activity = new Map(daily.map((d) => [d.date, Number(d.tokens) || 0]));
  // Swift 的 `.max() ?? 1`：只有空数组才落到 1，全 0 时留在 0（heatColor 见 max<=0 一律画空档）
  const max = daily.length ? daily.reduce((m, d) => Math.max(m, Number(d.tokens) || 0), 0) : 1;
  const grid = state.heatRange === 0 ? dashWeekStrip(activity, max) : dashHeatGrid(activity, max);
  const sel = state.heatDate ? daily.find((d) => d.date === state.heatDate) : null;
  return `<section class="dw-block dw-heat"><div class="dw-rhythm-head">
    <h3 class="dw-title">活跃热力</h3><span class="filler"></span>
    <div class="segmented is-mini heat-seg" role="tablist" aria-label="热力跨度">
      ${[[0, "周"], [1, "月"], [2, "年"]].map(([value, label]) => `<button type="button" role="tab"
        aria-selected="${state.heatRange === value}" class="seg${state.heatRange === value ? " is-active" : ""}"
        data-heat-range="${value}">${label}</button>`).join("")}
    </div></div>${grid}${sel ? dashHeatDetail(sel) : ""}${dashHeatLegend()}</section>`;
}

/** 对应 weekStrip（Swift:492-544）：最近 7 天，每行 20×20 格子 + MM-dd + 当日成本 */
function dashWeekStrip(activity, max) {
  const now = new Date();
  const rows = [];
  for (let i = 0; i < 7; i += 1) {
    const ds = dashDayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - i)));
    const day = findDashDay(ds) || {};
    const cost = Number(day.total) || 0;
    const cny = Number(day.cost_cny) || 0;
    rows.push(`<div class="heat-wrow"><span class="heat-cell heat-wcell${ds === state.heatDate ? " is-sel" : ""}"
      style="background:${heatColor(Number(activity.get(ds)) || 0, max)}" data-heat-cell="${ds}"></span>
      <span class="heat-wdate">${escapeHtml(ds.slice(5))}</span>
      ${cost > 0 || cny > 0 ? `<span class="heat-wcost">${escapeHtml(nativeMoney(cost, cny))}</span>` : ""}</div>`);
  }
  return `<div class="heat-week"><div class="heat-labels is-week">${
    weekdayLabels().map((t) => '<span class="heat-label is-week">' + escapeHtml(t) + "</span>").join("")
  }</div><div class="heat-week-rows">${rows.join("")}</div></div>`;
}

/** 对应 heatmapGrid（Swift:546-626）：列按周一对齐铺开，最后一天之后不留格子 */
function dashHeatGrid(activity, max) {
  const big = state.heatRange === 1;
  const totalDays = big ? 35 : 371;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (totalDays - 1));
  // Swift 的 (weekday + 5) % 7（周日=1）等价于 JS getDay() 的 (d + 6) % 7（周一为 0）
  const startWeekday = (start.getDay() + 6) % 7;
  const cols = [];
  for (let i = 0; i < totalDays; i += 1) {
    const ds = dashDayStr(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    const offset = startWeekday + i;
    (cols[Math.floor(offset / 7)] ??= Array.from({ length: 7 }, () => null))[offset % 7] = ds;
  }
  const cls = big ? "heat-cell is-big" : "heat-cell";
  const grid = cols.map((col) => `<div class="heat-col${big ? " is-big" : ""}">${col.map((ds, r) => {
    if (!ds) return `<span class="${cls}" style="background:${HEAT_EMPTY}"></span>`;
    return `<span class="${cls}${ds === state.heatDate ? " is-sel" : ""}" data-heat-cell="${ds}"
      style="background:${heatColor(Number(activity.get(ds)) || 0, max)}" title="${ds}"></span>`
    ;
  }).join("")}</div>`).join("");
  const labelCls = big ? "heat-label is-big" : "heat-label";
  return `<div class="heat-grid"><div class="heat-labels${big ? " is-big" : ""}">${
    weekdayLabels().map((t) => `<span class="${labelCls}">${escapeHtml(t)}</span>`).join("")
    }</div><div class="heat-scroll" id="heat-scroll"><div class="heat-cols${big ? " is-big" : ""}">${grid}</div></div></div>`;
}

/** 对应 heatmapLegend（Swift:646-658）：右对齐，两头是「少 / 多」 */
function dashHeatLegend() {
  return `<div class="heat-legend"><span class="filler"></span><span class="heat-few">少</span>
    ${HEAT_COLORS.map((c, i) => `<span class="heat-key" style="background:${i === 0 ? HEAT_EMPTY : c}"></span>`).join("")}
    <span class="heat-few">多</span></div>`;
}

/** 对应 HeatDetailCard（Swift:118-190）：每档的口径与显示条件都照 Swift 的 cell 列表，含没有 Gemini 这件事 */
function dashHeatDetail(day) {
  const n = (v) => Number(v) || 0;
  const sum = (...keys) => keys.reduce((s, k) => s + n(day[k]), 0);
  const cell = (name, tint, tokens, cost, cny) => `<div class="hd-cell" style="--tint:${tint}">
    <span class="hd-name"><i></i>${escapeHtml(name)}</span>
    <span class="hd-tok">${escapeHtml(human(tokens))} tok</span>
    <span class="hd-cost">${escapeHtml(nativeMoney(cost, cny))}</span></div>`;
  const cells = [];
  cells.push(cell("Claude", modelTint("claude"), sum("c_in", "c_out", "c_cr", "c_cw"), day.claude));
  cells.push(cell("Codex", modelTint("codex"), sum("x_in", "x_out"), day.codex));
  const reserveTok = sum("xr_in", "xr_out");
  if (reserveTok > 0 || n(day.codex_reserve) > 0) {
    cells.push(cell("Luna Reserve", modelTint("codex"), reserveTok, day.codex_reserve));
  }
  cells.push(cell("Pi", modelTint("pi"), sum("p_in", "p_out", "p_cr", "p_cw", "p_reason"), day.pi));
  cells.push(cell("Prime Agent", modelTint("prime_agent"),
    sum("pa_in", "pa_out", "pa_cr", "pa_cw", "pa_reason"), day.prime_agent));
  cells.push(cell("WorkBuddy", modelTint("workbuddy"), sum("w_in", "w_out", "w_cr", "w_cw"), day.workbuddy));
  const waTok = sum("wa_in", "wa_out", "wa_cr", "wa_cw");
  if (waTok > 0) cells.push(cell("WorkBuddy Intl.", modelTint("workbuddy_ai"), waTok, day.workbuddy_ai));
  const dTok = sum("d_in", "d_out", "d_cr", "d_cw", "d_reason");
  if (dTok > 0) {
    cells.push(cell("DeepSeek Harness", modelTint("deepseek_harness"), dTok, day.deepseek_harness,
      day.cny_by_tool?.deepseek_harness));
  }
  const cbTok = sum("cb_in", "cb_out", "cb_cr", "cb_cw");
  if (cbTok > 0 || n(day.cb_credits) > 0) {
    cells.push(`<div class="hd-cell" style="--tint:${modelTint("codebuddy")}">
      <span class="hd-name"><i></i>CodeBuddy</span><span class="hd-tok">${escapeHtml(human(cbTok))} tok</span>
      ${n(day.cb_credits) > 0 ? `<span class="hd-cost">${escapeHtml(credits(day.cb_credits))} Credits</span>` : ""}</div>`);
  }
  cells.push(cell("Qwen Code", modelTint("qwencode"), sum("q_in", "q_out", "q_cr", "q_reason"), day.qwencode));
  const gTok = sum("g_in", "g_out", "g_cr", "g_reason");
  if (gTok > 0) cells.push(cell("Grok Build", modelTint("grok"), gTok, day.grok));
  return `<div class="heat-detail"><div class="hd-head">
    <span class="hd-date">${escapeHtml(day.date)}</span><span class="filler"></span>
    <span class="hd-total">${escapeHtml(nativeMoney(day.total, day.cost_cny))}</span>
    <button type="button" class="hd-close" data-heat-close aria-label="关闭">${icon("xmark.circle")}</button>
  </div><div class="hd-grid">${cells.join("")}</div></div>`;
}

function findDashDay(ds) {
  return (state.dashboard?.daily || []).find((d) => d.date === ds) || null;
}

/**
 * 对应 DashboardView.applyCachedScope 的本地分支（Swift:690-712）：没开多设备时直接吃仓库那份，
 * 只把 grok_bot 的行换成实时额度窗口里的明细。
 * 全设备合并（allDeviceDaily / allDeviceWrapped）属于「Git 多设备同步」那一档，这里不移植。
 */
function dashModelRows() {
  const payload = state.dashboard;
  if (!payload) return [];
  const base = payload.models || [];
  return base.filter((m) => m.tool !== "grok_bot").concat(dashGrokBotRows(base));
}

/** 对应 grokBotModelsForCurrentScope（Swift:715-734）：额度窗口没数据就退回仓库里的 grok_bot 行 */
function dashGrokBotRows(base) {
  const fallback = base.filter((m) => m.tool === "grok_bot");
  const ranges = state.payload?.grok_bot?.quota?.usage?.ranges;
  const range = ranges?.[DASH_RANGE_KEY[state.dashPeriod] || "all"];
  if (!range || !Array.isArray(range.models)) return fallback;
  return range.models.map((m) => {
    const tokens = Number(m.tokens)
      || ((Number(m.in) || 0) + (Number(m.out) || 0) + (Number(m.cr) || 0)
        + (Number(m.cw) || 0) + (Number(m.reason) || 0));
    const outK = (Number(m.out) || 0) / 1000;
    return {
      name: m.name, cost: Number(m.cost) || 0, tool: "grok_bot", tokens,
      cost_per_k: outK > 0 ? (Number(m.cost) || 0) / outK : 0,
      out_ratio: tokens > 0 ? (Number(m.out) || 0) / tokens * 100 : 0,
    };
  });
}

/** 对应 DashboardRepository.$payloads 落到视图的那一段：把快照按本地口径铺出来 */
function renderDashboard() {
  const box = $("dash-body");
  if (!box) return;
  const payload = state.dashboard;
  if (!payload) {
    // Swift 的 loading 态：ProgressView(.small) 占 200 高，仓库真回了快照才算完
    box.innerHTML = `<div class="page-state is-tall"><span class="spin"></span><span class="msg">加载中…</span></div>`;
    state.dashAppeared = false;
    return;
  }
  const w = payload.wrapped || null;
  const models = dashModelRows();
  const providers = (payload.provider_models || []).filter((m) => m.tool !== "grok_bot");
  const daily = payload.daily || [];
  const parts = [];
  if (w && Number(w.total_tokens) > 0) parts.push(dashWrapped(w));
  if (models.length) parts.push(thinDiv() + dashModelSection(models));
  if (providers.length) parts.push(thinDiv() + dashProviderSection(providers));
  if (daily.length) {
    if (w && (w.projects || []).length) parts.push(thinDiv() + dashProjectsSection(w.projects));
    parts.push(thinDiv() + dashHeatmap(daily));
  }
  box.innerHTML = parts.join("");
  // 对应 proxy.scrollTo("heatEnd", anchor:.trailing)：停在最新一列
  const scroller = $("heat-scroll");
  if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  fitDashChips(box);
  dashMaybeAppear();
}

/** Swift 用 lineLimit(1) + minimumScaleFactor(0.6) 让胶囊数值自适应（WrappedView:180）。
 *  CSS 没有「放不下去就先缩字号、缩到头才省略」这条通路，只能排版后量一次：
 *  12.5 → 10.5 → 7.5 三档（0.6 档是 7.5px），每档都重新量溢出，最后一档仍溢出就交给
 *  text-overflow 的省略号。必须等 innerHTML 进文档后再量，flex 子项的 scrollWidth 才有值。 */
function fitDashChips(root) {
  root.querySelectorAll(".dw-chip-value b.fit").forEach((el) => {
    el.classList.remove("is-tight", "is-tighter");
    if (el.scrollWidth <= el.clientWidth) return;
    el.classList.add("is-tight");
    if (el.scrollWidth <= el.clientWidth) return;
    el.classList.add("is-tighter");
  });
}

/** 对应 WrappedView body（Swift:75-86）：hero、五枚胶囊、巅峰日、成就、分隔线、作息 */
function dashWrapped(w) {
  const parts = [dashHero(w), dashChips(w)];
  if ((w.peak_days || []).length) parts.push(dashPeakDays(w.peak_days));
  if ((w.achievements || []).length) parts.push(dashAchievements(w));
  parts.push(thinDiv());
  parts.push(dashRhythm(w));
  // ConfettiView 挂在 overlay(alignment:.top)，220 高不吃点击，不进布局
  if (state.dashConfetti) parts.unshift(`<div class="dw-confetti">${dashConfettiPieces()}</div>`);
  return `<section class="dw-wrapped">${parts.join("")}</section>`;
}

/** 对应 ConfettiView（Swift:414-441）：30 片，落点、时长、延迟都按 Swift 的取模公式 */
function dashConfettiPieces() {
  const out = [];
  for (let i = 0; i < 30; i += 1) {
    out.push(`<i style="--x:${(i * 37) % 100}%;--dur:${(1.5 + ((i * 13) % 10) / 10).toFixed(1)}s;`
      + `--dly:${(((i * 7) % 8) / 10).toFixed(1)}s;--rot:${(i * 47) % 360}deg;`
      + `background:${CONFETTI_TINTS[i % CONFETTI_TINTS.length]}"></i>`);
  }
  return out.join("");
}

/** 对应 UserDefaults 的三个键（WrappedView.swift:94-113）：Windows 侧落在 localStorage */
function dashSeen() {
  return (localStorage.getItem("seenAchievements") || "").split("\n").filter(Boolean);
}

function dashMarkSeen(titles) {
  const seen = new Set(dashSeen().concat(titles));
  localStorage.setItem("seenAchievements", [...seen].sort().join("\n"));
}

/** 每 10 亿一档，跨档才撒花；返回真值的同时把档位写回去 */
function dashCheckMilestone(tokens) {
  const cur = Math.floor((Number(tokens) || 0) / 1_000_000_000);
  const last = Number(localStorage.getItem("lastTokenMilestone")) || 0;
  if (cur <= last) return false;
  localStorage.setItem("lastTokenMilestone", String(cur));
  return true;
}

/**
 * 对应 WrappedView.onAppear（Swift:88-102）：只在「刚出现在屏幕上」那一次跑 ——
 * 进页、或快照从没有变成有。之后每轮刷新推送都只换数据，不再摇彩蛋、不再撒花。
 */
function dashOnAppear(w) {
  state.funSeed = Math.floor(Math.random() * 3);
  if (dashCheckMilestone(w.total_tokens)) {
    state.dashConfetti = true;
    renderDashboard();
    clearTimeout(dashOnAppear.confettiTimer);
    dashOnAppear.confettiTimer = setTimeout(() => {
      state.dashConfetti = false;
      document.querySelector(".dw-confetti")?.remove();
    }, 2600);
  }
  clearTimeout(dashOnAppear.seenTimer);
  dashOnAppear.seenTimer = setTimeout(
    () => dashMarkSeen((w.achievements || []).map((a) => a.title)), 1800);
}

/** 可见性判定：WrappedView 真的在屏幕上（有回顾且 total_tokens>0）才算出现一次 */
function dashMaybeAppear() {
  const w = state.dashboard?.wrapped;
  const visible = state.tab === "dashboard" && !!w && Number(w.total_tokens) > 0;
  if (visible && !state.dashAppeared) {
    state.dashAppeared = true;
    dashOnAppear(w);
  } else if (!visible) {
    state.dashAppeared = false;
  }
}

/**
 * 取面板快照（对应 DashboardRepository.load(wrappedPeriod)）。
 * 按「最新一次请求胜出」收口：切区间、进页、每轮刷新推送都可能撞上同一次取数，
 * 早发的回执要丢掉，否则画面会停在上一档区间上。
 * 主进程建失败回的是上一份快照或 null（同 Swift 的仓库行为），这里就沿用旧画面，
 * 不自己编「加载失败」那一行 —— macOS 那侧没有这个态，编出来会对不上。
 */
async function loadDashboard(period, force) {
  const seq = ++state.dashboardSeq;
  state.dashPeriod = period || state.dashPeriod;
  state.dashboardLoading = true;
  if (state.tab === "dashboard") renderDashboard();
  try {
    const payload = await window.tokei.getDashboard(state.dashPeriod, force);
    if (seq !== state.dashboardSeq) return;
    if (payload) state.dashboard = payload;
  } catch (e) {
    if (seq !== state.dashboardSeq) return;
    console.error("取面板数据失败", e);
  } finally {
    if (seq === state.dashboardSeq) {
      state.dashboardLoading = false;
      if (state.tab === "dashboard") renderDashboard();
    }
  }
}

function toggleHideProjects() {
  state.hideProjects = !state.hideProjects;
  localStorage.setItem("hideProjects", state.hideProjects ? "1" : "");
  renderDashboard();
}

/** 菜单栏样式与信息量的中文名，对应 MenuBarStyle.label / MenuBarDensity.label */
const MENU_STYLE_ITEMS = [
  ["system", "经典白"], ["color", "彩色"], ["symbols", "刻度"], ["dots", "圆点"],
  ["compact", "数字"], ["artistic", "星轨"], ["palm", "椰影"],
];
const MENU_DENSITY_ITEMS = [["full", "双额度"], ["lowest", "单额度"], ["icon", "仅图标"]];

/**
 * 状态栏额度来源：对应 MenuBarQuotaSource（MenuBarStyle.swift:66-147）。
 * 顺序就是状态栏的显示优先级，on 是 defaultEnabled —— 只有历史上默认开的两项为真。
 */
const QUOTA_SOURCES = [
  { id: "claude5h", label: "Claude 5h", color: "#eb8566", on: true },
  { id: "claudeWeek", label: "Claude 周", color: "#eb8566", on: false },
  { id: "claudeFable", label: "Claude Fable", color: "#f5ae38", on: false },
  { id: "codex5h", label: "Codex 5h", color: "#6badfa", on: false },
  { id: "codexWeek", label: "Codex 周", color: "#6badfa", on: true },
  { id: "kimi5h", label: "Kimi 5h", color: "#33c7a8", on: false },
  { id: "kimiSubscription", label: "Kimi 订阅", color: "#33c7a8", on: false },
  { id: "grok", label: "Grok", color: "#a6adbf", on: false },
];

function el(cls, text, tag) {
  const node = document.createElement(tag || "div");
  if (cls) node.className = cls;
  if (text !== undefined && text !== "") node.textContent = text;
  return node;
}

/** mini 开关：macOS 的 Toggle(.switch, .mini)，状态只靠 is-on 类名 */
function switchEl(isOn) {
  const sw = el("set-sw" + (isOn ? " is-on" : ""), undefined, "span");
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", isOn ? "true" : "false");
  return sw;
}

/** settingsRow（PV:4717-4741）：34 高的色点行，整行可点 */
function settingsRow(name, color, isOn, onToggle) {
  const row = el("set-tool");
  row.style.setProperty("--tint", color);
  row.appendChild(el("dot", undefined, "span"));
  row.appendChild(el("name", name, "span"));
  row.appendChild(switchEl(isOn));
  row.onclick = () => onToggle(!isOn);
  return row;
}

/** settingsToggleRow（PV:3916-3929） */
function settingsToggleRow(title, isOn, onToggle) {
  const row = el("set-row");
  row.appendChild(el("name", title, "span"));
  row.appendChild(switchEl(isOn));
  row.onclick = () => onToggle(!isOn);
  return row;
}

/** Picker(.segmented).controlSize(.mini)：往已有的 .segmented 容器里填段 */
function fillSegmented(box, items, activeValue, onPick) {
  for (const [value, text] of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg" + (value === activeValue ? " is-active" : "");
    b.dataset.value = String(value);
    b.textContent = text;
    b.onclick = () => onPick(value);
    box.appendChild(b);
  }
  return box;
}

function segmented(items, activeValue, onPick) {
  return fillSegmented(el("segmented is-mini"), items, activeValue, onPick);
}

/** menuBarQuotaHint（PV:2760-2769）：双额度只显示前两项，多出来的报「放不下」 */
function quotaHintText(selected) {
  if (!selected.length) return "全部关闭，任务栏只留图标。";
  const shown = selected.slice(0, 2).map((s) => s.label).join(" · ");
  if (selected.length > 2) {
    return `双额度显示：${shown}；${selected.slice(2).map((s) => s.label).join("、")} 放不下。`;
  }
  return `双额度显示：${shown}。`;
}

/** macOS 段落里那条 8.5 号说明（settingsSection 内 toggleRow 之后紧跟 Text） */
function sectionNote(text) {
  return el("set-note", text, "p");
}

function quotaSourceOn(id) {
  const stored = state.settings.menu_quota_enabled?.[id];
  return stored === undefined ? QUOTA_SOURCES.find((s) => s.id === id).on : !!stored;
}

function toggleQuotaSource(id, next) {
  const patch = { ...state.settings.menu_quota_enabled };
  patch[id] = next;
  void save({ menu_quota_enabled: patch });
}

function renderSettings() {
  const toolBox = $("tool-toggles");
  const quotaBox = $("quota-choice");
  const privacyBox = $("privacy-rows");
  const systemBox = $("system-rows");
  const sitBox = $("sit-rows");
  [toolBox, quotaBox, privacyBox, systemBox, sitBox,
    $("style-preview"), $("density-choice")].forEach((b) => { b.innerHTML = ""; });

  // 显示卡片（PV:2969-3005）：勾掉的工具不再扫描，所以写回 disabled_tools
  const disabled = new Set(state.settings.disabled_tools || []);
  for (const id of Object.keys(TOOL_META)) {
    toolBox.appendChild(settingsRow(TOOL_META[id].name, TOOL_META[id].color, !disabled.has(id), (next) => {
      next ? disabled.delete(id) : disabled.add(id);
      void save({ disabled_tools: [...disabled] });
    }));
  }

  // 菜单栏（PV:2804-2869）：样式、信息量两个 mini 分段 + 额度来源网格 + 摘要
  fillSegmented($("style-preview"), MENU_STYLE_ITEMS, state.settings.menu_style,
    (v) => save({ menu_style: v }));
  fillSegmented($("density-choice"), MENU_DENSITY_ITEMS, state.settings.menu_density,
    (v) => save({ menu_density: v }));
  for (const source of QUOTA_SOURCES) {
    quotaBox.appendChild(settingsRow(source.label, source.color, quotaSourceOn(source.id), (next) => {
      toggleQuotaSource(source.id, next);
    }));
  }
  $("quota-choice-hint").textContent =
    quotaHintText(QUOTA_SOURCES.filter((s) => quotaSourceOn(s.id)));

  // 隐私与额度（PV:3290-3346）：五项开关里 Windows 能落地的是这三项——
  // 「应用活跃统计」要等遥测心跳（#28），「Claude Code CLI 额度查询」要等 CLI 那条取数路，
  // 两者做出来之前不放开关，免得摆一个按下去没反应的钮。
  privacyBox.appendChild(settingsToggleRow("Grok 实时额度查询", !!state.settings.grok_live_quota_enabled,
    (v) => save({ grok_live_quota_enabled: v })));
  privacyBox.appendChild(sectionNote("默认只读本机 Grok 日志中的额度快照，不访问网络。开启后才会用本地登录凭据请求 Grok 账单接口，以便拿到最新剩余额度。"));
  privacyBox.appendChild(el("thin-div"));
  privacyBox.appendChild(settingsToggleRow("Grok Bot 额度查询", !!state.settings.grok_bot_quota_enabled,
    (v) => save({ grok_bot_quota_enabled: v })));
  // 原版这段讲的是 macOS 的只读助手与 Keychain 授权（PV:3316）；Windows 没有那条本机路，
  // 额度全部复用 Cursor 登录态（quota/grokBot.ts 的头注释），所以按实际链路重写这一句。
  privacyBox.appendChild(sectionNote("默认关闭。开启后用本机 Cursor 登录态请求 Grok Build 的额度接口，并按 5 分钟缓存；没有 Cursor 登录态时取不到读数。登录密钥只在本次请求的内存中使用，不另存副本。"));
  privacyBox.appendChild(el("thin-div"));
  privacyBox.appendChild(settingsToggleRow("千问办公额度查询", !!state.settings.qwenwork_quota_enabled,
    (v) => save({ qwenwork_quota_enabled: v })));
  privacyBox.appendChild(sectionNote("默认关闭。开启后 Tokei 仅连接千问办公桌面端在本机 127.0.0.1 提供的受保护接口；千问办公可能随之向官方服务刷新额度。不读取或保存登录凭据，需保持千问办公已登录并运行。"));

  // 系统（PV:2940-2966）
  systemBox.appendChild(settingsToggleRow("登录时启动", !!state.settings.autostart,
    (v) => save({ autostart: v })));

  // 久坐提醒（PV:3560-3587）：间隔 45/60/90，选了「启用」才展开
  sitBox.appendChild(settingsToggleRow("启用", !!state.settings.sit_reminder_enabled,
    (v) => save({ sit_reminder_enabled: v })));
  if (state.settings.sit_reminder_enabled) {
    const interval = el("set-vrow");
    interval.appendChild(el("name", "间隔", "span"));
    const picker = segmented([[45, "45m"], [60, "60m"], [90, "90m"]],
      state.settings.sit_reminder_minutes, (v) => save({ sit_reminder_minutes: v }));
    picker.style.width = "130px";
    interval.appendChild(picker);
    sitBox.appendChild(interval);
    // settingsActionButton(icon:"bell.badge", title:"测试提醒")（PV:3578-3580）：立刻弹一条通知验证通路
    const test = document.createElement("button");
    test.type = "button";
    test.className = "set-act";
    test.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">'
      + '<path d="M8 2.2c-2.1 0-3.4 1.5-3.4 3.6 0 2.6-.8 3.8-1.6 4.6-.4.4-.1 1.1.5 1.1h9c.6 0 .9-.7.5-1.1-.8-.8-1.6-2-1.6-4.6 0-2.1-1.3-3.6-3.4-3.6Z"/>'
      + '<path d="M6.6 12.6c.2.8.7 1.2 1.4 1.2s1.2-.4 1.4-1.2"/>'
      + '<circle class="badge" cx="11.6" cy="3.4" r="2.1"/></svg>'
      + "<span>测试提醒</span>";
    test.onclick = () => { void window.tokei.sitTest(); };
    sitBox.appendChild(test);
    sitBox.appendChild(sectionNote("基于系统空闲判断连续用机时长，看视频或开会不操作会被当作离开。"));
  }

  syncProviderUi();
  renderDiagnostics();
}

/** 对应 debugSummary（PV:158-165）：只挑 exit / json / errors 三种行首，用「 · 」串成一行 */
function diagSummaryText(output) {
  if (!output) return "";
  const lines = output.split("\n");
  const pick = (prefix) => lines.find((line) => line.startsWith(prefix)) || "";
  return [pick("exit:"), pick("json:"), pick("errors:")].filter(Boolean).join(" · ");
}

/** 对应 settingsDiagnosticsSection 的三态（PV:3499-3556）：钮面、转圈、复制钮与展开块 */
function renderDiagnostics() {
  const btn = $("btn-diag");
  if (!btn) return;
  const empty = !state.diagOutput;
  btn.disabled = state.diagRunning;
  btn.innerHTML = icon(state.diagRunning || empty ? "ladybug" : "chevron.up.circle")
    + `<span>${escapeHtml(state.diagRunning ? "检查中…" : empty ? "运行诊断" : "收起诊断")}</span>`;
  $("diag-spin").hidden = !state.diagRunning;
  // 原版的复制钮与报告块都只看「有没有读数」，所以连 running... 这一档都在
  $("btn-diag-copy").hidden = empty;
  const out = $("diag-out");
  out.hidden = empty;
  if (empty) return;
  out.innerHTML = `<button type="button" class="diag-sum${state.diagExpanded ? " is-open" : ""}">`
    + icon(state.diagExpanded ? "chevron.down" : "chevron.right", "diag-chev")
    + `<span class="diag-sum-text">${escapeHtml(diagSummaryText(state.diagOutput))}</span>`
    + '<span class="filler"></span></button>'
    + (state.diagExpanded ? `<pre class="diag-text">${escapeHtml(state.diagOutput)}</pre>` : "");
  const sum = out.querySelector(".diag-sum");
  if (sum) sum.onclick = () => { state.diagExpanded = !state.diagExpanded; renderDiagnostics(); };
}

/** 对应 toggleDiagnostics + runDiagnostics（PV:4063-4086）：有读数先收起，没读数才起一次全量扫描 */
async function runDiagnostics() {
  if (state.diagRunning) return;
  if (state.diagOutput) {
    state.diagOutput = "";
    state.diagExpanded = false;
    renderDiagnostics();
    return;
  }
  state.diagRunning = true;
  state.diagOutput = "running...";
  state.diagExpanded = false;
  renderDiagnostics();
  try {
    state.diagOutput = String(await window.tokei.runDiagnostics() ?? "");
  } catch (e) {
    console.error("诊断跑不起来", e);
    state.diagOutput = "";
  }
  state.diagRunning = false;
  renderDiagnostics();
}

async function save(patch) {
  state.settings = await window.tokei.setSettings(patch);
  render();
}

/** 输入框只在自建 DOM 里建一次；每次 render 都重建会让人打一个字掉一次焦点 */
const providerUi = { built: false, urlInput: null, keyInputs: {}, clears: {}, regionSeg: null, result: null };

function providerRow(label, placeholder, type, onInput) {
  const row = document.createElement("div");
  row.className = "p-row";
  const span = document.createElement("span");
  span.className = "p-label";
  span.textContent = label;
  const input = document.createElement("input");
  input.type = type;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.oninput = () => onInput(input.value);
  row.appendChild(span);
  row.appendChild(input);
  return { row, input };
}

function buildProviderUi() {
  const box = $("provider-fields");
  box.innerHTML = "";
  for (const p of PROVIDERS) {
    // 每个 Provider 之前一条 thinDivider，与原版 settingsProviderQuotaSection 一致
    box.appendChild(el("thin-div"));
    const title = document.createElement("div");
    title.className = "p-group";
    title.style.color = p.color;
    title.textContent = p.name;
    box.appendChild(title);
    if (p.note) box.appendChild(sectionNote(p.note));
    if (p.hasUrl) {
      const { row, input } = providerRow("Base URL", "https://api.example.com", "text",
        (v) => { state.providerDraft.sub2api_base_url = v; });
      providerUi.urlInput = input;
      box.appendChild(row);
    }
    if (p.hasRegion) {
      const row = document.createElement("div");
      row.className = "p-row";
      const label = document.createElement("span");
      label.className = "p-label";
      label.textContent = "区域";
      row.appendChild(label);
      // z.ai 区域在原版是 mini 分段选择器（PV:3100-3106）
      providerUi.regionSeg = segmented([["global", "Global"], ["bigmodel-cn", "BigModel CN"]],
        state.providerDraft.zai_region, (v) => { state.providerDraft.zai_region = v; render(); });
      row.appendChild(providerUi.regionSeg);
      box.appendChild(row);
    }
    const { row, input } = providerRow("API Key", p.keyPlaceholder, "password",
      (v) => { state.providerDraft.keys[p.id] = v; });
    providerUi.keyInputs[p.id] = input;
    box.appendChild(row);

    const clear = document.createElement("div");
    clear.className = "p-clear";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "set-act";
    // settingsActionButton(icon:"trash")（PV:3084-3086）
    btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">'
      + '<path d="M2.6 4.4h10.8M6.2 4.4V2.9h3.6v1.5M4.5 4.4l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1"/></svg>'
      + `<span>清除 ${escapeHtml(p.name)} 密钥</span>`;
    btn.onclick = async () => applyProviderReply(await window.tokei.clearProviderSecret(p.id), p.id);
    providerUi.clears[p.id] = btn;
    clear.appendChild(btn);
    box.appendChild(clear);
  }
  providerUi.result = $("provider-result");
  providerUi.built = true;
}

function syncProviderUi() {
  if (!providerUi.built) buildProviderUi();
  const d = state.providerDraft;
  if (providerUi.urlInput && providerUi.urlInput.value !== d.sub2api_base_url) {
    providerUi.urlInput.value = d.sub2api_base_url;
  }
  for (const p of PROVIDERS) {
    const input = providerUi.keyInputs[p.id];
    if (input && input.value !== d.keys[p.id]) input.value = d.keys[p.id];
    // 已保存时留空表示「不修改」，跟原版占位文案一致
    input.placeholder = state.stored[p.id] ? "已保存，留空不修改" : p.keyPlaceholder;
    providerUi.clears[p.id].hidden = !state.stored[p.id];
    // 整行一起收起来，否则空行还在 6pt 的段间距里占位
    providerUi.clears[p.id].parentElement.hidden = !state.stored[p.id];
  }
  if (providerUi.regionSeg) {
    providerUi.regionSeg.querySelectorAll(".seg").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.value === d.zai_region);
    });
  }
  providerUi.result.textContent = state.providerResult;
  providerUi.result.classList.toggle("is-ok", !!state.providerResult && state.providerResultOk);
  providerUi.result.classList.toggle("is-warn", !!state.providerResult && !state.providerResultOk);
}

function applyProviderReply(reply, clearedProvider) {
  if (!reply) return;
  state.settings = reply.settings || state.settings;
  state.stored = reply.stored || {};
  state.providerResult = reply.result || "";
  state.providerResultOk = !!reply.ok;
  if (clearedProvider) state.providerDraft.keys[clearedProvider] = "";
  if (reply.ok) {
    // 保存成功后不把明文 Key 留在输入框里
    for (const p of PROVIDERS) state.providerDraft.keys[p.id] = "";
    state.providerDraft.sub2api_base_url = reply.settings?.sub2api_base_url || "";
    state.providerDraft.zai_region = reply.settings?.zai_region || "global";
  }
  render();
}

/** 对应 DateFormatter "HH:mm:ss" */
function clockTime(d) {
  const p = (v) => String(v).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 表头那一处读数（store.lastUpdated，main.swift:105-147）的四种取值：
 * 成功一轮 → 更新 HH:mm:ss；扫描失败但手上还有旧数据 → 缓存数据 · 等待刷新；
 * 失败且没有数据 → 加载失败（同一轮 store.loadError 让整页换成失败态）；都还没有 → 加载中…
 */
function stampText() {
  if (state.updated) return `更新 ${clockTime(state.updated)}`;
  if (state.loadError) return "加载失败";
  if (state.payload) return "缓存数据 · 等待刷新";
  return "加载中…";
}

function renderStamp() {
  $("last-updated").textContent = stampText();
}

/** 节日皮肤（PV:270-280）：特定日期在品牌秒表右上角挂一个小角标 */
function festiveEmoji() {
  const d = new Date();
  const m = d.getMonth() + 1, day = d.getDate();
  if (m === 12 && (day === 24 || day === 25)) return "🎄";
  if (m === 1 && day === 1) return "🎉";
  if (m === 10 && day === 31) return "🎃";
  if (m === 2 && day === 14) return "❤️";
  if (m === 2 && (day === 16 || day === 17 || day === 18)) return "🧧";
  return "";
}

function renderFestive() {
  const el = $("brand-festive");
  const emoji = festiveEmoji();
  el.textContent = emoji;
  el.hidden = !emoji;
}

/** 防休眠的文案位：关掉显示「防休眠」，开着显示 ∞ 或到点的 HH:mm（KA:23-27、KA:121） */
function kaStatusLabel() {
  const ka = state.keepAwake;
  if (!ka.active) return "防休眠";
  if (ka.endsAt == null) return "∞";
  const d = new Date(ka.endsAt);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function renderKeepAwake() {
  $("btn-keep-awake").classList.toggle("is-on", state.keepAwake.active);
  $("ka-label").textContent = kaStatusLabel();
}

/** 主进程是防休眠的持有者：回执或推送进来的快照都走这一条路落到画面 */
function applyKeepAwake(s) {
  if (s && typeof s === "object") state.keepAwake = s;
  renderKeepAwake();
}

/** 勾选列和「关闭防休眠」要在打开那一刻按当前状态画（KA:139-152） */
function renderKeepAwakeMenu() {
  const ka = state.keepAwake;
  const menu = $("keep-awake-menu");
  for (const b of menu.querySelectorAll("[data-mode]")) {
    b.classList.toggle("is-on", (b.dataset.mode === "true") === ka.allowDisplaySleep);
  }
  menu.querySelector("[data-lowbattery]").classList.toggle("is-on", ka.lowBatteryGuard);
  $("ka-stop").hidden = !ka.active;
  $("ka-sep-stop").hidden = !ka.active;
}

function hideKeepAwakeMenu() {
  $("keep-awake-menu").hidden = true;
}

function showKeepAwakeMenu(x, y) {
  renderKeepAwakeMenu();
  const menu = $("keep-awake-menu");
  menu.hidden = false;
  // 咖啡钮在面板底部，菜单贴着光标弹会掉出窗外，先按真实尺寸夹一遍
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

/** 对应 footer 的 disclaimer（PanelView.swift:2106-2108）：设置页换成署名 */
function renderDisclaimer() {
  $("disclaimer").textContent = state.tab === "settings"
    ? "Made by lank" : "成本按 API 价估算,非订阅实付";
}

function renderViews() {
  for (const tab of ["usage", "quota", "dashboard", "projects", "settings"]) {
    const on = state.tab === tab;
    $(`view-${tab}`).classList.toggle("is-active", on);
    const btn = document.querySelector(`.mode-btn[data-mode="${tab}"]`);
    if (btn) {
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  }
}

function render() {
  renderViews();
  if (state.payload) {
    renderRangeControl();
    renderCards();
  } else {
    renderPageState();
  }
  if (state.settings) renderSettings();
  // 足迹页与卡片互不依赖，只在自己被看到时重绘（payload 每 10s 推一次）
  if (state.tab === "projects") renderProjects();
  if (state.tab === "dashboard") renderDashboard();
  renderStamp();
  renderDisclaimer();
  renderFestive();
  renderKeepAwake();
  // 曲线的画布宽度要照着页面真实宽度算，所以放在视图切换之后：隐藏时量出来是 0
  if (state.tab === "quota") renderCurve();
}

/**
 * 对应 PanelView 的 pageWidth(for: mode)（PanelView.swift:168-174）：
 * 额度曲线与设置恒 640；用量页按 useWide（可见卡片 >2）在 322 与 640 之间切；
 * 项目页取 max(用量页宽, 420)。
 */
const PANEL_WIDTH = { cards: 322, projects: 420, wide: 640 };

/** 对应 visibleCount：只数设置里没被关掉的工具，与本机有没有数据无关 */
function visibleToolCount() {
  const disabled = new Set(state.settings?.disabled_tools || []);
  return PANEL_ORDER.filter((id) => !disabled.has(id)).length;
}

function applyPanelWidth(tab) {
  const wide = visibleToolCount() > 2;
  let w;
  if (tab === "quota" || tab === "settings") w = PANEL_WIDTH.wide;
  else if (tab === "usage") w = wide ? PANEL_WIDTH.wide : PANEL_WIDTH.cards;
  else w = wide ? PANEL_WIDTH.wide : PANEL_WIDTH.projects;
  void window.tokei.setPanelWidth(w);
}

function selectTab(tab) {
  state.tab = tab;
  // WrappedView 的 onAppear 是「每次回到这一页」重跑一次（彩蛋重新摇），离开就把手臂收回
  if (tab !== "dashboard") state.dashAppeared = false;
  void save({ panel_tab: tab });
  if (tab === "projects" && state.trail === null) void loadTrail();
  // 对应 macOS 曲线视图的 onAppear reload：进这一页就重取一次，别停在离开期间攒下的旧帧上
  if (tab === "quota") { void loadCurve(); void loadDetail(true); }
  // 对应 DashboardView.onAppear 的 loadData：进页只走非强制取数，仓库 30s 内的快照直接复用
  //（Swift 的 force:true 只在每轮刷新推送那一发，见 boot 里的 onUsage）
  if (tab === "dashboard") void loadDashboard(state.dashPeriod, false);
  hideTrailMenu();
  applyPanelWidth(tab);
  // 顶部条与 footer 钉住后所有页共用 .view-stack 这一个滚动容器，换页要回到顶部，
  // 否则会停在上一页的滚动位置（macOS 每页是独立 ScrollView，天然从顶部开始）。
  $("view-stack").scrollTop = 0;
  render();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const copyTimers = new WeakMap();

/** 复制成功的回显：macOS 的 copyFeedback 也是 1.6s 后自己复原，期间重复点不重新计时 */
/**
 * 复制成功的回显：1.6s 内把图标换成 checkmark、文案换成「已复制」。
 * 对应 PV:2058 与 PV:2507 的 done ? "checkmark" : "photo.on.rectangle"，
 * 以及 PV:2062 那档 primary .10 的底（.is-done 已在 CSS 里接了同一档）。
 */
function flashCopied(btn, doneText) {
  btn.classList.add("is-done");
  const span = btn.querySelector("span");
  const prev = span ? span.textContent : "";
  if (span && doneText) span.textContent = doneText;
  const svg = btn.querySelector("svg");
  const prevSvg = svg ? svg.innerHTML : "";
  if (svg) svg.innerHTML = ICONS.checkmark;
  const prevTitle = btn.getAttribute("title") || "";
  if (prevTitle) btn.setAttribute("title", doneText === "" ? "已复制图片" : "已复制");
  clearTimeout(copyTimers.get(btn));
  copyTimers.set(btn, setTimeout(() => {
    btn.classList.remove("is-done");
    if (span && doneText) span.textContent = prev;
    if (svg) svg.innerHTML = prevSvg;
    if (prevTitle) btn.setAttribute("title", prevTitle);
  }, 1600));
}

/**
 * 对应 footer 的复制图片（PanelView 的 copyUsageImage）：macOS 用 ImageRenderer 把分享卡
 * 画成 PNG，Windows 侧没有那套卡片渲染器，这里等价地直接截面板窗口——内容就是当前这块面板。
 */
async function copyPanelImage() {
  hideTrailMenu();
  if (await window.tokei.copyPanelImage()) flashCopied($("btn-copy-image"), "已复制");
}

/** 卡头那枚复制钮：按卡片在视口里的矩形截取，对应 macOS 单张卡的 copyCardImage */
async function copyCardImage(btn) {
  const card = btn.closest(".card");
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const ok = await window.tokei.copyCardImage({
    x: Math.round(rect.left), y: Math.round(rect.top),
    width: Math.round(rect.width), height: Math.round(rect.height),
  });
  if (ok) flashCopied(btn, "");
}

/**
 * 一轮扫描的回执（对应 main.swift 的 performRefresh 回调）：扫成功就盖时间戳，
 * 失败时按手上还有没有旧数据分流——有就继续显示旧卡片、只把表头写成「缓存数据 · 等待刷新」，
 * 没有才让整页落到 90pt 失败态。
 */
function applyPayload(payload) {
  state.payload = payload ?? null;
  state.refreshing = false;
  if (state.payload && state.payload._ok !== false) {
    state.updated = new Date(Number(state.payload._at) || Date.now());
    state.loadError = "";
  } else {
    state.updated = null;
    state.loadError = state.payload ? "" : "读取用量失败";
  }
}

async function boot() {
  state.settings = await window.tokei.getSettings();
  if (["usage", "quota", "dashboard", "projects", "settings"].includes(state.settings.panel_tab)) state.tab = state.settings.panel_tab;
  state.pinned = new Set((localStorage.getItem("pinnedProjects") || "").split("\n").filter(Boolean));
  state.home = (await window.tokei.homeDir()) || "";
  state.stored = (await window.tokei.credentialStatus()) || {};
  state.providerDraft.sub2api_base_url = state.settings.sub2api_base_url || "";
  state.providerDraft.zai_region = state.settings.zai_region || "global";
  $("app-version").textContent = `v${await window.tokei.appVersion()} · Windows`;
  // 防休眠归主进程管（面板关掉断言也要继续），所以开面板先取一次快照再挂推送
  applyKeepAwake(await window.tokei.keepAwakeStatus?.());
  window.tokei.onKeepAwake?.((s) => applyKeepAwake(s));
  window.tokei.onUsage((payload) => {
    applyPayload(payload);
    render();
    // macOS 的曲线视图观察 QuotaHistoryStore，每轮刷新自动更新；渲染进程收不到 store 变更，
    // 就在推送到达后顺着重取一次，只在这页可见时做。周期卡同理，但走 force=false：
    // 主进程在这一轮的 refresh 里已经在建详情，这里接住同一发就行，别排第二遍。
    if (state.tab === "quota") { void loadCurve(); void loadDetail(false); }
    // 对应 DashboardView 的 .onReceive(store.$usage)（Swift:347-353）：扫描写回的按天缓存
    // 是面板数据的来源，所以每轮刷完强制重算当前区间那一档，别停在上一轮的快照上。
    if (state.tab === "dashboard") void loadDashboard(state.dashPeriod, true);
  });
  const existing = await window.tokei.getUsage();
  // 磁盘缓存那一份没有 _ok/_at：先按「缓存数据 · 等待刷新」画出来，等第一轮扫描盖上时间戳
  if (existing) { state.payload = existing; render(); }
  await window.tokei.refreshNow();

  $("btn-refresh").onclick = async () => {
    state.refreshing = true;
    render();
    await window.tokei.refreshNow();
    if (state.tab === "quota") void loadCurve();
  };
  $("btn-home").onclick = () => selectTab("usage");
  $("btn-quit").onclick = () => window.tokei.quitApp();
  // 设置页页头（PV:3817-3863）：GitHub 圆钮开外链，✕ 回用量页
  $("btn-github").onclick = () => void window.tokei.openExternal("https://github.com/cclank/tokei");
  $("btn-settings-close").onclick = () => selectTab("usage");
  $("btn-copy-image").onclick = () => copyPanelImage();
  // 咖啡钮：左键一键开关（KA:115 的 toggle），右键开时长/模式菜单（KA:132）
  $("btn-keep-awake").onclick = async () => {
    applyKeepAwake(await (state.keepAwake.active
      ? window.tokei.keepAwakeStop()
      : window.tokei.keepAwakeStart(null)));
  };
  $("btn-keep-awake").oncontextmenu = (e) => {
    e.preventDefault();
    showKeepAwakeMenu(e.clientX, e.clientY);
  };
  $("keep-awake-menu").addEventListener("click", async (e) => {
    const item = e.target.closest("[data-min],[data-mode],[data-lowbattery],.ka-stop");
    if (!item) return;
    let s = null;
    if (item.dataset.min !== undefined) s = await window.tokei.keepAwakeStart(Number(item.dataset.min) || null);
    else if (item.dataset.mode !== undefined) s = await window.tokei.keepAwakeMode(item.dataset.mode === "true");
    else if (item.hasAttribute("data-lowbattery")) s = await window.tokei.keepAwakeLowBattery(!state.keepAwake.lowBatteryGuard);
    else s = await window.tokei.keepAwakeStop();
    applyKeepAwake(s);
    // 原生 contextMenu 点一项就收，这里保持一致
    hideKeepAwakeMenu();
  });
  $("btn-provider-save").onclick = async () => {
    const d = state.providerDraft;
    applyProviderReply(await window.tokei.saveProviderSettings({
      sub2api_base_url: d.sub2api_base_url, zai_region: d.zai_region, keys: d.keys,
    }));
  };

  // 诊断段与远程采集段（PV:3499-3509、4691-4698）：两处复制都直接写系统剪贴板
  $("btn-diag").onclick = () => void runDiagnostics();
  $("btn-diag-copy").onclick = () => void window.tokei.copyText(state.diagOutput);
  $("btn-copy-remote").onclick = () => void window.tokei.copyText($("remote-setup-cmd").textContent);

  $("trail-search").oninput = (e) => {
    state.trailQuery = e.target.value;
    $("trail-clear").hidden = !state.trailQuery;
    renderProjects();
  };
  $("trail-clear").onclick = () => {
    state.trailQuery = "";
    $("trail-search").value = "";
    $("trail-clear").hidden = true;
    renderProjects();
  };
  $("trail-refresh").onclick = () => loadTrail();
  $("quota-curve").addEventListener("click", (e) => {
    // 换工具不用重新取数：一帧里两个工具的投影都算好了，本地重绘就够
    const tool = e.target.closest("[data-curve-tool]");
    if (tool) {
      state.curveTool = tool.dataset.curveTool;
      renderCurve();
      return;
    }
    const span = e.target.closest("[data-curve-span]");
    if (span) {
      state.curveSpan = Number(span.dataset.curveSpan);
      void loadCurve();
      return;
    }
    // 周期节的筛选与展开都只重绘：快照里三个工具的周期都算好了，不用再取一次数
    const filter = e.target.closest("[data-cycle-tool]");
    if (filter) {
      state.cycleTool = filter.dataset.cycleTool || null;
      renderCurve();
      return;
    }
    const expand = e.target.closest("[data-cycle-expand]");
    if (expand) {
      const tool = expand.dataset.cycleExpand;
      if (state.expandedCycles.has(tool)) state.expandedCycles.delete(tool);
      else state.expandedCycles.add(tool);
      renderCurve();
    }
  });
  $("trail-list").addEventListener("click", (e) => {
    const pin = e.target.closest("[data-pin]");
    if (pin) { togglePin(pin.dataset.pin); return; }
    const row = e.target.closest(".trail-row");
    if (row) void runTrailAction(row.dataset.path, "terminal");
  });
  $("trail-list").addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".trail-row");
    if (!row) return;
    e.preventDefault();
    showTrailMenu(row.dataset.path, e.clientX, e.clientY);
  });
  $("trail-menu").addEventListener("click", (e) => {
    const item = e.target.closest("[data-act]");
    if (!item) return;
    void runTrailAction($("trail-menu").dataset.path, item.dataset.act);
    hideTrailMenu();
  });
  // 面板页的所有交互都在同一块 innerHTML 里重建，所以走事件委托
  $("dash-body").addEventListener("click", (e) => {
    const period = e.target.closest("[data-dash-period]");
    if (period) {
      // 同 Swift 的 periodPicker：点当前档直接 return，重复取数没有意义
      if (period.dataset.dashPeriod !== state.dashPeriod) void loadDashboard(period.dataset.dashPeriod, false);
      return;
    }
    const range = e.target.closest("[data-heat-range]");
    if (range) {
      // 对应 .onChange(of: heatRange) { selectedCell = nil }
      state.heatRange = Number(range.dataset.heatRange);
      state.heatDate = null;
      renderDashboard();
      return;
    }
    const cell = e.target.closest("[data-heat-cell]");
    if (cell) {
      const ds = cell.dataset.heatCell;
      state.heatDate = state.heatDate === ds ? null : ds;
      renderDashboard();
      return;
    }
    if (e.target.closest("[data-heat-close]")) {
      state.heatDate = null;
      renderDashboard();
      return;
    }
    if (e.target.closest("[data-hide-toggle]")) { toggleHideProjects(); return; }
    if (e.target.closest("[data-ach-toggle]")) {
      state.achExpanded = !state.achExpanded;
      renderDashboard();
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#trail-menu")) hideTrailMenu();
    if (!e.target.closest("#keep-awake-menu")) hideKeepAwakeMenu();
  });

  // panel_tab 这个设置在原版是有的，之前只是存了下来没人读
  document.querySelectorAll(".mode-btn[data-mode]").forEach((btn) => {
    btn.onclick = () => selectTab(btn.dataset.mode);
  });
  $("tool-cards").addEventListener("click", (e) => {
    const disc = e.target.closest("[data-disc]");
    if (disc) {
      toggleExpanded(`disc:${disc.dataset.disc}`);
      renderCards();
      return;
    }
    const row = e.target.closest("[data-model]");
    if (row) {
      toggleExpanded(row.dataset.model);
      renderCards();
      return;
    }
    const copy = e.target.closest("[data-copy-tool]");
    if (copy) void copyCardImage(copy);
  });
  // 宽度是主进程异步改的，等窗口真的 resize 再按新尺寸重画一次，图才不会停在旧宽度上
  window.addEventListener("resize", () => { if (state.tab === "quota") renderCurve(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      // 菜单开着时先收菜单，否则关面板（macOS 的 Escape 只关面板，因为没有浮层菜单）
      if (!$("trail-menu").hidden) { hideTrailMenu(); return; }
      if (!$("keep-awake-menu").hidden) { hideKeepAwakeMenu(); return; }
      window.tokei.hidePanel();
    }
    if (e.key === "r" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      state.refreshing = true;
      render();
      void window.tokei.refreshNow();
    }
  });
  if (state.tab === "projects") void loadTrail();
  if (state.tab === "quota") void loadCurve();
  if (state.tab === "dashboard") void loadDashboard(state.dashPeriod, false);
  applyPanelWidth(state.tab);
  render();
}

boot();

/**
 * 面板几何测量台。Electron 在这个 shell 里起不来，所以把 renderer 的四个视图分别导出成
 * 静态页面，喂真实 payload + 真实项目足迹，再用 headless Edge 的 --dump-dom 读回逐元素盒模型数据。
 * 只剥掉 CSP、给 window.tokei 打桩；HTML/CSS/app.js 原样引用，不改正被测文件。
 *
 * 页面宽度按 macOS 的 pageWidth(for: mode) 分档：额度曲线与设置是 640 的宽页，用量与项目 420。
 * 曲线页在这台机器上还没有真额度读数（Claude 的 q5/q7/qf、Codex 的 pw 都是 null），面板只会是
 * 空态，量不到任何几何；所以这一页喂合成历史，但帧本身走 dist/core 里同一个
 * buildQuotaHistoryFrame()，不另写一份投影。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RENDERER = path.join(ROOT, "renderer").replace(/\\/g, "/");
const ENV = { ...process.env, TOKEI_RESOURCE_DIR: `${ROOT.replace(/\\/g, "/")}/resources` };
const { buildQuotaHistoryFrame } = require(path.join(ROOT, "dist", "core", "quotaProjection.js"));
const cli = (arg) => {
  const r = spawnSync(process.execPath, ["dist/cli.js", ...(arg ? [arg] : [])], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, env: ENV,
  });
  if (r.status !== 0) throw new Error(`cli ${arg} failed: ` + r.stderr);
  const text = r.stdout;
  return JSON.parse(text.slice(text.indexOf(arg === "--projects" ? "[" : "{")));
};
const payload = cli("");
const trail = cli("--projects");

// Codex 的 Reserve 额度、Reserve 按模型和重置卡在这台机器上全是 null（续卡抓取没移植、
// 日志里也没有 reserve 事件），面板永远不会渲染这三块。量几何必须人工补一份，
// 形状照 usage.30s.py:4195-4216 与 Model.swift:174-194。
const NOW = Math.floor(Date.now() / 1000);
const codexReserveRange = (sessions) => ({
  hit: 66.7, in: 1200000, cached: 2400000, out: 300000, reason: 90000,
  cost: 12.34, sessions,
  models: [{
    model_id: "gpt-reserve", name: "Luna Reserve", in: 400000, out: 120000,
    cr: 800000, cw: 0, reason: 30000, cost: 4.11, cost_cny: 0, credits: 0,
    pin: 5, pout: 30, pcr: 0.5, pref: "GPT-5.5",
  }, {
    model_id: "gpt-reserve-2", name: "Luna Reserve 第二档很长很长的模型名字用来测换行", in: 60000, out: 9000,
    cr: 0, cw: 0, reason: 0, cost: 0.4, cost_cny: 0, credits: 0, pin: 5, pout: 30, pcr: 0,
  }],
});
function withCodexReserve(p, stale) {
  const c = JSON.parse(JSON.stringify(p));
  c.codex = c.codex || {};
  c.codex.p5 = 62.5; c.codex.pw = 18.2;
  c.codex.r5 = NOW + 3 * 3600 + 900; c.codex.rw = NOW + 4 * 86400;
  c.codex.q_updated = NOW - 120;
  c.codex.reserve_quota = {
    used_percent: 87.5, resets_at: NOW + 2 * 86400, window_minutes: 10080,
    plan: "pro", updated: NOW - 120, stale: !!stale,
  };
  c.codex.reserve_ranges = { today: codexReserveRange(7), year: codexReserveRange(31) };
  c.codex.reset_cards = { count: 3, expires: [NOW + 2 * 86400, NOW + 5 * 86400 + 7200, NOW + 9 * 86400 + 3600], updated: NOW - 60 };
  if (stale) { c.codex.p5_stale = true; c.codex.pw_stale = true; }
  return c;
}
const PAYLOAD_CODEX = withCodexReserve(payload, false);
const PAYLOAD_CODEX_STALE = withCodexReserve(payload, true);

// Grok 的订阅额度与分产品占用同样只有联网才有的到（source 恒为 null），补一份：
// 四个产品名覆盖 grokProductLabel 的三条映射分支和 default 分支。
function withGrokQuota(p, ended) {
  const c = JSON.parse(JSON.stringify(p));
  c.grok = c.grok || {};
  c.grok.pct = 71.5; c.grok.window = "week"; c.grok.plan = "supergrok";
  c.grok.source = "live"; c.grok.q_updated = NOW - 300; c.grok.auth_expired = false;
  c.grok.reset = ended ? NOW - 3600 : NOW + 3 * 86400;
  c.grok.stale = !!ended;
  c.grok.products = [
    { name: "GrokBuild", pct: 62 },
    { name: "api", pct: 23.4 },
    { name: "grokchat", pct: 9 },
    { name: "某个没映射的产品名-很长很长用来测省略号", pct: 3 },
  ];
  return c;
}
const PAYLOAD_GROK = withGrokQuota(payload, false);
const PAYLOAD_GROK_ENDED = withGrokQuota(payload, true);

// 千问办公额度只有桌面端本机接口才有（Windows 上 available 恒为 false），
// 共享资源包 / 明细 / 到期行都得合成。形状照 Model.swift:822-828 与 collector 的 qwenwork 节点。
function withQwenQuota(p, stale) {
  const c = JSON.parse(JSON.stringify(p));
  c.qwenwork = Object.assign({}, c.qwenwork, {
    available: true, exceeded: !!stale, is_team: true,
    remaining: 1234.5, remaining_pct: 62.5,
    expires_at: NOW + 20 * 86400, plan_expiration: NOW + 200 * 86400,
    // 三条明细分别压「映射命中」「转红」「无 total 也就没有条」三个分支
    segments: [
      { id: "plan", kind: "plan", total: 2000, used: 1100, remaining: 900, percentage_used: 55, unit: "credits", renews_at: NOW + 5 * 86400, expires_at: NOW + 40 * 86400 },
      { id: "add-on-credits", kind: "add_on", total: 500, used: 440, remaining: 60, percentage_used: 88, unit: null, renews_at: null, expires_at: NOW + 3 * 86400 },
      { id: "", kind: "其他项目", total: 0, used: null, remaining: 12.5, percentage_used: null, unit: "点", renews_at: null, expires_at: null },
    ],
    shared: { total: 50000, used: 47250, remaining: 2750, percentage_used: 94.5, unit: "credits", expires_at: NOW + 9 * 86400 },
    source: stale ? "cache" : "mcp", updated: NOW - 60, stale: !!stale,
  });
  return c;
}
const PAYLOAD_QWEN = withQwenQuota(payload);
const PAYLOAD_QWEN_STALE = withQwenQuota(payload, true);

// Provider 联网额度模板（PV:1062-1144）在这台机器上永远没有数据（联网取数还没接），
// 只能合成：windows 含一条 usage_known=false，details 给 14 条压 prefix(12) 的上限。
function withProviderQuota(p, stale) {
  const c = JSON.parse(JSON.stringify(p));
  const q = {
    available: true, plan: "pro Max", account: "someone.long.mail@exceeding-the-width.example.com",
    windows: [
      { id: "5h", title: "5 小时", used_pct: 33.3, reset: NOW + 2 * 3600, window_minutes: 300 },
      { id: "week", title: "本周", used_pct: 78.9, reset: NOW + 4 * 86400, window_minutes: 10080, detail: "按会话累计" },
      { id: "month", title: "本月", usage_known: false, detail: "该套餐不公开月比例" },
      { id: "extra", title: "没有说明的窗口", usage_known: false },
    ],
    details: Array.from({ length: 14 }, (_, i) => ({
      label: i === 0 ? "额度到期" : `明细项 ${i + 1}`,
      value: i === 0 ? String(NOW + 30 * 86400) : `${(i * 137) % 999} 次`,
      secondary: i % 3 === 0 ? "附带一行很长的说明文字用来量右对齐" : "",
    })),
    source: "live", updated: NOW - 45, stale: !!stale,
  };
  c.minimax = Object.assign({}, c.minimax, { quota: q });
  c.devin = Object.assign({}, c.devin, { quota: stale ? { available: true, windows: [], details: [], stale: true, updated: null } : q });
  return c;
}
const PAYLOAD_PROVIDER = withProviderQuota(payload, false);
const PAYLOAD_PROVIDER_STALE = withProviderQuota(payload, true);

// 真实足迹里没有极端长路径，几何上是否溢出必须用最坏情况测，所以按真实数据的形状补几条人工行。
const LONG = "D:\\work\\ai_code\\very_long_workspace_name\\sub-project-directory\\nested\\erp.api";
const EXTRA = [
  { path: LONG, name: "erp.api", last_active: today(), sessions: 1234567,
    tokens: 999999999, cost: 12345.67, cost_cny: 88888.88,
    top_model: "MiMo-V2.5-Pro-Longest-Model-DisplayName (DeepSeek Harness)",
    tools: ["claude", "codex", "workbuddy", "deepseek_harness", "musecode", "kimicode", "grok"] },
  { path: "D:\\work\\ai_code\\qoder 中文项目名-含空格", name: "qoder 中文项目名-含空格", last_active: today(),
    sessions: 2, tokens: 100, cost: 0, top_model: "", tools: ["claude"] },
  { path: "C:\\Users\\A\\notes", name: "notes", last_active: farDay(30), sessions: 1, tokens: 10,
    cost: 0.01, top_model: "GPT-5.1 Codex (Codex)", tools: ["codex"] },
  { path: "D:\\work\\ai_code\\x", name: "an-absurdly-long-project-directory-name-for-overflow-testing",
    last_active: today(), sessions: 99999, tokens: 1, cost: 0.02, cost_cny: 0.13,
    top_model: "claude-opus-4-1-20251114 (Claude)", tools: ["claude", "codex", "pi", "prime_agent", "kimicode", "musecode", "cmdcode"] },
];
const TRAIL = [...EXTRA, ...trail];

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function farDay(offset) {
  const d = new Date(Date.now() - offset * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SETTINGS = {
  disabled_tools: [], menu_style: "system", menu_density: "full", menu_quota_enabled: {},
  autostart: false, keep_awake_low_battery: true, sit_reminder_enabled: false, sit_reminder_minutes: 45,
  panel_tab: "usage", device_id: "probe", sync_dir: "",
  grok_live_quota_enabled: false, qwenwork_quota_enabled: false, locale: "auto",
  sub2api_base_url: "https://sub2api.example.com/v1", zai_region: "bigmodel-cn",
  sub2api_quota_enabled: false, zai_quota_enabled: true, minimax_quota_enabled: false,
};
/** 设置页的三种极端档位：久坐展开（多一条间隔行）、额度来源全开（摘要走「放不下」）、全关 */
const SETTINGS_SIT = { ...SETTINGS, sit_reminder_enabled: true, sit_reminder_minutes: 60 };
const SETTINGS_QUOTA_ALL = {
  ...SETTINGS,
  menu_quota_enabled: Object.fromEntries(["claude5h", "claudeWeek", "claudeFable", "codex5h",
    "codexWeek", "kimi5h", "kimiSubscription", "grok"].map((k) => [k, true])),
};
const SETTINGS_QUOTA_NONE = { ...SETTINGS, menu_quota_enabled: { claude5h: false, codexWeek: false } };

/**
 * 窄页（322 单列）的入口是「可见卡片 ≤2」：对应 PanelView 的 useWide 判定。
 * 这里只留 Claude Code 与 Codex 两张有真实数据的卡，其余全部关掉，
 * 才能量到窄档的版式；宽档用上面的默认设置（可见 31 个）。
 */
const ALL_BUT_TWO = [
  "gemini", "grok", "grok_bot", "qoderwork", "qoder", "qodercli", "qodercli_cn",
  "hermes", "zcode", "mimocode", "openclaw", "pi", "prime_agent", "workbuddy", "workbuddy_ai",
  "codebuddy", "deepseek_harness", "opencode", "qwencode", "qwenwork", "kimicode", "musecode",
  "cmdcode", "devin", "minimax", "antigravity", "cursor", "zed", "sub2api", "zai",
];
const LEAN = { ...SETTINGS, disabled_tools: ALL_BUT_TWO };
/**
 * 窄档（322 单列）的真实入口是「可见卡片 ≤2」，所以合成页要按 payload 里的工具名逐个关掉，
 * 只留被测的那一张；只关一部分会得到 322 双列那种真机上不存在的版式。
 */
const ALL_TOOLS = Object.keys(payload);
const onlyLean = (keep) => ({ ...SETTINGS, disabled_tools: ALL_TOOLS.filter((t) => !keep.includes(t)) });
const LEAN_GROK = onlyLean(["grok"]);
const LEAN_QWEN = onlyLean(["qwenwork"]);
const LEAN_PROVIDER = onlyLean(["minimax", "devin"]);

/**
 * 合成额度历史：8 天、15 分钟一跳，夜里（00-06 点）不采样，好让跨零点的空档产出「约」。
 * 数值两三跳才动一次 —— 真实读数本来就是这个阶梯形状，平台段压实是为它准备的。
 * 种子固定，量出来的几何每次可复现。
 */
function synthPoints() {
  let seed = 20261009;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const one = (v) => Math.round(v * 10) / 10;
  const now = Math.floor(Date.now() / 1000);
  const step = 900;
  let fable = null;
  const out = [];
  let liveFive = 100, liveWeek = 92, liveCodex = 68;
  for (let i = Math.floor(8 * 86400 / step); i >= 0; i--) {
    const ts = Math.floor((now - i * step) / 60) * 60;
    const hour = new Date(ts * 1000).getHours();
    // 最近三小时始终有读数，否则现在若是凌晨，1h 这一档会空掉、量不到曲线
    if (ts < now - 3 * 3600 && (hour < 7 || hour > 23)) continue;
    if (i % 3 === 0) liveFive -= 2 + rnd() * 9;
    if (liveFive < 12) liveFive = 100;                        // 5 小时窗口滚动重置
    if (i % 5 === 0) liveWeek -= 0.8 + rnd() * 6;
    if (liveWeek < 8) liveWeek = 100;                         // 周额度回满：一次上升够 10 个点才算
    if (i % 4 === 0) liveCodex -= 1.5 + rnd() * 9;
    if (liveCodex < 20) liveCodex = 96;
    if (ts > now - 4 * 86400 && fable === null) fable = 62;   // 前四天没有 Fable 窗口读数
    if (fable !== null) {
      if (i % 6 === 0) fable -= 1 + rnd() * 5;
      if (fable < 10) fable = 100;
    }
    const claudeActivity = rnd() < 0.14
      ? [{ model: "claude-opus-4-1-20251114", tokenDelta: Math.round(20000 + rnd() * 9_000_000) }]
        .concat(rnd() < 0.4 ? [{ model: "Claude Fable 预览版", tokenDelta: Math.round(1000 + rnd() * 900_000) }] : [])
      : [];
    out.push({
      timestamp: ts,
      claudeFiveHourRemaining: one(liveFive),
      claudeWeekRemaining: one(liveWeek),
      claudeFableWeekRemaining: fable === null ? null : one(fable),
      codexWeekRemaining: one(liveCodex),
      claudeActivity,
      codexActivity: rnd() < 0.09
        ? [{ model: "gpt-5.1-codex-max-reasoning-xhigh", tokenDelta: Math.round(5000 + rnd() * 3_000_000) }]
        : [],
    });
  }
  // 最新一拍的 Fable 窗口钉在 15 以下，专门踩 macOS 的 value <= 15 转红分支
  if (out.length) out[out.length - 1].claudeFableWeekRemaining = 11.4;
  return out;
}

const POINTS = synthPoints();
const END = Math.floor(Date.now() / 1000);
const framesFor = (points) => Object.fromEntries([1, 6, 24, 168].map((span) => [span, buildQuotaHistoryFrame(
  points.filter((p) => p.timestamp >= END - span * 3600), points, span, END,
)]));
const CURVE = framesFor(POINTS);
const CURVE_EMPTY = framesFor([]);

/**
 * 合成周额度详情（buildQuotaDetail 的那一份回执）：这台机器上账本止于 09-22、
 * 锚点文件也没有，周期与一年跨度的每日柱子都画不出来，量几何只能人工喂。
 * 形状照 src/core/quotaDetail.ts 的 QuotaDetailPayload，值照最坏情况取：
 * claude 给 12 条历史周期（压过 collapsedCycleLimit=8 的展开分支）并掺一条 4.3 天的重锚，
 * codex 当前周期 used_pct 为空（没有进度条）、token 大到要缩号，grok 只有历史没有当前。
 */
function synthDetail(kind) {
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  const key = (epoch) => {
    const d = new Date(epoch * 1000);
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  let seed = 20261013;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  const daily = [];
  if (kind !== "nodaily") {
    // 380 天，逢 7 的倍数缺一天（CLI 清过日志），柱子疏密与跨年跨度一起量
    for (let i = 380; i >= 0; i--) {
      if (i % 7 === 3) continue;
      const epoch = now - i * day;
      const busy = i < 60;
      daily.push({
        d: key(epoch),
        c: Math.round((busy ? 400_000 : 60_000) + rnd() * 9_000_000),
        x: Math.round((busy ? 900_000 : 30_000) + rnd() * 24_000_000),
        g: Math.round(rnd() * 1_200_000),
      });
    }
  }

  const cycle = (tool, start, end, used, tokens, devices, approx, current) => ({
    tool, start, end, used_pct: used, tokens, devices, approx, current,
  });
  let cycles = [];
  if (kind !== "nocycles") {
    cycles = [
      cycle("claude", now - 3 * day, now + 4 * day, 61.5, 42_300_000,
        { 本机: 31_000_000, "会议室那台很长的设备名": 11_300_000 }, false, true),
      // 12 条整周历史 + 一条 4.3 天的重锚，末尾那条给 0 台设备（devices 为空也不能崩）
      ...Array.from({ length: 12 }, (_, i) => cycle(
        "claude", now - (10 + i * 7) * day, now - (3 + i * 7) * day,
        [96.4, 88.8, 100, 42.5, 71.2, 55, 63.9, 12.5, 30.4, 77.7, 91, 60][i],
        Math.round((9_000_000 + rnd() * 70_000_000) / (i + 1)),
        { 本机: 5_000_000 }, i % 4 === 0, false)),
      cycle("claude", now - 92 * day, now - 87.7 * day, 33.3, 8_000_000, { 本机: 8_000_000 }, false, false),
      cycle("codex", now - 5 * day, now + 2 * day, null, 1_876_543_210,
        { 本机: 1_800_000_000, 笔记本: 76_543_210 }, true, true),
      ...Array.from({ length: 3 }, (_, i) => cycle(
        "codex", now - (9 + i * 7) * day, now - (2 + i * 7) * day,
        [78.5, 100, 6.2][i], Math.round(4_000_000 + rnd() * 40_000_000), { 本机: 3_000_000 }, false, false)),
      // grok：只有历史，没有当前周期 → 走「compactTitle: false」那张卡
      ...Array.from({ length: 2 }, (_, i) => cycle(
        "grok", now - (11 + i * 7) * day, now - (4 + i * 7) * day,
        [45, null][i], Math.round(1_000_000 + rnd() * 6_000_000), { 本机: 1_000_000 }, false, false)),
    ];
  }
  return {
    daily,
    cycles,
    devices: kind === "onedev" ? ["本机"] : ["本机", "会议室那台很长的设备名", "笔记本"],
    missing: kind === "nocycles" ? ["claude", "codex", "grok"] : ["grok"],
    now,
  };
}

const DETAIL = synthDetail("full");
const DETAIL_ONE_DEV = synthDetail("onedev");
const DETAIL_NO_CYCLES = synthDetail("nocycles");
const DETAIL_NO_DAILY = synthDetail("nodaily");

/* ---- 数据面板（主进程 DashboardStore 那份快照）----
   这一页取数走 DashboardStore，测量台起不了 Electron，所以调同一个 buildDashboard() 造快照。
   区间起点按传进去的「今天」算：本机数据止于缓存最后一天，拿那一天当今天，1d/7d/30d 三档
   才有内容可量；渲染端那边的热力格子是按真今天的 new Date() 铺的，所以用例统一带 today=<数据末日>
   把 window.Date 钉住，两边对齐。
   真快照铺不出项目排行、账号 Provider 模型、超过 10 枚成就，也点不出单日下钻里的
   Luna Reserve / WorkBuddy Intl. / CodeBuddy / Grok Build 四格（这台机器没有对应数据），
   所以另造一份 full 变体把这些分支补齐——补的是形状，不是这台机器的读数。 */
const { buildDashboard } = require(path.join(ROOT, "dist", "core", "dashboard.js"));
const { providerUsageFromDays } = require(path.join(ROOT, "dist", "core", "providerQuota.js"));
const dashIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DASH_PERIODS = ["all", "365d", "30d", "7d", "1d"];
const DASH_LAST = buildDashboard(payload, "all", new Date()).daily
  .reduce((m, d) => (d.date > m ? d.date : m), "");
const DASH_TODAY = DASH_LAST ? new Date(`${DASH_LAST}T12:00:00`) : new Date();

/** grok_bot 的账号级模型来自实时额度节点的 usage.ranges（compute.ts:243-252），
 *  这台机器 grok_bot.quota 是空的，只能按同一条重建函数造一份。 */
function withGrokBotUsage(p) {
  const c = JSON.parse(JSON.stringify(p));
  const model = (name, tokens, cost) => ({
    name, tokens, in: Math.round(tokens * 0.375), out: Math.round(tokens * 0.1125),
    cr: Math.round(tokens * 0.5), cw: 0, reason: Math.round(tokens * 0.0125), cost,
  });
  const day = {
    tokens: 1200000, in: 400000, out: 120000, cr: 600000, cw: 0, reason: 80000,
    cost: 3.21, requests: 42,
    models: {
      "grok-4": model("grok-4", 800000, 2.1),
      "grok-code-fast-一个长到必须缩字号的模型名": model("grok-code-fast-一个长到必须缩字号的模型名", 400000, 1.11),
    },
  };
  const days = {};
  for (let i = 0; i < 400; i += 7) {
    const d = new Date(DASH_TODAY.getTime());
    d.setDate(d.getDate() - i);
    days[dashIso(d)] = day;
  }
  c.grok_bot = Object.assign({}, c.grok_bot, {
    quota: Object.assign({ available: false, plan: null, account: null, windows: [], details: [], source: "cache", updated: null, stale: true },
      c.grok_bot && c.grok_bot.quota, { usage: providerUsageFromDays(days) }),
  });
  return c;
}
const PAYLOAD_GROKBOT = withGrokBotUsage(payload);

/** 把一份真快照补齐成「所有分支都会出现」的那份 */
function enrichDash(d) {
  const c = JSON.parse(JSON.stringify(d));
  c.models = c.models.concat([
    { name: "GPT-5.5 Pro 长到要截断的模型名字用来量省略号", tool: "codex", tokens: 98_400_000, cost: 41.06, cost_cny: 295.6, cost_per_k: 0.42, out_ratio: 8.1 },
    { name: "deepseek-v4-pro", tool: "deepseek_harness", tokens: 21_900_000, cost: 1.94, cost_cny: 14.02, cost_per_k: 0.09, out_ratio: 12.4 },
    { name: "kimi-k2", tool: "kimicode", tokens: 3_400_000, cost: 0.71, cost_cny: 0, cost_per_k: 0.21, out_ratio: 30.2 },
    { name: "grok-4", tool: "grok_bot", tokens: 800_000, cost: 2.1, cost_cny: 0, cost_per_k: 2.6, out_ratio: 11.3 },
  ]);
  c.provider_models = [
    { name: "claude-opus-4 (账号级)", tool: "claude", tokens: 903_000_000, cost: 212.4, cost_cny: 1530.2, cost_per_k: 0.24, out_ratio: 6.2 },
    { name: "gpt-5-codex (Cursor 账号)", tool: "cursor", tokens: 128_500_000, cost: 33.1, cost_cny: 0, cost_per_k: 0.26, out_ratio: 9.8 },
    { name: "glm-4.7 (z.ai 账号)", tool: "zai", tokens: 12_400_000, cost: 2.05, cost_cny: 14.8, cost_per_k: 0.17, out_ratio: 41.5 },
  ];
  c.wrapped.projects = [
    { name: "天枢票控 ERP 主工程", tokens: 1_284_500_000, cost: 512.4, cost_cny: 3660.11 },
    { name: "very_long_workspace_name/sub-project-directory/nested/erp.api", tokens: 320_400_000, cost: 88.02, cost_cny: 0 },
    { name: "demo", tokens: 4_120_000, cost: 0.31, cost_cny: 0.02 },
  ];
  c.wrapped.top_model = { name: "GPT-5.5-pro-high-一个长得吃掉整枚胶囊的模型名", tokens: 1_940_000_000 };
  c.wrapped.peak_days = (c.wrapped.peak_days || []).slice(0, 3).map((p, i) => ({
    ...p,
    projects: [
      ["天枢票控", "ai_code/tokei-win", "另一个项目目录名很长用来量换行"],
      ["单独一个项目"],
      [],
    ][i],
  }));
  const base = (c.wrapped.achievements || []).slice();
  const extra = [
    ["crown.fill", "万亿先生", "3.42 万亿 token", "gold"],
    ["hexagon.fill", "千亿先生", "1200 亿 token", "gold"],
    ["dollarsign.circle.fill", "烧钱大户", "累计 $1,024.31", "red"],
    ["banknote.fill", "人民币玩家", "累计 ¥7,380.50", "green"],
    ["flame.fill", "二十天连轴", "连续 20 天", "orange"],
    ["bolt.fill", "单日爆发", "单日 12.4 亿 token", "yellow"],
    ["square.grid.3x3.fill", "多面手", "9 个工具齐开", "blue"],
    ["scope", "夜猫子", "深夜产出占比 41.2%", "purple"],
    ["moon.stars.fill", "凌晨四点的代码", "凌晨 4 点还在跑", "indigo"],
    ["beach.umbrella.fill", "度假还在用", "周末 2 天活跃", "teal"],
    ["calendar", "半年老用户", "跨度 186 天", "gray"],
  ];
  c.wrapped.achievements = base.concat(extra.map(([icon, title, desc, tint]) => ({ icon, title, desc, tint })));
  // 单日下钻要能点到「十一个格子都齐」的那一天：真数据里没有 Gemini/Pi/CodeBuddy 这些桶，
  // 就把它们并进数据末日那一行（同一天留一行，否则 daily.find 先命中的是真行、量不到补的值）。
  const merged = {
    date: DASH_LAST,
    claude: 21.4, codex: 6.31, codex_reserve: 1.02, gemini: 0, grok: 0.44, hermes: 0, openclaw: 0,
    zcode: 0, mimocode: 0, devin: 0, minimax: 0, pi: 1.35, workbuddy: 8.6, workbuddy_ai: 2.14,
    codebuddy: 0, deepseek_harness: 1.94, qwencode: 0.62, kimicode: 0, musecode: 0, cmdcode: 0,
    prime_agent: 3.08, total: 47.24,
    c_in: 5200000, c_out: 610000, c_cr: 12400000, c_cw: 300000,
    x_in: 1200000, x_out: 300000, x_cached: 2400000, x_reason: 90000,
    xr_in: 400000, xr_out: 120000, xr_cached: 800000, xr_reason: 30000,
    p_in: 300000, p_out: 90000, p_cr: 600000, p_cw: 0, p_reason: 0,
    pa_in: 800000, pa_out: 210000, pa_cr: 1500000, pa_cw: 0, pa_reason: 40000,
    w_in: 2100000, w_out: 480000, w_cr: 5200000, w_cw: 120000,
    wa_in: 600000, wa_out: 150000, wa_cr: 900000, wa_cw: 0,
    cb_in: 0, cb_out: 0, cb_cr: 0, cb_cw: 0, cb_credits: 128.5,
    d_in: 900000, d_out: 260000, d_cr: 1800000, d_cw: 0, d_reason: 50000,
    q_in: 260000, q_out: 80000, q_cr: 400000, q_reason: 0,
    g_in: 120000, g_out: 40000, g_cr: 200000, g_reason: 10000,
    tokens: 42_600_000, cost_cny: 339.8,
    cny_by_tool: { claude: 153.7, codex: 45.3, deepseek_harness: 14.02, workbuddy: 61.8, workbuddy_ai: 15.4, pi: 9.7, prime_agent: 22.2, qwencode: 4.5, grok: 3.2 },
  };
  const at = c.daily.findIndex((x) => x.date === DASH_LAST);
  if (at >= 0) c.daily[at] = { ...c.daily[at], ...merged };
  else c.daily.push(merged);
  return c;
}
const dashSet = (enrich) => Object.fromEntries(DASH_PERIODS.map((p) => {
  const d = buildDashboard(payload, p, DASH_TODAY);
  return [p, enrich ? enrichDash(d) : d];
}));
const DASH = dashSet(false);
const DASH_FULL = dashSet(true);
/** 诊断报告的桩：行首必须是 exit: / json: / errors: 才进摘要；
 *  总行数故意超过 16，用来量展开全文的 lineLimit(16) 封顶。 */
const DIAG_REPORT = [
  "script: D:\\work\\ai_code\\tokei-win\\dist\\cli.js",
  "exists: true size: 148392B",
  "exit: 0 timeout: no elapsed: 3.42s",
  "stdout: 1048576B stderr: 0B",
  "json: ok tools: claude,codex,gemini,antigravity,cursor,zed,sub2api,zai,grok,grok_bot,"
    + "hermes,zcode,mimocode,openclaw,pi,workbuddy,workbuddy_ai,codebuddy,deepseek_harness,"
    + "opencode,qwencode,qwenwork,kimicode,musecode,cmdcode,prime_agent,devin,minimax",
  "pricing: 214 2026-10-11 03:07",
  "errors:",
].concat(Array.from({ length: 11 }, (_, i) => `- ${["cursor", "zed", "grok_bot", "sub2api", "zai", "minimax",
  "antigravity", "devin", "codex", "gemini", "grok"][i]}_quota: Error: 第 ${i + 1} 路取数失败`)).join("\n");
// 区间整体落在数据之外（本机真实今天就在这个格子里，缓存止于 09-22）：
// Swift 那边是一段都不画的空 VStack，渲染端也只能安静退场，不许抛异常。
const DASH_ZERO_ISO = dashIso(new Date(DASH_TODAY.getTime() + 60 * 864e5));
const DASH_ZERO = Object.fromEntries(DASH_PERIODS.map((p) =>
  [p, buildDashboard(payload, p, new Date(`${DASH_ZERO_ISO}T12:00:00`))]));
console.log("dash last=" + DASH_LAST + " allBytes=" + JSON.stringify(DASH.all).length
  + " fullBytes=" + JSON.stringify(DASH_FULL.all).length
  + " grokBotRanges=" + Object.keys(PAYLOAD_GROKBOT.grok_bot.quota.usage.ranges).join(","));

// 帧的大小就是这张页每次 IPC 的真实开销，量几何顺带盯住它
console.log("curve points=" + POINTS.length
  + " frameBytes=" + [1, 6, 24, 168].map((s) => `${s}h:${JSON.stringify(CURVE[s]).length}`).join(" "));

const STUB = (curveFrames, detail, vw, settings, pay, dash) => `<script>
// headless Edge 的最小窗口宽度夹在 ~492，而面板真实宽度是 322/420；菜单夹取读的是 window.innerWidth，
// 所以这里把它按真实尺寸打桩，量出来的夹取结果才对应真实窗口。
Object.defineProperty(window, "innerWidth", { get: () => ${vw} });
Object.defineProperty(window, "innerHeight", { get: () => 640 });
window.__usagePush = [];
window.__copyCalls = [];
// 防休眠：主进程那份快照用桩复现。ka=on 无限期 / ka=15 定时 15 分钟；
// kamode=1 = 允许关屏；kaguard=0 = 低电量保护已关。
window.__ka = {
  active: false, endsAt: null,
  allowDisplaySleep: /(?:#|&)kamode=1/.test(location.hash),
  lowBatteryGuard: !/(?:#|&)kaguard=0/.test(location.hash),
};
const seedKa = /(?:#|&)ka=([^&]+)/.exec(location.hash);
if (seedKa) {
  window.__ka.active = true;
  window.__ka.endsAt = seedKa[1] === "on" ? null : Date.now() + Number(seedKa[1]) * 60000;
}
const setKa = (p) => Object.assign(window.__ka, p);
// 桩或 app.js 抛错时立刻在 DOM 上留标记：dump-dom 只认 DOM，控制台里的栈看不见
window.addEventListener("error", (e) => {
  const p = document.createElement("pre");
  p.id = "boot-error";
  p.textContent = "BOOT-ERROR " + e.message + " @" + (e.filename || "") + ":" + e.lineno;
  document.body.appendChild(p);
});
window.addEventListener("unhandledrejection", (e) => {
  const p = document.createElement("pre");
  p.id = "boot-error";
  p.textContent = "BOOT-REJECT " + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason);
  document.body.appendChild(p);
});
window.tokei = {
  getSettings: async () => (${JSON.stringify(settings)}),
  setSettings: async (p) => Object.assign({}, ${JSON.stringify(settings)}, p),
  getUsage: async () => (${JSON.stringify(pay)}),
  // onUsage 走真链路：refreshNow 之后按主进程那一轮的样子推一份带 _ok/_at 的 payload，
  // 这样表头的「更新 HH:mm:ss」与整页失败态都能量到，而不是只测缓存分支。
  onUsage: (h) => { window.__usagePush.push(h); },
  refreshNow: async () => {
    const p = Object.assign({}, ${JSON.stringify(pay)}, { _ok: true, _at: Date.now() });
    window.__usagePush.forEach((h) => h(p));
    return p;
  },
  appVersion: async () => "0.1.0",
  hidePanel: () => {}, openExternal: () => {},
  // 宽窄页切换在真机上是主进程改窗口，测量台里窗口尺寸已经按这一页的档位钉死，桩只需吞掉调用
  setPanelWidth: async () => true,
  getQuotaHistory: async (span) => window.__curveFrames[span] || window.__curveFrames[24],
  // 周额度详情：契约是 Promise<QuotaDetailPayload | null>（preload.ts:16），force 只影响主进程缓存，
  // 桩这边直接回快照；detail=none 复现「一次都没构建成功」的 null，量占位与缺失提示那一档。
  getQuotaDetail: async () => window.__detail,
  // 数据面板快照：主进程那边走 DashboardStore（新鲜期/并发合帧在单测里对过），
  // 这里按区间直接回同一份 buildDashboard() 产物；period 缺档回 null 复现「一次都没构建成功」。
  getDashboard: async (period) => window.__dash[period] || null,
  credentialStatus: async () => ({ sub2api: false, zai: true, minimax: false }),
  saveProviderSettings: async (i) => ({ ok: true, result: "已保存", stored: { sub2api: !!i.keys.sub2api, zai: !!i.keys.zai, minimax: !!i.keys.minimax }, settings: (${JSON.stringify(settings)}) }),
  clearProviderSecret: async () => ({ ok: true, result: "已清除", stored: { sub2api: false, zai: false, minimax: false }, settings: (${JSON.stringify(settings)}) }),
  quitApp: async () => true,
  // 防休眠：主进程那份状态用桩复现。ka=on 无限期开启 / ka=15 定时 15 分钟，
  // kamode=1 表示允许关屏，kaguard=0 表示低电量保护已关。
  keepAwakeStatus: async () => window.__ka,
  keepAwakeStart: async (m) => setKa({ active: true, endsAt: m ? Date.now() + m * 60000 : null }),
  keepAwakeStop: async () => setKa({ active: false, endsAt: null }),
  keepAwakeMode: async (v) => setKa({ allowDisplaySleep: !!v }),
  keepAwakeLowBattery: async (v) => setKa({ lowBatteryGuard: !!v }),
  sitTest: async () => { window.__sitTests = (window.__sitTests ?? 0) + 1; return true; },
  onKeepAwake: () => () => {},
  copyPanelImage: async () => { window.__copyCalls.push("panel"); return true; },
  copyCardImage: async (r) => { window.__copyCalls.push("card" + Math.round(r.width) + "x" + Math.round(r.height)); return true; },
  getProjects: async () => (${JSON.stringify(TRAIL)}),
  openProject: async () => ({ ok: true }),
  copyProjectPath: async () => true,
  // 诊断段与两处复制：桩给一份定型的报告，让报告块能在无 Electron 的 headless 里量到展开态
  runDiagnostics: async () => {
    window.__diagCalls = (window.__diagCalls ?? 0) + 1;
    // diag=hold：让取数挂住，用来看「检查中…」那一档
    if (window.__diagHold) return new Promise(() => {});
    return window.__diag;
  },
  copyText: async (t) => { window.__copyText = (window.__copyText ?? []).concat(String(t).slice(0, 40)); return true; },
  homeDir: async () => (${JSON.stringify(process.env.USERPROFILE || "C:\\Users\\A")}),
};
window.__curveFrames = ${JSON.stringify(curveFrames)};
window.__detail = ${detail === null ? "null" : JSON.stringify(detail)};
window.__dash = ${JSON.stringify(dash || DASH)};
window.__diag = ${JSON.stringify(DIAG_REPORT)};
</script>`;

const PROBE = (vw) => `<script>
(function () {
  const JS_ERRORS = [];
  window.addEventListener("error", (e) => JS_ERRORS.push("JS错误: " + e.message + " @" + (e.filename || "") + ":" + e.lineno));
  window.addEventListener("unhandledrejection", (e) => JS_ERRORS.push("JS拒绝: " + (e.reason && e.reason.message || e.reason)));
  const VW = ${vw}, VH = 640;
  const want = Object.fromEntries(location.hash.slice(1).split("&").filter(Boolean).map(kv => kv.split("=")));
  function box(el) {
    const r = el.getBoundingClientRect();
    return el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : "")
      + "@" + r.left.toFixed(0) + ".." + r.right.toFixed(0) + " " + r.width.toFixed(0) + "x" + r.height.toFixed(0);
  }
  function rect(el) { return el.getBoundingClientRect(); }
  function measure() {
    const lines = [];
    const vis = (el) => {
      if (el.closest(".view:not(.is-active)") && !el.closest("#trail-menu")) return false;
      const r = el.getBoundingClientRect();
      return (r.width > 0 || r.height > 0) && getComputedStyle(el).display !== "none";
    };
    for (const el of document.querySelectorAll("body *")) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > VW + 0.5 || r.left < -0.5) {
        // 横向滚动容器把内容推到盒子外面是正常的（面板的热力墙就是往左滚），
        // 这种「越界」只在滚动容器自己的盒子上判，里面的格子/列一律跳过
        const hscroll = (() => {
          for (let n = el.parentElement; n; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (s.overflowX !== "visible" && n.scrollWidth > n.clientWidth + 1) return true;
          }
          return false;
        })();
        if (!hscroll) {
          lines.push("越界 <" + el.tagName.toLowerCase() + ">." + String(el.className || "")
            + " left=" + r.left.toFixed(1) + " right=" + r.right.toFixed(1)
            + " '" + (el.textContent || "").trim().slice(0, 20) + "'");
        }
      }
      if (r.bottom > VH + 0.5 && !el.closest("main") && getComputedStyle(el).position !== "fixed") {
        lines.push("沉底越界 <" + el.tagName.toLowerCase() + ">." + String(el.className || "")
          + " bottom=" + r.bottom.toFixed(1) + " '" + (el.textContent || "").trim().slice(0, 16) + "'");
      }
      const leaf = el.children.length === 0 && (el.textContent || "").trim();
      if (leaf && el.scrollWidth > el.clientWidth + 1) {
        const over = getComputedStyle(el).overflowX;
        if (over === "visible") {
          lines.push("被裁 <" + el.tagName.toLowerCase() + ">." + String(el.className || "")
            + " '" + el.textContent.trim().slice(0, 24) + "' scroll=" + el.scrollWidth + " client=" + el.clientWidth);
        } else if (want.strict) {
          lines.push("省略号截断 <" + el.tagName.toLowerCase() + ">." + String(el.className || "")
            + " '" + el.textContent.trim().slice(0, 28) + "' scroll=" + el.scrollWidth + " client=" + el.clientWidth
            + " text-overflow=" + getComputedStyle(el).textOverflow);
        }
      }
    }
    const main = document.querySelector("main");
    const inside = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
    for (const grid of document.querySelectorAll(".tool-grid")) {
      if (grid.closest(".view:not(.is-active)")) continue;
      const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
      const cards = [...grid.children].map((c) => rect(c));
      const tops = [...new Set(cards.map((r) => r.top.toFixed(0)))];
      const widths = [...new Set(cards.map((r) => r.width.toFixed(0)))];
      // 只有两个轴都重叠才算相交：同一行的两张卡本来就该 top 相同
      const overl = cards.some((r, i) => cards.slice(i + 1).some((o) =>
        r.left < o.right - 0.5 && o.left < r.right - 0.5 && r.top < o.bottom - 0.5 && o.top < r.bottom - 0.5));
      lines.push("grid " + box(grid) + " cols=" + cols + " 卡=" + cards.length
        + " 行顶=" + tops.join(",") + " 宽=" + widths.join(",")
        + " 相交=" + overl
        + " 出格=" + cards.filter((r) => !inside(r, rect(grid))).length);
    }
    for (const card of document.querySelectorAll(".card")) {
      if (card.closest(".view:not(.is-active)")) continue;
      const cr = rect(card);
      const head = card.querySelector(".card-head");
      const cells = head ? [...head.children].map((c) => {
        const r = c.getBoundingClientRect();
        return String(c.className || "u").split(" ")[0].replace("head-", "")
          + "@" + r.left.toFixed(0) + ".." + r.right.toFixed(0)
          + (c.scrollWidth > c.clientWidth + 1 ? "(裁" + c.scrollWidth + "/" + c.clientWidth + ")" : "");
      }).join(" | ") : "无卡头";
      const hl = card.querySelector(".headline");
      const metrics = card.querySelector(".metrics");
      const overflow = [...card.querySelectorAll(".card-head *, .headline, .metrics .metric, .q-top, .disc, .disc *, .mrow, .m-detail, .notice, .badge-row, .reset-panel, .reset-panel *, .share-row, .share-row *, .q-shared, .q-shared *, .q-over, .q-seg, .q-seg *, .pq-head, .pq-unknown, .pq-details, .pd-row, .pd-row *")]
        .filter((el) => !inside(rect(el), cr));
      // 重置卡那一行的图标/文字/最近到期挤不挤，只有 322 档能量出来，单独打一行
      const reset = card.querySelector(".disc.is-reset");
      if (reset) {
        const rr = rect(reset);
        lines.push("reset " + card.dataset.tool + " " + rr.width.toFixed(0) + "x" + rr.height.toFixed(0)
          + "@" + rr.top.toFixed(0) + " | " + [...reset.children].map((c) => {
            const r = c.getBoundingClientRect();
            return String(c.className).split(" ")[0] + "@" + r.left.toFixed(0) + ".." + r.right.toFixed(0)
              + (c.scrollWidth > c.clientWidth + 1 ? "(裁" + c.scrollWidth + "/" + c.clientWidth + ")" : "");
          }).join(" ")
          + " | 面板=" + (() => {
            const p = card.querySelector(".reset-panel");
            if (!p) return "收起";
            const items = [...p.querySelectorAll(".reset-item")].map((it) => rect(it).height.toFixed(0));
            return rect(p).width.toFixed(0) + "x" + rect(p).height.toFixed(0) + " 行=" + items.join(",");
          })());
      }
      // Grok 分产品占用行与千问共享包：一行一行打，看窄卡里名称有没有被截断
      for (const sel of [".share-row", ".q-shared", ".q-seg", ".pq-head", ".pq-unknown", ".pd-row"]) {
        for (const el of card.querySelectorAll(sel)) {
          const r = rect(el);
          lines.push(sel.slice(1) + " " + card.dataset.tool + " " + r.width.toFixed(0) + "x" + r.height.toFixed(0)
            + "@" + r.top.toFixed(0) + " | " + [...el.querySelectorAll("*")].filter((c) => c.children.length === 0).map((c) => {
              const q = c.getBoundingClientRect();
              return (String(c.className).split(" ")[0] || c.tagName.toLowerCase())
                + "@" + q.left.toFixed(0) + ".." + q.right.toFixed(0)
                + (c.scrollWidth > c.clientWidth + 1 ? "(裁" + c.scrollWidth + "/" + c.clientWidth + ")" : "");
            }).join(" "));
        }
      }
      lines.push("card " + card.dataset.tool + " " + cr.width.toFixed(0) + "x" + cr.height.toFixed(0)
        + "@" + cr.top.toFixed(0) + " tint=" + getComputedStyle(card).getPropertyValue("--tint").trim()
        + " | " + cells
        + " | 大数=" + (hl ? hl.querySelector("b").textContent + " " + hl.querySelector("span").textContent : "无")
        + (metrics ? " | 格=" + getComputedStyle(metrics).gridTemplateColumns.split(" ").filter(Boolean).length
          + "/" + metrics.children.length + "环=" + metrics.querySelectorAll(".m-ring").length : " | 无metric")
        + " | q=" + card.querySelectorAll(".q-row").length + " 条=" + card.querySelectorAll(".q-bar i").length
        + " 通知=" + card.querySelectorAll(".notice").length + " 落款=" + card.querySelectorAll(".q-stamp").length
        + " 披露=" + card.querySelectorAll(".disc").length + " 模型行=" + card.querySelectorAll(".mrow").length
        + " 胶囊=" + card.querySelectorAll(".m-detail .tag").length
        + " 占用=" + card.querySelectorAll(".share-row").length
        + " 共享=" + card.querySelectorAll(".q-shared").length
        + " 日期=" + card.querySelectorAll(".q-date").length
        + " 积分段=" + card.querySelectorAll(".q-seg").length
        + " 警告落款=" + card.querySelectorAll(".q-stamp.is-warn").length
        + " 未知窗=" + card.querySelectorAll(".pq-unknown").length
        + " 明细=" + card.querySelectorAll(".pd-row").length
        + " | 出格=" + overflow.length
        + (overflow.length ? "[" + overflow.slice(0, 3).map((el) =>
          String(el.className || el.tagName).split(" ")[0] + " "
          + rect(el).left.toFixed(0) + ".." + rect(el).right.toFixed(0)
          + "/" + cr.left.toFixed(0) + ".." + cr.right.toFixed(0)).join(" ") + "]" : ""));
    }
    const idle = document.querySelector("#idle-tools");
    if (idle && !idle.hidden) lines.push("idle " + box(idle) + " '" + idle.textContent.trim().slice(0, 40) + "'");
    const state = document.querySelector("#tool-cards .page-state");
    if (state) lines.push("page-state " + box(state) + " '" + state.textContent.trim() + "'");
    const stamp = document.querySelector("#last-updated");
    if (stamp) lines.push("stamp '" + stamp.textContent.trim() + "' " + box(stamp));
    // 品牌头：秒表图标、节日角标、模式钮都在同一行里排队，逐个量一遍才看得出挤不挤
    const bar = document.querySelector(".topbar");
    if (bar) {
      lines.push("head " + box(bar) + " | " + [...bar.children].map((c) => {
        const r = c.getBoundingClientRect();
        return (c.className || c.tagName) + "@" + r.left.toFixed(0) + ".." + r.right.toFixed(0)
          + " " + r.width.toFixed(0) + "x" + r.height.toFixed(0);
      }).join(" | "));
      const mk = bar.querySelector(".mark-wrap"), fe = bar.querySelector(".festive");
      lines.push("brand mark=" + (mk ? box(mk) : "无")
        + " 角标=" + (fe && !fe.hidden ? box(fe) + " '" + fe.textContent + "'" : "无")
        + " 文案=" + (bar.querySelector(".brand-text") ? box(bar.querySelector(".brand-text")) : "无"));
    }
    const foot = document.querySelector(".panel-foot");
    if (foot) lines.push("foot " + box(foot) + " | " + [...foot.children].map((c) => {
      const r = c.getBoundingClientRect();
      return (c.id || c.className) + "@" + r.left.toFixed(0) + ".." + r.right.toFixed(0)
        + " " + r.width.toFixed(0) + "x" + r.height.toFixed(0)
        + (c.scrollWidth > c.clientWidth + 1 ? "(裁)" : "");
    }).join(" | "));
    // 咖啡钮：开启态的颜色/底是 Theme.claude 那一条，文案位换成 ∞ 或 HH:mm，必须当场读
    const kaBtn = document.querySelector("#btn-keep-awake");
    if (kaBtn) {
      const cs = getComputedStyle(kaBtn);
      const cup = kaBtn.querySelector(".cup-body");
      lines.push("ka " + box(kaBtn) + " '" + kaBtn.textContent.trim() + "'"
        + " 前景=" + cs.color + " 底=" + cs.backgroundColor + " 杯填=" + (cup ? getComputedStyle(cup).fill : "?")
        + " 模式勾选=" + [...document.querySelectorAll("#keep-awake-menu [data-mode]")]
          .map((b) => b.dataset.mode + ":" + b.classList.contains("is-on")).join(",")
        + " 低电=" + /is-on/.test(document.querySelector("#keep-awake-menu [data-lowbattery]").className)
        + " 关闭项=" + (document.querySelector("#ka-stop").hidden ? "隐" : "现")
        + " 勾=" + (document.querySelector("#keep-awake-menu button.is-on .ka-check")
          ? getComputedStyle(document.querySelector("#keep-awake-menu button.is-on .ka-check"), "::before").content : "无"));
    }
    const kaMenu = document.querySelector("#keep-awake-menu");
    if (kaMenu && !kaMenu.hidden) {
      const mr = kaMenu.getBoundingClientRect();
      lines.push("camenu " + box(kaMenu) + " top=" + mr.top.toFixed(0) + " bottom=" + mr.bottom.toFixed(0)
        + " right=" + mr.right.toFixed(0) + " inWindow=" + (mr.left >= 0 && mr.top >= 0
          && mr.right <= innerWidth + 0.5 && mr.bottom <= innerHeight + 0.5)
        + " | " + [...kaMenu.children].map(box).join(" | "));
    }
    // 复制图片的回显是 1.6s 后就消失的瞬时态，--dump-dom 看不到，必须在探针里当场读
    const copyBtn = document.querySelector("#btn-copy-image");
    if (copyBtn) {
      const cardCopy = document.querySelector("[data-copy-tool]");
      lines.push("copy 面板=" + copyBtn.classList.contains("is-done") + " '" + copyBtn.textContent.trim()
        + "' | 卡片=" + (cardCopy ? cardCopy.classList.contains("is-done") + " '" + cardCopy.textContent.trim() + "'" : "无")
        + " | 事件回调=" + (window.__copyCalls || []).join(","));
    }
    for (const row of document.querySelectorAll(".trail-row")) {
      if (row.closest(".view:not(.is-active)")) continue;
      const name = row.querySelector(".trail-name");
      const pth = row.querySelector(".trail-path");
      const meta = row.querySelector(".trail-meta");
      const model = row.querySelector(".trail-model");
      lines.push("row " + box(row) + " h=" + row.getBoundingClientRect().height.toFixed(0)
        + " | name" + (name.scrollWidth > name.clientWidth + 1 ? "(裁" + name.scrollWidth + "/" + name.clientWidth + ")" : "")
        + " | path[" + pth.textContent.trim() + "]len=" + pth.textContent.trim().length
        + (pth.scrollWidth > pth.clientWidth + 1 ? "(裁" + pth.scrollWidth + "/" + pth.clientWidth + ")" : "")
        + " | metaH=" + meta.getBoundingClientRect().height.toFixed(0)
        + " rows=" + Math.round(meta.getBoundingClientRect().height / 15)
        + (model ? " | model@" + model.getBoundingClientRect().width.toFixed(0)
          + (model.scrollWidth > model.clientWidth + 1 ? "(裁" + model.scrollWidth + "/" + model.clientWidth + ")" : "") : "")
        + " | dots=" + row.querySelectorAll(".trail-dot").length
        + " | pin=" + box(row.querySelector(".trail-pin")));
    }
    for (const g of document.querySelectorAll(".trail-group")) {
      lines.push("group " + box(g) + " '" + g.textContent.trim() + "'");
    }
    const head = document.querySelector(".view.is-active .trail-head");
    if (head) {
      lines.push("head " + [...head.querySelectorAll("*")].map(box).join(" | "));
      lines.push("footer " + box(document.querySelector("#trail-footer"))
        + " '" + document.querySelector("#trail-footer").textContent.trim() + "'");
    }
    const menu = document.querySelector("#trail-menu");
    if (menu && !menu.hidden) {
      const mr = menu.getBoundingClientRect();
      lines.push("menu " + box(menu) + " top=" + mr.top.toFixed(0) + " bottom=" + mr.bottom.toFixed(0)
        + " right=" + mr.right.toFixed(0) + " inWindow=" + (mr.left >= 0 && mr.top >= 0
          && mr.right <= innerWidth + 0.5 && mr.bottom <= innerHeight + 0.5)
        + " | " + [...menu.children].map(box).join(" | "));
    }
    measureCurve(lines);
    measureSettings(lines);
    measureDash(lines);
    // 外壳：顶部条与 footer 必须钉在视口上下，滚动只发生在 .view-stack 里
    //（head/foot 两行已经量了各自的盒，这里只判「贴不贴边、中间能不能滚」）
    const stack = document.querySelector(".view-stack");
    if (stack) {
      const vhReal = main.getBoundingClientRect().height;
      const b = rect(document.querySelector(".topbar"));
      const f = rect(document.querySelector(".panel-foot"));
      lines.push("shell 顶贴边=" + (b.top <= 15.5) + " 底贴边=" + (Math.abs(f.bottom - (vhReal - 15)) <= 1.5)
        + " 中间可滚=" + (stack.scrollHeight > stack.clientHeight)
        + " client/scroll=" + stack.clientHeight + "/" + stack.scrollHeight
        + " overflowY=" + getComputedStyle(stack).overflowY
        + " 滚动条占宽=" + (stack.offsetWidth - stack.clientWidth) + "px");
    }
    lines.push("main client/scroll=" + main.clientHeight + "/" + main.scrollHeight
      + " overflowY=" + getComputedStyle(main).overflowY);
    lines.push("inner=" + innerWidth + "x" + innerHeight + "(stub)"
      + " body=" + document.body.getBoundingClientRect().width.toFixed(0) + "x"
      + document.body.getBoundingClientRect().height.toFixed(0)
      + " dpr=" + devicePixelRatio);
    lines.push("doc scroll=" + document.documentElement.scrollWidth + "x" + document.body.scrollHeight
      + " bodyH=" + document.body.clientHeight);
    lines.push("cards=" + document.querySelectorAll(".view.is-active .card").length
      + " grid=" + document.querySelectorAll(".view.is-active .tool-grid").length
      + " metric=" + document.querySelectorAll(".view.is-active .metric").length
      + " qrow=" + document.querySelectorAll(".view.is-active .q-row").length
      + " mrow=" + document.querySelectorAll(".view.is-active .mrow").length
      + " trailRows=" + document.querySelectorAll(".trail-row").length
      + " groups=" + document.querySelectorAll(".trail-group").length
      + " curveStats=" + document.querySelectorAll(".curve-stat").length
      + " curveRows=" + document.querySelectorAll(".curve-rows > div").length);
    if (JS_ERRORS.length) lines.unshift("errors " + JS_ERRORS.slice(0, 5).join(" ; "));
    const pre = document.createElement("pre");
    pre.id = "probe";
    pre.textContent = "PROBE " + location.hash + "\\n" + (JS_ERRORS.length ? JS_ERRORS.join("\\n") + "\\n" : "") + lines.join("\\n");
    document.body.appendChild(pre);
  }

  /** 周额度一节逐元素：筛选行、当前周期卡（进度/大数/外推/设备行）、更早周期行网格、展开钮 */
  function measureCycle(lines) {
    const section = document.querySelector(".cycle-section");
    if (!section) return;
    lines.push("cycle 节 " + box(section) + " 卡=" + section.querySelectorAll(".curve-card").length
      + " 行=" + section.querySelectorAll(".cycle-row").length
      + " 占位=" + section.querySelectorAll(".cycle-placeholder").length
      + " 缺失提示=" + section.querySelectorAll(".cycle-missing").length
      + " 展开钮=" + section.querySelectorAll(".cycle-more").length
      + " 分隔线=" + section.querySelectorAll(".cycle-divider").length);
    const header = section.querySelector(".cycle-header");
    if (header) {
      const filter = header.querySelector(".cycle-filter");
      lines.push("cycle 头 " + box(header) + " | " + [...header.children].map(box).join(" | ")
        + " | 标题截断=" + [...header.querySelectorAll(".cycle-titles *")].map((c) => c.scrollWidth + "/" + c.clientWidth).join(",")
        + " 标题字号=" + (header.querySelector(".cycle-title") ? getComputedStyle(header.querySelector(".cycle-title")).fontSize + "/" + getComputedStyle(header.querySelector(".cycle-title")).fontWeight : "-")
        + " 副标题='" + (header.querySelector(".cycle-sub") || { textContent: "" }).textContent.trim() + "'"
        + " | 筛选=" + (filter ? getComputedStyle(filter).width + "(算得 " + (54 * (filter.children.length - 1) + 24) + ") "
          + [...filter.children].map((b) => b.textContent + ":" + rect(b).width.toFixed(0)
            + (b.scrollWidth > b.clientWidth + 1 ? "(裁" + b.scrollWidth + "/" + b.clientWidth + ")" : "")).join(",") : "无(≤1 工具)"));
    }
    for (const card of section.querySelectorAll(".curve-card")) {
      const cr = rect(card);
      const tint = getComputedStyle(card).getPropertyValue("--tint").trim();
      const out = [...card.querySelectorAll("*")].filter((el) => el.children.length === 0
        && (el.textContent || "").trim() && el.getBoundingClientRect().right > cr.right + 0.5);
      lines.push("cycle 卡 " + box(card) + " tint=" + tint
        + " 出格=" + (out.length ? out.slice(0, 3).map((el) => String(el.className || el.tagName).split(" ")[0]
          + "@" + rect(el).right.toFixed(0)).join(",") : "无"));
      const cur = card.querySelector(".cycle-card");
      if (cur) {
        const top = cur.querySelector(".cycle-top");
        lines.push("  卡头 " + [...top.children].map(box).join(" | ")
          + " | 标题=" + getComputedStyle(top.querySelector("strong")).fontSize + "/" + getComputedStyle(top.querySelector("strong")).fontWeight
          + " 色=" + getComputedStyle(top.querySelector("strong")).color
          + " 回满='" + top.children[1].textContent.trim() + "'"
          + " 截断=" + [...top.children].map((c) => c.scrollWidth + "/" + c.clientWidth).join(","));
        const prog = cur.querySelector(".cycle-progress");
        lines.push("  进度=" + (prog ? (() => {
          const track = prog.querySelector(".cycle-track"), fill = track.firstElementChild, used = prog.querySelector(".cycle-used");
          return box(track) + " 高=" + rect(track).height.toFixed(0) + " 圆角=" + getComputedStyle(track).borderRadius
            + " 填充=" + rect(fill).width.toFixed(0) + "/" + rect(track).width.toFixed(0)
            + "(" + getComputedStyle(fill).background.slice(0, 24) + ")"
            + " 已用@" + rect(used).left.toFixed(0) + ".." + rect(used).right.toFixed(0)
            + " minWidth=" + getComputedStyle(used).minWidth + " 实宽=" + rect(used).width.toFixed(0)
            + " 截=" + used.scrollWidth + "/" + used.clientWidth;
        })() : "无(used_pct 为空)"));
        const big = cur.querySelector(".cycle-big strong"), grouped = cur.querySelector(".cycle-grouped");
        const project = cur.querySelector(".cycle-project"), devices = cur.querySelector(".cycle-devices");
        lines.push("  用量 " + box(cur.querySelector(".cycle-tokens"))
          + " | 大数='" + big.textContent + getComputedStyle(big).fontSize + "/" + getComputedStyle(big).fontWeight
          + "/" + getComputedStyle(big).fontFamily.split(",")[0] + "'"
          + " 单位='" + cur.querySelector(".cycle-unit").textContent.trim() + "'"
          + " 精确='" + grouped.textContent.trim() + "'(" + grouped.scrollWidth + "/" + grouped.clientWidth + ")"
          + " | 外推=" + (project ? "'" + project.textContent.trim() + "' " + box(project.querySelector("strong"))
            + " 字号=" + getComputedStyle(project.querySelector("strong")).fontSize : "无(used<3 或 tokens=0)")
          + " | 设备=" + (devices ? box(devices) + " 截=" + devices.scrollWidth + "/" + devices.clientWidth
            + " textOverflow=" + getComputedStyle(devices).textOverflow + " '" + devices.textContent.trim().slice(0, 40) + "'"
            : "无(≤1 台)"));
      }
      const hist = card.querySelector(".cycle-history");
      if (hist) {
        const more = hist.querySelector(".cycle-more");
        lines.push("  更早 " + box(hist) + " 标题='" + hist.querySelector("strong").textContent.trim() + "'"
          + " 行=" + hist.querySelectorAll(".cycle-row").length
          + " 警告=" + hist.querySelectorAll(".cycle-uneven").length
          + " 展开=" + (more ? box(more) + " '" + more.textContent.trim() + "' 色=" + getComputedStyle(more).color
            + " 字号=" + getComputedStyle(more).fontSize + " 图标=" + (more.querySelector("svg") ? box(more.querySelector("svg")) : "无")
            : "无(已全展开)"));
        for (const [i, r] of [...hist.querySelectorAll(".cycle-row")].entries()) {
          const kids = [...r.children].map((c) => {
            const q = c.getBoundingClientRect();
            return String(c.className).split(" ")[0].replace("cycle-", "") + "@" + q.left.toFixed(0) + ".." + q.right.toFixed(0)
              + "w" + q.width.toFixed(0) + (c.scrollWidth > c.clientWidth + 1 ? "(裁" + c.scrollWidth + "/" + c.clientWidth + ")" : "");
          }).join(" ");
          const bar = r.querySelector(".cycle-bar i");
          lines.push("  行" + i + " " + rect(r).width.toFixed(0) + "x" + rect(r).height.toFixed(0)
            + " cols=[" + getComputedStyle(r).gridTemplateColumns + "] " + kids
            + " 条=" + (bar ? rect(bar).width.toFixed(0) + "/" + rect(r.querySelector(".cycle-bar")).width.toFixed(0) : "无"));
          if (i === 0) lines.push("  行0占位列='" + (r.querySelector(".cycle-pct > span:first-child") || { textContent: "" }).textContent + "' 显示=" + getComputedStyle(r.querySelector(".cycle-pct > span:first-child")).visibility);
        }
      }
    }
    const ph = section.querySelector(".cycle-placeholder");
    if (ph) lines.push("cycle 占位 " + box(ph) + " 高=" + rect(ph).height.toFixed(0) + "(设计 58) '" + ph.textContent.trim() + "'");
    for (const m of section.querySelectorAll(".cycle-missing")) {
      lines.push("cycle 缺失 " + box(m) + " 截=" + m.scrollWidth + "/" + m.clientWidth + " '" + m.textContent.trim().slice(0, 30) + "'");
    }
  }

  function measureCurve(lines) {
    const curve = document.querySelector("#quota-curve");
    if (!curve || !(curve.textContent || "").trim()) return;
    measureCycle(lines);
    // 曲线/每日那一张卡：周期节也复用 .curve-card，所以按内容定位而不是取第一个
    const body = (document.querySelector(".curve-summary, .daily-stats") || curve).closest(".curve-card") || curve;
    lines.push("curve box=" + box(curve) + " card=" + box(body));
    const controls = document.querySelector(".curve-controls");
    if (controls) {
      lines.push("controls " + [...controls.querySelectorAll("*")].map(box).join(" | ")
        + " | titles截断=" + [...controls.querySelectorAll(".curve-titles *")].map(
          (c) => c.scrollWidth + "/" + c.clientWidth).join(","));
    }
    const summary = document.querySelector(".curve-summary");
    if (summary) {
      lines.push("summary " + box(summary) + " | " + [...summary.children].map(box).join(" | ")
        + " | 行数=" + Math.round(summary.getBoundingClientRect().height / 26));
    }
    const wrap = document.querySelector(".daily-wrap");
    if (wrap) {
      const stats = wrap.querySelector(".daily-stats");
      lines.push("daily wrap " + box(wrap) + " 卡=" + box(wrap.closest(".curve-card")));
      lines.push("daily stats " + box(stats) + " cols=" + getComputedStyle(stats).gridTemplateColumns
        + " | " + [...stats.children].map((s) => {
          const exact = s.querySelector(".daily-exact");
          const strong = s.querySelector("strong");
          return s.querySelector("span").textContent + "@" + rect(s).width.toFixed(0) + "x" + rect(s).height.toFixed(0)
            + " 大数=" + strong.textContent + "/" + getComputedStyle(strong).fontSize
            + "/" + getComputedStyle(strong).fontFamily.split(",")[0]
            + " 色=" + getComputedStyle(strong).color
            + " 精确=" + exact.textContent + "(" + exact.scrollWidth + "/" + exact.clientWidth + ")"
            + " 标题截=" + s.querySelector("span").scrollWidth + "/" + s.querySelector("span").clientWidth;
        }).join(" | "));
      const cardRect = rect(wrap.closest(".curve-card"));
      const out = [...wrap.querySelectorAll("*")].filter((el) => el.children.length === 0
        && (el.textContent || "").trim() && el.getBoundingClientRect().right > cardRect.right + 0.5);
      lines.push("daily 出格=" + (out.length ? out.slice(0, 4).map((el) =>
        String(el.className || el.tagName).split(" ")[0] + "@" + rect(el).right.toFixed(0)).join(",") : "无"));
    }
    const plot = document.querySelector(".curve-plot");
    const isDaily = !!plot && !!plot.querySelector("[data-daily-plot]");
    if (plot) {
      const svg = plot.querySelector("svg");
      const pr = rect(plot), cr = rect(body);
      const legend = body.querySelector(".curve-legend");
      lines.push((isDaily ? "daily-plot " : "plot ") + box(plot) + " svg=" + svg.getAttribute("width") + "x" + svg.getAttribute("height")
        + " svgRight=" + (rect(svg).right - cr.right).toFixed(1) + "(相对卡片右缘，负数=留白)"
        + " 画布总高=" + (rect(legend).height + parseFloat(getComputedStyle(plot).marginTop) + rect(svg).height).toFixed(0)
        + "(Swift 235=图例18+间距6+svg211)");
      const texts = [...svg.querySelectorAll("text")];
      // 曲线那档的 y 轴带 %、每日那档的 y 轴是 human 缩号，只有靠 text-anchor 才分得开
      const xLabels = isDaily ? texts.filter((t) => t.getAttribute("text-anchor") === "middle")
        : texts.filter((t) => !/%$/.test(t.textContent));
      const xs = xLabels.map((t) => Number(t.getAttribute("x")));
      let minGap = Infinity;
      for (let i = 1; i < xs.length; i++) minGap = Math.min(minGap, xs[i] - xs[i - 1]);
      const widths = xLabels.map((t) => t.getComputedTextLength());
      lines.push("xticks n=" + xLabels.length + " minGap=" + minGap.toFixed(1)
        + " maxLabel=" + (widths.length ? Math.max(...widths).toFixed(1) : "-")
        + " 重叠=" + (xs.some((x, i) => i > 0 && x - xs[i - 1] < widths[i] + 4) ? "是" : "否")
        + " | " + xLabels.slice(0, 3).map((t) => t.textContent).join(",") + " … "
        + (xLabels.length ? xLabels[xLabels.length - 1].textContent : "-"));
      lines.push("paths=" + svg.querySelectorAll("path").length + " dots=" + svg.querySelectorAll("circle").length
        + " grid=" + svg.querySelectorAll("line").length + " legend=" + box(legend)
        + " 图例截=" + [...legend.children].map((c) => c.scrollWidth + "/" + c.clientWidth).join(","));
      if (isDaily) {
        const bars = [...svg.querySelectorAll("rect")];
        const bw = bars.map((b) => Number(b.getAttribute("width")));
        const bh = bars.map((b) => Number(b.getAttribute("height")));
        lines.push("bars=" + bars.length + " 柱宽=" + Math.min(...bw).toFixed(2) + ".." + Math.max(...bw).toFixed(2)
          + " 柱高=" + Math.min(...bh).toFixed(1) + ".." + Math.max(...bh).toFixed(1)
          + " 落底=" + bars.every((b) => Math.abs(
            Number(b.getAttribute("y")) + Number(b.getAttribute("height")) - rect(svg).height + 16) < 20));
      }
      // 未悬停时引导线与气泡必须真的不可见：只看 hidden 属性不够，
      // 作者样式里的 display 会盖掉浏览器的 [hidden]{display:none}。
      const idleGuide = plot.querySelector(".curve-guide");
      const idleBubble = plot.querySelector(".curve-bubble");
      lines.push("idle 引导线 " + (idleGuide ? "hidden=" + idleGuide.hidden + " display=" + getComputedStyle(idleGuide).display : "无(每日档不画)")
        + " 气泡 hidden=" + idleBubble.hidden + " display=" + getComputedStyle(idleBubble).display
        + " 宽=" + getComputedStyle(idleBubble).width + " 高=" + rect(idleBubble).height.toFixed(0));
      // hover：贴着左右两端与中间各放一次，验气泡夹取（macOS 的 anchor 夹在绘图区内）
      for (const [tag, x] of [["左", pr.left + 30], ["中", pr.left + pr.width / 2], ["右", pr.right - 8]]) {
        plot.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: pr.top + 40 }));
        const guide = plot.querySelector(".curve-guide");
        const bubble = plot.querySelector(".curve-bubble");
        if (bubble.hidden || getComputedStyle(bubble).display === "none") { lines.push("hover " + tag + " 未出气泡(x=" + x.toFixed(0) + ")"); continue; }
        const br = rect(bubble);
        lines.push("hover " + tag + " 气泡@" + br.left.toFixed(0) + ".." + br.right.toFixed(0)
          + " h=" + br.height.toFixed(0) + " 行=" + bubble.querySelectorAll(".curve-brow").length
          + " inPlot=" + (br.left >= pr.left - 0.5 && br.right <= pr.right + 0.5 && br.bottom <= pr.bottom + 0.5)
          + (guide ? " guide@" + guide.style.left + ".." + (pr.left + parseFloat(guide.style.left)).toFixed(0)
            + " inPlotX=" + (pr.left + parseFloat(guide.style.left) >= pr.left - 0.5
              && pr.left + parseFloat(guide.style.left) <= pr.right + 0.5) : " 无引导线")
          + " 活动截断=" + ((bact) => bact ? bact.scrollWidth + "/" + bact.clientWidth : "-")(bubble.querySelector(".curve-bact"))
          + " 气泡内截断=" + [...bubble.querySelectorAll("*")].filter((c) => c.children.length === 0)
            .map((c) => (String(c.className).split(" ")[0] || c.tagName) + ":" + c.scrollWidth + "/" + c.clientWidth).join(","));
      }
      plot.dispatchEvent(new MouseEvent("mouseleave"));
      lines.push("leave 引导线 display=" + (idleGuide ? getComputedStyle(idleGuide).display : "无")
        + " 气泡 display=" + getComputedStyle(plot.querySelector(".curve-bubble")).display);
    } else {
      lines.push("plot 空态 " + box(document.querySelector(".curve-empty, .daily-empty") || curve)
        + " 图标=" + (document.querySelector(".daily-empty svg") ? rect(document.querySelector(".daily-empty svg")).width.toFixed(0) + "x" + rect(document.querySelector(".daily-empty svg")).height.toFixed(0) : "无"));
    }
    for (const rows of document.querySelectorAll(".curve-rows")) {
      const r = rect(rows);
      lines.push("rows " + box(rows) + " cols=[" + getComputedStyle(rows).gridTemplateColumns + "]"
        + " 溢出=" + (r.right - rect(curve).right).toFixed(1)
        + " 子=" + [...rows.children].slice(0, 10).map((c) =>
          c.className.replace("curve-", "") + ":" + c.getBoundingClientRect().width.toFixed(0)
          + (c.scrollWidth > c.clientWidth + 1 ? "(裁" + c.scrollWidth + "/" + c.clientWidth + ")" : "")).join(" "));
    }
    lines.push("footnote " + box(document.querySelector(".curve-footnote")));
  }

  /** 设置页逐元素：页头、双列、section 盒、mini 控件的几何 */
  function measureSettings(lines) {
    const view = document.querySelector("#view-settings");
    if (!view || !view.classList.contains("is-active")) return;
    const head = view.querySelector(".set-head");
    lines.push("sethead " + box(head) + " | " + [...head.children].map(box).join(" | ")
      + " | 版本='" + view.querySelector("#app-version").textContent.trim() + "'"
      + " 副标题='" + view.querySelector(".set-sub").textContent.trim() + "'"
      + " 行高=" + ["\\.set-title", "\\.set-build", "\\.set-sub"].map((s) => {
        const n = view.querySelector(s);
        return getComputedStyle(n).height + "/" + getComputedStyle(n).lineHeight;
      }).join(",")
      + " 字体=" + getComputedStyle(view.querySelector("\\.set-title")).fontFamily.split(",")[0]);
    const cols = view.querySelector(".set-cols");
    lines.push("sethead 钉顶=" + getComputedStyle(head).position + "/" + getComputedStyle(head).top
      + " z=" + getComputedStyle(head).zIndex
      + " 底=" + getComputedStyle(head).backgroundColor + " 模糊=" + getComputedStyle(head).backdropFilter);
    lines.push("cols " + box(cols) + " | " + [...cols.children].map((c) => {
      return "col" + box(c).replace(/^div/, "");
    }).join(" | ") + " 右缘离窗=" + (VW - rect(cols.lastElementChild).right).toFixed(1) + "(macOS 应为 5)");
    for (const sec of view.querySelectorAll(".set-sec")) {
      const r = rect(sec);
      lines.push("sec " + sec.querySelector(".set-sec-title").textContent + " "
        + r.width.toFixed(0) + "x" + r.height.toFixed(0) + "@" + r.top.toFixed(0)
        + " 图标=" + sec.querySelector(".set-sec-ico").getBoundingClientRect().width.toFixed(0)
        + " 底=" + getComputedStyle(sec).backgroundColor + " 描边=" + getComputedStyle(sec).boxShadow
        + " 子=" + sec.querySelectorAll(".set-sec-body > *").length
        + " 右缘离窗=" + (VW - r.right).toFixed(1));
    }
    // mini 开关：macOS controlSize(.mini) 约 26×15，整页应该只有这一档尺寸
    const sws = [...view.querySelectorAll(".set-sw")];
    lines.push("switch n=" + sws.length
      + " 尺寸=" + [...new Set(sws.map((s) => rect(s).width.toFixed(0) + "x" + rect(s).height.toFixed(0)))].join(",")
      + " 开=" + sws.filter((s) => s.classList.contains("is-on")).length
      + " 滑块=" + (sws.length ? getComputedStyle(sws[0], "::after").width + "/"
        + getComputedStyle(sws[0], "::after").left : "-")
      + " 开色=" + (() => { const on = sws.find((s) => s.classList.contains("is-on")); return on ? getComputedStyle(on).backgroundColor : "无"; })());
    // 分段选择器：样式 7 段 + 信息 3 段 + 区域 2 段 +（启用久坐时）间隔 3 段
    for (const seg of view.querySelectorAll(".segmented.is-mini")) {
      const r = rect(seg);
      const segs = [...seg.children].map((b) => {
        const q = rect(b);
        return b.textContent + ":" + q.width.toFixed(0) + "x" + q.height.toFixed(0)
          + (b.scrollWidth > b.clientWidth + 1 ? "(裁" + b.scrollWidth + "/" + b.clientWidth + ")" : "");
      });
      lines.push("seg " + (seg.id || "区间") + " " + r.width.toFixed(0) + "x" + r.height.toFixed(0)
        + " 段=" + segs.join(" "));
    }
    // settingsRow 网格：34 高、色点 6、名称是否被省略号截断
    for (const grid of view.querySelectorAll(".set-tools")) {
      const rows = [...grid.children];
      const cut = rows.filter((x) => {
        const n = x.querySelector(".name");
        return n.scrollWidth > n.clientWidth + 1;
      });
      lines.push("tools " + grid.id + " 列=" + getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length
        + " 行=" + rows.length + " 高=" + [...new Set(rows.map((x) => rect(x).height.toFixed(0)))].join(",")
        + " 宽=" + [...new Set(rows.map((x) => rect(x).width.toFixed(0)))].join(",")
        + " 点=" + (rows[0] ? rect(rows[0].querySelector(".dot")).width.toFixed(0) : "-")
        + " 截断=" + (cut.length ? cut.map((x) => x.querySelector(".name").textContent).join("/") : "无"));
    }
    const stack = view.querySelector("#style-preview").closest(".set-stacked");
    lines.push("stacked " + box(stack) + " 标签=" + box(stack.querySelector(".set-stacked-label")));
    // 诊断段（PV:3497-3557）：操作条 8 距、22×22 复制圆钮、报告块 pad8/圆角6 与 lineLimit(16)
    const dBar = view.querySelector(".diag-bar");
    const dBtn = view.querySelector("#btn-diag");
    const dCopy = view.querySelector("#btn-diag-copy");
    const dSpin = view.querySelector("#diag-spin");
    const dOut = view.querySelector("#diag-out");
    const dText = dOut.querySelector(".diag-text");
    const dSum = dOut.querySelector(".diag-sum");
    lines.push("diag 条=" + box(dBar) + " 间距=" + getComputedStyle(dBar).gap
      + " 钮=" + box(dBtn) + " 文案='" + dBtn.textContent.trim() + "' 禁用=" + dBtn.disabled
      + " 钮图标=" + box(dBtn.querySelector("svg"))
      + " 转圈=" + (dSpin.hidden ? "隐" : box(dSpin))
      + " 复制=" + (dCopy.hidden ? "隐" : box(dCopy) + " 圆=" + getComputedStyle(dCopy).borderRadius)
      + " 复制图标=" + box(dCopy.querySelector("svg")));
    lines.push("diag 块=" + (dOut.hidden ? "隐" : box(dOut)
      + " 内边距=" + getComputedStyle(dOut).padding + " 圆角=" + getComputedStyle(dOut).borderRadius
      + " 列距=" + getComputedStyle(dOut).gap)
      + (dSum ? " 摘要=" + box(dSum) + " 距=" + getComputedStyle(dSum).gap
        + " chevron=" + box(dSum.querySelector(".diag-chev"))
        + " 摘要字=" + getComputedStyle(dSum.querySelector(".diag-sum-text")).fontSize
        + " 截=" + (() => { const n = dSum.querySelector(".diag-sum-text");
          return n.scrollWidth + "/" + n.clientWidth; })()
        + " 全文='" + dSum.textContent.trim().slice(0, 46) + "' 展开钮击=" + (dBtn.disabled ? "-" : "已点")
        : " 摘要=无")
      + (dText ? " 正文=" + box(dText) + " 字号=" + getComputedStyle(dText).fontSize
        + " 行高=" + getComputedStyle(dText).lineHeight
        + " 行=" + dText.textContent.split("\\n").length
        + " 高/内高=" + rect(dText).height.toFixed(0) + "/" + dText.clientHeight.toFixed(0)
        + " 溢出=" + (dText.scrollHeight > dText.clientHeight + 1 ? "16行封顶" : "无")
        : " 正文=收起"));
    // 远程采集的 copyBlock（PV:4683-4703）：pad8/圆角6/底 .04，文字四行封顶
    const cBlock = view.querySelector(".copy-block");
    const cText = cBlock.querySelector(".copy-text");
    lines.push("copy 块=" + box(cBlock) + " 内边距=" + getComputedStyle(cBlock).padding
      + " 圆角=" + getComputedStyle(cBlock).borderRadius + " 底=" + getComputedStyle(cBlock).backgroundColor
      + " 文=" + box(cText) + " 字号=" + getComputedStyle(cText).fontSize
      + " 行=" + cText.textContent.split("\\n").length
      + " 封顶=" + getComputedStyle(cText).webkitLineClamp
      + " 溢出=" + (cText.scrollHeight > cText.clientHeight + 1 ? "裁" : "无")
      + " 钮=" + box(cBlock.querySelector(".copy-btn")));
    // 链路：点过几次取数、两处复制各写进剪贴板什么（截 40 字，够比对来源就行）
    lines.push("diag 链路 取数=" + (window.__diagCalls ?? 0)
      + " 复制=" + (window.__copyText ?? []).map((s) => "'" + s + "'").join(" + "));
    lines.push("rows set-row=" + view.querySelectorAll(".set-row").length
      + " vrow=" + view.querySelectorAll(".set-vrow").length
      + " note=" + view.querySelectorAll(".set-note").length
      + " hint2='" + view.querySelector("#quota-choice-hint").textContent.trim() + "'"
      + " act=" + view.querySelectorAll(".set-act").length
      + " provider行=" + view.querySelectorAll("#provider-fields .p-row").length
      + " 分隔=" + view.querySelectorAll(".thin-div").length);
  }

  /**
   * 数据面板逐元素：hero、区间胶囊、五枚指标、巅峰日、成就网格、作息柱、
   * 模型/Provider/项目三种条、热力墙（周/月/年三档）、单日下钻卡、图例。
   */
  function measureDash(lines) {
    const view = document.querySelector("#view-dashboard");
    if (!view || !view.classList.contains("is-active")) return;
    const body = document.querySelector("#dash-body");
    const txt = (n) => (n ? String(n.textContent || "").trim() : "无");
    const cut = (n) => (n ? (n.scrollWidth > n.clientWidth + 1 ? "是" : "否") : "-");
    // 同一行里两个兄弟盒子左右相交 = 文字挤到一起了
    const overlapped = (nodes) => nodes.some((a, i) => nodes.slice(i + 1).some((b) => {
      const ra = rect(a), rb = rect(b);
      return ra.left < rb.right - 0.5 && rb.left < ra.right - 0.5 && ra.top < rb.bottom - 0.5 && rb.top < ra.bottom - 0.5;
    }));
    lines.push("dash " + box(body) + " 段=" + body.querySelectorAll("section").length
      + " 分隔=" + body.querySelectorAll(".thin-div").length
      + " 序=" + [...body.children].map((el) => String(el.className || "").split(" ")[0] || el.tagName.toLowerCase()).join(","));
    const hero = body.querySelector(".dw-hero");
    if (hero) {
      const big = hero.querySelector(".dw-big");
      const fun = hero.querySelector(".dw-fun");
      lines.push("hero " + box(hero) + " 内=" + [...hero.children].map(box).join(" | ")
        + " 大数字=" + box(big) + " 字号=" + getComputedStyle(big).fontSize
        + " 顶部相交=" + overlapped([...hero.querySelectorAll(".dw-hero-top > *")])
        + " since=" + box(hero.querySelector(".dw-since-row")) + " '" + txt(hero.querySelector(".dw-since-row")) + "'"
        + " 彩蛋 " + box(fun) + " 裁=" + cut(fun) + " '" + txt(fun) + "'");
    }
    const period = body.querySelector(".dw-period");
    if (period) {
      const caps = [...period.children];
      const active = caps.find((c) => c.classList.contains("is-active"));
      lines.push("period " + box(period) + " 胶囊=" + caps.length
        + " 宽=" + [...new Set(caps.map((c) => rect(c).width.toFixed(0)))].join(",")
        + " 高=" + [...new Set(caps.map((c) => rect(c).height.toFixed(0)))].join(",")
        + " 选中='" + txt(active) + "' 合计=" + caps.reduce((s, c) => s + rect(c).width, 0).toFixed(0)
        + " 溢出=" + (period.scrollWidth > period.clientWidth + 1 ? "是" : "否")
        + " 相交=" + overlapped(caps));
    }
    const chips = [...body.querySelectorAll(".dw-chip")];
    if (chips.length) {
      lines.push("chips " + box(chips[0].parentElement) + " 枚=" + chips.length
        + " 宽=" + [...new Set(chips.map((c) => rect(c).width.toFixed(0)))].join(",")
        + " 高=" + [...new Set(chips.map((c) => rect(c).height.toFixed(0)))].join(",")
        + " 相交=" + overlapped(chips));
      for (const c of chips) {
        const b = c.querySelector(".dw-chip-value b");
        lines.push("  chip '" + txt(c.querySelector(".dw-chip-label")) + "' 值='" + txt(b)
          + "' 档=" + (b.classList.contains("is-tighter") ? "0.60" : b.classList.contains("is-tight") ? "0.84" : "1.00")
          + " 字号=" + getComputedStyle(b).fontSize
          + " scroll/client=" + b.scrollWidth + "/" + b.clientWidth
          + " 省略=" + cut(b) + " 图标=" + (c.querySelector(".dw-chip-ic") ? "有" : "无")
          + " 盒=" + box(b));
      }
    }
    for (const p of [...body.querySelectorAll(".dw-peak")]) {
      const pr = p.querySelector(".dw-peak-projs");
      lines.push("peak " + box(p) + " 内=" + [...p.children].map(box).join(" | ")
        + " 相交=" + overlapped([...p.children])
        + " 项目=" + (pr ? box(pr) + " scroll/client=" + pr.scrollWidth + "/" + pr.clientWidth + " 裁=" + cut(pr) : "无")
        + " '" + txt(p.querySelector(".dw-peak-date")) + "/" + txt(p.querySelector(".dw-peak-tok")) + "'");
    }
    const more = body.querySelector(".dw-more");
    const achGrid = body.querySelector(".dw-ach-grid");
    if (achGrid) {
      const badges = [...achGrid.children];
      const tops = [...new Set(badges.map((b) => rect(b).top.toFixed(0)))];
      const b0 = badges[0];
      lines.push("ach " + box(achGrid) + " 行=" + tops.length + " 徽章=" + badges.length
        + " 每行=" + badges.filter((b) => rect(b).top.toFixed(0) === tops[0]).length
        + " 宽=" + [...new Set(badges.map((b) => rect(b).width.toFixed(0)))].join(",")
        + " 高=" + [...new Set(badges.map((b) => rect(b).height.toFixed(0)))].join(",")
        + " 金光=" + badges.filter((b) => b.classList.contains("is-new")).length
        + " 相交=" + overlapped(badges)
        + " 展开钮=" + (more ? box(more) + " '" + txt(more) + "'" : "无")
        + " 头=" + box(body.querySelector(".dw-ach-head")) + " 计数=" + txt(body.querySelector(".dw-count")));
      lines.push("  徽章内 " + [...b0.children].map(box).join(" | ")
        + " 名裁=" + cut(b0.querySelector("strong")) + " 说明裁=" + cut(b0.querySelector("em"))
        + " 图标=" + box(b0.querySelector(".dw-badge-ic")));
    }
    const hours = body.querySelector(".dw-hours");
    if (hours) {
      const bars = [...hours.children];
      lines.push("hours " + box(hours) + " 柱=" + bars.length
        + " 宽=" + [...new Set(bars.map((b) => rect(b).width.toFixed(0)))].join(",")
        + " 峰=" + bars.findIndex((b) => b.classList.contains("is-peak"))
        + " 高=" + bars.map((b) => rect(b).height.toFixed(0)).join(",")
        + " 轴=" + box(body.querySelector(".dw-hour-axis"))
        + " 轴内=" + [...body.querySelector(".dw-hour-axis").children].map((n) => txt(n) + ":" + rect(n).width.toFixed(0)).join(",")
        + " 高峰标签='" + txt(body.querySelector(".dw-peak-label")) + "'");
    }
    for (const sec of [...body.querySelectorAll(".dw-block")]) {
      const bars = [...sec.querySelectorAll(".stat-bar")];
      if (!bars.length) continue;
      lines.push("bars '" + txt(sec.querySelector(".dw-title")) + "' " + box(sec) + " 条=" + bars.length
        + " 宽=" + [...new Set(bars.map((b) => rect(b).width.toFixed(0)))].join(","));
      for (const bar of bars) {
        const name = bar.querySelector(".sb-name"), tok = bar.querySelector(".sb-tok");
        const cost = bar.querySelector(".sb-cost"), right = bar.querySelector(".sb-right"), fill = bar.querySelector(".sb-bar");
        lines.push("  bar '" + txt(name) + "' 名=" + rect(name).width.toFixed(0) + " 裁=" + cut(name)
          + " 右块=" + box(right) + " 数=" + txt(tok) + " 钱=" + txt(cost)
          + " 钱右沿距条右=" + (cost || tok ? (rect(bar).right - rect(cost || tok).right).toFixed(1) : "-")
          + " 相交=" + overlapped([name, right])
          + " 条=" + rect(fill).width.toFixed(0) + "/" + rect(bar).width.toFixed(0)
          + " 条高=" + rect(fill).height.toFixed(0));
      }
    }
    const eye = body.querySelector(".dw-eye-head");
    if (eye) {
      lines.push("eye " + box(eye) + " 内=" + [...eye.children].map(box).join(" | ")
        + " 相交=" + overlapped([...eye.children])
        + " 收起态=" + (body.querySelector(".dw-hidden-line") ? "'" + txt(body.querySelector(".dw-hidden-line")) + "'" : "否")
        + " 体=" + box(body.querySelector(".dw-eye-body")));
    }
    const seg = body.querySelector(".heat-seg");
    if (seg) {
      lines.push("heatseg " + box(seg) + " 档=" + [...seg.children].map((b) => txt(b) + ":" + rect(b).width.toFixed(0)
        + (b.classList.contains("is-active") ? "(选中)" : "")).join(",") + " 相交=" + overlapped([...seg.children]));
    }
    const week = body.querySelector(".heat-week");
    if (week) {
      const rows = [...week.querySelectorAll(".heat-wrow")];
      lines.push("week " + box(week) + " 行=" + rows.length
        + " 标签=" + [...week.querySelectorAll(".heat-label")].map((t) => txt(t) + ":" + rect(t).height.toFixed(0)).join(",")
        + " 列宽=" + box(week.querySelector(".heat-labels")) + " | " + box(week.querySelector(".heat-week-rows")));
      for (const r of rows) {
        const cost = r.querySelector(".heat-wcost");
        lines.push("  wrow " + box(r) + " 格=" + box(r.querySelector(".heat-wcell"))
          + " 日期=" + box(r.querySelector(".heat-wdate")) + " '" + txt(r.querySelector(".heat-wdate")) + "'"
          + " 成本=" + (cost ? box(cost) : "无") + " 相交=" + overlapped([...r.children]));
      }
    }
    const gridEl = body.querySelector(".heat-grid");
    if (gridEl) {
      const scroller = gridEl.querySelector("#heat-scroll");
      const cols = [...scroller.querySelectorAll(".heat-col")];
      const cells = [...scroller.querySelectorAll(".heat-cell")];
      const labels = gridEl.querySelector(".heat-labels");
      const last = cols[cols.length - 1];
      lines.push("heat " + box(gridEl) + " 列=" + cols.length + " 格=" + cells.length
        + " 格宽=" + [...new Set(cells.map((c) => rect(c).width.toFixed(0)))].join(",")
        + " 档=" + (cells[0].classList.contains("is-big") ? "月(20)" : "年(12)")
        + " 标签列=" + box(labels) + " 标签=" + [...labels.children].map((t) => txt(t) + ":" + rect(t).height.toFixed(0)).join(","));
      lines.push("  scroll client/scroll=" + scroller.clientWidth + "/" + scroller.scrollWidth
        + " scrollLeft=" + scroller.scrollLeft
        + " 贴右=" + (Math.abs(scroller.scrollWidth - scroller.scrollLeft - scroller.clientWidth) <= 1)
        + " 内容宽=" + rect(scroller.firstElementChild).width.toFixed(0)
        + " 列宽=" + cols.slice(0, 3).map((c) => rect(c).width.toFixed(0)).join(",")
        + " 格距=" + (cols.length > 1 ? (rect(cols[1]).left - rect(cols[0]).right).toFixed(1) : "-"));
      lines.push("  首列左=" + rect(cols[0]).left.toFixed(1) + " 标签右=" + rect(labels).right.toFixed(1)
        + " 顶对齐=" + (Math.abs(rect(cols[0]).top - rect(labels).top) <= 0.5)
        + " 末列右=" + rect(last).right.toFixed(0) + " 可视右=" + (rect(scroller).right).toFixed(0)
        + " 末列格=" + [...last.children].map((c) => rect(c).height.toFixed(0)).join(",")
        + " 选中格=" + cells.filter((c) => c.classList.contains("is-sel")).length);
    }
    const detail = body.querySelector(".heat-detail");
    if (detail) {
      const g = detail.querySelector(".hd-grid");
      const cells = [...g.children];
      const tops = [...new Set(cells.map((c) => rect(c).top.toFixed(0)))];
      lines.push("detail " + box(detail) + " 格=" + cells.length + " 行=" + tops.length
        + " 每行=" + cells.filter((c) => rect(c).top.toFixed(0) === tops[0]).length
        + " 宽=" + [...new Set(cells.map((c) => rect(c).width.toFixed(0)))].join(",")
        + " 高=" + [...new Set(cells.map((c) => rect(c).height.toFixed(0)))].join(",")
        + " 相交=" + overlapped(cells)
        + " 头=" + [...detail.querySelector(".hd-head").children].map((n) => box(n) + "('" + txt(n) + "')").join(" | "));
      for (const c of cells) {
        const nm = c.querySelector(".hd-name"), tk = c.querySelector(".hd-tok"), co = c.querySelector(".hd-cost");
        lines.push("  格 '" + txt(nm) + "' " + box(c) + " 名裁=" + cut(nm)
          + " 量=" + box(tk) + " '" + txt(tk) + "' 钱=" + (co ? box(co) + " '" + txt(co) + "'" : "无")
          + " 相交=" + overlapped([...c.children]));
      }
    }
    const legend = body.querySelector(".heat-legend");
    if (legend) {
      lines.push("legend " + box(legend) + " 项=" + [...legend.children].map((x) => box(x) + "('" + txt(x) + "')").join(" | ")
        + " 相交=" + overlapped([...legend.children]));
    }
    // 整页最宽的那一侧：文档 scrollWidth 比视口大时，用它判断是谁把宽度撑出去的
    let wide = { w: 0, el: "" };
    for (const el of body.querySelectorAll("*")) {
      const r = rect(el);
      if (r.right > wide.w) { wide = { w: r.right, el: el.tagName.toLowerCase() + "." + String(el.className || "").split(" ")[0] }; }
    }
    lines.push("page 最右=" + wide.w.toFixed(1) + " @" + wide.el
      + " 文档=" + document.documentElement.scrollWidth + " 栈=" + document.querySelector(".view-stack").scrollWidth
      + "/" + document.querySelector(".view-stack").clientWidth);
  }

  let clicked = false, acted = false, waits = 0;
  function start() {
    // 先等 boot 完成首屏渲染（模式按钮的处理器是 boot 里挂的），再切页，再等懒加载的行出现
    stage = "first-paint waits=" + waits;
    if (!document.querySelector(".card, .page-state, .chip-btn") && ++waits < 200) { setTimeout(run, 30); return; }
    if (!clicked) {
      clicked = true;
      stage = "tab-click";
      if (want.tab === "usage") document.querySelector("#btn-home").click();
      else if (want.tab) document.querySelector('[data-mode="' + want.tab + '"]').click();
      setTimeout(run, 30);
      return;
    }
    const ready = want.tab === "projects"
      ? document.querySelectorAll(".trail-row").length > 0 || document.querySelector("#trail-list .empty")
      : want.tab === "quota"
        ? document.querySelector(".curve-controls")
        // 面板页取数是异步的：#dash-body 里还挂着 .page-state 说明快照没回来，量了个寂寞
        : want.tab === "dashboard"
          ? document.querySelector("#dash-body") && !document.querySelector("#dash-body .page-state")
          : document.querySelector(".card, .page-state, .chip-btn");
    stage = "ready=" + !!ready + " waits=" + waits;
    if (!ready && ++waits < 200) { setTimeout(run, 30); return; }
    if (!acted) {
      acted = true;
      stage = "act";
      act();
      // 点跨度会重新走一次异步取数，给它一帧时间回来再量
      setTimeout(run, 60);
      return;
    }
    stage = "measure";
    measure();
  }
  function act() {
    if (want.pin) {
      const rows = [...document.querySelectorAll("[data-pin]")];
      const hit = rows.find(b => b.dataset.pin.indexOf(want.pin) >= 0) || rows[Number(want.pin) - 1];
      if (hit) hit.click();
    }
    if (want.q) {
      const input = document.querySelector("#trail-search");
      input.value = want.q;
      input.dispatchEvent(new Event("input"));
    }
    // 换区间会重建卡片，必须先把区间点到目标档，再展开「按模型」，否则点到的是上一轮的按钮
    if (want.range) {
      const seg = [...document.querySelectorAll("#range-control .seg")]
        .find(b => b.getAttribute("aria-selected") === "true");
      const target = [...document.querySelectorAll("#range-control .seg")][Number(want.range)];
      if (target && target !== seg) target.click();
    }
    // 卡头不再折叠整张卡：展开的是「按模型」披露，行还能再点开单价胶囊。
    // 每次点击都会重建卡片 DOM，静态 NodeList 里的后续节点会被摘掉，所以逐个重新查未展开的那个。
    if (want.expand !== "0") {
      for (let i = 0; i < 60; i++) {
        const b = document.querySelector('#tool-cards [data-disc][aria-expanded="false"]');
        if (!b) break;
        b.click();
      }
      if (want.deep) {
        for (let i = 0; i < 300; i++) {
          const m = document.querySelector('#tool-cards [data-model][aria-expanded="false"]');
          if (!m) break;
          m.click();
        }
      }
    }
    if (want.copy) {
      // 复制图片走的是主进程截图：桩返回 true，这里只验渲染进程的处理器与回显不报错
      document.querySelector("#btn-copy-image").click();
      const c = document.querySelector("[data-copy-tool]");
      if (c) c.click();
    }

    if (want.curveTool) {
      const b = document.querySelector('[data-curve-tool="' + want.curveTool + '"]');
      if (b) b.click();
    }
    if (want.curveSpan) {
      const b = document.querySelector('[data-curve-span="' + want.curveSpan + '"]');
      if (b) b.click();
    }
    // 周期节的两个交互：筛选只看某一个工具、展开更早的周期。点了就整节重绘，所以按 hash 顺序来
    if (want.cycleTool) {
      const b = document.querySelector('[data-cycle-tool="' + want.cycleTool + '"]');
      if (b) b.click();
    }
    if (want.cycleExpand) {
      const b = document.querySelector('[data-cycle-expand="' + want.cycleExpand + '"]');
      if (b) b.click();
    }
    // 面板页的四个交互都会重绘整块 #dash-body，顺序固定：区间 → 热力跨度 → 单日下钻 → 成就展开
    //（点热力跨度会把 selectedCell 收回，所以选格子必须在它之后）
    if (want.dashPeriod) {
      const b = document.querySelector('[data-dash-period="' + want.dashPeriod + '"]');
      if (b) b.click();
    }
    if (want.heat) {
      const b = document.querySelector('[data-heat-range="' + want.heat + '"]');
      if (b) b.click();
    }
    if (want.cell) {
      const b = document.querySelector('[data-heat-cell="' + want.cell + '"]');
      if (b) b.click();
    }
    if (want.ach) {
      const b = document.querySelector("[data-ach-toggle]");
      if (b) b.click();
    }
    // 诊断段：diag=1 只跑一次（收起态），diag=2 再点开摘要行展开全文，
    // diag=hold 让取数永不返回，用来看「检查中…」那一档的转圈与禁用态。
    // 取数是 await 的，第二击要排到下一个 tick，否则 .diag-sum 还没挂上。
    if (want.diag) {
      if (want.diag === "hold") window.__diagHold = true;
      const b = document.querySelector("#btn-diag");
      if (b) b.click();
      if (want.diag === "2") {
        setTimeout(() => {
          const s = document.querySelector(".diag-sum");
          if (s) s.click();
        }, 0);
      }
    }
    if (want.dclick) {
      // 两处「复制到剪贴板」：诊断报告全文（PV:4052）与远程采集命令（PV:4691），点一次看落点
      setTimeout(() => {
        const c = document.querySelector("#btn-diag-copy"); if (c) c.click();
        const r = document.querySelector("#btn-copy-remote"); if (r) r.click();
      }, 0);
    }
    if (want.menu) {
      const rows = [...document.querySelectorAll(".trail-row")];
      const row = want.menu === "last" ? rows[rows.length - 1] : rows[Number(want.menu) - 1] || rows[0];
      const r = row.getBoundingClientRect();
      // corner=1 时把光标放在设计尺寸的右下角，逼出菜单夹取分支
      const x = want.menu === "corner" ? VW - 4 : Math.min(r.right - 2, VW - 4);
      const y = want.menu === "corner" ? VH - 4 : Math.min(r.bottom - 2, VH - 4);
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }
    if (want.setclick) {
      // 设置页交互：样式末段、第一行卡片开关、第一行额度来源开关，只看处理器会不会抛
      document.querySelector("#style-preview .seg:last-child").click();
      document.querySelector("#tool-toggles .set-tool").click();
      document.querySelector("#quota-choice .set-tool").click();
    }
    if (want.camenu) {
      // 右键咖啡钮开菜单：corner 把光标钉在右下角，逼出夹取分支
      const b = document.querySelector("#btn-keep-awake");
      const r = b.getBoundingClientRect();
      const x = want.camenu === "corner" ? VW - 4 : r.left + 8;
      const y = want.camenu === "corner" ? VH - 4 : r.top + 4;
      b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }
    if (want.caclick) {
      // 左键开关走的是真链路：点完看桩回写的状态有没有落到文案与配色上
      document.querySelector("#btn-keep-awake").click();
    }
  }
  function run() {
    try { start(); } catch (e) {
      JS_ERRORS.push("探针异常: " + (e && e.stack || e));
      // 探针自己崩了也要留下可读的现场，否则 dump-dom 里什么都看不到
      if (!document.getElementById("probe")) {
        const pre = document.createElement("pre");
        pre.id = "probe";
        pre.textContent = "PROBE-FAIL " + (e && e.stack || String(e));
        document.body.appendChild(pre);
      }
    }
  }
  let stage = "boot";
  window.addEventListener("load", () => {
    setTimeout(run, 0);
    // 看门狗：卡在哪一步也要留现场，不然只会拿到一份没有探针的 DOM
    setTimeout(() => {
      if (document.getElementById("probe")) return;
      const pre = document.createElement("pre");
      pre.id = "probe";
      pre.textContent = "PROBE-TIMEOUT stage=" + stage + " waits=" + waits
        + " cards=" + document.querySelectorAll(".card").length
        + " errors=" + JS_ERRORS.join(" ; ");
      document.body.appendChild(pre);
    }, 8000);
  });
})();
</script>`;

const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8")
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");

function docFor(vw, curveFrames, detail, settings, pay, hash, dash) {
  // 节日角标看的是本机日历，测量台得把「今天几号」钉住才量得到那一枚 emoji
  const fest = /festive=([0-9]+-[0-9]+-[0-9]+)/.exec(hash || "");
  // 面板页同理：热力墙与周条按渲染时的 new Date() 往前铺格子，快照里的数据止于哪天就得把
  // 「今天」钉到哪天，否则 7 天/371 天全是空档，量不到任何颜色档位。
  const pin = fest || /(?:#|&)today=([0-9]+-[0-9]+-[0-9]+)/.exec(hash || "");
  const shim = !pin ? "" : `<script>(()=>{const p=${JSON.stringify(pin[1].split("-"))};const D=Date;`
    + `class F extends D{constructor(...a){if(!a.length)super(+p[0],+p[1]-1,+p[2],12,0,0);else super(...a);}`
    + `static now(){return new F(+p[0],+p[1]-1,+p[2],12,0,0).getTime();}}window.Date=F;})()</script>`;
  // 「隐藏项目排行」在 macOS 是 @AppStorage，渲染进程 boot 时读 localStorage，所以要在 app.js 之前种进去
  const seed = /(?:#|&)hide=1/.test(hash || "")
    ? `<script>(()=>{localStorage.setItem("hideProjects","1");})()</script>` : "";
  // 一次性动画（徽章金光/弹入、加载圈）在 --dump-dom 的虚拟时间里停在首帧，
  // scale(.7) 会把盒量小，量的就不是布局尺寸了；noanim=1 的档位一律把动画冻结到终态。
  const noanim = /(?:#|&)noanim=1/.test(hash || "") ? `<style>*,*::before,*::after{animation:none!important}</style>` : "";
  const doc = html
    // headless Edge 把窗口宽度夹到 ~492，所以直接按面板这一页的真实尺寸固定 html
    .replace("<head>", `<head><style>html{width:${vw}px;height:640px;overflow:hidden}</style>`)
    .replace("<head>", `<head>${noanim}`)
    .replace("<head>", `<head><base href="file:///${RENDERER}/">`)
    .replace('<script src="app.js"></script>',
      `${shim}${seed}${STUB(curveFrames, detail, vw, settings, pay, dash)}<script src="file:///${RENDERER}/app.js"></script>${PROBE(vw)}`);
  if (!doc.includes("window.tokei")) throw new Error("注入失败");
  return doc;
}

const WIDE = 640, MID = 420, NARROW = 322;
const cases = [
  // 用量页：可见卡片 >2 走 640 双列，≤2 走 322 单列（对应 useWide / pageWidth）
  ["usage-year", "#tab=usage&range=5&deep=1", WIDE, SETTINGS],
  ["usage-year-lean", "#tab=usage&range=5&deep=1", NARROW, LEAN],
  ["usage-year-nodisc", "#tab=usage&range=5&expand=0", WIDE, SETTINGS],
  ["usage-today", "#tab=usage&range=0", WIDE, SETTINGS],
  ["usage-festive", "#tab=usage&range=0&festive=2026-10-31", WIDE, SETTINGS],
  ["usage-today-lean", "#tab=usage&range=0", NARROW, LEAN],
  ["usage-copy", "#tab=usage&range=5&copy=1&expand=0", WIDE, SETTINGS],
  // 防休眠：footer 咖啡钮的三种状态 + 右键菜单（含右下角夹取）+ 左键开关
  ["usage-ka-on", "#tab=usage&range=0&ka=on", WIDE, SETTINGS],
  ["usage-ka-timed", "#tab=usage&range=0&ka=15", WIDE, SETTINGS],
  ["usage-ka-click", "#tab=usage&range=0&caclick=1", WIDE, SETTINGS],
  ["usage-ka-menu", "#tab=usage&range=0&ka=15&camenu=1", WIDE, SETTINGS],
  ["usage-ka-menu-corner", "#tab=usage&range=0&kamode=1&kaguard=0&camenu=corner", WIDE, SETTINGS],
  // 322 窄页：footer 多了咖啡钮以后要确认 disclaimer 与各钮都还在 292 内
  ["usage-ka-lean", "#tab=usage&range=0&ka=15", NARROW, LEAN],
  ["usage-ka-menu-lean", "#tab=usage&range=0&camenu=corner", NARROW, LEAN],
  // 合成 Codex 额度：Reserve 行 / Reserve 按模型 / 重置卡披露在本机没有真实数据，只能人工喂一份量几何
  ["usage-codex-quota", "#tab=usage&range=0", WIDE, SETTINGS, "fresh"],
  ["usage-codex-quota-lean", "#tab=usage&range=0", NARROW, LEAN, "fresh"],
  ["usage-codex-stale", "#tab=usage&range=5", NARROW, LEAN, "stale"],
  // 合成 Grok 额度：分产品占用行（grokProductShareRow）与「周期已翻篇」两条分支
  ["usage-grok-share", "#tab=usage&range=0", WIDE, SETTINGS, "grok"],
  ["usage-grok-share-lean", "#tab=usage&range=0", NARROW, LEAN_GROK, "grok"],
  ["usage-grok-ended", "#tab=usage&range=0", NARROW, LEAN_GROK, "grokend"],
  ["usage-grok-ended-wide", "#tab=usage&range=0", WIDE, SETTINGS, "grokend"],
  // 合成千问办公额度：团队共享资源包 + 明细 + 两条有效期行
  ["usage-qwen-quota", "#tab=usage&range=0", WIDE, SETTINGS, "qwen"],
  ["usage-qwen-lean", "#tab=usage&range=0", NARROW, LEAN_QWEN, "qwen"],
  ["usage-qwen-stale", "#tab=usage&range=0", NARROW, LEAN_QWEN, "qwenstale"],
  // 合成 Provider 额度：plan 胶囊 + 账号、未知窗口、14 条明细（只画前 12）、stale 落款
  ["usage-provider-quota", "#tab=usage&range=0", WIDE, SETTINGS, "provider"],
  ["usage-provider-lean", "#tab=usage&range=0", NARROW, LEAN_PROVIDER, "provider"],
  ["usage-provider-stale", "#tab=usage&range=0", NARROW, LEAN_PROVIDER, "providerstale"],
  ["quota", "#tab=quota", WIDE, SETTINGS],
  ["quota-1h", "#tab=quota&curveSpan=1", WIDE, SETTINGS],
  ["quota-6h", "#tab=quota&curveSpan=6", WIDE, SETTINGS],
  ["quota-week", "#tab=quota&curveSpan=168", WIDE, SETTINGS],
  ["quota-codex", "#tab=quota&curveTool=codex", WIDE, SETTINGS],
  ["quota-codex-week", "#tab=quota&curveTool=codex&curveSpan=168", WIDE, SETTINGS],
  ["quota-empty", "#tab=quota&curve=empty", WIDE, SETTINGS],
  ["quota-narrow", "#tab=quota", MID, SETTINGS],
  // 周额度周期卡：三个工具各一块（claude 12 条历史压展开、codex 无 used_pct、grok 无当前周期）
  ["quota-cycle-claude", "#tab=quota&cycleTool=claude", WIDE, SETTINGS],
  ["quota-cycle-grok", "#tab=quota&cycleTool=grok", WIDE, SETTINGS],
  ["quota-cycle-expand", "#tab=quota&cycleExpand=claude", WIDE, SETTINGS],
  ["quota-cycle-onedev", "#tab=quota&detail=onedev&cycleExpand=codex", WIDE, SETTINGS],
  // 详情还没落盘（首次构建前）与三工具都切不出周期：占位 58 高 + 三条缺失提示
  ["quota-detail-none", "#tab=quota&detail=none", WIDE, SETTINGS],
  ["quota-detail-nocycles", "#tab=quota&detail=nocycles", WIDE, SETTINGS],
  ["quota-cycles-narrow", "#tab=quota&cycleExpand=claude", MID, SETTINGS],
  // 1月 / 1年：整段换成按天聚合的真实 token 消耗，跨度选择器从 4 档变 6 档
  ["quota-month", "#tab=quota&curveSpan=720", WIDE, SETTINGS],
  ["quota-year", "#tab=quota&curveSpan=8760", WIDE, SETTINGS],
  ["quota-year-nodaily", "#tab=quota&curveSpan=8760&detail=nodaily", WIDE, SETTINGS],
  ["quota-month-narrow", "#tab=quota&curveSpan=720", MID, SETTINGS],
  // 设置页：macOS 只有 640 一档宽度（settingsPanelWidth），304.5 双列；
  // settings-narrow 是人为压到 420 的压力档，右列必然出格，只看不判。
  ["settings", "#tab=settings", WIDE, SETTINGS],
  ["settings-sit", "#tab=settings", WIDE, SETTINGS_SIT],
  ["settings-quota-all", "#tab=settings", WIDE, SETTINGS_QUOTA_ALL],
  ["settings-quota-none", "#tab=settings", WIDE, SETTINGS_QUOTA_NONE],
  ["settings-click", "#tab=settings&setclick=1", WIDE, SETTINGS],
  ["settings-narrow", "#tab=settings", MID, SETTINGS],
  // 诊断段两态：diag=1 跑完停在收起态（只有摘要行），diag=2 再点摘要行展开全文（16 行封顶）
  ["settings-diag", "#tab=settings&diag=1", WIDE, SETTINGS],
  ["settings-diag-open", "#tab=settings&diag=2", WIDE, SETTINGS],
  ["settings-diag-narrow", "#tab=settings&diag=2", MID, SETTINGS],
  // 在跑的那一档（转圈+禁用）与两处复制的落点
  ["settings-diag-hold", "#tab=settings&diag=hold", WIDE, SETTINGS],
  ["settings-diag-copy", "#tab=settings&diag=1&dclick=1", WIDE, SETTINGS],
  ["projects", "#tab=projects&strict=1", WIDE, SETTINGS],
  ["projects-mid", "#tab=projects&strict=1", MID, LEAN],
  ["projects-pin", "#tab=projects&pin=demo&strict=1", MID, LEAN],
  ["projects-query", "#tab=projects&q=erp&strict=1", MID, LEAN],
  ["projects-nomatch", "#tab=projects&q=zzzz&strict=1", MID, LEAN],
  ["projects-menu", "#tab=projects&menu=1&strict=1", MID, LEAN],
  ["projects-corner", "#tab=projects&menu=corner&strict=1", MID, LEAN],
  // 数据面板：真档位只有 640（可见工具>2）与 420（≤2）两档——pageWidth 对 dashboard 取
  // max(panelWidth,420)，322 在这一页出现不了。today 钉到数据末日，热力墙才有颜色可量。
  ["dashboard", `#tab=dashboard&today=${DASH_LAST}&noanim=1&strict=1`, WIDE, SETTINGS, null, DASH],
  ["dashboard-lean", `#tab=dashboard&today=${DASH_LAST}&noanim=1&strict=1`, MID, LEAN, null, DASH],
  ["dashboard-full", `#tab=dashboard&today=${DASH_LAST}&noanim=1&strict=1`, WIDE, SETTINGS, null, DASH_FULL],
  ["dashboard-full-lean", `#tab=dashboard&today=${DASH_LAST}&noanim=1&strict=1`, MID, LEAN, null, DASH_FULL],
  // 热力三档 + 单日下钻 + 成就展开 + 收起项目排行 + 区间换档
  ["dashboard-week", `#tab=dashboard&today=${DASH_LAST}&noanim=1&strict=1&heat=0`, WIDE, SETTINGS, null, DASH_FULL],
  ["dashboard-month", `#tab=dashboard&today=${DASH_LAST}&noanim=1&strict=1&heat=1`, WIDE, SETTINGS, null, DASH_FULL],
  ["dashboard-cell", `#tab=dashboard&today=${DASH_LAST}&noanim=1&strict=1&cell=${DASH_LAST}`, WIDE, SETTINGS, null, DASH_FULL],
  ["dashboard-cell-lean", `#tab=dashboard&today=${DASH_LAST}&noanim=1&strict=1&cell=${DASH_LAST}`, MID, LEAN, null, DASH_FULL],
  ["dashboard-ach", `#tab=dashboard&today=${DASH_LAST}&noanim=1&strict=1&ach=1`, WIDE, SETTINGS, null, DASH_FULL],
  ["dashboard-hide", `#tab=dashboard&today=${DASH_LAST}&noanim=1&strict=1&hide=1`, WIDE, SETTINGS, null, DASH_FULL],
  ["dashboard-1d", `#tab=dashboard&today=${DASH_LAST}&noanim=1&strict=1&dashPeriod=1d`, WIDE, SETTINGS, null, DASH_FULL],
  ["dashboard-zero", `#tab=dashboard&today=${DASH_ZERO_ISO}&noanim=1&strict=1&dashPeriod=1d`, WIDE, SETTINGS, null, DASH_ZERO],
];
for (const [name, hash, vw, settings, variant, dash] of cases) {
  const frames = /curve=empty/.test(hash) ? CURVE_EMPTY : CURVE;
  const detail = /detail=none/.test(hash) ? null
    : /detail=onedev/.test(hash) ? DETAIL_ONE_DEV
    : /detail=nocycles/.test(hash) ? DETAIL_NO_CYCLES
    : /detail=nodaily/.test(hash) ? DETAIL_NO_DAILY
    : DETAIL;
  const syn = {
    fresh: PAYLOAD_CODEX, stale: PAYLOAD_CODEX_STALE,
    grok: PAYLOAD_GROK, grokend: PAYLOAD_GROK_ENDED, qwen: PAYLOAD_QWEN,
    qwenstale: PAYLOAD_QWEN_STALE,
    provider: PAYLOAD_PROVIDER, providerstale: PAYLOAD_PROVIDER_STALE,
  };
  const pay = variant ? syn[variant] : (dash === DASH_FULL ? PAYLOAD_GROKBOT : payload);
  if (!pay) throw new Error("未知合成变体 " + variant);
  const file = path.join(__dirname, `panel-${name}.html`);
  fs.writeFileSync(file, docFor(vw, frames, detail, settings, pay, hash, dash).replace(/location\.hash/g, JSON.stringify(hash)));
  console.log(`${file}  vw=${vw} payload tools=${Object.keys(pay).length} trail=${TRAIL.length} cycles=${detail ? detail.cycles.length : 0}`);
}

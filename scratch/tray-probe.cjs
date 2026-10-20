/**
 * 托盘出图取证：用真实的 config.json + last_usage.json 走一遍主进程那套判定，
 * 看七档样式各自画出来的是什么、有没有两档完全相同（脚本不落盘、不改配置）。
 */
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const root = path.resolve(__dirname, "..");
const S = require(path.join(root, "dist/main/settings.js"));
const T = require(path.join(root, "dist/main/trayIcon.js"));
const fs = require("fs");

const settings = S.loadSettings();
const payload = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".tokei/last_usage.json"), "utf8"));

// 1) 额度来源：默认值与实存值各是什么
const on = S.QUOTA_SOURCE_ORDER.filter((id) => S.quotaSourceEnabled(settings, id));
console.log("menu_quota_enabled 实存 =", JSON.stringify(settings.menu_quota_enabled));
console.log("按默认/存储判定为开的来源 =", on.join(",") || "(无)");

// 2) 复刻 quotaMetrics：读数（过期也占位）+ 重置「—」+ 今日总量兜底
function reading(id) {
  const c = payload.claude ?? {}, x = payload.codex ?? {}, k = payload.kimicode ?? {}, g = payload.grok ?? {};
  const pick = (used, stale) => (typeof used === "number" && Number.isFinite(used) ? { used, stale: !!stale } : null);
  return { claude5h: pick(c.q5, c.q5_stale), claudeWeek: pick(c.q7, c.q7_stale), claudeFable: pick(c.qf, c.qf_stale),
    codex5h: pick(x.p5, x.p5_stale), codexWeek: pick(x.pw, x.pw_stale), kimi5h: pick(k.p5, k.p5_stale),
    kimiSubscription: pick(k.pw, k.pw_stale), grok: pick(g.pct, g.stale) }[id];
}
const RESET_META = { claude5h: "claude.q5_reset", claudeWeek: "claude.q7_reset", claudeFable: "claude.qf_reset",
  codex5h: "codex.r5", codexWeek: "codex.rw", kimi5h: "kimicode.r5", kimiSubscription: "kimicode.rw", grok: "grok.reset" };
function resetOf(id) {
  const [node, key] = RESET_META[id].split(".");
  const raw = (payload[node] ?? {})[key];
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") { const n = Number(raw); if (Number.isFinite(n)) return n; const t = Date.parse(raw); return Number.isNaN(t) ? null : t / 1000; }
  return null;
}
const WINDOW = { claude5h: "hour", claudeWeek: "week", claudeFable: "week", codex5h: "hour",
  codexWeek: "week", kimi5h: "hour", kimiSubscription: null, grok: null };
const metrics = [];
for (const id of S.QUOTA_SOURCE_ORDER) {
  if (!S.quotaSourceEnabled(settings, id)) continue;
  const r = reading(id);
  if (!r) continue;
  if (r.stale && resetOf(id) !== null && resetOf(id) <= Date.now() / 1000) {
    metrics.push({ source: id, remaining: null, value: "—", color: "#888", window: WINDOW[id], stale: true });
    continue;
  }
  metrics.push({ source: id, remaining: 100 - r.used, value: String(Math.round(100 - r.used)),
    color: "#888", window: WINDOW[id], stale: r.stale });
}
let todayTokens = 0;
for (const [tool, v] of Object.entries(payload)) {
  if (tool.startsWith("_") || !v || !v.ranges || !v.ranges.today) continue;
  const t = v.ranges.today;
  todayTokens += (t.in || 0) + (t.out || 0) + (t.cr || 0) + (t.cw || 0);
}
console.log("有读数的来源 =", metrics.length, "| 今日 token 总量 =", todayTokens);
for (const m of metrics) console.log("  ", m.source, "值=" + m.value, "剩=" + m.remaining, "失真=" + !!m.stale, "窗口=" + m.window);
if (!metrics.length && on.length && todayTokens > 0) metrics.push({ source: "total", remaining: null, value: "0", color: "#777", window: null });

// 3) 七档样式 × 三档信息量，各自出图指纹
const theme = { text: "#dddddd", separator: "#8a8a8a", glyph: "#ffffff", background: null };
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
for (const density of ["full", "lowest", "icon"]) {
  const rows = ["system", "color", "symbols", "dots", "compact", "artistic", "palm"].map((style) => {
    const svg = T.traySvg({ style, density, metrics, keepAwake: false, scaleFactor: 1, theme });
    return `${style}=${hash(svg)}/${svg.match(/width="([\d.]+)"/)[1]}w`;
  });
  console.log(density.padEnd(7), rows.join(" "));
}
// 同一份图重跑一次，确认判定是幂等的（排除随时间/随机量作怪）
const again = T.traySvg({ style: "symbols", density: "full", metrics, keepAwake: false, scaleFactor: 1, theme });
console.log("symbols 重跑一致 =", again === T.traySvg({ style: "symbols", density: "full", metrics, keepAwake: false, scaleFactor: 1, theme }));

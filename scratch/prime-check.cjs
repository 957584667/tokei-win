/**
 * 开机垫快照的取证：拿真实的 ~/.tokei/last_usage.json 走一遍 loadCachedUsage()，
 * 看内部键剥没剥干净、Claude 那三路额度的过期标记按「现在」重算成了什么。
 * 只读，不落盘、不改任何真实文件。
 */
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const U = require(path.join(root, "dist/main/usageCache.js"));
const M = require(path.join(root, "dist/core/model.js"));
const S = require(path.join(root, "dist/main/settings.js"));
const line = (label, value) => console.log(`${label}${value}`);

const file = U.LAST_USAGE_FILE;
const bytesBefore = fs.readFileSync(file);
const raw = JSON.parse(bytesBefore.toString("utf8"));
const primed = U.loadCachedUsage(file);
const bytesAfter = fs.readFileSync(file);

line("快照文件：", `${file} ${bytesBefore.length}B，mtime ${fs.statSync(file).mtime.toISOString()}`);
line("P1 磁盘那份的下划线键：", Object.keys(raw).filter((k) => k.startsWith("_")).join(",") || "(无)");
line("P2 读回来的键：", Object.keys(primed).join(",") || "(无)");
line("P3 _ok/_at 是否已剥掉：", primed._ok === undefined && primed._at === undefined ? "是" : "否");

const claude = raw.claude ?? {};
const after = primed.claude ?? {};
const age = Math.floor(Date.now() / 1000) - Number(claude.q_updated ?? 0);
line("P4 claude.q_updated 距今：", `${age} 秒（TTL 1800 秒）`);
for (const key of ["q5", "q7", "qf"]) {
  const value = claude[key];
  line(`P5 ${key}：`, `${typeof value === "number" ? `值 ${value}` : "无值"}，reset=${claude[`${key}_reset`]}，`
    + `磁盘 stale=${claude[`${key}_stale`]} → 读回来 stale=${after[`${key}_stale`]}、值=${after[key] === undefined ? "无" : after[key]}`);
}

// 托盘在这一份垫底后能出几档：复刻 quotaMetrics 的「有数值才占位」判定
const windows = [["claude", ["q5", "q7", "qf"]], ["codex", ["p5", "pw"]], ["kimicode", ["p5", "pw"]], ["grok", ["pct"]]];
const count = windows.reduce((sum, [node, keys]) => sum + keys.filter((k) => typeof (primed[node] ?? {})[k] === "number").length, 0);
line("P6 垫上后可占位的额度窗口：", `${count} 档（payload 为 null 时托盘只画省略号）`);

// 额度窗口一个都没有时托盘落到今日总量（index.ts:319-325）；这里按 summarize 同一套算法
// （跳过 `_` 键与被关掉的工具、用 displayTokenTotal）把垫上那份的数字算出来。
const disabled = new Set(S.loadSettings().disabled_tools ?? []);
let tokens = 0;
for (const [key, node] of Object.entries(primed)) {
  if (key.startsWith("_") || disabled.has(key)) continue;
  const r = node && node.ranges ? node.ranges.today : null;
  if (r) tokens += M.displayTokenTotal(r, key);
}
line("P7 今日总量兜底的数字：", `${tokens} tokens（不垫快照时这一档拿到的是 null，托盘画「…」）`);
line("P8 读过后文件是否一字未动：", bytesBefore.equals(bytesAfter) ? "是" : "否");

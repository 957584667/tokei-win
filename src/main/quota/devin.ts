/**
 * Devin 额度：对应 usage.30s.py 的 7503-7705。
 *
 * Devin.app 是改名后的 Windsurf 编辑器，本质是一个 VS Code fork，因此它的
 * globalStorage 就是一个普通 SQLite 文件（state.vscdb），账号最近一次读到的
 * 套餐是其中一行。不需要任何凭据、不联网、不写盘。
 * 键名仍叫 windsurf.*：bundle id 没跟着产品名改。
 *
 * 读数的落款是「那次启动」而不是抓取时刻：这一行只在启动时写入，运行中不刷新，
 * 所以用 logs/ 下启动目录名给它落款，超过 10 分钟按快照展示（stale），
 * 超过一天没重启过就干脆不展示——解法是打开 Devin，那会写入新的一行。
 */
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { APPDATA, HOME, isFile, pathCandidates } from "../../core/paths";
import {
  epochSeconds, providerEpoch, providerMoney, providerNumber, providerQuotaEnabled,
  providerWindow,
} from "../../core/providerQuota";
import { QuotaDeps } from "./context";

// node:sqlite 在 Node 22 是实验内置模块、不在 builtinModules 清单里，
// vitest/vite 的静态导入解析会失败，故运行时经 createRequire 获取构造器
const { DatabaseSync: DatabaseSyncCtor } = createRequire(path.join(process.cwd(), "noop.cjs"))("node:sqlite") as typeof import("node:sqlite");

/** 对应 _DEVIN_PLAN_KEY_PATTERNS：先精确的 reactSettings，再退到旧的 settings 键 */
const DEVIN_PLAN_KEY_PATTERNS = [
  "windsurf.reactSettings.cachedPlanInfoData%",
  "windsurf.settings.cachedPlanInfo%",
];
/** 对应 _DEVIN_SNAPSHOT_FRESH：10 分钟内的启动读数算实时 */
const DEVIN_SNAPSHOT_FRESH = 10 * 60;
/** 对应 _DEVIN_SNAPSHOT_MAX_AGE：超过一天没重启，这行数据不再展示 */
const DEVIN_SNAPSHOT_MAX_AGE = 24 * 60 * 60;

/** 对应 DEVIN_SUPPORT_DIRS：macOS 候选之后是 Windows（%APPDATA%）与 .config */
function devinSupportCandidates(): string[] {
  return pathCandidates("TOKEI_DEVIN_SUPPORT",
    path.join(HOME, "Library", "Application Support", "Devin"),
    path.join(HOME, "Library", "Application Support", "Windsurf"),
    path.join(APPDATA, "Devin"),
    path.join(APPDATA, "Windsurf"),
    path.join(HOME, ".config", "Devin"),
    path.join(HOME, ".config", "Windsurf"));
}

/** 对应 _devin_support_dir：含 state.vscdb 的支持目录，取修改时间最新的一个 */
export function devinSupportDir(): string | null {
  let best: [number, string] | null = null;
  for (const root of devinSupportCandidates()) {
    if (!isFile(path.join(root, "User", "globalStorage", "state.vscdb"))) continue;
    let stamp = 0;
    try {
      stamp = fs.statSync(root).mtimeMs;
    } catch {
      // 目录在枚举间隙消失：与原版一致按 0 处理，仍可能作为最旧候选胜出
    }
    if (!best || stamp > best[0]) best = [stamp, root];
  }
  return best ? best[1] : null;
}

/**
 * 对应 _devin_launch_stamp：logs/ 下每次运行建一个目录，目录名就是启动时刻
 * （本地时区）：20260914T092003。
 *
 * 用目录名而不是目录的修改时间：修改时间会往后跑——在已有文件里追加不动它，
 * 但会话进行一小时后新建的日志文件会把它顶上去，顶上去多少分钟，卡片就把
 * 这份自启动起就没变过的读数少算多少分钟。
 *
 * 返回 epoch 秒（原版的 datetime.astimezone() 即本地时刻）。
 */
export function devinLaunchStamp(name: unknown): number | null {
  if (typeof name !== "string" || name.length !== 15) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(name);
  if (!m) return null;
  // Date 会把 13 月 32 日滚动成合法日期，所以解析后要按同格式回写比对，
  // 与 Python 的 strftime 回环校验等价
  const parsed = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]));
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const rendered = `${pad(parsed.getFullYear(), 4)}${pad(parsed.getMonth() + 1)}${pad(parsed.getDate())}`
    + `T${pad(parsed.getHours())}${pad(parsed.getMinutes())}${pad(parsed.getSeconds())}`;
  if (rendered !== name) return null;
  const seconds = Math.floor(parsed.getTime() / 1000);
  return Number.isFinite(seconds) ? seconds : null;
}

/** 对应 _devin_last_launch：logs/ 下目录名解析出的最晚一次启动 */
export function devinLastLaunch(support: string): number | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(support, "logs"));
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const name of entries) {
    if (!fs.existsSync(path.join(support, "logs", name))) continue;
    try {
      if (!fs.statSync(path.join(support, "logs", name)).isDirectory()) continue;
    } catch {
      continue;
    }
    const stamp = devinLaunchStamp(name);
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return newest;
}

/**
 * 对应 _devin_plan：返回 [套餐, 本机账号行数]。
 *
 * 一台机器上登录过两个账号就会有两行，而文件里没有任何字段说明哪个是当前的。
 * 取 endTimestamp 最远的一行：还在订阅期内的套餐优先于已过期的。
 * 只读打开（readOnly + query_only），与原版 mode=ro 等价；任何打开或查询
 * 失败都按没有套餐处理。
 */
export function devinPlan(dbPath: string): [Record<string, any> | null, number] {
  let found: Array<{ key: unknown; value: unknown }> = [];
  let conn: DatabaseSync | null = null;
  try {
    conn = new DatabaseSyncCtor(dbPath, { readOnly: true });
    conn.exec("PRAGMA query_only=ON");
    for (const pattern of DEVIN_PLAN_KEY_PATTERNS) {
      const rows = conn.prepare("SELECT key, value FROM ItemTable WHERE key LIKE ?")
        .all(pattern) as Array<{ key: unknown; value: unknown }>;
      if (rows.length) { found = rows; break; }
    }
  } catch {
    return [null, 0];
  } finally {
    try { conn?.close(); } catch { /* 已经读完了，关不掉就算了 */ }
  }

  let best: [number, Record<string, any>] | null = null;
  let parsedRows = 0;
  for (const row of found) {
    let value = row.value;
    if (value instanceof Uint8Array) {
      // 原版在此 decode utf-8 失败就跳过；JS 的 toString 会用替换字符兜底，
      // 非法字节几乎必然让下面的 JSON.parse 失败，殊途同归
      value = Buffer.from(value).toString("utf8");
    }
    if (typeof value !== "string") continue;
    let plan: unknown;
    try {
      plan = JSON.parse(value);
    } catch {
      continue;
    }
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) continue;
    parsedRows += 1;
    const end = providerNumber((plan as Record<string, any>).endTimestamp) ?? 0;
    if (!best || end > best[0]) best = [end, plan as Record<string, any>];
  }
  return best ? [best[1], parsedRows] : [null, parsedRows];
}

/**
 * 对应 _devin_plan_number：布尔值也是数字类型的一种，True 会被读成 1。
 * hideDailyQuota 走到这里会变成 1%，所以布尔一律不当数字。
 */
function devinPlanNumber(plan: Record<string, any>, field: string): number | null {
  const value = plan[field];
  return typeof value === "boolean" ? null : providerNumber(value);
}

/** 对应 f"{int(v):,}"：向零取整 + 英文千分位 */
function thousands(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

/**
 * 对应 _normalize_devin_plan：一行缓存的套餐在 now 时刻意味着什么。
 *
 * 没有可信落款的快照不展示，而不是拿抓取时刻替它落款：数据库自身的修改时间
 * 被文件里其它每一个键刷新着，早餐时读到的数会显示成一秒前的。
 *
 * launchedAt / now 都是 epoch 秒；now 由调用方传入（Windows 化：让单测能钉住
 * 「现在」，原版取 datetime.now()）。
 */
export function normalizeDevinPlan(
  plan: Record<string, any>, launchedAt: number | null | undefined,
  now?: number, accounts = 1,
): Record<string, any> {
  const nowS = Math.trunc(now ?? epochSeconds());
  const launched = typeof launchedAt === "number" ? Math.trunc(launchedAt) : null;
  if (launched === null || launched > nowS || nowS - launched > DEVIN_SNAPSHOT_MAX_AGE) return {};

  const windows: ReturnType<typeof providerWindow>[] = [];
  // Devin 自己同时给出两个百分比和两个重置时刻，所以 used = 100 - remaining，
  // 窗口长度也用它真的给了的那个，没有一处是推算出来的。
  for (const [field, resetField, hideField, windowId, title, minutes] of [
    ["dailyRemainingPercent", "dailyResetAtUnix", "hideDailyQuota", "devin-daily", "日额度", 1440],
    ["weeklyRemainingPercent", "weeklyResetAtUnix", "hideWeeklyQuota", "devin-weekly", "周额度", 10080],
  ] as const) {
    if (plan[hideField]) continue;
    const remaining = devinPlanNumber(plan, field);
    if (remaining === null) {
      // 不报日额度的套餐就不画这个环，而不是画一个满环。
      continue;
    }
    const reset = providerEpoch(plan[resetField]);
    // 重置时刻已经过去的窗口直接丢掉而不是继续挂着：那个数字属于一个
    // 已经不存在的窗口。另一个窗口和余额（本来就没有重置）照常保留。
    if (reset !== null && reset <= nowS) continue;
    windows.push(providerWindow(windowId, title, 100 - remaining, reset, minutes));
  }

  // 免费套餐给的是一池消息数。-1 是付费套餐表示「不适用」的写法，不是计数，
  // 按计数读会画出「负一分之负一」，所以任一端为负都按没有这项处理。
  const total = devinPlanNumber(plan, "totalMessages");
  const remainingMessages = devinPlanNumber(plan, "remainingMessages");
  if (total !== null && remainingMessages !== null && total > 0 && remainingMessages >= 0) {
    windows.push(providerWindow(
      "devin-messages", "消息额度",
      (total - remainingMessages) / total * 100, null, null,
      `剩余 ${thousands(remainingMessages)} / ${thousands(total)} 条`));
  }

  const details: Array<Record<string, string>> = [];
  // 字段名就写了是 micros：10,000,000 即十美元。
  const balance = devinPlanNumber(plan, "overageBalanceMicros");
  if (balance !== null) {
    details.push({ label: "超额余额", value: providerMoney(balance / 1_000_000) ?? "" });
  }
  if (accounts > 1) {
    details.push({ label: "本机账号", value: `${accounts} 个`, secondary: "取订阅期最长的一个" });
  }

  if (!windows.length && !details.length) return {};

  const rawPlan = plan.planName;
  const planName = typeof rawPlan === "string" && rawPlan.trim() ? rawPlan.trim() : null;
  // 这一行自己带了人类可读的账号（实测形如 "someone@example.com - My Team"），
  // 比键里那串 user-<32 hex> 有用得多；没有就留空，不拿那串 id 顶上。
  const rawAccount = plan.accountIdentityText;
  const account = typeof rawAccount === "string" && rawAccount.trim() ? rawAccount.trim() : null;
  return {
    available: true,
    plan: planName ? `Devin ${planName}` : null,
    account,
    windows,
    details,
    source: "devin-app-cache",
    updated: launched,
    stale: nowS - launched > DEVIN_SNAPSHOT_FRESH,
  };
}

/** 对应 fetch_devin_quota */
export function fetchDevinQuota(deps: QuotaDeps): Record<string, any> {
  const support = devinSupportDir();
  if (!support) return {};
  const [plan, accounts] = devinPlan(
    path.join(support, "User", "globalStorage", "state.vscdb"));
  if (!plan) return {};
  return normalizeDevinPlan(plan, devinLastLaunch(support), Math.trunc(deps.now()), accounts);
}

/** 对应 scan_devin_quota：默认开启（本地读数，不联网） */
export function scanDevinQuota(deps: QuotaDeps): Record<string, any> {
  if (!providerQuotaEnabled("devin", deps)) return {};
  return fetchDevinQuota(deps);
}

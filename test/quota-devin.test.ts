/**
 * Devin 扫描器单测：用 node:sqlite 造真的 state.vscdb，经 TOKEI_DEVIN_SUPPORT 指到
 * 临时目录。不发任何请求、不写真实 ~/.tokei。
 * 覆盖：完整套餐归一化、启动落款（fresh/stale/超龄/无效名）、双账号取最长订阅、
 * 旧键兜底、BLOB 解码、多目录取最新、缺库与坏库、开关。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "node:module";
// vitest 环境里 node:sqlite 不能静态 import（vite 内置表没有它），与采集器同法
const { DatabaseSync } = createRequire(path.join(process.cwd(), "noop.cjs"))("node:sqlite") as typeof import("node:sqlite");
import { useProviderQuotaFiles } from "../src/core/providerQuota";
import { QuotaDeps, baseDeps } from "../src/main/quota/context";
import {
  devinLaunchStamp, devinSupportDir, fetchDevinQuota, normalizeDevinPlan, scanDevinQuota,
} from "../src/main/quota/devin";

const NOW = 1_800_000_000;
let root: string;
let support: string;
let env: Record<string, string>;
let config: Record<string, any>;
let deps: QuotaDeps;
const savedDevinSupport: string | undefined = process.env.TOKEI_DEVIN_SUPPORT;

/** 目录名即启动时刻（本地时区）：%Y%m%dT%H%M%S */
function launchDir(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function makeSupportDir(dir: string): void {
  fs.mkdirSync(path.join(dir, "User", "globalStorage"), { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
}

/** 造 state.vscdb：ItemTable(key, value)，行内容由用例给 */
function writeDb(dir: string, rows: Array<[string, string | Buffer]>): string {
  makeSupportDir(dir);
  const file = path.join(dir, "User", "globalStorage", "state.vscdb");
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    for (const [key, value] of rows) insert.run(key, value);
  } finally {
    db.close();
  }
  return file;
}

function addLaunch(dir: string, ts: number): void {
  fs.mkdirSync(path.join(dir, "logs", launchDir(ts)), { recursive: true });
}

const PRO_PLAN = {
  planName: "Pro",
  accountIdentityText: " someone@example.com - My Team ",
  dailyRemainingPercent: 80, dailyResetAtUnix: NOW + 3600,
  weeklyRemainingPercent: 50, weeklyResetAtUnix: NOW + 7 * 3600,
  hideDailyQuota: false, hideWeeklyQuota: false,
  overageBalanceMicros: 12_500_000,
  // -1 是付费套餐表示「不适用」的写法，不画消息环
  totalMessages: -1, remainingMessages: -1,
  endTimestamp: NOW + 86400,
};

function reactKey(suffix: string): string {
  return `windsurf.reactSettings.cachedPlanInfoData.user-${suffix}`;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-devin-"));
  support = path.join(root, "Devin");
  process.env.TOKEI_DEVIN_SUPPORT = support;
  useProviderQuotaFiles(path.join(root, "provider_quota_cache.json"), path.join(root, "config.json"));
  env = {};
  config = {};
  deps = baseDeps({
    env: (key) => env[key],
    config: () => config,
    now: () => NOW,
  });
});

afterEach(() => {
  if (savedDevinSupport === undefined) delete process.env.TOKEI_DEVIN_SUPPORT;
  else process.env.TOKEI_DEVIN_SUPPORT = savedDevinSupport;
  useProviderQuotaFiles(null, null);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch { /* Windows 句柄未释放时忽略 */ }
});

describe("端到端扫描", () => {
  it("默认开启：完整套餐画出日/周两环、超额余额与账号", () => {
    writeDb(support, [[reactKey("a".repeat(32)), JSON.stringify(PRO_PLAN)]]);
    addLaunch(support, NOW);
    const quota = scanDevinQuota(deps);
    expect(quota.available).toBe(true);
    expect(quota.plan).toBe("Devin Pro");
    expect(quota.account).toBe("someone@example.com - My Team");
    expect(quota.source).toBe("devin-app-cache");
    expect(quota.updated).toBe(NOW);
    expect(quota.stale).toBe(false);
    expect(quota.windows).toEqual([
      { id: "devin-daily", title: "日额度", used_pct: 20, reset: NOW + 3600,
        window_minutes: 1440, detail: null, usage_known: true },
      { id: "devin-weekly", title: "周额度", used_pct: 50, reset: NOW + 25200,
        window_minutes: 10080, detail: null, usage_known: true },
    ]);
    expect(quota.details).toEqual([{ label: "超额余额", value: "$12.50" }]);
  });

  it("开关关掉时连库都不打开", () => {
    writeDb(support, [[reactKey("b".repeat(32)), JSON.stringify(PRO_PLAN)]]);
    addLaunch(support, NOW);
    env.TOKEI_DEVIN_QUOTA = "0";
    expect(scanDevinQuota(deps)).toEqual({});
  });

  it("没有 state.vscdb 返回 {}", () => {
    fs.mkdirSync(support, { recursive: true });
    addLaunch(support, NOW);
    expect(scanDevinQuota(deps)).toEqual({});
  });

  it("坏库（不是 SQLite 文件）按无套餐处理而不是抛错", () => {
    fs.mkdirSync(path.join(support, "User", "globalStorage"), { recursive: true });
    fs.writeFileSync(path.join(support, "User", "globalStorage", "state.vscdb"), "这不是数据库");
    addLaunch(support, NOW);
    expect(scanDevinQuota(deps)).toEqual({});
  });

  it("多个候选目录取修改时间最新的一个", () => {
    const old = path.join(root, "Windsurf");
    const fresh = path.join(root, "Devin2");
    writeDb(old, [[reactKey("c".repeat(32)), JSON.stringify({ ...PRO_PLAN, planName: "Old" })]]);
    writeDb(fresh, [[reactKey("d".repeat(32)), JSON.stringify({ ...PRO_PLAN, planName: "New" })]]);
    addLaunch(old, NOW);
    addLaunch(fresh, NOW);
    const past = new Date(Date.now() - 3600 * 1000); // 目录 mtime 用真实过去：NOW 是未来时刻
    fs.utimesSync(old, past, past);
    process.env.TOKEI_DEVIN_SUPPORT = `${old}${path.delimiter}${fresh}`;
    const key = (p: string) => path.normalize(p).toLowerCase();
    expect(key(devinSupportDir()!)).toBe(key(fs.realpathSync(fresh)));
    expect(fetchDevinQuota(deps).plan).toBe("Devin New");
  });
});

describe("启动落款", () => {
  it("目录名回环校验：长度、格式、非法日期都拒收", () => {
    expect(devinLaunchStamp(launchDir(NOW))).toBe(NOW);
    expect(devinLaunchStamp("20260914T09200")).toBeNull(); // 少一位
    expect(devinLaunchStamp("20260914t092003")).toBeNull(); // 小写 t
    expect(devinLaunchStamp("20261332T092003")).toBeNull(); // 13 月 32 日
    expect(devinLaunchStamp(20260914092003)).toBeNull();
  });

  it("超过 10 分钟按快照展示（stale），仍给真实落款", () => {
    writeDb(support, [[reactKey("e".repeat(32)), JSON.stringify(PRO_PLAN)]]);
    addLaunch(support, NOW - 700);
    const quota = fetchDevinQuota(deps);
    expect(quota.stale).toBe(true);
    expect(quota.updated).toBe(NOW - 700);
  });

  it("超过一天没重启就不展示", () => {
    writeDb(support, [[reactKey("f".repeat(32)), JSON.stringify(PRO_PLAN)]]);
    addLaunch(support, NOW - 24 * 3600 - 1);
    expect(fetchDevinQuota(deps)).toEqual({});
  });

  it("logs/ 目录名不可信时没有落款，宁可不展示", () => {
    writeDb(support, [[reactKey("g".repeat(32)), JSON.stringify(PRO_PLAN)]]);
    fs.mkdirSync(path.join(support, "logs", "老日志簿"), { recursive: true });
    expect(fetchDevinQuota(deps)).toEqual({});
  });
});

describe("套餐行解析", () => {
  it("登录过两个账号：取 endTimestamp 最远的一行并加明细", () => {
    const expired = { ...PRO_PLAN, planName: "Expired", endTimestamp: NOW - 10 };
    const active = { ...PRO_PLAN, planName: "Active", endTimestamp: NOW + 10 };
    // 第二行以 BLOB 存放：桌面端某些版本确实会写出 bytes，解码后照样解析
    writeDb(support, [
      [reactKey("h".repeat(32)), JSON.stringify(expired)],
      [reactKey("i".repeat(32)), Buffer.from(JSON.stringify(active), "utf8")],
    ]);
    addLaunch(support, NOW);
    const quota = fetchDevinQuota(deps);
    expect(quota.plan).toBe("Devin Active");
    expect(quota.details).toEqual([
      { label: "超额余额", value: "$12.50" },
      { label: "本机账号", value: "2 个", secondary: "取订阅期最长的一个" },
    ]);
  });

  it("新键没有命中时退回旧键 windsurf.settings.cachedPlanInfo%", () => {
    writeDb(support, [["windsurf.settings.cachedPlanInfo.user-j", JSON.stringify(PRO_PLAN)]]);
    addLaunch(support, NOW);
    expect(fetchDevinQuota(deps).plan).toBe("Devin Pro");
  });

  it("免费套餐画消息环；-1 或任一端为负按没有这项", () => {
    writeDb(support, [[reactKey("k".repeat(32)), JSON.stringify({
      totalMessages: 1200, remainingMessages: 250,
    })]]);
    addLaunch(support, NOW);
    const quota = fetchDevinQuota(deps);
    expect(quota.plan).toBeNull();
    expect(quota.windows).toHaveLength(1);
    expect(quota.windows[0]).toMatchObject({
      id: "devin-messages", used_pct: 79.166667, reset: null, window_minutes: null,
      detail: "剩余 250 / 1,200 条",
    });
    expect(fetchDevinQuota(deps).available).toBe(true);
  });
});

describe("归一化边界", () => {
  it("hide 开关与已过去的重置时刻都不画环", () => {
    const plan = { ...PRO_PLAN, hideWeeklyQuota: true, dailyResetAtUnix: NOW - 1 };
    expect(normalizeDevinPlan(plan, NOW, NOW).windows).toEqual([]);
    // 只剩超额余额一条明细，卡片仍然出得来
    expect(normalizeDevinPlan(plan, NOW, NOW).details)
      .toEqual([{ label: "超额余额", value: "$12.50" }]);
  });

  it("布尔不当数字：hideDailyQuota 不会变成 1% 的环", () => {
    const plan = { dailyRemainingPercent: true, dailyResetAtUnix: NOW + 3600 };
    expect(normalizeDevinPlan(plan, NOW, NOW)).toEqual({});
  });

  it("没有任何环也没有明细时返回 {}", () => {
    expect(normalizeDevinPlan({ planName: "Pro" }, NOW, NOW)).toEqual({});
  });

  it("落款在未来不展示", () => {
    expect(normalizeDevinPlan(PRO_PLAN, NOW + 60, NOW)).toEqual({});
  });
});

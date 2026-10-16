/**
 * 面板数据仓储单测：新鲜期、按区间各留一份、重入保护、失败留旧值。
 * 构建本身不写盘；账本读的是临时那份空的，免得真实 ~/.tokei 里的历史天把数字顶歪。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DashboardStore, DashboardSource, DASHBOARD_FRESH_SECONDS, isDashboardPeriod } from "../src/main/dashboardStore";
import { useLedgerFile } from "../src/core/ledger";

const NOW_EPOCH = 1_800_000_000;
let realNow: () => number;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-dashboard-store-"));
  const ledgerFile = path.join(root, "ledger.json");
  fs.writeFileSync(ledgerFile, JSON.stringify({ v: 1, tools: {} }));
  useLedgerFile(ledgerFile, path.join(root, "config.json"));
  realNow = Date.now;
  Date.now = () => NOW_EPOCH * 1000;
});

afterEach(() => {
  Date.now = realNow;
  useLedgerFile(null, null);
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 每构建一次记一笔；缓存内容可以逐轮不同，用来验「补算拿的是新读数」 */
function countingSource(days: Record<string, any> = {}): { source: DashboardSource; calls: () => number } {
  let count = 0;
  const source: DashboardSource = {
    cache: () => {
      count++;
      return count === 1 ? {} : days;
    },
  };
  return { source, calls: () => count };
}

function advance(seconds: number): void {
  Date.now = () => (NOW_EPOCH + seconds) * 1000;
}

const DAY = "2026-10-11";
const claudeCache = (cost: number) => ({
  claude: { f: { proj: "D:/work/alpha", days: { [DAY]: { in: 100, out: 20, cr: 0, cw: 0, cost, models: {} } } } },
});

describe("新鲜期与重入", () => {
  it("30 秒内复用，过期后重算，force=true 立刻绕开", async () => {
    const { source, calls } = countingSource(claudeCache(1.5));
    const store = new DashboardStore(source);
    expect((await store.load("all"))?.wrapped.total_tokens).toBe(0); // 首轮缓存是空的
    expect(calls()).toBe(1);
    advance(DASHBOARD_FRESH_SECONDS - 1);
    await store.load("all");
    expect(calls()).toBe(1);
    advance(DASHBOARD_FRESH_SECONDS + 1);
    expect((await store.load("all"))?.wrapped.total_tokens).toBe(120);
    expect(calls()).toBe(2);
    await store.load("all", false);
    expect(calls()).toBe(2);
    await store.load("all", true);
    expect(calls()).toBe(3);
  });

  it("区间各留一份，互不顶替", async () => {
    const { source, calls } = countingSource(claudeCache(1.5));
    const store = new DashboardStore(source);
    await store.load("all");
    expect(store.peek("7d")).toBeNull();
    await store.load("7d");
    expect(calls()).toBe(2);
    // all 那份算的时候缓存还是空的；7d 这份起点在本周一，2026-10-11 早就出窗了
    expect(store.peek("all")?.wrapped.total_tokens).toBe(0);
    expect(store.peek("7d")?.wrapped.total_tokens).toBe(0);
    // 已经留过的那份不会因为切到别的区间而失效
    advance(DASHBOARD_FRESH_SECONDS - 1);
    await store.load("all");
    expect(calls()).toBe(2);
  });

  it("正在算的时候不并发第二轮，攒下的强制请求只补一次", async () => {
    const { source, calls } = countingSource(claudeCache(2.5));
    const store = new DashboardStore(source);
    const first = store.load("all");
    const concurrent = store.load("all", false);
    const forced = store.load("all", true);
    const [a, b, c] = await Promise.all([first, concurrent, forced]);
    expect(calls()).toBe(2);
    // 补算那一轮拿的是新缓存；三个调用者都拿到补算后的那份（同 Swift：发布的是最后落成的 payload）
    expect(a?.wrapped.total_tokens).toBe(120);
    expect(a?.wrapped.total_cost).toBe(2.5);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("失败的区间不盖时间戳，下一轮照常重试", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ok: DashboardSource = { cache: () => claudeCache(1.5) };
    const store = new DashboardStore(ok);
    await store.load("all");
    const before = store.peek("all");

    const boom: DashboardSource = { cache: () => { throw new Error("扫描炸了"); } };
    const failing = new DashboardStore(boom);
    expect(await failing.load("all")).toBeNull();
    advance(DASHBOARD_FRESH_SECONDS + 1);
    expect(await failing.load("all")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(store.peek("all")).toBe(before);
  });

  it("区间认不出来就退回 all，别把 undefined 拼进路径", () => {
    expect(isDashboardPeriod("7d")).toBe(true);
    expect(isDashboardPeriod("all")).toBe(true);
    expect(isDashboardPeriod("1y")).toBe(false);
    expect(isDashboardPeriod(null)).toBe(false);
  });
});

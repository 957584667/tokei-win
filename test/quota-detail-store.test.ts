/**
 * 额度详情仓储单测：新鲜期、重入保护、只落成功的那份。
 * 同样全程用临时目录，真实 ~/.tokei 不参与。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { QuotaDetailSource, QuotaDetailStore, QUOTA_DETAIL_FRESH_SECONDS, decodeQuotaDetail } from "../src/main/quotaDetailStore";
import { QuotaDetailPayload, useQuotaDetailFiles } from "../src/core/quotaDetail";
import { useLedgerFile } from "../src/core/ledger";

const NOW_EPOCH = 1_800_000_000;

let root: string;
let anchorFile: string;
let detailFile: string;
let ledgerFile: string;
let realNow: () => number;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-quota-detail-store-"));
  anchorFile = path.join(root, "quota_cycles.json");
  detailFile = path.join(root, "quota_detail.json");
  ledgerFile = path.join(root, "ledger.json");
  fs.writeFileSync(ledgerFile, JSON.stringify({ v: 1, tools: {} }));
  useQuotaDetailFiles({
    anchorFile, syncDir: path.join(root, "sync"), detailFile,
    configFile: path.join(root, "config.json"), lastUsageFile: path.join(root, "last_usage.json"),
  });
  useLedgerFile(ledgerFile, path.join(root, "config.json"));
  // 新鲜期判定走的是系统时间，钉住它才能测「30 秒内复用、过期重算」这条线
  realNow = Date.now;
  Date.now = () => NOW_EPOCH * 1000;
});

afterEach(() => {
  Date.now = realNow;
  useQuotaDetailFiles(null);
  useLedgerFile(null, null);
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 每取一次 payload 记一笔，用来数构建轮次；读数本身可以逐轮不同 */
function countingSource(readings: Record<string, any>[]): { source: QuotaDetailSource; calls: () => number } {
  let count = 0;
  const source: QuotaDetailSource = {
    payload: () => {
      const used = readings[Math.min(count, readings.length - 1)] ?? {};
      count++;
      return {
        claude: { q7: used.claude ?? 10, q7_reset: NOW_EPOCH + 2 * 86400 },
        codex: {}, grok: {},
      };
    },
    cache: () => ({}),
    payloadAgeSeconds: () => 0,
  };
  return { source, calls: () => count };
}

function advance(seconds: number): void {
  Date.now = () => (NOW_EPOCH + seconds) * 1000;
}

describe("新鲜期与重入", () => {
  it("30 秒内复用，过期后重算，force=true 立刻绕开", async () => {
    const { source, calls } = countingSource([{ claude: 10 }]);
    const store = new QuotaDetailStore(source, detailFile);
    await store.load();
    expect(calls()).toBe(1);
    advance(QUOTA_DETAIL_FRESH_SECONDS - 1);
    await store.load();
    expect(calls()).toBe(1);
    advance(QUOTA_DETAIL_FRESH_SECONDS + 1);
    await store.load();
    expect(calls()).toBe(2);
    await store.load(false);
    expect(calls()).toBe(2);
    await store.load(true);
    expect(calls()).toBe(3);
  });

  it("正在算的时候不并发第二轮，攒下的强制请求只补一次", async () => {
    const { source, calls } = countingSource([{ claude: 10 }]);
    const store = new QuotaDetailStore(source, detailFile);
    const first = store.load();
    const concurrent = store.load(false);
    const forced = store.load(true);
    const [a, b, c] = await Promise.all([first, concurrent, forced]);
    // 首轮 + 一次补算，不是三次
    expect(calls()).toBe(2);
    expect(a).toEqual(c);
    expect(b).toEqual(c);
    expect((a as QuotaDetailPayload).cycles[0].tool).toBe("claude");
  });
});

describe("落盘与解码", () => {
  it("成功才写盘，写出去的就是 Python 那套键名", async () => {
    const { source } = countingSource([{ claude: 25 }]);
    const store = new QuotaDetailStore(source, detailFile);
    const detail = await store.load();
    expect(detail).not.toBeNull();
    const onDisk = JSON.parse(fs.readFileSync(detailFile, "utf8"));
    expect(Object.keys(onDisk).sort()).toEqual(["cycles", "daily", "devices", "missing", "now"]);
    expect(onDisk.cycles[0]).toMatchObject({ tool: "claude", used_pct: 25, current: true });
    expect(onDisk.devices).toEqual(["本机"]);
    // 本机亲眼读到的锚点要落盘：这是「额度详情」和「周期历史」之间唯一的持久契约
    const anchors = JSON.parse(fs.readFileSync(anchorFile, "utf8"));
    expect(anchors.anchors.claude[0].reset).toBe(NOW_EPOCH + 2 * 86400);
  });

  it("构建失败只往 stderr 留痕，并把上一次成功的那份交回去", async () => {
    const { source } = countingSource([{ claude: 10 }]);
    const store = new QuotaDetailStore(source, detailFile);
    await store.load();
    const before = fs.readFileSync(detailFile, "utf8");

    const boom: QuotaDetailSource = { payload: () => { throw new Error("扫描炸了"); }, cache: () => ({}) };
    const failing = new QuotaDetailStore(boom, detailFile);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    advance(QUOTA_DETAIL_FRESH_SECONDS * 2);
    const result = await failing.load();
    expect(spy).toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(fs.readFileSync(detailFile, "utf8")).toBe(before);
  });

  it("磁盘那份结构坏了就当没有，不硬塞给面板", async () => {
    fs.writeFileSync(detailFile, JSON.stringify({ cycles: [{ tool: "claude" }], daily: [], devices: [], missing: [], now: 1 }));
    const boom: QuotaDetailSource = { payload: () => { throw new Error("扫描炸了"); }, cache: () => ({}) };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await new QuotaDetailStore(boom, detailFile).load()).toBeNull();
    expect(spy).toHaveBeenCalled();
  });

  it("decodeQuotaDetail 只认齐形的载荷", () => {
    expect(decodeQuotaDetail(null)).toBeNull();
    expect(decodeQuotaDetail([])).toBeNull();
    expect(decodeQuotaDetail({ daily: [], cycles: [], devices: [], missing: [], now: "不是数" })).toBeNull();
    const good = decodeQuotaDetail({
      daily: [{ d: "2026-10-11", c: 1, x: 2, g: 3 }],
      cycles: [{ tool: "claude", start: 1, end: 2, used_pct: null, tokens: 0, devices: {}, approx: false, current: true }],
      devices: ["本机"], missing: ["grok"], now: 1_800_000_000.7,
    });
    expect(good!.now).toBe(1_800_000_000);
    expect(good!.cycles[0].used_pct).toBeNull();
    expect(good!.daily[0].d).toBe("2026-10-11");
  });
});

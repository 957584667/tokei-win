/**
 * 持久账本测试（core/ledger.ts ← usage.30s.py:1064-1500）。
 * 全部走临时目录：账本文件与 config.json 都注入到 tmp，绝不碰真实的 ~/.tokei。
 * 重点覆盖：
 *   - _ledger_values 的相加/取 max/逐格 hours/集合 union/subtract 钳零
 *   - 天级高水位对账：日志被删不缩水、坏时间戳不入账、版本更高的旧账本赢
 *   - 来源级合并：缺席来源保留、v1 无 provenance 只保余额、Codex 权威来源可直接替换
 *   - flush 落盘、_sources 45 天收拢、损坏后从同步仓快照自愈
 *   - 无公开价模型的成本重算（清零 / 按 token × 现价补回）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  codexLegacyDay, ledgerAddRecordSource, ledgerDayTotal, ledgerFileSources, ledgerFlush,
  ledgerMemo, ledgerMergeSources, ledgerRecordVersion, ledgerReconcile, ledgerTokenSum, ledgerTouch,
  ledgerValues, loadLedger, prepareQoderCliLedger, prepareUnpricedCostLedger,
  pruneLedgerSources, repriceUnpricedCosts, useLedgerFile,
} from "../src/core/ledger";
import { rawPrice } from "../src/core/price";

let ROOT: string;
let LEDGER: string;
let CONFIG: string;

beforeAll(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-ledger-"));
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** 每个用例都从干净的内存 memo + 干净的盘开始 */
beforeEach(() => {
  LEDGER = path.join(ROOT, `ledger-${Math.random().toString(36).slice(2)}.json`);
  CONFIG = path.join(ROOT, `config-${Math.random().toString(36).slice(2)}.json`);
  useLedgerFile(LEDGER, CONFIG);
});

function disk(): Record<string, any> {
  return JSON.parse(fs.readFileSync(LEDGER, "utf8"));
}

const DAY = "2026-03-05";
const OTHER = "2026-03-06";

describe("_ledger_values 合并", () => {
  it("数值相加、嵌套明细相加、下划线元数据取 max", () => {
    const merged = ledgerValues(
      { in: 10, out: 3, cost: 1.5, models: { "m-a": { in: 4, cost: 0.2 } }, _cost_version: 2, est: 7 },
      { in: 5, out: 1, cost: 0.5, models: { "m-a": { in: 1, cost: 0.1 }, "m-b": { in: 9 } }, _cost_version: 5 },
    );
    expect(merged.in).toBe(15);
    expect(merged.cost).toBe(2.0);
    expect(merged.models["m-a"]).toEqual({ in: 5, cost: 0.30000000000000004 });
    expect(merged.models["m-b"]).toEqual({ in: 9 });
    expect(merged._cost_version).toBe(5);
    expect(merged.est).toBe(7);
  });

  it("_sources 不参与相加，hours 逐格相加，列表与集合并集", () => {
    const merged = ledgerValues(
      { _sources: { a: { in: 1 } }, hours: [1, 2, 3], projects: ["p1"] },
      { _sources: { b: { in: 2 } }, hours: [10, 20], projects: ["p2", "p1"] , sessions: new Set(["s2"]) },
    );
    expect(merged._sources).toBeUndefined();
    // 对应 Python 的 zip：短的那一份到头为止
    expect(merged.hours).toEqual([11, 22]);
    expect(merged.projects).toEqual(["p1", "p2"]);
    expect(merged.sessions).toEqual(["s2"]);
  });

  it("subtract 把负数钳到 0，列表做差集", () => {
    const rest = ledgerValues(
      { in: 100, out: 40, models: { "m-a": { in: 60 } }, sessions: ["s1", "s2", "s3"], hours: [10, 10] },
      { in: 60, out: 10, models: { "m-a": { in: 60 } }, sessions: ["s2"], hours: [4, 20] },
      true,
    );
    expect(rest.in).toBe(40);
    expect(rest.out).toBe(30);
    expect(rest.models["m-a"]).toEqual({ in: 0 });
    expect(rest.sessions).toEqual(["s1", "s3"]);
    expect(rest.hours).toEqual([6, 0]);
  });
});

describe("天级高水位对账", () => {
  it("实时更高就上移账本，日志被删后退回账本值", () => {
    expect(ledgerReconcile("claude", { [DAY]: { in: 100, out: 10, cost: 1 } })).toEqual({
      [DAY]: { in: 100, out: 10, cost: 1 },
    });
    ledgerFlush();
    expect(disk().tools.claude[DAY]).toEqual({ in: 100, out: 10, cost: 1 });

    // 日志被清掉一半：整天退回账本存档，账本不动
    const shrunk = ledgerReconcile("claude", { [DAY]: { in: 20, out: 1, cost: 0.1 } });
    expect(shrunk[DAY]).toEqual({ in: 100, out: 10, cost: 1 });
    // 日志整体消失：账本兜底
    expect(ledgerReconcile("claude", {})).toEqual({ [DAY]: { in: 100, out: 10, cost: 1 } });
  });

  it("记账版本更高的旧账本赢，即使体量更小", () => {
    ledgerReconcile("opencode", { [DAY]: { in: 500, _ledger_version: 1 } });
    ledgerFlush();
    const merged = ledgerReconcile("opencode", { [DAY]: { in: 400, _ledger_version: 0 } });
    expect(merged[DAY].in).toBe(500);
  });

  it("OpenCode 的聚合天在 token 总量回来前守住历史快照", () => {
    ledgerReconcile("opencode", { [DAY]: { in: 900, out: 100 } });
    ledgerFlush();
    // 重新定价后总量没回来：继续用旧快照
    expect(ledgerReconcile("opencode", { [DAY]: { in: 500, out: 60 } })[DAY].in).toBe(900);
  });

  it("坏时间戳的天返回但不入账本", () => {
    const merged = ledgerReconcile("claude", {
      "2024-01-08": { in: 999 }, "2099-01-01": { in: 888 }, [DAY]: { in: 7 },
    });
    expect(Object.keys(merged).sort()).toEqual(["2024-01-08", "2026-03-05", "2099-01-01"]);
    ledgerFlush();
    expect(Object.keys(disk().tools.claude)).toEqual([DAY]);
  });

  it("会话集合只做实时归属，不写进账本", () => {
    ledgerReconcile("zcode", { [DAY]: { in: 10, sessions: new Set(["s1", "s2"]) } });
    ledgerFlush();
    expect(disk().tools.zcode[DAY]).toEqual({ in: 10 });
  });

  it("ledger_touch 建空占位，标记扫描器已接入", () => {
    ledgerTouch("grok_bot");
    ledgerFlush();
    expect(disk().tools.grok_bot).toEqual({});
  });

  it("没有任何变更就不写盘", () => {
    expect(fs.existsSync(LEDGER)).toBe(false);
    ledgerReconcile("claude", {});
    ledgerFlush();
    expect(fs.existsSync(LEDGER)).toBe(false);
  });
});

describe("来源级合并", () => {
  it("缺席来源的贡献保留，已知来源被替换且不重复累加", () => {
    const first = ledgerReconcile("pi", { [DAY]: { in: 30, out: 5 } }, {
      "file-a": { [DAY]: { in: 20, out: 4, _accounting_version: 1 } },
      "file-b": { [DAY]: { in: 10, out: 1, _accounting_version: 1 } },
    });
    expect(first[DAY].in).toBe(30);

    // file-b 的日志被删：file-a 的新贡献 + file-b 的历史余额并存
    const second = ledgerReconcile("pi", { [DAY]: { in: 25, out: 4 } }, {
      "file-a": { [DAY]: { in: 25, out: 4, _accounting_version: 1 } },
    });
    expect(second[DAY].in).toBe(35);
    expect(Object.keys(second[DAY]._sources).sort()).toEqual(
      [sha("file-a"), sha("file-b")].sort());
    expect(second[DAY]._sources[sha("file-b")].in).toBe(10);
  });

  it("v1 整天没有 provenance：只保住无法归属的余额", () => {
    // 先写入一份 v1 账本（无 _sources）
    ledgerReconcile("mimocode", { [DAY]: { in: 100, out: 20 } });
    ledgerFlush();

    // 现在扫描器只能看到部分会话（30 in），旧值不能和它相加
    const merged = ledgerReconcile("mimocode", { [DAY]: { in: 30, out: 5 } }, {
      "sid-1": { [DAY]: { in: 30, out: 5, _accounting_version: 1 } },
    });
    expect(merged[DAY].in).toBe(100);
    expect(merged[DAY]._sources.legacy.in).toBe(70);
    expect(merged[DAY]._sources[sha("sid-1")].in).toBe(30);
  });

  it("Codex 权威来源直接替换，即便总量更低；v1 余额改写成不重复计数的形态", () => {
    // kept 是升级前的混合天：in 里含 cached，且没有 provenance
    const kept = { in: 200, out: 50, cached: 80, cost: 2 };
    const first = ledgerMergeSources(kept, {
      s1: { in: 120, out: 30, cached: 40, _accounting_version: 7 },
    }, "codex");
    // legacy 只保住无法归属的那部分，cached 仍夹在 in 里
    expect(first._sources.legacy).toMatchObject({ in: 80, out: 20, cached: 40, reason: 0 });
    expect(first._sources.legacy.models.unknown).toMatchObject({ in: 40, out: 20, cr: 40 });
    // 整天重新相加后与历史一致，没有重复累加
    expect([first.in, first.out, first.cached, first.cost]).toEqual([200, 50, 80, 2]);

    // 权威来源（accounting_version 到位）即便把总量调低也整份替换
    const second = ledgerMergeSources(first, {
      s1: { in: 90, out: 20, cached: 30, _accounting_version: 7 },
    }, "codex");
    expect(second._sources.s1.in).toBe(90);
    expect(second.in).toBe(90 + first._sources.legacy.in);
  });

  it("DeepSeek Harness 的余额被完整重建后不再留孤儿美元", () => {
    const kept = { in: 100, out: 10, cost_cny: 3.5, cost: 0, models: { "deepseek-v3": { in: 100, out: 10 } } };
    const merged = ledgerMergeSources(kept, {
      "turn-1": { in: 100, out: 10, cost_cny: 3.5, _accounting_version: 2 },
    }, "deepseek_harness");
    expect(merged._sources.legacy.in).toBe(0);
    expect(merged._sources.legacy.cost).toBe(0);
    expect(merged._sources.legacy.cost_cny).toBe(0);
    expect(merged._sources.legacy.models).toEqual({});
  });

  it("projects 与 sessions 由实时扫描补回，并随 flush 落盘", () => {
    ledgerReconcile("prime_agent", { [DAY]: { projects: ["p1"], sessions: ["s1"] } }, {
      "sid": { [DAY]: { in: 5 } },
    });
    const merged = ledgerReconcile("prime_agent", { [DAY]: { projects: ["p1", "p9"], sessions: ["s2"] } }, {
      "sid": { [DAY]: { in: 5 } },
    });
    expect(merged[DAY].projects).toEqual(["p1", "p9"]);
    expect(merged[DAY].sessions).toEqual(["s2"]);
    ledgerFlush();
    expect(disk().tools.prime_agent[DAY].projects).toEqual(["p1", "p9"]);
  });
});

describe("flush 与磁盘的高水位合并", () => {
  it("磁盘上更高的天不被内存低值覆盖", () => {
    // 另一份进程（这里手工写盘）先落了个大值
    fs.writeFileSync(LEDGER, JSON.stringify({
      v: 1, tools: { claude: { [DAY]: { in: 900, out: 90 }, [OTHER]: { in: 5 } } },
    }));
    useLedgerFile(LEDGER, CONFIG);
    ledgerReconcile("claude", { [DAY]: { in: 10 }, [OTHER]: { in: 50 } });
    ledgerFlush();
    expect(disk().tools.claude[DAY].in).toBe(900);
    expect(disk().tools.claude[OTHER].in).toBe(50);
  });

  it("迁移过的工具按 schema 键整份覆盖", () => {
    fs.writeFileSync(LEDGER, JSON.stringify({ v: 1, tools: { qodercli: { [DAY]: { in: 900 } } } }));
    useLedgerFile(LEDGER, CONFIG);
    prepareQoderCliLedger("qodercli");
    expect(loadLedger().tools.qodercli).toEqual({});
    ledgerReconcile("qodercli", { [DAY]: { in: 3 } });
    ledgerFlush();
    expect(disk().qodercli_schema).toBe(1);
    expect(disk().tools.qodercli[DAY]).toEqual({ in: 3 });
  });

  it("codex 的记账版本升级允许把总量调低", () => {
    // 磁盘上是旧的混合天（version 1，in=500），内存里 Reserve 归属升级后（version 2，in=200）
    fs.writeFileSync(LEDGER, JSON.stringify({
      v: 1, tools: { codex: { [DAY]: { in: 500, out: 10, _ledger_version: 1 } } },
    }));
    useLedgerFile(LEDGER, CONFIG);
    loadLedger().tools.codex[DAY] = { in: 200, out: 10, _ledger_version: 2 };
    (ledgerMemo() as { dirty: boolean }).dirty = true;
    ledgerFlush();
    expect(disk().tools.codex[DAY]).toEqual({ in: 200, out: 10, _ledger_version: 2 });
  });

  it("flush 后内存指向磁盘那份，且不再重复写", () => {
    ledgerReconcile("claude", { [DAY]: { in: 1 } });
    ledgerFlush();
    const before = fs.statSync(LEDGER).mtimeMs;
    ledgerFlush();
    expect(fs.statSync(LEDGER).mtimeMs).toBe(before);
  });
});

describe("保留期与自愈", () => {
  it("45 天外的来源明细被收拢，合计原样保留", () => {
    const ledger = loadLedger();
    ledger.tools.codex = {
      "2026-01-10": { in: 400, _sources: { a: { in: 400 } } },
      "2026-02-20": { in: 100, _sources: { b: { in: 100 } } },
    };
    expect(pruneLedgerSources(ledger, "2026-03-05")).toBe(true);
    expect(ledger.tools.codex["2026-01-10"]._sources).toBeUndefined();
    expect(ledger.tools.codex["2026-01-10"].in).toBe(400);
    expect(ledger.tools.codex["2026-02-20"]._sources).toBeDefined();
    expect(pruneLedgerSources(ledger, "2026-03-05")).toBe(false);
  });

  it("账本损坏时从同步仓的本机快照恢复", () => {
    fs.writeFileSync(LEDGER, "{ broken");
    const sync = path.join(ROOT, "sync");
    fs.mkdirSync(sync, { recursive: true });
    fs.writeFileSync(path.join(sync, "devA.json"), JSON.stringify({
      _ledger: { v: 1, tools: { claude: { [DAY]: { in: 777 } } } },
    }));
    fs.writeFileSync(CONFIG, JSON.stringify({ device_id: "devA", sync_dir: sync }));
    useLedgerFile(LEDGER, CONFIG);
    expect(loadLedger().tools.claude[DAY].in).toBe(777);
    // 恢复出来的账本要落回本地，下次启动不再走自愈分支
    expect(disk().tools.claude[DAY].in).toBe(777);
  });

  it("快照里没有账本时用空账本重扫", () => {
    fs.writeFileSync(CONFIG, JSON.stringify({ device_id: "devB", sync_dir: path.join(ROOT, "nope") }));
    useLedgerFile(LEDGER, CONFIG);
    expect(loadLedger()).toEqual({ v: 1, tools: {} });
  });
});

describe("成本重算与逐来源记账", () => {
  it("无公开价模型清零、有公开价按 token × 现价重算，当天合计按差额调整", () => {
    const priced = "anthropic/claude-sonnet-4.6";
    const p = rawPrice(priced);
    const pricedCost = (1e6 * p.in + 1e6 * p.out) / 1e6;
    fs.writeFileSync(LEDGER, JSON.stringify({
      v: 1, tools: { workbuddy: {
        [DAY]: { cost: 4.0, models: {
          "totally-unknown-model": { in: 1e6, out: 1e6, cr: 1e6, cw: 1e6, cost: 3.5 },
          [priced]: { in: 1e6, out: 1e6, cr: 0, cw: 0, cost: 0.5 },
        } },
        [OTHER]: {
          cost: 1.0,
          models: { "totally-unknown-model": { in: 1e6, out: 0, cr: 0, cw: 0, cost: 1.0 } },
          _sources: { s: { cost: 1.0, models: { "totally-unknown-model": { in: 1e6, out: 0, cr: 0, cw: 0, cost: 1.0 } } } },
        },
      } },
    }));
    useLedgerFile(LEDGER, CONFIG);
    prepareUnpricedCostLedger("workbuddy");
    const ledger = loadLedger();
    expect(ledger.tools.workbuddy[DAY].models["totally-unknown-model"].cost).toBe(0);
    expect(ledger.tools.workbuddy[DAY].models[priced].cost).toBeCloseTo(pricedCost, 10);
    expect(ledger.tools.workbuddy[DAY].cost).toBeCloseTo(pricedCost, 10);
    expect(ledger.tools.workbuddy[OTHER].cost).toBe(0);
    expect(ledger.tools.workbuddy[OTHER]._sources.s.cost).toBe(0);
    expect(ledger.tools.workbuddy[OTHER]._sources.s.models["totally-unknown-model"].cost).toBe(0);
    expect(ledger.workbuddy_unpriced_schema).toBe(3);
    // 迁移只做一次：再调不重复动
    prepareUnpricedCostLedger("workbuddy");
    expect(loadLedger().tools.workbuddy[DAY].cost).toBeCloseTo(pricedCost, 10);
  });

  it("Pi 保住日志自带的真实成本，Qwen Code 把 reason 计入输出", () => {
    const priced = "anthropic/claude-sonnet-4.6";
    const qwen = "qwen/qwen3.8-max";
    const piDay: any = {
      cost: 9.9,
      models: {
        [priced]: { in: 1e6, out: 0, cr: 0, cw: 0, cost: 9.9 },
        "totally-unknown-model": { in: 1e6, out: 0, cr: 0, cw: 0, cost: 0 },
      },
    };
    repriceUnpricedCosts(piDay, "pi");
    expect(piDay.models[priced].cost).toBe(9.9); // 只补原来是 0 的行
    expect(piDay.cost).toBe(9.9);

    const qp = rawPrice(qwen);
    const qwenDay: any = { cost: 0, models: { [qwen]: { in: 0, out: 0, reason: 1e6, cr: 0, cw: 0, cost: 0 } } };
    repriceUnpricedCosts(qwenDay, "qwencode");
    expect(qwenDay.models[qwen].cost).toBeCloseTo(qp.out, 10);
    expect(qwenDay.cost).toBeCloseTo(qp.out, 10);
    // 无公开价：清零后当天合计钳到 0，不会出现负数
    const zeroDay: any = { cost: 0.2, models: { "totally-unknown-model": { in: 1e6, out: 1e6, cr: 0, cw: 0, cost: 5 } } };
    repriceUnpricedCosts(zeroDay, "workbuddy");
    expect(zeroDay.cost).toBe(0);
  });

  it("逐文件来源：逻辑 ID 扛得住文件移动，day_hours 覆盖小时分布", () => {
    const sources = ledgerFileSources({
      "/old/a.jsonl": { sid: "S1", days: { [DAY]: { in: 3, out: 1 } }, day_hours: { [DAY]: [0, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
      "/new/b.jsonl": { sid: "S1", days: { [DAY]: { in: 4, out: 2 } } },
      "/skip/c.jsonl": { sid: "S2", days: {} },
    }, "sid", 7);
    expect(Object.keys(sources)).toEqual(["S1"]);
    expect(sources.S1[DAY]).toMatchObject({ in: 7, out: 3, _accounting_version: 7 });
    expect(sources.S1[DAY].hours[1]).toBe(3);
  });

  it("逐条记录来源：没有 models 时按模型名建一份，hour 只在对应格子计数", () => {
    const sources: Record<string, Record<string, any>> = {};
    ledgerAddRecordSource(sources, "sess-1", DAY, { model: "gpt-5.6-sol", in: 6, out: 2, cost: 0.1 }, 9);
    expect(sources["sess-1"][DAY].models["gpt-5.6-sol"]).toMatchObject({ in: 6, out: 2, cost: 0.1 });
    expect(sources["sess-1"][DAY].hours[9]).toBe(8);
    expect(sources["sess-1"][DAY].hours.reduce((a: number, b: number) => a + b, 0)).toBe(8);
    ledgerAddRecordSource(sources, "sess-1", DAY, { in: 1, out: 1, models: { "m": { in: 1, out: 1 } } });
    expect(sources["sess-1"][DAY].in).toBe(7);
    expect(sources["sess-1"][DAY].out).toBe(3);
  });
});

describe("口径函数", () => {
  it("reason 对 codex 一族是 out 的子集，不参与 token 相加", () => {
    const day = { in: 10, out: 20, reason: 8, thoughts: 3, cached: 100, est: 5 };
    expect(ledgerTokenSum(day, "codex")).toBe(33);
    expect(ledgerTokenSum(day, "claude")).toBe(41);
    // cached 永远是 in 的子集，加它会重复计数
    expect(ledgerTokenSum(day, null)).toBe(41);
  });

  it("day_total 排除成本与下划线元数据", () => {
    expect(ledgerDayTotal({ in: 1, out: 2, cost: 99, cost_cny: 50, _sources: {}, est: true, calls: 3 })).toBe(6);
  });

  it("record_version 优先取 _ledger_version，回落到 _cost_version", () => {
    expect(ledgerRecordVersion({ _ledger_version: 3, _cost_version: 1 })).toBe(3);
    expect(ledgerRecordVersion({ _cost_version: 2 })).toBe(2);
    expect(ledgerRecordVersion({ _cost_version: true })).toBe(0);
    expect(ledgerRecordVersion(null)).toBe(0);
  });

  it("codex 旧天：cached/reason 钳进父字段，模型明细对不上就退成 unknown", () => {
    const day = codexLegacyDay({ in: 100, out: 50, cached: 140, reason: 70, cost: 1.5, models: {}, hours: new Array(24).fill(30) });
    expect(day.cached).toBe(100);
    expect(day.reason).toBe(50);
    expect(day.models).toEqual({ unknown: { in: 0, out: 50, cr: 100, cw: 0, reason: 50, cost: 1.5 } });
    // 30*24 > in+out，旧的小时分布不可信，整格清空
    expect(day.hours).toEqual(new Array(24).fill(0));

    const matched = codexLegacyDay({
      in: 60, out: 10, cached: 20, reason: 4, cost: 0,
      models: { "m-a": { in: 40, out: 10, cr: 20, cw: 0, reason: 4 } },
      hours: [1, 2, 3],
    });
    expect(matched.models["m-a"].in).toBe(40);
    expect(matched.hours).toEqual([1, 2, 3]);
  });
});

function sha(source: string): string {
  return crypto.createHash("sha256").update(String(source)).digest("hex");
}

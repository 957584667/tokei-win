/**
 * 价目表指纹测试（core/price.ts ← usage.30s.py 的 _effective_pricing_map /
 * _make_pricing_fingerprint / _load_scan_cache 指纹分支 / _cached_entry_has_pricing_change /
 * _reprice_claude_events / _reprice_codex_event_caches）。
 * 价目表、转录、账本全写在临时目录，HOME 也指过去，绝不碰真实的 ~/.tokei。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { dayKey, rangeBounds } from "../src/core/ranges";

type PriceModule = typeof import("../src/core/price");
type ClaudeModule = typeof import("../src/collectors/claude");
type CodexModule = typeof import("../src/collectors/codex");

let root: string;
let res: string;
let claudeDir: string;
let codexDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function fields(inp: number, out: number, cr: number, cw: number) {
  return { in: inp, out, cache_read: cr, cache_write: cw };
}

/** 夹具价目表：两个自建模型 + 一个带长 prompt 档位的 Haiku 5.5 */
const MODELS: Record<string, any> = {
  "test/alpha-1.2-sol": fields(2, 8, 0.2, 0.5),
  "test/gamma-3": fields(0.5, 1, 0.05, 0.1),
  "anthropic/claude-haiku-5.5": fields(0.8, 4, 0.08, 1.0),
};

/**
 * 夹具落盘：资源目录与 ~/.tokei 两份一起写。第一次 initPricing 会把资源里那份复制到 ~/.tokei
 * （对应 Python _writable_path 的 Windows 分支），之后可写路径只认副本——只改资源那份，
 * reloadPricingIfChanged() 盯的文件里不会有新内容。
 */
function writePrices(models: Record<string, any> = MODELS, overrides: Record<string, any> = {}): void {
  const user = path.join(root, ".tokei");
  fs.mkdirSync(user, { recursive: true });
  for (const dir of [res, user]) {
    fs.writeFileSync(path.join(dir, "pricing.json"), JSON.stringify({ models }));
    fs.writeFileSync(path.join(dir, "pricing_overrides.json"), JSON.stringify(overrides));
  }
}

/** 价目层与两个采集器要在同一份模块实例上跑（指纹状态就在 price 模块里），所以一次导入。 */
async function loadSuite(): Promise<{ price: PriceModule; claude: ClaudeModule; codex: CodexModule }> {
  vi.resetModules();
  const price = await import("../src/core/price");
  price.initPricing(res);
  const claude = await import("../src/collectors/claude");
  const codex = await import("../src/collectors/codex");
  return { price, claude, codex };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-fp-"));
  res = path.join(root, "resources");
  claudeDir = path.join(root, "claude-projects");
  codexDir = path.join(root, "codex-sessions");
  fs.mkdirSync(res, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  writePrices();
  // 模块级常量在 import 时求值，所以先改环境再 resetModules
  setEnv("HOME", root);
  setEnv("USERPROFILE", root);
  setEnv("TOKEI_CLAUDE_DIR", claudeDir);
  setEnv("TOKEI_CODEX_DIR", codexDir);
  setEnv("TOKEI_CODEX_ARCHIVED_DIR", path.join(root, "codex-archived"));
  setEnv("TOKEI_CODEX_CONFIG", path.join(root, "config.toml"));
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const name of Object.keys(savedEnv)) delete savedEnv[name];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("生效价目表摊平", () => {
  it("内置→目录→本地覆盖逐层合并，缺的字段补 0，anthropic 也不补 2×输入", async () => {
    writePrices(MODELS, { models: { "test/alpha-1.2-sol": { out: 9.5 } } });
    const { price } = await loadSuite();
    const map = price.effectivePricingMap();
    expect(map["test/alpha-1.2-sol"]).toEqual({ in: 2, out: 9.5, cache_read: 0.2, cache_write: 0.5, write1h: 0 });
    // rawPrice() 对 anthropic 有 1h 写 = 2×输入 的兜底，摊平表刻意不带：
    // 指纹只要自比，多一条推导规则只会让"变了没"更难判。
    expect(map["anthropic/claude-haiku-5.5"].write1h).toBe(0);
    expect(map["openai/gpt-5.5"].write1h).toBe(0);
    expect(map["openai/gpt-5.5"].in).toBe(5);
  });

  it("长 prompt 档位随模型进摊平表，没档位的模型不带这个键", async () => {
    const { price } = await loadSuite();
    const map = price.effectivePricingMap();
    expect(map["anthropic/claude-haiku-5.5"].long_prompt).toEqual([100_000, 5]);
    expect("long_prompt" in map["test/alpha-1.2-sol"]).toBe(false);
  });
});

describe("指纹与热重载", () => {
  it("文件没动指纹不变；改一个价后重读才变，变更名单只有它", async () => {
    const { price } = await loadSuite();
    const cache: Record<string, any> = {};
    price.markPricingChanges(cache);
    price.finishPricingPass(cache);
    const before = price.pricingFingerprint();
    expect(price.reloadPricingIfChanged()).toBe(false);
    expect(price.pricingFingerprint()).toBe(before);

    writePrices({ ...MODELS, "test/alpha-1.2-sol": fields(4, 8, 0.2, 0.5) });
    expect(price.reloadPricingIfChanged()).toBe(true);
    expect(price.pricingFingerprint()).not.toBe(before);
    price.markPricingChanges(cache);
    expect(cache._pricing_changed_models).toEqual(["test/alpha-1.2-sol"]);
  });

  it("首轮缓存里没留过快照：整批按内置名单 + 倍率表，盖完章第二轮不再标脏", async () => {
    const { price } = await loadSuite();
    const cache: Record<string, any> = {};
    price.markPricingChanges(cache);
    expect(cache._pricing_changed).toBe(true);
    expect(cache._dirty).toBe(true);
    expect(cache._pricing_changed_models).toContain("openai/gpt-5.6-sol");
    expect(cache._pricing_changed_models).toContain("gpt-5.6");
    expect(cache._pricing_changed_models).toEqual([...cache._pricing_changed_models].sort());
    expect(cache._pricing_cost_multipliers).toEqual({ "openai/gpt-5.6-sol": 2 });

    price.finishPricingPass(cache);
    expect(cache._pricing_changed).toBeUndefined();
    expect(cache._pricing_changed_models).toBeUndefined();
    // 倍率表只在本轮有效：留着下一轮会把同一批日账再乘一遍
    expect(cache._pricing_cost_multipliers).toBeUndefined();
    expect(cache._pricing_fingerprint).toBe(price.pricingFingerprint());
    const snapshot = JSON.stringify(cache._pricing_effective);

    price.markPricingChanges(cache);
    expect(cache._pricing_changed).toBeUndefined();
    expect(JSON.stringify(cache._pricing_effective)).toBe(snapshot);
  });

  it("别名改了指向：别名本身、旧目标、新目标一起进名单", async () => {
    writePrices(MODELS, { aliases: { "test/alias-1": "test/alpha-1.2-sol" } });
    const { price } = await loadSuite();
    const cache: Record<string, any> = {};
    price.markPricingChanges(cache);
    price.finishPricingPass(cache);

    writePrices(MODELS, { aliases: { "test/alias-1": "test/gamma-3" } });
    expect(price.reloadPricingIfChanged()).toBe(true);
    price.markPricingChanges(cache);
    expect(new Set(cache._pricing_changed_models)).toEqual(
      new Set(["test/alias-1", "test/alpha-1.2-sol", "test/gamma-3"]),
    );
  });
});

describe("缓存条目命中判定", () => {
  const changed = ["test/alpha-1.2-sol"];

  it("active_model、days 与 deduped_days 里的模型名都算命中", async () => {
    const { price } = await loadSuite();
    expect(price.cachedEntryHasPricingChange({ active_model: "test/alpha-1.2-sol" }, changed)).toBe(true);
    expect(price.cachedEntryHasPricingChange({ days: { "2026-10-20": { models: { "test/alpha-1.2-sol": {} } } } }, changed)).toBe(true);
    expect(price.cachedEntryHasPricingChange({ deduped_days: { "2026-10-20": { models: { "test/alpha-1.2-sol": {} } } } }, changed)).toBe(true);
    expect(price.cachedEntryHasPricingChange({ days: { "2026-10-20": { models: { "test/gamma-3": {} } } } }, changed)).toBe(false);
  });

  it("日账里一个模型都没有才退到事件明细；定长数组事件（Codex）不参与", async () => {
    const { price } = await loadSuite();
    expect(price.cachedEntryHasPricingChange({ days: {}, events: [{ model: "test/alpha-1.2-sol" }] }, changed)).toBe(true);
    expect(price.cachedEntryHasPricingChange({ days: {}, events: [["ts", "2026-10-20", 0, 0, 0, 0, 1, 0, 1, 0, 0, "test/alpha-1.2-sol", "r1"]] }, changed)).toBe(false);
    expect(price.cachedEntryHasPricingChange(null, changed)).toBe(false);
  });

  it("模型名按原价/规范化/解析后三个键匹配：带 custom: 前缀的也认", async () => {
    const { price } = await loadSuite();
    expect(price.modelHasPricingChange("TEST/Alpha-1.2-Sol", changed)).toBe(true);
    expect(price.modelHasPricingChange("test/alpha-1.2-sol:free", changed)).toBe(true);
    expect(price.modelHasPricingChange("test/gamma-3", changed)).toBe(false);
  });
});

describe("Claude 缓存事件重算", () => {
  function writeTranscript(): string {
    const dir = path.join(claudeDir, "proj-a");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "session.jsonl");
    const ts = new Date().toISOString();
    const line = (id: string, model: string) => JSON.stringify({
      type: "assistant", timestamp: ts, cwd: "C:\\work\\proj-a", uuid: id,
      message: {
        id: `msg_${id}`, model,
        usage: { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    fs.writeFileSync(file, [line("a", "test/alpha-1.2-sol"), line("b", "test/gamma-3")].join("\n") + "\n");
    return file;
  }

  it("转录未变、价目表变了：缓存事件的成本跟着重算", async () => {
    const file = writeTranscript();
    const { price, claude } = await loadSuite();
    const bounds = rangeBounds(new Date());
    const cache: Record<string, any> = {};

    price.markPricingChanges(cache);
    const first = claude.scanClaude(bounds, cache);
    const today = dayKey(new Date());
    // 1M 输入 × $2 + 0.5M 输出 × $8 = 6；gamma：1M × 0.5 + 0.5M × 1 = 1
    expect(first.days[today].cost).toBeCloseTo(7, 10);
    const entry = cache.claude[file];
    expect(entry).toBeTruthy();
    expect(entry.events[0].cost).toBeCloseTo(6, 10);
    // 这一轮收尾盖章：下一轮的变更名单才只由价格差异决定
    price.finishPricingPass(cache);

    // 只动 alpha 的输入价：2 → 3，gamma 那条一个字都不该变
    writePrices({ ...MODELS, "test/alpha-1.2-sol": fields(3, 8, 0.2, 0.5) });
    expect(price.reloadPricingIfChanged()).toBe(true);
    price.markPricingChanges(cache);
    expect(cache._pricing_changed_models).toEqual(["test/alpha-1.2-sol"]);
    const second = claude.scanClaude(bounds, cache);
    expect(second.days[today].cost).toBeCloseTo(8, 10);
    expect(cache.claude[file].events[0].cost).toBeCloseTo(7, 10);
    expect(cache.claude[file].events[1].cost).toBeCloseTo(1, 10);

    // 第三轮价格没再变：不该再标脏，读数保持第二轮的值
    price.finishPricingPass(cache);
    price.markPricingChanges(cache);
    expect(cache._pricing_changed).toBeUndefined();
    const third = claude.scanClaude(bounds, cache);
    expect(third.days[today].cost).toBeCloseTo(8, 10);
  });
});

describe("Codex 缓存日账重算", () => {
  const DAY = dayKey(new Date());

  function writeRollout(): string {
    const file = path.join(codexDir, `rollout-${DAY}-sess-1.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: "sess-1" } }) + "\n");
    return file;
  }

  /** 手写一条"上一轮已经缓存好"的条目：sig 与文件一致、版本齐全，扫描器会整文件跳过重解析 */
  function cachedEntry(codex: CodexModule, file: string, days: Record<string, any>, model: string): any {
    const stat = fs.statSync(file);
    const event: any[] = [
      new Date().toISOString(), DAY, null, null, null, null,
      1_000_000, 200_000, 500_000, 0, 0, model, "resp-1",
    ];
    return {
      sig: `${stat.mtimeMs / 1000}:${stat.size}`,
      events: [event],
      days, deduped_days: days,
      session_id: "sess-1", forked_from_id: null, history_base: null,
      limits: null, limits_ts: null, plan: null, g_limits: null, g_ts: null, g_plan: null,
      reserve_limits: null, reserve_limits_ts: null, last_total: null, prev_total_key: null,
      active_model: model,
      parser_version: codex.CODEX_PARSER_VERSION, accounting_version: codex.CODEX_ACCOUNTING_VERSION,
      response_ids: ["resp-1"], pending_responses: [], last_legacy_snapshot: null,
      file_id: `${stat.dev}:${stat.ino}`, parsed_size: stat.size, parsed_guard: "",
      event_count: 1, first_keys: [], first_event_ts: null, last_event_ts: null,
      drop_count: 0, dedupe_open: false, canonical: true, dedupe_peers: [file], proj: "",
    };
  }

  /** 日账成本先写成 999：重算后是几，就说明走了哪条路（缩放 or 按事件重算） */
  function staleDays(model: string): Record<string, any> {
    const usage = { in: 800_000, out: 500_000, cr: 200_000, cw: 0, reason: 0, cost: 999, credits: 0, cost_cny: 0 };
    const day: any = {
      in: 1_000_000, cached: 200_000, out: 500_000, reason: 0, cost: 999,
      models: { [model]: usage }, hours: new Array(24).fill(0),
      model_hours: { [model]: new Array(24).fill(0) },
    };
    // days 与 deduped_days 指向同一批对象，缩放必须按引用去重，否则乘两遍
    return { [DAY]: day };
  }

  it("首轮没有价目表快照：能按倍率缩放的日账乘倍率，不重算事件", async () => {
    const file = writeRollout();
    const model = "openai/gpt-5.6-sol";
    const { price, codex } = await loadSuite();
    const cache: Record<string, any> = { codex: { [file]: cachedEntry(codex, file, staleDays(model), model) } };
    price.markPricingChanges(cache);
    expect(cache._pricing_cost_multipliers[model]).toBe(2);
    const result = codex.scanCodex(rangeBounds(new Date()), cache);
    expect(result.days[DAY].cost).toBeCloseTo(1998, 6);
    expect(cache._dirty).toBe(true);
  });

  it("改过价且知道差多少：按事件明细重算整份日账，不用旧 cost", async () => {
    const file = writeRollout();
    const model = "test/alpha-1.2-sol";
    const { price, codex } = await loadSuite();
    const cache: Record<string, any> = {};
    price.markPricingChanges(cache);
    price.finishPricingPass(cache);
    cache.codex = { [file]: cachedEntry(codex, file, staleDays(model), model) };

    writePrices({ ...MODELS, "test/alpha-1.2-sol": fields(6, 30, 0.8, 5) });
    expect(price.reloadPricingIfChanged()).toBe(true);
    price.markPricingChanges(cache);
    expect(cache._pricing_changed_models).toEqual([model]);
    expect(cache._pricing_cost_multipliers).toEqual({});
    const expected = codex.codexEstimatedCost(model, 1_000_000, 200_000, 500_000);
    const result = codex.scanCodex(rangeBounds(new Date()), cache);
    expect(result.days[DAY].cost).toBeCloseTo(expected, 10);
    expect(result.days[DAY].cost).not.toBeCloseTo(999, 6);
  });

  it("手上没有事件明细的条目先跳过，交给扫描器按源文件重新解析", async () => {
    const file = writeRollout();
    const model = "openai/gpt-5.6-sol";
    const { price, codex } = await loadSuite();
    const cache: Record<string, any> = { codex: { [file]: cachedEntry(codex, file, staleDays(model), model) } };
    cache.codex[file].events = null;
    price.markPricingChanges(cache);
    const result = codex.scanCodex(rangeBounds(new Date()), cache);
    // 缓存被重解析掉，那条手写的 999 成本不该出现在结果里
    expect(result.days[DAY]?.cost ?? 0).not.toBeCloseTo(1998, 6);
    expect(Array.isArray(cache.codex[file].events)).toBe(true);
  });
});

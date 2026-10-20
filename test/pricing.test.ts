/**
 * 定价层测试（core/price.ts ← usage.30s.py 的 _normalize / _catalog_index /
 * _predecessor_pricing_id / _pricing_id / _resolve_id 与 Claude 长 prompt 分档）。
 * 价目表夹具写在临时目录里，并把 HOME 指到同一份临时目录，
 * 绝不读真实的 ~/.tokei/pricing.json，用例结果只由这份夹具决定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type PriceModule = typeof import("../src/core/price");

let root: string;
let res: string;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

function fields(i: number, o: number, cr: number, cw: number) {
  return { in: i, out: o, cache_read: cr, cache_write: cw };
}

/** 基线夹具：一条完整的 alpha 版本线、歧义名 delta、同版本正式/preview 的 eps、GLM 参照 */
const BASE_MODELS: Record<string, any> = {
  "test/alpha-1.2-sol": fields(2, 8, 0.2, 0.5),
  "test/alpha-1.1-sol": fields(1.5, 6, 0.15, 0.4),
  "test/alpha-1.0": fields(1, 4, 0.1, 0.3),
  "test/eps-1.0": fields(3, 9, 0.3, 0.6),
  "test/eps-1.0-preview": fields(3, 9, 0.3, 0.6),
  "test/gamma-3": fields(0.5, 1, 0.05, 0.1),
  "test/delta-1": fields(0.5, 1, 0.05, 0.1),
  "other/delta-1": fields(0.7, 1.4, 0.07, 0.14),
  "z-ai/glm-5.1": fields(1.2, 5, 0.2, 1.0),
  "anthropic/claude-haiku-5.5": fields(0.8, 4, 0.08, 1.0),
};

/**
 * 夹具落盘：资源目录与 ~/.tokei 两份一起写。
 * 第一次 initPricing 会把资源里那份复制到 ~/.tokei（对应 Python _writable_path 的 Windows 分支），
 * 之后 writablePath 只认副本——只改资源那份的话，用例改的价根本没被读到。
 */
function writeFixtures(models: Record<string, any>, overrides: Record<string, any>): void {
  const user = path.join(root, ".tokei");
  fs.mkdirSync(user, { recursive: true });
  for (const dir of [res, user]) {
    fs.writeFileSync(path.join(dir, "pricing.json"), JSON.stringify({ models }));
    fs.writeFileSync(path.join(dir, "pricing_overrides.json"), JSON.stringify(overrides));
  }
}

async function loadPricing(models: Record<string, any> = BASE_MODELS, overrides: Record<string, any> = {}): Promise<PriceModule> {
  writeFixtures(models, overrides);
  vi.resetModules();
  const price = await import("../src/core/price");
  price.initPricing(res);
  return price;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-price-"));
  res = path.join(root, "resources");
  fs.mkdirSync(res, { recursive: true });
  // 模块级 TOKEI_DIR 在 import 时求值，所以先改 HOME 再 resetModules
  process.env.HOME = root;
  process.env.USERPROFILE = root;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("模型名规范化", () => {
  it("剥掉自配模型前缀 custom*:（WorkBuddy 的 custom-local:step-5-preview）", async () => {
    const p = await loadPricing();
    expect(p.normalize("custom-local:hy3")).toBe("tencent/hy3");
    expect(p.normalize("custom:claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4.6");
    expect(p.normalize("CUSTOM:gpt-5.5")).toBe("openai/gpt-5.5");
  });

  it("裸模型名到价目表里查：唯一匹配才认，两家同名不认", async () => {
    const p = await loadPricing();
    expect(p.normalize("gamma-3")).toBe("test/gamma-3");
    expect(p.normalize("delta-1")).toBe("delta-1");
    expect(p.normalize("no-such-model-anywhere")).toBe("no-such-model-anywhere");
  });

  it("claude 日期快照与 -latest 同基础版一个价，不当成版本号", async () => {
    const p = await loadPricing();
    expect(p.normalize("claude-opus-5-5-20260921")).toBe("anthropic/claude-opus-5.5");
    expect(p.normalize("claude-sonnet-latest")).toBe("anthropic/claude-sonnet");
  });
});

describe("前驱版本继承", () => {
  it("同档位里找版本不高于它的最近一个", async () => {
    const p = await loadPricing();
    expect(p.predecessorPricingId("test/alpha-1.3-sol-preview")).toBe("test/alpha-1.2-sol");
    expect(p.predecessorPricingId("test/alpha-1.5-sol")).toBe("test/alpha-1.2-sol");
  });

  it("基础款只认基础款：不带档位后缀时退到同版本线的基础款", async () => {
    const p = await loadPricing();
    expect(p.predecessorPricingId("test/alpha-2.0")).toBe("test/alpha-1.0");
    expect(p.predecessorPricingId("test/alpha-1.0")).toBe("test/alpha-1.0");
  });

  it("同版本时正式版优先于 preview", async () => {
    const p = await loadPricing();
    expect(p.predecessorPricingId("test/eps-1.1")).toBe("test/eps-1.0");
  });

  it("不带厂商前缀时，候选来自两家就不认", async () => {
    const p = await loadPricing();
    expect(p.predecessorPricingId("delta-2")).toBeNull();
    expect(p.predecessorPricingId("test/delta-2")).toBe("test/delta-1");
  });

  it("价目表里没有的 OpenRouter 命名按上一版计：gpt-6.2-sol → gpt-6.1-sol", async () => {
    const p = await loadPricing();
    expect(p.predecessorPricingId("openai/gpt-6.2-sol")).toBe("openai/gpt-6.1-sol");
  });
});

describe("pricingId / resolveId 查找顺序", () => {
  it("别名优先于规范化与前驱", async () => {
    const p = await loadPricing(BASE_MODELS, { aliases: { "my-alias": "test/gamma-3" } });
    expect(p.pricingId("my-alias")).toBe("test/gamma-3");
    expect(p.resolveId("my-alias")).toBe("test/gamma-3");
  });

  it("前驱继承排在家族回退之前", async () => {
    const p = await loadPricing();
    expect(p.resolveId("test/alpha-9.9-sol")).toBe("test/alpha-1.2-sol");
    expect(p.pricingId("test/alpha-9.9-sol")).toBe("test/alpha-1.2-sol");
  });

  it("GLM 5.2 价目表缺位时按 5.1 计（临时映射）", async () => {
    const p = await loadPricing();
    expect(p.pricingId("glm-5.2")).toBe("z-ai/glm-5.1");
    // 家族兜底仍然给 5.2 的代表价，绝不落到 Opus
    expect(p.knownIdOrRaw("glm-5.2")).toBe("z-ai/glm-5.2");
  });

  it("查不到价的模型保留原名，不套 Opus 兜底估价", async () => {
    const p = await loadPricing();
    expect(p.pricingId("hunyuan-hurricane")).toBeNull();
    expect(p.hasKnownPrice("hunyuan-hurricane")).toBe(false);
    expect(p.knownIdOrRaw("hunyuan-hurricane")).toBe("hunyuan-hurricane");
  });
});

describe("索引随价目表重建", () => {
  it("initPricing 换目录后裸名与前驱结果跟着变", async () => {
    const first = await loadPricing({ "only/one-2.5": fields(1, 2, 0.1, 0.2) });
    expect(first.normalize("gamma-3")).toBe("gamma-3");
    expect(first.predecessorPricingId("only/one-3.0")).toBe("only/one-2.5");
    const second = await loadPricing();
    expect(second.normalize("gamma-3")).toBe("test/gamma-3");
    expect(second.predecessorPricingId("only/one-3.0")).toBeNull();
  });
});

describe("recalcCosts 标注借用的参考价", () => {
  it("单价来自前驱版本时写 pref，精确命中目录时不写", async () => {
    const p = await loadPricing();
    const { recalcCosts } = await import("../src/core/model");
    const { niceModel } = await import("../src/core/ranges");
    const result = {
      workbuddy: { ranges: { all: { models: [
        { name: "Alpha 1.3 Sol", model_id: "test/alpha-1.3-sol", in: 1e6, out: 1e6, cr: 0, cw: 0, cost: 0 },
        { name: "Gamma 3", model_id: "test/gamma-3", in: 1e6, out: 0, cr: 0, cw: 0, cost: 0 },
      ] } } },
    };
    recalcCosts(result);
    const [borrowed, exact] = result.workbuddy.ranges.all.models;
    // alpha-1.3-sol 目录缺位 → 沿用 alpha-1.2-sol 的 2 / 8，并写明参照
    expect(borrowed.pref).toBe(niceModel("test/alpha-1.2-sol"));
    expect(borrowed.pin).toBe(2);
    expect(borrowed.pout).toBe(8);
    expect(borrowed.cost).toBe(10);
    expect(exact.pref).toBeNull();
    expect(exact.pin).toBe(p.rawPrice("test/gamma-3").in);
  });
});

describe("Claude 长 prompt 分档", () => {
  it("提示（输入+缓存读+缓存写）超 100K 后整次请求乘 5", async () => {
    const p = await loadPricing();
    const { claudeEventCost } = await import("../src/collectors/claude");
    expect(p.resolveId("claude-haiku-5.5")).toBe("anthropic/claude-haiku-5.5");
    const base = { model: "claude-haiku-5.5", out: 1000, cw: 0, cw5: null, cw1: null };
    const long = claudeEventCost({ ...base, in: 60_000, cr: 50_000 });
    const short = claudeEventCost({ ...base, in: 60_000, cr: 39_000 });
    const plain = (60_000 * 0.8 + 1000 * 4) / 1e6;
    // 60_000 + 50_000 = 110K > 100K → 5 倍；60_000 + 39_000 = 99K 不越档
    expect(long).toBeCloseTo((plain + 50_000 * 0.08 / 1e6) * 5, 10);
    expect(short).toBeCloseTo(plain + 39_000 * 0.08 / 1e6, 10);
  });

  it("阈值边界是严格大于：正好 100K 不加倍", async () => {
    await loadPricing();
    const { claudeEventCost } = await import("../src/collectors/claude");
    const at = claudeEventCost({ model: "claude-haiku-5.5", in: 100_000, out: 0, cr: 0, cw: 0, cw5: null, cw1: null });
    const over = claudeEventCost({ model: "claude-haiku-5.5", in: 100_001, out: 0, cr: 0, cw: 0, cw5: null, cw1: null });
    expect(at).toBeCloseTo(100_000 * 0.8 / 1e6, 10);
    expect(over).toBeCloseTo((100_001 * 0.8 / 1e6) * 5, 10);
  });
});

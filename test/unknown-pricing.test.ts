/**
 * 查漏补缺测试（core/unknownPricing.ts + core/localModels.ts ← usage.30s.py 的
 * update_unknown / _scan_local_models / _is_exact_match / _estimate_from_sibling）。
 *
 * 价目表是夹具里那几条、假日志写在临时目录、HOME/APPDATA 全钉在临时路径，
 * 最后一个用例拿传输注入口证明这一趟一个请求都不发（原版也不联网）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type PriceModule = typeof import("../src/core/price");
type UnknownModule = typeof import("../src/core/unknownPricing");
type LocalModule = typeof import("../src/core/localModels");

let root: string;
let home: string;
let res: string;
let tokeiDir: string;
let price: PriceModule;
let unknown: UnknownModule;
let local: LocalModule;

const savedEnv: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** 三条够用：同族两条 max（比字典序）、一条无前缀可依的版本线（测「只有前驱价」不算精确） */
const CATALOG = {
  "qwen/qwen3.8-max": { in: 2.5, out: 10, cache_read: 0.5, cache_write: 3 },
  "qwen/qwen3.7-max": { in: 1.5, out: 6, cache_read: 0.3, cache_write: 2 },
  "test/alpha-1": { in: 2, out: 8, cache_read: 0.2, cache_write: 0.5 },
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-unknown-"));
  home = path.join(root, "home");
  res = path.join(root, "resources");
  tokeiDir = path.join(home, ".tokei");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, "pricing.json"), JSON.stringify({ models: CATALOG }));
  fs.writeFileSync(path.join(res, "pricing_overrides.json"), JSON.stringify({ models: {}, aliases: {} }));
  setEnv("HOME", home);
  setEnv("USERPROFILE", home);
  setEnv("APPDATA", path.join(root, "no-appdata"));
  setEnv("LOCALAPPDATA", path.join(root, "no-localappdata"));
  setEnv("TOKEI_CLAUDE_DIR", path.join(root, "claude"));
  setEnv("TOKEI_GEMINI_DIR", path.join(root, "gemini"));
  setEnv("TOKEI_PI_DIR", path.join(root, "pi"));
  setEnv("TOKEI_WORKBUDDY_DIR", path.join(root, "workbuddy"));
  setEnv("TOKEI_WORKBUDDY_AI_DIR", path.join(root, "workbuddy-ai"));
  setEnv("TOKEI_CODEBUDDY_DIR", path.join(root, "codebuddy"));
  setEnv("QWEN_HOME", path.join(root, "qwen"));
  setEnv("QWEN_RUNTIME_DIR", undefined);
  vi.resetModules();
  // paths.ts 的 HOME/APPDATA 与 claude.ts 的 CLAUDE_DIR 都在导入时定死，必须改完 env 再取模块
  price = await import("../src/core/price");
  unknown = await import("../src/core/unknownPricing");
  local = await import("../src/core/localModels");
  price.initPricing(res);
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function overridesFile(): string {
  return path.join(tokeiDir, "pricing_overrides.json");
}

function seedOverrides(value: unknown): void {
  fs.mkdirSync(tokeiDir, { recursive: true });
  fs.writeFileSync(overridesFile(), typeof value === "string" ? value : JSON.stringify(value));
  price.initPricing(res);
}

function readOverrides(): Record<string, any> {
  return JSON.parse(fs.readFileSync(overridesFile(), "utf8"));
}

function writeJsonl(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

describe("_is_exact_match：有没有精确价", () => {
  it("在册、命中别名、空名与 <synthetic> 都算匹配；只有前驱价不算", () => {
    expect(price.isExactMatch("qwen/qwen3.8-max")).toBe(true);
    expect(price.isExactMatch("")).toBe(true);
    expect(price.isExactMatch("<synthetic>")).toBe(true);
    expect(price.isExactMatch("  Qwen/Qwen3.8-Max ")).toBe(true);
    // 版本线兜底能让它算出钱（resolveId 认前驱），但「查漏补缺」要的就是这种没精确价的
    expect(price.resolveId("test/alpha-2")).toBe("test/alpha-1");
    expect(price.isExactMatch("test/alpha-2")).toBe(false);
    expect(price.isExactMatch("Claude-Sonnet-6.5")).toBe(false);
    seedOverrides({ models: {}, aliases: { "我的模型": "qwen/qwen3.8-max" } });
    expect(price.isExactMatch("我的模型")).toBe(true);
  });
});

describe("_estimate_from_sibling：同族同档借价", () => {
  it("按档位词 + 家族词找候选，字典序最大的那条胜出", () => {
    const estimate = price.estimateFromSibling("qwen3.9-max")!;
    expect(estimate).toMatchObject({ source: "qwen/qwen3.8-max", in: 2.5, out: 10, cache_read: 0.5, cache_write: 3 });
    // 候选缺字段按 0 补（原版 best_p.get(k, 0)）
    expect(price.estimateFromSibling("qwen/next-plus")).toBeNull(); // 有 plus 档但没有 plus 价条目
  });

  it("名字里没有档位词就没有估价，档位词有了但家族不同也没有", () => {
    expect(price.estimateFromSibling("Claude-Sonnet-6.5")).toBeNull();
    expect(price.estimateFromSibling("gpt-5.9-max")).toBeNull(); // max 档有了，目录里没有 gpt-5 家族条目
  });
});

describe("update_unknown：补价与排版", () => {
  it("全部有精确价时只报一句话，一个字都不写", () => {
    seedOverrides({ models: {}, aliases: {} });
    const before = fs.readFileSync(overridesFile(), "utf8");
    const result = unknown.updateUnknown({ resourceDir: res, models: ["qwen/qwen3.8-max", "<synthetic>", ""] });
    expect(result.code).toBe(0);
    // 原版 print(json.dumps(..., ensure_ascii=False))：键序固定、分隔符带空格、中文不转义
    expect(result.stdout).toBe('{"status": "ok", "message": "所有模型价格已匹配", "count": 0, "added": []}');
    expect(fs.readFileSync(overridesFile(), "utf8")).toBe(before);
  });

  it("借到价就写四价 + 别名，条目里不带 source，added 里带", () => {
    const result = unknown.updateUnknown({ resourceDir: res, models: ["qwen3.9-max"] });
    expect(result.count).toBe(1);
    const written = readOverrides();
    expect(written.models["qwen/qwen3.9-max"]).toEqual({ in: 2.5, out: 10, cache_read: 0.5, cache_write: 3 });
    expect(written.aliases["qwen3.9-max"]).toBe("qwen/qwen3.9-max");
    expect(result.stdout).toContain('"method": "estimated from qwen/qwen3.8-max"');
    expect(JSON.parse(result.stdout).added[0].price.source).toBe("qwen/qwen3.8-max");
    // indent=2 且不排序：models 在 aliases 之前，条目内键序就是写入序
    const raw = fs.readFileSync(overridesFile(), "utf8");
    expect(raw).toContain('{\n  "models": {\n    "qwen/qwen3.9-max": {\n      "in": 2.5');
    expect(raw.indexOf('"models"')).toBeLessThan(raw.indexOf('"aliases"'));
  });

  it("借不到价也进 added，但只有本名≠规范名才写别名（原版查的是规范名是否已被占）", () => {
    const bare = unknown.updateUnknown({ resourceDir: res, models: ["test/alpha-2"] });
    expect(bare.count).toBe(1);
    expect(bare.stdout).toContain('"method": "no estimate available, using fallback"');
    expect(readOverrides().aliases).toEqual({});

    seedOverrides({ models: {}, aliases: { "anthropic/claude-sonnet-6.5": "qwen/qwen3.8-max" } });
    const taken = unknown.updateUnknown({ resourceDir: res, models: ["Claude-Sonnet-6.5"] });
    expect(taken.count).toBe(1);
    expect(taken.stdout).toContain('"price": null');
    // 这就是原版那处看着像笔误的判断：norm 已被占用 → 连本名别名都不写，下一轮还是「未知」
    expect(readOverrides().aliases).toEqual({ "anthropic/claude-sonnet-6.5": "qwen/qwen3.8-max" });

    seedOverrides({ models: {}, aliases: {} });
    const fresh = unknown.updateUnknown({ resourceDir: res, models: ["Claude-Sonnet-6.5"] });
    expect(fresh.count).toBe(1);
    expect(readOverrides().aliases).toEqual({ "Claude-Sonnet-6.5": "anthropic/claude-sonnet-6.5" });
  });

  it("重复名字只补一次，写盘坏了返回 1 且不动原文件", () => {
    const result = unknown.updateUnknown({ resourceDir: res, models: ["qwen3.9-max", "qwen3.9-max"] });
    expect(result.count).toBe(1);
    const keep = fs.readFileSync(overridesFile(), "utf8");
    // 占住那个 pid 临时名（写成目录），rename 前的写入必然失败
    fs.mkdirSync(`${overridesFile()}.${process.pid}.tmp`, { recursive: true });
    const broken = unknown.updateUnknown({ resourceDir: res, models: ["qwen3.9-max"] });
    expect(broken.code).toBe(1);
    expect(broken.stdout).toBe("");
    expect(broken.message.startsWith("更新失败:")).toBe(true);
    expect(fs.readFileSync(overridesFile(), "utf8")).toBe(keep);
  });

  it("下一轮进程重读价目表后，上一轮补的名字就算精确匹配了", () => {
    unknown.updateUnknown({ resourceDir: res, models: ["qwen3.9-max"] });
    price.initPricing(res); // 模拟原版「另起一个进程」
    const again = unknown.updateUnknown({ resourceDir: res, models: ["qwen3.9-max"] });
    expect(again.count).toBe(0);
    expect(again.stdout).toContain("所有模型价格已匹配");
  });

  it("overrides 是坏 JSON 就整份按空表起步；合法但没有 models 键也不崩", () => {
    seedOverrides({ models: {}, aliases: {} });
    fs.writeFileSync(overridesFile(), "{坏掉的一半");
    price.initPricing(res);
    const first = unknown.updateUnknown({ resourceDir: res, models: ["qwen3.9-max"] });
    expect(first.count).toBe(1);
    expect(Object.keys(readOverrides().models)).toEqual(["qwen/qwen3.9-max"]);

    seedOverrides({ aliases: { 留着: "qwen/qwen3.8-max" }, 自定义: "别的键" });
    const second = unknown.updateUnknown({ resourceDir: res, models: ["Claude-Sonnet-6.5"] });
    expect(second.count).toBe(1);
    const written = readOverrides();
    expect(written.aliases).toEqual({ 留着: "qwen/qwen3.8-max", "Claude-Sonnet-6.5": "anthropic/claude-sonnet-6.5" });
    expect(written.自定义).toBe("别的键");
    // 没借到价 → 只写别名，models 保持空（原版那条 KeyError 的位置在这里是空表）
    expect(written.models).toEqual({});
  });
});

describe("_scan_local_models：本机日志里的模型名", () => {
  it("claude / gemini / pi / workbuddy / codebuddy / qwen 六路都能收到，坏行与占位名跳过", () => {
    writeJsonl(path.join(root, "claude", "s1.jsonl"), [
      { message: { model: "claude-opus-4-8" } },
      { message: { model: "<synthetic>" } },
      { message: { model: "" } },
    ]);
    fs.writeFileSync(path.join(root, "claude", "s2.jsonl"), '坏行含"model"\n{"message":{"model":"grok-4.6"}}\n', "utf8");
    fs.mkdirSync(path.join(root, "gemini"), { recursive: true });
    fs.writeFileSync(path.join(root, "gemini", "session-1.json"), JSON.stringify({
      sessionId: "g1",
      messages: [
        { id: "m1", type: "gemini", model: "gemini-3-flash", timestamp: "2026-10-01T10:00:00Z", tokens: { input: 10, output: 5 } },
        { id: "m2", type: "gemini", timestamp: "2026-10-01T10:01:00Z", tokens: { input: 1 } },
        { id: "m3", type: "user", model: "不该出现的", timestamp: "2026-10-01T10:02:00Z", tokens: { input: 1 } },
      ],
    }), "utf8");
    writeJsonl(path.join(root, "pi", "p1.jsonl"), [
      // 走网关：请求名是分组名，真实名要补上 provider 前缀才能跟带前缀的写法归并
      { message: { role: "assistant", provider: "magpie", model: "group/router", responseModel: "gpt-5.4", usage: {} } },
      { message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-5", usage: {} } },
      { message: { role: "user", model: "不该出现的", usage: {} } },
      // 两个名字都没有 → _served_identity 兜底成 "unknown"，照样会进名单（原版如此）
      { message: { role: "assistant", usage: {} } },
    ]);
    writeJsonl(path.join(root, "workbuddy", "w1.jsonl"), [
      { usage: {}, providerData: { requestModelName: "deepseek-v4-pro" } },
      { usage: {}, message: { providerData: { requestModelId: "glm-5.2" } } },
      { usage: {}, message: { providerData: { model: "kimi-k3" } } },
      { usage: {}, providerData: {} },
    ]);
    writeJsonl(path.join(root, "codebuddy", "c1.jsonl"), [{ usage: {}, providerData: { requestModelName: "hy3" } }]);
    fs.mkdirSync(path.join(root, "qwen", "usage"), { recursive: true });
    writeJsonl(path.join(root, "qwen", "usage", "token-usage-2026-10.jsonl"), [
      { model: "qwen3.8-max", total_tokens: 10 },
      { model: "qwen3.9-max", total_tokens: 20 },
    ]);
    writeJsonl(path.join(root, "qwen", "usage_record.jsonl"), [
      { models: { "mimo-v2.5-pro": { in: 1 } } },
      { models: "不是字典" },
    ]);

    expect([...local.collectLocalModels()].sort()).toEqual([
      "anthropic/claude-sonnet-5",
      "claude-opus-4-8",
      "deepseek-v4-pro",
      "gemini-3-flash",
      "glm-5.2",
      "grok-4.6",
      "hy3",
      "kimi-k3",
      "magpie/gpt-5.4",
      "mimo-v2.5-pro",
      "qwen3.8-max",
      "qwen3.9-max",
      "unknown",
    ]);
  });
});

describe("主进程外壳", () => {
  it("runUnknownUpdate 全程不碰传输注入口", async () => {
    const main = await import("../src/main/pricingFetch");
    const http = await import("../src/main/quota/http");
    let calls = 0;
    http.setProviderTransport(async () => { calls++; throw new Error("这里不该联网"); });
    try {
      const result = main.runUnknownUpdate(res, ["qwen3.9-max", "Claude-Sonnet-6.5"]);
      expect(result.code).toBe(0);
      expect(result.count).toBe(2);
      expect(calls).toBe(0);
    } finally {
      http.setProviderTransport(null);
    }
  });
});

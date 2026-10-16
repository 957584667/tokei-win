/**
 * Dashboard 数据层（core/dashboard.ts ← usage.30s.py:14283-15465）。
 * 每个用例盯一条口径：逐日成本列、各工具的 token 算法、账本高水位、人民币成本归属、
 * 账号级 provider 行、回顾页的连续/巅峰/成就阶梯。这些数字一旦跑偏，面板上看不出来，
 * 只有对着缓存形状算才知道，所以形状全部手写。
 * 账本一律走临时文件，绝不碰真实的 ~/.tokei/ledger.json。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CURSOR_PROVIDER_DAYS_CACHE_KEY, GEMINI_DAYS_CACHE_KEY, GROK_BOT_PROVIDER_DAYS_CACHE_KEY,
  GROK_DAYS_CACHE_KEY, ZAI_PROVIDER_DAYS_CACHE_KEY,
  buildDailyCosts, buildDashboard, buildWrapped, cacheDashboardDays, codexAccountedDays,
  cnyBreakdown, geminiTokenTotal, mergeDashboardDays, periodCutoff, priceGeminiDays,
} from "../src/core/dashboard";
import { geminiPrice } from "../src/core/price";
import { useLedgerFile } from "../src/core/ledger";
import { niceModel } from "../src/core/ranges";

/** 固定「今天」：2026-10-13 是周二，本周一起于 10-12 */
const NOW = new Date(2026, 9, 13);

let ROOT: string;
let LEDGER: string;
let CONFIG: string;

beforeAll(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tokei-dashboard-"));
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  LEDGER = path.join(ROOT, `ledger-${Math.random().toString(36).slice(2)}.json`);
  CONFIG = path.join(ROOT, `config-${Math.random().toString(36).slice(2)}.json`);
  useLedgerFile(LEDGER, CONFIG);
});

/** 直接写盘造账本：v=1 是 ledger.ts 里的 LEDGER_VERSION，形状变了这里会一起失效。
 *  写完必须重新注入一次，否则 loadLedger 的进程内 memo 还是上一轮的旧账本。 */
function writeLedger(tools: Record<string, any>): void {
  fs.writeFileSync(LEDGER, JSON.stringify({ v: 1, tools }), "utf8");
  useLedgerFile(LEDGER, CONFIG);
}

const codexRecord = (over: Record<string, any> = {}) => ({
  date: "2026-10-05", hour: 3, ts: 1, ts_key: "k", item_id: "i",
  in: 100, out: 20, cr: 5, cw: 3, reason: 7, cost: 0.3, credits: 1.234567,
  model: "glm-5.1", message_id: "m", dedup: "d-1", session: "s-1", line: 1, ...over,
});

describe("_period_cutoff：区间起点", () => {
  it("日/周/月/年/全部各按起点，周从周一算", () => {
    expect(periodCutoff("1d", NOW)).toBe("2026-10-13");
    expect(periodCutoff("7d", NOW)).toBe("2026-10-12");
    expect(periodCutoff("30d", NOW)).toBe("2026-10-01");
    expect(periodCutoff("365d", NOW)).toBe("2026-01-01");
    expect(periodCutoff("all", NOW)).toBeNull();
    expect(periodCutoff()).toBeNull();
  });

  it("周一当天不回退到上周", () => {
    expect(periodCutoff("7d", new Date(2026, 9, 12))).toBe("2026-10-12");
    expect(periodCutoff("7d", new Date(2026, 9, 11))).toBe("2026-10-05");
  });
});

describe("gemini 口径", () => {
  it("input 已含 cached，thoughts 按输出计，cached 超量要夹住", () => {
    expect(geminiTokenTotal({ in: 100, cached: 30, out: 20, thoughts: 5 })).toBe(125);
    expect(geminiTokenTotal({ in: 10, cached: 50, out: 1 })).toBe(11);
  });

  it("日账没成本时按同一条公式逐模型补价，已有成本不动原值", () => {
    const days = {
      "2026-10-05": {
        in: 1_000_000, cached: 200_000, out: 300_000, thoughts: 50_000, cost: 0,
        models: {
          "gemini-2.5-pro": { in: 700_000, cached: 200_000, out: 300_000, thoughts: 50_000, cost: 0 },
          "gemini-2.5-flash": { in: 300_000, cached: 0, out: 0, thoughts: 0, cost: 0 },
        },
      },
      "2026-10-06": { cost: 4.5, models: { "gemini-2.5-pro": { in: 10, out: 10, cost: 4.5 } } },
    };
    const priced = priceGeminiDays(days);
    const p = geminiPrice("gemini-2.5-pro");
    const f = geminiPrice("gemini-2.5-flash");
    expect(priced["2026-10-05"].cost).toBeCloseTo(
      (500_000 / 1e6) * p.in + (200_000 / 1e6) * p.cache_read + (350_000 / 1e6) * p.out
      + (300_000 / 1e6) * f.in, 12,
    );
    expect(priced["2026-10-06"].cost).toBe(4.5);
    // 只改副本，传进来的缓存不能被估价污染
    expect(days["2026-10-05"].cost).toBe(0);
  });
});

describe("日账缓存保留", () => {
  it("内容变了才写，顺带标脏；集合序列化成排序数组", () => {
    const cache: Record<string, any> = {};
    cacheDashboardDays(cache, GROK_DAYS_CACHE_KEY, { "2026-10-05": { sessions: new Set(["b", "a"]) } });
    expect(cache[GROK_DAYS_CACHE_KEY]).toEqual({ "2026-10-05": { sessions: ["a", "b"] } });
    expect(cache._dirty).toBe(true);
    cache._dirty = false;
    cacheDashboardDays(cache, GROK_DAYS_CACHE_KEY, { "2026-10-05": { sessions: ["a", "b"] } });
    expect(cache._dirty).toBe(false);
    expect(cache[GROK_DAYS_CACHE_KEY]).toEqual({ "2026-10-05": { sessions: ["a", "b"] } });
  });

  it("merge：空读数原样返回，历史天不被本轮覆盖掉", () => {
    const cache: Record<string, any> = {};
    mergeDashboardDays(cache, GROK_BOT_PROVIDER_DAYS_CACHE_KEY, { "2026-10-01": { tokens: 5 } });
    mergeDashboardDays(cache, GROK_BOT_PROVIDER_DAYS_CACHE_KEY, {});
    mergeDashboardDays(cache, GROK_BOT_PROVIDER_DAYS_CACHE_KEY, { "2026-10-02": { tokens: 7 } });
    expect(Object.keys(cache[GROK_BOT_PROVIDER_DAYS_CACHE_KEY]).sort()).toEqual(["2026-10-01", "2026-10-02"]);
  });
});

describe("_codex_accounted_days：按模型拆主额度与 Reserve", () => {
  const cache = {
    codex: {
      "rollout-1": {
        days: {
          "2026-10-05": {
            in: 1210, cached: 300, out: 102, reason: 50, cost: 1.0,
            models: {
              "gpt-5": { in: 900, out: 100, cr: 300, cw: 0, reason: 50, cost: 0.9 },
              "gpt-reserve": { in: 10, out: 2, cr: 0, cw: 0, reason: 0, cost: 0.1 },
            },
          },
        },
      },
    },
  };

  it("明细里的 in 是非缓存输入，回日级要加回 cr", () => {
    const main = codexAccountedDays(cache, false)["2026-10-05"];
    expect(main.in).toBe(1200);
    expect(main.cached).toBe(300);
    expect(main.out).toBe(100);
    expect(main.cost).toBeCloseTo(0.9, 12);
    expect(Object.keys(main.models)).toEqual(["gpt-5"]);
  });

  it("Reserve 桶只收 gpt-reserve 那份明细", () => {
    const reserve = codexAccountedDays(cache, true)["2026-10-05"];
    expect(reserve.in).toBe(10);
    expect(reserve.out).toBe(2);
    expect(Object.keys(reserve.models)).toEqual(["gpt-reserve"]);
  });

  it("账本里的历史天补回来，实时值更高时不被存档顶掉", () => {
    writeLedger({
      codex: {
        // 10-05 的存档偏小 → 保留实时值
        "2026-10-05": { in: 10, out: 1, cost: 0.01, models: {} },
        // 日志已清理，只剩存档
        "2026-09-01": { in: 500, cached: 100, out: 50, reason: 9, cost: 0.2, models: {} },
      },
    });
    const days = codexAccountedDays(cache, false);
    expect(days["2026-10-05"].in).toBe(1200);
    expect(days["2026-09-01"].in).toBe(500);
    expect(days["2026-09-01"].cost).toBe(0.2);
  });
});

describe("build_daily_costs：逐日成本列", () => {
  const cache = () => ({
    claude: {
      "D:/log/a.jsonl": {
        proj: "D:/work/alpha",
        days: {
          "2026-10-05": {
            in: 1000, out: 200, cr: 500, cw: 100, reason: 42, cost: 2.5,
            models: { "claude-opus-4-7": { in: 1000, out: 200, cr: 500, cw: 100, cost: 2.5 } },
          },
        },
      },
    },
    codex: {
      "rollout-1": {
        days: {
          "2026-10-05": {
            in: 1210, cached: 300, out: 102, reason: 50, cost: 1.0,
            models: {
              "gpt-5": { in: 900, out: 100, cr: 300, cw: 0, reason: 50, cost: 0.9 },
              "gpt-reserve": { in: 10, out: 2, cr: 0, cw: 0, reason: 0, cost: 0.1 },
            },
          },
        },
      },
    },
    // opencode 没有独立成本列，只并进 total
    opencode: { "db:o": { days: { "2026-10-05": { in: 10, out: 5, cost: 0.7, models: {} } } } },
    codebuddy: { F1: { proj: "D:/p/cb", sid: "s-1", records: [codexRecord()] } },
  });

  it("各工具写自己的列，tokens 用各自的口径", () => {
    const { daily } = buildDailyCosts(cache(), "all", NOW);
    expect(daily.length).toBe(1);
    const row = daily[0];
    expect(row.date).toBe("2026-10-05");
    expect(row.claude).toBe(2.5);
    expect(row.codex).toBe(0.9);
    expect(row.codex_reserve).toBe(0.1);
    expect(row.codebuddy).toBe(0.3);
    expect(row.total).toBeCloseTo(2.5 + 0.9 + 0.1 + 0.7 + 0.3, 10);
    expect(row).not.toHaveProperty("opencode");
    expect(row.c_in).toBe(1000);
    expect(row.c_cw).toBe(100);
    expect(row.x_in).toBe(1200);
    expect(row.x_cached).toBe(300);
    expect(row.xr_in).toBe(10);
    expect(row.cb_in).toBe(100);
    // claude 的 reason 不进 token；会话数不进 payload
    expect(row.tokens).toBe(1800 + 1300 + 12 + 15 + 135);
    expect(row).not.toHaveProperty("sessions");
    expect(row.cb_credits).toBe(1.235);
  });

  it("区间起点之前的整天丢掉", () => {
    expect(buildDailyCosts(cache(), "7d", NOW).daily).toEqual([]);
    expect(buildDailyCosts(cache(), "30d", NOW).daily.length).toBe(1);
  });

  it("模型行按 -成本、-token 排序，cost_per_k 与 out_ratio 各自取整", () => {
    const { models } = buildDailyCosts(cache(), "all", NOW);
    expect(models[0].name).toBe("Opus 4.7");
    const claude = models.find((m) => m.name === "Opus 4.7")!;
    expect(claude).toMatchObject({ tool: "claude", cost: 2.5, tokens: 1800, in: 1000, out: 200, cr: 500, cw: 100 });
    expect(claude.cost_per_k).toBe(12.5);
    expect(claude.out_ratio).toBe(11.1);
    const cx = models.find((m) => m.name === `${niceModel("gpt-5")} (Codex)`)!;
    expect(cx).toMatchObject({ tool: "codex", tokens: 1300, cost: 0.9, reason: 50 });
    const reserve = models.find((m) => m.name === "Luna Reserve (Codex Reserve)")!;
    expect(reserve.tokens).toBe(12);
  });

  it("只有账本里没有模型明细时，用汇总成本兜一行 GPT-5.5 (Codex)", () => {
    writeLedger({ codex: { "2026-09-01": { in: 300, cached: 100, out: 50, reason: 9, cost: 0.4, models: {} } } });
    const { models } = buildDailyCosts({ codex: {} }, "all", NOW);
    const row = models.find((m) => m.name === "GPT-5.5 (Codex)")!;
    expect(row).toMatchObject({ tool: "codex", cost: 0.4, in: 300, out: 50, reason: 9 });
  });

  it("账本高水位：同一天取 max 不相加，缺席的天补进序列", () => {
    writeLedger({
      claude: {
        "2026-10-05": { in: 500, out: 100, cost: 9, models: {} },
        "2026-09-01": { in: 700, out: 100, cost: 4, models: {} },
      },
    });
    const { daily } = buildDailyCosts(cache(), "all", NOW);
    expect(daily.map((d) => d.date)).toEqual(["2026-09-01", "2026-10-05"]);
    const today = daily[1];
    expect(today.claude).toBe(9); // 成本取 max
    expect(today.tokens).toBe(1800 + 1300 + 12 + 15 + 135); // 600 < 1800，不补差
    const archived = daily[0];
    expect(archived.tokens).toBe(800);
    expect(archived.claude).toBe(4);
  });

  it("人民币成本按天与按工具落到行上，账本存档优先", () => {
    const cnyCache = {
      deepseek_harness: {
        S1: {
          proj: "D:/p/ds", sid: "sess",
          records: [{ date: "2026-10-05", ts: 1, turn: 1, step: 1, priority: 1, model: "deepseek-v4-pro", provider: "deepseek-official", in: 20, out: 5, cr: 0, cw: 0, reason: 0, cost: 0, cost_cny: 1.5 }],
        },
      },
      opencode: {
        "db:o": { days: { "2026-10-05": { in: 10, out: 5, cost: 0, models: { "deepseek-v4-pro": { in: 10, out: 5, cost: 0, cost_cny: 0.25 } } } } },
      },
    };
    const { daily, models } = buildDailyCosts(cnyCache, "all", NOW);
    expect(daily[0].cost_cny).toBeCloseTo(1.75, 10);
    expect(daily[0].cny_by_tool).toEqual({ deepseek_harness: 1.5, opencode: 0.25 });
    expect(models.find((m) => m.tool === "deepseek_harness")!.cost_cny).toBe(1.5);
    expect(models.find((m) => m.tool === "opencode")!.cost_cny).toBe(0.25);

    writeLedger({
      opencode: { "2026-10-05": { in: 10, out: 5, cost: 0, cost_cny: 9, models: { "deepseek-v4-pro": { in: 10, out: 5, cost_cny: 9 } } } },
    });
    expect(cnyBreakdown(cnyCache, null).daily["2026-10-05"]).toBeCloseTo(10.5, 10);
  });

  it("账号级 provider 行进 provider_models，grok bot 并进 models", () => {
    const providerCache = {
      [CURSOR_PROVIDER_DAYS_CACHE_KEY]: {
        "2026-10-05": {
          models: {
            "gemini-3-flash": { in: 100, out: 20, tokens: 120, cost: 0.4 },
            "claude-opus-4-7": { in: 50, out: 10, cost: 0.2 },
          },
        },
      },
      [ZAI_PROVIDER_DAYS_CACHE_KEY]: {
        "2026-10-03": { models: { "glm-5.1": { in: 1, out: 1, tokens: 2, cost: 0 } } },
      },
      [GROK_BOT_PROVIDER_DAYS_CACHE_KEY]: {
        "2026-10-05": { models: { "x-ai/grok-4.6": { in: 7, out: 3, tokens: 10, cost: 0.5 } } },
      },
    };
    const { daily, models, provider_models } = buildDailyCosts(providerCache, "all", NOW);
    // 账号日账只出模型行，不造逐日成本行
    expect(daily).toEqual([]);
    expect(provider_models.map((m) => m.name)).toEqual([
      `${niceModel("gemini-3-flash")} (Cursor 账号)`,
      `${niceModel("claude-opus-4-7")} (Cursor 账号)`,
      `${niceModel("glm-5.1")} (z.ai 账号)`,
    ]);
    // 没写 tokens 的行退回五字段相加
    expect(provider_models[1].tokens).toBe(60);
    expect(provider_models[0]).not.toHaveProperty("credits");
    const bot = models.find((m) => m.tool === "grok_bot")!;
    expect(bot).toMatchObject({ name: niceModel("x-ai/grok-4.6"), tokens: 10, cost: 0.5 });
  });

  it("空缓存出空表，不抛异常", () => {
    expect(buildDailyCosts({}, "all", NOW)).toEqual({ daily: [], models: [], provider_models: [] });
  });
});

describe("build_wrapped：回顾页", () => {
  const hourRow = (slots: Record<number, number>) => {
    const row = new Array(24).fill(0);
    for (const [h, v] of Object.entries(slots)) row[Number(h)] = v;
    return row;
  };
  const cache = () => ({
    claude: {
      f1: {
        proj: "D:/work/alpha",
        days: {
          "2026-10-11": { in: 1000, out: 200, cr: 0, cw: 0, reason: 0, cost: 1.5, models: { "claude-opus-4-7": { in: 1000, out: 200 } } },
          "2026-10-12": { in: 500, out: 100, cr: 0, cw: 0, reason: 0, cost: 0.5, models: {} },
        },
        day_hours: { "2026-10-11": hourRow({ 2: 100, 14: 900 }) },
      },
    },
  });

  it("空缓存出一堆零，不抛异常", () => {
    const w = buildWrapped({}, "all", NOW);
    expect(w.total_tokens).toBe(0);
    expect(w.active_days).toBe(0);
    expect(w.streak_max).toBe(0);
    expect(w.busiest).toEqual({ date: "", tokens: 0 });
    expect(w.peak_days).toEqual([]);
    expect(w.top_model).toEqual({ name: "-", tokens: 0 });
    expect(w.hours.length).toBe(24);
    expect(w.weekday.length).toBe(7);
    expect(w.projects).toEqual([]);
    expect(w.achievements).toEqual([]);
    expect(w.first_day).toBe("");
  });

  it("总量 / 连续 / 巅峰日 / 项目 / 模型一并出，巅峰日带项目名", () => {
    const w = buildWrapped(cache(), "all", NOW);
    expect(w.total_tokens).toBe(1800);
    expect(w.total_cost).toBe(2);
    expect(w.active_days).toBe(2);
    expect(w.streak_max).toBe(2);
    expect(w.streak_cur).toBe(2); // 最近活跃日是昨天
    expect(w.busiest).toEqual({ date: "2026-10-11", tokens: 1200 });
    expect(w.peak_days).toEqual([
      { date: "2026-10-11", tokens: 1200, projects: ["alpha"] },
      { date: "2026-10-12", tokens: 600, projects: ["alpha"] },
    ]);
    expect(w.day_projects["2026-10-11"]).toEqual(["alpha"]);
    expect(w.top_model).toEqual({ name: "Opus 4.7", tokens: 1200 });
    expect(w.projects).toEqual([{ name: "alpha", tokens: 1800, cost: 2, cost_cny: 0 }]);
    expect(w.max_projs_day).toBe(1);
    expect(w.first_day).toBe("2026-10-11");
    expect(w.period).toBe("all");
  });

  it("作息按 hour / day_hours 累计，凌晨与周末占比算成就", () => {
    const w = buildWrapped(cache(), "all", NOW);
    expect(w.hours[2]).toBe(100);
    expect(w.hours[14]).toBe(900);
    expect(w.night_share).toBe(10);
    // 2026-10-11 是周日（周一=0），10-12 是周一
    expect(w.weekday[6]).toBe(1200);
    expect(w.weekday[0]).toBe(600);
    expect(w.achievements.map((a) => a.title)).toEqual(["专一", "夜猫子", "周末战士"]);
    expect(w.achievements[0]).toMatchObject({ icon: "scope", tint: "blue", desc: "主项目占 100%" });
    expect(w.achievements[0]).not.toHaveProperty("tokens");
  });

  it("逐小时明细型走 hours 数组，短数组不越界", () => {
    const w = buildWrapped({ opencode: { d: { day: { date: "2026-10-11", in: 10, out: 5, cost: 0.1, hours: [0, 0, 15] } } } }, "all", NOW);
    expect(w.total_tokens).toBe(15);
    expect(w.hours[2]).toBe(15);
    expect(w.top_model.name).toBe("-");
  });

  it("里程碑成就带原始数与模板，「亿」没法套模板所以只有中文 desc", () => {
    const big = {
      claude: {
        f1: {
          proj: "D:/work/alpha",
          days: { "2026-10-12": { in: 1_200_000_000, out: 0, cr: 0, cw: 0, cost: 1200, models: {} } },
          day_hours: { "2026-10-12": hourRow({ 3: 1_200_000_000 }) },
        },
      },
    };
    const w = buildWrapped(big, "all", NOW);
    const titles = w.achievements.map((a) => a.title);
    expect(titles).toContain("十亿先生");
    expect(titles).toContain("破千刀");
    expect(titles).toContain("爆肝日");
    const billion = w.achievements.find((a) => a.title === "十亿先生")!;
    expect(billion).toMatchObject({ tokens: 1_200_000_000, tokens_template: "%@ token", desc: "12.0 亿 token" });
    expect(w.achievements.find((a) => a.title === "破千刀")).toMatchObject({ desc: "≈$1,200" });
  });

  it("账本兜底：日志清空后总量、活跃天与归档项目名还在", () => {
    writeLedger({
      claude: {
        "2026-10-11": { in: 5000, out: 0, cost: 7, models: {} },
        "2026-08-02": { in: 900, out: 100, cost: 1, models: {}, projects: ["归档名", ""] },
      },
    });
    const w = buildWrapped(cache(), "all", NOW);
    expect(w.total_tokens).toBe(5000 + 600 + 1000); // 10-11 取 max，不与实时相加；08-02 只剩存档
    expect(w.active_days).toBe(3);
    expect(w.busiest).toEqual({ date: "2026-10-11", tokens: 5000 });
    // 只剩存档的那天照样成行，归档名从 day.projects 补回
    expect(w.peak_days.map((p) => p.date)).toEqual(["2026-10-11", "2026-08-02", "2026-10-12"]);
    expect(w.peak_days[0].projects).toEqual(["alpha"]);
    expect(w.peak_days[1].projects).toEqual(["归档名"]);
    expect(w.day_projects["2026-08-02"]).toEqual(["归档名"]);
    expect(w.streak_max).toBe(2);
  });

  it("区间起点决定 first_day 与统计范围", () => {
    const w = buildWrapped(cache(), "1d", NOW);
    expect(w.total_tokens).toBe(0);
    expect(w.first_day).toBe("2026-10-13");
    expect(w.period).toBe("1d");
  });
});

describe("build_dashboard", () => {
  it("同一份缓存同时出逐日、模型与回顾", () => {
    const cache = {
      claude: {
        f1: {
          proj: "D:/work/alpha",
          days: { "2026-10-11": { in: 1000, out: 200, cr: 0, cw: 0, reason: 0, cost: 1.5, models: { "claude-opus-4-7": { in: 1000, out: 200, cost: 1.5 } } } },
        },
      },
    };
    const payload = buildDashboard(cache, "all", NOW);
    expect(Object.keys(payload)).toEqual(["daily", "models", "provider_models", "wrapped"]);
    expect(payload.daily[0].tokens).toBe(1200);
    expect(payload.wrapped.total_tokens).toBe(payload.daily.reduce((s, d) => s + d.tokens, 0));
    expect(payload.models[0]).toMatchObject({ name: "Opus 4.7", cost: 1.5, tokens: 1200 });
  });

  it("保留键写入缓存后，逐日成本才看得见 gemini 与 grok", () => {
    const cache: Record<string, any> = {};
    cacheDashboardDays(cache, GEMINI_DAYS_CACHE_KEY, priceGeminiDays({
      "2026-10-11": { in: 1000, cached: 0, out: 500, thoughts: 0, cost: 0, models: { "gemini-2.5-pro": { in: 1000, cached: 0, out: 500, thoughts: 0, cost: 0 } } },
    }));
    cacheDashboardDays(cache, GROK_DAYS_CACHE_KEY, {
      "2026-10-11": { in: 70, out: 30, cr: 0, cw: 0, reason: 0, cost: 0.2, models: {} },
    });
    const { daily, models } = buildDailyCosts(cache, "all", NOW);
    expect(daily[0].gemini).toBeGreaterThan(0);
    expect(daily[0].grok).toBe(0.2);
    expect(daily[0].tokens).toBe(1500 + 100);
    expect(models.map((m) => m.tool)).toEqual(["gemini"]);
    expect(cache._dirty).toBe(true);
  });
});

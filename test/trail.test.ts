/**
 * 项目足迹聚合：口径必须与 usage.30s.py 的 _project_contributions()/projects() 一致。
 * 每个用例盯一条规则 —— 记不记成本、会话按条目还是按 sid、tokens 用哪个函数数、
 * 路径以什么为键。这些是缓存形状决定的，改采集器时最容易悄悄跑偏。
 */
import { describe, expect, it } from "vitest";
import { projectContributions, projectDayNames, projectTrail } from "../src/core/trail";
import { grokUsageCost } from "../src/collectors/grok";
import { niceModel } from "../src/core/ranges";

const P = (cache: Record<string, any>, path: string) =>
  projectTrail(cache).find((p) => p.path === path);

describe("文件型工具（_PROJECT_SOURCES）", () => {
  const cache = {
    claude: {
      "D:/log/a.jsonl": {
        proj: "D:/work/alpha",
        days: {
          "2026-09-30": { in: 100, out: 50, cr: 20, cw: 10, cost: 1.5, models: { "claude-opus-4-7": { in: 100, out: 50, cr: 20, cw: 10 } } },
          "2026-10-02": { in: 10, out: 5, cr: 0, cw: 0, cost: 0.25, models: {} },
        },
      },
      "D:/log/b.jsonl": {
        proj: "D:/work/beta",
        days: { "2026-10-01": { in: 7, out: 3, cr: 0, cw: 0, cost: 0.5, models: {} } },
      },
    },
  };

  it("token 口径 = in+out+cr+cw+reason，成本照记", () => {
    const hit = [...projectContributions(cache)].find((h) => h.day === "2026-09-30")!;
    expect(hit.tokens).toBe(180);
    expect(hit.cost).toBe(1.5);
    expect(hit.label).toBe("Claude");
  });

  it("同一项目的不同写法合并成一行（尾斜杠 / 盘符大小写 / 斜杠方向）", () => {
    const merged = projectTrail({
      claude: {
        a: { proj: "D:/work/alpha", days: { "2026-10-02": { in: 10, out: 5, cr: 0, cw: 0, cost: 0.25, models: {} } } },
        b: { proj: "D:\\work\\alpha\\", days: { "2026-10-01": { in: 7, out: 3, cr: 0, cw: 0, cost: 0.5, models: {} } } },
        c: { proj: "d:/WORK/alpha", days: { "2026-10-03": { in: 1, out: 1, cr: 0, cw: 0, cost: 0.1, models: {} } } },
      },
    });
    expect(merged.length).toBe(1);
    expect(merged[0].tokens).toBe(15 + 10 + 2);
    expect(merged[0].cost).toBe(0.85);
    expect(merged[0].sessions).toBe(3);
    expect(merged[0].last_active).toBe("2026-10-03");
    // 展示与打开用的是最近活跃那份原文，Windows 上照样能进目录
    expect(merged[0].path).toBe("d:/WORK/alpha");
    expect(merged[0].name).toBe("alpha");
  });

  it("last_active 取最大日期，top_model 取 token 最多的模型，工具名排序", () => {
    const p = P(cache, "D:/work/alpha")!;
    expect(p.last_active).toBe("2026-10-02");
    expect(p.top_model).toBe("Opus 4.7 (Claude)");
    expect(p.tools).toEqual(["claude"]);
    expect(p.name).toBe("alpha");
    expect(p.cost).toBe(1.75);
  });

  it("proj 缺失或为 ? 的条目不参与足迹", () => {
    const junk = { claude: { x: { days: { "2026-10-01": { in: 9, out: 0, cost: 9 } } }, y: { proj: "?", days: { "2026-10-01": { in: 9, out: 0 } } } } };
    expect(projectTrail(junk)).toEqual([]);
  });
});

describe("口径差异按工具指定", () => {
  it("Kimi 不记成本，会话按 sid 跨条目去重", () => {
    const cache = {
      kimicode: {
        "w1": { proj: "D:/p/kimi", sid: "s-1", days: { "2026-10-01": { in: 10, out: 5, cost: 3, models: {} } } },
        "w2": { proj: "D:/p/kimi", sid: "s-1", days: { "2026-10-01": { in: 1, out: 1, cost: 3, models: {} } } },
        "w3": { proj: "D:/p/kimi", sid: "s-2", days: { "2026-10-02": { in: 2, out: 0, cost: 3, models: {} } } },
      },
    };
    const p = P(cache, "D:/p/kimi")!;
    expect(p.cost).toBe(0);
    expect(p.sessions).toBe(2);
    expect(p.tokens).toBe(19);
    expect(p.last_active).toBe("2026-10-02");
  });

  it("Muse Code 的推理并进输出，计数不能再加 reason", () => {
    const cache = {
      musecode: {
        f: { proj: "D:/p/muse", sid: "m-1", days: { "2026-10-01": { in: 10, out: 6, cr: 1, cw: 2, reason: 4, cost: 0.1, models: {} } } },
      },
    };
    const hit = [...projectContributions(cache)][0];
    expect(hit.tokens).toBe(19);
    expect(hit.cost).toBe(0.1);
  });

  it("codex / pi / prime_agent / cmdcode 各按自己的缓存键出贡献", () => {
    const day = { in: 1, out: 1, cr: 0, cw: 0, reason: 0, cost: 0, models: {} };
    const cache = {
      codex: { "rollout-1": { proj: "D:/p/cx", days: { "2026-10-01": day } } },
      pi: { "pi-1": { proj: "D:/p/pi", sid: "ps", days: { "2026-10-01": day } } },
      prime_agent: { "pr-1": { proj: "D:/p/pr", days: { "2026-10-01": day } } },
      cmdcode: { "cc-1": { proj: "D:/p/cc", sid: "cs", days: { "2026-10-01": day } } },
    };
    const byName = Object.fromEntries(projectTrail(cache).map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(["cc", "cx", "pi", "pr"]);
    // entry 型按条目计数，sid 型按 sid 计数，两者此处都是 1
    expect(byName.cx.sessions).toBe(1);
    expect(byName.pi.sessions).toBe(1);
    expect(byName.cx.tokens).toBe(2);
  });
});

describe("记录型工具（_PROJECT_RECORD_SOURCES）", () => {
  const rec = (over: Record<string, any>) => ({
    date: "2026-10-01", hour: 3, ts: 1, ts_key: "k", item_id: "i",
    in: 10, out: 5, cr: 0, cw: 0, reason: 0, cost: 0.4, credits: 0,
    model: "glm-5.1", message_id: "m", dedup: "d-1", session: "s-1", line: 1, ...over,
  });

  it("WorkBuddy 的同一条记录跨文件只算一次，取 token 多的那份", () => {
    const cache = {
      workbuddy: {
        "F1": { proj: "D:/p/wb", sid: "s-1", records: [rec({ dedup: "same", in: 10 })] },
        "F2": { proj: "D:/p/wb", sid: "s-1", records: [rec({ dedup: "same", in: 30 })] },
      },
    };
    const p = P(cache, "D:/p/wb")!;
    expect(p.tokens).toBe(35);
    expect(p.cost).toBe(0.4);
    expect(p.sessions).toBe(1);
    // 展示名规则：`niceModel(模型) (工具显示名)`
    expect(p.top_model).toBe(`${niceModel("glm-5.1")} (WorkBuddy)`);
  });

  it("workbuddy_ai 与 codebuddy 各自成一条工具线，同项目可合并", () => {
    const cache = {
      workbuddy_ai: { "A": { proj: "D:/p/shared", sid: "a1", records: [rec({ dedup: "a" })] } },
      codebuddy: { "B": { proj: "D:/p/shared", sid: "b1", records: [rec({ dedup: "b", session: "b2" })] } },
    };
    const p = P(cache, "D:/p/shared")!;
    expect(p.tools).toEqual(["codebuddy", "workbuddy_ai"]);
    expect(p.sessions).toBe(2);
  });

  it("DeepSeek Harness 没有模型名时回落默认模型，人民币成本单独累计", () => {
    const cache = {
      deepseek_harness: {
        "S1": {
          proj: "D:/p/ds", sid: "sess",
          records: [{
            date: "2026-10-03", ts: 1, turn: 1, step: 1, priority: 1, model: "", provider: "deepseek-official",
            in: 20, out: 5, cr: 0, cw: 0, reason: 0, cost: 0, cost_cny: 1.234,
          }],
        },
      },
    };
    const p = P(cache, "D:/p/ds")!;
    expect(p.tokens).toBe(25);
    expect(p.top_model).toBe(`${niceModel("deepseek-v4-pro")} (DeepSeek Harness)`);
    expect(p.cost_cny).toBe(1.23);
    expect(p.sessions).toBe(1);
  });
});

describe("Grok（按天按项目）", () => {
  const cache = {
    grok: {
      "D:/sessions/g1/summary.json": {
        sig: "a", mtime: 1_000, date: "2026-10-04", sid: "gx-1", model: "x-ai/grok-4.6",
        project: "D:/p/gx", tokens: 999, turns: 1,
      },
      // 同一 sid 的旧快照必须被丢掉，否则会话数与项目归属都会翻倍
      "D:/sessions/g1-copy/summary.json": {
        sig: "b", mtime: 500, date: "2026-10-04", sid: "gx-1", model: "x-ai/grok-4.6",
        project: "D:/p/gx", tokens: 999, turns: 1,
      },
    },
    grok_usage: {
      sig: "u",
      // 不带时区的 ISO 串按本地时间解析（与 Python 的 fromtimestamp 同口径），
      // 用正午避免测试机时区把日期推到前一天
      records: [
        { id: "r1", ts: "2026-10-04T12:00:00", sid: "gx-1", in: 1000, cr: 500, out: 200, reason: 100 },
        { id: "r2", ts: "2026-10-04T13:00:00", sid: "gx-1", in: 10, cr: 0, out: 5, reason: 0 },
      ],
    },
  };

  it("token 来自 usage 记录并按天按项目合并，成本逐请求计价", () => {
    const hits = [...projectContributions(cache)].filter((h) => h.tool === "grok");
    expect(hits.length).toBe(1);
    const hit = hits[0];
    expect(hit.day).toBe("2026-10-04");
    expect(hit.tokens).toBe(1000 + 500 + 200 + 100 + 10 + 5);
    expect(hit.cost).toBe(
      grokUsageCost({ in: 1000, cr: 500, out: 200, reason: 100 }, "x-ai/grok-4.6")
      + grokUsageCost({ in: 10, cr: 0, out: 5, reason: 0 }, "x-ai/grok-4.6"),
    );
    expect(hit.label).toBe("Grok Build");
    expect(hit.models).toEqual({ [`${niceModel("x-ai/grok-4.6")} (Grok Build)`]: 1815 });
  });

  it("一个会话贡献一次会话数", () => {
    const p = P(cache, "D:/p/gx")!;
    expect(p.sessions).toBe(1);
    expect(p.tools).toEqual(["grok"]);
    expect(p.last_active).toBe("2026-10-04");
    expect(p.tokens).toBe(1815);
  });
});

describe("数据库型工具的按天×按项目桶（_PROJECT_DAY_SOURCES）", () => {
  const cache = {
    hermes: {
      "D:/hermes/state.db": {
        version: 2, sig: "s",
        days: {
          "2026-10-04": {
            in: 120, out: 12, cr: 5, cw: 2, reason: 1, cost: 0.25, sessions: 2, models: {},
            projects: {
              "D:/work/erp": { tokens: 118, cost: 0.2, models: { "anthropic/claude-opus-4.8": 118 }, sessions: ["h1"] },
              "D:/work/api": { tokens: 22, cost: 0.05, models: { "gpt-5": 22 }, sessions: ["h2", ""] },
            },
          },
          "2026-10-01": {
            in: 3, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, sessions: 1, models: {},
            projects: { "D:/work/erp": { tokens: 3, cost: 0, models: {}, sessions: ["h3"] } },
          },
          // 账本归档写的名字列表：不是逐项目用量，整天跳过
          "2026-09-30": { in: 9, out: 0, cr: 0, cw: 0, reason: 0, cost: 0, sessions: 1, models: {}, projects: ["erp", "归档名"] },
        },
      },
    },
    minimax: {
      "db:D:/mm.sqlite": {
        version: 1, sig: "m",
        days: { "2026-10-03": {
          in: 40, out: 4, cr: 6, cw: 1, reason: 3, cost: 0.02, sessions: 1, models: {},
          projects: { "D:/work/mm": { tokens: 54, cost: 0.02, models: { "anthropic/claude-sonnet-4.6": 54 }, sessions: ["m1", "m1"] } },
        } },
      },
    },
    // 桶缺席的其它数据库工具（devin/opencode/mimocode）不能被这条分支造出行
    devin: { "db:D:/devin.db": { days: { "2026-10-02": { in: 1, out: 1, cr: 0, cw: 0, reason: 0, cost: 0, sessions: [], models: {} } } } },
  };

  it("桶里的 token/成本/模型/会话直接进贡献流，模型名带工具后缀", () => {
    const hits = [...projectContributions(cache)].filter((h) => h.tool === "hermes");
    expect(hits.length).toBe(3); // 10-04 两个项目 + 10-01 一个；09-30 的名字列表不算
    const erp = hits.find((h) => h.day === "2026-10-01")!;
    expect(erp.path).toBe("D:/work/erp");
    expect(erp.tokens).toBe(3);
    expect(erp.cost).toBe(0);
    expect(erp.label).toBe("Hermes");
    const api = hits.find((h) => h.path === "D:/work/api")!;
    expect(api.models).toEqual({ "GPT-5 (Hermes)": 22 });
    expect([...projectContributions(cache)].some((h) => h.day === "2026-09-30")).toBe(false);
  });

  it("会话是数组：空 id 丢掉，重复 id 由足迹去重", () => {
    const hit = [...projectContributions(cache)].find((h) => h.tool === "minimax")!;
    expect(hit.session).toEqual(["m1", "m1"]);
    expect(P(cache, "D:/work/mm")!.sessions).toBe(1);
    expect(P(cache, "D:/work/api")!.sessions).toBe(1); // ["h2", ""] 里的空串不算会话
  });

  it("多个项目的行按天汇总，账本名字列表不进足迹", () => {
    const list = projectTrail(cache);
    expect(list.map((p) => p.name).sort()).toEqual(["api", "erp", "mm"]);
    const erp = P(cache, "D:/work/erp")!;
    expect(erp.tokens).toBe(121);
    expect(erp.cost).toBe(0.2);
    expect(erp.sessions).toBe(2);
    expect(erp.tools).toEqual(["hermes"]);
    expect(list.some((p) => p.name === "归档名")).toBe(false);
  });

  it("projectDayNames：{日期: {项目名}}，与足迹同源、无日期的跳过", () => {
    expect(projectDayNames(cache)).toEqual({
      "2026-10-04": ["api", "erp"],
      "2026-10-03": ["mm"],
      "2026-10-01": ["erp"],
    });
  });
});

describe("聚合与排序", () => {
  it("按 last_active 倒序，成本两位四舍五入", () => {
    const day = (n: number) => ({ in: n, out: 0, cr: 0, cw: 0, reason: 0, cost: 0.005, models: {} });
    const cache = {
      claude: {
        f1: { proj: "D:/p/old", days: { "2026-01-01": day(1) } },
        f2: { proj: "D:/p/new", days: { "2026-10-05": day(2) } },
        f3: { proj: "D:/p/mid", days: { "2026-06-06": day(3) } },
      },
    };
    const list = projectTrail(cache);
    expect(list.map((p) => p.name)).toEqual(["new", "mid", "old"]);
    expect(list[0].cost).toBe(0.01);
  });

  it("缓存里没有项目键时返回空数组，不抛异常", () => {
    expect(projectTrail({})).toEqual([]);
    expect(projectTrail({ claude: {}, codex: null, grok: undefined })).toEqual([]);
  });
});

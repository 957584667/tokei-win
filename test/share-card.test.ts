/**
 * 分享卡数据（core/shareCard.ts ← UsageSummaryBuilder 的 toolLines / totals / formatUpdatedLine）。
 * 纯函数，不落盘、不联网。
 */
import { describe, expect, it } from "vitest";
import {
  SHARE_MULTI_WIDTH, SHARE_SINGLE_WIDTH, buildShareSpec, formatUpdatedLine, shareLines, shareTotals,
} from "../src/core/shareCard";

/** 一份最小 payload：字段名照 compute() 的产物，数值只求能算清 */
function payload(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    claude: { ranges: { today: { in: 100, out: 50, cr: 300, cw: 20, cost: 1.25, sessions: 3, hit: 60 } } },
    codex: {
      ranges: { today: { in: 10, cached: 40, out: 5, reason: 2, cost: 0.5, sessions: 1, hit: 80 } },
      reserve_ranges: { today: { in: 1, cached: 2, out: 3, reason: 4, cost: 0.1, sessions: 1, hit: 50 } },
    },
    gemini: { ranges: { today: { in: 7, out: 8, cached: 9, thoughts: 10, cost: 0, sessions: 2, hit: 0 } } },
    grok: { ranges: { today: { usage_available: true, in: 1, out: 2, cr: 3, reason: 4, usage_calls: 9, usage_sessions: 5, sessions: 2, cost: 0.7, hit: 30 } } },
    kimicode: { ranges: { today: { in: 1, out: 1, cr: 1, cw: 1, reason: 0, cost: 9, cost_cny: 60, sessions: 1, hit: 0 } } },
    musecode: { ranges: { today: { in: 10, out: 20, cr: 0, cw: 0, reason: 5, cost: 0, sessions: 1, hit: 0 } } },
    qoder: { ranges: { today: { in: 4, cached: 6, out: 2, calls: 7, sessions: 1, ctx: 42 } } },
    zcode: { ranges: { today: { in: 1, out: 2, cr: 3, cw: 4, reason: 0, cost: 0.2, cost_cny: 1.4, sessions: 1, hit: 0 } } },
    ...overrides,
  };
}

const find = (lines: any[], id: string) => lines.find((l) => l.id === id);

describe("shareLines", () => {
  it("按 Swift 的顺序出卡，token 口径逐家核对", () => {
    const lines = shareLines(payload(), "today");
    expect(lines.map((l) => l.id)).toEqual([
      "claude", "codex", "codex_reserve", "gemini", "grok", "qoder", "zcode", "kimicode", "musecode",
    ]);
    expect(find(lines, "claude").tokens).toBe(470); // in+out+cr+cw
    expect(find(lines, "codex").tokens).toBe(55); // in+cached+out
    expect(find(lines, "codex_reserve").tokens).toBe(6);
    expect(find(lines, "gemini").tokens).toBe(34); // in+cached+out+thoughts
    expect(find(lines, "grok").tokens).toBe(10); // usage_available: in+out+cr+reason
    expect(find(lines, "grok").calls).toBe(9);
    expect(find(lines, "grok").sessions).toBe(5); // max(sessions, usage_sessions)
    // Muse 的 reason 已含在 out 里：不进 tokens，但单独那一格照写
    expect(find(lines, "musecode").tokens).toBe(30);
    expect(find(lines, "musecode").reason).toBe(5);
    // Kimi 的成本刻意不画（与卡面一致）
    expect(find(lines, "kimicode").cost).toBeUndefined();
    expect(find(lines, "kimicode").costCny).toBeUndefined();
    expect(find(lines, "zcode").costCny).toBe(1.4);
    expect(find(lines, "qoder").hit).toBe(42);
  });

  it("grok 没有真实用量时退回上下文快照的 tokens，输入输出等一律不画", () => {
    const lines = shareLines(payload({
      grok: { ranges: { today: { usage_available: false, tokens: 1234, sessions: 2, in: 999 } } },
    }), "today");
    const grok = find(lines, "grok");
    expect(grok.tokens).toBe(1234);
    expect(grok.input).toBeUndefined();
    expect(grok.calls).toBeUndefined();
  });

  it("勾掉的工具整条不上卡；一项数都没有的也不上卡", () => {
    const empty = payload({ zcode: { ranges: { today: {} } } });
    const lines = shareLines(empty, "today", ["claude", "musecode"]);
    expect(find(lines, "claude")).toBeUndefined();
    expect(find(lines, "musecode")).toBeUndefined();
    expect(find(lines, "zcode")).toBeUndefined();
    // 剩下的照样按原顺序
    expect(lines.map((l) => l.id)).toEqual(["codex", "codex_reserve", "gemini", "grok", "qoder", "kimicode"]);
  });

  it("没有 reserve 段时不会凭空长出一张 Luna Reserve", () => {
    const noReserve = payload();
    delete noReserve.codex.reserve_ranges;
    expect(find(shareLines(noReserve, "today"), "codex_reserve")).toBeUndefined();
  });
});

describe("shareTotals", () => {
  it("逐项求和，工具数按上卡的条数", () => {
    const lines = shareLines(payload(), "today");
    const totals = shareTotals(lines);
    expect(totals.tools).toBe(lines.length);
    expect(totals.tokens).toBe(lines.reduce((sum, l) => sum + (l.tokens || 0), 0));
    expect(totals.cost).toBeCloseTo(1.25 + 0.5 + 0.1 + 0.7 + 0.2, 6);
    expect(totals.costCny).toBeCloseTo(1.4, 6);
    expect(totals.sessions).toBe(3 + 1 + 1 + 2 + 5 + 1 + 1 + 1 + 1);
  });
});

describe("formatUpdatedLine", () => {
  it("只把成功的「更新 …」改写成「更新于 …」", () => {
    expect(formatUpdatedLine("更新 12:34:56")).toBe("更新于 12:34:56");
    expect(formatUpdatedLine("更新于 12:34:56")).toBe("更新于 12:34:56");
    expect(formatUpdatedLine("  更新 09:00:00  ")).toBe("更新于 09:00:00");
  });

  it("加载中/加载失败/预览/空串都不写这一行", () => {
    for (const text of ["加载中…", "加载中…(2)", "加载失败", "预览", "", "   ", null, undefined]) {
      expect(formatUpdatedLine(text as any)).toBeNull();
    }
  });
});

describe("buildShareSpec", () => {
  it("整页卡：380 宽、标题「Tokei 用量」、带合计", () => {
    const spec = buildShareSpec({ payload: payload(), range: "today", kind: "overview", updated: "更新 08:00:00" });
    expect(spec.width).toBe(SHARE_MULTI_WIDTH);
    expect(spec.title).toBe("Tokei 用量");
    expect(spec.subtitle).toBe("今日");
    expect(spec.rangeLabel).toBe("今日");
    expect(spec.updatedLine).toBe("更新于 08:00:00");
    expect(spec.totals!.tools).toBe(spec.lines.length);
    expect(spec.sessions).toBeNull();
  });

  it("单卡：340 宽，标题取工具名，会话胶囊跟着这张卡走", () => {
    const spec = buildShareSpec({ payload: payload(), range: "today", kind: "tool", toolId: "claude" });
    expect(spec.width).toBe(SHARE_SINGLE_WIDTH);
    expect(spec.title).toBe("Claude Code");
    expect(spec.subtitle).toBe("Tokei · 今日");
    expect(spec.lines).toHaveLength(1);
    expect(spec.sessions).toBe(3);
    expect(spec.totals).toBeNull();
  });

  it("找不到这个工具（或它被勾掉）时出一张空卡，不炸", () => {
    const spec = buildShareSpec({ payload: payload(), range: "today", kind: "tool", toolId: "claude", disabled: ["claude"] });
    expect(spec.lines).toEqual([]);
    expect(spec.sessions).toBeNull();
    // 整页卡没有可用工具时也不挂合计
    const overview = buildShareSpec({ payload: {}, range: "today", kind: "overview" });
    expect(overview.lines).toEqual([]);
    expect(overview.totals).toBeNull();
  });

  it("区间写错按今日算；fontScale 原样带过去", () => {
    const spec = buildShareSpec({ payload: payload(), range: "昨天", kind: "overview", fontScale: 1.12 });
    expect(spec.rangeLabel).toBe("今日");
    expect(spec.fontScale).toBe(1.12);
  });
});

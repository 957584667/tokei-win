/**
 * 托盘合成的几何与配色断言。Electron 在这个环境里起不来，所以 trayIcon 写成纯函数，
 * 用 vitest 覆盖「样式 × 密度 × 主题」的组合，替代肉眼验收。
 */
import { describe, expect, it } from "vitest";
import {
  DARK_THEME, LIGHT_THEME, Metric, TrayTheme, focusMetric, layout, traySvg, visibleMetrics,
} from "../src/main/trayIcon";

const ORDER = ["claude5h", "claudeWeek", "claudeFable", "codex5h", "codexWeek",
  "kimi5h", "kimiSubscription", "grok"] as const;

function metric(source: (typeof ORDER)[number], remaining: number, color: string, window: Metric["window"]): Metric {
  return { source, remaining, value: String(Math.round(remaining)), color, window };
}

const TWO: Metric[] = [metric("claude5h", 97, "#eb8566", "hour"), metric("codexWeek", 33, "#6badfa", "week")];
const TIGHT: Metric[] = [metric("claude5h", 97, "#eb8566", "hour"), metric("claudeFable", 8, "#f5ae38", "week")];
const STYLES = ["system", "color", "symbols", "dots", "compact", "artistic", "palm"] as const;
const DENSITIES = ["full", "lowest", "icon"] as const;
/** 彩色/数字两档按工具色上色，墨迹不跟任务栏主题走（对应 Swift 的 colored 分支） */
const INK_STYLES = STYLES.filter(s => s !== "color" && s !== "compact");
/** 只有画品牌图的样式带防休眠角标；symbols/dots 是纯刻度环，原版也没有角标 */
const BRANDED_STYLES = ["system", "color", "artistic", "palm", "compact"] as const;

describe("density 裁剪额度", () => {
  it("full 只显示前两个，顺序即 QUOTA_SOURCE_ORDER", () => {
    const many = ORDER.map((id, i) => metric(id, 90 - i * 10, "#fff", i % 2 ? "week" : "hour"));
    expect(visibleMetrics(many, "full").map((m) => m.source)).toEqual(["claude5h", "claudeWeek"]);
  });

  it("lowest 显示剩余最少的那个，而不是第一个", () => {
    expect(visibleMetrics(TIGHT, "lowest").map((m) => m.source)).toEqual(["claudeFable"]);
  });

  it("icon 不显示数字", () => {
    expect(visibleMetrics(TWO, "icon").length).toBe(1);
    const svg = traySvg({ style: "system", density: "icon", metrics: TWO, keepAwake: false });
    expect(svg).not.toContain("97");
  });

  it("focusMetric 忽略非有限值", () => {
    expect(focusMetric([])).toBeNull();
    expect(focusMetric(TIGHT)?.source).toBe("claudeFable");
  });
});

describe("SVG 几何", () => {
  it.each([...STYLES.flatMap((style) => DENSITIES.map((density) => [style, density] as const))])(
    "%s/%s 的每个元素都不越界", (style, density) => {
      for (const theme of [DARK_THEME, LIGHT_THEME]) {
        for (const scale of [1, 2]) {
          const { width, parts } = layout({ style, density, metrics: TWO, keepAwake: false, scaleFactor: scale, theme });
          expect(parts.length).toBeGreaterThan(0);
          // 文本左端点必须落在画布内，否则数字会被裁掉
          for (const text of [...parts.join("").matchAll(/<text x="([\d.]+)"/g)]) {
            expect(Number(text[1])).toBeLessThan(width);
          }
          const svg = traySvg({ style, density, metrics: TWO, keepAwake: false, scaleFactor: scale, theme });
          expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}"`)).toBe(true);
          expect(svg.match(/height="(\d+)"/)?.[1]).toBe(String(16 * scale));
        }
      }
    },
  );

  it("额度越多画布越宽，两位数和一位数宽度不同", () => {
    const one = layout({ style: "compact", density: "full", metrics: [TWO[0]], keepAwake: false }).width;
    const two = layout({ style: "compact", density: "full", metrics: TWO, keepAwake: false }).width;
    expect(two).toBeGreaterThan(one);
    const singleDigit = layout({ style: "compact", density: "full", metrics: [metric("claude5h", 8, "#eb8566", "hour")], keepAwake: false }).width;
    expect(singleDigit).toBeLessThan(one);
  });

  it("刻度环的进度下限 4%，100% 时画整圈", () => {
    const empty = traySvg({ style: "symbols", density: "full", metrics: [metric("claude5h", 0, "#eb8566", "hour")], keepAwake: false });
    expect(empty).toContain("A 4,4 0 0 1 8.49,4.13");
    const full = traySvg({ style: "symbols", density: "full", metrics: [metric("claude5h", 100, "#eb8566", "hour")], keepAwake: false });
    // 整圈要拆成两段弧，否则起终点重合画不出来
    expect((full.match(/A 4,4 0 1 1/g) ?? []).length).toBe(2);
  });

  it("5 小时窗口画沙漏、周窗口画横块、无窗口只画点", () => {
    const hour = traySvg({ style: "dots", density: "full", metrics: [metric("claude5h", 50, "#eb8566", "hour")], keepAwake: false });
    const week = traySvg({ style: "dots", density: "full", metrics: [metric("codexWeek", 50, "#6badfa", "week")], keepAwake: false });
    const none = traySvg({ style: "dots", density: "full", metrics: [metric("grok", 50, "#a6adbf", null)], keepAwake: false });
    expect(hour).toContain("<polygon");
    expect(week).toContain("<rect");
    expect(none).toContain("<circle");
    expect(none).not.toContain("<polygon");
  });
});

describe("任务栏配色", () => {
  it.each(STYLES)("%s 在浅色任务栏上不用白色墨迹", (style) => {
    const svg = traySvg({ style, density: "full", metrics: TWO, keepAwake: false, theme: LIGHT_THEME });
    expect(svg).not.toContain('fill="#e8e8ee"');
    expect(svg).not.toContain('stroke="#000"');
  });

  it.each(INK_STYLES)("%s 的正文跟浅色任务栏改成深色墨", (style) => {
    const svg = traySvg({ style, density: "full", metrics: TWO, keepAwake: false, theme: LIGHT_THEME });
    expect(svg).toContain(LIGHT_THEME.text);
  });

  it.each(INK_STYLES)("%s 在深色任务栏上用白色墨迹", (style) => {
    const svg = traySvg({ style, density: "full", metrics: TWO, keepAwake: false, theme: DARK_THEME });
    expect(svg).toContain(DARK_THEME.text);
  });

  it("数字之间的分隔点也跟随主题（只有排成数字行的样式才有分隔点）", () => {
    for (const style of ["system", "artistic", "palm"] as const) {
      expect(traySvg({ style, density: "full", metrics: TWO, keepAwake: false, theme: LIGHT_THEME }))
        .toContain(LIGHT_THEME.separator);
      expect(traySvg({ style, density: "full", metrics: TWO, keepAwake: false, theme: DARK_THEME }))
        .toContain(DARK_THEME.separator);
    }
  });

  it.each(["color", "compact"] as const)("%s 始终用工具色，不跟随主题", (style) => {
    for (const theme of [DARK_THEME, LIGHT_THEME] as TrayTheme[]) {
      const svg = traySvg({ style, density: "full", metrics: TWO, keepAwake: false, theme });
      expect(svg).toContain('fill="#eb8566"');
      expect(svg).toContain('fill="#6badfa"');
    }
  });

  it("缺省主题按深色处理", () => {
    const svg = traySvg({ style: "system", density: "full", metrics: TWO, keepAwake: false });
    expect(svg).toContain(DARK_THEME.text);
  });
});

describe("防休眠角标", () => {
  it.each(BRANDED_STYLES)("%s 开启后图形有变化", (style) => {
    const off = traySvg({ style, density: "full", metrics: TWO, keepAwake: false });
    const on = traySvg({ style, density: "full", metrics: TWO, keepAwake: true });
    expect(on).not.toBe(off);
  });

  it("symbols/dots 只有刻度环，不画品牌图，所以角标无处可加", () => {
    for (const style of ["symbols", "dots"] as const) {
      expect(traySvg({ style, density: "full", metrics: TWO, keepAwake: true }))
        .toBe(traySvg({ style, density: "full", metrics: TWO, keepAwake: false }));
    }
  });
});

/**
 * 本机没有额度读数时的样子 —— 用户反馈「菜单栏样式设置不起作用」就是这条链路：
 * 额度为空时若所有样式都退回品牌图，换样式自然看不出变化（MenuBarStyle.swift:628-682）。
 */
describe("没有额度读数时的退让", () => {
  const TOTAL: Metric[] = [{ source: "total", remaining: null, value: "12.3M", color: DARK_THEME.separator, window: null }];

  it("七种样式两两不同：彩色/星轨/椰影带着自己的图形，只有其余四档退回品牌图", () => {
    const svg = STYLES.map((style) => traySvg({ style, density: "full", metrics: TOTAL, keepAwake: false }));
    expect(new Set(svg).size).toBe(STYLES.length);
  });

  it("总量项没有剩余额度：刻度环画满圈、圆点退化成一个点，都不画窗口符号", () => {
    const symbols = traySvg({ style: "symbols", density: "full", metrics: TOTAL, keepAwake: false });
    expect(symbols).toContain("12.3M");
    expect(symbols).not.toContain("<polygon");   // 沙漏
    expect(symbols).not.toContain("<rect");      // 周窗口横块
    const dots = traySvg({ style: "dots", density: "full", metrics: TOTAL, keepAwake: false });
    expect(dots.match(/<circle/g)?.length).toBe(1);
  });

  it("focusMetric 只看有剩余额度的项，总量项不会被当成「最紧的额度」", () => {
    expect(focusMetric(TOTAL)?.source).toBe("total");
    expect(focusMetric([...TWO, TOTAL])?.source).not.toBe("total");
  });

  it("额度全关且今日无数据 → 只剩品牌图，此时四档退让成同一张（与原版一致）", () => {
    const empty = STYLES.map((style) => traySvg({ style, density: "full", metrics: [], keepAwake: false }));
    expect(new Set(empty).size).toBe(4);   // 品牌图 + 签名 + 星轨 + 椰影
  });
});

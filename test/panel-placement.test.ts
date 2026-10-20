/**
 * 面板尺寸（main/panelPlacement.ts ← PanelPlacement.swift）。
 * 纯算术：屏幕可见高度 → 上限；内容自然尺寸 → 夹进上限并向上取整。
 */
import { describe, expect, it } from "vitest";
import {
  PANEL_FALLBACK_VISIBLE_HEIGHT, PANEL_HEIGHT_RATIO, PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH,
  PANEL_PROVISIONAL, PANEL_VERTICAL_MARGIN, fitPanelSize, panelMaximumHeight,
} from "../src/main/panelPlacement";

describe("panelMaximumHeight", () => {
  it("1122 高的屏：0.88 约 987，离顶满（1082）还留约 95", () => {
    expect(panelMaximumHeight(1122)).toBeCloseTo(1122 * PANEL_HEIGHT_RATIO, 5);
    expect(1122 - panelMaximumHeight(1122)).toBeGreaterThan(95);
  });

  it("矮屏按上下留 40 的余量走，再矮就保住最小可用高度", () => {
    // 900 高：860 的余量比 792（0.88）宽，所以按比例取 792
    expect(panelMaximumHeight(900)).toBeCloseTo(900 * PANEL_HEIGHT_RATIO, 5);
    expect(panelMaximumHeight(600)).toBe(528);
    // 460 - 40 = 420 > 404.8 → 按比例；300 - 40 = 260 < 264 → 320 兜底
    expect(panelMaximumHeight(460)).toBeCloseTo(460 * PANEL_HEIGHT_RATIO, 5);
    expect(panelMaximumHeight(300)).toBe(PANEL_MIN_HEIGHT);
  });

  it("量不到可见高度时退回 900 的兜底值", () => {
    expect(panelMaximumHeight(undefined, 1000)).toBe(880);
    expect(panelMaximumHeight(null, null)).toBeCloseTo(PANEL_FALLBACK_VISIBLE_HEIGHT * PANEL_HEIGHT_RATIO, 5);
  });
});

describe("fitPanelSize", () => {
  it("内容比一屏长：夹到上限并向上取整", () => {
    // 实测内容约 1569 点：1122 高的屏按 987.36 封顶
    expect(fitPanelSize({ width: 640, height: 1569 }, 1122)).toEqual({ width: 640, height: 988 });
    expect(fitPanelSize({ width: 640, height: 1569 }, 900)).toEqual({ width: 640, height: 792 });
  });

  it("内容很短也要保住 320 的最小高度", () => {
    expect(fitPanelSize({ width: 420, height: 180 }, 900)).toEqual({ width: 420, height: 320 });
  });

  it("还没量到内容（0）时用 640 的起点尺寸，同样受屏高封顶", () => {
    expect(fitPanelSize({ width: 0, height: 0 }, 1122)).toEqual({
      width: PANEL_PROVISIONAL.width, height: PANEL_PROVISIONAL.height,
    });
    expect(fitPanelSize({ width: 0, height: 0 }, 600).height).toBe(528);
  });

  it("宽度只有下限，没有自造的上限", () => {
    expect(fitPanelSize({ width: 300, height: 500 }, 900).width).toBe(PANEL_MIN_WIDTH);
    expect(fitPanelSize({ width: 900, height: 500 }, 900).width).toBe(900);
  });

  it("高度取整只向上，不会把内容裁掉半像素", () => {
    expect(fitPanelSize({ width: 640, height: 500.2 }, 900).height).toBe(501);
    expect(fitPanelSize({ width: 640, height: 500 }, 900).height).toBe(500);
  });
});

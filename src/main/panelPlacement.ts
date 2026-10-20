/**
 * 面板尺寸（对应 PanelPlacement.swift）：内容要多少给多少，再夹进这块屏幕装得下的范围。
 *
 * 内容天然比任何屏幕都长（实测约 1569 点），所以「贴合内容」必须按比例封顶——
 * 之前写死的 840 在 1112 高的屏幕上正好约 3/4，换到 13 寸上却会顶满。
 * 0.88 在 1122 高的屏幕上约 987 点，距离顶满（1082）仍留约 95 点余量。
 */

/** 对应 PanelPlacement.verticalMargin：上下留出的总边距 */
export const PANEL_VERTICAL_MARGIN = 40;
/** 对应 PanelPlacement.heightRatio */
export const PANEL_HEIGHT_RATIO = 0.88;
export const PANEL_MIN_HEIGHT = 320;
export const PANEL_MIN_WIDTH = 322;
/** 量不到屏幕可见高度时按 900 算（对应 fallbackVisibleHeight） */
export const PANEL_FALLBACK_VISIBLE_HEIGHT = 900;
/** 还没量到内容时（启动那一刻）的起点尺寸，对应 provisionalSize */
export const PANEL_PROVISIONAL = { width: 640, height: 640 };

/** 这块屏幕上面板最高能有多少：按比例取，再留出上下边距，并保住最小可用高度。 */
export function panelMaximumHeight(visibleHeight?: number | null, fallbackVisibleHeight?: number | null): number {
  const visible = visibleHeight ?? fallbackVisibleHeight ?? PANEL_FALLBACK_VISIBLE_HEIGHT;
  const room = visible - PANEL_VERTICAL_MARGIN;
  return Math.max(PANEL_MIN_HEIGHT, Math.min(room, visible * PANEL_HEIGHT_RATIO));
}

/** 对应 PanelPlacement.contentSize：夹完再向上取整（Swift 的 .rounded(.up)）。 */
export function fitPanelSize(
  fitting: { width: number; height: number },
  visibleHeight?: number | null,
  fallbackVisibleHeight?: number | null,
): { width: number; height: number } {
  const ceiling = panelMaximumHeight(visibleHeight, fallbackVisibleHeight);
  const height = fitting.height > 0
    ? Math.min(Math.max(fitting.height, PANEL_MIN_HEIGHT), ceiling)
    : Math.min(PANEL_PROVISIONAL.height, ceiling);
  const width = fitting.width > 0
    ? Math.max(fitting.width, PANEL_MIN_WIDTH)
    : PANEL_PROVISIONAL.width;
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

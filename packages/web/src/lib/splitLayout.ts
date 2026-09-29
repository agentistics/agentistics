/**
 * splitLayout.ts — PURE: how wide each side of the split sessions workspace is.
 *
 * The main pane's share of the row is a RATIO, so the split keeps its proportions when the window
 * changes size; the gap between the two panes is the resize handle (`PanelGap`), which speaks in
 * pixels, so the two conversions live here. Each side keeps at least `SPLIT_MIN_PX`: it carries a
 * whole session layout (chat, rail, band), and below that it stops being usable.
 */

export const SPLIT_MIN_PX = 420
export const SPLIT_DEFAULT_RATIO = 0.5
export const SPLIT_RATIO_KEY = 'agentistics-sessions-split-ratio'

/** A ratio that always leaves each side its minimum, for a row of `rowWidth` pixels. */
export function clampSplitRatio(ratio: number, rowWidth: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_DEFAULT_RATIO
  if (rowWidth <= 2 * SPLIT_MIN_PX) return SPLIT_DEFAULT_RATIO
  const lo = SPLIT_MIN_PX / rowWidth
  return Math.min(1 - lo, Math.max(lo, ratio))
}

/** The main pane's width in pixels. */
export function mainPaneWidth(ratio: number, rowWidth: number): number {
  return Math.round(clampSplitRatio(ratio, rowWidth) * rowWidth)
}

/** The drag's pixel width back to a ratio. */
export function ratioFromWidth(width: number, rowWidth: number): number {
  return rowWidth > 0 ? clampSplitRatio(width / rowWidth, rowWidth) : SPLIT_DEFAULT_RATIO
}

/** A stored ratio, tolerating anything malformed. */
export function parseSplitRatio(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 && n < 1 ? n : SPLIT_DEFAULT_RATIO
}

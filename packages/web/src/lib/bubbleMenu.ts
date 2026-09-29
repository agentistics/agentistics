/**
 * bubbleMenu.ts — PURE: where a message's menu opens.
 *
 * The menu is anchored inside the bubble, at the press (or under the `⋯`). On the LAST message of a
 * conversation that point sits right above the composer, and a menu opening downwards went behind
 * it — measured at 390px: the rows were covered, and the browser scrolling them into view closed the
 * menu (it closes on scroll, because it is anchored to a bubble that moves). So it opens UPWARDS when
 * the room below the anchor, down to `floor`, cannot hold it — and never above the viewport's top.
 */

/** The menu's height for `rows` entries — 44px rows on a phone, 34px elsewhere, plus padding. */
export function bubbleMenuHeight(rows: number, isMobile: boolean): number {
  return rows * (isMobile ? 44 : 34) + 8
}

/**
 * The menu's `top`, in the BUBBLE's own coordinates.
 *
 * `localY`: the anchor inside the bubble. `anchorViewportY`: the same point in the viewport.
 * `floor`: the lowest viewport y the menu may reach (the composer's top edge, else the viewport's).
 */
export function bubbleMenuTop(o: {
  localY: number
  anchorViewportY: number
  menuHeight: number
  floor: number
  gap?: number
}): number {
  const gap = o.gap ?? 4
  if (o.anchorViewportY + o.menuHeight + gap <= o.floor) return o.localY
  const up = o.localY - o.menuHeight - gap
  // Never above the top of the viewport: clamp against how far the bubble already sits below it.
  const minLocal = o.localY - o.anchorViewportY + gap
  return Math.max(up, minLocal)
}

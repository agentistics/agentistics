/**
 * panelLayout.ts — the PURE geometry and drag math behind the floating-panel workspace layout
 * (Sessions workspace, desktop only). See `sdd/brief.md` for the full design and the reference
 * mockup this implements.
 *
 * This module never reads or writes a limit itself — the sessions list's width, the right aside's
 * width and the bottom band's height each keep their OWN existing clamp/resolver
 * (`asideWidth.ts`'s `clampAsideWidth`, `artifactLayout.ts`'s panel-width clamp,
 * `shellBand.ts`'s `resolveBandDrag`/`resolveBandHeight`) — reused exactly, per the brief. What
 * lives here instead is what is genuinely NEW: the T-junction's two-axis drag (one pointer delta
 * feeding two independent, already-clamped axes), which junctions exist for a given open/closed
 * combination of panels, and the hit-zone rectangles a gap or a junction claims.
 */

/**
 * THE ONE INNER GAP — the visible seam and drag handle BETWEEN two panels (left list ↔ centre,
 * centre ↔ right aside, conversation ↔ bottom band, the live-activity strip ↔ conversation).
 * Owner-requested bump from 6px to 10px (2026-09-27): at 6px the gap's own three-dot grip
 * (`PanelGapDots`) sat pressed right against both neighbouring panels' borders, with no room to read
 * as its own control. Every place that drew this figure — `App.tsx`'s SideNav padding and its aside
 * gap's `right` offset, `SessionsPage.tsx`'s right-aside gap and its live-activity strip's bottom
 * margin, `bandControls.tsx`'s `BandResizeHandle` — now reads this ONE constant, so a future change
 * moves every seam together instead of drifting one at a time the way six independent literal `6`s
 * eventually would.
 *
 * THE OUTER edges (a panel's own border to the window's left/right/bottom, and the frame's top gap
 * below the header) are a DIFFERENT figure and STAY 6px — they were never part of this complaint (the
 * grip lives only on an INNER seam between two panels, never on a window edge with nothing to grip
 * against) and changing them was never asked for. Do not fold them into this constant.
 */
export const PANEL_GAP = 10

export interface PanelOpenState {
  leftOpen: boolean
  rightOpen: boolean
  bandOpen: boolean
}

export type JunctionId = 'bottom-left' | 'bottom-right'

/**
 * Which T-junctions exist right now. A junction is where the horizontal gap (under the
 * conversation, above the band) meets a vertical gap — so it needs BOTH the band's own horizontal
 * gap and the neighbouring vertical gap to be present. In this workspace's fixed geometry the band
 * always spans the full width of the centre column (it never reaches under the right aside), so
 * `bottom-left` is exactly "band open AND the left list open" and `bottom-right` is exactly "band
 * open AND the right aside open" — there is no independent "does the band span this edge" question
 * to ask beyond the two panels' own open state. A junction whose gap is gone (either panel closed,
 * or the band collapsed/empty) is never returned, so a caller never has to separately check "is this
 * junction's hit zone reachable" before acting on it.
 */
export function activeJunctions(state: PanelOpenState): JunctionId[] {
  const ids: JunctionId[] = []
  if (state.bandOpen && state.leftOpen) ids.push('bottom-left')
  if (state.bandOpen && state.rightOpen) ids.push('bottom-right')
  return ids
}

/** Clamps a size to its own inclusive bounds — the one arithmetic every axis-specific resolver this
 *  module defers to already performs; kept here too because the junction drag below needs to apply
 *  it identically to whichever axis it is given, without importing any one axis's own module. */
export function clampSize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Applies one pointer-delta component to one resizable size, through its own sign and its own
 * bounds. `sign` is which way the POINTER has to move to GROW this axis: `+1` for a boundary whose
 * panel sits to the pointer's origin side and grows when the pointer moves away from it (the left
 * list's right edge, or the band's own top edge growing upward — a smaller `clientY` growing the
 * band), `-1` for the mirror case (the right aside's left edge growing when the pointer moves
 * left). This is the ONE function a lone gap's drag and a junction's two-axis drag both resolve
 * through, so a junction can never grow a boundary past a limit the lone gap would have refused.
 */
export function applyAxisDrag(start: number, delta: number, sign: 1 | -1, min: number, max: number): number {
  return clampSize(start + sign * delta, min, max)
}

export interface JunctionAxis {
  /** The size this axis had when the drag began — never the live value, so a rapid drag resolves
   *  against one fixed baseline instead of compounding rounding across many pointer-move events. */
  start: number
  sign: 1 | -1
  min: number
  max: number
}

/**
 * A T-junction drags TWO independent axes from ONE pointer delta: the VERTICAL boundary reads only
 * the horizontal component (`dx`) and the HORIZONTAL boundary reads only the vertical component
 * (`dy`) — each stays on its own axis of the pointer's movement, exactly as the brief specifies
 * ("Each boundary follows its own axis of the pointer delta"). Either side is `null` when that
 * boundary is not part of THIS junction (a junction missing one of its two neighbours is not a
 * junction — see `activeJunctions`), and its `null` passes straight through.
 */
export function applyJunctionDrag(
  vertical: JunctionAxis | null,
  horizontal: JunctionAxis | null,
  dx: number,
  dy: number,
): { vertical: number | null; horizontal: number | null } {
  return {
    vertical: vertical ? applyAxisDrag(vertical.start, dx, vertical.sign, vertical.min, vertical.max) : null,
    horizontal: horizontal ? applyAxisDrag(horizontal.start, dy, horizontal.sign, horizontal.min, horizontal.max) : null,
  }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A single gap's own hit-zone rectangle, centred on the gap's own visual centre line. The brief:
 * "The hit area must be at least the gap's width, and may extend 2px invisibly into each
 * neighbour" — so the returned thickness is the gap plus `overflow` on each side, never narrower
 * than the gap alone (`overflow: 0` reproduces the bare gap exactly).
 */
export function gapHitRect(
  orientation: 'vertical' | 'horizontal',
  center: { x: number; y: number },
  span: { start: number; end: number },
  gap: number,
  overflow = 2,
): Rect {
  const thickness = gap + overflow * 2
  return orientation === 'vertical'
    ? { x: center.x - thickness / 2, y: span.start, width: thickness, height: span.end - span.start }
    : { x: span.start, y: center.y - thickness / 2, width: span.end - span.start, height: thickness }
}

/**
 * A T-junction's own square hot zone, centred on the crossing point — "at least gap × gap, may be
 * slightly larger" (brief). `extra` grows the square symmetrically past the bare gap so it clearly
 * overlaps both gaps' own hit zones (a junction pinched to exactly the gap's width would be a
 * single-pixel target at the one point the two gaps' centre lines cross).
 */
export function junctionHitRect(center: { x: number; y: number }, gap: number, extra = 4): Rect {
  const side = gap + extra
  return { x: center.x - side / 2, y: center.y - side / 2, width: side, height: side }
}

/** Is a point inside a rectangle (inclusive of the edges) — used to decide which hit zone a pointer
 *  landed in when a junction's square and its two gaps' own strips overlap near the crossing. */
export function pointInRect(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
}

/**
 * The window-level events that must always END an active drag-resize gesture. A plain `mouseup` is
 * not enough on its own: the pointer can leave the window before the button comes up (the tab loses
 * focus — `blur`), or the OS/browser can cancel the pointer sequence outright (`pointercancel`, a
 * touch drag interrupted by a system gesture). A T-junction (`PanelJunction`/`armGap`, `PanelGap.tsx`)
 * arms TWO independent drags off one synthetic `mousedown`, and a release neither gap's own listener
 * happens to see left both panels tracking the pointer forever — reported live: releasing the mouse
 * button after a junction drag left the band height and the aside width still following every
 * subsequent `mousemove`. Every drag-resize listener in this workspace (`PanelGap`, `useBandDrag`,
 * the artifacts aside's own resize effect) ends on every one of these, not `mouseup` alone.
 */
export const DRAG_END_EVENTS = ['mouseup', 'pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur'] as const
export type DragEndEvent = typeof DRAG_END_EVENTS[number]

/** Whether a given DOM event type is one of `DRAG_END_EVENTS` — the one decision every drag-resize
 *  listener in this workspace shares, kept in one place so a fifth "this also means release" event
 *  is added once rather than found missing in a third copy. */
export function isDragEndEvent(type: string): boolean {
  return (DRAG_END_EVENTS as readonly string[]).includes(type)
}

/**
 * Which hit zone a pointer at `p` should act on, given the (up to) three candidates that can
 * overlap near a corner: the vertical gap's own strip, the horizontal gap's own strip, and the
 * junction's square. The JUNCTION WINS wherever it claims the point — it is the more specific
 * gesture (drag two boundaries at once) and every junction square is deliberately built to sit
 * entirely inside the union of the two strips it overlaps, so choosing it over either lone strip
 * never surprises a reader aiming at a single boundary elsewhere along its length.
 */
export function resolveHitZone(
  p: { x: number; y: number },
  zones: { junction?: Rect; vertical?: Rect; horizontal?: Rect },
): 'junction' | 'vertical' | 'horizontal' | null {
  if (zones.junction && pointInRect(p, zones.junction)) return 'junction'
  if (zones.vertical && pointInRect(p, zones.vertical)) return 'vertical'
  if (zones.horizontal && pointInRect(p, zones.horizontal)) return 'horizontal'
  return null
}

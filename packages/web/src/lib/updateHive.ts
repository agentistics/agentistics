/**
 * updateHive.ts — PURE rules of the hive ("Colmeia") update animation, treatment A, "a colmeia abre
 * espaço". Ported from the owner-approved prototype (`~/.agentistics/leader/upd-demo/hive-legibility.html`,
 * v3) and kept apart from the canvas (`updateScene.ts`) so each rule that decides what a person SEES
 * is a tested function: where the hive may not draw, how it makes room around the text, and how a
 * cell moves between its states.
 *
 * Two promises, both asserted by `updateHive.test.ts`:
 *  1. NO HEXAGON IS EVER DRAWN OVER TEXT. A cell whose circumscribed circle would touch any line of
 *     text is fully transparent (`clearing`), by construction and not by tuning.
 *  2. NO CELL IS DRAWN INSIDE THE LOADER'S FRAME. The frame is a pointy-top hexagon and so is every
 *     cell, so both are measured with ONE norm (`hnorm`) and the placement refuses what overlaps.
 */

export const C30 = Math.sqrt(3) / 2
export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const smooth = (t: number): number => { const x = clamp01(t); return x * x * (3 - 2 * x) }
export const approach = (v: number, t: number, d: number): number => (v < t ? Math.min(t, v + d) : Math.max(t, v - d))

// ── geometry ─────────────────────────────────────────────────────────────────────────────────

export interface HiveGeometry {
  W: number; H: number
  /** Centre of the loader. */
  cx: number; cy: number
  /** Logo radius. */
  R: number
  /** Frame circumradius, and its clip apothem (+ stroke + glow margin). */
  FR: number; A_CLIP: number
  /** Lattice step, cell circumradius and cell apothem. */
  S: number; RC: number; AC: number
}

export function hiveGeometry(W: number, H: number): HiveGeometry {
  const cx = W / 2, cy = H * 0.47, R = Math.min(W, H) * (W < 640 ? 0.15 : 0.12)
  const FR = R * 1.4, A_CLIP = FR * C30 + 7
  const S = Math.max(14, Math.min(W, H) / 26), RC = S * 0.86
  return { W, H, cx, cy, R, FR, A_CLIP, S, RC, AC: RC * C30 }
}

/**
 * The hex norm: max |p·n| over the three side normals of a pointy-top hexagon. Two same-orientation
 * hexagons are disjoint exactly when h(p) >= apothem_a + apothem_b.
 */
export function hnorm(dx: number, dy: number): number {
  const u = dy * C30, v = dx * 0.5
  return Math.max(Math.abs(dx), Math.abs(v + u), Math.abs(v - u))
}

// ── the frame exclusion ──────────────────────────────────────────────────────────────────────

/**
 * The opacity multiplier a cell gets from the frame. 0 when the cell lies wholly inside it (never
 * drawn there), ramping up as it leaves; a cell that still touches the edge is drawn clipped to the
 * outside by the caller, so nothing is ever painted inside the frame.
 */
export function frameFactor(x: number, y: number, grow: number, g: HiveGeometry): number {
  const h = hnorm(x - g.cx, y - g.cy), ac = g.AC * grow
  if (h + ac <= g.A_CLIP) return 0
  const clear = h - ac - g.A_CLIP
  return smooth((clear + ac * 0.8) / (ac * 0.8 + 16))
}

/** Does this cell still touch the frame's edge (it then needs the clipped path)? */
export function touchesFrame(x: number, y: number, grow: number, g: HiveGeometry): boolean {
  return hnorm(x - g.cx, y - g.cy) - g.AC * grow - g.A_CLIP < 3
}

// ── making room around the text ──────────────────────────────────────────────────────────────

/** The real ink of one line of text (or one bar row), in the stage's own coordinates. */
export interface Ink { l: number; t: number; r: number; b: number }

/** Distance from a point to the rectangle (0 inside). */
export function rectDistance(x: number, y: number, k: Ink): number {
  const nx = Math.max(k.l, Math.min(x, k.r)), ny = Math.max(k.t, Math.min(y, k.b))
  return Math.hypot(x - nx, y - ny)
}

/**
 * Distance to a PILL around the line: a rectangle whose short side is fully rounded. Its contour
 * leans in at the corners, which is what lets the clearing read as cells drawing back from the
 * letters instead of from a box. `rr` is the rounding radius; `nx, ny` the unit direction away from
 * the pill (the way a cell yields).
 */
export function pillDistance(x: number, y: number, k: Ink): { d: number; nx: number; ny: number; rr: number } {
  const hw = (k.r - k.l) / 2, hh = (k.b - k.t) / 2, rr = Math.max(0, Math.min(hw, hh))
  const px = x - (k.l + k.r) / 2, py = y - (k.t + k.b) / 2
  const qx = Math.abs(px) - (hw - rr), qy = Math.abs(py) - (hh - rr)
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), len = Math.hypot(ox, oy)
  const d = len + Math.min(Math.max(qx, qy), 0) - rr
  let nx: number, ny: number
  if (len > 1e-6) { nx = Math.sign(px || 1) * ox / len; ny = Math.sign(py || 1) * oy / len } else if (qx > qy) { nx = Math.sign(px || 1); ny = 0 } else { nx = 0; ny = Math.sign(py || 1) }
  return { d, nx, ny, rr }
}

/** A pill lies inside its rectangle; the gap is at most (√2 − 1)·rr, at the four corners. */
export const PILL_CORNER_GAP = Math.SQRT2 - 1

/** Width of the soft falloff: wider than the prototype's fixed 84 on a big stage, narrower on a phone. */
export function inkFade(S: number): number { return Math.max(56, S * 2.4) }

// ── the corridor: frame + foot text read as ONE calm zone ───────────────────────────────────────

export type Pt = readonly [number, number]

/** Convex hull (monotone chain), counter-clockwise in y-up coordinates. */
export function hullOf(points: readonly Pt[]): Pt[] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cr = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo: Pt[] = [], up: Pt[] = []
  for (const q of p) { while (lo.length > 1 && cr(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop(); lo.push(q) }
  for (const q of p.slice().reverse()) { while (up.length > 1 && cr(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop(); up.push(q) }
  lo.pop(); up.pop()
  return lo.concat(up)
}

/** Signed distance to a convex polygon (< 0 inside) and the unit direction away from it. */
export function hullDistance(x: number, y: number, poly: readonly Pt[]): { d: number; nx: number; ny: number } {
  let d = Infinity, nx = 0, ny = 0, allPos = true, allNeg = true
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!, ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey || 1
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2)), qx = a[0] + ex * t, qy = a[1] + ey * t, dd = Math.hypot(x - qx, y - qy)
    if (dd < d) { d = dd; nx = x - qx; ny = y - qy }
    const side = (x - a[0]) * ey - (y - a[1]) * ex
    if (side < 0) allPos = false
    if (side > 0) allNeg = false
  }
  const inside = allPos || allNeg // inside a convex polygon = on the same side of every edge
  const m = Math.hypot(nx, ny) || 1
  return { d: inside ? -d : d, nx: nx / m, ny: ny / m }
}

/**
 * The corridor: the convex hull of the frame's LOWER half (the frame's real extent, glow included)
 * and the foot block — every line of ink that sits below the frame. Null when there is no foot text.
 * Whatever lies between the frame and that text is part of the same calm zone, so no cell may.
 */
export function corridorOf(inks: readonly Ink[], g: HiveGeometry): Pt[] | null {
  const foot = inks.filter(k => (k.t + k.b) / 2 > g.cy + g.FR)
  if (!foot.length) return null
  const l = Math.min(...foot.map(k => k.l)), r = Math.max(...foot.map(k => k.r)), t = Math.min(...foot.map(k => k.t)), b = Math.max(...foot.map(k => k.b))
  const fr = g.A_CLIP / C30 // circumradius of the clip: frame + stroke + glow
  return hullOf([[g.cx - fr * C30, g.cy + fr / 2], [g.cx, g.cy + fr], [g.cx + fr * C30, g.cy + fr / 2], [l, t], [r, t], [l, b], [r, b]])
}

/** The corridor's falloff is a little tighter than a line's: it is a zone, not an edge. */
export const CORRIDOR_FADE = 0.8

/**
 * How much of a cell survives next to the text, and which way it yields.
 *
 * Distance is measured to each LINE's own pill (never to one big box) AND to the corridor joining the
 * frame to the foot text, each reduced by a per-cell jitter from the cell's seed so the edge follows
 * the lattice irregularly — cells that drew back, not a contour. The jitter only ever REDUCES the
 * distance, so it can clear more, never less: the zero points (`RC + corner gap + 2` for a line,
 * `RC + 2` for the corridor) are hard guarantees that a visible cell's circle touches neither the
 * rectangle of any line nor the corridor.
 */
export function clearing(
  x: number, y: number, seed: number, inks: readonly Ink[], g: HiveGeometry, hull: readonly Pt[] | null = corridorOf(inks, g),
): { f: number; px: number; py: number } {
  if (!inks.length) return { f: 1, px: 0, py: 0 }
  const fade = inkFade(g.S), jit = seed * g.S * 0.9
  let best = Infinity, px = 0, py = 0
  for (const k of inks) {
    const p = pillDistance(x, y, k)
    const zero = g.RC + PILL_CORNER_GAP * p.rr + 2
    const v = (p.d - jit - zero) / fade
    if (v < best) { best = v; px = p.nx; py = p.ny }
  }
  if (hull) {
    const h = hullDistance(x, y, hull), v = (h.d - jit - (g.RC + 2)) / (fade * CORRIDOR_FADE)
    if (v < best) { best = v; px = h.nx; py = h.ny }
  }
  return { f: smooth(best), px, py }
}

/** A cell counts as drawn above this opacity. */
export const VISIBLE = 0.004

// ── how a cell moves ─────────────────────────────────────────────────────────────────────────

export const ENTRY_MS = 450, EXIT_MS = 420, STAG_IN = 650, STAG_OUT = 600, PULSE_MS = 600, ROOM_MS = 800

/** One frame of a cell's own state. Moves at most `dt / ms` per frame — never a jump. */
export function stepOn(on: number, want: 0 | 1, dtMs: number, reduced: boolean): number {
  const ms = reduced ? 160 : want ? ENTRY_MS : EXIT_MS
  return approach(on, want, dtMs / ms)
}

/** How long a cell waits before it follows a change of wanted state: inner cells first on the way in, outer first on the way out. */
export function staggerMs(want: 0 | 1, dn: number, reduced: boolean): number {
  return reduced ? 0 : want ? dn * STAG_IN : (1 - dn) * STAG_OUT
}

/** The breathing dip applied to every cell while the restart (no percentage) is waited out. */
export function pulseFactor(pulseAmt: number, tSec: number, distance: number): number {
  return 1 - pulseAmt * (1 - (0.55 + 0.45 * Math.sin(tSec * 2.6 - distance / 70)))
}

/** The opacity a settled cell twinkles at. */
export function restingAlpha(tSec: number, seed: number, reduced: boolean): number {
  return reduced ? 0.27 : 0.16 + 0.22 * (0.5 + 0.5 * Math.sin(tSec * 1.6 + seed * 6.3))
}

/** The sentence `place` uses to decide a cell's stroke and fill opacity from its base alpha. */
export function cellAlphas(a: number, orange: boolean, seed: number): { stroke: number; fill: number } {
  return { stroke: Math.min(0.85, a * (orange ? 2.4 : 1.6)), fill: orange || seed > 0.86 ? a * (orange ? 0.55 : 0.22) : 0 }
}

/** Stage-relative ink rectangles from DOM rects and the stage's own rect. Empty boxes are dropped. */
export function inksFrom(rects: readonly { left: number; top: number; right: number; bottom: number; width: number; height: number }[], stage: { left: number; top: number }): Ink[] {
  return rects.filter(r => r.width > 0 && r.height > 0).map(r => ({ l: r.left - stage.left, t: r.top - stage.top, r: r.right - stage.left, b: r.bottom - stage.top }))
}

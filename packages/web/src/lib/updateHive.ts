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

/** Width of the soft falloff — TIGHT (the owner: the clearing was far too big): about one cell, never under 26 px. */
export function inkFade(S: number): number { return Math.max(26, S * 0.9) }

/** Per-cell jitter of the clearing's edge, in cells (it only ever clears more). */
export const JITTER = 0.45

/** How far a cell that is making room is nudged away from the text, in cells. */
export const SPREAD = 0.2

/**
 * How much of a cell survives next to the text, and which way it yields.
 *
 * Distance is measured to each LINE's own pill (never to one big box, and to nothing joining the
 * lines to the frame), reduced by a small per-cell jitter from the cell's seed so the edge follows
 * the lattice irregularly — cells that drew back a hair, not a contour. The clearing is TIGHT: cells
 * come right up to the text, so the space between the frame and the foot text reads as the rest of
 * the hive. The jitter only ever REDUCES the distance, so it can clear more, never less: the zero
 * point (`RC + corner gap + 2`) is a hard guarantee that a visible cell's circle does not touch the
 * rectangle of any line.
 */
export function clearing(x: number, y: number, seed: number, inks: readonly Ink[], g: HiveGeometry): { f: number; px: number; py: number } {
  if (!inks.length) return { f: 1, px: 0, py: 0 }
  const fade = inkFade(g.S), jit = seed * g.S * JITTER
  let best = Infinity, px = 0, py = 0
  for (const k of inks) {
    const p = pillDistance(x, y, k)
    const zero = g.RC + PILL_CORNER_GAP * p.rr + 2
    const v = (p.d - jit - zero) / fade
    if (v < best) { best = v; px = p.nx; py = p.ny }
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

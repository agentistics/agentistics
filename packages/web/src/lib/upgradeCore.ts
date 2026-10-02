/**
 * upgradeCore.ts — PURE geometry and budgets for the update loader's core animation
 * (`components/UpgradeCore.tsx`). Kept out of the component so the CPU budget is a tested number
 * rather than a hope: a phone gets fewer particles, a lower pixel ratio and half the frame rate,
 * and reduced motion gets none of it — one static frame redrawn only when the charge changes.
 *
 * The picture: data streams spiral INTO a central core that ASSEMBLES piece by piece (three rings
 * of segments, revealed in order as the real charge grows), circuit traces light up from the edges
 * toward the heart during the restart, and an energy ring sweeps around the core as it charges.
 */

export interface CoreBudget {
  /** Live particles at most. */
  particles: number
  /** Device pixel ratio cap. */
  dpr: number
  /** Minimum ms between drawn frames (16 ≈ 60 fps, 33 ≈ 30 fps). */
  frameMs: number
  /** Whether a frame loop runs at all. */
  animate: boolean
}

export function coreBudget(o: { isMobile: boolean; reducedMotion: boolean; dpr: number }): CoreBudget {
  if (o.reducedMotion) return { particles: 0, dpr: Math.min(o.dpr, 2), frameMs: 0, animate: false }
  return o.isMobile
    ? { particles: 42, dpr: Math.min(o.dpr, 1.5), frameMs: 33, animate: true }
    : { particles: 96, dpr: Math.min(o.dpr, 2), frameMs: 16, animate: true }
}

/** The core's pieces: ring index, start angle and sweep (radians), in reveal order. */
export interface CorePiece { ring: 0 | 1 | 2; a0: number; a1: number }

export const RING_SEGMENTS = [6, 10, 16] as const

/** All pieces, inner ring first — the core is built from its heart outward. */
export function corePieces(): CorePiece[] {
  const out: CorePiece[] = []
  RING_SEGMENTS.forEach((n, ring) => {
    const step = (Math.PI * 2) / n
    const gap = step * 0.16
    // Interleave so a ring fills around its whole circumference, not clockwise in one sweep.
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (a % 2) - (b % 2) || a - b)
    for (const i of order) {
      const a0 = -Math.PI / 2 + i * step + gap / 2 + ring * 0.21
      out.push({ ring: ring as 0 | 1 | 2, a0, a1: a0 + step - gap })
    }
  })
  return out
}

/** How many pieces are in place at a charge of `fraction` (0..1). Every piece is in at 1. */
export function piecesLit(fraction: number, total: number): number {
  const f = Math.max(0, Math.min(1, fraction))
  return Math.min(total, Math.floor(f * total + 0.0001 + (f > 0 ? 1 : 0)))
}

/** How much of the circuit traces is lit: nothing before the swap ends, all of it once back. */
export function circuitLit(fraction: number): number {
  return Math.max(0, Math.min(1, (fraction - 0.6) / 0.32))
}

/** The 8 traces, as polylines from the frame's edge to the core's outer ring, in unit coordinates
 *  (core at 0,0; frame half-size 1; ring radius `r`). Right-angled, like a board. */
export function circuitTraces(r: number): [number, number][][] {
  const traces: [number, number][][] = []
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8
    const ex = Math.cos(a) * r, ey = Math.sin(a) * r
    const sx = Math.sign(Math.cos(a)) * 0.98, sy = Math.sin(a) * 0.98
    const mid = (sx + ex) / 2
    traces.push([[sx, sy], [mid, sy], [mid, ey], [ex, ey]])
  }
  return traces
}

/** Spawn rate (particles per second) for each narrated step: the download is a torrent. */
export function spawnRate(step: 'data' | 'brain' | 'wiring' | 'power', max: number): number {
  const k = { data: 1.1, brain: 0.6, wiring: 0.35, power: 1.4 }[step]
  return max * k
}

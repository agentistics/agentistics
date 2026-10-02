import { describe, expect, test } from 'bun:test'
import {
  ENTRY_MS, EXIT_MS, VISIBLE, clearing, corridorOf, frameFactor, hiveGeometry, hnorm, hullDistance, hullOf, inkFade, inksFrom, pillDistance, pulseFactor, rectDistance,
  restingAlpha, staggerMs, stepOn, touchesFrame, type Ink,
} from './updateHive'

const C30_ = Math.sqrt(3) / 2
const SIZES: [number, number][] = [[1920, 1080], [1366, 768], [390, 844]]

/** The prototype's real layout: a header block over the hive and a foot block under it — one Ink per line. */
function lines(W: number, H: number): Ink[] {
  const mid = W / 2, out: Ink[] = []
  const line = (cy: number, w: number, h: number) => out.push({ l: mid - w / 2, r: mid + w / 2, t: cy - h / 2, b: cy + h / 2 })
  const top = H * 0.08
  line(top + 6, 90, 11); line(top + 28, Math.min(W - 32, 360), 26)
  const foot = H - H * 0.08
  line(foot - 150, Math.min(W - 32, 330), 20); line(foot - 118, 56, 28); line(foot - 88, Math.min(W - 32, 240), 14)
  line(foot - 66, Math.min(W - 32, 200), 14); line(foot - 38, Math.min(W - 32, 460), 22); line(foot - 6, Math.min(W - 32, 400), 14)
  return out
}

/** Every lattice cell of a stage, as the scene builds them. */
function lattice(W: number, H: number) {
  const g = hiveGeometry(W, H), s = g.S, w = Math.sqrt(3) * s, h = 1.5 * s, cells: { x: number; y: number; seed: number }[] = []
  let k = 0
  for (let row = -2; row < H / h + 2; row++) for (let col = -2; col < W / w + 2; col++) {
    const x = col * w + (row % 2 ? w / 2 : 0), y = row * h
    if (Math.hypot(x - g.cx, y - g.cy) < g.R * 1.35) continue
    cells.push({ x, y, seed: ((k++ * 2654435761) % 1000) / 1000 })
  }
  return { g, cells }
}

describe('the frame exclusion (the loader frame is a hexagon, and so is every cell)', () => {
  for (const [W, H] of SIZES) {
    test(`${W}x${H}: no cell that is drawn lies inside the frame, and none that is wholly outside is dimmed`, () => {
      const { g, cells } = lattice(W, H)
      let inside = 0, outside = 0
      for (const c of cells) {
        const f = frameFactor(c.x, c.y, 1, g), h = hnorm(c.x - g.cx, c.y - g.cy)
        if (h + g.AC <= g.A_CLIP) { expect(f).toBe(0); inside++ }
        if (f > VISIBLE) expect(h + g.AC).toBeGreaterThan(g.A_CLIP)          // drawn ⇒ not wholly inside
        if (h - g.AC - g.A_CLIP >= 16) { expect(f).toBeCloseTo(1, 5); outside++ } // clear of the frame: untouched
      }
      expect(outside).toBeGreaterThan(50)
      void inside
    })
  }
  test('the factor only rises with distance from the frame, along any ray', () => {
    const g = hiveGeometry(1366, 768)
    for (const a of [0, 0.7, 1.9, 3.1, 4.4, 5.6]) {
      let prev = 0
      for (let d = 0; d < g.R * 3; d += 2) {
        const f = frameFactor(g.cx + Math.cos(a) * d, g.cy + Math.sin(a) * d, 1, g)
        expect(f).toBeGreaterThanOrEqual(prev - 1e-9); prev = f
      }
    }
  })
  test('a shrinking cell (the finale pull) is judged by its OWN size, and edge cells are flagged for the clipped path', () => {
    const g = hiveGeometry(1366, 768), x = g.cx + g.A_CLIP + g.AC * 0.2, y = g.cy
    expect(touchesFrame(x, y, 1, g)).toBe(true)
    expect(touchesFrame(g.cx + g.A_CLIP * 3, g.cy, 1, g)).toBe(false)
    expect(frameFactor(g.cx + g.A_CLIP + 6, g.cy, 0.08, g)).toBeGreaterThan(frameFactor(g.cx + g.A_CLIP + 6, g.cy, 1, g))
  })
})

describe('the organic clearing: cells draw back from the TEXT, never from a box', () => {
  for (const [W, H] of SIZES) {
    test(`${W}x${H}: no visible cell's circle touches the rectangle of any line of text (every seed)`, () => {
      const { g, cells } = lattice(W, H), inks = lines(W, H)
      let visible = 0
      for (const c of cells) for (const seed of [0, 0.37, 0.99, c.seed]) {
        const { f } = clearing(c.x, c.y, seed, inks, g)
        if (f > VISIBLE) { visible++; for (const k of inks) expect(rectDistance(c.x, c.y, k)).toBeGreaterThanOrEqual(g.RC) }
      }
      expect(visible).toBeGreaterThan(100)
    })
  }

  test('jitter only ever clears MORE, so the guarantee holds for every seed at once', () => {
    const g = hiveGeometry(1366, 768), inks = lines(1366, 768)
    for (let x = 0; x < 1366; x += 23) for (let y = 0; y < 768; y += 23) {
      let prev = -1
      for (const seed of [0, 0.25, 0.5, 0.75, 1]) { const f = clearing(x, y, seed, inks, g).f; if (prev >= 0) expect(f).toBeLessThanOrEqual(prev + 1e-9); prev = f }
    }
  })

  test('the edge is not a rectangle: along a line the clearing distance varies with the cell, and rounds at the ends', () => {
    const g = hiveGeometry(1920, 1080), k: Ink = { l: 760, r: 1160, t: 800, b: 826 }
    // at the same distance from the long side, a point past the end of the line is cleared LESS than one beside its middle
    const mid = pillDistance(960, 850, k).d, end = pillDistance(1190, 850, k).d
    expect(end).toBeGreaterThan(mid)
    // …and the rectangle distance for those same points would be equal-ish at the side; the pill is what bends
    expect(rectDistance(1190, 850, k)).toBeGreaterThan(rectDistance(960, 850, k))
    // the same cell with different seeds sits at different fade values: the contour is irregular
    const fs = new Set([0.1, 0.4, 0.8].map(s => clearing(960, 915, s, [k], g).f.toFixed(3)))
    expect(fs.size).toBeGreaterThan(1)
  })

  test('the falloff is wider than the old fixed 84 on a big stage and never collapses on a phone', () => {
    expect(inkFade(hiveGeometry(1920, 1080).S)).toBeGreaterThan(84)
    expect(inkFade(hiveGeometry(390, 844).S)).toBeGreaterThanOrEqual(56)
  })

  test('a cell yields AWAY from the nearest line, and with no text nothing yields', () => {
    const g = hiveGeometry(1366, 768), k: Ink = { l: 500, r: 860, t: 600, b: 620 }
    const above = clearing(680, 560, 0.2, [k], g), below = clearing(680, 660, 0.2, [k], g)
    expect(above.py).toBeLessThan(0); expect(below.py).toBeGreaterThan(0)
    expect(clearing(10, 10, 0.5, [], g)).toEqual({ f: 1, px: 0, py: 0 })
  })

  test('inksFrom keeps real lines only and re-origins them on the stage', () => {
    const r = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h })
    expect(inksFrom([r(110, 220, 50, 10), r(0, 0, 0, 0)], { left: 100, top: 200 })).toEqual([{ l: 10, t: 20, r: 60, b: 30 }])
  })
})

describe('the corridor: no cell between the frame and the foot text', () => {
  for (const [W, H] of SIZES) {
    test(`${W}x${H}: no visible cell's centre lies inside the corridor, and none sits in the strip between them`, () => {
      const { g, cells } = lattice(W, H), inks = lines(W, H), hull = corridorOf(inks, g)!
      expect(hull).not.toBeNull()
      const footTop = Math.min(...inks.filter(k => (k.t + k.b) / 2 > g.cy + g.FR).map(k => k.t))
      let inStrip = 0, visible = 0
      for (const c of cells) for (const seed of [0, 0.5, 1, c.seed]) {
        const { f } = clearing(c.x, c.y, seed, inks, g, hull)
        if (f > VISIBLE) {
          visible++
          expect(hullDistance(c.x, c.y, hull).d).toBeGreaterThanOrEqual(g.RC)           // not in it, and not touching it
        }
      }
      // the strip straight under the frame, down to the text: every lattice cell there is cleared
      for (const c of cells) if (Math.abs(c.x - g.cx) < g.FR * C30_ && c.y > g.cy + g.FR && c.y < footTop) { inStrip++; expect(clearing(c.x, c.y, c.seed, inks, g, hull).f).toBeLessThanOrEqual(VISIBLE) }
      expect(inStrip).toBeGreaterThan(0)
      expect(visible).toBeGreaterThan(100)                                                // …while the sides still show the hive
    })
  }
  test('the sides are untouched: cells well to the left and right of the frame keep full strength', () => {
    const { g, cells } = lattice(1920, 1080), inks = lines(1920, 1080), hull = corridorOf(inks, g)
    const far = cells.filter(c => Math.abs(c.x - g.cx) > 700 && c.y > g.cy && c.y < g.H * 0.8)
    expect(far.length).toBeGreaterThan(10)
    for (const c of far) expect(clearing(c.x, c.y, c.seed, inks, g, hull).f).toBeGreaterThan(0.9)
  })
  test('no foot text, no corridor; the hull and its distance behave like a convex polygon', () => {
    const g = hiveGeometry(1366, 768)
    expect(corridorOf([{ l: 600, r: 760, t: 40, b: 60 }], g)).toBeNull()
    const sq = hullOf([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]])
    expect(sq).toHaveLength(4)
    expect(hullDistance(5, 5, sq).d).toBeLessThan(0)
    expect(hullDistance(20, 5, sq).d).toBeCloseTo(10)
    expect(hullDistance(20, 5, sq).nx).toBeCloseTo(1)
  })
  test('the corridor widens from the frame to the text block (a hull, not a bar), and the old behaviour without it is unchanged', () => {
    const g = hiveGeometry(1920, 1080), inks = lines(1920, 1080), hull = corridorOf(inks, g)!
    const xs = (y: number) => { let lo = 0, hi = 0; for (let x = 0; x < 1920; x++) if (hullDistance(x, y, hull).d < 0) { if (!lo) lo = x; hi = x } return hi - lo }
    expect(xs(g.cy + g.FR + 40)).toBeLessThan(xs(Math.min(...inks.filter(k => k.t > g.cy + g.FR).map(k => k.t)) + 4))
    expect(clearing(100, 100, 0.2, inks, g, null).f).toBeGreaterThan(0)
  })
})

describe('transitions never jump', () => {
  test('a cell moves at most dt/ms per frame, in or out, at 30 and 60 fps (and under reduced motion)', () => {
    for (const dt of [8, 16.7, 33, 64]) for (const want of [0, 1] as const) for (const reduced of [false, true]) {
      let on = want ? 0 : 1
      for (let i = 0; i < 400; i++) {
        const n = stepOn(on, want, dt, reduced)
        expect(Math.abs(n - on)).toBeLessThanOrEqual(dt / (reduced ? 160 : want ? ENTRY_MS : EXIT_MS) + 1e-9)
        expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThanOrEqual(1)
        on = n
      }
      expect(on).toBe(want)
    }
  })
  test('the worst single-frame step is small enough not to read as a pop', () => {
    expect(stepOn(0, 1, 64, false)).toBeLessThan(0.15)
    expect(stepOn(1, 0, 64, false)).toBeGreaterThan(0.84)
  })
  test('inner cells enter first and outer cells leave first; reduced motion has no stagger', () => {
    expect(staggerMs(1, 0, false)).toBeLessThan(staggerMs(1, 1, false))
    expect(staggerMs(0, 1, false)).toBeLessThan(staggerMs(0, 0, false))
    expect(staggerMs(1, 0.7, true)).toBe(0)
  })
  test('the restart pulse only dims, never brightens, and only by what was asked', () => {
    for (let t = 0; t < 10; t += 0.13) for (const d of [0, 300, 900]) {
      const f = pulseFactor(1, t, d)
      expect(f).toBeLessThanOrEqual(1); expect(f).toBeGreaterThanOrEqual(0.1)
      expect(pulseFactor(0, t, d)).toBe(1)
    }
  })
  test('the resting twinkle stays within its band; reduced motion is a steady value', () => {
    for (let t = 0; t < 10; t += 0.2) { const a = restingAlpha(t, 0.3, false); expect(a).toBeGreaterThanOrEqual(0.16); expect(a).toBeLessThanOrEqual(0.38) }
    expect(restingAlpha(1, 0.3, true)).toBe(restingAlpha(9, 0.9, true))
  })
})

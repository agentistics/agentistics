/**
 * updateHiveScene.ts — the canvas renderer of the hive ("Colmeia"), treatment A, "a colmeia abre
 * espaço". Ported from the owner-approved prototype (`~/.agentistics/leader/upd-demo/hive-legibility.html`,
 * v4: entry/exit waves, the restart pulse, frame exclusion, the organic clearing around the text, the
 * finale's suction + burst + rings) and measured there at 60 fps.
 *
 * NO SCRIM. The old hive darkened a radial pool behind the text; this one makes room instead — cells
 * near a line of text fade and draw back (`clearing`, `updateHive.ts`), so the type needs no overlay
 * at all. What may and may not be drawn is decided by pure, tested rules; this file only paints them.
 *
 * WHY IT IS FAST. Cells are BATCHED: one path + one stroke per (colour, opacity bucket) instead of
 * a save/translate/stroke/restore per cell, and the settled bulk is blitted from small pre-rendered
 * SPRITES (a blit is a copy, a stroke is a scan-conversion). The few cells touching the frame's edge
 * keep real paths because they are clipped. The progress edge's glow is plain strokes, the logo's
 * glow a pre-rendered sprite, DPR capped at 1.5.
 *
 * THE LOGO IS NEVER REDRAWN (owner rule): the brand raster, drawn into a SQUARE, changed only by
 * scale, opacity and glow.
 */

import { SUCK_S, easeFactor, finaleBeat, finaleLogoPose, runningLogoPose, REDUCED_FINALE_BEAT, type LogoPose } from './updateAnim'
import {
  C30, PULSE_MS, approach, clamp01, clearing, corridorOf, frameFactor, hiveGeometry, hnorm, inksFrom, lerp, pulseFactor, restingAlpha, smooth,
  staggerMs, stepOn, touchesFrame, type HiveGeometry, type Ink,
} from './updateHive'

type RGB = readonly [number, number, number]
const SLATE: RGB = [148, 163, 184], SLATE_HI: RGB = [203, 213, 225], OR: RGB = [245, 158, 11], OR_D: RGB = [217, 119, 6], GREEN: RGB = [16, 185, 129]
const rgb = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3)
const easeIn = (x: number) => Math.pow(clamp01(x), 2.2)
const SPREAD = 0.55
const UX: number[] = [], UY: number[] = []
for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; UX.push(Math.cos(a)); UY.push(Math.sin(a)) }

interface Cell {
  x: number; y: number; d: number; seed: number; orange: boolean
  on: number; want: 0 | 1; wait: number; order: number; dn: number
  /** The share of the cell the text leaves it (and the target it eases to), and the way it yields. */
  rm: number; rmT: number; rmSet: boolean; px: number; py: number
}
interface Spark { x: number; y: number; vx: number; vy: number; life: number; age: number; w: number; col: RGB }

function hexTo(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.moveTo(x + UX[0]! * r, y + UY[0]! * r)
  for (let i = 1; i < 6; i++) ctx.lineTo(x + UX[i]! * r, y + UY[i]! * r)
  ctx.closePath()
}

/** Every cell of a frame, grouped so the canvas does one stroke per (colour, opacity bucket). */
class Batch {
  sa: number[][][] = [[], []]
  fa: number[][][] = [[], []]
  ss: string[][] = [[], []]
  fs: string[][] = [[], []]
  n = 0
  private sprites = new Map<string, HTMLCanvasElement>()
  private skey = ''
  constructor(private nb: number, private maxA: number, private nf = 0, private maxF = 0) {
    const col = [SLATE, OR]
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < nb; i++) { this.sa[c]!.push([]); this.ss[c]!.push(rgb(col[c]!, maxA * (i + 1) / nb)) }
      for (let i = 0; i < nf; i++) { this.fa[c]!.push([]); this.fs[c]!.push(rgb(col[c]!, maxF * (i + 1) / nf)) }
    }
  }
  reset(): void { this.n = 0; for (let c = 0; c < 2; c++) { for (const l of this.sa[c]!) l.length = 0; for (const l of this.fa[c]!) l.length = 0 } }
  hasFill(): boolean { return this.fa[0]!.some(l => l.length) || this.fa[1]!.some(l => l.length) }
  add(x: number, y: number, r: number, col: 0 | 1, sa: number, fa: number): void {
    if (sa > 0.004) { const li = Math.min(this.nb - 1, Math.max(0, Math.ceil(sa / this.maxA * this.nb) - 1)); this.sa[col]![li]!.push(x, y, r); this.n++ }
    if (fa > 0.003 && this.nf) { const fi = Math.min(this.nf - 1, Math.max(0, Math.ceil(fa / this.maxF * this.nf) - 1)); this.fa[col]![fi]!.push(x, y, r) }
  }
  /** Real paths: used for the clipped cells at the frame's edge. */
  flush(ctx: CanvasRenderingContext2D): void {
    ctx.lineWidth = 1; ctx.lineJoin = 'miter'
    for (let c = 0; c < 2; c++) for (let b = 0; b < this.nb; b++) {
      const l = this.sa[c]![b]!; if (!l.length) continue
      ctx.beginPath(); for (let j = 0; j < l.length; j += 3) hexTo(ctx, l[j]!, l[j + 1]!, l[j + 2]!)
      ctx.strokeStyle = this.ss[c]![b]!; ctx.stroke()
    }
    for (let c = 0; c < 2; c++) for (let b = 0; b < this.nf; b++) {
      const l = this.fa[c]![b]!; if (!l.length) continue
      ctx.beginPath(); for (let j = 0; j < l.length; j += 3) hexTo(ctx, l[j]!, l[j + 1]!, l[j + 2]!)
      ctx.fillStyle = this.fs[c]![b]!; ctx.fill()
    }
  }
  /** Sprites: each (colour, bucket) outline is drawn ONCE and then blitted — the settled bulk. */
  flushSprites(ctx: CanvasRenderingContext2D, RC: number, DPR: number): void {
    const key = `${RC}|${DPR}`
    if (this.skey !== key) { this.skey = key; this.sprites = new Map() }
    const half = RC + 2, px = Math.ceil(2 * half * DPR)
    const get = (kind: 's' | 'f', c: number, b: number): HTMLCanvasElement => {
      const id = `${kind}${c}_${b}`
      let spr = this.sprites.get(id)
      if (!spr) {
        spr = document.createElement('canvas'); spr.width = spr.height = px
        const g = spr.getContext('2d')!; g.setTransform(DPR, 0, 0, DPR, 0, 0)
        g.beginPath(); hexTo(g, half, half, RC)
        if (kind === 's') { g.lineWidth = 1; g.strokeStyle = this.ss[c]![b]!; g.stroke() } else { g.fillStyle = this.fs[c]![b]!; g.fill() }
        this.sprites.set(id, spr)
      }
      return spr
    }
    for (const [kind, arr, nn] of [['s', this.sa, this.nb], ['f', this.fa, this.nf]] as const) {
      for (let c = 0; c < 2; c++) for (let b = 0; b < nn; b++) {
        const l = arr[c]![b]!; if (!l.length) continue
        const spr = get(kind, c, b)
        for (let j = 0; j < l.length; j += 3) {
          if (Math.abs(l[j + 2]! - RC) < 0.02) ctx.drawImage(spr, Math.round((l[j]! - half) * DPR) / DPR, Math.round((l[j + 1]! - half) * DPR) / DPR, px / DPR, px / DPR) // settled: a 1:1 copy, no resampling
          else { const h = half * l[j + 2]! / RC; ctx.drawImage(spr, l[j]! - h, l[j + 1]! - h, 2 * h, 2 * h) }
        }
      }
    }
  }
}

export interface HiveRenderer {
  resize(): void
  drawRunning(o: { p: number; indet: boolean; now: number; dt: number }): void
  drawFinale(o: { t: number; now: number; dt: number }): void
  /** The elements whose lines of text the hive must leave clear. */
  setInk(els: (HTMLElement | null)[]): void
  dispose(): void
}

export function createHive(canvas: HTMLCanvasElement, logo: HTMLImageElement, reduced: boolean): HiveRenderer {
  const ctx = canvas.getContext('2d')!
  let g: HiveGeometry = hiveGeometry(0, 0), DPR = 1
  let cells: Cell[] = []
  let bgLayer: HTMLCanvasElement | null = null, glowSprite: HTMLCanvasElement | null = null, edgeClip: Path2D | null = null
  let inkEls: (HTMLElement | null)[] = [], inks: Ink[] = [], inksAt = -1e9
  let sparks: Spark[] = [], burstAt = -1, inFinale = false
  let pulseAmt = 0, frameA = 1
  const pose: LogoPose = { scale: 1, alpha: 1, glow: 0 }
  const main = new Batch(12, 0.85, 6, 0.25), edge = new Batch(12, 0.85, 6, 0.25), rest = new Batch(4, 0.07)
  const small = () => g.W < 640

  function buildCells() {
    const s = g.S, w = Math.sqrt(3) * s, h = 1.5 * s
    cells = []
    for (let row = -2; row < g.H / h + 2; row++) for (let col = -2; col < g.W / w + 2; col++) {
      const x = col * w + (row % 2 ? w / 2 : 0), y = row * h, d = Math.hypot(x - g.cx, y - g.cy)
      if (d < g.R * 1.35) continue
      cells.push({ x, y, d, seed: Math.random(), orange: Math.random() < 0.06, on: 0, want: 0, wait: 0, order: 0, dn: 0, rm: 1, rmT: 1, rmSet: false, px: 0, py: 0 })
    }
    let md = 1
    for (const c of cells) if (c.d > md) md = c.d
    for (const c of cells) { c.order = (c.d / md) * 0.88 + c.seed * 0.12; c.dn = c.d / md }
  }

  function layer(draw: (b: CanvasRenderingContext2D) => void): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = Math.round(g.W * DPR); c.height = Math.round(g.H * DPR)
    const b = c.getContext('2d')!
    b.setTransform(DPR, 0, 0, DPR, 0, 0)
    draw(b)
    return c
  }

  function resize() {
    const W = canvas.clientWidth || window.innerWidth, H = canvas.clientHeight || window.innerHeight
    if (cells.length && W === g.W && H === g.H) return // same size: keep the hive standing
    DPR = Math.min(window.devicePixelRatio || 1, 1.5)
    g = hiveGeometry(W, H)
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    bgLayer = layer(b => {
      const gr = b.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, Math.max(W, H) * 0.7)
      gr.addColorStop(0, '#111118'); gr.addColorStop(1, '#0a0a0f')
      b.fillStyle = gr; b.fillRect(0, 0, W, H)
    })
    buildCells(); inksAt = -1e9
    // the clip for cells that touch the frame: the whole stage MINUS the frame's hexagon (even-odd)
    const circ = g.A_CLIP / C30, pad = g.S * 3 + 8
    edgeClip = new Path2D()
    edgeClip.rect(g.cx - circ - pad, g.cy - circ - pad, 2 * (circ + pad), 2 * (circ + pad))
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 3, x = g.cx + Math.cos(a) * circ, y = g.cy + Math.sin(a) * circ
      if (i) edgeClip.lineTo(x, y); else edgeClip.moveTo(x, y)
    }
    edgeClip.closePath()
    // the logo's glow: rendered once, drawn scaled with globalAlpha (replaces a per-frame radial gradient)
    glowSprite = document.createElement('canvas'); glowSprite.width = glowSprite.height = 256
    const gc = glowSprite.getContext('2d')!, gr = gc.createRadialGradient(128, 128, 128 * 0.08, 128, 128, 128)
    gr.addColorStop(0, rgb(OR_D, 0.24)); gr.addColorStop(1, rgb(OR_D, 0)); gc.fillStyle = gr; gc.fillRect(0, 0, 256, 256)
  }

  /** Re-measure the lines of text (twice a second: the phrase and the figures change width). */
  function measureInk(now: number) {
    if (now - inksAt < 500) return
    inksAt = now
    const sr = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0 }
    inks = inksFrom(inkEls.filter((e): e is HTMLElement => !!e).map(e => e.getBoundingClientRect()), sr)
    const hull = corridorOf(inks, g)
    for (const c of cells) {
      const r = clearing(c.x, c.y, c.seed, inks, g, hull)
      c.rmT = r.f; if (!c.rmSet) { c.rm = r.f; c.rmSet = true }
      c.px = r.px; c.py = r.py
    }
  }

  function place(x: number, y: number, grow: number, a: number, c: Cell) {
    const f = frameFactor(x, y, grow, g)
    if (f <= 0) return // wholly inside the frame: never drawn there
    a *= f
    if (a < 0.004) return
    const sa = Math.min(0.85, a * (c.orange ? 2.4 : 1.6)), fa = c.orange || c.seed > 0.86 ? a * (c.orange ? 0.55 : 0.22) : 0
    ;(touchesFrame(x, y, grow, g) ? edge : main).add(x, y, g.RC * grow, c.orange ? 1 : 0, sa, fa)
  }

  function hexFrame(p: number, trackA: number, edgesA: number) {
    const fr = g.FR, pts = (i: number): [number, number] => { const a = -Math.PI / 2 + i * Math.PI / 3; return [g.cx + Math.cos(a) * fr, g.cy + Math.sin(a) * fr] }
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    ctx.strokeStyle = rgb(OR, 0.16 * trackA); ctx.lineWidth = 2; ctx.beginPath()
    for (let i = 0; i <= 6; i++) { const [x, y] = pts(i); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) }
    ctx.stroke()
    const edges = 6 * clamp01(p), full = Math.floor(edges), part = edges - full
    if (edges > 0.001 && edgesA > 0.002) {
      ctx.beginPath(); ctx.moveTo(g.cx, g.cy - fr)
      for (let i = 1; i <= full; i++) { const [x, y] = pts(i); ctx.lineTo(x, y) }
      if (part > 0 && full < 6) { const [x0, y0] = pts(full), [x1, y1] = pts(full + 1); ctx.lineTo(x0 + (x1 - x0) * part, y0 + (y1 - y0) * part) }
      // the glow is two wide translucent strokes under the crisp one (it was shadowBlur: a gaussian per frame)
      ctx.strokeStyle = rgb(OR, 0.10 * edgesA); ctx.lineWidth = 9; ctx.stroke()
      ctx.strokeStyle = rgb(OR, 0.18 * edgesA); ctx.lineWidth = 5; ctx.stroke()
      ctx.strokeStyle = rgb(OR, 0.95 * edgesA); ctx.lineWidth = 2.5; ctx.stroke()
    }
    ctx.restore()
  }

  function drawLogo(dt: number, target: LogoPose, tau: number) {
    for (const k of ['scale', 'alpha', 'glow'] as const) pose[k] += (target[k] - pose[k]) * easeFactor(dt, tau)
    if (!logo.complete || !logo.naturalWidth) return
    const s = g.R * 1.15 * pose.scale
    if (pose.glow > 0.01 && glowSprite) { const r = s * (1.15 + pose.glow * 0.6); ctx.save(); ctx.globalAlpha = pose.glow; ctx.drawImage(glowSprite, g.cx - r, g.cy - r, 2 * r, 2 * r); ctx.restore() }
    ctx.save(); ctx.globalAlpha = pose.alpha
    ctx.drawImage(logo, g.cx - s / 2, g.cy - s / 2, s, s) // square — scale, opacity and glow only; never the geometry
    ctx.restore()
  }

  function flashRings(t: number) {
    for (let r = 0; r < 2; r++) {
      const rr = t - r * 0.35
      if (rr < 0 || rr > 1.8) continue
      ctx.strokeStyle = rgb(r ? GREEN : OR, Math.max(0, 0.6 - rr * 0.32)); ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.arc(g.cx, g.cy, g.R * (1.1 + rr * 1.7), 0, Math.PI * 2); ctx.stroke()
    }
  }

  function startBurst(now: number) {
    burstAt = now; sparks = []
    if (reduced) return
    const n = small() ? 34 : 56
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.25, sp = g.R * (2.2 + Math.random() * 2.6), r = Math.random()
      sparks.push({ x: g.cx + Math.cos(a) * g.R * 0.55, y: g.cy + Math.sin(a) * g.R * 0.55, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.55 + Math.random() * 0.45, age: 0, w: 1.2 + Math.random() * 1.3, col: r < 0.72 ? OR : r < 0.88 ? SLATE_HI : GREEN })
    }
  }

  function drawBurst(now: number, dt: number) {
    if (burstAt < 0) return
    const t = (now - burstAt) / 1000
    if (t < 0.22 && !reduced) {
      const f = 1 - t / 0.22, gr = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.R * 1.6)
      gr.addColorStop(0, rgb([255, 237, 213], 0.45 * f)); gr.addColorStop(0.4, rgb(OR, 0.22 * f)); gr.addColorStop(1, rgb(OR, 0))
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(g.cx, g.cy, g.R * 1.6, 0, Math.PI * 2); ctx.fill()
    }
    const d = dt / 1000, drag = Math.exp(-d * 3.2)
    ctx.save(); ctx.lineCap = 'round'
    sparks = sparks.filter(q => {
      q.age += d
      if (q.age >= q.life) return false
      const ox = q.x, oy = q.y
      q.vx *= drag; q.vy *= drag; q.x += q.vx * d; q.y += q.vy * d
      const a = 1 - q.age / q.life
      ctx.strokeStyle = rgb(q.col, 0.85 * a * a); ctx.lineWidth = q.w
      ctx.beginPath(); ctx.moveTo(ox - (q.x - ox) * 1.5, oy - (q.y - oy) * 1.5); ctx.lineTo(q.x, q.y); ctx.stroke()
      return true
    })
    ctx.restore()
  }

  function draw(p: number, indet: boolean, now: number, dt: number, fin: { t: number } | null) {
    const k = reduced ? 1 : easeFactor(dt), t = now / 1000
    measureInk(now)
    pulseAmt = approach(pulseAmt, indet && !reduced ? 1 : 0, dt / PULSE_MS)
    if (fin && !inFinale) { inFinale = true; burstAt = -1; sparks = [] }
    if (!fin && inFinale) { inFinale = false; burstAt = -1; sparks = []; for (const c of cells) { c.on = 0; c.want = 0; c.wait = 0 } }
    main.reset(); edge.reset(); rest.reset()
    const ft = fin ? fin.t : 0
    for (const c of cells) {
      c.rm += (c.rmT - c.rm) * (reduced ? 1 : k * 0.5)
      // the faint resting grid, per cell so it can make room too
      if (!fin && c.rm > 0.01) {
        const sp = (1 - c.rm) * g.S * SPREAD, x = c.x + c.px * sp, y = c.y + c.py * sp
        if (hnorm(x - g.cx, y - g.cy) - g.AC >= g.A_CLIP + 2) rest.add(x, y, g.RC, 0, 0.07 * c.rm, 0)
      }
      const pull = reduced ? 0 : 0.05 * (1 - c.dn)
      if (fin) {
        // FINALE: the field is sucked into the centre, staggered by distance; clipped by the frame so cells vanish INTO its edge
        if (reduced) { const w = 1 - clamp01(ft / 0.3); if (w <= 0) continue; place(c.x, c.y, 1, 0.27 * w * c.rm, c); continue }
        const local = clamp01((ft - c.dn * SUCK_S * 0.45) / (SUCK_S * 0.55))
        if (local >= 1) continue
        const e = easeIn(local), bx = c.x + (g.cx - c.x) * pull, by = c.y + (g.cy - c.y) * pull
        const aRun = 0.16 + 0.22 * (0.5 + 0.5 * Math.sin(t * 1.6 + c.seed * 6.3)), aFin = (0.35 + 0.4 * c.seed) * (1 - e * 0.4)
        // the text is still on screen until the burst: the field keeps clear of it on the way in too
        place(lerp(bx, g.cx, e), lerp(by, g.cy, e), 1 - e * 0.92, lerp(aRun, aFin, smooth(ft / 0.3)) * c.rm, c)
        continue
      }
      const want: 0 | 1 = c.order < p * 1.02 ? 1 : 0
      if (want !== c.want) { c.want = want; c.wait = staggerMs(want, c.dn, reduced) }
      if (c.wait > 0) c.wait -= dt; else c.on = stepOn(c.on, want, dt, reduced)
      if (c.on < 0.004) continue
      const ev = c.want ? easeOut(c.on) : smooth(c.on)
      const grow = reduced ? 1 : 0.6 + 0.4 * ev, away = reduced || c.want ? 0 : (1 - ev) * g.S * 0.35, pl = c.on * pull
      let x = c.x + (g.cx - c.x) * pl, y = c.y + (g.cy - c.y) * pl
      if (away) { const ox = c.x - g.cx, oy = c.y - g.cy, om = Math.hypot(ox, oy) || 1; x += ox / om * away; y += oy / om * away }
      let a = restingAlpha(t, c.seed, reduced)
      a *= pulseFactor(pulseAmt, t, c.d)
      a *= ev * c.rm
      if (a < 0.004) continue
      const sp = (1 - c.rm) * g.S * SPREAD
      place(x + c.px * sp, y + c.py * sp, grow, a, c)
    }
    ctx.drawImage(bgLayer!, 0, 0, g.W, g.H)
    rest.flushSprites(ctx, g.RC, DPR); main.flushSprites(ctx, g.RC, DPR)
    if (edge.n || edge.hasFill()) { ctx.save(); ctx.clip(edgeClip!, 'evenodd'); edge.flush(ctx); ctx.restore() }

    if (!fin) {
      frameA = approach(frameA, 1, dt / 600)
      hexFrame(p, frameA, frameA)
      drawLogo(dt, runningLogoPose(p, indet, now, reduced), 220)
      return
    }
    // the frame stays whole while the field is pulled in, then fades just before the burst (a cut would pop)
    frameA = reduced ? 0 : 1 - smooth((ft - (SUCK_S - 0.25)) / 0.25)
    if (frameA > 0.002) hexFrame(1, frameA, frameA)
    const beat = reduced ? REDUCED_FINALE_BEAT : finaleBeat(ft)
    drawLogo(dt, finaleLogoPose(reduced ? SUCK_S : ft, reduced), reduced ? 120 : 70)
    if (!reduced && beat.burst && burstAt < 0) startBurst(now)
    drawBurst(now, dt)
    if (reduced) flashRings(0.9); else if (beat.burst) flashRings(beat.after)
  }

  return {
    resize,
    setInk(els) { inkEls = els; inksAt = -1e9 },
    drawRunning({ p, indet, now, dt }) { draw(p, indet, now, dt, null) },
    drawFinale({ t, now, dt }) { draw(1, false, now, dt, { t }) },
    dispose() { cells = []; sparks = []; bgLayer = null; glowSprite = null; edgeClip = null },
  }
}

/**
 * updateScene.ts — the canvas behind the update loader and its finale. Two scenes, one engine:
 * the CORE ("Núcleo": data streams falling into rings that charge) and the HIVE ("Colmeia": a
 * hexagonal field that fills in from the centre outward). Ported from the owner-approved reference
 * (`~/.agentistics/leader/upd-demo/reference.html`), which was measured at a steady 60 fps.
 *
 * WHY IT IS FAST. Everything static is painted ONCE per resize into an offscreen layer (the
 * background and the hive's faint grid) and composited with one `drawImage` per frame; nothing
 * here uses `shadowBlur` except the hive's single progress edge. Time-based easing (`updateAnim.ts`)
 * means the same feel at any frame rate. Mobile gets fewer particles and a pixel ratio of at most
 * 1.5.
 *
 * THE LOGO IS NEVER REDRAWN (owner rule): it is the brand raster, drawn into a SQUARE with
 * `drawImage` and changed only by scale, opacity and a glow behind it (`LogoPose`).
 *
 * The scene owns no clock and no DOM besides the canvas: the caller passes `now`, `dt` and what to
 * show, so the same engine serves the loader (real progress) and the finale (a timeline).
 */

import { SUCK_S, clamp01, finaleBeat, finaleLogoPose, runningLogoPose, type LogoPose, easeFactor } from './updateAnim'

type RGB = readonly [number, number, number]
const SLATE: RGB = [148, 163, 184], SLATE_HI: RGB = [203, 213, 225], OR: RGB = [245, 158, 11], OR_D: RGB = [217, 119, 6]
const CYAN: RGB = [6, 182, 212], GREEN: RGB = [16, 185, 129], BG: RGB = [10, 10, 15]
const rgb = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3)
const easeIn = (x: number) => Math.pow(clamp01(x), 2.2)

export type SceneVariant = 'core' | 'hive'

interface Cell { x: number; y: number; d: number; seed: number; orange: boolean; on: number; order: number; dn: number }
interface Part { x: number; y: number; v: number; col: RGB }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; age: number; w: number; col: RGB }

export interface Scene {
  resize(): void
  /** One frame of the real loader. `p` is the already-eased overall progress. */
  drawRunning(o: { p: number; indet: boolean; now: number; dt: number }): void
  /** One frame of the finale, `t` seconds in. */
  drawFinale(o: { t: number; now: number; dt: number }): void
  /** Elements that need a soft dark pool behind them (hive only, while the loader is on screen). */
  setScrim(els: (HTMLElement | null)[]): void
  dispose(): void
}

export function createScene(canvas: HTMLCanvasElement, variant: SceneVariant, logo: HTMLImageElement, reduced: boolean): Scene {
  const ctx = canvas.getContext('2d')!
  let W = 0, H = 0, DPR = 1, cx = 0, cy = 0, R = 0
  let bgLayer: HTMLCanvasElement | null = null, hexBase: HTMLCanvasElement | null = null
  let cells: Cell[] = [], cellPath: Path2D | null = null
  let parts: Part[] = [], sparks: Spark[] = [], burstAt = -1
  let scrimEls: (HTMLElement | null)[] = []
  let rects: DOMRect[] = [], rectsAt = -1e9

  const small = () => W < 640

  function makeLayer(draw: (b: CanvasRenderingContext2D) => void): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = Math.round(W * DPR); c.height = Math.round(H * DPR)
    const b = c.getContext('2d')!
    b.setTransform(DPR, 0, 0, DPR, 0, 0)
    draw(b)
    return c
  }

  function hexPath(s: number): Path2D {
    const p = new Path2D()
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + i * Math.PI / 3
      if (i) p.lineTo(Math.cos(a) * s, Math.sin(a) * s); else p.moveTo(Math.cos(a) * s, Math.sin(a) * s)
    }
    p.closePath()
    return p
  }

  function buildHex() {
    const s = Math.max(14, Math.min(W, H) / 26), w = Math.sqrt(3) * s, h = 1.5 * s
    cellPath = hexPath(s * 0.86); cells = []
    for (let row = -2; row < H / h + 2; row++) for (let col = -2; col < W / w + 2; col++) {
      const x = col * w + (row % 2 ? w / 2 : 0), y = row * h, d = Math.hypot(x - cx, y - cy)
      if (d < R * 1.35) continue
      cells.push({ x, y, d, seed: Math.random(), orange: Math.random() < 0.06, on: 0, order: 0, dn: 0 })
    }
    let md = 1
    for (const c of cells) if (c.d > md) md = c.d
    for (const c of cells) { c.order = (c.d / md) * 0.88 + c.seed * 0.12; c.dn = c.d / md }
    hexBase = makeLayer(b => {
      b.strokeStyle = rgb(SLATE, 0.07); b.lineWidth = 1
      for (const c of cells) { b.save(); b.translate(c.x, c.y); b.stroke(cellPath!); b.restore() }
    })
  }

  function resize() {
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    W = canvas.clientWidth || window.innerWidth; H = canvas.clientHeight || window.innerHeight
    DPR = Math.min(dpr, W < 640 ? 1.5 : 2)
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    cx = W / 2; cy = H * 0.47; R = Math.min(W, H) * (W < 640 ? 0.15 : 0.12)
    bgLayer = makeLayer(b => {
      const g = b.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7)
      g.addColorStop(0, '#111118'); g.addColorStop(1, '#0a0a0f')
      b.fillStyle = g; b.fillRect(0, 0, W, H)
    })
    if (variant === 'hive') buildHex()
    parts = []; rectsAt = -1e9
  }

  // ---- shared pieces ----------------------------------------------------------------------------

  function drawLogo(pose: LogoPose) {
    if (!logo.complete || !logo.naturalWidth) return
    const s = R * 1.15 * pose.scale
    if (pose.glow > 0) {
      const r = s * (1.15 + pose.glow * 0.6)
      const g = ctx.createRadialGradient(cx, cy, s * 0.15, cx, cy, r)
      g.addColorStop(0, rgb(OR_D, 0.24 * pose.glow)); g.addColorStop(1, rgb(OR_D, 0))
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill()
    }
    ctx.save(); ctx.globalAlpha = pose.alpha
    ctx.drawImage(logo, cx - s / 2, cy - s / 2, s, s) // square, scale/opacity/glow only — never the geometry
    ctx.restore()
  }

  function scrim(r: DOMRect, strength: number) {
    if (strength <= 0 || !r.width) return
    const ex = r.left + r.width / 2, ey = r.top + r.height / 2, rx = r.width / 2 + 120, ry = r.height / 2 + 70
    ctx.save(); ctx.translate(ex, ey); ctx.scale(rx, ry)
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
    g.addColorStop(0, rgb(BG, 0.9 * strength)); g.addColorStop(0.55, rgb(BG, 0.78 * strength)); g.addColorStop(1, rgb(BG, 0))
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill(); ctx.restore()
  }

  function drawScrims(strength: number, now: number) {
    if (now - rectsAt > 400) { rects = scrimEls.map(e => (e ? e.getBoundingClientRect() : new DOMRect())); rectsAt = now }
    for (const r of rects) scrim(r, strength)
  }

  function flashRings(t: number) {
    for (let r = 0; r < 2; r++) {
      const rr = t - r * 0.35
      if (rr < 0 || rr > 1.8) continue
      ctx.strokeStyle = rgb(r ? GREEN : OR, Math.max(0, 0.6 - rr * 0.32)); ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.arc(cx, cy, R * (1.1 + rr * 1.7), 0, Math.PI * 2); ctx.stroke()
    }
  }

  function startBurst(now: number) {
    burstAt = now; sparks = []
    if (reduced) return
    const n = small() ? 34 : 56
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.25, sp = R * (2.2 + Math.random() * 2.6), r = Math.random()
      sparks.push({ x: cx + Math.cos(a) * R * 0.55, y: cy + Math.sin(a) * R * 0.55, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.55 + Math.random() * 0.45, age: 0, w: 1.2 + Math.random() * 1.3, col: r < 0.72 ? OR : r < 0.88 ? SLATE_HI : GREEN })
    }
  }

  function drawBurst(now: number, dt: number) {
    if (burstAt < 0) return
    const t = (now - burstAt) / 1000
    if (t < 0.22 && !reduced) {
      const f = 1 - t / 0.22, g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.6)
      g.addColorStop(0, rgb([255, 237, 213], 0.45 * f)); g.addColorStop(0.4, rgb(OR, 0.22 * f)); g.addColorStop(1, rgb(OR, 0))
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.6, 0, Math.PI * 2); ctx.fill()
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

  // ---- B · Colmeia ------------------------------------------------------------------------------

  function hexFrame(p: number, alphaTrack: number) {
    const fr = R * 1.4
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    ctx.strokeStyle = rgb(OR, 0.16 * alphaTrack); ctx.lineWidth = 2; ctx.beginPath()
    for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + i * Math.PI / 3; if (i) ctx.lineTo(cx + Math.cos(a) * fr, cy + Math.sin(a) * fr); else ctx.moveTo(cx + Math.cos(a) * fr, cy + Math.sin(a) * fr) }
    ctx.stroke()
    const edges = 6 * clamp01(p), full = Math.floor(edges), part = edges - full
    ctx.strokeStyle = rgb(OR, 0.95); ctx.lineWidth = 2.5; ctx.shadowColor = rgb(OR, 0.6); ctx.shadowBlur = 8
    ctx.beginPath(); ctx.moveTo(cx, cy - fr)
    for (let i = 1; i <= full; i++) { const a = -Math.PI / 2 + i * Math.PI / 3; ctx.lineTo(cx + Math.cos(a) * fr, cy + Math.sin(a) * fr) }
    if (part > 0 && full < 6) {
      const a0 = -Math.PI / 2 + full * Math.PI / 3, a1 = a0 + Math.PI / 3
      ctx.lineTo(cx + (Math.cos(a0) + (Math.cos(a1) - Math.cos(a0)) * part) * fr, cy + (Math.sin(a0) + (Math.sin(a1) - Math.sin(a0)) * part) * fr)
    }
    if (edges > 0.001) ctx.stroke()
    ctx.restore()
  }

  function drawHex(p: number, indet: boolean, now: number, k: number, fin: { t: number } | null) {
    const t = now / 1000
    ctx.drawImage(bgLayer!, 0, 0, W, H)
    if (!fin) ctx.drawImage(hexBase!, 0, 0, W, H)
    else { ctx.save(); ctx.globalAlpha = 1 - easeOut(fin.t / (SUCK_S * 0.6)); ctx.drawImage(hexBase!, 0, 0, W, H); ctx.restore() }
    for (const c of cells) {
      let x = c.x, y = c.y, sc = 1, a: number
      if (fin) {
        const local = clamp01((fin.t - c.dn * SUCK_S * 0.45) / (SUCK_S * 0.55))
        if (local >= 1) continue
        const e = easeIn(local)
        x = lerp(c.x, cx, e); y = lerp(c.y, cy, e); sc = 1 - e * 0.92
        a = (0.35 + 0.4 * c.seed) * (1 - e * 0.4)
      } else {
        const want = c.order < p * 1.02 ? 1 : 0
        c.on += (want - c.on) * k * 0.6
        if (c.on < 0.01) continue
        const pull = reduced ? 0 : c.on * 0.05 * (1 - c.dn)
        x = c.x + (cx - c.x) * pull; y = c.y + (cy - c.y) * pull
        a = 0.16 + 0.22 * (0.5 + 0.5 * Math.sin(t * 1.6 + c.seed * 6.3))
        if (indet && !reduced) a *= 0.55 + 0.45 * Math.sin(t * 2.6 - c.d / 70)
        a *= c.on
      }
      ctx.save(); ctx.translate(x, y); if (sc !== 1) ctx.scale(sc, sc)
      const col = c.orange ? OR : SLATE
      ctx.strokeStyle = rgb(col, Math.min(0.85, a * (c.orange ? 2.4 : 1.6))); ctx.lineWidth = 1 / sc; ctx.stroke(cellPath!)
      if (c.orange || c.seed > 0.86) { ctx.fillStyle = rgb(col, a * (c.orange ? 0.55 : 0.22)); ctx.fill(cellPath!) }
      ctx.restore()
    }
    if (!fin) hexFrame(p, 1)
    else if (fin.t < SUCK_S) hexFrame(1, 1 - fin.t / SUCK_S)
  }

  // ---- A · Núcleo -------------------------------------------------------------------------------

  function spawnPart() {
    const a = Math.random() * Math.PI * 2, d = Math.max(W, H) * (0.45 + Math.random() * 0.2), r = Math.random()
    parts.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, v: 90 + Math.random() * 120, col: r < 0.55 ? OR : r < 0.85 ? SLATE : CYAN })
  }

  const RINGS = [{ r: 1.05, w: 3, segs: 24, col: OR_D }, { r: 1.25, w: 2, segs: 36, col: OR }, { r: 1.45, w: 1.5, segs: 48, col: SLATE }] as const

  function drawCore(p: number, indet: boolean, now: number, dt: number, fin: { t: number } | null) {
    ctx.drawImage(bgLayer!, 0, 0, W, H)
    const speedMul = fin ? 2.6 + fin.t * 3 : indet ? 0.35 : 1
    const want = reduced || fin ? 0 : (small() ? 60 : 140) * (indet ? 0.35 : 0.45 + 0.55 * p)
    while (parts.length < want) spawnPart()
    const reach = Math.max(W, H)
    ctx.save(); ctx.lineCap = 'round'
    parts = parts.filter(q => {
      const dx = cx - q.x, dy = cy - q.y, d = Math.hypot(dx, dy)
      if (d < R * 0.55) return false
      const step = Math.min(d, q.v * speedMul * dt / 1000 * (1 + 2.2 * (1 - Math.min(1, d / (reach * 0.5)))))
      const nx = q.x + dx / d * step, ny = q.y + dy / d * step
      ctx.strokeStyle = rgb(q.col, Math.min(0.9, 0.25 + (1 - d / (reach * 0.6)))); ctx.lineWidth = 1.6
      ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(nx, ny); ctx.stroke(); q.x = nx; q.y = ny
      return true
    })
    ctx.restore()
    const rot = reduced ? 0 : now / (indet ? 1400 : 4000)
    const shrink = fin ? 1 - easeIn(fin.t / SUCK_S) : 1
    if (shrink > 0.02) {
      RINGS.forEach((ring, kk) => {
        const litF = ring.segs * clamp01(fin ? 1 : p * (1.15 - kk * 0.12))
        for (let s = 0; s < ring.segs; s++) {
          const a0 = (s / ring.segs) * Math.PI * 2 + rot * (kk % 2 ? -1 : 1), a1 = a0 + (Math.PI * 2 / ring.segs) * 0.6
          const lit = clamp01(litF - s)
          ctx.strokeStyle = lit > 0 ? rgb(ring.col, 0.15 + 0.85 * lit) : 'rgba(255,255,255,0.06)'
          ctx.lineWidth = ring.w; ctx.beginPath(); ctx.arc(cx, cy, R * ring.r * shrink, a0, a1); ctx.stroke()
        }
      })
      ctx.strokeStyle = rgb(OR, 0.95 * shrink); ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.7 * shrink, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (fin ? 1 : p)); ctx.stroke()
    }
  }

  // ---- the two entry points ---------------------------------------------------------------------

  return {
    resize,
    setScrim(els) { scrimEls = els; rectsAt = -1e9 },
    drawRunning({ p, indet, now, dt }) {
      // Reduced motion draws a settled frame: cells snap, nothing travels.
      const k = reduced ? 1 : easeFactor(dt)
      if (variant === 'hive') drawHex(p, indet, now, k, null); else drawCore(p, indet, now, dt, null)
      drawLogo(runningLogoPose(p, indet, now, reduced))
      if (variant === 'hive') drawScrims(1, now)
    },
    drawFinale({ t, now, dt }) {
      const beat = finaleBeat(t)
      const ft = reduced ? SUCK_S : t
      const fin = { t: ft }
      if (variant === 'hive') drawHex(1, false, now, 1, fin); else drawCore(1, false, now, dt, fin)
      drawLogo(finaleLogoPose(ft, reduced))
      if (!reduced && beat.burst && burstAt < 0) startBurst(now)
      drawBurst(now, dt)
      if (reduced) { flashRings(0.9) } else if (beat.burst) flashRings(beat.after)
    },
    dispose() { parts = []; sparks = []; cells = []; bgLayer = null; hexBase = null },
  }
}

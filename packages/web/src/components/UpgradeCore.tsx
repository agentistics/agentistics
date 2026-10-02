/**
 * UpgradeCore.tsx — the loader's living picture: data absorbed into a core that builds itself.
 *
 * One canvas, one frame loop, no shadows (canvas `shadowBlur` is the expensive call; the glow is a
 * pre-rendered sprite composited with `lighter`). The loop reads `fraction`/`step` from refs, so a
 * new poll answer changes what is drawn without restarting anything, and it stops while the tab is
 * hidden. Budgets (particles, pixel ratio, frame rate) are `coreBudget` — tested, not guessed.
 * Under reduced motion there is NO loop: one calm static frame, redrawn when the charge changes.
 */

import { useEffect, useRef } from 'react'
import type { UpdateStep } from '../lib/updateI18n'
import { circuitLit, circuitTraces, coreBudget, corePieces, piecesLit, spawnRate } from '../lib/upgradeCore'

interface Props {
  fraction: number
  step: UpdateStep
  size: number
  isMobile: boolean
  reducedMotion: boolean
}

interface Particle { a: number; r: number; v: number; w: number; hue: 0 | 1 | 2; life: number }

const AMBER = [249, 115, 22] as const
const GOLD = [251, 191, 36] as const
const CYAN = [94, 234, 212] as const
const rgba = (c: readonly number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

function glowSprite(dpr: number): HTMLCanvasElement {
  const s = Math.round(64 * dpr)
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grad.addColorStop(0, 'rgba(255,214,150,0.95)')
  grad.addColorStop(0.25, 'rgba(249,115,22,0.55)')
  grad.addColorStop(1, 'rgba(249,115,22,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, s, s)
  return c
}

export function UpgradeCore({ fraction, step, size, isMobile, reducedMotion }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const live = useRef({ fraction, step })
  live.current = { fraction, step }
  const redrawRef = useRef<() => void>(() => {})

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const budget = coreBudget({ isMobile, reducedMotion, dpr: window.devicePixelRatio || 1 })
    const dpr = budget.dpr
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const sprite = glowSprite(dpr)

    const c = size / 2
    const R = size * 0.17
    const ringR = [R * 0.62, R * 0.95, R * 1.3]
    const pieces = corePieces()
    const revealedAt: number[] = pieces.map(() => -1)
    const traces = circuitTraces(ringR[2]! / c + 0.04)
    const particles: Particle[] = []
    let flash = 0
    let spawnDebt = 0
    let last = performance.now()
    let lastDrawn = 0
    let raf = 0

    const spawn = () => {
      particles.push({
        a: Math.random() * Math.PI * 2,
        r: c * (0.92 + Math.random() * 0.12),
        v: c * (0.28 + Math.random() * 0.3),
        w: (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.9),
        hue: (Math.random() < 0.62 ? 0 : Math.random() < 0.6 ? 1 : 2) as 0 | 1 | 2,
        life: 0,
      })
    }

    const draw = (now: number, dt: number) => {
      const { fraction: f, step: st } = live.current
      ctx.clearRect(0, 0, size, size)

      // Faint grid — the board the core is built on.
      ctx.strokeStyle = 'rgba(148,163,184,0.06)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = 0; x <= size; x += size / 12) { ctx.moveTo(x, 0); ctx.lineTo(x, size) }
      for (let y = 0; y <= size; y += size / 12) { ctx.moveTo(0, y); ctx.lineTo(size, y) }
      ctx.stroke()

      // Circuits: dim always, lit from the edge toward the heart as the restart progresses.
      const lit = circuitLit(f)
      for (const t of traces) {
        const pts = t.map(([x, y]) => [c + x * c, c + y * c] as const)
        ctx.strokeStyle = 'rgba(148,163,184,0.16)'
        ctx.lineWidth = 1.5
        ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke()
        if (lit > 0) {
          const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]))
          const total = lens.reduce((a, b) => a + b, 0)
          let left = total * lit
          ctx.strokeStyle = rgba(GOLD, 0.85)
          ctx.lineWidth = 2
          ctx.beginPath(); ctx.moveTo(pts[0]![0], pts[0]![1])
          let tip = pts[0]!
          for (let i = 0; i < lens.length && left > 0; i++) {
            const k = Math.min(1, left / lens[i]!)
            const a = pts[i]!, b = pts[i + 1]!
            tip = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k] as const
            ctx.lineTo(tip[0], tip[1])
            left -= lens[i]!
          }
          ctx.stroke()
          // The spark riding the lit trace toward the core.
          if (budget.animate) {
            const s = 7 + 4 * Math.sin(now / 160)
            ctx.globalCompositeOperation = 'lighter'
            ctx.drawImage(sprite, tip[0] - s, tip[1] - s, s * 2, s * 2)
            ctx.globalCompositeOperation = 'source-over'
          }
        }
      }

      // Data streams spiralling in.
      if (budget.animate) {
        spawnDebt += (spawnRate(st, budget.particles) * dt) / 1000
        while (spawnDebt >= 1 && particles.length < budget.particles) { spawn(); spawnDebt -= 1 }
        if (spawnDebt > 4) spawnDebt = 4
        ctx.globalCompositeOperation = 'lighter'
        ctx.lineCap = 'round'
        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i]!
          const x0 = c + Math.cos(p.a) * p.r, y0 = c + Math.sin(p.a) * p.r
          const pull = 1 + (1 - p.r / c) * 2.2
          p.r -= (p.v * pull * dt) / 1000
          p.a += (p.w * pull * dt) / 1000
          p.life += dt
          if (p.r <= ringR[0]!) { particles.splice(i, 1); flash = Math.min(1, flash + 0.06); continue }
          const x1 = c + Math.cos(p.a) * p.r, y1 = c + Math.sin(p.a) * p.r
          const col = p.hue === 0 ? AMBER : p.hue === 1 ? GOLD : CYAN
          const a = Math.min(1, p.life / 300) * Math.min(1, (p.r - ringR[0]!) / (c * 0.25) + 0.25)
          ctx.strokeStyle = rgba(col, 0.75 * a)
          ctx.lineWidth = 1.6
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke()
          ctx.fillStyle = rgba(col, a)
          ctx.fillRect(x1 - 1, y1 - 1, 2, 2)
        }
        ctx.globalCompositeOperation = 'source-over'
      }

      // The core, assembled piece by piece from its heart outward.
      const n = piecesLit(f, pieces.length)
      pieces.forEach((pc, i) => {
        const r = ringR[pc.ring]!
        if (i >= n) {
          ctx.strokeStyle = 'rgba(148,163,184,0.10)'
          ctx.lineWidth = 3
          ctx.beginPath(); ctx.arc(c, c, r, pc.a0, pc.a1); ctx.stroke()
          return
        }
        if (revealedAt[i]! < 0) revealedAt[i] = now
        const t = budget.animate ? Math.min(1, (now - revealedAt[i]!) / 420) : 1
        const ease = 1 - (1 - t) ** 3
        const fly = (1 - ease) * R * 0.9
        ctx.strokeStyle = rgba(pc.ring === 1 ? GOLD : AMBER, 0.35 + 0.65 * ease)
        ctx.lineWidth = pc.ring === 0 ? 5 : pc.ring === 1 ? 4 : 3
        ctx.beginPath(); ctx.arc(c, c, r + fly, pc.a0, pc.a1); ctx.stroke()
      })

      // The energy ring: the real charge, swept around the core.
      ctx.strokeStyle = 'rgba(148,163,184,0.12)'
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(c, c, ringR[2]! + R * 0.32, 0, Math.PI * 2); ctx.stroke()
      ctx.strokeStyle = rgba(CYAN, 0.9)
      ctx.lineWidth = 2.5
      ctx.beginPath(); ctx.arc(c, c, ringR[2]! + R * 0.32, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.01, f)); ctx.stroke()

      // The heart: brighter as it charges, beating once power is on.
      flash *= budget.animate ? Math.pow(0.04, dt / 1000) : 0
      const beat = budget.animate ? (st === 'power' ? 0.5 + 0.5 * Math.sin(now / 140) : 0.5 + 0.5 * Math.sin(now / 600)) : 0.5
      const glow = R * (0.9 + 0.9 * f + 0.25 * beat + 0.6 * flash)
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.45 + 0.45 * f
      ctx.drawImage(sprite, c - glow, c - glow, glow * 2, glow * 2)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      const heart = ctx.createRadialGradient(c, c, 0, c, c, R * 0.42)
      heart.addColorStop(0, `rgba(255,237,213,${0.55 + 0.45 * f})`)
      heart.addColorStop(1, rgba(AMBER, 0.15 + 0.5 * f))
      ctx.fillStyle = heart
      ctx.beginPath(); ctx.arc(c, c, R * 0.42, 0, Math.PI * 2); ctx.fill()
    }

    redrawRef.current = () => { if (!budget.animate) draw(performance.now(), 0) }

    if (!budget.animate) {
      draw(performance.now(), 0)
      return () => { redrawRef.current = () => {} }
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (document.hidden) { last = now; return }
      if (now - lastDrawn < budget.frameMs - 1) return
      const dt = Math.min(80, now - last)
      last = now
      lastDrawn = now
      draw(now, dt)
    }
    raf = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(raf); redrawRef.current = () => {} }
  }, [size, isMobile, reducedMotion])

  // Reduced motion: no loop, so a new charge is drawn here, once.
  useEffect(() => { redrawRef.current() }, [fraction, step])

  return <canvas ref={canvasRef} aria-hidden style={{ width: size, height: size, display: 'block' }} />
}

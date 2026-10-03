/**
 * NayFab.tsx — the Nay chat button as something you can pick up and move.
 *
 * The rules live in `lib/nayFab.ts` (pure, tested); this file is the part that touches the DOM:
 *  - ONE requestAnimationFrame loop, running only while something moves, writing transforms
 *    through refs so a drag never re-renders React sixty times a second;
 *  - the button keeps being a button: a press that travels less than `FAB_CLICK_SLOP` is a click,
 *    and a drag swallows the click that the browser fires after it;
 *  - `prefers-reduced-motion` turns every look into a plain move (no spring, no stretch, no
 *    ripple, no tail) — the position still follows the pointer, and the edge magnet still pulls.
 *  - the button goes where it is DROPPED. An edge pulls it in only when it is released close to
 *    that edge (`dropFabAt`), and while it is dragged near one, that edge glows — the glow is
 *    the only warning that a release will snap, so it lights per side, never all four at once.
 *
 * The four looks come from the studies page the owner chose from. Their effects draw on a layer
 * that ignores the pointer, so a ripple or a tail can never catch a click meant for the page.
 */

import { createPortal } from 'react-dom'
import { NAY_FAB_EFFECTS_Z, NAY_FAB_Z } from '../../lib/zLayers'
import { publishFabLanded, publishFabLive } from '../../lib/nayFabLive'
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import {
  clampFabPos, defaultFabPos, dropFabAt, FAB_CLICK_SLOP, FAB_SIZE, FAB_SPRING, magnetEdges, NO_MAGNET, smoothVelocity, springAtRest,
  type MagnetEdges,
  stepSpring, stretchFor, type NayFabPrefs, type SpringState, type Vec, type Viewport,
} from '../../lib/nayFab'

const SUBSTEPS = 4
const GHOSTS = 3

export interface FabHandlers {
  bodyRef: RefObject<HTMLButtonElement | null>
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLButtonElement>) => void
  /** Swallows the click the browser fires at the end of a drag. */
  onClickCapture: (e: ReactMouseEvent) => void
  dragging: boolean
}

export interface NayFabProps {
  prefs: NayFabPrefs
  onPrefs: (next: NayFabPrefs) => void
  isMobile: boolean
  /** Changes when the page underneath changes shape (entering a session), so the place is re-kept. */
  routeKey?: string
  children: (h: FabHandlers) => ReactNode
}

const viewport = (): Viewport => ({ w: window.innerWidth, h: window.innerHeight })

/**
 * How much of the bottom of a phone's screen the button must stay out of: the bottom nav (a CSS
 * variable) and, inside a session, the COMPOSER — it once sat on the send button (owner,
 * 2026-09-29). The composer is found by the class its ground already carries; a composer that is
 * not on screen costs nothing.
 */
function bottomInset(isMobile: boolean): number {
  if (!isMobile) return 0
  const h = window.innerHeight
  // The bar is MEASURED, not read off `--mobile-nav-h`: that token is a `calc(…)`, and a custom
  // property reads back unresolved, so `parseFloat` of it was NaN and the inset silently 0.
  const nav = document.querySelector('.mobile-bottom-nav')
  const navTop = nav ? nav.getBoundingClientRect().top : h
  let inset = navTop < h ? h - navTop + 8 : 0
  document.querySelectorAll('.ag-composer-ground').forEach(el => {
    const r = el.getBoundingClientRect()
    if (r.height > 0 && r.width > 0 && r.top < h && r.bottom > 0) inset = Math.max(inset, h - r.top + 8)
  })
  return inset
}

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

function orange(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--anthropic-orange').trim()
  return v || '#fd8924'
}

interface Ring { x: number; y: number; r: number; a: number; grow: number }

export function NayFab({ prefs, onPrefs, isMobile, routeKey, children }: NayFabProps) {
  const style = prefs.style
  // The magnet is the same on a phone as on a desktop (owner, 2026-09-30): it used to be forced on
  // there, and it used to snap on every release, which confined the button to the edges.
  const magnet = prefs.snap
  const glowRefs = useRef<Record<keyof MagnetEdges, HTMLDivElement | null>>({ left: null, right: null, top: null, bottom: null })
  const anchorRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLButtonElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ghostRefs = useRef<(HTMLDivElement | null)[]>([])
  const [dragging, setDragging] = useState(false)
  const [reduced, setReduced] = useState(prefersReducedMotion)

  // Everything the loop reads and writes lives in one mutable record.
  const sim = useRef({
    spring: { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } } as SpringState,
    target: { x: 0, y: 0 } as Vec,
    placed: false,
    drag: null as null | { id: number; sx: number; sy: number; ox: number; oy: number; t: number; moved: boolean },
    dragVel: { x: 0, y: 0 } as Vec,
    swallowClick: false,
    // the look
    sx: 1, sy: 1, svx: 0, svy: 0, ang: 0, tilt: 0, tiltV: 0,
    ghosts: Array.from({ length: GHOSTS }, () => ({ pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }) as SpringState),
    rings: [] as Ring[],
    trail: [] as Vec[],
    raf: 0,
    last: 0,
  })

  // --- reduced motion follows the system setting live -----------------------------------------
  useEffect(() => {
    let mq: MediaQueryList | null = null
    try { mq = window.matchMedia('(prefers-reduced-motion: reduce)') } catch { return }
    const on = () => setReduced(mq!.matches)
    mq.addEventListener?.('change', on)
    return () => mq?.removeEventListener?.('change', on)
  }, [])

  const apply = useCallback(() => {
    const s = sim.current
    const a = anchorRef.current
    if (a) a.style.transform = `translate3d(${s.spring.pos.x}px, ${s.spring.pos.y}px, 0)`
    // The open dock follows the button's LIVE position, not the stored one (`nayFabLive.ts`).
    const v = s.drag?.moved ? s.dragVel : s.spring.vel
    publishFabLive(s.spring.pos.x, s.spring.pos.y, Math.hypot(v.x, v.y))
    const b = bodyRef.current
    if (!b) return
    if (reduced) { b.style.transform = ''; return }
    if (style === 'jelly' || style === 'trail') {
      const deg = s.ang * 180 / Math.PI
      b.style.transform = `rotate(${deg}deg) scale(${s.sx}, ${s.sy}) rotate(${-deg}deg)`
    } else if (style === 'shock') {
      b.style.transform = `scale(${s.sx}, ${s.sy})`
    } else {
      b.style.transform = `rotate(${s.tilt}deg)`
    }
  }, [reduced, style])

  const draw = useCallback(() => {
    const s = sim.current
    s.ghosts.forEach((g, i) => {
      const el = ghostRefs.current[i]
      if (!el) return
      const lag = Math.hypot(s.spring.pos.x - g.pos.x, s.spring.pos.y - g.pos.y)
      el.style.opacity = String(Math.min(lag / 90, 0.5 - i * 0.12))
      el.style.transform = `translate3d(${g.pos.x}px, ${g.pos.y}px, 0) scale(${1 - (i + 1) * 0.08})`
    })
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const vp = viewport()
    if (c.width !== vp.w * dpr || c.height !== vp.h * dpr) { c.width = vp.w * dpr; c.height = vp.h * dpr }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, vp.w, vp.h)
    const col = orange()
    if (style === 'comet' && s.trail.length > 2) {
      const speed = Math.hypot(s.spring.vel.x, s.spring.vel.y)
      const width = Math.min(22, speed / 90)
      if (width > 1) {
        ctx.lineCap = 'round'
        ctx.strokeStyle = col
        for (let i = 1; i < s.trail.length; i++) {
          const f = i / s.trail.length
          ctx.globalAlpha = 0.45 * f
          ctx.lineWidth = width * f
          ctx.beginPath(); ctx.moveTo(s.trail[i - 1]!.x, s.trail[i - 1]!.y); ctx.lineTo(s.trail[i]!.x, s.trail[i]!.y); ctx.stroke()
        }
      }
    }
    for (const r of s.rings) {
      ctx.globalAlpha = r.a
      ctx.strokeStyle = col
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.globalAlpha = 1
  }, [style])

  const tick = useCallback((dtTotal: number): boolean => {
    const s = sim.current
    const { stiffness: k, damping: c } = FAB_SPRING
    const dt = dtTotal / SUBSTEPS
    for (let n = 0; n < SUBSTEPS; n++) {
      if (!s.drag?.moved) s.spring = reduced ? { pos: s.target, vel: { x: 0, y: 0 } } : stepSpring(s.spring, s.target, dt, k, c)
      const vel = s.drag?.moved ? s.dragVel : s.spring.vel
      const speed = Math.hypot(vel.x, vel.y)
      if (style === 'jelly' || style === 'trail') {
        const amt = stretchFor(speed)
        if (speed > 30) s.ang = Math.atan2(vel.y, vel.x)
        const ks = k * 1.6, cs = c * 0.7
        s.svx += (ks * (1 + amt - s.sx) - cs * s.svx) * dt; s.svy += (ks * (1 - amt * 0.55 - s.sy) - cs * s.svy) * dt
        s.sx += s.svx * dt; s.sy += s.svy * dt
      } else if (style === 'shock') {
        const ks = k * 2, cs = c * 0.9
        s.svx += (ks * (1 - s.sx) - cs * s.svx) * dt; s.svy += (ks * (1 - s.sy) - cs * s.svy) * dt
        s.sx += s.svx * dt; s.sy += s.svy * dt
      } else {
        const target = Math.max(-22, Math.min(22, vel.x / 60))
        s.tiltV += (k * 1.2 * (target - s.tilt) - c * 0.8 * s.tiltV) * dt; s.tilt += s.tiltV * dt
      }
      if (style === 'trail') s.ghosts = s.ghosts.map((g, i) => stepSpring(g, s.spring.pos, dt, k * (0.55 - i * 0.14), c * (0.8 + i * 0.1)))
    }
    if (style === 'comet') {
      s.trail.push({ x: s.spring.pos.x + FAB_SIZE / 2, y: s.spring.pos.y + FAB_SIZE / 2 })
      if (s.trail.length > 16) s.trail.shift()
    }
    s.rings = s.rings.map(r => ({ ...r, r: r.r + r.grow * dtTotal, a: r.a * Math.pow(0.08, dtTotal) })).filter(r => r.a > 0.02)
    apply(); draw()

    const bodyAtRest = Math.abs(s.sx - 1) < 0.002 && Math.abs(s.sy - 1) < 0.002 && Math.abs(s.svx) < 0.02 && Math.abs(s.svy) < 0.02 && Math.abs(s.tilt) < 0.05 && Math.abs(s.tiltV) < 0.1
    const ghostsAtRest = style !== 'trail' || s.ghosts.every(g => springAtRest(g, s.spring.pos))
    const atRest = !s.drag && springAtRest(s.spring, s.target) && (reduced || bodyAtRest) && ghostsAtRest && s.rings.length === 0
    if (atRest) {
      s.spring = { pos: s.target, vel: { x: 0, y: 0 } }
      s.trail = []
      apply(); draw()
    }
    return !atRest
  }, [apply, draw, reduced, style])

  const kick = useCallback(() => {
    const s = sim.current
    if (s.raf) return
    s.last = performance.now()
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - s.last) / 1000)
      s.last = now
      s.raf = tick(dt) ? requestAnimationFrame(frame) : 0
    }
    s.raf = requestAnimationFrame(frame)
  }, [tick])

  useEffect(() => () => { if (sim.current.raf) cancelAnimationFrame(sim.current.raf) }, [])

  // --- where it should be: the stored place (or the default), kept on screen -------------------
  const settle = useCallback((animate: boolean) => {
    const s = sim.current
    const vp = viewport(), inset = bottomInset(isMobile)
    const want = prefs.pos ?? defaultFabPos(vp, isMobile ? Math.max(0, inset - 12) : 0)
    const t = clampFabPos(want, vp, inset)
    s.target = t
    if (!s.placed || !animate) {
      s.spring = { pos: t, vel: { x: 0, y: 0 } }
      s.ghosts = s.ghosts.map(() => ({ pos: t, vel: { x: 0, y: 0 } }))
      s.placed = true
      apply(); draw()
    } else kick()
  }, [prefs.pos, isMobile, apply, draw, kick])

  useEffect(() => { settle(sim.current.placed) }, [settle, routeKey])
  // On a phone the composer grows as someone types and appears a moment after a session opens;
  // a light poll re-keeps the button clear of it. Settling at an unchanged target costs one frame.
  useEffect(() => {
    if (!isMobile) return
    const t = window.setInterval(() => { if (!sim.current.drag) settle(true) }, 1200)
    return () => window.clearInterval(t)
  }, [isMobile, settle])
  useEffect(() => {
    const onResize = () => settle(false)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [settle])

  // --- the pointer ---------------------------------------------------------------------------
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const s = sim.current
    s.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: s.spring.pos.x, oy: s.spring.pos.y, t: performance.now(), moved: false }
    s.dragVel = { x: 0, y: 0 }
    // Captured at the PRESS, not at the first move: a quick flick's first event can already land
    // outside the button, and without capture it would never reach this handler at all. A captured
    // pointer still clicks the same element, so a plain tap is unaffected.
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* no capture: the drag degrades to in-bounds moves */ }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = sim.current
    const d = s.drag
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    if (!d.moved) {
      if (Math.hypot(dx, dy) < FAB_CLICK_SLOP) return
      d.moved = true
      setDragging(true)
    }
    const vp = viewport(), inset = bottomInset(isMobile)
    const next = clampFabPos({ x: d.ox + dx, y: d.oy + dy }, vp, inset)
    showGlow(magnet ? magnetEdges(next, vp, inset) : NO_MAGNET, inset)
    const now = performance.now()
    s.dragVel = smoothVelocity(s.dragVel, next.x - s.spring.pos.x, next.y - s.spring.pos.y, (now - d.t) / 1000)
    d.t = now
    s.spring = { pos: next, vel: s.dragVel }
    s.target = next
    kick()
  }
  const endDrag = (e: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const s = sim.current
    const d = s.drag
    if (!d || d.id !== e.pointerId) return
    s.drag = null
    if (!d.moved) return   // a press that never travelled is left to be the click it is
    s.swallowClick = true
    setDragging(false)
    showGlow(NO_MAGNET, 0)
    const vp = viewport(), inset = bottomInset(isMobile)
    // A cancelled drag (the browser took the pointer) never snaps: nobody chose where it landed.
    const t = dropFabAt(s.spring.pos, vp, inset, magnet && !cancelled)
    s.target = t
    s.spring = { pos: s.spring.pos, vel: reduced ? { x: 0, y: 0 } : s.dragVel }
    const land = Math.hypot(s.dragVel.x, s.dragVel.y)
    if (!cancelled) publishFabLanded(land)
    if (style === 'shock' && !reduced && !cancelled) {
      s.rings.push({ x: t.x + FAB_SIZE / 2, y: t.y + FAB_SIZE / 2, r: 30, a: Math.max(0.25, Math.min(0.9, land / 1600)), grow: 120 + land * 0.12 })
      const nx = s.dragVel.x / (land || 1), ny = s.dragVel.y / (land || 1)
      const hit = Math.max(0.05, Math.min(0.32, land / 2600))
      s.sx = 1 - hit * Math.abs(nx) + hit * Math.abs(ny); s.sy = 1 - hit * Math.abs(ny) + hit * Math.abs(nx)
    }
    if (!cancelled) onPrefs({ ...prefs, pos: t })
    kick()
  }
  const onClickCapture = (e: ReactMouseEvent) => {
    const s = sim.current
    if (!s.swallowClick) return
    s.swallowClick = false
    e.preventDefault(); e.stopPropagation()
  }

  /** Lights exactly the edges a release would snap to. Written through refs: it runs per move. */
  function showGlow(m: MagnetEdges, inset: number) {
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const el = glowRefs.current[side]
      if (!el) continue
      el.style.opacity = m[side] ? '1' : '0'
      if (side === 'bottom') el.style.bottom = `${inset}px`
    }
  }

  const effects = !reduced && (style === 'trail' || style === 'shock' || style === 'comet')
  const glowBase = {
    position: 'absolute', pointerEvents: 'none', opacity: 0,
    background: 'var(--anthropic-orange)',
    boxShadow: '0 0 22px 7px color-mix(in srgb, var(--anthropic-orange) 45%, transparent)',
    transition: reduced ? 'none' : 'opacity 140ms ease-out',
  } as const

  return (
    <>
      {/* The EDGE MAGNET's glow: mounted only while a drag with the magnet on is in progress, so an
          idle page carries no fixed layers at all. Each side is its own strip, lit on its own. */}
      {/* PORTALED to <body>, as ONE fixed full-viewport layer: rendered in place, the strips were
          `position: fixed` inside a tree whose ancestor establishes a containing block, so the top
          edge lit only across the sidebar. From <body> every side spans the whole viewport edge, and
          the layer sits above every panel. */}
      {dragging && magnet && typeof document !== 'undefined' && createPortal(
        <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 9990, pointerEvents: 'none' }}>
          <div ref={el => { glowRefs.current.left = el }} style={{ ...glowBase, left: 0, top: 0, bottom: 0, width: 3 }} />
          <div ref={el => { glowRefs.current.right = el }} style={{ ...glowBase, right: 0, top: 0, bottom: 0, width: 3 }} />
          <div ref={el => { glowRefs.current.top = el }} style={{ ...glowBase, left: 0, right: 0, top: 0, height: 3 }} />
          <div ref={el => { glowRefs.current.bottom = el }} style={{ ...glowBase, left: 0, right: 0, bottom: 0, height: 3 }} />
        </div>,
        document.body,
      )}
      {effects && (
        <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: NAY_FAB_EFFECTS_Z, pointerEvents: 'none' }}>
          {(style === 'shock' || style === 'comet') && (
            <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
          )}
          {style === 'trail' && Array.from({ length: GHOSTS }, (_, i) => (
            <div key={i} ref={el => { ghostRefs.current[i] = el }} style={{
              position: 'absolute', left: 0, top: 0, width: FAB_SIZE, height: FAB_SIZE, borderRadius: 16,
              border: '1.5px solid var(--anthropic-orange)', opacity: 0, willChange: 'transform, opacity',
            }} />
          ))}
        </div>
      )}
      <div ref={anchorRef} style={{ position: 'fixed', left: 0, top: 0, zIndex: NAY_FAB_Z, width: FAB_SIZE, height: FAB_SIZE, willChange: 'transform' }}>
        {children({
          bodyRef,
          onPointerDown, onPointerMove,
          onPointerUp: e => endDrag(e, false),
          onPointerCancel: e => endDrag(e, true),
          onClickCapture,
          dragging,
        })}
      </div>
    </>
  )
}

/**
 * liveDeliveryFx — the Live Delivery line's transition animations, WAAPI only (no dependency).
 *
 * Two shapes, ported from the approved prototype:
 *  - a stage→stage MOVE: the card lifts (shadow + a ring in the source column's colour), glides on a
 *    soft arc with a slight tilt, a thin blurred streak in the destination colour follows it, and a
 *    dashed SLOT opens at the destination before it lands. It lands with NO bounce;
 *  - MERGE APPROVED (PR/merge → Published): the card DISINTEGRATES in grey (grayscale + a left→right
 *    clip-path sweep while grey dust drifts up and fades), then REINTEGRATES in the destination with
 *    green particles converging into a left→right reveal under a green glow. The card is the very
 *    same card; only the animation differs.
 *
 * Everything is drawn on a fixed overlay (`fxLayer`) so no column's overflow can clip it, and every
 * particle count goes through `particleGrid(..., PARTICLE_CAP)` so the cost stays flat on a phone and
 * on WebKit. `prefers-reduced-motion` gets a plain fade (`reducedMotion`).
 */

export const PARTICLE_CAP = 120

export interface Box { left: number; top: number; width: number; height: number }

/** No WAAPI (an old engine, a test DOM): there is nothing to animate and the card just appears. */
export const canAnimate = (): boolean => typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'

export const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** PURE: dust origins over a box — a grid whose step grows until it fits `cap` points. `u` is 0..1 left→right. */
export function particleGrid(r: Box, cap = PARTICLE_CAP, minStep = 7): { x: number; y: number; u: number }[] {
  const w = Math.max(1, r.width), h = Math.max(1, r.height)
  let step = minStep
  const count = (s: number) => Math.ceil(w / s) * Math.ceil(h / s)
  while (count(step) > cap) step += 1
  const out: { x: number; y: number; u: number }[] = []
  for (let y = r.top + step / 2; y < r.top + h; y += step) {
    for (let x = r.left + step / 2; x < r.left + w; x += step) out.push({ x, y, u: (x - r.left) / w })
  }
  return out.slice(0, cap)
}

const rnd = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!

export function fxLayer(): HTMLElement {
  let el = document.getElementById('ag-live-fx')
  if (!el) {
    el = document.createElement('div')
    el.id = 'ag-live-fx'
    el.setAttribute('aria-hidden', 'true')
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1300;overflow:hidden'
    document.body.appendChild(el)
  }
  return el
}

const box = (r: DOMRect | Box): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height })

function ghostOf(el: HTMLElement, b: Box): HTMLElement {
  const g = el.cloneNode(true) as HTMLElement
  g.removeAttribute('data-live-card')
  g.style.cssText += `;position:fixed;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;margin:0;opacity:1;pointer-events:none;will-change:transform`
  return g
}

function streak(layer: HTMLElement, a: { x: number; y: number }, b: { x: number; y: number }, color: string, h: number) {
  const len = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x)
  const t = document.createElement('div')
  t.style.cssText = `position:fixed;left:${a.x}px;top:${a.y}px;width:${len + 2}px;height:${h}px;transform-origin:0 50%;transform:translateY(-50%) rotate(${ang}rad);border-radius:999px;filter:blur(3px);background:linear-gradient(90deg,${color}00,${color}40)`
  layer.appendChild(t)
  t.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 420, easing: 'ease-out' }).onfinish = () => t.remove()
}

/** Pure target math of a flight: the offset from the origin box to the destination box. */
export function flightGeometry(from: Box, to: Box): { dx: number; dy: number; arc: number; tilt: number } {
  const dx = to.left - from.left, dy = to.top - from.top
  const dist = Math.hypot(dx, dy)
  return { dx, dy, arc: Math.min(70, 18 + dist * 0.07), tilt: Math.max(-4, Math.min(4, dx / 120)) }
}

/** Glide `el` (already at its destination, hidden by the caller) from `from` to where it is now. */
export function flyCard(el: HTMLElement, from: Box, o: { fromColor: string; toColor: string; speed?: number }): Promise<void> {
  const to = box(el.getBoundingClientRect())
  if (!canAnimate()) return Promise.resolve()
  if (reducedMotion()) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 })
    return Promise.resolve()
  }
  const layer = fxLayer()
  const g = ghostOf(el, from)
  layer.appendChild(g)
  const geo = flightGeometry(from, to)
  // ~600 ms: a card that changes stage must be FOLLOWED by the eye, not waited for (owner, 06/11).
  const dur = o.speed && o.speed > 1 ? 480 : 600
  // The slot opens at the destination before the card arrives.
  const slot = document.createElement('div')
  slot.style.cssText = `position:fixed;left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px;border:1.5px dashed ${o.toColor};border-radius:10px;background:${o.toColor}14`
  layer.appendChild(slot)
  slot.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'scale(1)', offset: 0.35 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: dur + 160, easing: 'ease-out' }).onfinish = () => slot.remove()
  const frames = (d: { dx: number; dy: number; arc: number; tilt: number }): Keyframe[] => {
    const lift = '0 22px 44px rgba(0,0,0,.5),0 0 0 1.5px '
    const rest = '0 1px 2px rgba(0,0,0,.2),0 0 0 0 transparent'
    return [
      { transform: 'translate(0,0) scale(1) rotate(0)', boxShadow: rest, offset: 0 },
      { transform: `translate(0,-6px) scale(1.035) rotate(${-d.tilt * 0.4}deg)`, boxShadow: lift + o.fromColor, offset: 0.16 },
      { transform: `translate(${d.dx * 0.5}px,${d.dy * 0.5 - d.arc}px) scale(1.05) rotate(${d.tilt}deg)`, boxShadow: lift + o.toColor, offset: 0.55 },
      { transform: `translate(${d.dx}px,${d.dy}px) scale(1) rotate(0)`, boxShadow: rest, offset: 1 },
    ]
  }
  const anim = g.animate(frames(geo), { duration: dur, easing: 'cubic-bezier(.45,.05,.2,1)', fill: 'forwards' })
  // The board can scroll (or another card can open a slot) while this card is in the air: the
  // destination is read again every frame and the flight is re-aimed, so it lands on its slot.
  let aimed: Box = to
  const retarget = () => {
    if (!el.isConnected) return
    const now = box(el.getBoundingClientRect())
    if (Math.abs(now.left - aimed.left) < 1 && Math.abs(now.top - aimed.top) < 1) return
    aimed = now
    ;(anim.effect as KeyframeEffect | null)?.setKeyframes(frames(flightGeometry(from, now)))
    slot.style.left = `${now.left}px`
    slot.style.top = `${now.top}px`
  }
  let last: { x: number; y: number } | null = null
  const follow = () => {
    if (!g.isConnected) return
    retarget()
    const r = g.getBoundingClientRect(), p = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    if (last && Math.hypot(p.x - last.x, p.y - last.y) > 6) streak(layer, last, p, o.toColor, r.height * 0.55)
    last = p
    requestAnimationFrame(follow)
  }
  requestAnimationFrame(follow)
  return new Promise<void>(resolve => {
    const end = () => { g.remove(); resolve() }
    anim.finished.then(end, end)
    setTimeout(end, dur + 900)
  })
}

const GREYS = ['#6b7280', '#9ca3af', '#4b5563', '#d1d5db'] as const
const GREENS = ['#10b981', '#34d399', '#6ee7b7', '#059669'] as const

function dust(layer: HTMLElement, x: number, y: number, color: string, glow = false): HTMLElement {
  const p = document.createElement('div')
  p.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:3px;height:3px;border-radius:1px;background:${color}${glow ? ';box-shadow:0 0 6px #10b98199' : ''}`
  layer.appendChild(p)
  return p
}

/** Grey out and sweep the card away left→right while grey dust drifts up and fades. */
export function disintegrate(el: HTMLElement, from: Box): Promise<void> {
  if (!canAnimate()) return Promise.resolve()
  if (reducedMotion()) return Promise.resolve()
  const layer = fxLayer()
  const g = ghostOf(el, from)
  layer.appendChild(g)
  const DUR = 1300
  g.animate([{ filter: 'grayscale(0) brightness(1)' }, { filter: 'grayscale(1) brightness(.85)', offset: 0.25 }, { filter: 'grayscale(1) brightness(.7)' }], { duration: DUR, fill: 'forwards' })
  const sweep = g.animate([
    { clipPath: 'inset(0 0 0 0 round 10px)' }, { clipPath: 'inset(0 0 0 0 round 10px)', offset: 0.22 }, { clipPath: 'inset(0 0 0 100% round 10px)' },
  ], { duration: DUR, easing: 'cubic-bezier(.5,0,.6,1)', fill: 'forwards' })
  for (const pt of particleGrid(from)) {
    if (Math.random() < 0.3) continue
    const p = dust(layer, pt.x, pt.y, rnd(GREYS))
    const ang = -Math.PI / 2 + (Math.random() - 0.2) * 1.6, rad = 30 + Math.random() * 70
    p.animate([
      { opacity: 0, transform: 'translate(-50%,-50%) scale(1)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.05 },
      { opacity: 0, transform: `translate(${Math.cos(ang) * rad + 20}px,${Math.sin(ang) * rad}px) scale(.3)` },
    ], { duration: 900 + Math.random() * 500, delay: DUR * (0.22 + pt.u * 0.72), easing: 'cubic-bezier(.2,.6,.3,1)', fill: 'both' }).onfinish = () => p.remove()
  }
  return new Promise<void>(resolve => {
    const end = () => { g.remove(); resolve() }
    sweep.finished.then(end, end)
    setTimeout(end, DUR + 1500)
  })
}

/** Green particles converge into a left→right reveal of the real card under a green glow. */
export function reintegrate(el: HTMLElement): Promise<void> {
  if (!canAnimate()) return Promise.resolve()
  if (reducedMotion()) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 }); return Promise.resolve() }
  const layer = fxLayer()
  const to = box(el.getBoundingClientRect())
  const DUR = 1300
  el.style.opacity = '1'
  el.style.clipPath = 'inset(0 100% 0 0 round 10px)'
  for (const pt of particleGrid(to)) {
    if (Math.random() < 0.3) continue
    const p = dust(layer, pt.x, pt.y, rnd(GREENS), true)
    const ang = Math.random() * Math.PI * 2, rad = 40 + Math.random() * 90
    p.animate([
      { opacity: 0, transform: `translate(calc(-50% + ${Math.cos(ang) * rad}px),calc(-50% + ${Math.sin(ang) * rad}px)) scale(.4)` },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1.2)', offset: 0.85 },
      { opacity: 0, transform: 'translate(-50%,-50%) scale(.6)' },
    ], { duration: DUR * 0.45 + Math.random() * 200, delay: DUR * pt.u * 0.6, easing: 'cubic-bezier(.3,.1,.2,1)', fill: 'both' }).onfinish = () => p.remove()
  }
  const reveal = el.animate([
    { clipPath: 'inset(0 100% 0 0 round 10px)', boxShadow: '0 0 0 1.5px #10b981,0 0 26px #10b98188' },
    { clipPath: 'inset(0 0 0 0 round 10px)', boxShadow: '0 0 0 1.5px #10b981,0 0 26px #10b98188', offset: 0.8 },
    { clipPath: 'inset(0 0 0 0 round 10px)', boxShadow: '0 1px 2px rgba(0,0,0,.2),0 0 0 0 #10b98100' },
  ], { duration: DUR + 250, delay: DUR * 0.25, easing: 'cubic-bezier(.4,0,.3,1)', fill: 'backwards' })
  return new Promise<void>(resolve => {
    const end = () => { el.style.clipPath = ''; el.style.opacity = ''; resolve() }
    reveal.finished.then(end, end)
    setTimeout(end, DUR * 2 + 800)
  })
}

/** What an arrival does, decided by the stages alone — a plain function so it is testable. */
export type TransitionKind = 'merge-approved' | 'move' | 'none'
export function transitionKind(prev: string | undefined, next: string): TransitionKind {
  if (!prev || prev === next) return 'none'
  return prev === 'merge' && next === 'published' ? 'merge-approved' : 'move'
}

/**
 * Is any of `b` inside `view` (the board scroller's visible rectangle)? A card whose source or
 * destination is scrolled out of sight is not animated — its ghost would be drawn on the fixed layer
 * over whatever is at those viewport coordinates (the sidebar, the page behind), which is not where
 * the card is.
 */
export function intersects(b: Box, view: Box): boolean {
  return b.left < view.left + view.width && b.left + b.width > view.left
    && b.top < view.top + view.height && b.top + b.height > view.top
}


/** A brief ring in the destination column's colour round a card that has just landed. */
export function ring(el: HTMLElement, color: string, ms = 900): void {
  if (!canAnimate() || reducedMotion()) return
  el.animate([{ boxShadow: `0 0 0 2px ${color}` }, { boxShadow: `0 0 0 2px ${color}`, offset: 0.45 }, { boxShadow: '0 0 0 0 transparent' }], { duration: ms, easing: 'ease-out' })
}

/** The card's stage-bar segments fade from the colours they had in the previous column to the ones they have now. */
export function recolorBar(el: HTMLElement, from: readonly string[], ms = 400): void {
  if (!canAnimate() || reducedMotion()) return
  const segs = Array.from(el.querySelectorAll<HTMLElement>('[data-live-bar] i'))
  segs.forEach((seg, k) => {
    const was = from[k]
    if (!was) return
    const now = getComputedStyle(seg).backgroundColor
    seg.animate([{ backgroundColor: was }, { backgroundColor: now }], { duration: ms, easing: 'ease-out' })
  })
}

/** The destination column is collapsed (no card element to land): flash its header in the arriving colour. */
export function flashHeader(head: HTMLElement | null, color: string, ms = 900): void {
  if (head) ring(head, color, ms)
}

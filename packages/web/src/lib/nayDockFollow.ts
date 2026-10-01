/**
 * nayDockFollow.ts — PURE: how the OPEN Nay dock follows its button while the button is dragged.
 *
 * The owner approved four follow motions, one per button drag style, so the dock's motion is not a
 * setting of its own: it INHERITS the button's style (design: the "Nay dock follow studies"
 * artifact, 2026-09-30).
 *  - `jelly`  — a soft spring; the dock shears toward its motion and wobbles back to square.
 *  - `trail`  — a loose, damped spring; the dock lags and leaves two outline echoes.
 *  - `shock`  — a tight spring; when the button lands the dock gives a small squash away from it.
 *  - `comet`  — the dock leans a few degrees into its motion and leaves fading outline echoes.
 *
 * Rules every style keeps:
 *  - The TARGET is always `placeDock` for the button's live position: the side with room, clamped.
 *  - SIDES change with hysteresis (`dockSides`), and a change is never a slide across the button:
 *    the dock fades and shrinks toward its old corner (~110 ms), then grows out of the new one.
 *  - The dock NEVER covers the button and never leaves the screen, even while a spring overshoots:
 *    `renderDock` keeps a berth that grows with the style's shear, tilt or squash, and a clamp that
 *    would still put it on the button fades it instead.
 *  - Reduced motion: attached to the button, no lag, no effect.
 *  - `NO_FADE` (the notification card): its opacity NEVER moves. The owner saw the card dip and
 *    come back while dragging the button along an edge — the side-change fade and the "fade
 *    rather than cover the button" rule, each firing near the edges — and wants it simply to
 *    follow. A side change is a retarget the spring slides to, and it is decided with a wider
 *    hysteresis (`CARD_SIDE_HYSTERESIS`), so it happens once per crossing, never per frame.
 *
 * The state is a plain record the caller keeps and `stepFollow` advances in place — the loop runs
 * per frame and allocating a new record every frame is garbage for nothing. No DOM here.
 */

import type { NayFabStyle } from './nayFab'
import { dockSides, placeDock, DOCK_GAP, type AnchorRect, type DockPlacement, type DockSides, type Size, type Viewport } from './nayDock'

/** Each style's position spring. Stiffness and damping, per second. */
export const DOCK_FOLLOW: Record<NayFabStyle, { k: number; c: number }> = {
  jelly: { k: 150, c: 12 },
  trail: { k: 55, c: 11 },
  shock: { k: 420, c: 34 },
  comet: { k: 170, c: 15 },
}

/** How long the fade toward the old corner takes, and the fade in on the new side. */
export const SWAP_OUT_S = 0.11
export const SWAP_IN_S = 0.16

/** How a follower treats its own opacity. The dock keeps the fades; the card has none. */
export interface FollowOpts { fade: boolean; hysteresis?: number }
export const WITH_FADE: FollowOpts = { fade: true }
/** Wider than the dock's: a card hopping sides near the midline is the flicker this removes. */
export const CARD_SIDE_HYSTERESIS = 40
export const NO_FADE: FollowOpts = { fade: false, hysteresis: CARD_SIDE_HYSTERESIS }

export interface Echo { x: number; y: number; vx: number; vy: number }

export interface DockFollowState {
  x: number; y: number; vx: number; vy: number
  w: number; h: number
  place: DockPlacement
  sides: DockSides
  key: string
  /** 0 = settled on its side; 1 = fading out of the old side; 2 = fading in on the new one. */
  swap: 0 | 1 | 2
  o: number; sc: number; scv: number
  shear: number; shearV: number
  sq: number; sqV: number
  rot: number; rotV: number
  echoes: Echo[]
}

/** Which placement this is, as far as a side change goes: above/below vs beside, and the corner. */
export function placementKey(p: DockPlacement, btn: AnchorRect): string {
  const vertical = p.top >= btn.y + btn.h || p.top + p.h <= btn.y
  return `${vertical ? 'v' : 's'}${p.grow.x}${p.grow.y}`
}

export function initFollow(btn: AnchorRect, want: Size, vp: Viewport): DockFollowState {
  const sides = dockSides(btn, vp)
  const place = placeDock(btn, want, vp, sides)
  return {
    x: place.left, y: place.top, vx: 0, vy: 0, w: place.w, h: place.h, place, sides, key: placementKey(place, btn),
    swap: 0, o: 1, sc: 1, scv: 0, shear: 0, shearV: 0, sq: 0, sqV: 0, rot: 0, rotV: 0,
    echoes: [0, 1].map(() => ({ x: place.left, y: place.top, vx: 0, vy: 0 })),
  }
}

/** Is the dock still moving — does the loop need another frame? */
export function followSettled(st: DockFollowState): boolean {
  const still = Math.hypot(st.place.left - st.x, st.place.top - st.y) < 0.5 && Math.hypot(st.vx, st.vy) < 8
  const flat = Math.abs(st.shear) < 0.05 && Math.abs(st.sq) < 0.002 && Math.abs(st.rot) < 0.05 && Math.abs(st.sc - 1) < 0.002
  const echoesIn = st.echoes.every(e => Math.hypot(st.x - e.x, st.y - e.y) < 0.5)
  return st.swap === 0 && st.o >= 1 && still && flat && echoesIn
}

/**
 * THE REST GUARANTEE. `followSettled` is a threshold on the SPRING, and a spring can fail to meet
 * it forever: a button that republishes a sub-pixel position, a clamp that nudges the target back
 * and forth, or a reported speed that never quite reaches zero all keep a follower "moving" — and a
 * moving follower keeps its `translate3d` + `will-change`, which is exactly what made the dock the
 * containing block of the settings screen's popovers away from the corner (owner, v2.81.1). So
 * the loop also counts frames in which the BUTTON has not moved (by its position, not by the speed
 * it reports), and after `REST_AFTER_FRAMES` of them the follower is put at rest outright.
 */
export const REST_AFTER_FRAMES = 30
/** A button that moved less than this in a frame, and reports less than this speed, is quiet. */
export const QUIET_MOVE_PX = 1
export const QUIET_SPEED = 20

/** The next quiet-frame count, given how far the button moved this frame and its reported speed. */
export function nextQuiet(quiet: number, moved: number, speed: number): number {
  return moved < QUIET_MOVE_PX && speed < QUIET_SPEED ? quiet + 1 : 0
}

/** Should a follower at rest (its button last seen at `restX,restY`) start moving again? */
export function shouldWake(restX: number, restY: number, btn: { x: number; y: number }, speed: number): boolean {
  if (Number.isNaN(restX)) return true
  return Math.hypot(btn.x - restX, btn.y - restY) >= QUIET_MOVE_PX || speed >= QUIET_SPEED
}

/** Put a follower at rest on its current target: no velocity, no deformation, full opacity. */
export function forceRest(st: DockFollowState): void {
  Object.assign(st, { x: st.place.left, y: st.place.top, vx: 0, vy: 0, w: st.place.w, h: st.place.h,
    swap: 0, o: 1, sc: 1, scv: 0, shear: 0, shearV: 0, sq: 0, sqV: 0, rot: 0, rotV: 0 })
  for (const e of st.echoes) { e.x = st.x; e.y = st.y; e.vx = e.vy = 0 }
}

/**
 * Advance one step. `btn` is the button's LIVE rect (its spring position, not where it was
 * released), so the dock follows the whole motion, overshoot included.
 */
export function stepFollow(st: DockFollowState, btn: AnchorRect, want: Size, vp: Viewport, style: NayFabStyle, reduced: boolean, dt: number, opts: FollowOpts = WITH_FADE): void {
  const sides = dockSides(btn, vp, st.sides, opts.hysteresis)
  const next = placeDock(btn, want, vp, sides)
  const key = placementKey(next, btn)

  if (reduced) {
    Object.assign(st, { place: next, sides, key, x: next.left, y: next.top, vx: 0, vy: 0, w: next.w, h: next.h,
      swap: 0, o: 1, sc: 1, scv: 0, shear: 0, shearV: 0, sq: 0, sqV: 0, rot: 0, rotV: 0 })
    for (const e of st.echoes) { e.x = next.left; e.y = next.top; e.vx = e.vy = 0 }
    return
  }

  // No fade: the new side is simply the new target and the spring carries the card there.
  if (!opts.fade) { st.swap = 0; st.o = 1 }
  else if (key !== st.key && st.swap === 0) st.swap = 1
  if (st.swap === 1) {
    st.o -= dt / SWAP_OUT_S
    st.sc -= dt * 0.6
    if (st.o <= 0) {
      // Invisible for this instant: jump to the new side, a little toward the button, and grow out.
      st.o = 0; st.swap = 2; st.place = next; st.sides = sides; st.key = key; st.w = next.w; st.h = next.h
      const bcx = btn.x + btn.w / 2, bcy = btn.y + btn.h / 2
      st.x = next.left + (bcx - (next.left + next.w / 2)) * 0.12
      st.y = next.top + (bcy - (next.top + next.h / 2)) * 0.12
      st.vx = st.vy = 0; st.sc = 0.92; st.scv = 0
      for (const e of st.echoes) { e.x = st.x; e.y = st.y; e.vx = e.vy = 0 }
    }
    return
  }
  st.place = next; st.sides = sides; st.key = key
  if (st.swap === 2) { st.o = Math.min(1, st.o + dt / SWAP_IN_S); if (st.o >= 1) st.swap = 0 }

  // Size SHRINKS at once and GROWS smoothly: a dock still taller than the room it now has would be
  // pushed back onto the button by the screen clamp.
  const ease = Math.min(1, dt * 14)
  st.w = Math.min(next.w, st.w + (next.w - st.w) * ease)
  st.h = Math.min(next.h, st.h + (next.h - st.h) * ease)

  const f = DOCK_FOLLOW[style]
  st.vx += (f.k * (next.left - st.x) - f.c * st.vx) * dt
  st.vy += (f.k * (next.top - st.y) - f.c * st.vy) * dt
  st.x += st.vx * dt; st.y += st.vy * dt
  st.scv += (300 * (1 - st.sc) - 20 * st.scv) * dt; st.sc += st.scv * dt

  const vertical = key[0] === 'v'
  if (style === 'jelly') {
    const target = clamp(-(vertical ? st.vx : st.vy) / 70, -5, 5)
    st.shearV += (240 * (target - st.shear) - 7 * st.shearV) * dt; st.shear += st.shearV * dt
  } else if (style === 'shock') {
    st.sqV += (520 * (0 - st.sq) - 16 * st.sqV) * dt; st.sq += st.sqV * dt
  } else if (style === 'comet') {
    const target = clamp(st.vx / 160, -3.5, 3.5)
    st.rotV += (200 * (target - st.rot) - 13 * st.rotV) * dt; st.rot += st.rotV * dt
  }
  if (style === 'trail' || style === 'comet') {
    st.echoes.forEach((e, i) => {
      const soft = style === 'trail' ? 0.6 - i * 0.2 : 0.8 - i * 0.2
      e.vx += (f.k * soft * (st.x - e.x) - 9 * e.vx) * dt; e.vy += (f.k * soft * (st.y - e.y) - 9 * e.vy) * dt
      e.x += e.vx * dt; e.y += e.vy * dt
    })
  } else {
    // Styles with no echoes keep them on the dock, so a later switch to one that has them starts
    // from where the dock is and `followSettled` does not wait on echoes nobody draws.
    for (const e of st.echoes) { e.x = st.x; e.y = st.y; e.vx = e.vy = 0 }
  }
}

/** Shock: the button just landed at `speed` px/s — the dock takes a smaller share of the impact. */
export function landImpulse(st: DockFollowState, style: NayFabStyle, reduced: boolean, speed: number): void {
  if (style !== 'shock' || reduced) return
  st.sq = clamp(speed / 2200, 0.03, 0.08); st.sqV = 0
}

export interface DockFrame {
  left: number; top: number; w: number; h: number
  origin: string
  transform: string
  opacity: number
  echoes: { left: number; top: number; opacity: number }[]
}

/**
 * Where to draw the dock this frame, with its style's deformation and the berth that deformation
 * needs. `buttonSpeed` widens the berth while the button itself is stretched.
 */
export function renderDock(st: DockFollowState, btn: AnchorRect, vp: Viewport, style: NayFabStyle, reduced: boolean, buttonSpeed: number, opts: FollowOpts = WITH_FADE): DockFrame {
  const vertical = st.key[0] === 'v'
  let extra = '', reach = 0
  if (!reduced) {
    if (style === 'jelly') {
      const squish = clamp(Math.hypot(st.vx, st.vy) / 6000, 0, 0.05)
      extra = vertical ? ` skewX(${st.shear}deg) scale(${1 + squish}, ${1 - squish})` : ` skewY(${st.shear}deg)`
      reach = Math.abs(Math.tan(st.shear * Math.PI / 180)) * (vertical ? st.h : st.w) + squish * Math.max(st.w, st.h)
    } else if (style === 'shock') {
      extra = vertical ? ` scale(${1 + st.sq * 0.5}, ${1 - st.sq})` : ` scale(${1 - st.sq}, ${1 + st.sq * 0.5})`
      reach = Math.abs(st.sq) * 0.5 * Math.max(st.w, st.h)
    } else if (style === 'comet') {
      extra = ` rotate(${st.rot}deg)`
      reach = Math.abs(Math.sin(st.rot * Math.PI / 180)) * Math.max(st.w, st.h)
    }
  }
  const pad = reduced ? 0 : 6 + reach + clamp(buttonSpeed / 3200, 0, 0.42) * btn.w / 2
  const edge = reduced ? 6 : 6 + reach
  const g = guard({ x: st.x, y: st.y, w: st.w, h: st.h }, st.place.grow, vertical, btn, vp, pad, edge)
  const over = g.x < btn.x + btn.w + pad && btn.x - pad < g.x + st.w && g.y < btn.y + btn.h + pad && btn.y - pad < g.y + st.h
  const opacity = !opts.fade ? 1 : over && !reduced ? Math.min(st.o, 0.15) : st.o
  const origin = vertical
    ? `${st.place.grow.x === 'left' ? 'right' : 'left'} ${st.place.grow.y === 'up' ? 'bottom' : 'top'}`
    : `${st.place.grow.x === 'left' ? 'right' : 'left'} ${st.place.grow.y === 'up' ? 'bottom' : 'top'}`
  const echoes = (style === 'trail' || style === 'comet') && !reduced && st.swap === 0
    ? st.echoes.map((e, i) => {
        const safe = guard({ x: e.x, y: e.y, w: st.w, h: st.h }, st.place.grow, vertical, btn, vp, 6, 6)
        const lag = Math.hypot(g.x - e.x, g.y - e.y)
        const cap = style === 'trail' ? 0.45 - i * 0.15 : 0.3 - i * 0.12
        return { left: safe.x, top: safe.y, opacity: clamp(lag / 120, 0, cap) }
      })
    : []
  return { left: g.x, top: g.y, w: st.w, h: st.h, origin, transform: `scale(${st.sc})${extra}`, opacity, echoes }
}

function guard(r: { x: number; y: number; w: number; h: number }, grow: DockPlacement['grow'], vertical: boolean, b: AnchorRect, vp: Viewport, pad: number, edge: number): { x: number; y: number } {
  let { x, y } = r
  const bx = b.x - pad, by = b.y - pad, bw = b.w + 2 * pad, bh = b.h + 2 * pad
  const overlaps = x < bx + bw + DOCK_GAP && bx - DOCK_GAP < x + r.w && y < by + bh + DOCK_GAP && by - DOCK_GAP < y + r.h
  if (overlaps) {
    if (vertical) {
      if (grow.y === 'up') y = Math.min(y, by - DOCK_GAP - r.h); else y = Math.max(y, by + bh + DOCK_GAP)
    } else if (grow.x === 'left') x = Math.min(x, bx - DOCK_GAP - r.w)
    else x = Math.max(x, bx + bw + DOCK_GAP)
  }
  return { x: clamp(x, edge, Math.max(edge, vp.w - r.w - edge)), y: clamp(y, edge, Math.max(edge, vp.h - r.h - edge)) }
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/**
 * A transform that changes nothing, written as nothing. `renderDock` always writes one (`scale(1)`
 * at rest, plus the style's skew or rotation), and ANY transform on an element makes it the
 * containing block of its `position: fixed` descendants — which is exactly what the `Select`
 * popovers inside the dock and the notification card are. So a frame at rest clears it, and a
 * popover opened after a drag lands where it belongs instead of offset by the dock's corner.
 */
/**
 * THE STYLE ONE FRAME WRITES, in motion and at rest — the rule that keeps popovers working.
 *
 * In MOTION the element is moved by a composited `translate3d` from its React-owned resting place,
 * with `will-change: transform` so the browser keeps it on its own layer. At REST it carries NO
 * transform and NO `will-change` at all, and is placed by `left`/`top` instead: either property
 * (even `will-change: transform` alone) makes the element the containing block of its
 * `position: fixed` descendants. The `Select` popovers inside the dock are exactly that, so with
 * `will-change` left on permanently (#825) every dropdown opened relative to the dock, its
 * `scrollIntoView` scrolled the settings screen, and the `Select` closed itself on that scroll —
 * "the dropdown flashes and closes", desktop only (the phone's dock is a sheet with no transform),
 * and less often with the page zoomed out (the option was already in view, so nothing scrolled).
 */
export interface FrameStyle { left?: number; top?: number; transform: string; willChange: string }

export function frameStyle(fr: Pick<DockFrame, 'left' | 'top' | 'transform'>, base: { left: number; top: number }, moving: boolean): FrameStyle {
  if (moving) {
    return { transform: `translate3d(${fr.left - base.left}px, ${fr.top - base.top}px, 0) ${fr.transform}`, willChange: 'transform' }
  }
  return { left: fr.left, top: fr.top, transform: restingTransform(fr.transform), willChange: '' }
}

/**
 * PURE: the opacity each outline echo may be drawn at. Echoes exist ONLY while the follower is
 * visible AND moving: at rest, while it leaves, or once it is gone they are 0 — an echo left at its
 * last opacity stayed on screen as an empty outline after the card had hidden (owner, v2.85.2).
 */
export function echoOpacities(fr: Pick<DockFrame, 'echoes'> | null, moving: boolean, visible: boolean): number[] {
  return [0, 1].map(i => (fr && moving && visible ? fr.echoes[i]?.opacity ?? 0 : 0))
}

export function restingTransform(t: string): string {
  const fns = [...t.matchAll(/(\w+)\(([^)]*)\)/g)]
  const identity = fns.every(([, fn, args]) => {
    const nums = args!.split(',').map(a => parseFloat(a))
    if (fn === 'scale') return nums.every(n => Math.abs(n - 1) < 1e-3)
    if (fn === 'skewX' || fn === 'skewY' || fn === 'rotate') return nums.every(n => Math.abs(n) < 1e-3)
    if (fn === 'translate3d' || fn === 'translate') return nums.every(n => Math.abs(n) < 0.5)
    return false
  })
  return identity ? '' : t
}

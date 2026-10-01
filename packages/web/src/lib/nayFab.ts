/**
 * nayFab.ts — PURE: where the Nay chat button sits, how it moves, and how it looks while moving.
 *
 * The button can be dragged anywhere (owner, 2026-09-29). Its position is remembered per browser
 * (`localStorage`, never `/api/preferences`: on a central that file is shared by everyone signed
 * in) and clamped whenever the window changes size. It is pulled flat against an edge only when
 * it is released CLOSE to one (`dropFabAt`, the edge magnet); anywhere else it stays where it was
 * dropped.
 *
 * The MOTION is a spring toward the target, and the LOOK is one of the four studies the owner
 * chose from the demo page (all four ship, selectable from the dock's settings popover):
 *  - `jelly`  — stretches along its travel, narrows across it, wobbles square on release (default);
 *  - `trail`  — outline echoes follow on softer springs;
 *  - `shock`  — a throw squashes it against the landing and sends out an orange ripple;
 *  - `comet`  — it leans into its motion and draws a tapered tail.
 * `NAY_FAB_STYLES` is the extensible list: a stored value that is not in it reads as the default,
 * so removing a style later can never leave a browser with a style nothing can draw.
 *
 * Everything here is arithmetic over plain numbers, so the physics can be tested without a DOM.
 */

export const NAY_FAB_STYLES = ['jelly', 'trail', 'shock', 'comet'] as const
export type NayFabStyle = typeof NAY_FAB_STYLES[number]
// Shipped default (owner, 2026-09-30): the elastic trail. A stored choice is kept; only an ABSENT one reads this.
export const DEFAULT_NAY_FAB_STYLE: NayFabStyle = 'trail'

export const FAB_SIZE = 56
/** Distance kept from every edge of the window. */
export const FAB_EDGE = 16
/** A pointer that moved less than this between down and up was a CLICK, never a drag. */
export const FAB_CLICK_SLOP = 5
/** The spring the button settles on. The studies page let the owner feel these two numbers. */
export const FAB_SPRING = { stiffness: 260, damping: 14 }

export interface Vec { x: number; y: number }
export interface Viewport { w: number; h: number }

export interface NayFabPrefs {
  style: NayFabStyle
  snap: boolean
  /** Top-left corner in CSS pixels, or null for the default bottom-right place. */
  pos: Vec | null
  /**
   * How the open DOCK follows the button, and how a NOTIFICATION CARD does — each its own choice,
   * combinable with the button's (owner, 2026-09-30). ABSENT means "inherit the button's style",
   * which is what every browser had before the choice existed, so nothing changes until somebody
   * picks one. Read them through `dockStyleOf` / `cardStyleOf`, never directly.
   */
  dockStyle?: NayFabStyle
  cardStyle?: NayFabStyle
}

/** The style the open dock follows the button with: its own choice, else the button's. */
export function dockStyleOf(p: NayFabPrefs): NayFabStyle { return p.dockStyle ?? p.style }

/** The style a notification card follows the button with: its own choice, else the button's. */
export function cardStyleOf(p: NayFabPrefs): NayFabStyle { return p.cardStyle ?? p.style }

export const DEFAULT_NAY_FAB_PREFS: NayFabPrefs = { style: DEFAULT_NAY_FAB_STYLE, snap: true, pos: null }

export function isNayFabStyle(v: unknown): v is NayFabStyle {
  return typeof v === 'string' && (NAY_FAB_STYLES as readonly string[]).includes(v)
}

/** Reads whatever was stored, keeping each field it can read and defaulting the rest. */
export function parseNayFabPrefs(raw: unknown): NayFabPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const p = o.pos as Record<string, unknown> | null | undefined
  const pos = p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y)
    ? { x: p.x as number, y: p.y as number }
    : null
  return {
    style: isNayFabStyle(o.style) ? o.style : DEFAULT_NAY_FAB_STYLE,
    snap: typeof o.snap === 'boolean' ? o.snap : DEFAULT_NAY_FAB_PREFS.snap,
    pos,
    ...(isNayFabStyle(o.dockStyle) ? { dockStyle: o.dockStyle } : {}),
    ...(isNayFabStyle(o.cardStyle) ? { cardStyle: o.cardStyle } : {}),
  }
}

/** The default place: bottom-right, `bottomInset` above the floor (a phone's bottom nav). */
export function defaultFabPos(vp: Viewport, bottomInset = 0): Vec {
  return { x: vp.w - FAB_SIZE - 24, y: vp.h - FAB_SIZE - 24 - bottomInset }
}

/** Keeps the whole button inside the window, `FAB_EDGE` from every side. */
export function clampFabPos(pos: Vec, vp: Viewport, bottomInset = 0): Vec {
  const maxX = Math.max(FAB_EDGE, vp.w - FAB_SIZE - FAB_EDGE)
  const maxY = Math.max(FAB_EDGE, vp.h - FAB_SIZE - FAB_EDGE - bottomInset)
  return { x: Math.min(maxX, Math.max(FAB_EDGE, pos.x)), y: Math.min(maxY, Math.max(FAB_EDGE, pos.y)) }
}

/**
 * THE EDGE MAGNET (owner, 2026-09-30). The button goes wherever it is dropped; an edge pulls it in
 * only when it is released CLOSE to that edge. "Snap to the nearest edge" used to fire on every
 * release, wherever the button was dropped, which confined it to the edges and corners.
 *
 * `FAB_MAGNET_PX` is the gap between the button's side and the window's side that counts as close.
 * Each side is judged on its own, so a drop near a corner can engage two edges at once.
 */
export const FAB_MAGNET_PX = 56

export interface MagnetEdges { left: boolean; right: boolean; top: boolean; bottom: boolean }
export const NO_MAGNET: MagnetEdges = { left: false, right: false, top: false, bottom: false }

/** Which edges are close enough to pull the button in, measured from its sides to the window's. */
export function magnetEdges(pos: Vec, vp: Viewport, bottomInset = 0, threshold = FAB_MAGNET_PX): MagnetEdges {
  const floor = vp.h - bottomInset
  return {
    left: pos.x <= threshold,
    right: vp.w - (pos.x + FAB_SIZE) <= threshold,
    top: pos.y <= threshold,
    bottom: floor - (pos.y + FAB_SIZE) <= threshold,
  }
}

export function anyMagnet(m: MagnetEdges): boolean {
  return m.left || m.right || m.top || m.bottom
}

/**
 * Where a released button comes to rest. It is always kept on screen; with the magnet on, every
 * edge it was dropped close to pulls it flat against that edge, and it stays exactly where it was
 * dropped otherwise. With the magnet off it never snaps.
 */
export function dropFabAt(pos: Vec, vp: Viewport, bottomInset = 0, magnet = true): Vec {
  const p = clampFabPos(pos, vp, bottomInset)
  if (!magnet) return p
  const m = magnetEdges(p, vp, bottomInset)
  const floor = vp.h - bottomInset
  return {
    x: m.left ? FAB_EDGE : m.right ? vp.w - FAB_SIZE - FAB_EDGE : p.x,
    y: m.top ? FAB_EDGE : m.bottom ? floor - FAB_SIZE - FAB_EDGE : p.y,
  }
}

export interface SpringState { pos: Vec; vel: Vec }

/**
 * One damped-spring step toward `target`. `dt` in seconds; callers substep so a stiff spring
 * stays stable at a 60 Hz frame.
 */
export function stepSpring(s: SpringState, target: Vec, dt: number, k = FAB_SPRING.stiffness, c = FAB_SPRING.damping): SpringState {
  const ax = k * (target.x - s.pos.x) - c * s.vel.x
  const ay = k * (target.y - s.pos.y) - c * s.vel.y
  const vel = { x: s.vel.x + ax * dt, y: s.vel.y + ay * dt }
  return { vel, pos: { x: s.pos.x + vel.x * dt, y: s.pos.y + vel.y * dt } }
}

/** True once the spring is close enough to its target, and slow enough, to stop animating. */
export function springAtRest(s: SpringState, target: Vec): boolean {
  return Math.hypot(target.x - s.pos.x, target.y - s.pos.y) < 0.5 && Math.hypot(s.vel.x, s.vel.y) < 8
}

/**
 * How far the body stretches for a given speed (px/s): 0 at rest, capped at `max` so a violent
 * throw never turns the button into a line. Proportional below the cap, as the brief asked.
 */
export function stretchFor(speed: number, max = 0.42): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0
  return Math.min(max, speed / 3200)
}

/** Smoothed pointer velocity, so one jittery event cannot fling the shape. */
export function smoothVelocity(prev: Vec, dx: number, dy: number, dtSec: number): Vec {
  const dt = Math.max(0.001, dtSec)
  return { x: prev.x * 0.6 + (dx / dt) * 0.4, y: prev.y * 0.6 + (dy / dt) * 0.4 }
}

/** The name each style is shown under, in both languages. */
export const NAY_FAB_STYLE_LABEL: Record<NayFabStyle, { pt: string; en: string }> = {
  jelly: { pt: 'Gelatina', en: 'Jelly' },
  trail: { pt: 'Rastro elástico', en: 'Elastic trail' },
  shock: { pt: 'Impacto', en: 'Shock' },
  comet: { pt: 'Cometa', en: 'Comet' },
}

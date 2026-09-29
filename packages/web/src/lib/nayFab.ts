/**
 * nayFab.ts — PURE: where the Nay chat button sits, how it moves, and how it looks while moving.
 *
 * The button can be dragged anywhere (owner, 2026-09-29). Its position is remembered per browser
 * (`localStorage`, never `/api/preferences`: on a central that file is shared by everyone signed
 * in), clamped whenever the window changes size, and snapped to the nearest edge on release when
 * the viewer asks for it (always on a phone, where a button floating mid-screen covers content).
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
export const DEFAULT_NAY_FAB_STYLE: NayFabStyle = 'jelly'

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
}

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

/** Moves the button flat against whichever edge its centre is nearest, keeping the other axis. */
export function snapFabToEdge(pos: Vec, vp: Viewport, bottomInset = 0): Vec {
  const p = clampFabPos(pos, vp, bottomInset)
  const floor = vp.h - bottomInset
  const cx = p.x + FAB_SIZE / 2, cy = p.y + FAB_SIZE / 2
  const d = { left: cx, right: vp.w - cx, top: cy, bottom: floor - cy }
  const nearest = Math.min(d.left, d.right, d.top, d.bottom)
  if (nearest === d.left) return { ...p, x: FAB_EDGE }
  if (nearest === d.right) return { ...p, x: vp.w - FAB_SIZE - FAB_EDGE }
  if (nearest === d.top) return { ...p, y: FAB_EDGE }
  return { ...p, y: floor - FAB_SIZE - FAB_EDGE }
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

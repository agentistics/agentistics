/**
 * nayFabLive.ts — the Nay button's LIVE position, for the dock that follows it.
 *
 * The button moves in its own per-frame loop (`NayFab`), and its stored position only changes when a
 * drag ends — so a dock reading the stored position jumps when the drag ends instead of following.
 * This is the channel between the two: the button publishes where it IS every frame, and a
 * `landed` count bumps when a drag is released (the Shock style's cue). A module-level value, not
 * React state: it changes every frame and nobody should re-render for it.
 */

export interface FabLive { x: number; y: number; speed: number; landed: number; landSpeed: number }

let live: FabLive | null = null
const listeners = new Set<() => void>()

export function publishFabLive(x: number, y: number, speed: number): void {
  live = { x, y, speed, landed: live?.landed ?? 0, landSpeed: live?.landSpeed ?? 0 }
  for (const l of listeners) l()
}

export function publishFabLanded(speed: number): void {
  if (!live) return
  live = { ...live, landed: live.landed + 1, landSpeed: speed }
  for (const l of listeners) l()
}

export function getFabLive(): FabLive | null { return live }

export function subscribeFabLive(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

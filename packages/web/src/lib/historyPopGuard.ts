/**
 * historyPopGuard.ts — the app's ONE `popstate` guard, registered before the router's listener.
 *
 * `unsavedLeave.ts`'s header carries the measurement: `popstate` listeners on `window` run in the
 * order they were added, and `BrowserRouter` adds its own as it mounts, before any lazy page can.
 * So `main.tsx` calls `installHistoryPopGuard()` before its first render, and the Sessions page's
 * `UnsavedChangesGuard` arms it with `armHistoryPopGuard` while it is mounted. Armed by nobody, the
 * listener does nothing at all.
 */
import { createPopGuard, type PopGuard, type PopGuardArming, type PoppableWindow } from './unsavedLeave'

let guard: PopGuard | null = null
let installed = false

function theGuard(): PopGuard | null {
  if (typeof window === 'undefined') return null
  guard ??= createPopGuard(window as unknown as PoppableWindow)
  return guard
}

/** Once, from `main.tsx`, before `createRoot(...).render`. Idempotent. */
export function installHistoryPopGuard(): void {
  const g = theGuard()
  if (g === null || installed) return
  installed = true
  g.listen()
}

/** Arms the guard for the calling page; returns the disarm. Inert where there is no window. */
export function armHistoryPopGuard(arming: PopGuardArming): () => void {
  return theGuard()?.arm(arming) ?? (() => {})
}

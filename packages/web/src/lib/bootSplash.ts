/**
 * bootSplash.ts — React's side of the boot splash (see `prebootHandoff.ts` for the rule).
 *
 * `useBootHold()` is mounted by every boot state; while one is mounted the splash stays exactly as
 * the first frame drew it. When the last hold goes, the release waits two animation frames (one for
 * React's commit to be painted under the splash) and fades it out. `setBootStatus` writes the one
 * optional line under the loader.
 */
import { useLayoutEffect } from 'react'
import { shouldReleasePreboot } from './prebootHandoff'

const SPLASH_ID = 'ag-preboot'
const BOOT_ANCHOR_KEY = 'ag-boot-anchor'

let holds = 0
let released = false
let pending = false

function splash(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById(SPLASH_ID)
}

/** True once the splash has left (or never existed): a loading state now draws its own loader. */
export function bootReleased(): boolean {
  return released || !splash()
}

/** Fade the splash out now, whatever holds it — for the error boundary. */
export function releaseBoot(): void {
  if (released) return
  released = true
  try { sessionStorage.removeItem(BOOT_ANCHOR_KEY) } catch { /* private mode */ }
  const el = splash()
  if (!el) return
  el.classList.add('ag-boot-out')
  el.setAttribute('aria-hidden', 'true')
  const remove = () => el.remove()
  el.addEventListener('transitionend', remove, { once: true })
  window.setTimeout(remove, 400)
}

/** Release the splash if nothing holds it by the time the current commit has been painted. */
export function scheduleBootRelease(): void {
  if (released || pending || typeof window === 'undefined') return
  pending = true
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    pending = false
    if (shouldReleasePreboot({ holds, released, painted: true })) releaseBoot()
  }))
}

/** Keeps the splash on screen for as long as the calling component is mounted and `active`. */
export function useBootHold(active = true): void {
  useLayoutEffect(() => {
    if (!active || released) return
    holds += 1
    return () => { holds -= 1; scheduleBootRelease() }
  }, [active])
}

/** The one short line under the loader; `null` leaves whatever is there. */
export function setBootStatus(text: string | null): void {
  if (text === null) return
  const el = splash()?.querySelector<HTMLElement>('.ag-boot-status')
  if (el && el.textContent !== text) el.textContent = text
}

/**
 * engineSurfaceHost — the ONE open engine surface, held outside any screen.
 *
 * A surface stays mounted while the person navigates (the host component lives at the app root, not in
 * a page), and only `closeEngineSurface` ends it. Opening another surface replaces the current one.
 * The layout (`full` modal / `side` panel) is host state the surface flips through its context.
 */
import { useSyncExternalStore } from 'react'
import type { EngineSurfaceInfo, SurfaceLayout } from './engineSurfaces'

export interface OpenSurface {
  surface: EngineSurfaceInfo
  sessionId: string | null
  lang: 'pt' | 'en'
  /** Increments per opening, so reopening the same surface remounts it. */
  nonce: number
  layout: SurfaceLayout
}

let current: OpenSurface | null = null
let nonce = 0
let returnFocus: HTMLElement | null = null
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

export function openEngineSurface(surface: EngineSurfaceInfo, opts: { sessionId: string | null; lang: 'pt' | 'en'; trigger?: HTMLElement | null }): void {
  // Asking for the surface that is already open keeps it (and its state) rather than restarting it.
  if (current && current.surface.id === surface.id) { current = { ...current, sessionId: opts.sessionId, lang: opts.lang }; emit(); return }
  returnFocus = opts.trigger ?? null
  current = { surface, sessionId: opts.sessionId, lang: opts.lang, nonce: ++nonce, layout: 'full' }
  emit()
}

export function closeEngineSurface(): void {
  if (!current) return
  current = null
  emit()
  const back = returnFocus
  returnFocus = null
  if (back && typeof back.focus === 'function' && back.isConnected) back.focus()
}

export function setEngineSurfaceLayout(layout: SurfaceLayout): void {
  if (!current || current.layout === layout) return
  current = { ...current, layout }
  emit()
}

export function currentEngineSurface(): OpenSurface | null { return current }

export function useOpenEngineSurface(): OpenSurface | null {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => current, () => null)
}

/** Tests only. */
export function resetEngineSurfaceHostForTests(): void { current = null; returnFocus = null; emit() }

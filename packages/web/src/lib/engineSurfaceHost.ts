/**
 * engineSurfaceHost — the ONE open engine surface, held outside any screen.
 *
 * A surface stays mounted while the person navigates (the host component lives at the app root, not in
 * a page), and only `closeEngineSurface` ends it. Opening another surface replaces the current one.
 * The layout (`full` modal / `side` panel / `inline` above the session composer) is host state the surface flips through its context.
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
  /** The composer instance whose button opened it: its inline slot is preferred. */
  slotId?: string
}

let current: OpenSurface | null = null
let nonce = 0
let returnFocus: HTMLElement | null = null
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

export function openEngineSurface(surface: EngineSurfaceInfo, opts: { sessionId: string | null; lang: 'pt' | 'en'; trigger?: HTMLElement | null; slotId?: string }): void {
  // Asking for the surface that is already open keeps it (and its state) rather than restarting it.
  if (current && current.surface.id === surface.id) { current = { ...current, sessionId: opts.sessionId, lang: opts.lang, slotId: opts.slotId }; emit(); return }
  returnFocus = opts.trigger ?? null
  current = { surface, sessionId: opts.sessionId, lang: opts.lang, nonce: ++nonce, layout: surface.layout ?? 'full', slotId: opts.slotId }
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
  if (layout === 'inline' && current.surface.placement !== 'composer') return
  current = { ...current, layout }
  emit()
}

/**
 * The elements above session composers that an `inline` surface may be mounted into, one per composer
 * instance. Each slot is registered by, and removed only by, its own composer. The surface goes to the
 * slot of the composer whose button opened it; if that one is gone, to another live slot of the same
 * session; with none, it is drawn as a `side` panel.
 */
const slots = new Map<string, { el: HTMLElement; sessionId: string }>()
export function registerEngineInlineSlot(id: string, sessionId: string, el: HTMLElement | null, own?: HTMLElement | null): void {
  if (el) { if (slots.get(id)?.el === el) return; slots.set(id, { el, sessionId }); emit(); return }
  if (own && slots.get(id)?.el === own) { slots.delete(id); emit() }
}
/** The slot the open surface should occupy right now, or `null`. */
export function resolveInlineSlot(): HTMLElement | null {
  if (!current || current.layout !== 'inline') return null
  const own = current.slotId ? slots.get(current.slotId) : undefined
  if (own && own.sessionId === current.sessionId) return own.el
  for (const v of slots.values()) if (v.sessionId === current.sessionId) return v.el
  return null
}
export function useEngineInlineSlot(): HTMLElement | null {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, resolveInlineSlot, () => null)
}

/** PURE. The layout actually drawn: `inline` needs a slot, and falls back to `side` without one. */
export function effectiveSurfaceLayout(layout: SurfaceLayout, hasSlot: boolean): SurfaceLayout {
  return layout === 'inline' && !hasSlot ? 'side' : layout
}

export function currentEngineSurface(): OpenSurface | null { return current }

export function useOpenEngineSurface(): OpenSurface | null {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => current, () => null)
}

/** Tests only. */
export function resetEngineSurfaceHostForTests(): void { current = null; returnFocus = null; slots.clear(); emit() }

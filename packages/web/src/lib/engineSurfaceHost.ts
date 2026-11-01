/**
 * engineSurfaceHost — the mounted engine surfaces, held outside any screen.
 *
 * A surface stays mounted while the person navigates (the host component lives at the app root, not in
 * a page). At most ONE is on screen; opening another takes the visible one away — ending it, or, when it
 * asked to be kept alive (`ctx.keepAlive(true)`), PARKING it: still mounted, its element moved off
 * screen, until it is brought back or ends. The layout (`full` modal / `side` panel / `inline` above the
 * session composer / `page` on its own route) is host state the surface flips through its context.
 */
import { useSyncExternalStore } from 'react'
import { isValidSessionId, type EngineSurfaceInfo, type SurfaceIndicator, type SurfaceLayout } from './engineSurfaces'

export interface OpenSurface {
  surface: EngineSurfaceInfo
  sessionId: string | null
  /** 1.18: what kind of conversation `sessionId` is, when the opener knew. */
  sessionKind?: 'nay' | 'session'
  lang: 'pt' | 'en'
  /** Increments per opening, so reopening the same surface remounts it; also the surface's handle. */
  nonce: number
  /** Bumped each time the already-mounted surface is asked for again (same nonce), so a view can re-select it. */
  reopen: number
  layout: SurfaceLayout
  /** The composer instance whose button opened it: its inline slot is preferred. */
  slotId?: string
  /** Mounted but off screen (kept alive). The `layout` it had is kept, for when it comes back. */
  parked: boolean
  /** Asked by the surface: taking it off screen parks it instead of ending it. */
  keepAlive: boolean
  /** Set when leaving its session floated it: the layout to give back when that session view returns. */
  leftLayout?: SurfaceLayout
  /** The top-bar pill it asked for, or `null`. */
  indicator: SurfaceIndicator | null
}

let mounted: OpenSurface[] = []
let visible: OpenSurface | null = null
let nonce = 0
let returnFocus: { nonce: number; el: HTMLElement } | null = null
const endHandlers = new Map<number, () => void>()
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

function commit(next: OpenSurface[]): void {
  mounted = next
  visible = next.find(s => !s.parked) ?? null
  for (const l of listeners) l()
}
const emit = () => { for (const l of listeners) l() }
const patch = (n: number, p: Partial<OpenSurface>) => commit(mounted.map(s => (s.nonce === n ? { ...s, ...p } : s)))

function remove(n: number): void {
  if (!mounted.some(s => s.nonce === n)) return
  endHandlers.delete(n)
  commit(mounted.filter(s => s.nonce !== n))
  const back = returnFocus
  if (back?.nonce === n) {
    returnFocus = null
    if (typeof back.el.focus === 'function' && back.el.isConnected) back.el.focus()
  }
}

/** Takes the visible surface off screen: parked if it asked to be kept alive, ended otherwise. */
function hide(s: OpenSurface): void {
  if (s.keepAlive) {
    patch(s.nonce, { parked: true })
    const back = returnFocus
    if (back?.nonce === s.nonce) {
      returnFocus = null
      if (typeof back.el.focus === 'function' && back.el.isConnected) back.el.focus()
    }
  } else remove(s.nonce)
}

export function openEngineSurface(surface: EngineSurfaceInfo, opts: { sessionId: string | null; sessionKind?: 'nay' | 'session'; lang: 'pt' | 'en'; trigger?: HTMLElement | null; slotId?: string }): void {
  // Asking for a surface that is already mounted keeps it (and its state) rather than restarting it, and
  // brings it back on screen if it was parked.
  const have = mounted.find(s => s.surface.id === surface.id)
  if (visible && visible !== have) hide(visible)
  if (have) {
    const now = mounted.find(s => s.nonce === have.nonce)
    if (now) patch(now.nonce, { reopen: now.reopen + 1, sessionId: opts.sessionId, sessionKind: opts.sessionKind, lang: opts.lang, slotId: opts.slotId, parked: false })
    return
  }
  const n = ++nonce
  if (opts.trigger) returnFocus = { nonce: n, el: opts.trigger }
  const layout: SurfaceLayout = surface.placement === 'rail' ? 'page' : surface.layout === 'page' ? 'full' : surface.layout ?? 'full'
  commit([...mounted, { surface, sessionId: opts.sessionId, ...(opts.sessionKind ? { sessionKind: opts.sessionKind } : {}), lang: opts.lang, nonce: n, reopen: 0, layout, slotId: opts.slotId, parked: false, keepAlive: false, indicator: null }])
}

/**
 * The host's own close (the close button, Esc, the backdrop, the active composer button): the visible
 * surface — or the one named by `n` — goes off screen, parked if it is kept alive, ended otherwise.
 */
export function closeEngineSurface(n?: number): void {
  const s = n === undefined ? visible : mounted.find(x => x.nonce === n)
  if (!s || s.parked) return
  hide(s)
}

/**
 * The host's END (the active composer button's promise): the surface's own `onIndicatorEnd` handler
 * when it registered one (it ends at its own pace and calls `ctx.close()`), else the surface is removed
 * — unmounted, its indicator with it. Unlike `closeEngineSurface` it never just parks a kept-alive one.
 */
export function endEngineSurfaceFromHost(n: number): void {
  if (!mounted.some(x => x.nonce === n)) return
  if (endHandlers.has(n)) endEngineSurfaceIndicator(n)
  else remove(n)
}

/** Minimize a floating window without ending it, even before keepAlive was requested. */
export function minimizeEngineSurface(n: number): void {
  const s = mounted.find(x => x.nonce === n)
  if (s?.layout === 'float') patch(n, { parked: true })
}

/** Leaving a session floats its kept-alive inline/side surface unless explicitly opted out. */
function floatAfterLeave(sessionId: string): void {
  queueMicrotask(() => {
    if ([...sessionViews.values()].includes(sessionId) || [...sideWants.values()].includes(sessionId) || [...slots.values()].some(v => v.sessionId === sessionId)) return
    for (const s of mounted) {
      if (s.sessionId === sessionId && !s.parked && s.keepAlive && s.surface.floatOnLeave !== false
        && (s.layout === 'inline' || s.layout === 'side')) patch(s.nonce, { layout: 'float', leftLayout: s.layout })
    }
  })
}

/** Ends a surface whatever it asked (`ctx.close()`). */
export function endEngineSurface(n: number): void { remove(n) }

/** Leaving a `rail` surface's page: parked if kept alive, ended otherwise. */
export function leaveEngineSurfacePage(id: string): void {
  const s = mounted.find(x => x.surface.id === id)
  if (s && !s.parked && s.layout === 'page') hide(s)
}

/** Brings a parked surface back on screen (the visible one, if another, goes away as usual). */
export function resumeEngineSurface(n: number): void {
  const s = mounted.find(x => x.nonce === n)
  if (!s || !s.parked) return
  if (visible && visible.nonce !== n) hide(visible)
  patch(n, { parked: false })
}

export function setEngineSurfaceLayout(layout: SurfaceLayout, n?: number): void {
  const s = n === undefined ? visible : mounted.find(x => x.nonce === n)
  if (!s || s.layout === layout) return
  if (layout === 'inline' && s.surface.placement !== 'composer') return
  // A `rail` surface is a page and nothing else; a page belongs to a `rail` surface only.
  if ((layout === 'page') !== (s.surface.placement === 'rail')) return
  patch(s.nonce, { layout, leftLayout: undefined })
}

/**
 * After the engine's announcement changed (caps invalidated): every mounted surface — on screen or kept
 * alive off it — that is no longer announced ends, and its indicator goes with it.
 */
export function reconcileEngineSurfaces(announced: (s: EngineSurfaceInfo) => boolean): void {
  for (const s of mounted) if (!announced(s.surface)) remove(s.nonce)
}

/** `ctx.keepAlive`: turning it off while parked ends the surface at once. */
export function setEngineSurfaceKeepAlive(n: number, on: boolean): void {
  const s = mounted.find(x => x.nonce === n)
  if (!s) return
  if (!on && s.parked) { remove(n); return }
  if (s.keepAlive !== on) patch(n, { keepAlive: on })
}

/** `ctx.setIndicator`, after validation. */
export function setEngineSurfaceIndicator(n: number, indicator: SurfaceIndicator | null): void {
  if (!mounted.some(x => x.nonce === n)) return
  patch(n, { indicator })
}

/** `ctx.onIndicatorEnd`: one callback per surface; the returned function removes it if still current. */
export function onEngineSurfaceIndicatorEnd(n: number, fn: () => void): () => void {
  if (!mounted.some(x => x.nonce === n)) return () => {}
  endHandlers.set(n, fn)
  return () => { if (endHandlers.get(n) === fn) endHandlers.delete(n) }
}

/** The app's router navigator, registered by a component inside the router (the top-bar indicators). */
let navigator: ((path: string) => void) | null = null
export function registerEngineSurfaceNavigator(fn: ((path: string) => void) | null, own?: ((path: string) => void) | null): void {
  if (fn) { navigator = fn; return }
  if (!own || navigator === own) navigator = null
}
/** `ctx.openSession`: validates the id and navigates with the app's router (no reload); `false` when it cannot. */
export function openEngineSurfaceSession(sessionId: unknown): boolean {
  if (!isValidSessionId(sessionId) || !navigator) return false
  navigator(`/sessions/${encodeURIComponent(sessionId)}`)
  return true
}

/** The indicator's secondary button. A throwing callback is the surface's problem, never the host's. */
export function endEngineSurfaceIndicator(n: number): void {
  const fn = endHandlers.get(n)
  if (!fn) return
  try { fn() } catch { /* the surface's own error */ }
}

/**
 * The elements above session composers that an `inline` surface may be mounted into, one per composer
 * instance. Each slot is registered by, and removed only by, its own composer. The surface goes to the
 * slot of the composer whose button opened it; if that one is gone, to another live slot of the same
 * session; with none, it is drawn as a `side` panel.
 */
// SessionChat registers even when no inline surface is drawn, covering the Nay panel and detached
// sessions as well as workspace panes. Leaving one of several views does not float a surface.
const sessionViews = new Map<string, string>()
export function registerEngineSessionView(id: string, sessionId: string | null): void {
  const previous = sessionViews.get(id)
  if (sessionId === null) sessionViews.delete(id)
  else sessionViews.set(id, sessionId)
  if (previous && previous !== sessionId) floatAfterLeave(previous)
}

/**
 * Coming back to a session view: a kept-alive composer surface of THAT session that left it (floated when the
 * view went away, or parked when another surface or page took the screen) returns to its layout, the composer's slot. Only a view that just
 * appeared calls this, so a surface the person closed while staying in the session stays parked.
 */
export function resumeParkedInlineSurfaces(sessionId: string): void {
  const s = mounted.find(x => x.keepAlive && x.surface.placement === 'composer' && x.sessionId === sessionId
    && (x.leftLayout !== undefined || (x.parked && x.layout === 'inline')))
  if (!s) return
  if (visible && visible.nonce !== s.nonce) hide(visible)
  patch(s.nonce, { ...(s.leftLayout !== undefined ? { layout: s.leftLayout } : {}), leftLayout: undefined, parked: false })
}

/** Is a `composer` surface with an active face (`activeLabel`) mounted for `sessionId` — on screen, floating or parked? */
export function hasActiveComposerSurface(sessionId: string | null): boolean {
  return sessionId !== null && mounted.some(x => x.sessionId === sessionId && x.surface.placement === 'composer' && !!x.surface.activeLabel)
}
export function useHasActiveComposerSurface(sessionId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => hasActiveComposerSurface(sessionId), () => false)
}

const slots = new Map<string, { el: HTMLElement; sessionId: string }>()
export function registerEngineInlineSlot(id: string, sessionId: string, el: HTMLElement | null, own?: HTMLElement | null): void {
  if (el) { if (slots.get(id)?.el === el) return; slots.set(id, { el, sessionId }); emit(); return }
  if (own && slots.get(id)?.el === own) { slots.delete(id); emit(); floatAfterLeave(sessionId) }
}
/** The slot the visible surface should occupy right now, or `null`. */
export function resolveInlineSlot(): HTMLElement | null {
  const current = visible
  if (!current || current.layout !== 'inline') return null
  const own = current.slotId ? slots.get(current.slotId) : undefined
  if (own && own.sessionId === current.sessionId) return own.el
  for (const v of slots.values()) if (v.sessionId === current.sessionId) return v.el
  return null
}
export function useEngineInlineSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, resolveInlineSlot, () => null)
}

/**
 * The element a `rail` surface's page route renders, one per surface id, registered and removed by that
 * page. Without it (the page is not on screen) a `page` surface is held off screen.
 */
const pageSlots = new Map<string, HTMLElement>()
export function registerEnginePageSlot(id: string, el: HTMLElement | null, own?: HTMLElement | null): void {
  if (el) { if (pageSlots.get(id) === el) return; pageSlots.set(id, el); emit(); return }
  if (own && pageSlots.get(id) === own) { pageSlots.delete(id); emit() }
}
export function resolvePageSlot(): HTMLElement | null {
  const current = visible
  if (!current || current.layout !== 'page') return null
  return pageSlots.get(current.surface.id) ?? null
}
export function useEnginePageSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, resolvePageSlot, () => null)
}

/**
 * The right asides of the sessions workspace, one per pane, each showing ONE session. A session
 * surface drawn as `side` (asked for, or `inline` with no inline slot on screen) whose session has an
 * aside on screen is mounted INSIDE that aside, as its own selected section, instead of the host's
 * fixed side panel. Each slot is registered by, and removed only by, its own aside. Without one (the
 * Nay panel, any other screen) the fixed panel is drawn as before.
 */
const sideSlots = new Map<string, { el: HTMLElement; sessionId: string }>()
export function registerEngineSideSlot(id: string, sessionId: string, el: HTMLElement | null, own?: HTMLElement | null): void {
  if (el) { const had = sideSlots.get(id); if (had?.el === el && had.sessionId === sessionId) return; sideSlots.set(id, { el, sessionId }); emit(); return }
  if (own && sideSlots.get(id)?.el === own) { sideSlots.delete(id); emit() }
}
/** PURE over the store: is `s` a session surface on screen that is drawn as `side`? */
function drawnSide(s: OpenSurface | null): s is OpenSurface {
  if (!s || s.parked || s.sessionId === null || s.surface.placement === 'rail') return false
  return effectiveSurfaceLayout(s.layout, resolveInlineSlot() !== null) === 'side'
}
/** The visible surface, when it is a session surface drawn as `side` for `sessionId`; else `null`. */
export function sideEngineSurfaceFor(sessionId: string | null): OpenSurface | null {
  const current = visible
  return sessionId !== null && drawnSide(current) && current.sessionId === sessionId ? current : null
}
export function useEngineSideSurface(sessionId: string | null): OpenSurface | null {
  return useSyncExternalStore(subscribe, () => sideEngineSurfaceFor(sessionId), () => null)
}
/** The aside the visible surface should be drawn in right now, or `null` (then the fixed side panel). */
export function resolveSideSlot(): HTMLElement | null {
  const current = visible
  if (!drawnSide(current)) return null
  for (const v of sideSlots.values()) if (v.sessionId === current.sessionId) return v.el
  return null
}
/** Id of the aside `resolveSideSlot` picks, or `null`. */
export function resolveSideSlotId(): string | null {
  const current = visible
  if (!drawnSide(current)) return null
  for (const [id, v] of sideSlots) if (v.sessionId === current.sessionId) return id
  return null
}
/**
 * Panes that SHOW a session a side surface is drawn for, and so may be asked to open their aside: the
 * slot only exists inside an open aside, so without this a closed aside could never receive the
 * surface (it would fall back to the fixed panel). Registered by the pane, removed by the same pane.
 */
const sideWants = new Map<string, string>()
export function registerEngineSideWant(id: string, sessionId: string | null): void {
  if (sessionId === null) { const previous = sideWants.get(id); if (sideWants.delete(id)) emit(); if (previous) floatAfterLeave(previous); return }
  if (sideWants.get(id) === sessionId) return
  const previous = sideWants.get(id)
  sideWants.set(id, sessionId); emit()
  if (previous) floatAfterLeave(previous)
}
/**
 * The aside that should hold the visible side surface: the first one that already has its slot, else
 * the one pane asked to open (`aside-main` preferred). `null` when no Sessions pane shows its session.
 */
export function resolveSideAsideId(): string | null {
  const current = visible
  if (!drawnSide(current)) return null
  const mounted = resolveSideSlotId()
  if (mounted !== null) return mounted
  let first: string | null = null
  for (const [id, sid] of sideWants) {
    if (sid !== current.sessionId) continue
    if (id === 'aside-main') return id
    first ??= id
  }
  return first
}
export function useEngineSideAsideId(): string | null {
  return useSyncExternalStore(subscribe, resolveSideAsideId, () => null)
}
export function useEngineSideSlotId(): string | null {
  return useSyncExternalStore(subscribe, resolveSideSlotId, () => null)
}
export function useEngineSideSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, resolveSideSlot, () => null)
}

/** PURE. The layout actually drawn: `inline` needs a slot, and falls back to `side` without one. */
export function effectiveSurfaceLayout(layout: SurfaceLayout, hasSlot: boolean): SurfaceLayout {
  return layout === 'inline' && !hasSlot ? 'side' : layout
}

/** The surface on screen, or `null`. */
export function currentEngineSurface(): OpenSurface | null { return visible }

export function useOpenEngineSurface(): OpenSurface | null {
  return useSyncExternalStore(subscribe, () => visible, () => null)
}

const NONE: OpenSurface[] = []
/** Every mounted surface, on screen or parked. */
export function useMountedEngineSurfaces(): OpenSurface[] {
  return useSyncExternalStore(subscribe, () => mounted, () => NONE)
}
export function mountedEngineSurfaces(): OpenSurface[] { return mounted }

const naySlots = new Map<string, HTMLElement>()
export function registerEngineNaySlot(id: string, el: HTMLElement | null, own?: HTMLElement | null): void {
  if (el) { if (naySlots.get(id) === el) return; naySlots.set(id, el); emit() }
  else if (own && naySlots.get(id) === own) { naySlots.delete(id); emit() }
}
export function useEngineNaySlot(id: string): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => naySlots.get(id) ?? null, () => null)
}

/** Tests only. */
export function resetEngineSurfaceHostForTests(): void { returnFocus = null; naySlots.clear(); sessionViews.clear(); slots.clear(); pageSlots.clear(); sideSlots.clear(); sideWants.clear(); endHandlers.clear(); navigator = null; commit([]) }

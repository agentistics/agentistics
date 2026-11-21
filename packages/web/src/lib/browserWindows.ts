/**
 * browserWindows.ts — PURE model + store of the FLOATING browser windows (NAVEGADOR S11, spec D6/§3.2).
 *
 * A session's browser (A1, id `s:<managedId>`) and the person's own browser (B1, id `personal`) can leave
 * their place (the card in the conversation, the panel in the right rail) for an APP-level window that
 * follows the person across pages — the `nayDock` mould (`placeWindow`, `windowZIndex`), not the
 * per-session `FloatingPanelLayer`, which disappears with the Sessions workspace.
 *
 * THE RULE THIS FILE EXISTS FOR: one browser is on screen in ONE place. A browser with a window — open
 * OR minimized — is "floating", and its card/panel draws a placeholder ("Voltar para a conversa/barra")
 * instead of a second live screen (two screens = two streams and two pointers on one page). `placeOf` is
 * the one answer every surface reads.
 *
 * Persistence follows the house line: WHICH browser floats (and minimized, and the title) is a CHOICE →
 * `/api/user-prefs` key `browserWindows`; WHERE and HOW BIG depends on the screen → localStorage.
 */
import { useSyncExternalStore } from 'react'
import { placeWindow, type NayWindow, type Viewport } from './nayDock'
import { createPersonalDoc } from './sharedPref'

export type BrowserWindowId = 'personal' | `s:${string}`

export interface BrowserWindow extends NayWindow {
  id: BrowserWindowId
  /** The session's title at the time it floated (A1); absent for the personal browser. */
  title?: string
  /** The window covers the viewport (`Esc` leaves). Never persisted: a reload starts windowed. */
  full: boolean
  /**
   * The page it floated from (B1: a session page — the right rail only exists with a session open), where
   * "Voltar para a barra" returns. Absent = the Sessions workspace.
   */
  from?: string
}

export interface BrowserWindowsState { windows: BrowserWindow[] }

export type BrowserPlace = 'docked' | 'floating' | 'minimized'

export const EMPTY_BROWSER_WINDOWS: BrowserWindowsState = { windows: [] }

/** The prototype's window sizes (`opcao-final.html`, `a1-floating` 580×420, `b1-floating` 560×420). */
export const A1_WINDOW = { w: 580, h: 420 }
export const B1_WINDOW = { w: 560, h: 420 }

export const sessionWindowId = (managedId: string): BrowserWindowId => `s:${managedId}`
export const isPersonalWindow = (id: BrowserWindowId): boolean => id === 'personal'
/** The session a window shows, or null for the personal browser. */
export function managedIdOf(id: BrowserWindowId): string | null {
  return id.startsWith('s:') ? id.slice(2) : null
}

export function isBrowserWindowId(v: unknown): v is BrowserWindowId {
  return v === 'personal' || (typeof v === 'string' && /^s:[A-Za-z0-9_.:-]{1,128}$/.test(v))
}

/** Where a browser is drawn: its card/panel, a window, or the minimized chip. */
export function placeOf(state: BrowserWindowsState, id: BrowserWindowId): BrowserPlace {
  const w = state.windows.find(x => x.id === id)
  return !w ? 'docked' : w.minimized ? 'minimized' : 'floating'
}

const topZ = (ws: readonly BrowserWindow[]) => ws.reduce((m, w) => Math.max(m, w.z), 0)

/**
 * "Flutuar": take a browser out of its card/panel into a window. Floating one that already has a window
 * RAISES and restores it — never a second window for the same browser.
 */
/** Only a page of the Sessions workspace is a place to return to (never an arbitrary or external URL). */
export function returnPath(v: unknown): string | undefined {
  return typeof v === 'string' && /^\/sessions(\/[A-Za-z0-9_.:%-]{1,160})?$/.test(v) ? v : undefined
}

export function floatBrowser(state: BrowserWindowsState, id: BrowserWindowId, vp: Viewport, title?: string, fromPath?: string): BrowserWindowsState {
  const from = returnPath(fromPath)
  if (state.windows.some(w => w.id === id)) {
    const next = restoreBrowser(state, id)
    if (title === undefined && from === undefined) return next
    return { windows: next.windows.map(w => (w.id === id ? { ...w, ...(title !== undefined ? { title } : {}), ...(from !== undefined ? { from } : {}) } : w)) }
  }
  const base = isPersonalWindow(id) ? B1_WINDOW : A1_WINDOW
  const n = state.windows.length
  const w = Math.max(320, Math.min(base.w, vp.w - 32))
  const h = Math.max(240, Math.min(base.h, vp.h - 32))
  const x = Math.max(16, Math.min(vp.w - w - 16, Math.round(vp.w * 5 / 16) + n * 28))
  const y = Math.max(16, Math.min(vp.h - h - 16, 96 + n * 28))
  const win: BrowserWindow = { id, x, y, w, h, minimized: false, z: topZ(state.windows) + 1, full: false, ...(title !== undefined ? { title } : {}), ...(from !== undefined ? { from } : {}) }
  return { windows: [...state.windows, win] }
}

/** "Voltar para a conversa/barra" — and B1's close: the window goes, the browser itself stays alive. */
export function dockBrowser(state: BrowserWindowsState, id: BrowserWindowId): BrowserWindowsState {
  if (!state.windows.some(w => w.id === id)) return state
  return { windows: state.windows.filter(w => w.id !== id) }
}

export function minimizeBrowser(state: BrowserWindowsState, id: BrowserWindowId): BrowserWindowsState {
  if (!state.windows.some(w => w.id === id && !w.minimized)) return state
  return { windows: state.windows.map(w => (w.id === id ? { ...w, minimized: true, full: false } : w)) }
}

/** Restore a minimized window (or raise an open one) to the front. */
export function restoreBrowser(state: BrowserWindowsState, id: BrowserWindowId): BrowserWindowsState {
  if (!state.windows.some(w => w.id === id)) return state
  const z = topZ(state.windows) + 1
  return { windows: state.windows.map(w => (w.id === id ? { ...w, minimized: false, z } : w)) }
}

/** Raise without restoring (a click inside an open window). */
export function focusBrowser(state: BrowserWindowsState, id: BrowserWindowId): BrowserWindowsState {
  const win = state.windows.find(w => w.id === id)
  if (!win || win.minimized || win.z === topZ(state.windows)) return state
  return restoreBrowser(state, id)
}

export function setBrowserFull(state: BrowserWindowsState, id: BrowserWindowId, full: boolean): BrowserWindowsState {
  if (!state.windows.some(w => w.id === id && !w.minimized && w.full !== full)) return state
  return { windows: state.windows.map(w => (w.id === id ? { ...w, full } : w)) }
}

/** Move/resize, kept on screen by its header — `nayDock.placeWindow`'s rule, not a second one. */
export function placeBrowser(state: BrowserWindowsState, id: BrowserWindowId, next: Partial<Pick<NayWindow, 'x' | 'y' | 'w' | 'h'>>, vp: Viewport): BrowserWindowsState {
  const placed = placeWindow({ open: false, panelSession: null, windows: state.windows }, id, next, vp).windows as BrowserWindow[]
  return { windows: placed }
}

/** The geometry a phone draws (`final.css`: 8px from each side, 84px from the top, 380 tall) — never stored. */
export function mobileWindowGeometry(vp: Viewport): Pick<NayWindow, 'x' | 'y' | 'w' | 'h'> {
  return { x: 8, y: 84, w: Math.max(0, vp.w - 16), h: Math.min(380, Math.max(240, vp.h - 100)) }
}

// ---------------------------------------------------------------------------------------------
// Persistence: the CHOICE (`/api/user-prefs`) and the GEOMETRY (localStorage), read back tolerantly.

export interface StoredChoice { id: BrowserWindowId; minimized: boolean; title?: string; from?: string; z: number }
export type StoredGeometry = Record<string, Pick<NayWindow, 'x' | 'y' | 'w' | 'h'>>

export function choiceOf(state: BrowserWindowsState): { windows: StoredChoice[] } {
  return { windows: state.windows.map(w => ({ id: w.id, minimized: w.minimized, z: w.z, ...(w.title !== undefined ? { title: w.title } : {}), ...(w.from !== undefined ? { from: w.from } : {}) })) }
}

export function geometryOf(state: BrowserWindowsState): StoredGeometry {
  return Object.fromEntries(state.windows.map(w => [w.id, { x: w.x, y: w.y, w: w.w, h: w.h }]))
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A stored choice + this device's geometry → a state. Anything malformed is dropped, never repaired. */
export function parseBrowserWindows(choice: unknown, geometry: unknown, vp: Viewport): BrowserWindowsState {
  const list = choice && typeof choice === 'object' && Array.isArray((choice as { windows?: unknown }).windows) ? (choice as { windows: unknown[] }).windows : []
  const geo = geometry && typeof geometry === 'object' && !Array.isArray(geometry) ? geometry as Record<string, unknown> : {}
  let state: BrowserWindowsState = EMPTY_BROWSER_WINDOWS
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (!isBrowserWindowId(r.id) || state.windows.some(w => w.id === r.id)) continue
    const title = typeof r.title === 'string' ? r.title.slice(0, 200) : undefined
    state = floatBrowser(state, r.id, vp, title, returnPath(r.from))
    const g = geo[r.id] && typeof geo[r.id] === 'object' ? geo[r.id] as Record<string, unknown> : null
    if (g) {
      const [x, y, w, h] = [num(g.x), num(g.y), num(g.w), num(g.h)]
      if (x !== null && y !== null && w !== null && h !== null) state = placeBrowser(state, r.id, { x, y, w, h }, vp)
    }
    const z = num(r.z)
    state = { windows: state.windows.map(w => (w.id === r.id ? { ...w, minimized: r.minimized === true, ...(z !== null ? { z } : {}) } : w)) }
  }
  return state
}

// ---------------------------------------------------------------------------------------------
// The store (one per app; `BrowserWindows.tsx` draws it, every card/panel reads `placeOf`).

const CHOICE_KEY = 'agentistics-browser-windows'
const GEOMETRY_KEY = 'agentistics-browser-window-geometry'

let choiceStore: ReturnType<typeof createPersonalDoc> | null = null
const choice = () => (choiceStore ??= createPersonalDoc(CHOICE_KEY, 'browserWindows'))

function viewport(): Viewport {
  return typeof window === 'undefined' ? { w: 1280, h: 800 } : { w: window.innerWidth, h: window.innerHeight }
}

function readGeometry(): unknown {
  try { const raw = localStorage.getItem(GEOMETRY_KEY); return raw === null ? null : JSON.parse(raw) } catch { return null }
}

let state: BrowserWindowsState = EMPTY_BROWSER_WINDOWS
let loaded = false
let lastWritten: string | null = null
const listeners = new Set<() => void>()

function load(): void {
  if (loaded) return
  loaded = true
  try {
    state = parseBrowserWindows(choice().get(), readGeometry(), viewport())
    // A choice that lands from the server after mount (or from another device) is followed.
    choice().subscribe(() => {
      const raw = choice().get()
      if (JSON.stringify(raw) === lastWritten) return
      state = parseBrowserWindows(raw, geometryOf(state), viewport())
      for (const l of listeners) l()
    })
  } catch { state = EMPTY_BROWSER_WINDOWS }
}

export function getBrowserWindows(): BrowserWindowsState { load(); return state }

export function subscribeBrowserWindows(fn: () => void): () => void {
  load()
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Apply a pure step and persist what changed (choice to the server, geometry to this device). */
export function updateBrowserWindows(step: (s: BrowserWindowsState, vp: Viewport) => BrowserWindowsState): void {
  load()
  const next = step(state, viewport())
  if (next === state) return
  const prevChoice = JSON.stringify(choiceOf(state))
  state = next
  const nextChoice = choiceOf(next)
  const encoded = JSON.stringify(nextChoice)
  if (encoded !== prevChoice) {
    lastWritten = encoded
    try { choice().set(nextChoice as unknown as Record<string, unknown>) } catch { /* the window still works this session */ }
  }
  try { localStorage.setItem(GEOMETRY_KEY, JSON.stringify(geometryOf(next))) } catch { /* private window */ }
  for (const l of listeners) l()
}

export function useBrowserWindows(): BrowserWindowsState {
  return useSyncExternalStore(subscribeBrowserWindows, getBrowserWindows, () => EMPTY_BROWSER_WINDOWS)
}

export function useBrowserPlace(id: BrowserWindowId): BrowserPlace {
  return placeOf(useBrowserWindows(), id)
}

/** For tests: forget everything (the module keeps one store per page). */
export function resetBrowserWindows(next: BrowserWindowsState = EMPTY_BROWSER_WINDOWS): void {
  state = next
  loaded = true
  lastWritten = null
  for (const l of listeners) l()
}

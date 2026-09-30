/**
 * floatingPanels.ts — a pinned panel becomes a FLOATING WINDOW inside the session area.
 *
 * Owner decision, 2026-09-27: the pin in a panel's header no longer means "keep this overlay open
 * when I click away" (the narrow-overlay pass's reading, `panelSlots.ts`'s own PIN paragraph). It
 * now means ONLY "float this panel": the panel leaves its docked place (the rail's content area or
 * the bottom band — never both, no duplicate) and is drawn as a window over the centre region of
 * the Sessions workspace, draggable by its header, resizable from its edges and corners, and
 * clamped so it can never leave that region. Several can float at once; the one last touched is on
 * top. Pressing the same pin again ("dock back") returns the panel to the slot its PLACEMENT
 * already names — floating never changes placement, so there is nothing to remember about where it
 * came from.
 *
 * TWO HALVES, as everywhere in this directory:
 *
 *  - THE GEOMETRY is pure and total: `clampRect` / `moveRect` / `resizeRect` / `bringToFront` /
 *    `restoreRect` / `defaultRect` take plain numbers and return plain numbers. A rect is stored
 *    RELATIVE TO THE SESSION AREA's own top-left corner, in CSS pixels, and is re-clamped against
 *    the area's CURRENT size every time it is drawn — never rewritten on the way. A window left at
 *    the right edge of a wide screen is therefore pulled back inside on a narrower one, and put back
 *    exactly where it was the day the screen is wide again.
 *
 *  - THE STORE is per SESSION (`sessionIdentityKey`, the one key a session survives a reopen
 *    under) and per BROWSER (`localStorage`, never `/api/preferences`: on a central that file is
 *    shared by everyone signed in, and one person's windows would open on everyone's screen — the
 *    same reason `panelSlots.ts` gives for its own layout). Every read and write is guarded: a
 *    private window, cleared site data or blocked storage costs the memory, never the feature.
 *
 * WHICH SESSION IS "CURRENT" is a module-level fact set by the page that shows one
 * (`setFloatingSession`). It exists so that `panelSlots.usePanelSlots()` — read independently by
 * the page, the bottom band, `ShellBand` and the header — can hand every one of them the SAME
 * layout with the floating panels already taken out of their docked slots. Deciding it in each
 * consumer separately would be four chances for one of them to draw a floating panel twice.
 *
 * DESKTOP ONLY. The page passes `null` on a phone, which floats nothing: there is no session area
 * wide enough for a window there, and the panels stay exactly where they were docked.
 */

import { useSyncExternalStore } from 'react'
import { isPanelId, type PanelId } from './panelSlots'
import { getActivePane, usePaneId, type PaneId } from './paneScope'

// ---------------------------------------------------------------------------------------------
// Geometry — pure.
// ---------------------------------------------------------------------------------------------

export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }

/** The smallest a window may be resized to — enough for a header row and a few lines of content.
 *  Below this a terminal or a list stops being usable, which is the only thing the floor is for. */
export const MIN_FLOAT_SIZE: Size = { w: 280, h: 180 }

/** A floating panel's stored state: where it is, and its place in the stacking order.
 *
 *  `min` — MINIMIZED (owner, 2026-09-29): the window is sent back into the bottom band's tab strip
 *  and drawn nowhere, but its rect and its place in the stack are KEPT, so clicking its tab puts it
 *  back exactly where and at the size it was left. It is still floating (out of every docked slot):
 *  minimizing is not docking. Absent reads as not minimized. */
export interface FloatingWindow extends Rect { z: number; min?: boolean }

export type FloatingSet = Partial<Record<PanelId, FloatingWindow>>

function finite(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback
}

/**
 * KEEP `rect` INSIDE `area`. The size is clamped first — never below `min`, never above the area
 * (except that `min` wins over a tiny area: a window smaller than usable is worse than one that
 * overhangs) — then the position, so the whole window is inside whenever it fits. When it cannot
 * fit, the TOP-LEFT is what stays inside, because the header (the only way to move it) lives there.
 */
export function clampRect(rect: Rect, area: Size, min: Size = MIN_FLOAT_SIZE): Rect {
  const aw = Math.max(0, finite(area.w, 0))
  const ah = Math.max(0, finite(area.h, 0))
  const w = Math.max(min.w, Math.min(finite(rect.w, min.w), aw))
  const h = Math.max(min.h, Math.min(finite(rect.h, min.h), ah))
  const x = Math.min(Math.max(0, finite(rect.x, 0)), Math.max(0, aw - w))
  const y = Math.min(Math.max(0, finite(rect.y, 0)), Math.max(0, ah - h))
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/** Drag by the header: translate, then clamp. */
export function moveRect(start: Rect, dx: number, dy: number, area: Size, min: Size = MIN_FLOAT_SIZE): Rect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, area, min)
}

/** Which edge(s) a resize grip moves. A corner is two edges at once. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const RESIZE_EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/**
 * Resize from `edge` by (`dx`, `dy`) measured from where the drag STARTED (`start`), never
 * accumulated per event — so a pointer that wanders past the floor and back lands exactly where it
 * would have without the detour. The OPPOSITE edge stays put: a west/north grip that hits the
 * minimum size stops moving rather than pushing the window across the area, and neither side may
 * pass the area's own boundary.
 */
export function resizeRect(
  start: Rect, edge: ResizeEdge, dx: number, dy: number, area: Size, min: Size = MIN_FLOAT_SIZE,
): Rect {
  let { x, y, w, h } = start
  const right = start.x + start.w
  const bottom = start.y + start.h
  if (edge.includes('e')) w = Math.min(Math.max(min.w, start.w + dx), Math.max(min.w, area.w - start.x))
  if (edge.includes('s')) h = Math.min(Math.max(min.h, start.h + dy), Math.max(min.h, area.h - start.y))
  if (edge.includes('w')) {
    x = Math.max(0, Math.min(start.x + dx, right - min.w))
    w = right - x
  }
  if (edge.includes('n')) {
    y = Math.max(0, Math.min(start.y + dy, bottom - min.h))
    h = bottom - y
  }
  return clampRect({ x, y, w, h }, area, min)
}

/** The highest `z` in the set, or 0 for an empty one. */
export function topZ(set: FloatingSet): number {
  let z = 0
  for (const win of Object.values(set)) if (win && win.z > z) z = win.z
  return z
}

/** Put `id` on top. A no-op (same object) when it already is, so a click on the front window
 *  writes nothing. */
export function bringToFront(set: FloatingSet, id: PanelId): FloatingSet {
  const win = set[id]
  if (!win) return set
  const top = topZ(set)
  if (win.z === top && Object.values(set).filter(w => w && w.z === top).length === 1) return set
  return { ...set, [id]: { ...win, z: top + 1 } }
}

/** Where a freshly floated window opens: a comfortable size, cascaded by how many are already
 *  floating so two do not open exactly on top of each other. */
export function defaultRect(area: Size, index: number, min: Size = MIN_FLOAT_SIZE): Rect {
  const step = 28 * (index % 8)
  const w = Math.min(560, Math.max(min.w, area.w - 80))
  const h = Math.min(440, Math.max(min.h, area.h - 80))
  return clampRect({ x: 40 + step, y: 32 + step, w, h }, area, min)
}

/** A stored window, re-read for the area as it is NOW. Pure: the stored value is not touched. */
export function restoreRect(win: FloatingWindow, area: Size, min: Size = MIN_FLOAT_SIZE): FloatingWindow {
  return { ...clampRect(win, area, min), z: win.z, ...(win.min ? { min: true } : {}) }
}

/** The panels floating AND ON SCREEN, back-most first — the order to draw them in. A minimized
 *  window is not drawn: its tab in the bottom band is the only thing left of it. */
export function stackOrder(set: FloatingSet): PanelId[] {
  return (Object.keys(set) as PanelId[])
    .filter(id => set[id] !== undefined && !set[id]!.min)
    .sort((a, b) => set[a]!.z - set[b]!.z)
}

/** Float `id` (no-op when it already floats): a default rect on top of everything else. */
export function floatIn(set: FloatingSet, id: PanelId, area: Size): FloatingSet {
  if (set[id]) return bringToFront(set, id)
  const index = Object.keys(set).length
  return { ...set, [id]: { ...defaultRect(area, index), z: topZ(set) + 1 } }
}

/** The floating panels that are MINIMIZED — each one a tab in the bottom band. */
export function minimizedPanels(set: FloatingSet): PanelId[] {
  return (Object.keys(set) as PanelId[]).filter(id => set[id]?.min === true)
}

/** Minimize `id` — kept whole (rect, z) and flagged. No-op when it does not float or already is. */
export function minimizeIn(set: FloatingSet, id: PanelId): FloatingSet {
  const win = set[id]
  if (!win || win.min) return set
  return { ...set, [id]: { ...win, min: true } }
}

/** Bring a minimized `id` back where it was, on top. A window already on screen is only raised. */
export function restoreIn(set: FloatingSet, id: PanelId): FloatingSet {
  const win = set[id]
  if (!win) return set
  if (!win.min) return bringToFront(set, id)
  const { min: _min, ...rest } = win
  return { ...set, [id]: { ...rest, z: topZ(set) + 1 } }
}

/** Dock `id` back (no-op when it does not float). */
export function dockOut(set: FloatingSet, id: PanelId): FloatingSet {
  if (!set[id]) return set
  const next = { ...set }
  delete next[id]
  return next
}

// ---------------------------------------------------------------------------------------------
// Persistence — pure parse, guarded IO.
// ---------------------------------------------------------------------------------------------

const STORAGE_KEY = 'agentistics-floating-panels'
/** How many sessions keep their windows. The oldest-touched are forgotten beyond it, so the value
 *  cannot grow for as long as the browser lives. */
export const MAX_SESSIONS = 200

interface StoredEntry { at: number; windows: FloatingSet }
export interface FloatingBook { v: 1; sessions: Record<string, StoredEntry> }

export const EMPTY_BOOK: FloatingBook = { v: 1, sessions: {} }

function readWindow(v: unknown): FloatingWindow | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const nums = ['x', 'y', 'w', 'h', 'z'].map(k => r[k])
  if (!nums.every(n => typeof n === 'number' && Number.isFinite(n))) return null
  const [x, y, w, h, z] = nums as number[]
  if (w! <= 0 || h! <= 0) return null
  return { x: x!, y: y!, w: w!, h: h!, z: z!, ...(r.min === true ? { min: true } : {}) }
}

/** Parse whatever is in storage. Anything unreadable is dropped entry by entry — one corrupt
 *  window never costs the other sessions theirs. */
export function parseBook(raw: string | null): FloatingBook {
  if (!raw) return EMPTY_BOOK
  let data: unknown
  try { data = JSON.parse(raw) } catch { return EMPTY_BOOK }
  if (typeof data !== 'object' || data === null) return EMPTY_BOOK
  const sessions = (data as Record<string, unknown>).sessions
  if (typeof sessions !== 'object' || sessions === null) return EMPTY_BOOK
  const out: Record<string, StoredEntry> = {}
  for (const [key, entry] of Object.entries(sessions as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const windows: FloatingSet = {}
    if (typeof e.windows === 'object' && e.windows !== null) {
      for (const [id, w] of Object.entries(e.windows as Record<string, unknown>)) {
        if (!isPanelId(id)) continue
        const win = readWindow(w)
        if (win) windows[id] = win
      }
    }
    if (Object.keys(windows).length === 0) continue
    out[key] = { at: typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : 0, windows }
  }
  return { v: 1, sessions: out }
}

/** Record `windows` for `key` at time `now`, forgetting the session entirely when nothing floats
 *  and the least-recently-touched sessions beyond `MAX_SESSIONS`. */
export function writeEntry(book: FloatingBook, key: string, windows: FloatingSet, now: number): FloatingBook {
  const sessions = { ...book.sessions }
  if (Object.keys(windows).length === 0) delete sessions[key]
  else sessions[key] = { at: now, windows }
  const keys = Object.keys(sessions)
  if (keys.length > MAX_SESSIONS) {
    keys.sort((a, b) => sessions[a]!.at - sessions[b]!.at)
    for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) delete sessions[k]
  }
  return { v: 1, sessions }
}

function loadBook(): FloatingBook {
  try { return parseBook(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null) } catch { return EMPTY_BOOK }
}

function saveBook(book: FloatingBook): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(book)) } catch { /* memory only */ }
}

// ---------------------------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------------------------

// Loaded on first use, not at import: `panelSlots.ts` imports this module and this one imports
// `isPanelId` back, so nothing here may run during module evaluation.
let loaded: FloatingBook | null = null
function bookNow(): FloatingBook { return loaded ??= loadBook() }
/** The session whose windows each pane draws right now — `null` on a phone or with nothing selected.
 *  One per pane (`paneScope.ts`): the two sides of a split show two different sessions, and a
 *  session's windows are keyed by that session in the book, so the two never write the same entry. */
const current: Record<PaneId, string | null> = { main: null, split: null }
const EMPTY_SET: FloatingSet = Object.freeze({}) as FloatingSet
const listeners = new Set<() => void>()

function emit(): void { for (const l of listeners) l() }

export function subscribeFloating(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** The session whose windows `pane` draws — `null` on a phone or with nothing selected. */
export function setFloatingSession(key: string | null, pane: PaneId = 'main'): void {
  if (key === current[pane]) return
  current[pane] = key
  emit()
}

/** A pane's CURRENT session's floating windows (a stable object between changes). */
export function getFloating(pane: PaneId = getActivePane()): FloatingSet {
  const key = current[pane]
  if (key === null) return EMPTY_SET
  return bookNow().sessions[key]?.windows ?? EMPTY_SET
}

function commit(windows: FloatingSet, pane: PaneId): void {
  const key = current[pane]
  if (key === null) return
  if (windows === getFloating(pane)) return
  loaded = writeEntry(bookNow(), key, windows, Date.now())
  saveBook(loaded)
  emit()
}

/** The session area as each pane's window layer last measured it — what a newly floated window is
 *  sized for. A pin pressed before the layer has ever measured gets a sensible desktop guess, which
 *  the clamp corrects on the first draw anyway. */
const lastArea: Record<PaneId, Size> = { main: { w: 960, h: 640 }, split: { w: 960, h: 640 } }
export function setFloatingArea(area: Size, pane: PaneId = 'main'): void {
  if (area.w > 0 && area.h > 0) lastArea[pane] = area
}

/** Float `id` in the pane's current session. */
export function floatPanel(id: PanelId, pane: PaneId = getActivePane()): void {
  commit(floatIn(getFloating(pane), id, lastArea[pane]), pane)
}
/** Dock `id` back in the pane's current session. */
export function dockPanel(id: PanelId, pane: PaneId = getActivePane()): void {
  commit(dockOut(getFloating(pane), id), pane)
}
/** Minimize `id` into the bottom band, keeping where and how big it was. */
export function minimizeFloatingPanel(id: PanelId, pane: PaneId = getActivePane()): void {
  commit(minimizeIn(getFloating(pane), id), pane)
}
/** Put a minimized `id` back exactly where it was (or raise it when it is already on screen). */
export function restoreFloatingPanel(id: PanelId, pane: PaneId = getActivePane()): void {
  commit(restoreIn(getFloating(pane), id), pane)
}
/** Raise `id` above every other window of the pane's current session. */
export function raisePanel(id: PanelId, pane: PaneId = getActivePane()): void {
  commit(bringToFront(getFloating(pane), id), pane)
}
/** Store a window's new rect (after a drag or a resize), keeping its place in the stack. */
export function placePanel(id: PanelId, rect: Rect, pane: PaneId = getActivePane()): void {
  const set = getFloating(pane)
  const win = set[id]
  if (!win) return
  if (win.x === rect.x && win.y === rect.y && win.w === rect.w && win.h === rect.h) return
  commit({ ...set, [id]: { ...rect, z: win.z, ...(win.min ? { min: true } : {}) } }, pane)
}
/** Is `id` floating in the pane's current session? */
export function isFloating(id: PanelId, pane: PaneId = getActivePane()): boolean { return getFloating(pane)[id] !== undefined }

/** For tests: forget everything, storage untouched. */
export function resetFloating(): void { loaded = EMPTY_BOOK; current.main = null; current.split = null; emit() }

export function useFloatingPanels(): FloatingSet {
  const pane = usePaneId()
  return useSyncExternalStore(subscribeFloating, () => getFloating(pane), () => EMPTY_SET)
}

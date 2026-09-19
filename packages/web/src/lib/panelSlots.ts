/**
 * panelSlots.ts — the pure model behind where the Studio, Claude Code's own pane and the Shell sit,
 * plus the per-browser store that carries it across the app.
 *
 * THE DEFECT THIS FIXES. The Studio used to be a MODE of `ArtifactsAside` (`studio` state, a `Layer`
 * over the aside's own chrome). Opening it therefore opened the session-contents panel too: the
 * header's contents button lit up beside the Studio button, and the Studio's own bar carried a way
 * back into a panel the reader never asked for. Two components, one open flag.
 *
 * THE MODEL. Four PANELS — `contents` (today's `ArtifactsAside`), `studio`, `cli` (the session's own
 * assistant pane) and `shell` (the per-session utility shell) — and two SLOTS — `right` (the aside
 * box: split / overlay / fullscreen) and `bottom` (the band docked under the composer). A panel sits
 * in AT MOST ONE slot at a time: opening panel P in slot S when P is already in the OTHER slot MOVES
 * it rather than duplicating it, and opening P where panel Q already sits DISPLACES Q — Q simply
 * stops being shown anywhere. `contents` never goes to the bottom: a tabbed list does not fit a band,
 * and nobody asked for it there.
 *
 * WHY A SEPARATE PURE CORE. `openPanel` / `closePanel` / `movePanel` / `allowed` / `resolveForViewport`
 * take a `SlotLayout` explicitly and return a new one — no store, no `localStorage`, no React. That is
 * what makes "every panel × slot × occupant" a table a test can walk exhaustively, and it is what a
 * re-parenting host (`StudioHost.tsx`) can reason about without touching a live subscription.
 *
 * THE STORE, layered on top, is the per-browser preference — like `boardPrefs.ts` / `shellBand.ts`'s
 * own `readBandPrefs`, never `/api/preferences` (shared by everyone signed in on a central). It is
 * guarded exactly like those: a private window, cleared site data or a browser blocking storage costs
 * the memory, never the feature. The panels' CONTENT stays per session — switching session keeps the
 * layout and mounts that session's own Studio / shell in the same slots; nothing here is keyed by
 * session because the layout is a fact about the BROWSER, not about which conversation is open.
 *
 * CLOSING (or DISPLACING) THE STUDIO ASKS FIRST when it holds unsaved buffers — the same question
 * `artifactsStore.closeArtifacts` already asks, through the same `unsavedBuffers.ts`. A MOVE never
 * asks: nothing is dropped by changing which slot shows a panel that stays mounted throughout.
 */

import { createElement, useSyncExternalStore, type ComponentType, type ReactElement } from 'react'
import { holdIfUnsaved } from './unsavedBuffers'

export type PanelId = 'contents' | 'studio' | 'cli' | 'shell' | 'hardware'
export type SlotId = 'right' | 'bottom'

export interface SlotLayout {
  right: PanelId | null
  bottom: PanelId | null
  /** Is the bottom BAND expanded? Independent of which panel occupies it — collapsing never drops
   *  the panel, exactly as collapsing the shell band today never ends the shell. */
  bottomOpen: boolean
  /** Where each panel was last shown, so `openPanel(panel)` with no explicit slot has an answer. */
  lastSlot: Record<PanelId, SlotId>
}

export const PANEL_IDS: readonly PanelId[] = ['contents', 'studio', 'cli', 'shell', 'hardware']

/** Defaults: `contents`/`studio`/`hardware` open on the right; `cli`/`shell` open at the bottom —
 *  matching where each of them has always lived before this feature existed. */
export const DEFAULT_LAST_SLOT: Record<PanelId, SlotId> = {
  contents: 'right', studio: 'right', cli: 'bottom', shell: 'bottom', hardware: 'right',
}

/** What each slot may host — CLOSED sets, so a new panel must be added here on purpose.
 *  `hardware` is RIGHT ONLY — it answers "what is this machine doing right now", which is a
 *  question with no useful shape in a band under the composer, and nobody asked for it there. */
const RIGHT_PANELS: readonly PanelId[] = ['contents', 'studio', 'cli', 'shell', 'hardware']
const BOTTOM_PANELS: readonly PanelId[] = ['cli', 'shell', 'studio']

export const EMPTY_SLOT_LAYOUT: SlotLayout = {
  right: null, bottom: null, bottomOpen: false, lastSlot: { ...DEFAULT_LAST_SLOT },
}

/** May this panel ever sit in this slot? `contents` is the one panel excluded from `bottom` — a
 *  tabbed list was never asked for in a band and does not fit one. */
export function allowed(slot: SlotId, panel: PanelId): boolean {
  return slot === 'right' ? RIGHT_PANELS.includes(panel) : BOTTOM_PANELS.includes(panel)
}

/** The layout with `panel` removed from wherever it sits. A no-op (same values) when it is not
 *  shown anywhere — callers compare against this to detect "nothing changed".
 *
 *  VACATING THE BOTTOM SLOT ALSO CLEARS `bottomOpen` — the same invariant `readLayout` already
 *  enforces on the way IN (`bottomOpen: bottom !== null && r.bottomOpen === true`). Without it,
 *  moving the Studio from the bottom to the right left `{ bottom: null, bottomOpen: true }` sitting
 *  in the live layout (and in storage) until the next full reload silently repaired it. */
function withoutPanel(layout: SlotLayout, panel: PanelId): SlotLayout {
  if (layout.right !== panel && layout.bottom !== panel) return layout
  const bottomCleared = layout.bottom === panel
  return {
    ...layout,
    right: layout.right === panel ? null : layout.right,
    bottom: bottomCleared ? null : layout.bottom,
    bottomOpen: bottomCleared ? false : layout.bottomOpen,
  }
}

/**
 * Put `panel` in `slot` (or in `lastSlot[panel]` when `slot` is omitted).
 *
 * REFUSED, never coerced: an illegal placement (`contents` at the bottom) returns `layout`
 * unchanged — same object, so a caller can tell "nothing happened" by reference. Displacing this
 * slot's current occupant is implicit: that panel simply stops being named by either slot.
 */
export function openPanel(layout: SlotLayout, panel: PanelId, slot?: SlotId): SlotLayout {
  const target = slot ?? layout.lastSlot[panel] ?? DEFAULT_LAST_SLOT[panel]
  if (!allowed(target, panel)) return layout
  const cleared = withoutPanel(layout, panel)
  const placed: SlotLayout = target === 'right'
    ? { ...cleared, right: panel }
    : { ...cleared, bottom: panel, bottomOpen: true }
  return { ...placed, lastSlot: { ...placed.lastSlot, [panel]: target } }
}

/** Remove `panel` from wherever it sits. A no-op (same object) when it was not shown. */
export function closePanel(layout: SlotLayout, panel: PanelId): SlotLayout {
  return withoutPanel(layout, panel)
}

/**
 * Move `panel` to slot `to` — a no-op when it is not currently shown anywhere (there is nothing to
 * move) or already sitting in `to`, refused when `to` cannot host it. Implemented as `openPanel`
 * with an explicit slot: the mechanics of "displace whatever is there, remember the new slot" are
 * identical, and a move is simply an open that happens to keep the panel visible throughout.
 */
export function movePanel(layout: SlotLayout, panel: PanelId, to: SlotId): SlotLayout {
  if (!allowed(to, panel)) return layout
  if (layout.right !== panel && layout.bottom !== panel) return layout
  if ((to === 'right' && layout.right === panel) || (to === 'bottom' && layout.bottom === panel)) return layout
  return openPanel(layout, panel, to)
}

/** Is this panel shown in EITHER slot right now? True for a panel sitting in a COLLAPSED bottom
 *  band too — collapsing hides the screen, not the fact that the panel is still there. */
export function isPanelShown(layout: SlotLayout, panel: PanelId): boolean {
  return layout.right === panel || layout.bottom === panel
}

/**
 * WHAT THE RIGHT SLOT IS ACTUALLY SHOWING — the one selector every "is this pressed" reading must
 * go through, rather than each caller comparing `layout.right` against `artifactsStore`'s own `open`
 * flag its own way. That duplication is exactly what C2 found: the header's Contents button read
 * `artifacts.open` on its own, so with `cli`/`shell` holding the slot its `aria-pressed` toggled
 * while the screen kept showing the terminal, unmoved.
 *
 * `contents` carries no field of its own in `SlotLayout` — see this module's header on why — so the
 * slot's own occupant (`layout.right`) always wins when there is one; `contentsOpen` (the store's
 * `open` flag) only decides the answer when nothing else occupies the slot.
 */
export function rightSlotShowing(layout: SlotLayout, contentsOpen: boolean): PanelId | null {
  return layout.right ?? (contentsOpen ? 'contents' : null)
}

/**
 * MAY THE DOCKED BAND ACTUALLY SHOW THIS `cli`/`shell` TARGET RIGHT NOW, or has the RIGHT slot
 * already claimed it?
 *
 * The docked `ShellBand` keeps its own independent `cli`/`shell` preference (`shellBand.ts`'s own
 * `target`, picked through its segmented control) — it is never written through `openPanel`, so
 * nothing enforced this file's own "a panel sits in at most one slot at a time" for it (C3): nothing
 * stopped the docked band going on streaming — and capturing — the very pane the right slot had just
 * taken, and moving that pane to the right before it was ever explicitly picked in the docked band
 * left `layout.bottom` unset, so the move itself silently did nothing.
 *
 * Applied on the READ side, exactly like `resolveForGates`/`resolveForViewport` — never written back
 * to storage or to the docked band's own stored preference, so moving the panel away from the right
 * later hands the docked band back its target without the reader having to re-pick it.
 */
export function dockedShowsTarget(layout: SlotLayout, target: 'cli' | 'shell'): boolean {
  return layout.right !== target
}

/** Expand or collapse the bottom band without touching which panel occupies it. */
export function setBottomOpen(layout: SlotLayout, open: boolean): SlotLayout {
  return layout.bottomOpen === open ? layout : { ...layout, bottomOpen: open }
}

/**
 * The layout as a PHONE reads it. A phone has no bottom slot and no side-by-side (`dockedAllowed`
 * in `terminalSurface.ts` already says the band cannot exist below the breakpoint), so a stored
 * `bottom: 'studio'` is read as the fullscreen right sheet instead — WITHOUT rewriting storage, so
 * turning the phone back into a desktop restores the layout exactly as it was left.
 */
export function resolveForViewport(layout: SlotLayout, isMobile: boolean): SlotLayout {
  if (!isMobile || layout.bottom !== 'studio') return layout
  return { ...layout, right: 'studio', bottom: null }
}

/**
 * The three server-decided facts that close a panel outright rather than merely greying its entry
 * (design §1.5's "every switcher entry is ABSENT when its gate is closed"): whether this machine
 * serves the repository explorer at all, whether it serves the per-session shell, and whether this
 * session is reached through a central's relay (which has no `cli`/`shell` stream of its own — the
 * whole `/api/fleet` prefix is refused there).
 */
export interface PanelGates {
  editorEnabled: boolean
  shellEnabled: boolean
  relayed: boolean
}

/** May this panel ever be shown, given what the server/session actually allows right now? */
function gateOpen(panel: PanelId, gates: PanelGates): boolean {
  if (panel === 'studio') return gates.editorEnabled
  if (panel === 'cli') return !gates.relayed
  if (panel === 'shell') return gates.shellEnabled && !gates.relayed
  return true // `contents` and `hardware` have no server gate of their own.
}

/**
 * THE LAYOUT AS THE GATES ACTUALLY ALLOW IT — read-time, exactly like `resolveForViewport`, and
 * NEVER written back to storage. A stored `right: 'studio'` from a browser where the repository
 * explorer was once on must not render an empty, unclosable pane the moment `editorEnabled` turns
 * off (a preference change, a different session, a machine reached through a central): the panel
 * is read as simply absent from wherever it sat, exactly as if it had never been opened, so the
 * slot falls back to showing whatever else belongs there (`contents`, on the right).
 *
 * Applied on every read alongside `resolveForViewport` — never only in one caller — or the same
 * stale-storage shape reopens on the next surface that reads `panelSlots` without the gate.
 */
export function resolveForGates(layout: SlotLayout, gates: PanelGates): SlotLayout {
  let next = layout
  for (const panel of PANEL_IDS) {
    if (!gateOpen(panel, gates) && isPanelShown(next, panel)) next = closePanel(next, panel)
  }
  return next
}

// ---------------------------------------------------------------------------------------------
// The store — a per-browser preference, guarded like `shellBand.ts`'s `readBandPrefs`.
// ---------------------------------------------------------------------------------------------

const STORAGE_KEY = 'agentistics-panel-slots'

function isPanelId(v: unknown): v is PanelId {
  return v === 'contents' || v === 'studio' || v === 'cli' || v === 'shell'
}

function readLastSlot(v: unknown): Record<PanelId, SlotId> {
  const out: Record<PanelId, SlotId> = { ...DEFAULT_LAST_SLOT }
  if (typeof v !== 'object' || v === null) return out
  const r = v as Record<string, unknown>
  for (const panel of PANEL_IDS) {
    const s = r[panel]
    if ((s === 'right' || s === 'bottom') && allowed(s, panel)) out[panel] = s
  }
  return out
}

/** Read the persisted layout. Exported (like `shellBand.ts`'s `readBandPrefs`) so the storage
 *  guard is directly testable with an injected `Storage`. */
export function readLayout(storage?: Storage): SlotLayout {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_SLOT_LAYOUT
    const v = JSON.parse(raw) as unknown
    if (typeof v !== 'object' || v === null) return EMPTY_SLOT_LAYOUT
    const r = v as Record<string, unknown>
    const right = isPanelId(r.right) && allowed('right', r.right) ? r.right : null
    const bottom = isPanelId(r.bottom) && allowed('bottom', r.bottom) ? r.bottom : null
    return {
      right, bottom,
      bottomOpen: bottom !== null && r.bottomOpen === true,
      lastSlot: readLastSlot(r.lastSlot),
    }
  } catch {
    return EMPTY_SLOT_LAYOUT
  }
}

function writeLayout(layout: SlotLayout, storage?: Storage): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(STORAGE_KEY, JSON.stringify(layout))
  } catch { /* the memory is a convenience; the panels still work without it */ }
}

let state: SlotLayout = readLayout()
const listeners = new Set<() => void>()

function commit(next: SlotLayout): void {
  if (next === state) return
  state = next
  writeLayout(state)
  for (const l of listeners) l()
}

export function getPanelLayout(): SlotLayout {
  return state
}

export function subscribePanelLayout(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/**
 * Open a panel imperatively — the one non-React callers (`artifactsStore.ts`'s compatibility shim)
 * reach for. DISPLACING the Studio out of every slot asks first, exactly as closing it does; MOVING
 * it (it stays shown, just in the other slot) never does, because `isPanelShown` reads `true` on
 * both sides of a move.
 */
export function showPanel(panel: PanelId, slot?: SlotId): void {
  const next = openPanel(state, panel, slot)
  if (next === state) return
  const studioDisplaced = panel !== 'studio'
    && isPanelShown(state, 'studio') && !isPanelShown(next, 'studio')
  if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return
  commit(next)
}

/**
 * Close a panel imperatively. Closing the Studio itself asks first when it is dirty.
 *
 * `after`, when given, runs once the panel is ACTUALLY gone — immediately if there was nothing to
 * ask about (including "it was not shown at all"), or once the reader discards. It never runs on
 * "keep editing". This is what lets a caller displace the Studio and then do something of its own
 * (`artifactsStore.openArtifacts` opening Contents in the slot the Studio just vacated) without
 * asking twice or opening behind a Studio the reader chose to keep.
 */
export function hidePanel(panel: PanelId, after?: () => void): void {
  const next = closePanel(state, panel)
  if (next === state) { after?.(); return }
  if (panel === 'studio' && holdIfUnsaved('close', () => { commit(next); after?.() })) return
  commit(next)
  after?.()
}

/** Move a panel to the other slot imperatively. Never asks — see `movePanel`. */
export function relocatePanel(panel: PanelId, to: SlotId): void {
  commit(movePanel(state, panel, to))
}

export function setBandOpen(open: boolean): void {
  commit(setBottomOpen(state, open))
}

/** For tests: forget everything. */
export function resetPanelSlots(): void {
  state = EMPTY_SLOT_LAYOUT
  for (const l of listeners) l()
}

export interface PanelSlotsApi {
  layout: SlotLayout
  openPanel: (panel: PanelId, slot?: SlotId) => void
  closePanel: (panel: PanelId) => void
  movePanel: (panel: PanelId, to: SlotId) => void
  setBottomOpen: (open: boolean) => void
}

/** The one hook every slot-aware component reads. Bound actions carry the same names as the pure
 *  functions above — they are methods on the returned object, so there is no export collision. */
export function usePanelSlots(): PanelSlotsApi {
  const layout = useSyncExternalStore(subscribePanelLayout, getPanelLayout, () => EMPTY_SLOT_LAYOUT)
  return {
    layout,
    openPanel: showPanel,
    closePanel: hidePanel,
    movePanel: relocatePanel,
    setBottomOpen: setBandOpen,
  }
}

/**
 * MOUNTS `Component` AT MOST ONCE, WITH NO `key` OF ITS OWN, wherever `shown` is true — the exact
 * shape §1.4's guarantee depends on. React identifies an element by (type, key, position in its
 * parent's children); `createElement(Component, props)` here never reads a `key` out of `props`
 * because none of this module's own callers ever put one there, so a caller that renders THIS
 * function's result at a stable position in its own tree cannot, by construction, force React to
 * remount it on a re-render — which is precisely what broke when a reviewer added
 * `key={rightIsStudio ? 'right' : 'bottom'}` directly on `<StudioHost>` in `SessionsPage.tsx`: a
 * `key` that changes with the very state a move updates is a key that changes on every move.
 *
 * `SessionsPage.tsx` calls this at the Studio's ONE mount site instead of writing `shown && (<Studio
 * Host .../>)` by hand, so `panelSlots.mountPanel.test.ts` can assert the guarantee against REAL
 * `React.ReactElement` objects (`.key`, `.type` — `React.isValidElement`) rather than against the
 * page's source text, which is what `sessionsPage.lint.test.ts`'s own I4 block already does and
 * could not, on its own, see past a comment or a rename (see that file's own header on why a
 * DOM-level test is not available here at all: there is no jsdom in this repo's test runner).
 */
export function mountPanel<P extends object>(
  shown: boolean, Component: ComponentType<P>, props: P,
): ReactElement<P> | null {
  return shown ? createElement(Component, props) : null
}

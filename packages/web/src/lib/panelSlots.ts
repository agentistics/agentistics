/**
 * panelSlots.ts — the pure model behind every panel in the sessions workspace: the icon RAIL on the
 * right, the tab strip docked at the BOTTOM, and the per-browser store that carries the layout
 * across the app.
 *
 * THE MODEL, AS OF THE RIGHT-ICON-RAIL PASS (2026-09-21, `sdd/scratch/right-rail-spec.md`).
 * `contents` stopped existing as a container: its ten former tabs (`live`, `gallery`, `skills`,
 * `agents`, `forks`, `workflows`, `mcps`, `prs`, `tasks`, `metrics`) are each their own `PanelId`
 * now, exactly like `studio`/`cli`/`shell`/`hardware` already were. FOURTEEN panels in total.
 *
 * Every panel carries a `Placement` — `'rail'` (an icon on the right rail), `'bottom'` (a tab in the
 * bottom band) or `'hidden'` (reachable from neither) — plus an `order` within that placement. This
 * is new: before this pass, "which slot a panel reaches" and "which panel currently occupies a slot"
 * were the SAME fact (a panel sat in AT MOST one of two slots, one occupant each). They are now two
 * different questions. PLACEMENT answers "where does this panel's icon/tab live" and is a per-browser
 * PREFERENCE, changed by the gear's move verbs (this pass), drag, or the hide/restore verbs (a later
 * pass). OCCUPANCY answers "which panel is the content area / the bottom band showing RIGHT NOW" —
 * `right`/`bottom` on `SlotLayout`, exactly as before — and only a panel whose placement allows it
 * (rail → the right content area, bottom → the bottom band) can ever be the occupant of that slot.
 *
 * WHY THIS SPLIT MATTERS: the rail can hold many icons at once (the default has twelve), so
 * "placement" cannot be an occupancy fact the way the old two-slot model had it — only ONE of those
 * twelve is ever actually showing in the content area at a time, which is what `right`/`bottom`
 * still track. A panel whose placement is `'hidden'` has no icon and no tab anywhere, so it cannot be
 * an occupant either — `openPanel` refuses it exactly as the old model refused a panel `allowed()`
 * said could not reach a slot.
 *
 * `restoreTo` remembers where a HIDDEN panel used to live (`'rail'` or `'bottom'`, never `'hidden'`
 * itself) so the eye's "put it back" verb (a later pass) has an answer — the direct descendant of the
 * old model's `lastSlot`, narrowed to the one case that still needs remembering: a panel that is
 * currently placed (rail or bottom) already states its own placement, so there is nothing left for
 * `restoreTo` to answer for it that `placement` does not already say.
 *
 * EVERY PANEL REACHES EVERY PLACEMENT, continuing the decision recorded here before this pass (see
 * the previous revision's own note on `BOTTOM_PANELS`): `allowed()` stays the one gate every caller
 * asks rather than assuming the answer, so a panel added later that genuinely cannot reach one
 * placement has one place to say so.
 *
 * WHY A SEPARATE PURE CORE. `openPanel` / `closePanel` / `movePanel` / `setPlacement` /
 * `resolveForViewport` take a `SlotLayout` explicitly and return a new one — no store, no
 * `localStorage`, no React. That is what makes "every panel × placement × slot" a table a test can
 * walk exhaustively.
 *
 * THE STORE, layered on top, keeps TWO halves apart (2026-10-01). Where each panel is docked, its
 * order, its pin and what is open are a person's CHOICES and live on the server (`/api/user-prefs`,
 * `panelSlots`, one record per pane), so the layout reads the same from every device — per ACCOUNT
 * on a central, never the shared machine file. The rail's WIDTH depends on the screen and stays per
 * browser: a phone and a desktop must not fight over one value. The browser copy (`localStorage`,
 * key `agentistics-panel-slots` — UNCHANGED, so an existing layout is still found; the first paint
 * plus the width) is guarded exactly like `shellBand.ts`'s own `readBandPrefs`: a private window,
 * cleared site data or a browser blocking storage costs the memory, never the feature.
 *
 * MIGRATION. A value written by the OLD model (no `placement` field, a bare `right`/`bottom` id from
 * the five-id domain, `'contents'` among them) is detected and converted: whatever occupied `bottom`
 * there STAYS at the bottom (`studio`/`cli`/`shell`/`hardware`); `'contents'`, wherever it was, is
 * replaced by its ten descendants, all placed on the RAIL — the spec's own words, and deliberately
 * NOT "wherever contents was" pins the descendants: a `contents` that was docked at the bottom does
 * not imply the reader wanted ten tabs squeezed into a band which never held more than one occupant
 * before. An unreadable value, or one from a version this build does not recognise, falls back to the
 * plain defaults — never throws, never a half-applied layout.
 *
 * CLOSING (or DISPLACING) THE STUDIO ASKS FIRST when it holds unsaved buffers — the same question
 * `artifactsStore.closeArtifacts` already asks, through the same `unsavedBuffers.ts`. A MOVE never
 * asks: nothing is dropped by changing which slot shows a panel that stays mounted throughout.
 *
 * PIN (narrow-overlay pass, 2026-09-22, `sdd/scratch/right-rail-spec.md` §11). Below `SPLIT_MIN_
 * WIDTH` a right-slot panel opens OVERLAID rather than split, and an unpinned one minimizes the
 * moment the reader clicks outside it or switches to another panel — a temporary surface by
 * design. `pinned: Record<PanelId, boolean>` is the per-panel escape from that: while pinned, a
 * click outside (or Esc) leaves the panel exactly where it is. It is a RAIL-ONLY fact — the bottom
 * band's own minimize/collapse behaviour is untouched by this field, and nothing here is ever read
 * for a bottom-placed panel. PIN BELONGS TO THE PANEL WHILE IT LIVES ON THE RAIL, NOT A PROPERTY
 * THAT TRAVELS: `setPlacement` clears it the moment a panel LEAVES the rail (moved to the bottom,
 * or hidden), and moving it back does not restore the flag — the owner's own words, "uma barra
 * pinada que foi movida pra baixo reseta o estado dela, inclusive se o usuario voltar ela pra
 * direita ela n esta mais pinned." Absent (an older stored value) reads as NOT pinned, same
 * convention as every other field this store persists.
 */

import { createSharedPref, type SharedPrefStore } from './sharedPref'
import { reorderByDrag } from './dragReorder'
import { clampRailWidth, RAIL_WIDTH_FLOOR_PX } from './railFit'
import { createElement, useSyncExternalStore, type ComponentType, type ReactElement } from 'react'
import { holdIfUnsaved } from './unsavedBuffers'
import { getFloating, dockPanel, restoreFloatingPanel, subscribeFloating, type FloatingSet } from './floatingPanels'
import { getActivePane, paneStorageKey, usePaneId, type PaneId } from './paneScope'

/** The ten panels ArtifactsAside used to render as tabs inside one `contents` container. */
export type TabPanelId =
  | 'search' | 'live' | 'gallery' | 'skills' | 'agents' | 'forks' | 'workflows' | 'mcps' | 'prs' | 'tasks'
  | 'metrics'

export type PanelId = TabPanelId | 'studio' | 'cli' | 'shell' | 'hardware'

/** In the READING ORDER the rail and the bottom bar fall back to for a panel neither has ever
 *  explicitly ordered — the same order `ArtifactsAside`'s own tab strip used to draw its tabs in,
 *  with `studio`/`hardware` (formerly right-slot-only) and `cli`/`shell` (formerly the bottom's
 *  default occupants) appended after them. */
export const PANEL_IDS: readonly PanelId[] = [
  'search', 'live', 'gallery', 'skills', 'agents', 'forks', 'workflows', 'mcps', 'prs', 'tasks', 'metrics',
  'studio', 'hardware', 'cli', 'shell',
]

export function isTabPanelId(v: unknown): v is TabPanelId {
  return v === 'search' || v === 'live' || v === 'gallery' || v === 'skills' || v === 'agents' || v === 'forks'
    || v === 'workflows' || v === 'mcps' || v === 'prs' || v === 'tasks' || v === 'metrics'
}

export function isPanelId(v: unknown): v is PanelId {
  return isTabPanelId(v) || v === 'studio' || v === 'cli' || v === 'shell' || v === 'hardware'
}

/** Where a panel's ICON/TAB lives. `'hidden'`: reachable from neither the rail nor the bottom band —
 *  design item §5, wired here so the model already carries it, though this pass draws no eye/verb
 *  for it yet. */
export type Placement = 'rail' | 'bottom' | 'hidden'

/** The two placements a panel can actually be OPENED into — `'hidden'` has no icon or tab to click,
 *  so `openPanel` refuses a panel sitting there rather than picking a placement for it. */
export type OpenPlacement = 'rail' | 'bottom'

/** Where a panel's CONTENT is currently shown — the right content area (left of the rail) or the
 *  bottom band. Kept as its own name distinct from `Placement`: a panel placed on the rail is not
 *  necessarily the one the content area is showing right now (eleven others could share that rail),
 *  while at most one bottom-placed panel is ever the bottom band's own active tab. */
export type SlotId = 'right' | 'bottom'

/** Defaults (spec §1): `cli`/`shell` at the bottom, everything else on the rail, nothing hidden —
 *  matching where the terminal panes have always lived and giving every other panel a rail icon. */
export const DEFAULT_PLACEMENT: Record<PanelId, Placement> = {
  search: 'rail', live: 'rail', gallery: 'rail', skills: 'rail', agents: 'rail', forks: 'rail', workflows: 'rail',
  mcps: 'rail', prs: 'rail', tasks: 'rail', metrics: 'rail', studio: 'rail', hardware: 'rail',
  cli: 'bottom', shell: 'bottom',
}

function defaultOrder(): Record<PanelId, number> {
  const out = {} as Record<PanelId, number>
  PANEL_IDS.forEach((id, i) => { out[id] = i })
  return out
}

/** Nothing is pinned on a fresh layout — see this module's own header on PIN. */
function defaultPinned(): Record<PanelId, boolean> {
  const out = {} as Record<PanelId, boolean>
  for (const id of PANEL_IDS) out[id] = false
  return out
}

/** Where a HIDDEN panel restores to — meaningless for a panel that is not hidden (its own
 *  `placement` already answers "rail" or "bottom" for it), so this always mirrors `DEFAULT_PLACEMENT`
 *  for a fresh layout and is updated only by `setPlacement`'s own hide branch. */
function defaultRestoreTo(): Record<PanelId, OpenPlacement> {
  const out = {} as Record<PanelId, OpenPlacement>
  for (const id of PANEL_IDS) out[id] = DEFAULT_PLACEMENT[id] === 'bottom' ? 'bottom' : 'rail'
  return out
}

export interface SlotLayout {
  placement: Record<PanelId, Placement>
  /** Order within a placement — ascending, ties broken by `PANEL_IDS`'s own order (never truly tied
   *  in practice; `setPlacement` always assigns a fresh, strictly increasing value). */
  order: Record<PanelId, number>
  /** See this module's own header — where a hidden panel goes back to. */
  restoreTo: Record<PanelId, OpenPlacement>
  /** See this module's own header on PIN (narrow-overlay pass, 2026-09-22) — RAIL-only, cleared the
   *  moment a panel leaves the rail. */
  pinned: Record<PanelId, boolean>
  /** Which panel the content area (left of the rail) is currently showing. `null` = nothing open. */
  right: PanelId | null
  /** Which panel the bottom band is currently showing as its active tab. `null` = nothing open. */
  bottom: PanelId | null
  /** Is the bottom BAND expanded? Independent of which panel occupies it. */
  bottomOpen: boolean
  /** Is the RIGHT SLOT'S OWN CONTENT visible right now? Independent of which panel occupies it.
   *  Defaults to `true` — see the pre-rail revision of this file for the full reasoning (the Studio's
   *  own park-not-unmount minimize reads this; every other panel closes outright on minimize instead
   *  and never sees it turn `false`). */
  rightOpen: boolean
  /** THE RAIL'S OWN WIDTH, in pixels (owner, 2026-09-21) — clamped to `[RAIL_WIDTH_FLOOR_PX,
   *  RAIL_WIDTH_CEILING_PX]` (`lib/railFit.ts`) by every writer, so a reader never has to re-check
   *  it. Persisted in this SAME record (`agentistics-panel-slots`) rather than a separate key,
   *  because it is exactly as much "how this reader's rail looks" as placement/order already are. */
  railWidth: number
  /** THE PANELS FLOATING AS WINDOWS in the session on screen (`floatingPanels.ts`) — a READ-TIME
   *  fact, applied by `applyFloating` and NEVER persisted here (floating is per session, this record
   *  is per browser). A floating panel is out of every list below and occupies no slot: it has left
   *  its docked place, and drawing it there as well would be the duplicate the owner ruled out. */
  floating?: readonly PanelId[]
}

export const EMPTY_SLOT_LAYOUT: SlotLayout = {
  placement: { ...DEFAULT_PLACEMENT },
  order: defaultOrder(),
  restoreTo: defaultRestoreTo(),
  pinned: defaultPinned(),
  right: null, bottom: null, bottomOpen: false, rightOpen: true,
  railWidth: RAIL_WIDTH_FLOOR_PX,
}

/** May this panel ever sit in this placement? As of this pass every panel reaches every placement —
 *  see this module's own header — this stays the one gate every caller asks rather than assuming
 *  "yes", so a panel added later that genuinely cannot reach one placement has one place to say so. */
export function allowed(_placement: Placement, _panel: PanelId): boolean {
  return true
}

/** The panels currently placed on the rail, in order. */
export function railPanels(layout: SlotLayout): PanelId[] {
  return PANEL_IDS.filter(id => layout.placement[id] === 'rail' && !layout.floating?.includes(id))
    .sort((a, b) => layout.order[a] - layout.order[b])
}

/** The panels currently placed at the bottom, in order. */
export function bottomPanels(layout: SlotLayout): PanelId[] {
  return PANEL_IDS.filter(id => layout.placement[id] === 'bottom' && !layout.floating?.includes(id))
    .sort((a, b) => layout.order[a] - layout.order[b])
}

/** The panels currently hidden — reachable from neither the rail nor the bottom band. */
export function hiddenPanels(layout: SlotLayout): PanelId[] {
  return PANEL_IDS.filter(id => layout.placement[id] === 'hidden' && !layout.floating?.includes(id))
    .sort((a, b) => layout.order[a] - layout.order[b])
}

/** The layout with `panel` removed from wherever it is the ACTIVE occupant — placement untouched.
 *  A no-op (same object) when it is not the occupant of either slot. */
function withoutOccupant(layout: SlotLayout, panel: PanelId): SlotLayout {
  if (layout.right !== panel && layout.bottom !== panel) return layout
  const bottomCleared = layout.bottom === panel
  const rightCleared = layout.right === panel
  return {
    ...layout,
    right: rightCleared ? null : layout.right,
    rightOpen: rightCleared ? true : layout.rightOpen,
    bottom: bottomCleared ? null : layout.bottom,
    bottomOpen: bottomCleared ? false : layout.bottomOpen,
  }
}

/**
 * Put `panel` in the slot its OWN placement maps to (`'rail'` → the right content area, `'bottom'`
 * → the bottom band) — REFUSED, never coerced, when the panel is currently `'hidden'` (there is no
 * icon or tab to have clicked). Displacing this slot's current occupant is implicit: that panel
 * simply stops being the active occupant, its own placement untouched.
 */
export function openPanel(layout: SlotLayout, panel: PanelId): SlotLayout {
  const placement = layout.placement[panel]
  if (placement === 'hidden') return layout
  const cleared = withoutOccupant(layout, panel)
  return placement === 'rail'
    ? { ...cleared, right: panel, rightOpen: true }
    : { ...cleared, bottom: panel, bottomOpen: true }
}

/** Remove `panel` from wherever it is the active occupant. A no-op (same object) when it was not
 *  shown — placement untouched, exactly like the old model's `closePanel`. */
export function closePanel(layout: SlotLayout, panel: PanelId): SlotLayout {
  return withoutOccupant(layout, panel)
}

/** Is this panel the ACTIVE occupant of either slot right now? True for one sitting in a COLLAPSED
 *  bottom band too — collapsing hides the screen, not the fact that the panel is still there. */
export function isPanelShown(layout: SlotLayout, panel: PanelId): boolean {
  return layout.right === panel || layout.bottom === panel
}

/** WHAT THE RIGHT SLOT IS ACTUALLY SHOWING — the one selector every "is this pressed" reading goes
 *  through. `contents` carried no field of its own in the old model; every panel now does, so this
 *  is a plain read, kept as a named function so callers do not have to know that. */
export function rightSlotShowing(layout: SlotLayout): PanelId | null {
  return layout.right
}

/**
 * MAY THE DOCKED BAND ACTUALLY SHOW THIS `cli`/`shell` TARGET RIGHT NOW, or has the RAIL's own
 * content area already claimed it?
 *
 * `ShellBand`'s docked branch keeps its own independent `cli`/`shell` preference (`shellBand.ts`'s
 * own `target`, picked through its segmented control) — it is never written through `openPanel`
 * except on an explicit tab click, so nothing else enforces this module's own "a panel is the active
 * occupant of at most one slot" for it. Applied on the READ side only, never written back.
 */
export function dockedShowsTarget(layout: SlotLayout, target: 'cli' | 'shell'): boolean {
  return layout.right !== target && !layout.floating?.includes(target)
}

/**
 * THE LAYOUT WITH `floating` TAKEN OUT OF THEIR DOCKED PLACES — read-time only, like
 * `resolveForViewport`. Each floating panel stops being the occupant of whichever slot it held (a
 * bottom band whose occupant floated away collapses, exactly as closing it would), and is dropped
 * from `railPanels`/`bottomPanels`/`hiddenPanels` through the `floating` field. Placement is
 * untouched, which is what makes docking back a matter of removing the id: the panel returns to
 * the slot its placement already names. Same object back when nothing floats.
 */
export function applyFloating(layout: SlotLayout, floating: readonly PanelId[]): SlotLayout {
  if (floating.length === 0) {
    if (layout.floating === undefined) return layout
    const { floating: _gone, ...rest } = layout
    return rest
  }
  let next: SlotLayout = { ...layout, floating }
  for (const id of floating) next = withoutOccupant(next, id)
  return next
}

/** Expand or collapse the bottom band without touching which panel occupies it. */
export function setBottomOpen(layout: SlotLayout, open: boolean): SlotLayout {
  return layout.bottomOpen === open ? layout : { ...layout, bottomOpen: open }
}

/** Minimize or restore the right slot's own content without touching which panel occupies it. */
export function setRightOpen(layout: SlotLayout, open: boolean): SlotLayout {
  return layout.rightOpen === open ? layout : { ...layout, rightOpen: open }
}

/**
 * MOVE `panel` TO `to` ('rail' or 'bottom') — the gear's own verb (spec §3), the icon's own
 * right-click "Mover", and the drag's cross-bar case (`planPanelDrop`, below) all route through this
 * ONE function, which is what lets this rule live in exactly one place instead of three that could
 * disagree.
 *
 * A MOVE CARRIES THE PANEL'S OPEN STATE — IT NEVER CREATES ONE (owner, 2026-09-21, replacing this
 * function's own former "a move is simply an open that happens to keep the panel visible
 * throughout"): moving a panel that was NOT currently shown just relocates its icon/tab and leaves
 * it closed, touching neither slot's occupant — reported live as the annoyance this replaces, where
 * moving ANY panel (including ones never opened) silently seized the destination away from whatever
 * a reader was actually looking at. Moving a panel that WAS shown reopens it at the destination, and
 * — for free, not as a second rule — MINIMIZES wherever it left: `openPanel` clears the OLD slot's
 * occupancy through `withoutOccupant` before assigning the new one, and clearing a slot's occupant
 * is already exactly what collapses the bottom band (`bottomOpen: false`) or empties the right slot.
 * A slot whose occupant was NOT the panel being moved is untouched either way, since nothing here
 * ever calls `withoutOccupant` for a panel that provably is not occupying anything.
 *
 * `restoreTo` is refreshed to the new placement regardless (inside `setPlacement`), so a LATER
 * hide-then-restore puts it back where this move actually left it, not where it was before —
 * unaffected by whether the move itself opened anything.
 *
 * `pinned` is CLEARED, also inside `setPlacement`, whenever this move takes the panel OFF the rail
 * — never restored by a later move back onto it (spec §11 item 5). See this module's own header on
 * PIN.
 */
export function movePanel(layout: SlotLayout, panel: PanelId, to: OpenPlacement): SlotLayout {
  const placed = setPlacement(layout, panel, to)
  return isPanelShown(layout, panel) ? openPanel(placed, panel) : placed
}

/**
 * THE ONE PRIMITIVE THAT CHANGES A PANEL'S PLACEMENT — rail/bottom/hidden, plus `order` (appended to
 * the end of the target placement's own list, so a panel just moved there sorts last, matching where
 * a person would expect something they just dropped to land — reordering within a placement, drag's
 * own job, is a separate later pass). Never touches which panel is the ACTIVE occupant of either
 * slot on its own — `movePanel` layers that on top for the gear's verbs; hiding a panel that IS the
 * active occupant of a slot removes it from there too, since a hidden panel can have no icon or tab
 * a reader could have clicked to see it.
 *
 * HIDING remembers `restoreTo` from the panel's OWN placement the moment BEFORE this call — never
 * from `to` (which is `'hidden'` itself) — so the eye's later "put it back" verb has an answer. A
 * panel that was ALREADY hidden keeps its existing `restoreTo` untouched (there is nothing new to
 * remember: it was not showing anywhere a moment ago either).
 */
export function setPlacement(layout: SlotLayout, panel: PanelId, to: Placement): SlotLayout {
  if (layout.placement[panel] === to) return layout
  if (!allowed(to, panel)) return layout
  const nextOrder = 1 + Math.max(0, ...PANEL_IDS.map(id => layout.order[id]))
  // Placed (rail/bottom): restoreTo mirrors the new placement — there is nothing else it could mean
  // for a panel that is visibly sitting there right now. Hidden: restoreTo remembers wherever the
  // panel was placed the moment BEFORE this call (never "hidden" itself), unless it was ALREADY
  // hidden, in which case there is nothing new to remember.
  const restoreTo: Record<PanelId, OpenPlacement> = to !== 'hidden'
    ? { ...layout.restoreTo, [panel]: to }
    : layout.placement[panel] !== 'hidden'
      ? { ...layout.restoreTo, [panel]: layout.placement[panel] as OpenPlacement }
      : layout.restoreTo
  // PIN IS CLEARED THE MOMENT A PANEL LEAVES THE RAIL — see this module's own header on PIN. Only a
  // panel that WAS on the rail can have anything to clear; `layout.pinned[panel]` is spread through
  // untouched otherwise, so a panel that was never on the rail (or is moving BETWEEN rail and rail,
  // impossible here since `to === layout.placement[panel]` already returned above) is unaffected.
  const pinned = layout.placement[panel] === 'rail' && to !== 'rail'
    ? { ...layout.pinned, [panel]: false }
    : layout.pinned
  const withPlacement: SlotLayout = {
    ...layout,
    placement: { ...layout.placement, [panel]: to },
    order: { ...layout.order, [panel]: nextOrder },
    restoreTo,
    pinned,
  }
  // A panel hidden while it was the active occupant of a slot has nothing left to occupy — there is
  // no icon or tab a reader could use to bring its content back into view.
  return to === 'hidden' ? withoutOccupant(withPlacement, panel) : withPlacement
}

/** The hide verb (design §5, wired for a later pass): `setPlacement(layout, panel, 'hidden')` by
 *  another name, kept here so a caller never has to remember the raw placement string. */
export function hidePanelPlacement(layout: SlotLayout, panel: PanelId): SlotLayout {
  return setPlacement(layout, panel, 'hidden')
}

/** The eye's "put it back where it was" verb (design §5, wired for a later pass): restores a hidden
 *  panel to its remembered `restoreTo` placement, WITHOUT opening it — restoring visibility is a
 *  separate question from restoring reachability, and the eye's own tile does not claim to answer
 *  both. A no-op when the panel is not currently hidden. */
export function restorePanelPlacement(layout: SlotLayout, panel: PanelId): SlotLayout {
  if (layout.placement[panel] !== 'hidden') return layout
  return setPlacement(layout, panel, layout.restoreTo[panel])
}

/** Is this panel pinned right now? See this module's own header on PIN. */
export function isPanelPinned(layout: SlotLayout, panel: PanelId): boolean {
  return layout.pinned[panel] === true
}

/**
 * Set a panel's pinned flag directly — a no-op (same reference) when it already reads that way.
 * Never gated on placement here: the CONTROL that offers this is only ever drawn for a right-slot
 * (rail) panel (spec §11 item 4, "the rail only"), so a bottom-placed panel simply never has this
 * called for it in practice, and `setPlacement` is what clears the flag the instant a pinned panel
 * DOES leave the rail — see that function's own PIN paragraph.
 */
export function setPanelPinned(layout: SlotLayout, panel: PanelId, pinned: boolean): SlotLayout {
  if (layout.pinned[panel] === pinned) return layout
  return { ...layout, pinned: { ...layout.pinned, [panel]: pinned } }
}

/** The pin toggle's own verb — flips whatever the panel's current pinned state is. */
export function togglePanelPinned(layout: SlotLayout, panel: PanelId): SlotLayout {
  return setPanelPinned(layout, panel, !isPanelPinned(layout, panel))
}

/**
 * WHAT A CLICK OUTSIDE THE NARROW-WIDTH OVERLAY (OR AN `Esc` PRESS) DOES (spec §11 items 2-3) — the
 * one decision behind both gestures, since the spec states them as the same rule ("Esc deveria fazer
 * o mesmo"). `pinned` wins outright: a pinned panel is never minimized by either gesture. Otherwise
 * a click that lands INSIDE the overlay's own box, or anywhere on the RAIL (including its config
 * area and its own context/overflow menus — switching panels, or working the rail's other verbs, is
 * not "clicking away"), does nothing either; everything else minimizes.
 *
 * PURE: the DOM question ("was this click inside the overlay, inside the rail") is answered by the
 * caller (`SessionsPage.tsx`, via `contains`/`closest`) and handed in as two booleans, which is what
 * lets this decision be unit-tested without a DOM.
 */
export function overlayOutsideAction(
  { pinned, insideOverlay, insideRail }: { pinned: boolean; insideOverlay: boolean; insideRail: boolean },
): 'minimize' | 'none' {
  if (pinned) return 'none'
  if (insideOverlay || insideRail) return 'none'
  return 'minimize'
}

/**
 * WHAT CLICKING A RAIL ICON DOES (addendum item 3, owner: "quando eu abro o item ele nao minimiza
 * dnv se eu clicar no icone do item dnv") — the RAIL IS A LAUNCHER, so its icon TOGGLES: clicking
 * the icon of the panel that is already open minimizes it, clicking any other icon opens it (which
 * also RESTORES a panel that is active but currently minimized — there is no third state a rail
 * icon click can express). The bottom bar now follows the same rule (`panelBar.ts`'s
 * `resolvePanelBarPick`, owner 2026-09-29): it used to be select-only, and two strips of the same
 * panels answering the same second click differently was reported as the bar being broken.
 */
export function railClickAction(active: PanelId | null, rightOpen: boolean, panel: PanelId): 'open' | 'minimize' {
  return active === panel && rightOpen ? 'minimize' : 'open'
}

/** Reorder every panel currently in `placement` to match `orderedIds` (design §3, wired for a later
 *  drag pass) — panels of `placement` absent from `orderedIds` keep their relative order, appended
 *  after the given ones; an id in `orderedIds` that is not actually in `placement` is ignored. */
export function reorderPlacement(
  layout: SlotLayout, placement: OpenPlacement, orderedIds: readonly PanelId[],
): SlotLayout {
  const current = (placement === 'rail' ? railPanels : bottomPanels)(layout)
  const wanted = orderedIds.filter(id => current.includes(id))
  const rest = current.filter(id => !wanted.includes(id))
  const sequence = [...wanted, ...rest]
  const order = { ...layout.order }
  sequence.forEach((id, i) => { order[id] = i })
  return { ...layout, order }
}

/**
 * A drag's drop TARGET (spec §3): either a specific other panel's icon/tab (reorder near it, or —
 * if it lives in the other bar — move there and land next to it) or a bare placement (dropped in
 * empty space of a bar, or on the bar's own container rather than on any one item — append to the
 * end, the same place the gear's move verb already lands a panel).
 */
export type PanelDropTarget = { panel: PanelId } | { placement: OpenPlacement }

/**
 * WHAT A DRAG-AND-DROP OF `dragPanel` ONTO `target` DOES (design §3) — the one pure decision behind
 * both the rail's own reorder and the rail↔bottom move, so the DOM layer only ever has to report
 * "this key was dropped on that key/bar" and never has to know which of the two operations that
 * implies.
 *
 * SAME BAR: a plain reorder via `reorderPlacement`, built on the shared `reorderByDrag` (the same
 * primitive `pinnedSessions.ts`'s drag and `SessionsGroupMenu`'s group-order drag both use).
 *
 * DIFFERENT BAR (or the panel is currently hidden — reachable from neither, so there is no "same
 * bar" to speak of): `movePanel` places it AND opens it there, mirroring the gear's own move verb
 * exactly, because that is what the spec asks for — a panel just dragged onto the bottom band is
 * the panel the person meant to look at next. When the drop landed on a SPECIFIC panel (rather than
 * bare empty space) it is then reordered to sit immediately before that panel, so "drop it here, ON
 * this tab" and "drop it here, roughly among these tabs" land in the same place rather than always
 * at the end regardless of where the cursor actually was.
 *
 * A drop with nothing to do (the target panel IS the dragged one, same bar) is a no-op — same as
 * `reorderByDrag`'s own no-op rule.
 */
export function planPanelDrop(layout: SlotLayout, dragPanel: PanelId, target: PanelDropTarget): SlotLayout {
  const targetPanel = 'panel' in target ? target.panel : null
  const targetPlacement: OpenPlacement = 'placement' in target
    ? target.placement
    : (layout.placement[targetPanel!] === 'bottom' ? 'bottom' : 'rail')
  if (targetPanel === dragPanel) return layout

  const samePlacement = layout.placement[dragPanel] === targetPlacement
  let next = samePlacement ? layout : movePanel(layout, dragPanel, targetPlacement)

  if (targetPanel !== null) {
    const order = (targetPlacement === 'rail' ? railPanels : bottomPanels)(next)
    next = reorderPlacement(next, targetPlacement, reorderByDrag(order, dragPanel, targetPanel))
  }
  return next
}

/**
 * The layout as a PHONE reads it. A phone has no rail and no bottom band (spec §8: "the fourteen
 * panels stay reachable through the existing mobile panel menu"), so a stored `bottom` occupant is
 * read as the fullscreen right sheet instead — WITHOUT rewriting storage, so turning the phone back
 * into a desktop restores the layout exactly as it was left. `cli`/`shell` are the one exception —
 * a phone's own `SessionPanel` already renders its OWN self-contained terminal/chat toggle
 * regardless of what `panelSlots` says for those two, so leaving them as the raw stored value here
 * is harmless and avoids fighting a path this function was never asked to change.
 *
 * ONLY WHEN NOTHING IS ALREADY ON THE RIGHT (`layout.right === null`). This is applied on every
 * render, not written back to storage, so without this guard it never STOPPED applying: a session
 * whose raw `bottom` was, say, `studio` (moved there by the gear, or carried over from a migrated
 * layout) folded into `right` on the first mobile render as intended — but the mobile switcher's own
 * click (`SessionsPage.tsx`'s `openSlotPanel`, which only ever writes the RAW `right` field) never
 * touches `bottom`, so the very next render folded `bottom` back over whatever the reader had just
 * picked. Measured live: tapping "Skills" in the mobile switcher while `bottom` still held `studio`
 * left the panel showing Studio, unchanged, on every tap — the switcher was reachable but inert.
 * Once something real sits on `right`, the fold has nothing left to do: the reader's own pick wins,
 * and `bottom`'s content stays reachable exactly as before, one tap away in the same switcher.
 */
export function resolveForViewport(layout: SlotLayout, isMobile: boolean): SlotLayout {
  if (!isMobile || layout.right !== null
    || layout.bottom === null || layout.bottom === 'cli' || layout.bottom === 'shell') {
    return layout
  }
  return { ...layout, right: layout.bottom, bottom: null, rightOpen: true }
}

/**
 * The three server-decided facts that close a panel outright rather than merely greying its entry:
 * whether this machine serves the repository explorer at all, whether it serves the per-session
 * shell, and whether this session is reached through a central's relay (which has no `cli`/`shell`
 * stream of its own — the whole `/api/fleet` prefix is refused there).
 */
export interface PanelGates {
  editorEnabled: boolean
  shellEnabled: boolean
  relayed: boolean
}

/** May this panel ever be shown, given what the server/session actually allows right now? The ten
 *  former `contents` tabs and `hardware` carry no server gate of their own — `hardware` is offered
 *  or not on a per-session basis (`hardwareOffered`, not a machine capability), read at the render
 *  layer alongside per-session availability (forks/tasks/metrics), never here. */
function gateOpen(panel: PanelId, gates: PanelGates): boolean {
  if (panel === 'studio') return gates.editorEnabled
  if (panel === 'cli') return !gates.relayed
  if (panel === 'shell') return gates.shellEnabled && !gates.relayed
  return true
}

/**
 * THE LAYOUT AS THE GATES ACTUALLY ALLOW IT — read-time, exactly like `resolveForViewport`, and
 * NEVER written back to storage. A stored `right: 'studio'` from a browser where the repository
 * explorer was once on must not render an empty, unclosable pane the moment `editorEnabled` turns
 * off: the panel is read as simply absent from wherever it sat, as if it had never been opened.
 */
export function resolveForGates(layout: SlotLayout, gates: PanelGates): SlotLayout {
  let next = layout
  for (const panel of PANEL_IDS) {
    if (!gateOpen(panel, gates) && isPanelShown(next, panel)) next = closePanel(next, panel)
  }
  return next
}

// ---------------------------------------------------------------------------------------------
// The store — choices on the server, the rail width per browser (see the header).
// ---------------------------------------------------------------------------------------------

const STORAGE_KEY = 'agentistics-panel-slots'

/** The current shape's version — bumped whenever the persisted fields change meaning, so a build
 *  newer than the one that wrote a value can tell "old shape, migrate it" from "current shape,
 *  trust it" without guessing from which fields happen to be present. */
const LAYOUT_VERSION = 2

type StoredPlacement = Record<string, unknown>

function readPlacement(v: unknown): Record<PanelId, Placement> {
  const out = { ...DEFAULT_PLACEMENT }
  if (typeof v !== 'object' || v === null) return out
  const r = v as StoredPlacement
  for (const id of PANEL_IDS) {
    const p = r[id]
    if ((p === 'rail' || p === 'bottom' || p === 'hidden') && allowed(p, id)) out[id] = p
  }
  return out
}

function readOrder(v: unknown, placement: Record<PanelId, Placement>): Record<PanelId, number> {
  const out = defaultOrder()
  if (typeof v === 'object' && v !== null) {
    const r = v as Record<string, unknown>
    for (const id of PANEL_IDS) {
      const n = r[id]
      if (typeof n === 'number' && Number.isFinite(n)) out[id] = n
    }
  }
  // Never let a corrupt/partial order disagree with placement in a way that makes two panels of
  // different placements interleave in `railPanels`/`bottomPanels` — harmless either way (those
  // sort within one placement only), kept only so `order` values stay monotonic-ish for the day
  // drag needs to insert between two of them.
  void placement
  return out
}

function readRestoreTo(v: unknown, placement: Record<PanelId, Placement>): Record<PanelId, OpenPlacement> {
  const out = defaultRestoreTo()
  if (typeof v === 'object' && v !== null) {
    const r = v as Record<string, unknown>
    for (const id of PANEL_IDS) {
      const p = r[id]
      if (p === 'rail' || p === 'bottom') out[id] = p
    }
  }
  // A panel that is CURRENTLY placed (not hidden) always restores to its own placement — there is
  // nothing else `restoreTo` could mean for it, and a stale value left over from an earlier hide
  // must not silently disagree with where the panel visibly sits right now.
  for (const id of PANEL_IDS) {
    if (placement[id] !== 'hidden') out[id] = placement[id] as OpenPlacement
  }
  return out
}

/** PIN reads FALSE for anything not an explicit `true`, and — same defensive correction
 *  `readRestoreTo` applies to its own field — is forced false for a panel that is not CURRENTLY on
 *  the rail: a stored `pinned: true` beside `placement: 'bottom'` is a value no writer in this
 *  module ever produces (`setPlacement` clears it in the same write that moves a panel off the
 *  rail), so a hand-edited or corrupt file must not resurrect a pin the panel's own placement
 *  disagrees with. */
function readPinned(v: unknown, placement: Record<PanelId, Placement>): Record<PanelId, boolean> {
  const out = defaultPinned()
  if (typeof v === 'object' && v !== null) {
    const r = v as Record<string, unknown>
    for (const id of PANEL_IDS) {
      if (r[id] === true) out[id] = true
    }
  }
  for (const id of PANEL_IDS) {
    if (placement[id] !== 'rail') out[id] = false
  }
  return out
}

function readOccupant(v: unknown, placement: Record<PanelId, Placement>, want: OpenPlacement): PanelId | null {
  if (!isPanelId(v)) return null
  return placement[v] === want ? v : null
}

/** OLD SHAPE (pre-rail): a bare `right`/`bottom` panel id from the five-id domain, no `placement`
 *  field at all. */
function isLegacyShape(r: Record<string, unknown>): boolean {
  return r.placement === undefined && ('right' in r || 'bottom' in r || 'lastSlot' in r)
}

/** MIGRATE an old-shape record — see this module's own header. `oldBottom`/`oldRight` are the raw
 *  legacy values (any string, since the old five-id domain included `'contents'`, which is not a
 *  `PanelId` any more). */
function migrateLegacy(r: Record<string, unknown>): SlotLayout {
  const oldRight = typeof r.right === 'string' ? r.right : null
  const oldBottom = typeof r.bottom === 'string' ? r.bottom : null
  const placement = { ...DEFAULT_PLACEMENT }
  for (const id of ['studio', 'cli', 'shell', 'hardware'] as const) {
    if (oldBottom === id) placement[id] = 'bottom'
    else if (oldRight === id) placement[id] = 'rail'
  }
  // `contents`'s ten descendants are placed on the rail regardless of where `contents` itself used
  // to sit — see this module's own header on why "wherever contents was" is deliberately not the
  // rule.
  let right: PanelId | null = isPanelId(oldRight) ? oldRight : null
  let bottom: PanelId | null = isPanelId(oldBottom) ? oldBottom : null
  if (oldRight === 'contents') right = 'live'
  if (oldBottom === 'contents') bottom = 'live'
  const order = defaultOrder()
  const restoreTo = defaultRestoreTo()
  for (const id of PANEL_IDS) restoreTo[id] = placement[id] === 'bottom' ? 'bottom' : 'rail'
  const bottomOpen = bottom !== null && r.bottomOpen === true
  const rightOpen = r.rightOpen !== false
  // A legacy value predates PIN entirely — nothing was ever pinned under the old model.
  return {
    placement, order, restoreTo, pinned: defaultPinned(), right, bottom, bottomOpen, rightOpen,
    railWidth: RAIL_WIDTH_FLOOR_PX,
  }
}

/** Read the persisted layout. Exported so the storage guard is directly testable with an injected
 *  `Storage`. Never throws: an unreadable value, or one this build does not recognise, reads as the
 *  plain defaults. */
export function readLayout(storage?: Storage, key: string = STORAGE_KEY): SlotLayout {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(key)
    if (!raw) return EMPTY_SLOT_LAYOUT
    return parseLayout(JSON.parse(raw) as unknown)
  } catch {
    return EMPTY_SLOT_LAYOUT
  }
}

/** PURE: a stored layout VALUE (already JSON-parsed) as a `SlotLayout`. Total, like `readLayout`. */
export function parseLayout(v: unknown): SlotLayout {
  try {
    if (typeof v !== 'object' || v === null) return EMPTY_SLOT_LAYOUT
    const r = v as Record<string, unknown>
    if (isLegacyShape(r)) return migrateLegacy(r)
    // CURRENT (or a later) shape. `version` is read but not gated on: a future build may add fields
    // this one does not know about, and reading only the fields this build recognises — ignoring
    // everything else — is what lets an OLDER build open a layout a NEWER one saved without
    // throwing or discarding it outright.
    const placement = readPlacement(r.placement)
    const order = readOrder(r.order, placement)
    const restoreTo = readRestoreTo(r.restoreTo, placement)
    const pinned = readPinned(r.pinned, placement)
    return {
      placement, order, restoreTo, pinned,
      right: readOccupant(r.right, placement, 'rail'),
      bottom: readOccupant(r.bottom, placement, 'bottom'),
      bottomOpen: readOccupant(r.bottom, placement, 'bottom') !== null && r.bottomOpen === true,
      rightOpen: r.rightOpen !== false,
      // Absent (an older build's record) migrates to the floor — never NaN, never a throw — and a
      // stored value outside the current clamp (a hand-edited file, or a future build with a wider
      // range) is re-clamped to what THIS build allows, same as every other field here.
      railWidth: clampRailWidth(typeof r.railWidth === 'number' ? r.railWidth : RAIL_WIDTH_FLOOR_PX),
    }
  } catch {
    return EMPTY_SLOT_LAYOUT
  }
}

function writeLayout(layout: SlotLayout, storage?: Storage, key: string = STORAGE_KEY): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(
      key, JSON.stringify({ version: LAYOUT_VERSION, ...layout }),
    )
  } catch { /* the memory is a convenience; the panels still work without it */ }
}

/**
 * ONE LAYOUT PER PANE (`paneScope.ts`). The main pane keeps the historical key, so a browser that
 * never opens a split reads and writes exactly what it always did. The split pane has its own
 * record, and starts from the main pane's arrangement the first time it is opened, so the second
 * session opens looking like the first rather than bare.
 */
interface PaneLayoutStore { state: SlotLayout; listeners: Set<() => void> }
const stores = new Map<PaneId, PaneLayoutStore>()

/** The CHOICE half of a layout — everything but the screen-dependent rail width. */
type SharedLayouts = Partial<Record<PaneId, Record<string, unknown>>>
function choiceOf(layout: SlotLayout): Record<string, unknown> {
  const { railWidth: _width, ...rest } = layout
  return { version: LAYOUT_VERSION, ...rest }
}

// Created on first use, never at import: `floatingPanels.ts` imports `isPanelId` from here.
let shared: SharedPrefStore<SharedLayouts | null> | null = null
function sharedLayouts(): SharedPrefStore<SharedLayouts | null> {
  if (shared) return shared
  const store = createSharedPref<SharedLayouts | null>({
    key: 'agentistics-panel-slots-ui', prefKey: 'panelSlots', fallback: null, adoptLocalWhenAbsent: true,
    parse: raw => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as SharedLayouts : null),
    // The one-time migration source: the per-pane layouts this browser held before they moved.
    seed: () => {
      const out: SharedLayouts = {}
      for (const pane of ['main', 'split'] as const) {
        const local = readLayout(undefined, paneStorageKey(STORAGE_KEY, pane))
        if (local !== EMPTY_SLOT_LAYOUT) out[pane] = choiceOf(local)
      }
      return Object.keys(out).length > 0 ? out : null
    },
  })
  // The server's copy landing (or another device's change, on refocus) re-applies the choices to
  // every pane already drawn, keeping each pane's own rail width.
  store.subscribe(() => {
    for (const [pane, st] of stores) {
      const choice = store.get()?.[pane]
      if (!choice) continue
      const next = { ...parseLayout(choice), railWidth: st.state.railWidth }
      if (JSON.stringify(next) === JSON.stringify(st.state)) continue
      st.state = next
      writeLayout(next, undefined, paneStorageKey(STORAGE_KEY, pane))
      for (const l of st.listeners) l()
    }
  })
  shared = store
  return store
}

function storeOf(pane: PaneId): PaneLayoutStore {
  let st = stores.get(pane)
  if (!st) {
    const key = paneStorageKey(STORAGE_KEY, pane)
    let initial = readLayout(undefined, key)
    const choice = sharedLayouts().get()?.[pane]
    if (choice) initial = { ...parseLayout(choice), railWidth: initial.railWidth }
    if (pane !== 'main' && initial === EMPTY_SLOT_LAYOUT) initial = storeOf('main').state
    st = { state: initial, listeners: new Set() }
    stores.set(pane, st)
  }
  return st
}

function commitTo(next: SlotLayout, pane: PaneId): void {
  const st = storeOf(pane)
  if (next === st.state) return
  st.state = next
  writeLayout(next, undefined, paneStorageKey(STORAGE_KEY, pane))
  const all = sharedLayouts()
  all.set({ ...(all.get() ?? {}), [pane]: choiceOf(next) })
  for (const l of st.listeners) l()
}

/** A pane's layout. Without a pane: the ACTIVE one (an imperative call outside React). */
export function getPanelLayout(pane: PaneId = getActivePane()): SlotLayout {
  return storeOf(pane).state
}

export function subscribePanelLayout(cb: () => void, pane: PaneId = getActivePane()): () => void {
  const st = storeOf(pane)
  st.listeners.add(cb)
  return () => { st.listeners.delete(cb) }
}

/**
 * Open a panel imperatively. DISPLACING the Studio out of every slot asks first, exactly as closing
 * it does; MOVING it (it stays shown, just in the other slot) never does, because `isPanelShown`
 * reads `true` on both sides of a move.
 */
export function showPanel(panel: PanelId, pane: PaneId = getActivePane()): void {
  const commit = (n: SlotLayout) => commitTo(n, pane)
  // A panel floating as a window has no docked slot to open into — asking for it (a rail pick, a
  // chat note's "open the Gallery") brings its window to the front instead — and a MINIMIZED one
  // back exactly where it was left.
  if (getFloating(pane)[panel] !== undefined) { restoreFloatingPanel(panel, pane); return }
  const state = getPanelLayout(pane)
  const next = openPanel(state, panel)
  if (next === state) return
  const studioDisplaced = panel !== 'studio'
    && isPanelShown(state, 'studio') && !isPanelShown(next, 'studio')
  if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return
  commit(next)
}

/**
 * UNPIN a floating window: dock it back to the slot its placement names and open it there. The one
 * gesture behind every "dock back" control — the window's own pin and the pressed pin beside its
 * minimized tab in the bottom band — so the two can never disagree about where it lands.
 */
export function unpinPanel(panel: PanelId, pane: PaneId = getActivePane()): void {
  dockPanel(panel, pane)
  showPanel(panel, pane)
}

/**
 * Close a panel imperatively. Closing the Studio itself asks first when it is dirty.
 *
 * `after`, when given, runs once the panel is ACTUALLY gone — immediately if there was nothing to
 * ask about, or once the reader discards. It never runs on "keep editing".
 */
export function hidePanel(panel: PanelId, after?: () => void, pane: PaneId = getActivePane()): void {
  const commit = (n: SlotLayout) => commitTo(n, pane)
  const next = closePanel(getPanelLayout(pane), panel)
  if (next === getPanelLayout(pane)) { after?.(); return }
  if (panel === 'studio' && holdIfUnsaved('close', () => { commit(next); after?.() })) return
  commit(next)
  after?.()
}

/** Move a panel to the rail or the bottom band imperatively. Never asks — see `movePanel`. */
export function relocatePanel(panel: PanelId, to: OpenPlacement, pane: PaneId = getActivePane()): void {
  commitTo(movePanel(getPanelLayout(pane), panel, to), pane)
}

/** A drag's drop, imperatively (spec §3) — same-bar reorder or cross-bar move, decided by
 *  `planPanelDrop`. Never asks — same as `relocatePanel`, which this can do everything that one
 *  does (a cross-bar drop can displace the Studio exactly as the gear's own move verb can, and
 *  neither one has ever asked first). */
export function dropPanel(panel: PanelId, target: PanelDropTarget, pane: PaneId = getActivePane()): void {
  commitTo(planPanelDrop(getPanelLayout(pane), panel, target), pane)
}

export function setBandOpen(open: boolean, pane: PaneId = getActivePane()): void {
  commitTo(setBottomOpen(getPanelLayout(pane), open), pane)
}

/**
 * "Ocultar" (spec §5), imperatively — a panel goes to `hidden`: no icon, no tab, reachable only
 * through the config area's eye. Built on the pure `hidePanelPlacement`, which already removes the
 * panel as the active occupant of whichever slot it was showing in.
 *
 * ASKS ONLY when hiding the Studio while it is CURRENTLY the active occupant would discard unsaved
 * edits — the exact same risk `hidePanel` (the ordinary close) already guards.
 */
export function concealPanel(panel: PanelId, pane: PaneId = getActivePane()): void {
  const commit = (n: SlotLayout) => commitTo(n, pane)
  const state = getPanelLayout(pane)
  const next = hidePanelPlacement(state, panel)
  if (next === state) return
  const studioDisplaced = panel === 'studio' && isPanelShown(state, 'studio')
  if (studioDisplaced && holdIfUnsaved('close', () => commit(next))) return
  commit(next)
}

/**
 * The eye's "put it back where it was" verb (spec §5), imperatively — restores a hidden panel to
 * its remembered `restoreTo` placement. Never asks: restoring only ever ADDS an icon or a tab back.
 */
export function revealPanel(panel: PanelId, pane: PaneId = getActivePane()): void {
  commitTo(restorePanelPlacement(getPanelLayout(pane), panel), pane)
}

/** Minimize or restore the right slot's own content — never asks: it never unmounts anything (the
 *  Studio's own host stays parked), so there is nothing here for `holdIfUnsaved` to protect. */
export function setSlotRightOpen(open: boolean, pane: PaneId = getActivePane()): void {
  commitTo(setRightOpen(getPanelLayout(pane), open), pane)
}

/** The header row's PIN toggle (spec §11 item 3), imperatively. Never asks. */
export function togglePinned(panel: PanelId, pane: PaneId = getActivePane()): void {
  commitTo(togglePanelPinned(getPanelLayout(pane), panel), pane)
}

/** The rail's own resize grip, imperatively — clamps and persists (owner, 2026-09-21). Never asks. */
export function setRailWidth(width: number, pane: PaneId = getActivePane()): void {
  const clamped = clampRailWidth(width)
  const state = getPanelLayout(pane)
  if (clamped === state.railWidth) return
  commitTo({ ...state, railWidth: clamped }, pane)
}

/** For tests: forget everything. */
export function resetPanelSlots(): void {
  stores.delete('split')
  derivedByPane.clear()
  const main = storeOf('main')
  main.state = EMPTY_SLOT_LAYOUT
  for (const l of main.listeners) l()
}

export interface PanelSlotsApi {
  layout: SlotLayout
  openPanel: (panel: PanelId) => void
  closePanel: (panel: PanelId) => void
  movePanel: (panel: PanelId, to: OpenPlacement) => void
  /** A drag's drop (spec §3) — see `dropPanel`/`planPanelDrop`. */
  dropPanel: (panel: PanelId, target: PanelDropTarget) => void
  setBottomOpen: (open: boolean) => void
  setRightOpen: (open: boolean) => void
  /** "Ocultar" (spec §5) — see `concealPanel`. */
  hidePanelToConfig: (panel: PanelId) => void
  /** The eye's restore verb (spec §5) — see `revealPanel`. */
  restorePanel: (panel: PanelId) => void
  /** The rail's own resize grip (owner, 2026-09-21) — see `setRailWidth`. */
  setRailWidth: (width: number) => void
  /** The header row's PIN toggle (spec §11 item 3) — see `togglePinned`. */
  togglePinned: (panel: PanelId) => void
}

/** The stored layout with the pane's floating panels applied (`applyFloating`), as a STABLE
 *  snapshot per pane: the same object until either store changes, which `useSyncExternalStore`
 *  requires of a snapshot or it re-renders forever. */
const derivedByPane = new Map<PaneId, { layout: SlotLayout; floating: FloatingSet; derived: SlotLayout }>()
function getEffectiveLayout(pane: PaneId): SlotLayout {
  const floating = getFloating(pane)
  const layout = getPanelLayout(pane)
  const hit = derivedByPane.get(pane)
  if (hit && hit.layout === layout && hit.floating === floating) return hit.derived
  const derived = applyFloating(layout, Object.keys(floating) as PanelId[])
  derivedByPane.set(pane, { layout, floating, derived })
  return derived
}

/** The one hook every panel-aware component reads — bound to the pane it is rendered in. */
export function usePanelSlots(): PanelSlotsApi {
  const pane = usePaneId()
  const layout = useSyncExternalStore(
    cb => {
      const a = subscribePanelLayout(cb, pane)
      const b = subscribeFloating(cb)
      return () => { a(); b() }
    },
    () => getEffectiveLayout(pane),
    () => EMPTY_SLOT_LAYOUT,
  )
  return {
    layout,
    openPanel: panel => showPanel(panel, pane),
    closePanel: panel => hidePanel(panel, undefined, pane),
    movePanel: (panel, to) => relocatePanel(panel, to, pane),
    dropPanel: (panel, target) => dropPanel(panel, target, pane),
    setBottomOpen: open => setBandOpen(open, pane),
    setRightOpen: open => setSlotRightOpen(open, pane),
    hidePanelToConfig: panel => concealPanel(panel, pane),
    restorePanel: panel => revealPanel(panel, pane),
    setRailWidth: width => setRailWidth(width, pane),
    togglePinned: panel => togglePinned(panel, pane),
  }
}

/**
 * THE RAIL'S OWN LIVE WIDTH, ALONE — every "stay clear of the rail" reader needs this ONE number
 * and nothing else `SlotLayout` carries. `useSyncExternalStore`'s snapshot here is a bare number, so
 * `Object.is` skips the re-render whenever a layout change leaves the width untouched. Per pane.
 */
export function useRailWidth(): number {
  const pane = usePaneId()
  return useSyncExternalStore(
    cb => subscribePanelLayout(cb, pane), () => getPanelLayout(pane).railWidth, () => RAIL_WIDTH_FLOOR_PX,
  )
}

/**
 * MOUNTS `Component` AT MOST ONCE, WITH NO `key` OF ITS OWN, wherever `shown` is true — see the
 * pre-rail revision of this file for the full story of the remount bug this guards against.
 */
export function mountPanel<P extends object>(
  shown: boolean, Component: ComponentType<P>, props: P,
): ReactElement<P> | null {
  return shown ? createElement(Component, props) : null
}

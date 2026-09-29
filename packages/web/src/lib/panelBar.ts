/**
 * panelBar.ts — the BOTTOM BAND's own tab strip: which of the panels currently PLACED AT THE BOTTOM
 * it offers, in what order, and which is lit.
 *
 * AFTER THE RIGHT ICON RAIL (2026-09-21), this bar's job narrowed. It used to be the ONE switcher for
 * all five panels regardless of which slot they occupied — a quick-jump control reachable from
 * wherever you were. The rail (`PanelRail.tsx`) is now that control for every RAIL-placed panel, so a
 * bar embedded in the bottom band that ALSO offered rail panels would be two competing switchers
 * disagreeing about which one is the "real" way to reach them. This bar is scoped to exactly what the
 * bottom band can ever show: the panels PLACED at the bottom (`panelSlots.ts`'s `bottomPanels`),
 * however many there are — the default two (`cli`/`shell`), or any others the gear/drag has moved
 * there since.
 *
 * Pure and React-free so the ORDER and the LIT tab can be tested without mounting anything.
 */

import { PANEL_IDS, type PanelId } from './panelSlots'

export type PanelBarId = PanelId

export interface PanelBarGates {
  /** `appCtx.editorEnabled` — the server's own answer, never re-derived. */
  editorEnabled: boolean
  /** `appCtx.shellEnabled` — ditto. */
  shellEnabled: boolean
  /** This session is another machine's, reached through a central's relay — no `cli`/`shell` stream
   *  of its own exists to show. */
  relayed: boolean
  /** Hardware reads THIS machine's own process list — meaningless (and refused) on a central. */
  hardwareOffered: boolean
}

export interface PanelBarEntry {
  id: PanelBarId
  /** Is this panel the bottom band's own active tab right now? */
  on: boolean
}

/**
 * The entries to render, in `bottomIds`'s OWN order (the caller already sorted it —
 * `panelSlots.bottomPanels`), each carrying whether it is the lit one. A gate-closed panel is
 * ABSENT rather than greyed, exactly as `panelSlots.resolveForGates` already treats it as absent
 * from the slot itself.
 */
export function panelBarEntries(
  bottomIds: readonly PanelBarId[], activeBottom: PanelBarId | null, gates: PanelBarGates,
): PanelBarEntry[] {
  return bottomIds
    .filter(id => panelBarGateOpen(id, gates))
    .map(id => ({ id, on: activeBottom === id }))
}

function panelBarGateOpen(panel: PanelBarId, gates: PanelBarGates): boolean {
  if (panel === 'studio') return gates.editorEnabled
  if (panel === 'cli') return !gates.relayed
  if (panel === 'shell') return gates.shellEnabled && !gates.relayed
  if (panel === 'hardware') return gates.hardwareOffered
  return true
}

/**
 * THE BOTTOM SLOT'S OWN OCCUPANT, AS THE SHELL GATE ACTUALLY ALLOWS IT.
 *
 * A stored `bottom: 'shell'` from before the switch was turned off in Settings must not light no tab
 * at all while `ShellBand` (which clamps its own `target` the same way) draws the session's CLI pane
 * underneath it regardless. So this is applied BEFORE `bottomOccupant` is used for anything.
 */
export function gatedBottomOccupant(
  bottom: PanelBarId | null, shellEnabled: boolean,
): PanelBarId | null {
  return bottom === 'shell' && !shellEnabled ? 'cli' : bottom
}

/** Which band component renders at the foot of the session panel — `'studio'`/`'shell'` keep their
 *  own dedicated bands (their content needs the persistent Monaco host / the terminal-stream
 *  machinery respectively); any OTHER panel placed at the bottom renders through the generic docked
 *  band (`SessionPanel.tsx`'s `SimpleDockedBand`, keyed by the panel id itself, since none of the
 *  ten former Contents tabs or `hardware` holds client-only state a remount could lose). `'cli'` is
 *  excluded from the type ENTIRELY (never merely absent at runtime) — a bare `cli` occupant is
 *  exactly what the `'shell'` fallback already represents (`ShellBand`'s own internal toggle), so
 *  the type itself says a generic docked panel can never be it. */
export type BottomBandKind = Exclude<PanelId, 'cli'> | 'bar-only' | 'none'

export interface BottomBandInput {
  /** `SessionPanel`'s own already-gated, already-viewport-resolved `slotLayout.bottom` — `null` when
   *  nothing is placed at the bottom right now (every bottom-placed panel was moved away), or a
   *  server gate closed the one that was there. Never `'cli'` — see `BottomBandKind`'s own header. */
  bottomOccupant: Exclude<PanelId, 'cli'> | null
  /** This session belongs to another machine, reached through a central's relay — no `cli`/`shell`
   *  stream of its own exists to dock. */
  relayed: boolean
  /** Phone viewport — the relayed fallback (`bar-only`) is desktop-only. */
  isMobile: boolean
  /** Is ANY panel PLACED at the bottom — whether or not one is open there? This is what separates
   *  COLLAPSED from EMPTY, and `bottomOccupant` cannot answer it: that is the panel currently SHOWN,
   *  `null` both when nothing is placed at the bottom and when panels are placed there but the band
   *  is collapsed. `SessionPanel` passes its own gated bar entries' count, so a panel a gate hides
   *  counts as absent, exactly as the bar would draw it. */
  bottomHasPanels: boolean
}

/**
 * WHICH BAND RENDERS AT THE FOOT OF THE PANEL.
 *
 * `bottomOccupant` wins whenever it names anything — whatever panel it is, gated or not.
 *
 * EMPTY IS EMPTY, ON A DESKTOP. A local session with nothing placed at the bottom used to fall back
 * to `'shell'`, on the reading that `ShellBand` always has its own `cli`/`shell` toggle to offer and
 * so is a floor rather than an empty region. That reading predates PLACEMENT: once every panel can
 * be moved to the rail, `cli` and `shell` included, the floor draws a bar with no tabs in it — a
 * thin strip holding one orange `−` and nothing else, reported twice ("o - ainda aparece na barra
 * mesmo com ela fechada"). An earlier fix guarded `SimpleDockedBand` and `PanelBarBand` and missed
 * this one, because the strip comes from the band that is SELECTED here rather than from a band
 * rendering its own emptiness.
 *
 * COLLAPSED IS NOT EMPTY, and the two must not be confused: panels placed at the bottom with the
 * band collapsed keep their band — its tabs and the chevron that reopens it — and that is
 * `bottomHasPanels`, NOT `bottomOccupant !== null`. The first draft of this fix read the occupant,
 * which is `null` for a collapsed band too, and took the whole band away with Claude Code and Shell
 * still parked in it: caught on a live preview before it shipped. Nothing placed at all is the
 * empty case, and it renders NOTHING.
 *
 * A PHONE KEEPS THE FLOOR. There is no rail there, and `ShellBand`'s own segment at the foot of the
 * chat is how a phone reaches the session's terminal at all; taking it away because a placement
 * decided on a desktop says `rail` would leave a phone with no route to it. A RELAYED session with
 * nothing docked keeps the narrow `'bar-only'` fallback on desktop, `'none'` on a phone.
 */
export function bottomBandFor(
  { bottomOccupant, relayed, isMobile, bottomHasPanels }: BottomBandInput,
): BottomBandKind {
  if (bottomOccupant !== null) return bottomOccupant
  if (!relayed) return isMobile || bottomHasPanels ? 'shell' : 'none'
  return isMobile ? 'none' : 'bar-only'
}

/**
 * THE COMPACT BREAKPOINT — the bar's own measured width, never the window's.
 * `0` (not yet measured) reads as WIDE, never compact.
 */
export const BAND_BAR_COMPACT_BREAKPOINT = 1100

export function bandBarCompact(width: number): boolean {
  return width > 0 && width < BAND_BAR_COMPACT_BREAKPOINT
}

/**
 * A TAB CLICK ON THE OPEN TAB MINIMIZES IT — the right rail's own behaviour (owner, 2026-09-29:
 * "quando eu clico na aba novamente ela nao minimiza (o aside da direita tem essa funcionalidade)").
 * This used to read "a tab click selects, it never toggles", so the only way to put the band away
 * was its own chevron, while the rail beside it collapsed on a second click: two strips of the same
 * panels answering the same gesture differently.
 *
 *  - `'open'` — this panel is not the bottom band's own active tab. Make it so.
 *  - `'restore'` — it already is, but the band is collapsed (`bottomOpen` false). Expand it.
 *  - `'minimize'` — it is the active tab AND the band is open. Collapse the band; the panel stays
 *    its occupant, so the next click restores exactly what was there.
 */
export type PanelBarPickAction = { kind: 'open' } | { kind: 'restore' } | { kind: 'minimize' }

export function resolvePanelBarPick(
  { id, activeBottom, bottomOpen }: { id: PanelBarId; activeBottom: PanelBarId | null; bottomOpen: boolean },
): PanelBarPickAction {
  if (activeBottom !== id) return { kind: 'open' }
  return bottomOpen ? { kind: 'minimize' } : { kind: 'restore' }
}

/** Every panel id, in the historical reading order (`ArtifactsAside`'s own former tab order, with
 *  the right-slot-only and bottom-default panels appended) — re-exported so a caller that only knows
 *  this module does not also have to import `panelSlots.ts` for it. */
export const PANEL_BAR_ORDER: readonly PanelBarId[] = PANEL_IDS

/**
 * panelBar.ts — which entries the ONE panel switcher offers, in what order, and which is lit
 * (design item 1, owner's screenshot: "the top bar becomes clean and dedicated to the title etc").
 *
 * This used to be the FIXED HEADER's own tab group (`sessionHeaderSwitcher.ts`, the previous UX
 * pass's design item 2). The owner's drawing moves the whole group DOWN into the bottom band — it
 * already carried its own `Claude Code | Shell | Studio` occupant switcher (`bandSegment.ts`), so
 * the two are now ONE control rather than a header row plus a band segment saying overlapping
 * things. `bandSegment.ts`/`bandSegmentEntries` is retired with it: a bar that already offers every
 * entry the old band segment offered, plus Contents and Hardware, is the merge, not a second copy
 * beside it.
 *
 * `contents`/`hardware` are RIGHT-SLOT-ONLY panels (`panelSlots.ts`'s own `allowed`), so for them
 * "lit" still means exactly what it meant in the header: occupying the right slot. `studio` is lit
 * whenever it is on screen in EITHER slot, tagged with where — unchanged from the header's own rule.
 *
 * `cli`/`shell` are NEW here: because this bar now lives INSIDE the bottom band itself, and the band
 * IS the door to whichever of them it is currently showing, they must read `on` for the BOTTOM slot
 * too, or the band's own occupant would show no lit tab at all the moment this bar replaced its old
 * segment (which always lit the occupant, right or wrong slot never entered into it). Lit in EITHER
 * slot, exactly like Studio, but with no location tag — nobody asked for one on these two.
 *
 * Pure and React-free so the ORDER, PRESENCE and TAG rules can be tested without mounting anything —
 * the same shape `panelSlots.ts`'s own `allowed`/`gateOpen` take.
 */

export type PanelBarId = 'contents' | 'studio' | 'cli' | 'shell' | 'hardware'

/** Where the Studio currently sits, for the tab's own tag — `'side'` for the right slot (rendered
 *  "lateral"/"side"), `'bottom'` for the bottom band ("embaixo"/"bottom"). Named after the SLOT's
 *  meaning to a reader, not its storage key (`panelSlots.ts`'s `'right'`), so this module never has
 *  to import that one just to rename its values at the call site. */
export type StudioLocation = 'side' | 'bottom'

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
  /** Is this panel on screen right now — in the right slot for `contents`/`hardware`, in EITHER
   *  slot for `studio`/`cli`/`shell`? */
  on: boolean
  /** Present only on the `studio` entry, and only while it is `on` — where it sits right now. */
  studioAt?: StudioLocation
}

/**
 * The entries to render, in a FIXED order (Conteúdo · Studio · Claude Code · Shell · Hardware —
 * design item 1's own listing), each carrying whether it should render at all, whether it is the lit
 * one, and — for Studio — where it sits.
 *
 * `rightOccupant` is `rightSlotShowing(layout, contentsOpen)` — what the RIGHT slot itself is
 * showing. `bottomOccupant` is `layout.bottom` — the bottom band's own occupant. ABSENT, never
 * greyed, for a closed gate — the same rule `panelSlots.allowed`/`gateOpen` already apply to the
 * slot itself.
 */
export function panelBarEntries(
  rightOccupant: PanelBarId | null,
  bottomOccupant: PanelBarId | null,
  gates: PanelBarGates,
): PanelBarEntry[] {
  const order: { id: PanelBarId; shown: boolean }[] = [
    { id: 'contents', shown: true },
    { id: 'studio', shown: gates.editorEnabled },
    { id: 'cli', shown: !gates.relayed },
    { id: 'shell', shown: gates.shellEnabled && !gates.relayed },
    { id: 'hardware', shown: gates.hardwareOffered },
  ]
  const studioAt: StudioLocation | undefined =
    rightOccupant === 'studio' ? 'side' : bottomOccupant === 'studio' ? 'bottom' : undefined
  return order.filter(e => e.shown).map(e => {
    if (e.id === 'studio') {
      return studioAt !== undefined ? { id: e.id, on: true, studioAt } : { id: e.id, on: false }
    }
    // contents/hardware can never occupy `bottomOccupant` in a real SlotLayout (`panelSlots.allowed`
    // refuses the placement outright), so this reads exactly as "lit in the right slot" for them —
    // the same rule as before — while giving cli/shell the either-slot reading this file's header
    // describes, from one line rather than two branches.
    return { id: e.id, on: rightOccupant === e.id || bottomOccupant === e.id }
  })
}

/** The tag's own two words, EN/PT — kept here so both the tab's visible text and its (identical)
 *  accessible name are built from one source. */
export function studioLocationLabel(at: StudioLocation, pt: boolean): string {
  if (at === 'side') return pt ? 'lateral' : 'side'
  return pt ? 'embaixo' : 'bottom'
}

/**
 * THE BOTTOM SLOT'S OWN OCCUPANT, AS THE SHELL GATE ACTUALLY ALLOWS IT.
 *
 * `SessionPanel.tsx` reads `slotLayout.bottom` straight off `panelSlots.ts` without ever running it
 * through that module's own `resolveForGates` (only `SessionsPage.tsx`'s RIGHT-slot reading does) —
 * so a stored `bottom: 'shell'` from before the switch was turned off in Settings survives read after
 * read. Left alone, that stale value would light no tab at all in the bar (`shell` is absent from
 * `panelBarEntries` the moment the gate is closed, so nothing there names it, and `cli`'s own `on`
 * reads `bottomOccupant === 'cli'`, which a stale `'shell'` never satisfies either) while `ShellBand`
 * — which clamps its OWN `target` the same way, see that component's own header — draws the session's
 * CLI pane underneath it regardless. The bar would show no lit tab over a pane that is plainly there.
 *
 * So this is applied BEFORE `bottomOccupant` is used for anything — the bar's own `panelBarEntries`
 * call and the prop handed to `ShellBand` both read the SAME already-gated value, and can never
 * disagree about which of the two panes is showing.
 */
export function gatedBottomOccupant(
  bottom: PanelBarId | null, shellEnabled: boolean,
): PanelBarId | null {
  return bottom === 'shell' && !shellEnabled ? 'cli' : bottom
}

/** Which band component renders at the foot of the session panel. */
export type BottomBandKind = 'studio' | 'shell' | 'bar-only' | 'none'

export interface BottomBandInput {
  /** `SessionPanel`'s own already-resolved fact: the editor gate is open, this is not a phone (the
   *  Studio never docks on one — `resolveForViewport` sends it to the right sheet instead) and the
   *  bottom slot's occupant is `'studio'`. */
  bottomIsStudio: boolean
  /** This session belongs to another machine, reached through a central's relay — no `cli`/`shell`
   *  stream of its own exists to dock. */
  relayed: boolean
  /** Phone viewport — the relayed fallback (`bar-only`) is desktop-only; see this function's own
   *  doc comment on why a relayed session on a phone is left exactly as it was before this fix. */
  isMobile: boolean
}

/**
 * WHICH BAND RENDERS AT THE FOOT OF THE PANEL — the fix this pass makes.
 *
 * `shellEnabled` decides NOTHING here any more. Before this fix the caller's own JSX read
 * `shellEnabled && !relayed` to choose between `ShellBand` and nothing at all, so a LOCAL session
 * with the shell switched off drew NEITHER band: no way to reach Contents/Studio/Hardware, no task
 * control, no panel switcher of any kind — reported as the shell switch silently taking the whole
 * bottom bar down with it. Turning the shell off is a security narrowing on the shell's own CONTENT
 * (`panelBarEntries`' own `shell` gate drops the tab; `ShellBand`'s own `shellEnabled` prop keeps it
 * from ever showing or opening a shell pane), never on whether the bar itself may exist — the CLI
 * pane is the session's own harness terminal, not the shell, and stays reachable.
 *
 * `bottomIsStudio` still wins first (the Studio's own small bar, `StudioBand`). A session that is
 * local otherwise always gets `'shell'` — `ShellBand` is now the ONE band for every local session,
 * whatever the shell switch says, exactly as it already was the one band for both `cli` and `shell`
 * before this pass ever touched it. A RELAYED session keeps its old, narrower fallback exactly:
 * `'bar-only'` (`PanelBarBand`) on desktop, `'none'` on a phone — that gap is deliberately UNTOUCHED
 * by this fix (see `SessionPanel.tsx`'s own module header on why: mobile has never drawn a fallback
 * for a relayed session, and widening that is a separate change from the one this pass makes).
 */
export function bottomBandFor(input: BottomBandInput): BottomBandKind {
  if (input.bottomIsStudio) return 'studio'
  if (!input.relayed) return 'shell'
  return input.isMobile ? 'none' : 'bar-only'
}

/**
 * THE COMPACT BREAKPOINT (design item 7: "below ~1100px wide collapse tab labels to icons with
 * tooltips, the lit tab keeps its label and the Studio location tag") — the bar's own measured
 * width, from `useElementWidth`, never the window's (see that hook's own header on why).
 *
 * `0` (not yet measured) reads as WIDE, never compact: the very first frame has nothing to measure,
 * and starting compact-then-widening is a more visible flash than starting wide-then-narrowing on a
 * genuinely narrow bar, which a `ResizeObserver` corrects within one frame regardless.
 */
export const BAND_BAR_COMPACT_BREAKPOINT = 1100

export function bandBarCompact(width: number): boolean {
  return width > 0 && width < BAND_BAR_COMPACT_BREAKPOINT
}

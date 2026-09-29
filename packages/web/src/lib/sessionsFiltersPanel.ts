/**
 * sessionsFiltersPanel.ts — PURE: the keyboard decisions the Filtros panel's collapse makes, and
 * where the panel is allowed to sit on screen.
 *
 * The panel is always MOUNTED (the grid-rows animation needs the collapsed state still in the DOM
 * to glide out of it), so a `gridTemplateRows: 0fr` + `overflow: hidden` collapse is a purely VISUAL
 * fact — every control inside it (the date presets, "Limpar filtros", the dimension chips) stayed
 * reachable by Tab and readable by a screen reader while invisible. Reported by review: 12 Tab
 * presses from the closed trigger crossed nine hidden controls, including "Limpar filtros" — a
 * keyboard user pressing Enter there silently clears every filter and turns "Só ativas" off.
 *
 * `filtrosPanelInert` answers what the DOM should carry: the HTML `inert` attribute (not
 * `visibility: hidden`, which still leaves an element focusable via `tabindex` in older engines, and
 * not `aria-hidden` alone, which does not stop a *sighted* keyboard user tabbing into it) removes a
 * collapsed panel from the tab order and the accessibility tree in one step, the same technique
 * `RepoFileEditor.tsx` and `Studio.tsx` already use for a hidden layer in this codebase. `true` is
 * given rather than `false` so the collapsed case renders the attribute at all — an element is only
 * ever inert by that attribute's PRESENCE, and `inert={false}` still creates a false-vs-absent
 * distinction some engines have gotten wrong.
 *
 * `sessionsFiltersShouldReturnFocus` answers the other half: if the reader's focus is INSIDE the
 * panel at the moment it collapses (its own trigger, `inert`, or a stray close-on-blur elsewhere
 * moved it there), that focus needs to land back on the trigger — or it lands on `inert` content and
 * the browser resets it to the document body, which reads as "the keyboard silently stopped
 * working". It answers `false` while the panel is (or is about to be) open: only a COLLAPSE ever
 * needs to relocate focus, since expanding never removes anything from the tab order.
 *
 * `filtrosPanelBounds` answers the THIRD thing, added after review found the panel's fixed-440px
 * cap wrong: at 1024×768 with the artifacts aside at its own DEFAULT width, the aside renders at
 * 439px — not the 620px the fix's own reasoning assumed — so a fixed cap left the panel's right
 * edge 15px past the aside's left edge, painting over the "Studio" and "Live" tabs. A fixed width
 * cannot be right when BOTH neighbours are resizable, collapsible, and change shape across
 * breakpoints — the only durable anchor is the room that is ACTUALLY there, measured from the two
 * real elements (`App.tsx` reads the fleet aside's own live width; `SessionsPage.tsx` measures the
 * artifacts aside's box with a `ResizeObserver` and reports its left edge through
 * `rightAsideEdge.ts`, re-measuring on every drag, open/close and window resize). This function is
 * the pure arithmetic on top of those two measurements: never trust the requested width over the
 * room that is actually there.
 */

export function filtrosPanelInert(open: boolean): true | undefined {
  return !open || undefined
}

export function sessionsFiltersShouldReturnFocus(
  willBeOpen: boolean,
  focusIsInsidePanel: boolean,
): boolean {
  return !willBeOpen && focusIsInsidePanel
}

/** The one edge of a neighbour's box this function reads — see `filtrosPanelBounds`. */
export interface HorizontalEdges {
  left: number
  right: number
}

/**
 * The panel's preferred width when there is room for it — the old fixed cap, now a ceiling.
 * 460, not 440 (owner, 2026-09-27): the trigger moved off the header and into the aside's own
 * button row, so the panel is no longer squeezed between two asides on its usual side — it opens
 * with the FiltersBar's own natural width available (roughly 460px before its date row/chips wrap),
 * and 440 read narrower than that content wants, forcing an unnecessary inner scroll.
 */
export const FILTROS_PANEL_PREFERRED_WIDTH = 460

/**
 * The panel's floor — narrow enough that it is reached only when the room between the two asides
 * is itself under this, at which point no width avoids SOME overlap and the panel takes the least
 * of it. Below this a `FiltersBar` reads as a column of wrapped words rather than a filter bar.
 */
export const FILTROS_PANEL_MIN_WIDTH = 240

/**
 * Where the panel may sit, and how wide, given what is actually on screen either side of it.
 *
 * `leftAside` is the fleet aside's own box — only its `right` edge is read, which is where the
 * panel starts (this one is exact today: `App.tsx` owns that width as state, so there is nothing to
 * measure). `rightAside` is the artifacts aside's box, or `null` when it is not on screen at all
 * (closed) — only its `left` edge is read, which is the one boundary the panel must never cross.
 * `viewportWidth` is the fallback right edge for a closed aside, and the ceiling on the room a wide
 * monitor could otherwise hand the panel unbounded.
 *
 * The available room is CLAMPED, never trusted at its preferred width — a room narrower than
 * `FILTROS_PANEL_PREFERRED_WIDTH` shrinks the panel to fit it, exactly the clearance the fixed
 * 440px cap assumed would always hold and, at 1024×768 with the aside at its default width, did
 * not. `FILTROS_PANEL_MIN_WIDTH` is the floor under that clamp: once the room itself is narrower
 * than a usable panel, there is no width left that avoids overlap, and the floor is the least of it
 * rather than a panel squeezed to nothing.
 */
export function filtrosPanelBounds(
  leftAside: HorizontalEdges,
  rightAside: HorizontalEdges | null,
  viewportWidth: number,
): { left: number; width: number } {
  const left = leftAside.right
  const rightEdge = rightAside === null ? viewportWidth : rightAside.left
  const available = Math.max(0, rightEdge - left)
  const width = Math.max(FILTROS_PANEL_MIN_WIDTH, Math.min(FILTROS_PANEL_PREFERRED_WIDTH, available))
  return { left, width }
}

/** The metrics tab's own dropdown floor — narrower than this and the figures inside it (money,
 *  token counts) start wrapping mid-line. Same reasoning as `FILTROS_PANEL_MIN_WIDTH`, a smaller
 *  number because this card's own rows are narrower than a filter dimension's chips. */
export const METRICS_PANEL_MIN_WIDTH = 200

/** The metrics dropdown's preferred width — `SessionStatsMenu`'s own hardcoded card width, restated
 *  here so this module can clamp against it without importing a component. */
export const METRICS_PANEL_PREFERRED_WIDTH = 300

/**
 * WHERE THE SECOND HANGING TAB SITS, AND HOW WIDE ITS DROPDOWN MAY OPEN (design item 4, screenshot
 * 7) — the session-metrics tab beside "Filtros", sharing the exact room `filtrosPanelBounds` already
 * keeps clear of both asides.
 *
 * The metrics tab's own trigger sits immediately after the Filtros tab (`gap` apart) — `filtrosTabW`
 * is that button's OWN measured width, since a `min-content` pill has no width this module can
 * compute from the filter count alone (the Portuguese/English label, plus a badge that changes
 * digits, both shift it). ITS DROPDOWN THEN OPENS TOWARD THE CONTENT, never back toward the left
 * aside: a 300px card anchored to expand LEFTWARD from a trigger sitting barely a hundred pixels
 * clear of that aside would swallow it whole, which is exactly the shape of overlap
 * `filtrosPanelBounds`'s own header describes for the panel it protects. So the available width is
 * measured to the RIGHT of the tab, against the same right edge (clear of the artifacts aside)
 * `filtrosPanelBounds` already computed — never re-derived, or the two panels could disagree about
 * where that edge is.
 */
export function metricsTabBounds(
  filtros: { left: number; width: number },
  filtrosTabW: number,
  gap: number,
): { left: number; panelMaxWidth: number } {
  const left = filtros.left + filtrosTabW + gap
  const rightEdge = filtros.left + filtros.width
  const available = Math.max(0, rightEdge - left)
  const panelMaxWidth = Math.max(METRICS_PANEL_MIN_WIDTH, Math.min(METRICS_PANEL_PREFERRED_WIDTH, available))
  return { left, panelMaxWidth }
}

// ---------------------------------------------------------------------------------------------
// THE RIGHT-ANCHORED MIRROR (owner: "você vai mover os dois itens 'Filtros' e os stats da sessão
// pra direita, quando o aside da direita abrir eles devem vir mais pra esquerda junto, eles nunca
// vao ficar por cima dele") — the same two tabs, moved from hanging off the FLEET aside's own right
// edge to hanging off the ARTIFACTS aside's own left edge instead. `filtrosPanelBoundsRight` is
// `filtrosPanelBounds` with the anchor flipped: the CLAMP is identical arithmetic (the room between
// the two asides does not change because a control chooses which side to hug), only the returned
// offset is a CSS `right` value — the distance from the VIEWPORT's own right edge — rather than a
// `left` one, so the tab's own box sits flush against the artifacts aside (or the viewport's edge
// when it is closed) and grows LEFTWARD into the room, never rightward under the aside.
//
// `metricsTabBoundsRight` mirrors `metricsTabBounds` the same way, but the SECOND tab moves to the
// OTHER side of the first: Filtros is the one control that is ALWAYS on screen (narrowing the fleet
// list needs no selected session), so it stays the stable anchor flush against the artifacts aside;
// the session-metrics tab is the CONDITIONAL one (only a selected session has anything to show), so
// it is the one derived from the anchor's own measured trigger width — exactly the role
// `metricsTabBounds` already gives it, just measured leftward from Filtros instead of rightward.
// Reusing that ordering (rather than swapping which tab anchors) means Filtros never has to wait on
// a width that might not exist yet.
// ---------------------------------------------------------------------------------------------

/**
 * The gap kept between the Filtros/metrics tabs and the TRUE viewport edge once the artifacts aside
 * is closed and there is no aside to hang off instead. Without it `rightEdge` fell back to the bare
 * `viewportWidth`, so `right` (`viewportWidth - rightEdge`) came out to exactly `0` — the trigger's
 * own box sat flush against the browser's edge, reproduced live at 1440px with the Filtros button's
 * measured right edge landing AT x:1441. Same figure as `PAGE_INSET` (`FleetOverview.tsx`) — the
 * margin this app already reserves at the page's own edges, and the same one this row's LEFT side
 * already adds when computing `leftAside.right` in `App.tsx` — kept here as its own literal rather
 * than an import so this pure arithmetic module does not take a dependency on a component file for
 * one number.
 */
export const VIEWPORT_EDGE_MARGIN = 32

/**
 * The RIGHT-anchored mirror of `filtrosPanelBounds`. `right` is a CSS `right` offset — pixels from
 * the viewport's own right edge — not a `left` one; see this module's own header, above, for why
 * the width clamp itself is unchanged. The closed-aside fallback edge is inset by
 * `VIEWPORT_EDGE_MARGIN` from the true viewport width — see that constant's own comment — so both
 * this panel and `metricsTabBoundsRight`, which is derived from it, keep the same small breathing
 * room from the browser's edge that an open aside would otherwise provide.
 */
export function filtrosPanelBoundsRight(
  leftAside: HorizontalEdges,
  rightAside: HorizontalEdges | null,
  viewportWidth: number,
): { right: number; width: number } {
  const rightEdge = rightAside === null ? viewportWidth - VIEWPORT_EDGE_MARGIN : rightAside.left
  const available = Math.max(0, rightEdge - leftAside.right)
  const width = Math.max(FILTROS_PANEL_MIN_WIDTH, Math.min(FILTROS_PANEL_PREFERRED_WIDTH, available))
  return { right: Math.max(0, viewportWidth - rightEdge), width }
}

/**
 * The RIGHT-anchored mirror of `metricsTabBounds` — the session-metrics tab sits to the LEFT of
 * Filtros (further from the artifacts aside) by Filtros' own measured trigger width plus the gap,
 * and its dropdown opens further left still, bounded by the SAME far edge Filtros' own box already
 * respects (`filtros.right + filtros.width` — Filtros' own left-most extent, mirroring
 * `metricsTabBounds`'s `filtros.left + filtros.width`).
 */
export function metricsTabBoundsRight(
  filtros: { right: number; width: number },
  filtrosTabW: number,
  gap: number,
): { right: number; panelMaxWidth: number } {
  const right = filtros.right + filtrosTabW + gap
  const farEdge = filtros.right + filtros.width
  const available = Math.max(0, farEdge - right)
  const panelMaxWidth = Math.max(METRICS_PANEL_MIN_WIDTH, Math.min(METRICS_PANEL_PREFERRED_WIDTH, available))
  return { right, panelMaxWidth }
}

/**
 * The panel's `overflow`, decided — PURE.
 *
 * It was `hidden` while collapsed or animating and `auto` otherwise, while the comment above it
 * promised `visible` once settled. `auto` makes the box a SCROLL CONTAINER, and a scroll container
 * clips its absolutely positioned descendants — which is every popover `FiltersBar` draws in flow:
 * the "+ Filtro" menu, the value pickers, the date calendar. So opening one opened it INSIDE the
 * panel, behind a vertical and a horizontal scrollbar, reported with a screenshot of exactly that.
 *
 * `visible` whenever the card FITS (the ordinary case), so every popover escapes; `auto` only when
 * the card itself is taller than the room measured for it, where scrolling it is the lesser evil;
 * `hidden` while collapsed or mid-animation, which the grid-rows collapse needs. `contentHeight` is
 * the CARD's own height — an absolutely positioned popover does not change it, so opening a menu
 * can never flip the panel into clipping that very menu. `null` (not measured yet) reads as fitting.
 */
export function filtrosPanelOverflow(o: {
  open: boolean
  animating: boolean
  contentHeight: number | null
  maxHeight: number | null
}): 'hidden' | 'visible' | 'auto' {
  if (!o.open || o.animating) return 'hidden'
  if (o.contentHeight === null || o.maxHeight === null) return 'visible'
  return o.contentHeight > o.maxHeight ? 'auto' : 'visible'
}

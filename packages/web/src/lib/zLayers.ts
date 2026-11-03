/**
 * zLayers.ts — the named tiers of the fixed-position stack that more than one module has to agree on.
 *
 * Nothing here is a stacking-context trap: the floating Nay button, the full-screen panels and the
 * sheets are all `position: fixed` siblings under `<body>`/`#root`, so the only thing that decides
 * who covers whom is the number. The button was `300` and every full-screen panel was
 * `PANEL_FULLSCREEN_Z` (`320`), so opening ANY panel full screen from the aside, the bottom band or
 * the rail drew the panel over the button — measured with `document.elementFromPoint` at the
 * button's centre (1440x900: the covering element was a `z=320` 1108x900 box).
 *
 * The order, low to high:
 *   topbar 300 · full-screen panels 320 · mobile pill bar 330 · NAY BUTTON 340 · dialogs 350+
 *
 * The button sits ABOVE what is merely a surface (a full-screen panel, the bottom bar) and BELOW
 * every dialog tier (`SessionDrilldownModal` starts at 350, `ConfirmModal` is 2000), so a modal or a
 * menu that is meant to cover it still does. The chat window the button opens is `WINDOW_Z_BASE`
 * (410) and up, already above all of this.
 */

/** The left aside (sessions list / area rail). Below the top bar: they only meet when the rail's tree opens. */
export const ASIDE_Z = 200

/** The fixed top bar (session tab strip + the notice row under it). */
export const TOPBAR_Z = 300

/**
 * The aside while its area-tree DRAWER is open (and the scrim behind it). It must cover the whole top bar
 * — the session tab and the "needs you" notice — so it sits above `TOPBAR_Z` and the full-screen panels,
 * still below the mobile pill bar, the Nay button and every dialog. Mirrored in `index.css` as
 * `--ag-z-drawer`; `zLayers.test.ts` keeps the two equal.
 */
export const ASIDE_DRAWER_Z = 322

/** A panel drawn over the whole viewport in place — below every modal, above the sticky header. */
export const PANEL_FULLSCREEN_Z = 320

/** The mobile floating pill bar. */
export const MOBILE_PILL_BAR_Z = 330

/** The floating Nay button. Above every full-screen surface, below the first dialog tier. */
export const NAY_FAB_Z = 340

/** The button's own effect layer (trail / shock / comet) rides just under it. */
export const NAY_FAB_EFFECTS_Z = NAY_FAB_Z - 1

/** The attention card that is anchored to the button — one above it, so it is never hidden by it. */
export const NAY_NOTIFY_CARD_Z = NAY_FAB_Z + 1

/** The first ordinary dialog tier (`SessionDrilldownModal` and friends). Must stay above the button. */
export const DIALOG_FLOOR_Z = 350

/** Menus opened from portalled popovers must remain above the popover surface itself. */
export const SESSION_ROW_MENU_Z = 1300

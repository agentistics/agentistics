/**
 * standaloneHeight.ts — PURE: the app's height when installed as a PWA on iOS, where `100dvh`
 * cannot be trusted after the keyboard has been up.
 *
 * Owner report, 2026-10-04 01:51 (iPhone, home-screen app): with the keyboard CLOSED, a black band
 * sat under the session's bottom bar. The header was where it belonged, so this was not a document
 * scroll or a panned visual viewport (both would have moved the top as well). The band was the
 * root box ending above the floor. That box is `100dvh` (App.tsx), and in standalone mode iOS
 * sometimes leaves the viewport short after the keyboard closes. The gap is about the size of the
 * status bar, and it stays until something forces a relayout.
 *
 * In standalone mode there is no browser chrome, so the area the app owns is the whole screen, and
 * `screen` gives that number exactly. So: while nothing is being edited, a standalone app whose
 * viewport reads short of its screen is held at the screen's height. In every other case the rule
 * stays `100dvh`: a browser tab (its toolbars really do change the height), an open keyboard (iOS
 * does not shrink the layout viewport for it; the composer rides up by padding, App.tsx), and a
 * reading within `STANDALONE_SLACK` of the screen.
 *
 * Nothing here is measured on a real device. There is no iPhone on the machine this was built on.
 * The keyboard probe (`?kbdebug=1`) now records `screenH` beside `innerH`, so one reading after a
 * dismissal shows whether this is the gap.
 */

/** Below this, a short viewport is rounding or a hairline, not the stale-height bug. */
export const STANDALONE_SLACK = 16

export interface StandaloneHeightInput {
  /** Installed to the home screen (`navigator.standalone` or `display-mode: standalone`). */
  standalone: boolean
  /** An input, textarea or contenteditable holds the focus — the keyboard may be up. */
  editing: boolean
  /** `window.innerWidth` / `innerHeight` — the layout viewport as the page reads it. */
  innerWidth: number
  innerHeight: number
  /** `screen.width` / `screen.height` — portrait numbers on iOS, whatever the orientation. */
  screenWidth: number
  screenHeight: number
}

/** The height to hold the app at, in px, or `null` to keep `100dvh`. */
export function standaloneAppHeight(i: StandaloneHeightInput): number | null {
  if (!i.standalone || i.editing) return null
  if (!(i.screenWidth > 0 && i.screenHeight > 0 && i.innerWidth > 0 && i.innerHeight > 0)) return null
  const landscape = i.innerWidth > i.innerHeight
  // iOS reports `screen` in portrait whatever the orientation; the full height is the long side
  // in portrait and the short side in landscape.
  const full = landscape ? Math.min(i.screenWidth, i.screenHeight) : Math.max(i.screenWidth, i.screenHeight)
  return full - i.innerHeight >= STANDALONE_SLACK ? full : null
}

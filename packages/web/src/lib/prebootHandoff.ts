/**
 * prebootHandoff.ts — the ONE rule for when the boot splash leaves.
 *
 * The HTML splash (`index.html` #ag-preboot, animated by `boot/preboot.ts`) is the only boot screen:
 * React never draws a second loader over or after it. Every React state that is still LOADING (the
 * session check, the data, the first route's lazy chunk) holds it; the splash fades out once nothing
 * holds it and React has painted the screen that replaces it. A screen that asks the person
 * something (login, consent, an error) holds nothing, so it releases the splash.
 */
export interface PrebootState {
  /** How many mounted boot states are still holding the splash. */
  holds: number
  /** The splash has already been released (it never comes back on this page). */
  released: boolean
  /** React has committed AND the browser has painted that commit. */
  painted: boolean
}

export function shouldReleasePreboot(s: PrebootState): boolean {
  return !s.released && s.painted && s.holds <= 0
}

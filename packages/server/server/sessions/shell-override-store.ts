/**
 * shell-override-store.ts — the "Enable now" override's ONE piece of state: a per-process boolean,
 * never written to `preferences.json`.
 *
 * The disabled-shell empty state (`ShellBand`'s own module) offers two buttons: "Enable
 * permanently" writes the ordinary preference through `PUT /api/preferences`, the same door
 * Settings → Sessions already uses. "Enable now" is deliberately NOT that — it is a one-session
 * convenience ("let me use it for the next five minutes without changing what Settings says"), so
 * it lives here instead: in memory, reset to `false` on every process start, and never read or
 * written by `preferences.ts`. A server restart is what turns it back off, by construction — there
 * is no expiry to compute and nothing to forget to clear.
 *
 * `shellAllowedNow` (`shell-gate.ts`) is the only thing this value feeds, and it is checked ONLY as
 * a fallback for a `false` preference — the override can never widen past `CAPS.localShell`. This
 * module holds no opinion about that; it is the plain accessor pair, kept this small on purpose so
 * the interesting rule stays in the pure gate and stays testable there.
 */

let overridden = false

/** The override's current value — `false` on every fresh process. */
export function getShellOverride(): boolean {
  return overridden
}

/** Set by the one authenticated route that offers "Enable now" — never by a preference write. */
export function setShellOverride(value: boolean): void {
  overridden = value
}

/** Test-only: put the module back to its fresh-process state between suites. */
export function resetShellOverride(): void {
  overridden = false
}

/** PURE: may this machine serve a per-session utility shell?
 *
 *  A raw shell is strictly more powerful than the chat, which `chat-gate.ts` already calls the most
 *  powerful thing this server does — the chat at least spawns a NAMED assistant CLI, while this
 *  spawns whatever the person types into it. So it takes the same two gates, in the same order:
 *
 *  - `capable` is `CAPS.localShell`, decided by the exposure profile in `exposure.ts`. It is the
 *    SECURITY answer, and it is UNCHANGED by the rule below: `lan`/`public` and a central stay OFF
 *    regardless of the preference — the profile is the one thing a preference may never widen past.
 *  - `preference` is the user's own switch, and it may only ever NARROW `capable` — never re-enable
 *    what the profile denied.
 *
 *  OWNER DECISION, 2026-09-14: an ABSENT preference now reads as ON (`preference !== false`), for
 *  this switch and for `editor-gate.ts`'s ONLY, reversing the strict rule this file carried before
 *  (still the rule `chat-gate.ts` and the `shareMode` migration each document their own version
 *  of). The bottom bar (`panelBar.ts`) now offers Claude Code, Shell and Studio as three standing
 *  entries of one control, and the owner's call is that Shell should be there from the first run —
 *  the same way the session's own Claude Code pane always was — on a profile that already permits
 *  it (`capable`). An explicit `false` (a person who turned it off) is still respected exactly as
 *  before; the security gate below is exactly as strict as it always was.
 *
 *  It is a SEPARATE switch from `chatEnabled`, not a reuse of it: they are different powers, and
 *  somebody who wants to talk to an assistant through the dashboard has not thereby asked for a
 *  shell on the host. */
export function shellAllowed(capable: boolean, preference: boolean | undefined): boolean {
  return capable && preference !== false
}

/**
 * THE EFFECTIVE ANSWER once a temporary OVERRIDE exists ("Enable now" on the disabled-shell empty
 * state — see `shell-override-store.ts`). `capable` still governs absolutely: an override can only
 * ever RESTORE what `preference` narrowed, never widen past what the exposure profile allows. So
 * `capable === false` stays off however `override` reads — the same rule `shellAllowed` already
 * carries for `preference`, extended to the one new input.
 *
 * `override` is checked only as a FALLBACK for a `false` preference — an explicit `true` (or the
 * absent-reads-as-on default) never needs it, and folding it into an `||` up front would make the
 * override look load-bearing on a machine where the switch was never touched.
 */
export function shellAllowedNow(
  capable: boolean, preference: boolean | undefined, override: boolean,
): boolean {
  return capable && (shellAllowed(capable, preference) || override)
}

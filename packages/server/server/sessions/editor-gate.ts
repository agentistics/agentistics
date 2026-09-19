/**
 * editor-gate.ts — PURE: may this machine serve the repository explorer's read+write routes?
 *
 * Filesystem read+write+create+delete over an arbitrary subtree is at least as powerful as the
 * per-session shell — arguably more directly dangerous, since it needs no command execution at
 * all to do damage. It gets the SAME two-gate model `shell-gate.ts` already established, not a
 * weaker one:
 *
 *  - `capable` is `CAPS.localShell`, decided by the exposure profile in `exposure.ts`. This is
 *    deliberately the SAME capability the shell rides, not a new one — the spec is explicit that
 *    there is no deployment that should expose a shell but not this. It remains the SECURITY
 *    answer and is UNCHANGED by the rule below: a `lan`/`public` profile, or a central, stays OFF
 *    regardless of the preference.
 *  - `preference` is the user's own switch (`Preferences.editorEnabled`), and it may only ever
 *    NARROW `capable` — never widen it past what the profile allows.
 *
 * OWNER DECISION, 2026-09-14: an ABSENT preference now reads as ON (`preference !== false`), not
 * OFF. The Studio moved from the fixed header into the bottom band as a standing feature — read
 * `panelBar.ts`'s own header — and the owner's call is that a feature reachable from the bottom bar
 * on every session should be there from the first run, the same way the bottom band's own Claude
 * Code pane always was. This REVERSES the "absent reads as OFF" rule this module carried before
 * (and that `shell-gate.ts`, `chat-gate.ts` and the `shareMode` migration each still document their
 * own version of) for these two switches ONLY — an explicit `false` (a person who turned it off) is
 * still respected exactly as before, and `autosave` (`editorAutosave`) is UNTOUCHED: it stays
 * absent = OFF, since widening a save race is a materially different risk than opening a panel.
 *
 * It is a SEPARATE switch from `shellEnabled`, not a reuse of it: a person who wants a shell has
 * not thereby asked for a file editor, or vice versa — folding two distinct grants into one switch
 * is exactly the trap `chat-gate.ts`'s header warns about.
 */
export function editorAllowed(capable: boolean, preference: boolean | undefined): boolean {
  return capable && preference !== false
}

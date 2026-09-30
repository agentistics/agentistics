/** PURE: may this machine serve the chat?
 *
 *  Chat spawns an assistant CLI on the host. It is the most powerful thing this server does, and
 *  until now it was on by default anywhere the exposure profile permitted it — so a machine
 *  installed for its metrics also shipped a shell, without anyone choosing that.
 *
 *  Two gates, and the order between them is the whole point:
 *  - `capable` is `CAPS.localChat`, decided by the exposure profile in `exposure.ts`. It is the
 *    SECURITY answer.
 *  - `preference` is the user's own switch, and it may only ever NARROW. A preference that could
 *    re-enable what `public` denied would be an opt-in that restores host power on an exposed
 *    instance, which `exposure.ts` exists to make impossible.
 *
 *  OWNER DECISION, 2026-09-29: an ABSENT preference now reads as ON (`preference !== false`), not
 *  OFF. Nay became real sessions and its chat button is on every screen; the owner's call is that
 *  the chat should work from the first run, the same reversal `editor-gate.ts` and `shell-gate.ts`
 *  carry since 2026-09-14. It used to read absence as OFF so that a machine installed for its
 *  metrics would not also ship a shell nobody chose — that is now the owner's accepted trade. An
 *  explicit `false` (a person who turned it off in Settings -> Chat) is respected exactly as before,
 *  and the SECURITY gate is untouched: `capable` still decides, so a `lan`/`public` profile or a
 *  central stays OFF whatever the preference says. */
export function chatAllowed(capable: boolean, preference: boolean | undefined): boolean {
  return capable && preference !== false
}

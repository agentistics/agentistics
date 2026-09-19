/**
 * editorGate.ts — what the app PUBLISHES as `AppContext.editorEnabled`, and the one place a central
 * is subtracted from it.
 *
 * `GET /api/team/session` answers with the server's own combination of `CAPS.localShell` and the
 * user's switch (`sessions/editor-gate.ts`), and that module carries **no central term at all** — so
 * a central on a `local` profile with the preference on reports `editorEnabled: true` while the whole
 * `/api/fleet` prefix, which is every request the Studio makes, is refused there. A reader who
 * presses a Studio entry on a central lands on a panel that can only fail.
 *
 * The term was therefore applied by each SURFACE: the desktop button spelled it out, `SessionsPage`
 * derived it once for its two entries. That is verifiably correct for the surfaces that exist and
 * reopens the hole for the next one — `ctx.editorEnabled` is a context field, and a context field is
 * read by whoever wants it. **So the subtraction happens where the value is PUBLISHED**: there is one
 * producer, every consumer inherits it, and a surface added tomorrow cannot forget a term it never
 * had to know about.
 *
 * The property this buys is one sentence, and it is what `editorGate.test.ts` asserts: **a central
 * never publishes a true `editorEnabled`.** Absence still reads as OFF — a read/write file editor is
 * opt-in and an older server that says nothing has not consented to one (the `chat-gate.ts` rule,
 * deliberately not `shareMode`'s migration rule).
 *
 * It is NOT the server-side fix. `sessions/editor-gate.ts` growing a central term is the deeper one
 * and is deliberately out of scope here; this closes the browser's half app-wide rather than per page.
 */
export function editorEnabledFor(serverEditorEnabled: boolean | undefined, isCentral: boolean): boolean {
  return serverEditorEnabled === true && !isCentral
}

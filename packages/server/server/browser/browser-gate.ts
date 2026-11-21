/**
 * browser-gate.ts — PURE: may this machine run the built-in browser (NAVEGADOR S2, spec §4)?
 *
 * The shape of `shell-gate.ts` / `chat-gate.ts`, for the same reason: a browser the model drives on the
 * host is host power.
 *
 * - `capable` is `CAPS.localShell` (the exposure profile, `exposure.ts`): the SECURITY answer. `lan` and
 *   `public` stay off whatever the preference says.
 * - `preference` is `preferences.browserEnabled`, the person's own switch. It may only ever NARROW
 *   `capable`. ABSENT reads as ON — the owner's standing decision for the shell, the editor and the chat
 *   (2026-09-14 / 2026-09-29), applied here so the browser works from the first run on a profile that
 *   already permits it. An explicit `false` is respected.
 *
 * Enforced in `index.ts` BEFORE the `/api/browser/*` routes (status included), never only in the UI.
 */
export function browserAllowed(capable: boolean, preference: boolean | undefined): boolean {
  return capable && preference !== false
}

/**
 * Who may drive which browser (spec §1.6 / §4). PURE over what the route already knows:
 *
 * - a SESSION route needs a VERIFIED session (the MCP's HMAC proof); the owner is that proof's id and
 *   nothing in the body can name another — a session drives its own browser only;
 * - a PERSONAL route is the person's: a request that carries a session identity (verified or not) is
 *   refused, so a session's MCP cannot reach the person's browser by sending its proof along.
 */
export type DriveDecision =
  | { ok: true; owner: { kind: 'session'; managedId: string } | { kind: 'personal' } }
  | { ok: false; status: 403; error: 'unverified_session' | 'session_cannot_drive_personal'; sentence: string }

export function decideDriver(input: { route: 'session' | 'personal'; carriesSession: boolean; verifiedId: string | null }): DriveDecision {
  if (input.route === 'session') {
    if (!input.verifiedId) {
      return {
        ok: false, status: 403, error: 'unverified_session',
        sentence: 'The browser tools only work inside a session agentistics started (its proof did not verify).',
      }
    }
    return { ok: true, owner: { kind: 'session', managedId: input.verifiedId } }
  }
  if (input.carriesSession) {
    return {
      ok: false, status: 403, error: 'session_cannot_drive_personal',
      sentence: "A session cannot use the person's own browser; its tools reach only the browser of the session itself.",
    }
  }
  return { ok: true, owner: { kind: 'personal' } }
}

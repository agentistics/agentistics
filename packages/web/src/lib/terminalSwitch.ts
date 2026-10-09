/**
 * terminalSwitch.ts — PURE: the web's "Open in terminal" on a session running over its harness's
 * protocol (F2.0b). Whether it asks first, and the toast it leaves behind.
 *
 * The verb itself (its label, and whether a row offers it at all) is the SERVER's: `fleet-row.ts`
 * adds it only to a row that is structured right now. This module holds what is left for the
 * browser — and nothing about which harness can do it: a harness that cannot resume by id answers
 * with a sentence naming itself, and that sentence is shown as it arrives.
 */

/**
 * Ending the child ends the reply it is writing. An idle session loses nothing, so only a row that is
 * mid-turn asks — the same call `kill` makes for work in flight, applied to the smaller loss.
 */
export function terminalNeedsConfirm(state: string): boolean {
  return state === 'working'
}

/** The toast for the outcome of the `terminal` action. The message is the server's, already localized. */
export function terminalToast(
  out: { ok: boolean; message: string },
  lang: 'pt' | 'en',
): { type: 'success' | 'warning'; title: string; message: string } {
  return {
    type: out.ok ? 'success' : 'warning',
    title: lang === 'pt' ? 'Abrir no terminal' : 'Open in terminal',
    message: out.message,
  }
}

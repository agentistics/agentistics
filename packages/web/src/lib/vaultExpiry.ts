/**
 * The auto-lock warning (owner, 2026-10-04): 5 minutes before the vault locks itself the person is ASKED —
 * "Seu cofre vai se trancar em 5 min. Manter aberto?". Pure half: when to ask, and only once per window.
 *
 * `autoLockInMs` is the server's own countdown (`/api/vault`), which resets on any use of the vault, so
 * "already warned" is forgotten the moment the countdown climbs back above the threshold (an extension
 * or ordinary use) and the NEXT approach warns again. Nothing here ever extends anything: that is a click.
 */
export const WARN_BEFORE_MS = 5 * 60_000

export interface WarnState { warned: boolean }
export const WARN_INITIAL: WarnState = { warned: false }

export function nextWarn(s: WarnState, autoLockInMs: number | null, periodMs = Infinity): { state: WarnState; fire: boolean } {
  // Not open (null), or a window no longer than the warning itself: nothing to ask about.
  if (autoLockInMs === null || periodMs <= WARN_BEFORE_MS) return { state: WARN_INITIAL, fire: false }
  if (autoLockInMs > WARN_BEFORE_MS) return { state: WARN_INITIAL, fire: false }
  if (autoLockInMs <= 0) return { state: s, fire: false }
  if (s.warned) return { state: s, fire: false }
  return { state: { warned: true }, fire: true }
}

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

/** PURE. Is this page served from the machine itself? Off-loopback the browser is a phone/other device,
 *  so the card says "passkey" from the first frame instead of flashing the Windows Hello sentence. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || h === '' || /^127(\.\d{1,3}){3}$/.test(h) || h.endsWith('.localhost')
}

/** PURE. The sentence shown while the confirmation is pending. */
export function confirmSentence(phone: boolean, pt: boolean): string {
  return phone ? (pt ? 'Confirme com a passkey do aparelho.' : 'Confirm with this device’s passkey.')
    : (pt ? 'Confirme no Windows Hello.' : 'Confirm with Windows Hello.')
}

/** PURE. The keep-open button's label: stable width, never a bare spinner. */
export function extendLabel(busy: boolean, pt: boolean): string {
  return busy ? (pt ? 'Confirmando…' : 'Confirming…') : (pt ? 'Manter aberto' : 'Keep open')
}

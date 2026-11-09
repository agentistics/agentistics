/**
 * helloFallback.ts — what the computer offers when Windows Hello FAILS (owner decision, 2026-10-03).
 *
 * A failure is not a cancel. A person who pressed Cancel said no, and gets nothing extra; a Hello that
 * errored (the bridge broke, Windows did not answer in time) leaves the owner locked out of their own
 * vault for a reason that is not theirs. The fallbacks, in order:
 *
 *  (A) DEFAULT — approve on the phone: a phone registered with biometrics opens the vault with its
 *      passkey, and this page carries on by itself once the vault is open.
 *  The 24 recovery words stay the last resort, on this computer only. (COFRE.DESBLOQUEIO, 2026-11-07:
 *  the old "code alone" fallback went with the app code — there is no code to fall back to.)
 *
 * PURE: the component is `components/vault/VaultUnlock.tsx` (`UnlockControl`).
 */

/** The refusal codes that mean Hello ERRORED rather than the person refusing it. */
const HELLO_ERRORS = new Set(['presence-unavailable', 'presence-timeout'])

/** Did the gesture fail for a reason that is not the person's own "no"? */
export function helloErrored(code: string | undefined): boolean {
  return code !== undefined && HELLO_ERRORS.has(code)
}

export interface HelloFallback {
  /** (A) a phone with biometrics can approve this unlock. */
  phone: boolean
  /** (A) is the default, but there is no phone yet: say how to get one. */
  phoneMissing: boolean
}

export const NO_FALLBACK: HelloFallback = { phone: false, phoneMissing: false }

/**
 * What to offer after a gesture refusal. Nothing at all after a cancel (or any refusal that is not a
 * Hello error): the fallbacks exist for a broken Hello, never as a way around saying no to it.
 */
export function helloFallback(code: string | undefined, facts: { passkeys: number }): HelloFallback {
  if (!helloErrored(code)) return NO_FALLBACK
  return { phone: facts.passkeys > 0, phoneMissing: facts.passkeys === 0 }
}

/** While waiting for the phone: how often the page asks whether the vault opened, and for how long. */
export const PHONE_APPROVE_POLL_MS = 2000
export const PHONE_APPROVE_WAIT_MS = 5 * 60_000

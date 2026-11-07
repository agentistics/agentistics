/**
 * unlock-methods.ts — WHICH ways of confirming "it is you" this machine offers (owner decision
 * 2026-11-07, COFRE.DESBLOQUEIO). PURE: the platform and what is installed are passed in.
 *
 * The rule is "what the computer already has, plus a password of your own anywhere":
 *
 *   macOS            Touch ID or the Mac's password (LocalAuthentication, part of every macOS)
 *   Windows / WSL    Windows Hello
 *   Linux            nothing built in that a background service can ask reliably — the vault's own password
 *   everywhere       the vault's own password
 *   advanced         a FIDO2 security key — offered ONLY where its tools are present (libfido2 on
 *                    macOS/Linux, a verified webauthn.dll bridge on Windows). It is never the only
 *                    door and never a step that fails for want of a package (the owner's Mac asked
 *                    for libfido2 and could not be set up at all).
 *
 * The authenticator app (a 6-digit code) is NOT a method and never returns: it was removed from every
 * flow on 2026-11-07. A vault that still records one keeps opening; the code is simply never asked.
 */
import type { Platform } from './vault'

export type UnlockMethod = 'touchid' | 'hello' | 'password' | 'fido2'
export const UNLOCK_METHODS: readonly UnlockMethod[] = ['touchid', 'hello', 'password', 'fido2']

export interface UnlockMethodEnv {
  platform: Platform
  wsl: boolean
  /** libfido2's command-line tools resolve on this machine (macOS / Linux). */
  fido2Tools: boolean
  /** The Windows security-key bridge has been verified (fido2.ts `WEBAUTHN_BRIDGE_VERIFIED`). */
  webauthnVerified: boolean
}

export interface UnlockMethodOffer {
  id: UnlockMethod
  /** Shown under "advanced" — available, not recommended as the first choice. */
  advanced: boolean
}

/** PURE. The methods this machine offers, best first. Never empty: the vault's password is always there. */
export function unlockMethodsFor(e: UnlockMethodEnv): UnlockMethodOffer[] {
  const out: UnlockMethodOffer[] = []
  const windows = e.platform === 'win32' || e.wsl
  if (e.platform === 'darwin') out.push({ id: 'touchid', advanced: false })
  if (windows) out.push({ id: 'hello', advanced: false })
  out.push({ id: 'password', advanced: false })
  const fido2 = windows ? e.webauthnVerified : (e.platform === 'darwin' || e.platform === 'linux') && e.fido2Tools
  if (fido2) out.push({ id: 'fido2', advanced: true })
  return out
}

export function isUnlockMethod(v: unknown): v is UnlockMethod {
  return typeof v === 'string' && (UNLOCK_METHODS as readonly string[]).includes(v)
}

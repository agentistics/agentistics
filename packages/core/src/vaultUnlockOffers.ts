/**
 * vaultUnlockOffers.ts — PURE. What a page may offer to OPEN a locked vault, by where it is opened
 * from (VAULT.PERSONAL §10, the remote-device unlock). The server and the page both read this table,
 * so the screen can never offer a way the service would refuse.
 *
 * The rule the owner set (2026-10-03): on this computer the vault opens with Windows Hello (+ the code
 * under the unlock policy). From any OTHER origin — the phone over Tailscale — Hello is NEVER offered:
 * nobody is at the desk to answer it. There, the vault opens with EITHER the phone's biometrics (a
 * passkey registered from that phone, which needs https) plus the authenticator code, OR — only when
 * the owner turned on "open from the phone with the code alone" — the code alone on a phone that was
 * approved once on the computer.
 */

export type UnlockOffer =
  /** Windows Hello / Touch ID / a security key on THIS computer (+ the code when the policy asks). */
  | 'hello'
  /** The phone's own passkey (biometrics) + the authenticator code. */
  | 'passkey'
  /** The authenticator code alone, on a phone approved once — only when the owner opted in. */
  | 'code-only'
  /** This phone has no way in yet: register it (asks the code here and an approval on the computer). */
  | 'enrol'
  /** Passkeys need a secure address: say in one line how to get https. */
  | 'https'

export interface UnlockFacts {
  /** The page was opened ON this computer (socket peer, Host and Origin all loopback). */
  loopback: boolean
  /** The page's origin is a secure context for its host (https, or http on localhost). */
  secure: boolean
  /** Phone passkeys that can OPEN the vault (a key wrapper exists for them) on this page's host. */
  passkeys: number
  /** The owner's "code alone from the phone" switch. Known only while the vault is open; `null` = locked, unknown. */
  codeOnly: boolean | null
  /** THIS phone holds a device key the service still knows (approved once, switch on). */
  deviceKey: boolean
}

/**
 * PURE. The offers, most preferred first. Never `hello` off loopback; never nothing at all (a page
 * with no way forward must still say what to do — `enrol` and/or `https`).
 */
export function unlockOffers(f: UnlockFacts): UnlockOffer[] {
  if (f.loopback) return ['hello']
  const out: UnlockOffer[] = []
  if (f.secure && f.passkeys > 0) out.push('passkey')
  // A device key exists only while the switch is on (turning it off deletes every one), so holding a
  // live one IS the switch's answer while the vault is locked.
  if (f.deviceKey && f.codeOnly !== false) out.push('code-only')
  if (out.length > 0) return out
  out.push('enrol')
  if (!f.secure) out.push('https')
  return out
}

/** PURE. What a phone may register: a passkey needs https; a device key needs the owner's switch on. */
export function enrolKinds(f: { secure: boolean; codeOnly: boolean }): Array<'passkey' | 'device'> {
  const out: Array<'passkey' | 'device'> = []
  if (f.secure) out.push('passkey')
  if (f.codeOnly) out.push('device')
  return out
}

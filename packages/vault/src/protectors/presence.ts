/**
 * presence.ts — what the presence protectors (Windows Hello, FIDO2) share: the KEK construction, the
 * wrapped-DEK envelope, and the §3.5 failure codes with their sentences (en + pt). PURE.
 *
 * A presence protector never hands the DEK to the platform. The platform performs ONE operation only
 * after a human gesture (a Hello signature over a fixed challenge, an `hmac-secret` over a fixed salt)
 * and returns a secret; `KEK = HKDF-SHA256(ikm = that secret, salt = kid, info = "agentistics/vault/v2/<type>")`
 * and the DEK is sealed under it with AES-256-GCM, AAD `"agentistics-vault/v2/<type>" ‖ kid`. The DEK
 * is wrapped and unwrapped inside the service; the KEK is zeroed right after use.
 *
 * The failure code travels in `UnwrapResult.reason` as `<code>: <detail>` (the core union has no field
 * for it and is not ours to change); `presenceCode()` reads it back and `presenceSentence()` renders it.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { Lang } from '../sentences'
import { firstLine } from './types'

export type PresenceCode =
  | 'presence-cancelled'
  | 'presence-timeout'
  | 'presence-unavailable'
  | 'presence-lost'

const CODES: readonly PresenceCode[] = ['presence-cancelled', 'presence-timeout', 'presence-unavailable', 'presence-lost']

/** A protector failure kind per code: a refusal is `denied`, a missing credential is `missing`, and
 *  everything that leaves the vault locked-and-retryable is `unavailable`. */
export function kindOf(code: PresenceCode): 'missing' | 'unavailable' | 'denied' {
  return code === 'presence-lost' ? 'missing' : code === 'presence-cancelled' ? 'denied' : 'unavailable'
}

export function presenceReason(code: PresenceCode, detail: string): string {
  return detail ? `${code}: ${detail}` : code
}

export function presenceCode(reason: string): PresenceCode | null {
  return CODES.find(c => reason === c || reason.startsWith(c + ':')) ?? null
}

/**
 * The bridge's stderr contract: `PRESENCE-ERROR <cancelled|timeout|unavailable|lost|no-hmac-secret> [detail]`.
 * Anything else (interop, a profile that would not load) is `unavailable` and carries its first line.
 */
export function parseBridgeError(stderr: string): { code: PresenceCode | 'no-hmac-secret'; detail: string } {
  const line = firstLine(stderr)
  const m = /^PRESENCE-ERROR (cancelled|timeout|unavailable|lost|no-hmac-secret)\b\s*(.*)$/.exec(line)
  if (!m) return { code: 'presence-unavailable', detail: line || 'the Windows bridge failed' }
  const k = m[1]!
  return { code: k === 'no-hmac-secret' ? 'no-hmac-secret' : (`presence-${k}` as PresenceCode), detail: m[2] ?? '' }
}

export function presenceSentence(code: PresenceCode, lang: Lang, presence: string, reason = ''): string {
  const r = reason.replace(/^presence-[a-z]+:\s*/, '')
  if (lang === 'pt') {
    switch (code) {
      case 'presence-cancelled': return `${presence} foi cancelado, então o cofre continuou trancado. Nada foi aberto.`
      case 'presence-timeout': return `${presence} não recebeu resposta em 60 segundos, então o cofre continuou trancado. Rode \`agentop vault unlock\` quando estiver no computador.`
      case 'presence-unavailable': return `${presence} não pode ser acessado agora (${r}). O cofre continua trancado; nada foi alterado. Se este dispositivo sumiu de vez, rode \`agentop vault recover\` com suas 24 palavras.`
      case 'presence-lost': return `A credencial de ${presence} que protege o cofre não existe mais nesta máquina (${r}). Seus segredos estão intactos. Abra o cofre com a chave de recuperação de 24 palavras: \`agentop vault recover\`.`
    }
  }
  switch (code) {
    case 'presence-cancelled': return `${presence} was cancelled, so the vault stayed locked. Nothing was opened.`
    case 'presence-timeout': return `${presence} did not get an answer within 60 seconds, so the vault stayed locked. Run \`agentop vault unlock\` when you are at the computer.`
    case 'presence-unavailable': return `${presence} cannot be reached right now (${r}). The vault stays locked; nothing was changed. If this device is gone for good, run \`agentop vault recover\` with your 24 words.`
    case 'presence-lost': return `The ${presence} credential that protects the vault no longer exists on this machine (${r}). Your secrets are intact. Open the vault with your 24-word recovery key: \`agentop vault recover\`.`
  }
}

export function deriveKek(secret: Uint8Array, kid: string, type: 'hello' | 'fido2'): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', secret, new TextEncoder().encode(kid), `agentistics/vault/v2/${type}`, 32))
}

function aad(type: string, kid: string): Uint8Array {
  return new TextEncoder().encode(`agentistics-vault/v2/${type}${kid}`)
}

/** `nonce(12) ‖ ciphertext ‖ tag(16)`. */
export function sealDek(kek: Uint8Array, dek: Uint8Array, type: 'hello' | 'fido2', kid: string): Uint8Array {
  const nonce = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', kek, nonce, { authTagLength: 16 })
  c.setAAD(aad(type, kid))
  return new Uint8Array(Buffer.concat([nonce, c.update(dek), c.final(), c.getAuthTag()]))
}

export function openDek(kek: Uint8Array, wrapped: Uint8Array, type: 'hello' | 'fido2', kid: string): Uint8Array | null {
  if (wrapped.length < 12 + 16) return null
  try {
    const d = createDecipheriv('aes-256-gcm', kek, wrapped.subarray(0, 12), { authTagLength: 16 })
    d.setAAD(aad(type, kid))
    d.setAuthTag(wrapped.subarray(wrapped.length - 16))
    // Owned buffer, never `Buffer.concat` (shared pool): the caller zeroes the only copy of the DEK.
    const a = d.update(wrapped.subarray(12, wrapped.length - 16))
    try {
      const b = d.final()
      const out = new Uint8Array(a.length + b.length)
      out.set(a, 0); out.set(b, a.length)
      b.fill(0)
      return out
    } finally { a.fill(0) }
  } catch {
    return null
  }
}

/** Best-effort zeroing of a derived key. */
export function zero(b: Uint8Array): void {
  b.fill(0)
}

export function describeThrown(err: unknown): PresenceCode {
  return /time/i.test(String((err as Error)?.message ?? err)) ? 'presence-timeout' : 'presence-unavailable'
}

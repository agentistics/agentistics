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
 * What a Windows bridge may say about WHY, as a closed list of keys. A bridge's own words (a .NET
 * exception type, a WinRT status, PowerShell's localized error text) are a fact for the LOG and never
 * part of a sentence: found on the owner's machine, the screen read
 * `presence-unavailable: System.Management.Automation.PSInvalidCastException`.
 */
export const PRESENCE_DETAILS = [
  'bridge-failed', 'hello-not-set-up', 'credential-exists', 'credential-deleted', 'hello-status', 'bad-request',
  'not-reproducible',
  // v2.98.1 (owner's real use): every reason a presence protector can produce is a KEY. The fido2 and
  // hello protectors used to put English sentences here, and `presenceSentence` repeated them inside the
  // Portuguese UI ("the Windows security-key bridge (webauthn.dll) is not verified…").
  'bridge-unverified', 'interop-off', 'powershell-missing', 'no-answer', 'no-signature', 'no-key', 'fido2-tools-missing',
  'device-error', 'no-credential-id', 'not-touched', 'no-hmac-output', 'file-missing', 'file-damaged',
] as const
export type PresenceDetail = typeof PRESENCE_DETAILS[number]

const DETAIL_TEXT: Record<PresenceDetail, { en: string; pt: string }> = {
  'bridge-failed': { en: 'the Windows bridge failed; the details are in the agentop log', pt: 'a ponte do Windows falhou; os detalhes estão no log do agentop' },
  'hello-not-set-up': { en: 'Windows Hello is not set up on this device', pt: 'o Windows Hello não está configurado neste dispositivo' },
  'credential-exists': { en: 'a credential with this name already exists', pt: 'já existe uma credencial com este nome' },
  'credential-deleted': { en: 'the credential was deleted', pt: 'a credencial foi apagada' },
  'hello-status': { en: 'Windows Hello gave an unexpected answer; the details are in the agentop log', pt: 'o Windows Hello deu uma resposta inesperada; os detalhes estão no log do agentop' },
  'bad-request': { en: 'the Windows bridge did not understand the request', pt: 'a ponte do Windows não entendeu o pedido' },
  'not-reproducible': { en: 'it answered, but not with the key it gave when the vault was set up', pt: 'respondeu, mas não com a chave que deu quando o cofre foi configurado' },
  'bridge-unverified': { en: 'security keys through Windows are coming soon; use Windows Hello on this computer for now', pt: 'a chave de segurança pelo Windows chega em breve; por enquanto, use o Windows Hello neste computador' },
  'interop-off': { en: 'this Linux (WSL) cannot reach Windows right now', pt: 'este Linux (WSL) não consegue falar com o Windows agora' },
  'powershell-missing': { en: 'a Windows component (PowerShell) was not found', pt: 'um componente do Windows (PowerShell) não foi encontrado' },
  'no-answer': { en: 'Windows did not answer in time', pt: 'o Windows não respondeu a tempo' },
  'no-signature': { en: 'Windows Hello did not give its answer back', pt: 'o Windows Hello não devolveu a resposta' },
  'no-key': { en: 'no security key is plugged in', pt: 'nenhuma chave de segurança está conectada' },
  'fido2-tools-missing': { en: 'the security-key tools are not installed on this computer (the libfido2 package, fido2-tools)', pt: 'as ferramentas de chave de segurança não estão instaladas neste computador (o pacote libfido2, fido2-tools)' },
  'device-error': { en: 'the security key answered with an error; the details are in the agentop log', pt: 'a chave de segurança respondeu com um erro; os detalhes estão no log do agentop' },
  'no-credential-id': { en: 'the security key did not return its credential', pt: 'a chave de segurança não devolveu a credencial' },
  'not-touched': { en: 'the security key did not confirm it was touched', pt: 'a chave de segurança não confirmou o toque' },
  'no-hmac-output': { en: 'the security key did not return its secret', pt: 'a chave de segurança não devolveu o segredo' },
  'file-missing': { en: 'the file that links it to the vault is missing', pt: 'o arquivo que a liga ao cofre sumiu' },
  'file-damaged': { en: 'the file that links it to the vault is damaged', pt: 'o arquivo que a liga ao cofre está danificado' },
}

/** PURE. A reason as words for a PERSON: a key is translated, anything else is the generic line — never repeated. */
export function presenceDetailWords(reason: string, lang: Lang): string {
  const r = reason.replace(/^(presence-[a-z]+|no-hmac-secret):\s*/, '').trim()
  return isDetail(r) ? DETAIL_TEXT[r][lang] : DETAIL_TEXT['bridge-failed'][lang]
}

function isDetail(s: string): s is PresenceDetail { return (PRESENCE_DETAILS as readonly string[]).includes(s) }

/**
 * The bridge's stderr contract: `PRESENCE-ERROR <cancelled|timeout|unavailable|lost|no-hmac-secret> [<detail-key> [raw…]]`.
 * Only a KEY from `PRESENCE_DETAILS` is passed on as `detail`; everything after it, and any line that
 * does not follow the contract (interop, a profile that would not load), is `raw` — for the log.
 */
export function parseBridgeError(stderr: string): { code: PresenceCode | 'no-hmac-secret'; detail: PresenceDetail | ''; raw: string } {
  const line = firstLine(stderr)
  const m = /^PRESENCE-ERROR (cancelled|timeout|unavailable|lost|no-hmac-secret)\b\s*(\S*)\s*(.*)$/.exec(line)
  if (!m) return { code: 'presence-unavailable', detail: 'bridge-failed', raw: line || 'the Windows bridge failed with no output' }
  const k = m[1]!
  const code = k === 'no-hmac-secret' ? 'no-hmac-secret' : (`presence-${k}` as PresenceCode)
  const key = m[2] ?? ''
  if (key === '' && !m[3]) return { code, detail: '', raw: '' }
  return isDetail(key) ? { code, detail: key, raw: m[3] ?? '' } : { code, detail: 'bridge-failed', raw: `${key} ${m[3] ?? ''}`.trim() }
}

/** Where a bridge's raw words go: the service's own log (stderr → journal). Never a reply, never a UI. */
export function logBridge(line: string): void {
  try { process.stderr.write(`agentop: presence bridge: ${line.replace(/[\r\n]+/g, ' ').slice(0, 300)}\n`) } catch { /* a log line never breaks the vault */ }
}

/**
 * The detail part of a reason, as words: a key is translated, and ANYTHING ELSE — a .NET type, an
 * English sentence some tool printed, a path — is never repeated to a person (v2.98.1: the owner's
 * Portuguese screen quoted an internal English sentence). Empty stays empty (no "()" in the sentence).
 */
function detailWords(r: string, lang: Lang): string {
  if (r === '') return ''
  return isDetail(r) ? DETAIL_TEXT[r][lang] : DETAIL_TEXT['bridge-failed'][lang]
}

export function presenceSentence(code: PresenceCode, lang: Lang, presence: string, reason = ''): string {
  const r = detailWords(reason.replace(/^presence-[a-z]+:\s*/, ''), lang)
  // The reproducibility check runs at the FIRST real unlock (owner decision 2026-10-02), so its failure
  // is its own sentence: the credential exists, it simply did not give back the setup's key.
  if (code === 'presence-lost' && /^presence-lost:\s*not-reproducible$/.test(reason)) {
    return lang === 'pt'
      ? `${presence} respondeu, mas não com a mesma chave da configuração — então não abre este cofre. Seus segredos estão intactos. Abra o cofre com a chave de recuperação de 24 palavras: \`agentop vault recover\`; depois ligue a presença de novo.`
      : `${presence} answered, but not with the key it gave at setup — so it cannot open this vault. Your secrets are intact. Open the vault with your 24-word recovery key: \`agentop vault recover\`, then turn presence on again.`
  }
  if (lang === 'pt') {
    switch (code) {
      case 'presence-cancelled': return `${presence} foi cancelado, então o cofre continuou trancado. Nada foi aberto.`
      case 'presence-timeout': return `${presence} não recebeu resposta em 60 segundos, então o cofre continuou trancado. Rode \`agentop vault unlock\` quando estiver no computador.`
      case 'presence-unavailable': return `${presence} não pode ser acessado agora${r ? ` (${r})` : ''}. O cofre continua trancado; nada foi alterado. Se este dispositivo sumiu de vez, rode \`agentop vault recover\` com suas 24 palavras.`
      case 'presence-lost': return `A credencial de ${presence} que protege o cofre não existe mais nesta máquina${r ? ` (${r})` : ''}. Seus segredos estão intactos. Abra o cofre com a chave de recuperação de 24 palavras: \`agentop vault recover\`.`
    }
  }
  switch (code) {
    case 'presence-cancelled': return `${presence} was cancelled, so the vault stayed locked. Nothing was opened.`
    case 'presence-timeout': return `${presence} did not get an answer within 60 seconds, so the vault stayed locked. Run \`agentop vault unlock\` when you are at the computer.`
    case 'presence-unavailable': return `${presence} cannot be reached right now${r ? ` (${r})` : ''}. The vault stays locked; nothing was changed. If this device is gone for good, run \`agentop vault recover\` with your 24 words.`
    case 'presence-lost': return `The ${presence} credential that protects the vault no longer exists on this machine${r ? ` (${r})` : ''}. Your secrets are intact. Open the vault with your 24-word recovery key: \`agentop vault recover\`.`
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

// ── live progress: one tick per COMPLETED gesture ────────────────────────────────────────────────
//
// Owner, 2026-10-02: a step that says "confirm twice" and then raises a third dialog is a step nobody
// can trust, and a person with a Hello dialog in front of them has no way to know how many are left.
// Each bridge ticks here after a prompt the person actually answered (Hello create/sign, a key's
// make/assert); the service turns the ticks into "confirmation i of n" for the page. Nothing secret
// passes through: the listener receives no argument at all.

let _gestureListener: (() => void) | null = null
/** The service's hook; `null` detaches. One listener — the service owns one gesture at a time. */
export function setGestureListener(fn: (() => void) | null): void { _gestureListener = fn }
/** Called by a bridge after a gesture completed. Never throws into the bridge. */
export function gestureDone(): void { try { _gestureListener?.() } catch { /* progress is advisory */ } }

/**
 * How many prompts each operation raises — the ONE place the page's counts come from. Owner decision
 * 2026-10-02: the minimum the API allows. The device check asks nothing (`IsSupportedAsync` / the key
 * is present); the enrolment is create/make + ONE sign/assert, its seal checked in memory with the key
 * just derived; every unlock is ONE. That the key REPRODUCES is proved by the first real unlock.
 */
export const PRESENCE_GESTURES = { probe: 0, enroll: 2, unlock: 1 } as const

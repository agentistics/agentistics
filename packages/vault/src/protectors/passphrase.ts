/**
 * passphrase.ts — the fallback when no system protector answers, and the optional second wrapper
 * (`agentop vault add-passphrase`) a Docker machine opens through.
 *
 * `scrypt(N = 2^17, r = 8, p = 1, 32-byte salt)` → KEK → AES-256-GCM over the DEK, AAD
 * `"agentistics-vault/v1/pass" ‖ kid`. The parameters are STORED in `dek.pass`, so they can be
 * raised later without breaking an existing vault.
 *
 * The passphrase is never stored, never logged, and never part of an error: a wrong one is
 * `denied` with no further detail (no "close", no length).
 */
import { randomBytes, scryptSync } from 'node:crypto'
import { aeadOpen, aeadSeal } from '../seal'
import type { Lang } from '../sentences'
import { bytes, text, type ProbeResult, type Protector, type ProtectorIo, type UnwrapResult } from './types'

export const PASS_FILE = 'dek.pass'
export const MIN_PASSPHRASE = 12

export interface ScryptParams {
  N: number
  r: number
  p: number
}
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 }

export type PassphraseCheck = { ok: true } | { ok: false; reason: 'empty' | 'short' | 'equals-secret' }

/**
 * PURE. Minimum length 12, refuse the empty string, and refuse a value equal to any secret being
 * migrated (a passphrase that IS the GitHub token protects nothing). No complexity theatre.
 */
export function checkPassphrase(pass: string, secretsBeingSealed: readonly string[] = []): PassphraseCheck {
  if (pass.length === 0) return { ok: false, reason: 'empty' }
  if ([...pass].length < MIN_PASSPHRASE) return { ok: false, reason: 'short' }
  if (secretsBeingSealed.some(s => s !== '' && s === pass)) return { ok: false, reason: 'equals-secret' }
  return { ok: true }
}

export function passphraseCheckSentence(r: 'empty' | 'short' | 'equals-secret', lang: Lang): string {
  const en = {
    empty: 'A passphrase is required — secrets are never stored in plain text.',
    short: `The passphrase must be at least ${MIN_PASSPHRASE} characters.`,
    'equals-secret': 'The passphrase must not be one of the secrets it protects.',
  }
  const pt = {
    empty: 'Uma frase-senha é obrigatória — segredos nunca são guardados em texto puro.',
    short: `A frase-senha precisa ter pelo menos ${MIN_PASSPHRASE} caracteres.`,
    'equals-secret': 'A frase-senha não pode ser um dos segredos que ela protege.',
  }
  return (lang === 'pt' ? pt : en)[r]
}

function aad(kid: string): Uint8Array {
  return bytes(`agentistics-vault/v1/pass\u0000${kid}`)
}

function kek(pass: string, salt: Uint8Array, p: ScryptParams): Uint8Array {
  return new Uint8Array(scryptSync(pass.normalize('NFC'), salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 160 * p.N * p.r + 1024 * 1024 }))
}

interface PassFile {
  kdf: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
  nonce: string
  ct: string
}

export function parsePassFile(raw: Uint8Array | null): PassFile | null {
  if (!raw) return null
  try {
    const o = JSON.parse(text(raw)) as Record<string, unknown>
    if (o.kdf !== 'scrypt') return null
    for (const k of ['N', 'r', 'p'] as const) if (typeof o[k] !== 'number' || !Number.isInteger(o[k]) || (o[k] as number) < 1) return null
    for (const k of ['salt', 'nonce', 'ct'] as const) if (typeof o[k] !== 'string') return null
    return o as unknown as PassFile
  } catch {
    return null
  }
}

export interface PassphraseOptions {
  io: ProtectorIo
  vaultDir: string
  /** The passphrase for THIS operation. Absent → the protector reports `denied` (it cannot ask). */
  passphrase?: string
  /** Lowered only by tests (scrypt at N=2^17 costs ~0.3 s and 128 MiB per call). */
  params?: ScryptParams
}

export function passphraseProtector(o: PassphraseOptions): Protector {
  const file = `${o.vaultDir}/${PASS_FILE}`
  return {
    id: 'passphrase',
    label: (lang: Lang) => lang === 'pt' ? 'uma frase-senha que você escolheu' : 'a passphrase you chose',
    async probe(): Promise<ProbeResult> {
      // A passphrase is always "available" — it is the fallback by construction, offered with the
      // no-protector sentence rather than detected.
      return o.passphrase ? { ok: true } : { ok: false, reason: 'no passphrase was given' }
    },
    async wrap(dek, kid) {
      if (!o.passphrase) return { ok: false, reason: 'no passphrase was given' }
      const p = o.params ?? DEFAULT_SCRYPT
      const salt = new Uint8Array(randomBytes(32))
      const nonce = new Uint8Array(randomBytes(12))
      const ct = aeadSeal(kek(o.passphrase, salt, p), nonce, aad(kid), dek)
      const body: PassFile = {
        kdf: 'scrypt', N: p.N, r: p.r, p: p.p,
        salt: Buffer.from(salt).toString('base64'), nonce: Buffer.from(nonce).toString('base64'), ct: Buffer.from(ct).toString('base64'),
      }
      await o.io.writeFile(file, bytes(JSON.stringify(body, null, 2) + '\n'))
      return { ok: true, record: { type: 'passphrase', createdAt: new Date().toISOString(), params: { file: PASS_FILE } } }
    },
    async unwrap(_r, kid): Promise<UnwrapResult> {
      const f = parsePassFile(await o.io.readFile(file))
      if (!f) return { ok: false, kind: 'missing', reason: `${PASS_FILE} is missing or unreadable` }
      if (!o.passphrase) return { ok: false, kind: 'denied', reason: 'the vault needs its passphrase' }
      const dek = aeadOpen(
        kek(o.passphrase, new Uint8Array(Buffer.from(f.salt, 'base64')), { N: f.N, r: f.r, p: f.p }),
        new Uint8Array(Buffer.from(f.nonce, 'base64')), aad(kid), new Uint8Array(Buffer.from(f.ct, 'base64')),
      )
      return dek && dek.length === 32 ? { ok: true, dek } : { ok: false, kind: 'denied', reason: 'wrong passphrase' }
    },
    async remove() {
      await o.io.removeFile(file).catch(() => {})
    },
  }
}

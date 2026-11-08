/**
 * vault-password.ts — the vault's OWN password as a PRESENCE protector (owner decision 2026-11-07,
 * COFRE.DESBLOQUEIO): the person proves it is them by typing it, on any operating system.
 *
 * It is a presence protector on purpose, not the old `passphrase` fallback: the human scope is locked at
 * every start and after every auto-lock, an unlock asks for it, and every action the vault confirms asks
 * for it again — exactly where Windows Hello or Touch ID would ask for a gesture.
 *
 *   KEK = scrypt(password NFC, salt 32 B, N = 2^17, r = 8, p = 1) → 32 bytes
 *   dek.password = { v:1, kdf:'scrypt', N, r, p, salt, wrapped }   wrapped = AES-256-GCM(KEK, DEK)
 *
 * scrypt is the key-derivation the vault already uses (passphrase.ts): memory-hard (128 MiB per try), so
 * a stolen `dek.password` costs an attacker that per guess. The password is never written anywhere,
 * never logged and never part of a reason: a wrong one is `denied` with no detail. The parameters are
 * stored in the file, so they can be raised later without breaking a vault.
 *
 * The password reaches this protector only as a constructor argument for ONE operation (the service
 * reads it from the request in flight and drops it with the request). Rules are checked by the caller
 * through `check` — the same function the page uses — and refused here too, before any key is made.
 */
import { randomBytes, scryptSync } from 'node:crypto'
import type { Lang } from '../sentences'
import { openDek, presenceReason, sealDek, zero } from './presence'
import { bytes, text, type ProbeResult, type Protector, type ProtectorIo, type UnwrapResult, type WrapperRecord } from './types'
import { DEFAULT_SCRYPT, type ScryptParams } from './passphrase'

export const PASSWORD_FILE = 'dek.password'

export interface VaultPasswordOptions {
  io: ProtectorIo
  vaultDir: string
  /** The password for THIS operation, or absent (then unwrap/derive answer `password-required`). */
  password?: string
  /** The rules (`checkVaultPassword` from @agentistics/core): true when the password may protect the vault. */
  check?: (pw: string) => boolean
  /** Lowered only by tests. */
  params?: ScryptParams
}

interface PasswordFile { v: 1; kdf: 'scrypt'; N: number; r: number; p: number; salt: string; wrapped: string }

export function parsePasswordFile(raw: Uint8Array | null): PasswordFile | null {
  if (!raw) return null
  try {
    const o = JSON.parse(text(raw)) as Record<string, unknown>
    if (o.v !== 1 || o.kdf !== 'scrypt') return null
    for (const k of ['N', 'r', 'p'] as const) if (typeof o[k] !== 'number' || !Number.isInteger(o[k]) || (o[k] as number) < 1) return null
    if (typeof o.salt !== 'string' || typeof o.wrapped !== 'string') return null
    return o as unknown as PasswordFile
  } catch { return null }
}

function kek(pw: string, salt: Uint8Array, p: ScryptParams): Uint8Array {
  return new Uint8Array(scryptSync(pw.normalize('NFC'), salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 160 * p.N * p.r + 1024 * 1024 }))
}

export function vaultPasswordProtector(o: VaultPasswordOptions): Protector {
  const file = `${o.vaultDir}/${PASSWORD_FILE}`
  const self: Protector = {
    id: 'password',
    label: (lang: Lang) => lang === 'pt' ? 'a senha do cofre, que só você sabe' : 'the vault password, which only you know',
    /** Always available — it needs nothing installed. Nothing is asked and nothing is written. */
    async probe(): Promise<ProbeResult> { return { ok: true } },
    async derive(_kid) {
      if (!o.password) return { ok: false, reason: presenceReason('presence-cancelled', 'password-required') }
      if (o.check && !o.check(o.password)) return { ok: false, reason: presenceReason('presence-cancelled', 'password-weak') }
      const p = o.params ?? DEFAULT_SCRYPT
      const salt = new Uint8Array(randomBytes(32))
      return { ok: true, held: { kek: kek(o.password, salt, p), fields: { salt: Buffer.from(salt).toString('base64'), N: String(p.N), r: String(p.r), p: String(p.p) } } }
    },
    async sealHeld(held, dek, kid) {
      const f = held.fields
      if (!f.salt || held.kek.length !== 32) return { ok: false, reason: presenceReason('presence-unavailable', 'bridge-failed') }
      const wrapped = sealDek(held.kek, dek, 'password', kid)
      const back = openDek(held.kek, wrapped, 'password', kid)
      const same = back !== null && Buffer.compare(Buffer.from(back), Buffer.from(dek)) === 0
      if (back) zero(back)
      if (!same) return { ok: false, reason: presenceReason('presence-unavailable', 'bridge-failed') }
      const body: PasswordFile = { v: 1, kdf: 'scrypt', N: Number(f.N), r: Number(f.r), p: Number(f.p), salt: f.salt, wrapped: Buffer.from(wrapped).toString('base64') }
      await o.io.writeFile(file, bytes(JSON.stringify(body) + '\n'))
      return { ok: true, record: { type: 'password', createdAt: new Date().toISOString(), params: { file: PASSWORD_FILE } } }
    },
    async discardHeld(held) { zero(held.kek) },
    async wrap(dek, kid) {
      const d = await self.derive!(kid)
      if (!d.ok) return d
      try { return await self.sealHeld!(d.held, dek, kid) } finally { zero(d.held.kek) }
    },
    async unwrap(_record: WrapperRecord, kid: string): Promise<UnwrapResult> {
      const f = parsePasswordFile(await o.io.readFile(file))
      if (!f) return { ok: false, kind: 'missing', reason: presenceReason('presence-lost', 'file-missing') }
      if (!o.password) return { ok: false, kind: 'denied', reason: presenceReason('presence-cancelled', 'password-required') }
      const k = kek(o.password, new Uint8Array(Buffer.from(f.salt, 'base64')), { N: f.N, r: f.r, p: f.p })
      const dek = openDek(k, new Uint8Array(Buffer.from(f.wrapped, 'base64')), 'password', kid)
      zero(k)
      return dek ? { ok: true, dek } : { ok: false, kind: 'denied', reason: presenceReason('presence-cancelled', 'password-wrong') }
    },
    async remove() { await o.io.removeFile(file).catch(() => {}) },
  }
  return self
}

/** PURE. Which password failure a protector reason carries, or null when it is not one. */
export function passwordFailure(reason: string): 'password-required' | 'password-wrong' | 'password-weak' | null {
  const m = /(password-required|password-wrong|password-weak)$/.exec(reason)
  return m ? (m[1] as 'password-required' | 'password-wrong' | 'password-weak') : null
}

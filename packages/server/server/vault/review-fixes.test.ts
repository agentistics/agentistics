/**
 * SECRETS.4 independent review (t-afdb361ae7, ~/.agentistics/leader/briefs/secrets4-review-findings.md):
 * one test per finding, each written to FAIL on the code as reviewed and pass once fixed. Fakes as in
 * gate.test.ts — a silent "dpapi", a "hello" that counts gestures — and a fake clock; nothing spawned.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base32Decode, hotp, type Protector, type ProtectorId, type UnwrapResult } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, sealToFile } from './service'
import { __resetGateForTests, beginAuthenticator, beginRecoveryKey, confirmAuthenticator, confirmRecoveryKey, enrolPresence } from './gate'

const STORE = new Map<string, Uint8Array>()
type Fake = Protector & { gestures: number; wrapFails: string | null }
function fake(id: ProtectorId): Fake {
  const self: Fake = {
    id, gestures: 0, wrapFails: null,
    label: () => (id === 'hello' ? 'Windows Hello (fake)' : 'DPAPI (fake)'),
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) {
      if (self.wrapFails) return { ok: false as const, reason: self.wrapFails }
      STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: 'x' } }
    },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> {
      if (id === 'hello') self.gestures++
      const d = STORE.get(`${id}:${kid}`)
      return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'gone' }
    },
    async remove(_r: unknown, kid: string) { STORE.delete(`${id}:${kid}`) },
  }
  return self
}

export let T = 1_800_000_000_000
const clock = () => T
let seed: Uint8Array
export const codeAt = (o = 0) => hotp(seed, Math.floor(T / 30_000) + o)
export const next = () => { T += 30_000 }
export let dir = ''
export let dpapi = fake('dpapi')
export let hello = fake('hello')
export const S = { session: 'socket' }

export function restart(): void {
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi, hello], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock)
  __resetGateForTests(clock)
}

/** A SECRETS.2 vault (silent DPAPI) holding one sealed secret. */
export async function silentVault(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-review-'))
  dpapi = fake('dpapi'); hello = fake('hello')
  restart()
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('MARK'))
}

/** …plus the authenticator and a recovery key (through the socket session), presence NOT yet enrolled. */
export async function enrolledVault(): Promise<{ words: string[] }> {
  await silentVault()
  const a = await beginAuthenticator(S, 'box')
  if (!a.ok) throw new Error(a.sentence)
  seed = base32Decode(a.secret)
  const c = await confirmAuthenticator(codeAt(-1), codeAt(0))
  if (!c.ok) throw new Error(c.sentence)
  next()
  const r = await beginRecoveryKey(S)
  if (!r.ok) throw new Error(r.sentence)
  const k = await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!))
  if (!k.ok) throw new Error(k.sentence)
  return { words: r.words }
}

beforeEach(() => { STORE.clear() })

describe('step 0 — a presence enrolment failure reaches the UI as a sentence, never a reason code', () => {
  test('the bridge failure is said in words (EN), with no code and no .NET name', async () => {
    await enrolledVault()
    hello.wrapFails = 'presence-unavailable: bridge-failed'
    const r = await enrolPresence('hello', { ...S, code: codeAt() })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('presence-unavailable')
    expect(r.sentence).not.toContain('presence-unavailable')
    expect(r.sentence).not.toContain('bridge-failed')
    expect(r.sentence).toContain('Windows Hello')
  })
  test('a reason that is not a presence code still becomes a sentence, not the raw text', async () => {
    await enrolledVault()
    hello.wrapFails = 'no-hmac-secret: this security key does not support hmac-secret'
    const r = await enrolPresence('hello', { ...S, code: codeAt() })
    expect(!r.ok && r.sentence).not.toMatch(/^no-hmac-secret:/)
  })
})

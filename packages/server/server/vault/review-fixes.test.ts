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

// ── M1: no cross-site request may drive a vault action ─────────────────────────────────────────

import { handleVaultHttp } from './http'
import { stepUpState } from './gate'
import { autoLockRemainingMs } from './service'

async function post(path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request(`http://127.0.0.1:47291${path}`, { method: 'POST', headers, ...(body !== undefined ? { body } : {}) })
  const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'local' })
  const t = res ? await res.text() : ''
  return { status: res?.status ?? 404, json: t.startsWith('{') ? JSON.parse(t) : {} }
}
const CODE = JSON.stringify({ code: '000000' })
const CROSS = { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }
const SAME = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:47291' }

describe('M1 — CSRF: /api/vault POSTs need a same-origin proof AND a JSON body type, cookie or not', () => {
  test('a text/plain "simple" POST (no preflight) is refused and counts no failure', async () => {
    await enrolledVault()
    const r = await post('/api/vault/stepup', { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' }, CODE)
    expect(r.json.code).toBe('not-json')
    expect((await stepUpState()).failures).toBe(0)
  })
  test('a cross-site POST cannot freeze the gate (25 tries, 0 failures counted)', async () => {
    await enrolledVault()
    for (let i = 0; i < 25; i++) { T += 31 * 60_000; expect((await post('/api/vault/stepup', CROSS, CODE)).json.code).toBe('not-same-origin') }
    const s = await stepUpState()
    expect(s.failures).toBe(0)
    expect(s.frozen).toBe(false)
  })
  test('a request with no Origin and no Sec-Fetch-Site (not a browser page of ours) is refused', async () => {
    await enrolledVault()
    expect((await post('/api/vault/stepup', { 'content-type': 'application/json' }, CODE)).json.code).toBe('not-same-origin')
    expect((await stepUpState()).failures).toBe(0)
  })
  test('a cross-site ping cannot keep the vault from auto-locking', async () => {
    await enrolledVault()
    T += 29 * 60_000
    const before = autoLockRemainingMs()
    await post('/api/vault/activity', CROSS, '{}')
    expect(autoLockRemainingMs()).toBe(before)
  })
  test('a cross-site POST cannot raise a presence gesture', async () => {
    await enrolledVault()
    const g = hello.gestures
    expect((await post('/api/vault/unlock', CROSS, '{}')).json.code).toBe('not-same-origin')
    expect(hello.gestures).toBe(g)
  })
  test('the dashboard itself (same-origin, JSON) still works — a wrong code is judged', async () => {
    await enrolledVault()
    const r = await post('/api/vault/stepup', SAME, CODE)
    expect(r.json.code).toBe('stepup-wrong')
    expect((await stepUpState()).failures).toBe(1)
  })
  test('an older browser without Sec-Fetch-Site passes on a matching Origin only', async () => {
    await enrolledVault()
    expect((await post('/api/vault/stepup', { 'content-type': 'application/json', origin: 'http://127.0.0.1:47291' }, CODE)).json.code).toBe('stepup-wrong')
    expect((await post('/api/vault/stepup', { 'content-type': 'application/json', origin: 'http://evil.example' }, CODE)).json.code).toBe('not-same-origin')
    expect((await stepUpState()).failures).toBe(1)
  })
})

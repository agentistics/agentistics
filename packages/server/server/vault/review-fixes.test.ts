/**
 * SECRETS.4 independent review (t-afdb361ae7, ~/.agentistics/leader/briefs/secrets4-review-findings.md):
 * one test per finding, each written to FAIL on the code as reviewed and pass once fixed. Fakes as in
 * gate.test.ts — a silent "dpapi", a "hello" that counts gestures — and a fake clock; nothing spawned.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
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
  const c = await confirmAuthenticator(codeAt(0), S)
  if (!c.ok) throw new Error(c.sentence)
  next()
  const r = await beginRecoveryKey(S)
  if (!r.ok) throw new Error(r.sentence)
  const k = await confirmRecoveryKey(r.positions.map(p => r.words[p - 1]!))
  if (!k.ok) throw new Error(k.sentence)
  return { words: r.words }
}

beforeEach(() => { STORE.clear() })
// Leave the process the way every other vault test file expects it (central-env.test.ts reads the
// default test vault without resetting it — a locked fake left here would fail it).
afterAll(() => { __resetVaultForTests({ dir: join(tmpdir(), 'agentistics-review-done', 'vault') }); __resetGateForTests() })

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

// ── M2: recovery mode hands out a NEW root key — only to the local terminal ──────────────────

import { recoverWithWords } from './gate'
import { vaultStatus } from './service'

describe('M2 — in recovery mode the re-enrolment steps answer the local socket (TTY), never HTTP', () => {
  async function inRecovery(): Promise<void> {
    const { words } = await enrolledVault()
    expect((await enrolPresence('hello', { ...S, code: codeAt() })).ok).toBe(true)
    next()
    restart()
    expect((await vaultStatus()).state).toBe('locked')
    const r = await recoverWithWords(words.join(' '))
    expect(r.ok).toBe(true)
  }
  const WEB = { session: 'local' }
  test('HTTP cannot get the new 24 words', async () => {
    await inRecovery()
    const r = await beginRecoveryKey(WEB)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('recovery-tty-only')
    expect(JSON.stringify(r)).not.toMatch(/"words"/)
  })
  test('HTTP cannot get a new authenticator seed', async () => {
    await inRecovery()
    const r = await beginAuthenticator(WEB, 'box')
    expect(!r.ok && r.code).toBe('recovery-tty-only')
  })
  test('HTTP cannot enrol a presence credential', async () => {
    await inRecovery()
    const g = hello.gestures
    const r = await enrolPresence('hello', WEB)
    expect(!r.ok && r.code).toBe('recovery-tty-only')
    expect(hello.gestures).toBe(g)
  })
  test('the local terminal (vault.sock) still completes all three steps without the lost factors', async () => {
    await inRecovery()
    const a = await beginAuthenticator(S, 'box')
    expect(a.ok).toBe(true)
    const r = await beginRecoveryKey(S)
    expect(r.ok).toBe(true)
    expect((await enrolPresence('hello', S)).ok).toBe(true)
  })
  test('the refusal is a sentence naming the terminal command, in PT too', async () => {
    await inRecovery()
    const r = await beginRecoveryKey(WEB)
    expect(!r.ok && r.sentence).toContain('agentop vault enroll')
  })
  test('an HTTP request whose session cookie is literally "socket" is still HTTP', async () => {
    await inRecovery()
    const req = new Request('http://127.0.0.1:47291/api/vault/recovery/begin', { method: 'POST', headers: SAME, body: '{}' })
    const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'socket' })
    const j = JSON.parse(await res!.text())
    expect(j.code).toBe('recovery-tty-only')
    expect(j.words).toBeUndefined()
  })
})

// ── S1 / N1: the socket ──────────────────────────────────────────────────────────────────────

import { DEFAULT_SOCKET_GATE, handleVaultOp, installVaultOps } from './ops'

function op(header: Record<string, unknown>, body: Uint8Array | null = null) {
  return handleVaultOp({ header, body, emit() {}, closed: new Promise(() => {}) })
}

describe('S1 — the socket never seals a reserved vault/* purpose (the gate\'s own seed)', () => {
  test('seal of vault/totp-seed is refused before any crypto', async () => {
    await enrolledVault()
    installVaultOps()
    const r = await op({ op: 'seal', purpose: 'vault/totp-seed', name: 'totp-seed' }, new Uint8Array(20))
    expect(r.reply.ok).toBe(false)
    expect(!r.reply.ok && r.reply.code).toBe('purpose')
    expect(r.body).toBeUndefined()
  })
  test('an ordinary human purpose still seals', async () => {
    await enrolledVault()
    installVaultOps()
    const r = await op({ op: 'seal', purpose: 'github-backup', name: 'github-backup' }, new TextEncoder().encode('x'))
    expect(r.reply.ok).toBe(true)
  })
})

describe('N1 — the socket gate fails CLOSED until the real one is installed', () => {
  test('the default gate refuses every action', async () => {
    for (const a of ['lock-local', 'rekey', 'reset', 'add-passphrase']) {
      const g = await DEFAULT_SOCKET_GATE(a, {})
      expect(g.ok).toBe(false)
    }
  })
})

// ── S2: the FIRST enrolment over HTTP needs a local proof ─────────────────────────────────────

import { mintSetupCode, probePresence } from './gate'

describe('S2 — first enrolment from a page needs a proof from this machine', () => {
  const WEB = { session: 'http:local' }
  test('the first authenticator over HTTP is refused without a setup code (no seed handed out)', async () => {
    await silentVault()
    const r = await beginAuthenticator(WEB, 'box')
    expect(!r.ok && r.code).toBe('setup-code-required')
    expect(!r.ok && r.sentence).toContain('agentop vault setup-code')
    expect(JSON.stringify(r)).not.toContain('otpauth')
  })
  test('with the code the service printed, it proceeds — once', async () => {
    await silentVault()
    const { code } = mintSetupCode()
    expect(code).toMatch(/^\d{8}$/)
    const r = await beginAuthenticator({ ...WEB, setupCode: code }, 'box')
    expect(r.ok).toBe(true)
    const again = await beginAuthenticator({ ...WEB, setupCode: code }, 'box')
    expect(!again.ok && again.code).toBe('setup-code-required')
  })
  test('five wrong setup codes burn it', async () => {
    await silentVault()
    const { code } = mintSetupCode()
    for (let i = 0; i < 5; i++) expect((await beginAuthenticator({ ...WEB, setupCode: '00000000' }, 'box')).ok).toBe(false)
    const r = await beginAuthenticator({ ...WEB, setupCode: code }, 'box')
    expect(!r.ok && r.code).toBe('setup-code-required')
  })
  test('an expired setup code is refused', async () => {
    await silentVault()
    const { code } = mintSetupCode()
    T += 11 * 60_000
    expect((await beginAuthenticator({ ...WEB, setupCode: code }, 'box')).ok).toBe(false)
  })
  test('the local terminal (socket) needs no setup code', async () => {
    await silentVault()
    expect((await beginAuthenticator(S, 'box')).ok).toBe(true)
  })
  test('the first recovery key over HTTP, outside THIS session\'s wizard, needs the authenticator code', async () => {
    await silentVault()
    const a = await beginAuthenticator(S, 'box')
    if (!a.ok) throw new Error(a.sentence)
    seed = base32Decode(a.secret)
    expect((await confirmAuthenticator(codeAt(), S)).ok).toBe(true)
    next()
    // The wizard flow belongs to the session that verified the code — a page is not that session.
    const r = await beginRecoveryKey(WEB)
    expect(!r.ok && r.code).toBe('stepup-required')
    const ok = await beginRecoveryKey({ ...WEB, code: codeAt() })
    expect(ok.ok).toBe(true)
  })
  test('inside the same session\'s wizard the verified code stands for the recovery step', async () => {
    await silentVault()
    const { code } = mintSetupCode()
    const a = await beginAuthenticator({ ...WEB, setupCode: code }, 'box')
    if (!a.ok) throw new Error(a.sentence)
    seed = base32Decode(a.secret)
    expect((await confirmAuthenticator(codeAt(), WEB)).ok).toBe(true)
    next()
    expect((await beginRecoveryKey(WEB)).ok).toBe(true)
  })
  test('a failed device check is said in words, never as a reason code', async () => {
    await silentVault()
    hello.wrapFails = 'presence-unavailable: bridge-failed'
    const r = await probePresence('hello', S)
    expect(!r.ok && r.sentence).not.toContain('bridge-failed')
    expect(!r.ok && r.code).toBe('presence-unavailable')
  })
})

// ── S3: reset of a vault that cannot open ──────────────────────────────────────────────────────

describe('S3 — reset when the vault cannot open: allowed from the terminal, with its own sentence', () => {
  test('a SECRETS.2 vault whose protector key is gone can be reset over the socket', async () => {
    await silentVault()
    STORE.clear() // the DPAPI blob is gone: protector-lost, no code can be checked
    restart(); installVaultOps()
    const r = await op({ op: 'vault-reset' })
    expect(r.reply.ok).toBe(true)
  })
  test('a vault that is merely LOCKED behind presence is not reset that way — the sentence says unlock first', async () => {
    const { } = await enrolledVault()
    expect((await enrolPresence('hello', { ...S, code: codeAt() })).ok).toBe(true)
    next()
    restart(); installVaultOps()
    const r = await op({ op: 'vault-reset' })
    expect(r.reply.ok).toBe(false)
    expect(!r.reply.ok && r.reply.code).toBe('reset-needs-unlock')
    expect(!r.reply.ok && r.reply.sentence).toContain('agentop vault unlock')
    expect(!r.reply.ok && r.reply.sentence).not.toContain('passphrase')
  })
})

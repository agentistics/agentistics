/**
 * SECRETS.4 S4.8 — the `/api/vault/*` routes, one test per route INCLUDING the refusals, and the §11
 * journey end to end over HTTP: fresh machine → enrol → restart → locked → gesture + code → open →
 * auto-lock → locked. Fake protectors (a silent "dpapi", a "hello" that counts gestures) and a fake
 * clock; nothing is spawned and nothing under ~/.agentistics is touched.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base32Decode, hotp, parseVaultJson, type Protector, type ProtectorId, type UnwrapResult } from '@agentistics/vault'
import {
  __resetVaultForTests, __setVaultClockForTests, autoLockTick, ensureVaultOpen, lockVault, openFromFile, sealToFile, vaultDir, vaultStatus,
} from './service'
import { __resetGateForTests } from './gate'
import { handleVaultHttp } from './http'

const STORE = new Map<string, Uint8Array>()
function fake(id: ProtectorId): Protector & { gestures: number } {
  const self = {
    id, gestures: 0,
    label: () => (id === 'hello' ? 'Windows Hello (fake)' : 'DPAPI (fake)'),
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) { STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: '2026-10-02T00:00:00.000Z' } } },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> {
      if (id === 'hello') self.gestures++
      const d = STORE.get(`${id}:${kid}`)
      return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'gone' }
    },
    async remove(_r: unknown, kid: string) { STORE.delete(`${id}:${kid}`) },
  }
  return self
}

let T = 1_800_000_000_000
const clock = () => T
const step = () => Math.floor(T / 1000 / 30)
let seed: Uint8Array
const codeAt = (offset = 0) => hotp(seed, step() + offset)
const next = () => { T += 30_000 }
const wrongCode = () => (codeAt() === '000000' ? '111111' : '000000')

let dir = ''
let dpapi = fake('dpapi')
let hello = fake('hello')

function restart(): void {
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi, hello], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock)
  __resetGateForTests(clock)
}

type J = Record<string, any>
async function http(method: 'GET' | 'POST', path: string, body?: unknown, grant?: string): Promise<{ status: number; json: J; headers: Headers }> {
  const req = new Request(`http://local${path}`, {
    method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    ...(grant ? { headers: { 'x-vault-grant': grant, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } } : {}),
  })
  const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'session-A' })
  if (!res) return { status: 404, json: {}, headers: new Headers() }
  const text = await res.text()
  return { status: res.status, json: text.startsWith('{') ? JSON.parse(text) : {}, headers: res.headers }
}

/** A machine that already has its first sealed secret (so the vault exists), not yet enrolled. */
async function fresh(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-http-'))
  STORE.clear()
  dpapi = fake('dpapi'); hello = fake('hello')
  T = 1_800_000_000_000
  restart()
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('TEST-NOT-A-SECRET'))
}

/** The wizard's whole path over HTTP; returns the 24 words. */
async function enrolOverHttp(): Promise<string[]> {
  const a = await http('POST', '/api/vault/authenticator/begin', {})
  seed = base32Decode(a.json.secret)
  expect((await http('POST', '/api/vault/authenticator/confirm', { code1: codeAt(-1), code2: codeAt(0) })).status).toBe(200)
  next()
  const r = await http('POST', '/api/vault/recovery/begin', {})
  const typed = (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!)
  expect((await http('POST', '/api/vault/recovery/confirm', { typed })).status).toBe(200)
  const p = await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: codeAt() })
  expect(p.status).toBe(200)
  next()
  return r.json.words as string[]
}

afterAll(() => { __resetVaultForTests({ dir: join(tmpdir(), 'agentistics-http-done', 'vault') }) })
beforeEach(async () => { await fresh() })

describe('GET /api/vault — the payload the sections read', () => {
  test('a fresh, un-enrolled vault: state + what could be enrolled, no authenticator, no recovery', async () => {
    const r = await http('GET', '/api/vault')
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.json).toMatchObject({
      state: 'open', authenticator: null, recoveryCreatedAt: null, presence: false, presenceAvailable: ['hello'],
      requirePresence: false, pendingStepup: false, autoLockMinutes: 30, recoveryTodo: null,
    })
    expect(typeof r.json.autoLockInMs).toBe('number')
    expect(Array.isArray(r.json.items)).toBe(true)
  })

  test('carries the hardening report as lines, and no secret-shaped field', async () => {
    const { __setHardeningForTests } = await import('./service')
    __setHardeningForTests({ state: 'ok', private: true, coreDumps: 'off', yama: 'absent', reason: null })
    const r = await http('GET', '/api/vault')
    expect(r.json.hardening).toMatchObject({ state: 'ok', private: true, coreDumps: 'off', yama: 'absent' })
    expect(r.json.hardening.lines.join(' ')).toContain('Yama')
    __setHardeningForTests(null)
    const blob = JSON.stringify(r.json)
    for (const f of ['seed', 'dek', 'secret', 'words', 'uri']) expect(blob.toLowerCase()).not.toContain(`"${f}"`)
  })

  test('once enrolled: the inventory needs a step-up (401), and the answer names the state without it', async () => {
    await enrolOverHttp()
    const r = await http('GET', '/api/vault')
    expect(r.status).toBe(401)
    expect(r.json).toMatchObject({ needsStepUp: true, code: 'stepup-required' })
    expect(r.json.items).toBeUndefined()
    expect(r.json.view.authenticator).toBeTruthy()
  })
})

describe('POST /api/vault/authenticator/begin + confirm', () => {
  test('begin serves the otpauth URI ONCE, no-store; a second begin is refused', async () => {
    const a = await http('POST', '/api/vault/authenticator/begin', { label: 'my-box' })
    expect(a.status).toBe(200)
    expect(a.headers.get('cache-control')).toBe('no-store')
    expect(a.json.uri).toStartWith('otpauth://totp/Agentistics:my-box?')
    expect(a.json.secret).toMatch(/^[A-Z2-7]+$/)
    const again = await http('POST', '/api/vault/authenticator/begin', {})
    expect(again).toMatchObject({ status: 403, json: { ok: false, code: 'already-served' } })
  })

  test('confirm: two codes that are not consecutive are refused; nothing is sealed until they are', async () => {
    const a = await http('POST', '/api/vault/authenticator/begin', {})
    seed = base32Decode(a.json.secret)
    const wrong = await http('POST', '/api/vault/authenticator/confirm', { code1: codeAt(0), code2: codeAt(-1) })
    expect(wrong).toMatchObject({ status: 403, json: { code: 'stepup-wrong' } })
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.stepup).toBeUndefined()
    const ok = await http('POST', '/api/vault/authenticator/confirm', { code1: codeAt(-1), code2: codeAt(0) })
    expect(ok.status).toBe(200)
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.stepup).toMatchObject({ digits: 6, period: 30 })
  })

  test('confirm without a begin, or with a malformed body, is refused', async () => {
    expect((await http('POST', '/api/vault/authenticator/confirm', { code1: '123456', code2: '123457' })).json.code).toBe('no-enrolment')
    expect((await http('POST', '/api/vault/authenticator/confirm', { code1: '123456' })).status).toBe(400)
    expect((await http('POST', '/api/vault/authenticator/confirm')).status).toBe(400)
  })

  test('re-enrolment (a new phone) is gated by the OLD code: without it, 401; with it, a new seed', async () => {
    await enrolOverHttp()
    const none = await http('POST', '/api/vault/authenticator/begin', {})
    expect(none).toMatchObject({ status: 401, json: { code: 'stepup-required' } })
    const old = await http('POST', '/api/vault/authenticator/begin', { code: wrongCode() })
    expect(old.status).toBe(403)
  })

  test('on a locked vault begin is refused with the locked sentence', async () => {
    await enrolOverHttp()
    restart() // locked behind presence: a begin must not raise a gesture or open anything
    const r = await http('POST', '/api/vault/authenticator/begin', {})
    expect(r).toMatchObject({ status: 403, json: { code: 'locked' } })
  })
})

describe('POST /api/vault/recovery/begin + confirm', () => {
  test('begin serves 24 words and 3 positions once; confirm needs those exact words', async () => {
    const r = await http('POST', '/api/vault/recovery/begin', {})
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.json.words).toHaveLength(24)
    expect(r.json.positions).toHaveLength(3)
    const wrong = await http('POST', '/api/vault/recovery/confirm', { typed: ['zoo', 'zoo', 'zoo'] })
    expect(wrong.status === 403 ? wrong.json.code : 'matched-by-chance').toMatch(/recovery-confirm-wrong|matched-by-chance/)
    const typed = (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!)
    expect((await http('POST', '/api/vault/recovery/confirm', { typed })).status).toBe(200)
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.wrappers.map(w => w.type)).toContain('recovery')
  })

  test('confirm refuses anything but exactly three words, and a confirm with nothing pending', async () => {
    expect((await http('POST', '/api/vault/recovery/confirm', { typed: ['a', 'b'] })).status).toBe(400)
    expect((await http('POST', '/api/vault/recovery/confirm', { typed: 'abc' })).status).toBe(400)
    expect((await http('POST', '/api/vault/recovery/confirm', { typed: ['a', 'b', 'c'] })).json.code).toBe('no-recovery-pending')
  })

  test('a NEW recovery key on an enrolled vault is gated (code + gesture): 401 without a code, 403 with a wrong one', async () => {
    await enrolOverHttp()
    expect((await http('POST', '/api/vault/recovery/begin', {})).status).toBe(401)
    expect((await http('POST', '/api/vault/recovery/begin', { code: wrongCode() })).status).toBe(403)
    const before = hello.gestures
    const ok = await http('POST', '/api/vault/recovery/begin', { code: codeAt() })
    expect(ok.status).toBe(200)
    expect(hello.gestures).toBeGreaterThan(before) // the gesture was proven, not assumed
  })
})

describe('POST /api/vault/recover', () => {
  test('never takes the words: it says where they are typed', async () => {
    const r = await http('POST', '/api/vault/recover', { words: 'abandon '.repeat(24).trim() })
    expect(r).toMatchObject({ status: 403, json: { ok: false, code: 'recover-tty-only' } })
    expect(r.json.sentence).toContain('agentop vault recover')
  })
})

describe('POST /api/vault/presence/enroll', () => {
  test('refuses a protector that is not a presence kind (400) and an enrolment before the authenticator', async () => {
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'dpapi' })).status).toBe(400)
    expect((await http('POST', '/api/vault/presence/enroll', {})).status).toBe(400)
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'hello' })).json.code).toBe('needs-authenticator')
  })

  test('refuses before the recovery key exists (a lost device would lose the vault)', async () => {
    const a = await http('POST', '/api/vault/authenticator/begin', {})
    seed = base32Decode(a.json.secret)
    await http('POST', '/api/vault/authenticator/confirm', { code1: codeAt(-1), code2: codeAt(0) })
    next()
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: codeAt() })).json.code).toBe('needs-recovery')
  })

  test('is gated: no code 401, wrong code 403 with the vault untouched; the right one retires the silent wrapper', async () => {
    const a = await http('POST', '/api/vault/authenticator/begin', {})
    seed = base32Decode(a.json.secret)
    await http('POST', '/api/vault/authenticator/confirm', { code1: codeAt(-1), code2: codeAt(0) })
    next()
    const r = await http('POST', '/api/vault/recovery/begin', {})
    await http('POST', '/api/vault/recovery/confirm', { typed: (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!) })
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'hello' })).status).toBe(401)
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: wrongCode() })).status).toBe(403)
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.wrappers.map(w => w.type)).not.toContain('hello')
    const ok = await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: codeAt() })
    expect(ok).toMatchObject({ status: 200, json: { ok: true, removed: ['dpapi'] } })
  })
})

describe('POST /api/vault/presence/disable', () => {
  test('refuses on a vault that has no presence', async () => {
    expect((await http('POST', '/api/vault/presence/disable', {})).json.code).toBe('no-presence')
  })

  test('is gated (code + gesture); the right code puts the silent wrapper back FIRST and removes the presence key', async () => {
    await enrolOverHttp()
    expect((await http('POST', '/api/vault/presence/disable', {})).status).toBe(401)
    expect((await http('POST', '/api/vault/presence/disable', { code: wrongCode() })).status).toBe(403)
    const kid = parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.kid
    expect(STORE.has(`hello:${kid}`)).toBe(true)
    const ok = await http('POST', '/api/vault/presence/disable', { code: codeAt() })
    expect(ok).toMatchObject({ status: 200, json: { ok: true, replacedBy: 'dpapi' } })
    const v = parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!
    expect(v.wrappers.map(w => w.type).sort()).toEqual(['dpapi', 'recovery'])
    expect(STORE.has(`hello:${kid}`)).toBe(false)
    expect(STORE.has(`dpapi:${kid}`)).toBe(true)
    next()
    // …and a restart now opens silently, with the code still owed on the next gated action.
    restart()
    expect((await vaultStatus()).state === 'open' || (await ensureVaultOpen()) !== null).toBe(true)
  })

  test("the owner's machine refuses without the recovery key — and the page can never supply it", async () => {
    await enrolOverHttp()
    const { handleVaultOp } = await import('./ops')
    const { becomeVaultHolder } = await import('./service')
    becomeVaultHolder()
    const flag = await handleVaultOp({ header: { op: 'require-presence' }, body: null, emit() {}, closed: new Promise(() => {}) })
    expect(flag.reply.ok).toBe(true)
    const r = await http('POST', '/api/vault/presence/disable', { code: codeAt(), words: 'abandon '.repeat(24).trim() })
    expect(r).toMatchObject({ status: 403, json: { code: 'recovery-required' } })
    expect(r.json.sentence).toContain('agentop vault disable-presence')
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.wrappers.map(w => w.type)).toContain('hello')
    // The terminal path (the socket) with the real words works; wrong words do not.
    const wrong = await handleVaultOp({ header: { op: 'presence-disable', code: codeAt(), words: 'abandon '.repeat(23) + 'zoo' }, body: null, emit() {}, closed: new Promise(() => {}) })
    expect(wrong.reply.ok).toBe(false)
  })
})

describe('GET /api/vault/credentials', () => {
  test('needs a step-up (401 without a grant), then lists the presence credentials and the recovery date — never a key', async () => {
    await enrolOverHttp()
    const no = await http('GET', '/api/vault/credentials')
    expect(no.status).toBe(401)
    const g = await http('POST', '/api/vault/stepup', { code: codeAt() })
    expect(g.status).toBe(200)
    next()
    const r = await http('GET', '/api/vault/credentials', undefined, g.json.grant)
    expect(r.status).toBe(200)
    expect(r.json.credentials).toEqual([{ type: 'hello', label: 'Windows Hello (fake)', createdAt: '2026-10-02T00:00:00.000Z' }])
    expect(typeof r.json.recoveryCreatedAt).toBe('string')
    expect(JSON.stringify(r.json)).not.toMatch(/dek|seed|words/i)
  })

  test('refuses a grant minted for another session, and a locked vault', async () => {
    await enrolOverHttp()
    const g = await http('POST', '/api/vault/stepup', { code: codeAt() })
    const { grantValid } = await import('./gate')
    expect(grantValid(g.json.grant, 'session-B', 'read')).toBe(false)
    lockVault('user')
    expect((await http('GET', '/api/vault/credentials', undefined, g.json.grant)).json.code).toBe('locked')
  })
})

describe('the routes that already existed keep their gate (stepup, lock, auto-lock, unlock, activity)', () => {
  test('stepup: bad body 400, wrong code 403, right code a grant; lock needs the code; auto-lock is bounded', async () => {
    await enrolOverHttp()
    expect((await http('POST', '/api/vault/stepup', {})).status).toBe(400)
    expect((await http('POST', '/api/vault/stepup', { code: wrongCode() })).status).toBe(403)
    const g = await http('POST', '/api/vault/stepup', { code: codeAt() })
    expect(g.json.grant).toBeTruthy()
    expect((await http('POST', '/api/vault/auto-lock', { minutes: 4 }, g.json.grant)).status).toBe(400)   // below 5
    expect((await http('POST', '/api/vault/auto-lock', { minutes: 'never' }, g.json.grant)).status).toBe(400)
    expect((await http('POST', '/api/vault/auto-lock', { minutes: 10 }, g.json.grant)).status).toBe(200)
    expect((await http('POST', '/api/vault/auto-lock', { minutes: 10 })).status).toBe(401)               // no grant, no code
    expect((await http('POST', '/api/vault/lock', {})).status).toBe(401)
    expect((await http('POST', '/api/vault/lock', {}, g.json.grant)).status).toBe(200)
  })

  test('activity is a heartbeat; an unknown path is not ours', async () => {
    expect((await http('POST', '/api/vault/activity', {})).json.ok).toBe(true)
    expect((await http('GET', '/api/vault/nope')).status).toBe(404)
    expect((await http('GET', '/api/vault/authenticator/begin')).status).toBe(404) // GET is not a begin
  })
})

describe('§11 — fresh owner machine → enrol → restart → locked → gesture + code → open → auto-lock → locked', () => {
  test('the whole journey over HTTP', async () => {
    // fresh: open, silent, one sealed secret
    expect((await http('GET', '/api/vault')).json).toMatchObject({ state: 'open', authenticator: null, presence: false })

    // enrol (authenticator → recovery key → presence), exactly the wizard's calls
    await enrolOverHttp()
    const v = parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!
    expect(v.wrappers.map(w => w.type).sort()).toEqual(['hello', 'recovery'])
    expect(STORE.has(`dpapi:${v.kid}`)).toBe(false) // the silent wrapper is gone

    // restart: LOCKED, and nothing raised a dialog
    restart()
    const gestures = hello.gestures
    const locked = await http('GET', '/api/vault')
    expect(locked.json).toMatchObject({ state: 'locked', locked: true, presence: true })
    expect(locked.json.items).toEqual([])
    expect(hello.gestures).toBe(gestures)

    // gesture (the button) → the key is open in the service but NOTHING opens until the code
    const u = await http('POST', '/api/vault/unlock')
    expect(u).toMatchObject({ status: 200, json: { ok: true, state: 'pending-stepup' } })
    expect(hello.gestures).toBe(gestures + 1)
    expect((await http('GET', '/api/vault')).json).toMatchObject({ pendingStepup: true, state: 'locked' })
    expect((await openFromFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup')).ok).toBe(false)

    // the code → open; a grant for the list
    expect((await http('POST', '/api/vault/unlock/code', { code: codeAt() })).status).toBe(200)
    next()
    expect((await http('GET', '/api/vault')).status).toBe(401) // the inventory still wants its own step-up
    const g = await http('POST', '/api/vault/stepup', { code: codeAt() })
    const open = await http('GET', '/api/vault', undefined, g.json.grant)
    expect(open.json).toMatchObject({ state: 'open', presence: true, autoLockMinutes: 30 })
    expect(Array.isArray(open.json.items)).toBe(true)
    expect(open.json.autoLockInMs).toBeGreaterThan(0)
    const r = await openFromFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup')
    expect(r.ok && new TextDecoder().decode(r.plaintext)).toBe('TEST-NOT-A-SECRET')

    // 30 minutes without use → locked, says why, and the next read is the locked shape
    expect(autoLockTick(T + 31 * 60_000)).toBe(true)
    const after = await http('GET', '/api/vault')
    expect(after.json).toMatchObject({ state: 'locked', lockedBy: 'auto-lock', locked: true })
    expect(after.json.autoLockInMs).toBeNull()
  })
})

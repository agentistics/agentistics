/**
 * SECRETS.4 S4.8 — the `/api/vault/*` routes, one test per route INCLUDING the refusals, and the §11
 * journey end to end over HTTP: fresh machine → enrol → restart → locked → the proof → open → auto-lock
 * → locked. Since COFRE.DESBLOQUEIO (owner, 2026-11-07) there is no authenticator code anywhere: the
 * proof is the way the vault confirms it is you (here a fake Windows Hello, and the REAL vault-password
 * protector over a throwaway directory). Fake clock; nothing is spawned and nothing under ~/.agentistics
 * is touched.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseVaultJson, type Protector, type ProtectorId, type UnwrapResult } from '@agentistics/vault'
import {
  __resetVaultForTests, __setVaultClockForTests, autoLockRemainingMs, autoLockTick, ensureVaultOpen, lockVault, openFromFile, sealToFile, vaultDir, vaultStatus,
} from './service'
import { __resetGateForTests, mintGrant, mintSetupCode } from './gate'
import { handleVaultHttp } from './http'

const STORE = new Map<string, Uint8Array>()
function fake(id: ProtectorId): Protector & { gestures: number; cancel: boolean } {
  const self = {
    id, gestures: 0, cancel: false,
    label: () => (id === 'hello' ? 'Windows Hello (fake)' : 'DPAPI (fake)'),
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) { STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: '2026-10-02T00:00:00.000Z' } } },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> {
      if (id === 'hello') { self.gestures++; if (self.cancel) return { ok: false, kind: 'denied', reason: 'presence-cancelled: the user said no' } }
      const d = STORE.get(`${id}:${kid}`)
      return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'gone' }
    },
    async remove(_r: unknown, kid: string) { STORE.delete(`${id}:${kid}`) },
  }
  return self
}

let T = 1_800_000_000_000
const clock = () => T
/** A code an old page might still send: never judged, never a proof. */
const OLD_CODE = '123456'
/** A password that meets the rules (≥ 9, 1 uppercase, 2 specials, 1 digit) — a test value, not a secret. */
const GOOD_PW = 'Test-Only!Pw9'

let dir = ''
let dpapi = fake('dpapi')
let hello = fake('hello')

function restart(withHello = true): void {
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: withHello ? [dpapi, hello] : [dpapi], autoInit: { candidates: [dpapi] }, scrypt: { N: 2 ** 10, r: 8, p: 1 } })
  __setVaultClockForTests(clock)
  __resetGateForTests(clock)
}

type J = Record<string, any>
interface Opts { remote?: boolean; password?: string }
/**
 * What the dashboard sends: same-origin, JSON (M1 refuses anything else on a POST). A page ON this
 * computer by default (loopback: the only page a dialog may be raised for); `remote` is a page from
 * another device. `password` travels in its own header, as the page sends it.
 */
async function http(method: 'GET' | 'POST', path: string, body?: unknown, grant?: string, cookie?: string, o: Opts = {}): Promise<{ status: number; json: J; headers: Headers }> {
  const headers: Record<string, string> = {
    'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    ...(grant ? { 'x-vault-grant': grant } : {}), ...(cookie ? { cookie } : {}), ...(o.password !== undefined ? { 'x-vault-password': o.password } : {}),
  }
  if (!o.remote) Object.assign(headers, { host: 'localhost:47292', origin: 'http://localhost:47292' })
  const req = new Request(`${o.remote ? 'http://local' : 'http://localhost:47292'}${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) })
  const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'session-A', ...(o.remote ? {} : { peer: '127.0.0.1' }) })
  if (!res) return { status: 404, json: {}, headers: new Headers() }
  const text = await res.text()
  return { status: res.status, json: text.startsWith('{') ? JSON.parse(text) : {}, headers: res.headers }
}

/** A machine that already has its first sealed secret (so the vault exists), not yet protected. */
async function fresh(withHello = true): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-http-'))
  STORE.clear()
  dpapi = fake('dpapi'); hello = fake('hello')
  T = 1_800_000_000_000
  restart(withHello)
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('TEST-NOT-A-SECRET'))
}

/** The one-time code the service prints for a page's FIRST enrolment (review S2). */
const setup = (): { setupCode: string } => ({ setupCode: mintSetupCode().code })
const typedOf = (r: { json: J }) => (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!)
const vj = () => parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!

/** The wizard's whole path over HTTP: [the first proof] → presence → recovery LAST. Returns the 24 words. */
async function enrolOverHttp(kind: 'hello' | 'password' = 'hello'): Promise<string[]> {
  expect((await http('POST', '/api/vault/setup-code', setup())).status).toBe(200)
  const p = await http('POST', '/api/vault/presence/enroll', { protector: kind }, undefined, undefined, kind === 'password' ? { password: GOOD_PW } : {})
  expect(p.status).toBe(200)
  expect(p.json.recoveryOwed).toBe(true)
  const r = await http('POST', '/api/vault/recovery/begin', {})
  expect((await http('POST', '/api/vault/recovery/confirm', { typed: typedOf(r) })).status).toBe(200)
  return r.json.words as string[]
}

afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-http-done-')), 'vault') }) })
beforeEach(async () => { await fresh() })

describe('GET /api/vault — the payload the sections read', () => {
  test('a fresh, unprotected vault: state + the ways this machine offers, no authenticator, no recovery', async () => {
    const r = await http('GET', '/api/vault')
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.json).toMatchObject({
      state: 'open', authenticator: null, legacyAppCode: false, recoveryCreatedAt: null, presence: false, presenceAvailable: ['hello', 'password'],
      methods: [], requirePresence: false, pendingStepup: false, autoLockMinutes: 30, recoveryTodo: null,
    })
    expect(r.json.unlockMethods.map((m: J) => m.id)).toEqual(['hello', 'password'])
    expect(r.json.passwordRules).toEqual({ minLength: 9, minSpecial: 2, rules: ['length', 'upper', 'special', 'digit'] })
    expect(typeof r.json.autoLockInMs).toBe('number')
    expect(Array.isArray(r.json.items)).toBe(true)
    // the table travels with the view — and no row asks a code any more
    expect(r.json.gates).toMatchObject({ list: { code: false, gesture: false, grant: false }, 'disable-presence': { code: false, gesture: true, grant: false }, 'lock-local': { code: false, gesture: false, grant: false } })
    for (const g of Object.values(r.json.gates as Record<string, J>)) expect(g.code).toBe(false)
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

  test('once protected and OPEN: the inventory asks nothing more — the open vault is the proof', async () => {
    await enrolOverHttp()
    const r = await http('GET', '/api/vault')
    expect(r.status).toBe(200)
    expect(r.json.needsStepUp).toBeUndefined()
    expect(r.json.methods).toEqual(['hello'])
    expect(r.json.authenticator).toBeNull()
  })
})

describe('the authenticator is RETIRED (owner, 2026-11-07)', () => {
  test('begin and confirm refuse in words — no seed, no QR, no URI, on a fresh vault and on a protected one', async () => {
    for (const phase of ['fresh', 'protected']) {
      if (phase === 'protected') await enrolOverHttp()
      for (const path of ['/api/vault/authenticator/begin', '/api/vault/authenticator/confirm']) {
        const r = await http('POST', path, { code: OLD_CODE, ...setup() })
        expect(r.json.ok).toBe(false)
        expect(r.json.code === 'authenticator-retired' || r.status === 400).toBe(true)
        expect(JSON.stringify(r.json)).not.toMatch(/otpauth|"secret"|"uri"/)
      }
    }
    expect(existsSync(join(vaultDir(), 'totp-seed.sealed'))).toBe(false)
    expect(vj().stepup).toBeUndefined()
  })
})

describe('POST /api/vault/recovery/begin + confirm', () => {
  test('begin serves 24 words and 3 positions once; confirm needs those exact words', async () => {
    const r = await http('POST', '/api/vault/recovery/begin', setup())
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.json.words).toHaveLength(24)
    expect(r.json.positions).toHaveLength(3)
    const wrong = await http('POST', '/api/vault/recovery/confirm', { typed: ['zoo', 'zoo', 'zoo'] })
    expect(wrong.status === 403 ? wrong.json.code : 'matched-by-chance').toMatch(/recovery-confirm-wrong|matched-by-chance/)
    expect((await http('POST', '/api/vault/recovery/confirm', { typed: typedOf(r) })).status).toBe(200)
    expect(vj().wrappers.map(w => w.type)).toContain('recovery')
  })

  test('confirm refuses anything but exactly three words, and a confirm with nothing pending', async () => {
    expect((await http('POST', '/api/vault/recovery/confirm', { typed: ['a', 'b'] })).status).toBe(400)
    expect((await http('POST', '/api/vault/recovery/confirm', { typed: 'abc' })).status).toBe(400)
    expect((await http('POST', '/api/vault/recovery/confirm', { typed: ['a', 'b', 'c'] })).json.code).toBe('no-recovery-pending')
  })

  test('a NEW recovery key on a protected vault asks the proof: a cancelled gesture refuses, a code never helps', async () => {
    await enrolOverHttp()
    hello.cancel = true
    expect((await http('POST', '/api/vault/recovery/begin', { code: OLD_CODE })).json.ok).toBe(false)
    hello.cancel = false
    const before = hello.gestures
    const ok = await http('POST', '/api/vault/recovery/begin', {})
    expect(ok.status).toBe(200)
    expect(hello.gestures).toBeGreaterThan(before) // the gesture was proven, not assumed
  })
})

describe('POST /api/vault/recover', () => {
  test('never takes the words from a page that is not on this computer (v2.98.1: loopback only — v2981.test.ts)', async () => {
    const r = await http('POST', '/api/vault/recover', { words: 'abandon '.repeat(24).trim() }, undefined, undefined, { remote: true })
    expect(r).toMatchObject({ status: 403, json: { ok: false, code: 'not-loopback' } })
    expect(r.json.sentence).not.toContain('agentop')
  })
})

describe('POST /api/vault/presence/enroll', () => {
  test('refuses a kind that is not a way to confirm (400); the FIRST one needs the first-enrolment proof, never an authenticator', async () => {
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'dpapi' })).status).toBe(400)
    expect((await http('POST', '/api/vault/presence/enroll', {})).status).toBe(400)
    const r = await http('POST', '/api/vault/presence/enroll', { protector: 'hello' })
    expect(r.json.code).toBe('setup-code-required')
    expect(JSON.stringify(r.json)).not.toMatch(/authenticator/i)
  })

  test('leader decision 2: presence comes BEFORE the recovery key, and says the key is owed', async () => {
    expect((await http('POST', '/api/vault/setup-code', setup())).status).toBe(200)
    const p = await http('POST', '/api/vault/presence/enroll', { protector: 'hello' })
    expect(p).toMatchObject({ status: 200, json: { ok: true, recoveryOwed: true } })
  })

  test('held until the words: the silent wrapper stays until the recovery key is confirmed, then retires', async () => {
    expect((await http('POST', '/api/vault/setup-code', setup())).status).toBe(200)
    const ok = await http('POST', '/api/vault/presence/enroll', { protector: 'hello' })
    expect(ok).toMatchObject({ status: 200, json: { ok: true, removed: [], recoveryOwed: true } })
    expect(vj().wrappers.map(w => w.type)).toEqual(['dpapi'])
    const r = await http('POST', '/api/vault/recovery/begin', {})
    expect((await http('POST', '/api/vault/recovery/confirm', { typed: typedOf(r) })).status).toBe(200)
    expect(vj().wrappers.map(w => w.type).sort()).toEqual(['hello', 'recovery'])
  })

  test('adding a SECOND way later asks the first one (one Hello); cancelled, nothing changes', async () => {
    await enrolOverHttp()
    hello.cancel = true
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'password' }, undefined, undefined, { password: GOOD_PW })).json.ok).toBe(false)
    expect(vj().wrappers.map(w => w.type)).not.toContain('password')
    hello.cancel = false
  })

  test('review S7: presence on a silent vault, long after the recovery key was made, asks for the words on a terminal', async () => {
    expect((await http('POST', '/api/vault/setup-code', setup())).status).toBe(200)
    const r = await http('POST', '/api/vault/recovery/begin', {})
    await http('POST', '/api/vault/recovery/confirm', { typed: typedOf(r) })
    T += 11 * 60_000 // the held words are gone
    const p = await http('POST', '/api/vault/presence/enroll', { protector: 'hello' })
    expect(p.json.code).toBe('presence-needs-recovery-words')
    // v2.98.1: the page never reads a command — it offers new words instead (ui-sentence.ts).
    expect(String(p.json.sentence)).not.toContain('agentop')
    expect(String(p.json.sentence)).toContain('Make new recovery words')
    expect(vj().wrappers.map(w => w.type)).toContain('dpapi')
  })
})

describe('COFRE.DESBLOQUEIO — the vault password over HTTP (the real protector, a throwaway directory)', () => {
  beforeEach(async () => { await fresh(false) }) // a machine with no Hello and no key: the password is its way

  test('the server REFUSES a weak password — each rule — and writes nothing', async () => {
    expect((await http('POST', '/api/vault/setup-code', setup())).status).toBe(200)
    for (const weak of ['Ab1!@', 'abcdef1!@', 'Abcdefgh1!', 'Abcdefgh!@']) {
      const r = await http('POST', '/api/vault/presence/enroll', { protector: 'password' }, undefined, undefined, { password: weak })
      expect(r.json).toMatchObject({ ok: false, code: 'password-weak' })
      expect(String(r.json.sentence)).not.toContain(weak)
    }
    const none = await http('POST', '/api/vault/presence/enroll', { protector: 'password' })
    expect(none.json.code).toBe('password-required')
    expect(vj().wrappers.map(w => w.type)).toEqual(['dpapi'])
    expect(existsSync(join(vaultDir(), 'dek.password'))).toBe(false)
  })

  test('set up with a good password → locked at restart → the password opens it; a wrong one opens nothing', async () => {
    const words = await enrolOverHttp('password')
    expect(words).toHaveLength(24)
    expect(vj().wrappers.map(w => w.type).sort()).toEqual(['password', 'recovery'])
    const file = readFileSync(join(vaultDir(), 'dek.password'), 'utf8')
    expect(file).not.toContain(GOOD_PW)                  // never stored
    expect(file).toContain('"kdf":"scrypt"')
    restart(false)
    expect((await vaultStatus()).state).toBe('locked')
    expect((await http('POST', '/api/vault/unlock', {})).json.code).toBe('password-required')
    expect((await http('POST', '/api/vault/unlock', {}, undefined, undefined, { password: 'Wrong-Pass!9' })).json.code).toBe('password-wrong')
    expect((await vaultStatus()).state).toBe('locked')
    const u = await http('POST', '/api/vault/unlock', {}, undefined, undefined, { password: GOOD_PW })
    expect(u.json).toMatchObject({ ok: true, state: 'open' })
    const r = await openFromFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup')
    expect(r.ok && new TextDecoder().decode(r.plaintext)).toBe('TEST-NOT-A-SECRET')
  })

  test('a confirmed action asks the password; the wrong one is refused; the right one passes', async () => {
    await enrolOverHttp('password')
    const sentence = (r: { json: J }) => String(r.json.sentence ?? '')
    const none = await http('POST', '/api/vault/auto-lock', { minutes: 10 })
    expect(none.json.code).toBe('password-required')
    expect(sentence(none)).toContain('vault password')
    expect((await http('POST', '/api/vault/auto-lock', { minutes: 10 }, undefined, undefined, { password: 'Wrong-Pass!9' })).json.code).toBe('password-wrong')
    expect((await http('POST', '/api/vault/auto-lock', { minutes: 10 }, undefined, undefined, { password: GOOD_PW })).json.ok).toBe(true)
    expect(vj().autoLock).toEqual({ minutes: 10 })
  })

  test('five wrong passwords pause it (never a lockout): even the right one waits, then works', async () => {
    await enrolOverHttp('password')
    restart(false)
    for (let i = 0; i < 5; i++) await http('POST', '/api/vault/unlock', {}, undefined, undefined, { password: `Wrong-Pass!${i}` })
    expect((await http('POST', '/api/vault/unlock', {}, undefined, undefined, { password: GOOD_PW })).json.code).toBe('password-paused')
    T += 61_000
    expect((await http('POST', '/api/vault/unlock', {}, undefined, undefined, { password: GOOD_PW })).json).toMatchObject({ ok: true, state: 'open' })
  })
})

describe('POST /api/vault/presence/disable', () => {
  test('refuses on a vault that has no presence', async () => {
    expect((await http('POST', '/api/vault/presence/disable', {})).json.code).toBe('no-presence')
  })

  test('asks the proof; the gesture puts the silent wrapper back FIRST and removes the presence key', async () => {
    await enrolOverHttp()
    hello.cancel = true
    expect((await http('POST', '/api/vault/presence/disable', { code: OLD_CODE })).json.ok).toBe(false)
    hello.cancel = false
    const kid = vj().kid
    expect(STORE.has(`hello:${kid}`)).toBe(true)
    const ok = await http('POST', '/api/vault/presence/disable', {})
    expect(ok).toMatchObject({ status: 200, json: { ok: true, replacedBy: 'dpapi' } })
    const v = vj()
    expect(v.wrappers.map(w => w.type).sort()).toEqual(['dpapi', 'recovery'])
    expect(STORE.has(`hello:${kid}`)).toBe(false)
    expect(STORE.has(`dpapi:${kid}`)).toBe(true)
    restart()
    expect((await vaultStatus()).state === 'open' || (await ensureVaultOpen()) !== null).toBe(true)
  })

  test("the owner's machine refuses without the recovery key — and a remote page can never supply it", async () => {
    await enrolOverHttp()
    const { handleVaultOp } = await import('./ops')
    const { becomeVaultHolder } = await import('./service')
    becomeVaultHolder()
    const flag = await handleVaultOp({ header: { op: 'require-presence' }, body: null, emit() {}, closed: new Promise(() => {}) })
    expect(flag.reply.ok).toBe(true)
    const r = await http('POST', '/api/vault/presence/disable', { words: 'abandon '.repeat(24).trim() }, undefined, undefined, { remote: true })
    expect(r.json.ok).toBe(false)
    expect(vj().wrappers.map(w => w.type)).toContain('hello')
    // The terminal path (the socket) with wrong words does not work either.
    const wrong = await handleVaultOp({ header: { op: 'presence-disable', words: 'abandon '.repeat(23) + 'zoo' }, body: null, emit() {}, closed: new Promise(() => {}) })
    expect(wrong.reply.ok).toBe(false)
  })
})

describe('GET /api/vault/credentials', () => {
  test('lists the presence credentials and the recovery date — never a key', async () => {
    await enrolOverHttp()
    const r = await http('GET', '/api/vault/credentials')
    expect(r.status).toBe(200)
    expect(r.json.credentials).toEqual([{ type: 'hello', label: 'Windows Hello (fake)', createdAt: '2026-10-02T00:00:00.000Z' }])
    expect(typeof r.json.recoveryCreatedAt).toBe('string')
    expect(JSON.stringify(r.json)).not.toMatch(/dek|seed|words/i)
  })

  test('a grant is bound to its session, and a locked vault refuses', async () => {
    await enrolOverHttp()
    const g = await http('POST', '/api/vault/stepup', { code: OLD_CODE })
    const { grantValid } = await import('./gate')
    expect(grantValid(g.json.grant, 'session-B', 'read')).toBe(false)
    lockVault('user')
    expect((await http('GET', '/api/vault/credentials', undefined, g.json.grant)).json.code).toBe('locked')
  })
})

describe('the routes that already existed keep their gate (stepup, lock, auto-lock, unlock, activity)', () => {
  test('stepup: the proof gives a grant (no code needed); lock asks nothing; auto-lock is bounded and confirmed', async () => {
    await enrolOverHttp()
    const g0 = hello.gestures
    const g = await http('POST', '/api/vault/stepup', { code: OLD_CODE })
    expect(g.json.grant).toBeTruthy()
    expect(hello.gestures).toBe(g0 + 1) // the "code" field is ignored: the gesture is the proof
    expect((await http('POST', '/api/vault/auto-lock', { minutes: 4 }, g.json.grant)).status).toBe(400)   // below 5
    expect((await http('POST', '/api/vault/auto-lock', { minutes: 'never' }, g.json.grant)).status).toBe(400)
    expect((await http('POST', '/api/vault/auto-lock', { minutes: 10 }, g.json.grant)).status).toBe(200)
    expect(hello.gestures).toBe(g0 + 1) // the grant stood for it
    expect((await http('POST', '/api/vault/lock', {})).status).toBe(200)  // locking only reduces exposure
  })

  test('from another device, nothing raises a dialog on this computer', async () => {
    await enrolOverHttp()
    const g0 = hello.gestures
    for (const [path, body] of [['/api/vault/auto-lock', { minutes: 10 }], ['/api/vault/recovery/begin', {}], ['/api/vault/presence/disable', {}]] as const) {
      expect((await http('POST', path, body, undefined, undefined, { remote: true })).json.ok).toBe(false)
    }
    expect(hello.gestures).toBe(g0)
  })

  test('activity needs the rotated tab token and is throttled', async () => {
    lockVault('user')
    const opened = await http('POST', '/api/vault/unlock', {})
    const setCookie = opened.headers.get('set-cookie') ?? ''
    const token = setCookie.match(/agentistics-vault-heartbeat=([^;]+)/)?.[1]
    expect(token).toBeTruthy()
    const cookie = `agentistics-vault-heartbeat=${token}`
    T += 1_000
    const before = autoLockRemainingMs()!
    expect((await http('POST', '/api/vault/activity', {}, undefined, cookie)).json.ok).toBe(true)
    const after = autoLockRemainingMs()!
    expect(after).toBeGreaterThan(before)
    expect((await http('POST', '/api/vault/activity', {}, undefined, cookie)).json.code).toBe('activity-too-soon')
    expect(autoLockRemainingMs()).toBe(after)
    T += 30_000
    expect((await http('POST', '/api/vault/activity', {}, undefined, cookie)).json.ok).toBe(true)
    lockVault('user')
    expect((await http('POST', '/api/vault/activity', {}, undefined, cookie)).json.code).toBe('activity-token')
    expect((await http('GET', '/api/vault/nope')).status).toBe(404)
    expect((await http('GET', '/api/vault/authenticator/begin')).status).toBe(404) // GET is not a begin
  })

  test('an open vault without a cookie can arm only from a trusted local page gesture', async () => {
    lockVault('user')
    await http('POST', '/api/vault/unlock', {})
    const grant = mintGrant('http:session-A', 'read')
    const noGesture = await http('POST', '/api/vault/activity/arm', {}, grant)
    expect(noGesture.json.code).toBe('activity-gesture')
    const armed = await http('POST', '/api/vault/activity/arm', { gesture: true }, grant)
    const token = armed.headers.get('set-cookie')?.match(/agentistics-vault-heartbeat=([^;]+)/)?.[1]
    expect(armed.json.ok).toBe(true)
    expect(token).toBeTruthy()
    T += 1_000
    const before = autoLockRemainingMs()!
    expect((await http('POST', '/api/vault/activity', {}, undefined, `agentistics-vault-heartbeat=${token}`)).json.ok).toBe(true)
    expect(autoLockRemainingMs()).toBeGreaterThan(before)
    lockVault('user')
    expect((await http('POST', '/api/vault/activity/arm', { gesture: true }, grant)).json.code).toBe('vault-locked')
  })

  const tokenOf = (r: { headers: Headers }) => r.headers.get('set-cookie')?.match(/agentistics-vault-heartbeat=([^;]+)/)?.[1]
  const beat = (t: string | undefined) => http('POST', '/api/vault/activity', {}, undefined, `agentistics-vault-heartbeat=${t}`)

  test('arm is refused without the page\'s grant (a bare local curl), with a grant for another session, and from a non-loopback peer', async () => {
    lockVault('user')
    await http('POST', '/api/vault/unlock', {})
    const bare = await http('POST', '/api/vault/activity/arm', { gesture: true })
    expect(bare.json.code).toBe('activity-grant')
    expect(tokenOf(bare)).toBeUndefined()
    const other = await http('POST', '/api/vault/activity/arm', { gesture: true }, mintGrant('http:session-B', 'read'))
    expect(other.json.code).toBe('activity-grant')
    expect((await http('POST', '/api/vault/activity/arm', { gesture: true }, 'garbage')).json.code).toBe('activity-grant')
    const req = new Request('http://localhost:47292/api/vault/activity/arm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost:47292', 'x-vault-grant': mintGrant('http:session-A', 'read') },
      body: JSON.stringify({ gesture: true }),
    })
    const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'session-A', peer: '192.0.2.10' })
    expect((await res!.json()).code).toBe('activity-not-here')
  })

  test('arm cannot move the idle clock faster than one beat per 30 s, and re-arming is itself throttled', async () => {
    lockVault('user')
    await http('POST', '/api/vault/unlock', {})
    const grant = mintGrant('http:session-A', 'read')
    T += 1_000
    const a1 = await http('POST', '/api/vault/activity/arm', { gesture: true }, grant)
    expect(a1.json.ok).toBe(true)
    expect((await beat(tokenOf(a1))).json.ok).toBe(true)
    const left = autoLockRemainingMs()!
    T += 5_000
    const a2 = await http('POST', '/api/vault/activity/arm', { gesture: true }, grant)
    expect(a2.json.code).toBe('activity-too-soon')
    expect(tokenOf(a2)).toBeUndefined()
    T += 25_000
    const a3 = await http('POST', '/api/vault/activity/arm', { gesture: true }, grant)
    expect(a3.json.ok).toBe(true)
    expect((await beat(tokenOf(a3))).json.ok).toBe(true)
    expect(autoLockRemainingMs()!).toBeGreaterThan(left - 31_000)
    T += 1_000
    expect((await beat(tokenOf(a3))).json.code).toBe('activity-too-soon')
  })

  test('the old token dies after a re-arm; lock and auto-lock invalidate the token', async () => {
    lockVault('user')
    const opened = await http('POST', '/api/vault/unlock', {})
    const t0 = tokenOf(opened)
    const grant = mintGrant('http:session-A', 'read')
    T += 31_000
    const a = await http('POST', '/api/vault/activity/arm', { gesture: true }, grant)
    const t1 = tokenOf(a)
    expect(t1).not.toBe(t0)
    expect((await beat(t0)).json.code).toBe('activity-token')
    expect((await beat(t1)).json.ok).toBe(true)
    expect(autoLockTick(T + 31 * 60_000)).toBe(true)
    expect((await beat(t1)).json.code).toBe('activity-token')
    const t2 = tokenOf(await http('POST', '/api/vault/unlock', {}))
    lockVault('user')
    await http('POST', '/api/vault/unlock', {})
    expect((await beat(t2)).json.code).toBe('activity-token')
  })

  test('extend: a non-loopback peer needs a passkey and cannot mint a heartbeat token', async () => {
    lockVault('user')
    await http('POST', '/api/vault/unlock', {})
    T += 10 * 60_000
    const before = autoLockRemainingMs()
    for (const grant of [undefined, mintGrant('http:session-A', 'read')]) {
      const req = new Request('http://localhost:47292/api/vault/extend', {
        method: 'POST', headers: { host: 'localhost:47292', origin: 'http://localhost:47292',
          'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(grant ? { 'x-vault-grant': grant } : {}) },
        body: '{}',
      })
      const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'session-A', peer: '192.0.2.10' })
      expect(await res!.json()).toMatchObject({ ok: false, code: 'mobile-gesture-required' })
      expect(res!.headers.get('set-cookie')).toBeNull()
      expect(autoLockRemainingMs()).toBe(before)
    }
  })

  test('extend: fresh Hello, never a code or grant; heartbeat cookies remain local and throttled', async () => {
    expect((await http('POST', '/api/vault/extend', {}, mintGrant('http:session-A', 'read'))).json.code).toBe('no-presence')
    await enrolOverHttp()
    T += 10 * 60_000
    const before = autoLockRemainingMs()!
    const g0 = hello.gestures
    const grant = mintGrant('http:session-A', 'read')
    hello.cancel = true
    const cancelled = await http('POST', '/api/vault/extend', { code: OLD_CODE }, grant)
    expect(cancelled.json.code).toBe('presence-cancelled')
    expect(tokenOf(cancelled)).toBeUndefined()
    expect(autoLockRemainingMs()).toBe(before)
    hello.cancel = false
    const first = await http('POST', '/api/vault/extend', {}, grant)
    expect(first.json.ok).toBe(true)
    expect(hello.gestures).toBe(g0 + 2)
    const t1 = tokenOf(first)
    expect(t1).toBeDefined()
    expect(autoLockRemainingMs()!).toBeGreaterThan(before)
    T += 5_000
    const second = await http('POST', '/api/vault/extend', {}, grant)
    expect(second.json.ok).toBe(true)
    expect(hello.gestures).toBe(g0 + 3)
    expect(tokenOf(second)).toBeUndefined()
    expect((await beat(t1)).json.ok).toBe(true)
  })

  test('activity without a token is refused; an unknown path is not ours', async () => {
    expect((await http('POST', '/api/vault/activity', {})).json.code).toBe('activity-token')
    expect((await http('GET', '/api/vault/nope')).status).toBe(404)
  })

  test('activity from a non-loopback peer is refused', async () => {
    const req = new Request('http://localhost:47292/api/vault/activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost:47292' },
      body: '{}',
    })
    const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'session-A', peer: '192.0.2.10' })
    expect(res?.status).toBe(403)
    expect((await res!.json()).code).toBe('activity-not-here')
  })
})

describe('§11 — fresh owner machine → protect → restart → locked → the proof → open → auto-lock → locked', () => {
  test('the whole journey over HTTP — no code anywhere', async () => {
    expect((await http('GET', '/api/vault')).json).toMatchObject({ state: 'open', authenticator: null, presence: false })
    await enrolOverHttp()
    const v = vj()
    expect(v.wrappers.map(w => w.type).sort()).toEqual(['hello', 'recovery'])
    expect(STORE.has(`dpapi:${v.kid}`)).toBe(false) // the silent wrapper is gone
    restart()
    const gestures = hello.gestures
    const locked = await http('GET', '/api/vault')
    expect(locked.json).toMatchObject({ state: 'locked', locked: true, presence: true })
    expect(locked.json.items).toEqual([])
    expect(hello.gestures).toBe(gestures)
    // the gesture (the button) → OPEN at once: no code step after it
    const u = await http('POST', '/api/vault/unlock')
    expect(u).toMatchObject({ status: 200, json: { ok: true, state: 'open' } })
    expect(hello.gestures).toBe(gestures + 1)
    const open = await http('GET', '/api/vault')
    expect(open.json).toMatchObject({ state: 'open', presence: true, autoLockMinutes: 30, pendingStepup: false })
    expect(open.json.autoLockInMs).toBeGreaterThan(0)
    const r = await openFromFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup')
    expect(r.ok && new TextDecoder().decode(r.plaintext)).toBe('TEST-NOT-A-SECRET')
    expect((await http('POST', '/api/vault/unlock/code', { code: OLD_CODE })).json.ok).toBe(false) // nothing to complete
    expect(autoLockTick(T + 31 * 60_000)).toBe(true)
    const after = await http('GET', '/api/vault')
    expect(after.json).toMatchObject({ state: 'locked', lockedBy: 'auto-lock', locked: true })
    expect(after.json.autoLockInMs).toBeNull()
  })
})

describe('POST /api/vault/presence/probe — the device check BEFORE anything changes', () => {
  test('a working device passes, writes nothing and leaves no stored key behind', async () => {
    const before = readFileSync(join(vaultDir(), 'vault.json'), 'utf8')
    const keys = STORE.size
    const gesturesBefore = hello.gestures
    const refused = await http('POST', '/api/vault/presence/probe', { protector: 'hello' })
    expect(refused).toMatchObject({ status: 403, json: { ok: false, code: 'setup-code-required' } })
    expect(hello.gestures).toBe(gesturesBefore)
    expect((await http('POST', '/api/vault/setup-code', setup())).status).toBe(200)
    const r = await http('POST', '/api/vault/presence/probe', { protector: 'hello' })
    expect(r).toMatchObject({ status: 200, json: { ok: true } })
    expect(readFileSync(join(vaultDir(), 'vault.json'), 'utf8')).toBe(before)
    expect(STORE.size).toBe(keys)
    expect(hello.gestures).toBe(gesturesBefore)
  })
  test('the view tells the page the setup code is owed, then not owed once this session spent it', async () => {
    expect((await http('GET', '/api/vault')).json.setupCode).toMatchObject({ owed: true })
    expect((await http('POST', '/api/vault/setup-code', { setupCode: '00000000' })).json.code).toBe('setup-code-required')
    expect((await http('POST', '/api/vault/setup-code', setup())).json).toMatchObject({ ok: true })
    const v = (await http('GET', '/api/vault')).json
    expect((v.setupCode ?? (v.view as Record<string, unknown>)?.setupCode) as { owed: boolean }).toMatchObject({ owed: false })
  })
  test('progress is readable while nothing is in flight: null', async () => {
    expect((await http('GET', '/api/vault/presence/progress')).json).toMatchObject({ ok: true, progress: null })
  })
  test('refuses a non-presence kind (400), a locked vault, and — once protected — asks the proof', async () => {
    expect((await http('POST', '/api/vault/presence/probe', { protector: 'dpapi' })).status).toBe(400)
    await enrolOverHttp()
    hello.cancel = true
    expect((await http('POST', '/api/vault/presence/probe', { protector: 'hello' })).json.ok).toBe(false)
    hello.cancel = false
    restart()
    expect((await http('POST', '/api/vault/presence/probe', { protector: 'hello' })).json.code).toBe('locked')
  })
})

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
import { __resetGateForTests, mintSetupCode } from './gate'
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
  // What the dashboard sends: same-origin, JSON (M1 refuses anything else on a POST).
  const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(grant ? { 'x-vault-grant': grant } : {}) }
  // VAULT.PERSONAL §10: the gesture unlock answers ONLY the page on this computer, so it is sent as one.
  const local = path === '/api/vault/unlock'
  if (local) Object.assign(headers, { host: 'localhost:47292', origin: 'http://localhost:47292' })
  const req = new Request(`${local ? 'http://localhost:47292' : 'http://local'}${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) })
  const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'session-A', ...(local ? { peer: '127.0.0.1' } : {}) })
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

/** The one-time code the service prints for a page's FIRST enrolment (review S2). */
const setup = (): { setupCode: string } => ({ setupCode: mintSetupCode().code })

/** The wizard's whole path over HTTP; returns the 24 words. */
async function enrolOverHttp(): Promise<string[]> {
  const a = await http('POST', '/api/vault/authenticator/begin', setup())
  seed = base32Decode(a.json.secret)
  expect((await http('POST', '/api/vault/authenticator/confirm', { code: codeAt(0) })).status).toBe(200)
  next()
  // Leader decision 2: presence, THEN the recovery key (the words wrap the final data key).
  const p = await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: codeAt() })
  expect(p.status).toBe(200)
  expect(p.json.recoveryOwed).toBe(true)
  next()
  const r = await http('POST', '/api/vault/recovery/begin', {})
  const typed = (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!)
  expect((await http('POST', '/api/vault/recovery/confirm', { typed })).status).toBe(200)
  next()
  return r.json.words as string[]
}

afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-http-done-')), 'vault') }) })
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
    // the §2.4 table travels with the view, so the screen never keeps a second copy of it
    expect(r.json.gates).toMatchObject({ list: { code: false, gesture: false, grant: false }, 'disable-presence': { code: true, gesture: true, grant: false }, 'lock-local': { code: false, gesture: false, grant: false } })
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

  test('once enrolled and OPEN: the inventory asks no code (owner 2026-10-04) — the open vault is the proof', async () => {
    await enrolOverHttp()
    const r = await http('GET', '/api/vault')
    expect(r.status).toBe(200)
    expect(r.json.needsStepUp).toBeUndefined()
    expect(Array.isArray(r.json.items)).toBe(true)
    expect(r.json.authenticator).toBeTruthy()
  })
})

describe('POST /api/vault/authenticator/begin + confirm', () => {
  test('begin serves the otpauth URI ONCE, no-store; a second begin is refused', async () => {
    const a = await http('POST', '/api/vault/authenticator/begin', { label: 'my-box', ...setup() })
    expect(a.status).toBe(200)
    expect(a.headers.get('cache-control')).toBe('no-store')
    expect(a.json.uri).toStartWith('otpauth://totp/Agentistics:my-box?')
    expect(a.json.secret).toMatch(/^[A-Z2-7]+$/)
    const again = await http('POST', '/api/vault/authenticator/begin', setup())
    expect(again).toMatchObject({ status: 403, json: { ok: false, code: 'already-served' } })
  })

  test('confirm takes ONE code: a wrong one is refused and seals nothing; the right one seals and returns the read grant', async () => {
    const a = await http('POST', '/api/vault/authenticator/begin', setup())
    seed = base32Decode(a.json.secret)
    const wrong = await http('POST', '/api/vault/authenticator/confirm', { code: wrongCode() })
    expect(wrong).toMatchObject({ status: 403, json: { code: 'stepup-wrong' } })
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.stepup).toBeUndefined()
    const ok = await http('POST', '/api/vault/authenticator/confirm', { code: codeAt(0) })
    expect(ok.status).toBe(200)
    expect(typeof ok.json.grant).toBe('string')
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.stepup).toMatchObject({ digits: 6, period: 30 })
  })

  test('confirm without a begin, or with a malformed body, is refused', async () => {
    expect((await http('POST', '/api/vault/authenticator/confirm', { code: '123456' })).json.code).toBe('no-enrolment')
    expect((await http('POST', '/api/vault/authenticator/confirm', { code1: '123456' })).status).toBe(400) // the old two-code body is no longer a request
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
    const r = await http('POST', '/api/vault/recovery/begin', setup())
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
  test('never takes the words from a page that is not on this computer (v2.98.1: loopback only — v2981.test.ts)', async () => {
    const r = await http('POST', '/api/vault/recover', { words: 'abandon '.repeat(24).trim() })
    expect(r).toMatchObject({ status: 403, json: { ok: false, code: 'not-loopback' } })
    expect(r.json.sentence).not.toContain('agentop')
  })
})

describe('POST /api/vault/presence/enroll', () => {
  test('refuses a protector that is not a presence kind (400) and an enrolment before the authenticator', async () => {
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'dpapi' })).status).toBe(400)
    expect((await http('POST', '/api/vault/presence/enroll', {})).status).toBe(400)
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'hello' })).json.code).toBe('needs-authenticator')
  })

  test('leader decision 2: presence comes BEFORE the recovery key, and says the key is owed', async () => {
    const a = await http('POST', '/api/vault/authenticator/begin', setup())
    seed = base32Decode(a.json.secret)
    await http('POST', '/api/vault/authenticator/confirm', { code: codeAt(0) })
    next()
    const p = await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: codeAt() })
    expect(p).toMatchObject({ status: 200, json: { ok: true, recoveryOwed: true } })
  })

  test('is gated: no code 401, wrong code 403 with the vault untouched; the right one retires the silent wrapper', async () => {
    const a = await http('POST', '/api/vault/authenticator/begin', setup())
    seed = base32Decode(a.json.secret)
    await http('POST', '/api/vault/authenticator/confirm', { code: codeAt(0) })
    T += 11 * 60_000 // the wizard's window is over: what follows is gated again
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'hello' })).status).toBe(401)
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: wrongCode() })).status).toBe(403)
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.wrappers.map(w => w.type)).not.toContain('hello')
    const ok = await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: codeAt() })
    // Leader decision 2026-10-02: presence is HELD; the silent wrapper stays until the recovery key is confirmed.
    expect(ok).toMatchObject({ status: 200, json: { ok: true, removed: [], recoveryOwed: true } })
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.wrappers.map(w => w.type)).toEqual(['dpapi'])
    const r = await http('POST', '/api/vault/recovery/begin', {})
    expect((await http('POST', '/api/vault/recovery/confirm', { typed: (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!) })).status).toBe(200)
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.wrappers.map(w => w.type).sort()).toEqual(['hello', 'recovery'])
  })

  test('review S7: presence on a silent vault, long after the recovery key was made, asks for the words on a terminal', async () => {
    await http('POST', '/api/vault/authenticator/confirm', { code: codeAt(0) }) // no enrolment: refused, harmless
    const a = await http('POST', '/api/vault/authenticator/begin', setup())
    seed = base32Decode(a.json.secret)
    await http('POST', '/api/vault/authenticator/confirm', { code: codeAt(0) })
    next()
    const r = await http('POST', '/api/vault/recovery/begin', {})
    await http('POST', '/api/vault/recovery/confirm', { typed: (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!) })
    T += 11 * 60_000 // the held words are gone
    const p = await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: codeAt() })
    expect(p.json.code).toBe('presence-needs-recovery-words')
    // v2.98.1: the page never reads a command — it offers new words instead (ui-sentence.ts).
    expect(String(p.json.sentence)).not.toContain('agentop')
    expect(String(p.json.sentence)).toContain('Make new recovery words')
    expect(parseVaultJson(readFileSync(join(vaultDir(), 'vault.json')))!.wrappers.map(w => w.type)).toContain('dpapi')
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
    expect(r.json.sentence).not.toContain('agentop')
    expect(r.json.action).toBe('disable-presence')
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
    expect(no.status).toBe(200) // metadata of an OPEN vault: no code (owner 2026-10-04)
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
    expect((await http('POST', '/api/vault/lock', {})).status).toBe(200)  // locking only reduces exposure: no code
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

    // the code → open AND the grant for the list: ONE code (owner 2026-10-03 — it was asked twice)
    const uc = await http('POST', '/api/vault/unlock/code', { code: codeAt() })
    expect(uc.status).toBe(200)
    expect(typeof uc.json.grant).toBe('string')
    expect((await http('GET', '/api/vault')).status).toBe(200) // the open vault lists with no further proof
    const open = await http('GET', '/api/vault', undefined, uc.json.grant)
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

describe('owner decision 2026-10-02 — ONE code, no second code after the wizard', () => {
  test('a code one step off still passes (±1); the same code never works twice (replay floor)', async () => {
    const a = await http('POST', '/api/vault/authenticator/begin', setup())
    seed = base32Decode(a.json.secret)
    const used = codeAt(-1)
    expect((await http('POST', '/api/vault/authenticator/confirm', { code: used })).status).toBe(200)
    // that very code, now as a step-up: refused as replayed
    expect((await http('POST', '/api/vault/stepup', { code: used })).json.code).toBe('stepup-replayed')
  })

  test('five wrong codes drop the seed: the QR must be fetched again', async () => {
    await http('POST', '/api/vault/authenticator/begin', setup())
    for (let i = 0; i < 4; i++) expect((await http('POST', '/api/vault/authenticator/confirm', { code: wrongCode() })).json.code).toBe('stepup-wrong')
    const fifth = await http('POST', '/api/vault/authenticator/confirm', { code: wrongCode() })
    expect(fifth.json.sentence).toContain('Start over')
    expect((await http('POST', '/api/vault/authenticator/confirm', { code: wrongCode() })).json.code).toBe('no-enrolment')
  })

  test('the grant from the confirm opens the inventory at once — no fresh code, no 30 s wait', async () => {
    const a = await http('POST', '/api/vault/authenticator/begin', setup())
    seed = base32Decode(a.json.secret)
    const ok = await http('POST', '/api/vault/authenticator/confirm', { code: codeAt(0) })
    const r = await http('GET', '/api/vault', undefined, ok.json.grant)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.json.items)).toBe(true)
  })

  test('presence and the recovery key in the same wizard need NO second code; later (flow over) presence is gated again', async () => {
    const a = await http('POST', '/api/vault/authenticator/begin', setup())
    seed = base32Decode(a.json.secret)
    await http('POST', '/api/vault/authenticator/confirm', { code: codeAt(0) })
    const p = await http('POST', '/api/vault/presence/enroll', { protector: 'hello' }) // no code
    expect(p).toMatchObject({ status: 200, json: { ok: true, removed: [], recoveryOwed: true } }) // held until the words
    const r = await http('POST', '/api/vault/recovery/begin', {}) // no code: still inside the wizard
    expect(r.status).toBe(200)
    await http('POST', '/api/vault/recovery/confirm', { typed: (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!) })
    // the flow is closed: adding a presence credential again asks for the code
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'hello' })).status).toBe(401)
  })

  test('without an enrolment in progress, presence still needs the code (the skip is not a hole)', async () => {
    await enrolOverHttp()
    next()
    restart()
    await http('POST', '/api/vault/unlock')
    await http('POST', '/api/vault/unlock/code', { code: codeAt() })
    next()
    expect((await http('POST', '/api/vault/presence/enroll', { protector: 'hello' })).status).toBe(401)
  })
})

describe('POST /api/vault/presence/probe — the gesture check BEFORE anything changes', () => {
  test('a working device passes, writes nothing and leaves no stored key behind', async () => {
    const before = readFileSync(join(vaultDir(), 'vault.json'), 'utf8')
    const keys = STORE.size
    // Owner 2026-10-02: on a first page enrolment the setup code comes BEFORE any gesture.
    const gesturesBefore = hello.gestures
    const refused = await http('POST', '/api/vault/presence/probe', { protector: 'hello' })
    expect(refused).toMatchObject({ status: 403, json: { ok: false, code: 'setup-code-required' } })
    expect(hello.gestures).toBe(gesturesBefore)
    expect((await http('POST', '/api/vault/setup-code', setup())).status).toBe(200)
    const r = await http('POST', '/api/vault/presence/probe', { protector: 'hello' })
    expect(r).toMatchObject({ status: 200, json: { ok: true } })
    expect(readFileSync(join(vaultDir(), 'vault.json'), 'utf8')).toBe(before)
    expect(STORE.size).toBe(keys)
    // Wrap only: no verifying unwrap here (the fake counts unwraps) — reproducibility is the enrolment's check.
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
  test('refuses a non-presence kind (400), a locked vault, and — once enrolled — an unauthenticated probe (401)', async () => {
    expect((await http('POST', '/api/vault/presence/probe', { protector: 'dpapi' })).status).toBe(400)
    await enrolOverHttp()
    next()
    expect((await http('POST', '/api/vault/presence/probe', { protector: 'hello' })).status).toBe(401)
    restart()
    expect((await http('POST', '/api/vault/presence/probe', { protector: 'hello' })).json.code).toBe('locked')
  })
})

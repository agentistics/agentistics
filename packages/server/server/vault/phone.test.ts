/**
 * VAULT.PERSONAL §10 — opening the vault from a phone, end to end over HTTP with a software
 * authenticator (real P-256 + a PRF): never Hello off loopback; the passkey + PRF (the phone's
 * biometrics) opens it. COFRE.DESBLOQUEIO (owner, 2026-11-07): no authenticator code anywhere — the
 * phone's REQUEST asks nothing, the computer's APPROVAL asks its own proof (Hello here), and the old
 * "device key + code" way is gone.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { b64url, type Protector, type ProtectorId, type UnwrapResult } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, sealToFile } from './service'
import { __resetGateForTests } from './gate'
import { __resetPersonalForTests } from './personal'
import { __resetMobileForTests } from './mobile'
import { __resetPhoneForTests } from './phone'
import { handleVaultHttp } from './http'

const STORE = new Map<string, Uint8Array>()
type Fake = Protector & { gestures: number; deny: boolean }
function fake(id: ProtectorId): Fake {
  const self: Fake = {
    id, gestures: 0, deny: false, label: () => id,
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) { STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: 'x' } } },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> {
      if (id === 'hello') { self.gestures++; if (self.deny) return { ok: false, kind: 'denied', reason: 'presence-cancelled: no' } }
      const d = STORE.get(`${id}:${kid}`); return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'gone' }
    },
    async remove(_r: unknown, kid: string) { STORE.delete(`${id}:${kid}`) },
    ...(id === 'hello' ? { async proveHuman() { return { ok: true as const } } } : {}),
  }
  return self
}

let T = 1_800_000_000_000
const clock = () => T
/** A code an old phone page might still send: never judged, never a proof. */
const OLD_CODE = '123456'
let hello = fake('hello'), dpapi = fake('dpapi')

const RP = 'box.tail1234.ts.net'
const LOCAL = { host: 'localhost:47292', origin: 'http://localhost:47292', peer: '127.0.0.1' }
const PHONE = { host: `${RP}`, origin: `https://${RP}`, peer: '100.64.0.7', fwd: true }
const PHONE_HTTP = { host: `${RP}:47292`, origin: `http://${RP}:47292`, peer: '100.64.0.7' }
type Where = { host: string; origin: string; peer: string }
type J = Record<string, any>
const grants: Record<string, string | undefined> = {}
async function http(method: 'GET' | 'POST', path: string, body: unknown = {}, where: Where = LOCAL, session = 'local'): Promise<{ status: number; json: J; headers: Headers }> {
  const g = grants[`${where.host}:${session}`]
  const headers: Record<string, string> = { host: where.host, 'sec-fetch-site': 'same-origin', origin: where.origin, ...(g ? { 'x-vault-grant': g } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }
  const req = new Request(`${where.origin}${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
  const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session, peer: where.peer })
  const text = res ? await res.text() : '{}'
  const json = text.startsWith('{') ? JSON.parse(text) : {}
  if (typeof json.grant === 'string') grants[`${where.host}:${session}`] = json.grant
  return { status: res?.status ?? 404, json, headers: res?.headers ?? new Headers() }
}

/** A phone: one P-256 key, its credential id, a counter. */
function phone() {
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const credId = new Uint8Array(randomBytes(16))
  const prfKey = randomBytes(32)
  let count = 0
  const ad = (withCred: boolean) => {
    const c = Buffer.alloc(4); c.writeUInt32BE(count)
    const parts = [createHash('sha256').update(RP).digest(), Buffer.from([0x01 | 0x04 | (withCred ? 0x40 : 0)]), c]
    if (withCred) { const l = Buffer.alloc(2); l.writeUInt16BE(16); parts.push(Buffer.alloc(16), l, Buffer.from(credId)) }
    return Buffer.concat(parts)
  }
  const cd = (type: string, ch: string) => Buffer.from(JSON.stringify({ type, challenge: ch, origin: `https://${RP}` }))
  return {
    create(ch: string) {
      return { clientDataJSON: b64url(cd('webauthn.create', ch)), authenticatorData: b64url(ad(true)), publicKey: b64url(new Uint8Array(kp.publicKey.export({ format: 'der', type: 'spki' }))), alg: -7, credentialId: b64url(credId) }
    },
    get(ch: string) {
      count++
      const a = ad(false), c = cd('webauthn.get', ch)
      const sig = sign('sha256', Buffer.concat([a, createHash('sha256').update(c).digest()]), { key: kp.privateKey, dsaEncoding: 'der' })
      return { credentialId: b64url(credId), clientDataJSON: b64url(c), authenticatorData: b64url(a), signature: b64url(new Uint8Array(sig)) }
    },
    /** The PRF extension: what the authenticator derives from a salt after the biometrics. */
    prf(salt: string) { return b64url(new Uint8Array(createHmac('sha256', prfKey).update(Buffer.from(salt, 'base64url')).digest())) },
  }
}

let vaultDirPath = ''
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-phone-'))
  vaultDirPath = join(dir, 'vault')
  STORE.clear(); for (const k of Object.keys(grants)) delete grants[k]
  hello = fake('hello'); dpapi = fake('dpapi'); T = 1_800_000_000_000
  __resetVaultForTests({ dir: vaultDirPath, lang: 'en', protectors: [dpapi, hello], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock); __resetGateForTests(clock); __resetPersonalForTests(clock); __resetMobileForTests(clock); __resetPhoneForTests(clock)
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('x'))
  await http('POST', '/api/vault/local-proof')
  await http('POST', '/api/vault/presence/enroll', { protector: 'hello' })
  const r = await http('POST', '/api/vault/recovery/begin')
  await http('POST', '/api/vault/recovery/confirm', { typed: (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!) })
})
afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-phone-done-')), 'vault') }) })

const lock = async () => { const r = await http('POST', '/api/vault/lock', {}); expect(r.json.ok).toBe(true) }
const state = async () => (await http('GET', '/api/vault/phone', undefined, PHONE)).json

/** The phone asks (no proof of its own yet), the computer approves with Hello. */
async function approvedRequest(kind: 'passkey', where: Where = PHONE, session = 'local') {
  const q = await http('POST', '/api/vault/phone/enrol/request', { kind, label: 'Pixel' }, where, session)
  expect(q.json).toMatchObject({ ok: true })
  expect(q.json.match).toMatch(/^\d\d \d\d$/)
  const list = await http('GET', '/api/vault/phone/requests')
  expect(list.json.requests).toEqual([expect.objectContaining({ id: q.json.id, label: 'Pixel', kind, match: q.json.match })])
  const d = await http('POST', '/api/vault/phone/requests/decide', { id: q.json.id, approve: true })
  expect(d.json.ok).toBe(true)
  expect((await http('GET', `/api/vault/phone/enrol/status?id=${q.json.id}`, undefined, where, session)).json.status).toBe('approved')
  return q.json.id as string
}
async function enrolPasskey(p = phone(), withPrf = true) {
  const id = await approvedRequest('passkey')
  const b = await http('POST', '/api/vault/personal/mobile/register/begin', { requestId: id }, PHONE)
  expect(b.json.ok).toBe(true)
  expect(b.json.options.extensions).toEqual({ prf: {} })
  const f = await http('POST', '/api/vault/personal/mobile/register/finish', { requestId: id, challengeId: b.json.options.challengeId, ...p.create(b.json.options.challenge) }, PHONE)
  expect(f.json.ok).toBe(true)
  const k = await http('POST', '/api/vault/phone/enrol/passkey-key', { challengeId: f.json.prf.challengeId, ...p.get(f.json.prf.challenge), ...(withPrf ? { prf: p.prf(f.json.prf.salt) } : {}) }, PHONE)
  expect(k.json.ok).toBe(true)
  return { p, unlockable: k.json.unlockable as boolean }
}
async function passkeyUnlock(p: ReturnType<typeof phone>, prf?: (salt: string) => string, extra: Record<string, unknown> = {}) {
  const b = await http('POST', '/api/vault/phone/unlock/begin', {}, PHONE)
  expect(b.json.ok).toBe(true)
  const salt = b.json.allow[0].salt as string
  return http('POST', '/api/vault/phone/unlock', { kind: 'passkey', challengeId: b.json.challengeId, ...p.get(b.json.challenge), prf: (prf ?? p.prf)(salt), ...extra }, PHONE)
}

describe('Windows Hello is never offered off loopback', () => {
  test('/api/vault/unlock from the phone is refused in words and raises no prompt', async () => {
    await lock()
    const g0 = hello.gestures
    const r = await http('POST', '/api/vault/unlock', {}, PHONE)
    expect(r.json).toMatchObject({ ok: false, code: 'unlock-not-here' })
    expect(hello.gestures).toBe(g0)
    expect((await state()).state).toBe('locked')
  })
  test('the same route on this computer still raises Hello', async () => {
    await lock()
    const g0 = hello.gestures
    await http('POST', '/api/vault/unlock', {})
    expect(hello.gestures).toBe(g0 + 1)
  })
})

describe('registering a phone: the phone asks, the computer approves with its own proof', () => {
  test('a request alone enrols nothing: no approval, no registration', async () => {
    const q = await http('POST', '/api/vault/phone/enrol/request', { kind: 'passkey' }, PHONE)
    expect(q.json.ok).toBe(true)
    expect((await http('POST', '/api/vault/personal/mobile/register/begin', { requestId: q.json.id }, PHONE)).json.code).toBe('not-approved')
  })
  test('the request asks the phone nothing (no code any more); approving is the computer\'s, with Hello — a denied Hello approves nothing', async () => {
    const q = await http('POST', '/api/vault/phone/enrol/request', { kind: 'passkey', code: OLD_CODE }, PHONE)
    expect(q.json.ok).toBe(true)
    expect((await http('POST', '/api/vault/phone/requests/decide', { id: q.json.id, approve: true }, PHONE)).json.code).toBe('desktop-only')
    expect((await http('GET', '/api/vault/phone/requests', undefined, PHONE)).json.code).toBe('desktop-only')
    hello.deny = true
    expect((await http('POST', '/api/vault/phone/requests/decide', { id: q.json.id, approve: true })).json.ok).toBe(false)
    hello.deny = false
    const g0 = hello.gestures
    expect((await http('POST', '/api/vault/phone/requests/decide', { id: q.json.id, approve: true })).json.ok).toBe(true)
    expect(hello.gestures).toBe(g0 + 1)
  })
  test('a denial is final and an approval belongs to the session that asked', async () => {
    const q = await http('POST', '/api/vault/phone/enrol/request', { kind: 'passkey' }, PHONE)
    await http('POST', '/api/vault/phone/requests/decide', { id: q.json.id, approve: false })
    expect((await http('GET', `/api/vault/phone/enrol/status?id=${q.json.id}`, undefined, PHONE)).json.status).toBe('denied')
    const id = await approvedRequest('passkey')
    expect((await http('POST', '/api/vault/personal/mobile/register/begin', { requestId: id }, PHONE, 'other')).json.code).toBe('not-approved')
    expect((await http('GET', `/api/vault/phone/enrol/status?id=${id}`, undefined, PHONE, 'other')).json.status).toBe('expired')
  })
  test('an approval expires', async () => {
    const id = await approvedRequest('passkey')
    T += 5 * 60_000 + 1
    expect((await http('POST', '/api/vault/personal/mobile/register/begin', { requestId: id }, PHONE)).json.code).toBe('not-approved')
  })
  test('the phone cannot register while the vault is locked, nor from this computer', async () => {
    expect((await http('POST', '/api/vault/phone/enrol/request', { kind: 'passkey' })).json.code).toBe('not-a-phone')
    await lock()
    expect((await http('POST', '/api/vault/phone/enrol/request', { kind: 'passkey' }, PHONE)).json.code).toBe('locked')
  })
  test('a passkey needs https; plain http says how to get it', async () => {
    const r = await http('POST', '/api/vault/phone/enrol/request', { kind: 'passkey' }, PHONE_HTTP)
    expect(r.json.code).toBe('insecure-context')
    expect(r.json.sentence).toContain('Tailscale')
  })
})

describe('opening the vault from the phone: the passkey (biometrics) alone', () => {
  test('opens with the passkey\'s PRF — no code, no Hello; audited as "opened from Pixel"; hands back the read grant', async () => {
    const { p, unlockable } = await enrolPasskey()
    expect(unlockable).toBe(true)
    await lock()
    expect(await state()).toMatchObject({ state: 'locked', passkeys: 1, loopback: false, secure: true, codeOnly: null })
    const g0 = hello.gestures
    const r = await passkeyUnlock(p)
    expect(r.json).toMatchObject({ ok: true, state: 'open' })
    expect(typeof r.json.grant).toBe('string')
    expect(hello.gestures).toBe(g0)
    expect((await state()).state).toBe('open')
    const audit = await readFile(join(vaultDirPath, 'audit.jsonl'), 'utf8')
    expect(audit).toContain('"type":"vault.unlock","device":"Pixel"')
  })
  test('a code sent beside it changes nothing (ignored, never required)', async () => {
    const { p } = await enrolPasskey()
    await lock()
    expect((await passkeyUnlock(p, undefined, { code: '000000' })).json).toMatchObject({ ok: true, state: 'open' })
  })
  test('the right signature with the wrong PRF output opens nothing', async () => {
    const { p } = await enrolPasskey()
    await lock()
    const r = await passkeyUnlock(p, () => b64url(new Uint8Array(randomBytes(32))))
    expect(r.json.code).toBe('phone-key-refused')
    expect((await state()).state).toBe('locked')
  })
  test('a phone without PRF registers for confirming actions but is told it cannot open', async () => {
    const { unlockable } = await enrolPasskey(phone(), false)
    expect(unlockable).toBe(false)
    await lock()
    expect((await http('POST', '/api/vault/phone/unlock/begin', {}, PHONE)).json.code).toBe('no-passkey')
  })
  test('removing the phone on the computer removes its way in', async () => {
    const { p } = await enrolPasskey()
    const list = await http('GET', '/api/vault/personal/mobile')
    await http('POST', '/api/vault/personal/mobile/passkeys/remove', { id: list.json.passkeys[0].id })
    await lock()
    expect((await http('POST', '/api/vault/phone/unlock/begin', {}, PHONE)).json.code).toBe('no-passkey')
    void p
  })
})

describe('COFRE.DESBLOQUEIO — "the code alone" is gone', () => {
  test('a phone cannot ask for a device key, and "the code alone" cannot be turned on', async () => {
    expect((await http('POST', '/api/vault/phone/enrol/request', { kind: 'device' }, PHONE_HTTP)).json.code).toBe('code-only-off')
    const on = await http('POST', '/api/vault/personal/mobile/code-reveal', { enabled: true })
    expect(on.json).toMatchObject({ ok: false, code: 'code-retired' })
    expect((await http('GET', '/api/vault/personal/mobile')).json.codeReveal).toBe(false)
  })
  test('a stored device key cannot open the vault: the "device" unlock is refused in words', async () => {
    await lock()
    const r = await http('POST', '/api/vault/phone/unlock', { kind: 'device', deviceId: 'd1', deviceSecret: b64url(new Uint8Array(randomBytes(32))), code: OLD_CODE }, PHONE_HTTP)
    expect(r.json).toMatchObject({ ok: false, code: 'device-key-retired' })
    expect((await state()).state).toBe('locked')
  })
  test('turning it OFF still works (it clears what an older version left behind)', async () => {
    expect((await http('POST', '/api/vault/personal/mobile/code-reveal', { enabled: false })).json.ok).toBe(true)
    expect((await http('GET', '/api/vault/phone', undefined, PHONE_HTTP)).json.devices).toEqual([])
  })
})

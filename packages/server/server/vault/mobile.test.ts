/**
 * VAULT.PERSONAL §7 — the phone, end to end over HTTP with a SOFTWARE authenticator (real ES256 key):
 * registering needs the code + Windows Hello on the computer; off loopback a personal action never
 * raises Hello and needs a single-use gesture token bound to the exact action; the code window exists
 * only when the owner opted in, reveals only, 30 s. Fake protectors and clock; nothing real touched.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { b64url, base32Decode, hotp, type Protector, type ProtectorId, type UnwrapResult } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, sealToFile } from './service'
import { __resetGateForTests } from './gate'
import { __resetPersonalForTests } from './personal'
import { __resetMobileForTests } from './mobile'
import { __resetPhoneForTests } from './phone'
import { handleVaultHttp } from './http'

const STORE = new Map<string, Uint8Array>()
type Fake = Protector & { gestures: number }
function fake(id: ProtectorId): Fake {
  const self: Fake = {
    id, gestures: 0, label: () => id,
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) { STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: 'x' } } },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> { if (id === 'hello') self.gestures++; const d = STORE.get(`${id}:${kid}`); return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'gone' } },
    async remove(_r: unknown, kid: string) { STORE.delete(`${id}:${kid}`) },
    ...(id === 'hello' ? { async proveHuman() { return { ok: true as const } } } : {}),
  }
  return self
}

let T = 1_800_000_000_000
const clock = () => T
let seed: Uint8Array
const codeAt = () => hotp(seed, Math.floor(T / 1000 / 30))
const next = () => { T += 30_000 }
let hello = fake('hello'), dpapi = fake('dpapi')

const RP = 'box.tail1234.ts.net'
const LOCAL = { host: 'localhost:47292', origin: 'http://localhost:47292', peer: '127.0.0.1' }
const PHONE = { host: `${RP}`, origin: `https://${RP}`, peer: '100.64.0.7', fwd: true }
const PHONE_HTTP = { host: `${RP}:47292`, origin: `http://${RP}:47292`, peer: '100.64.0.7' }
type Where = { host: string; origin: string; peer: string }
type J = Record<string, any>
const grants: Record<string, string | undefined> = {}
async function http(method: 'GET' | 'POST', path: string, body: unknown = {}, where: Where = LOCAL): Promise<{ status: number; json: J }> {
  const g = grants[where.host]
  const headers: Record<string, string> = { host: where.host, 'sec-fetch-site': 'same-origin', origin: where.origin, ...(g ? { 'x-vault-grant': g } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }
  const req = new Request(`${where.origin}${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
  const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'local', peer: where.peer })
  const text = res ? await res.text() : '{}'
  const json = text.startsWith('{') ? JSON.parse(text) : {}
  if (typeof json.grant === 'string') grants[where.host] = json.grant
  return { status: res?.status ?? 404, json }
}

/** A phone: one P-256 key, its credential id, a counter. */
function phone() {
  const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const credId = new Uint8Array(randomBytes(16))
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
  }
}

let itemId = ''
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-mobile-'))
  STORE.clear(); for (const k of Object.keys(grants)) delete grants[k]
  hello = fake('hello'); dpapi = fake('dpapi'); T = 1_800_000_000_000
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi, hello], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock); __resetGateForTests(clock); __resetPersonalForTests(clock); __resetMobileForTests(clock); __resetPhoneForTests(clock)
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('x'))
  await http('POST', '/api/vault/local-proof')
  seed = base32Decode((await http('POST', '/api/vault/authenticator/begin')).json.secret)
  await http('POST', '/api/vault/authenticator/confirm', { code: codeAt() }); next()
  await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: codeAt() }); next()
  const r = await http('POST', '/api/vault/recovery/begin')
  await http('POST', '/api/vault/recovery/confirm', { typed: (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!) }); next()
  itemId = (await http('POST', '/api/vault/personal', { item: { kind: 'login', name: 'Banco', fields: { login: 'me', password: 'MARKER-pw' } }, code: codeAt() })).json.meta.id
  next()
})
afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-mobile-done-')), 'vault') }) })

async function registerPhone(p = phone()) {
  // §10: the phone asks with the code, the computer approves with Hello, then the passkey is created.
  const q = await http('POST', '/api/vault/phone/enrol/request', { kind: 'passkey', label: 'Pixel', code: codeAt() }, PHONE)
  next()
  expect(q.json.ok).toBe(true)
  expect((await http('POST', '/api/vault/phone/requests/decide', { id: q.json.id, approve: true })).json.ok).toBe(true)
  const b = await http('POST', '/api/vault/personal/mobile/register/begin', { requestId: q.json.id }, PHONE)
  expect(b.json.ok).toBe(true)
  const f = await http('POST', '/api/vault/personal/mobile/register/finish', { requestId: q.json.id, challengeId: b.json.options.challengeId, ...p.create(b.json.options.challenge) }, PHONE)
  expect(f.json.ok).toBe(true)
  return p
}
async function token(p: ReturnType<typeof phone>, action: string, target: string): Promise<string> {
  const b = await http('POST', '/api/vault/personal/mobile/assert/begin', { action, target, code: codeAt() }, PHONE)
  next()
  expect(b.json.ok).toBe(true)
  const f = await http('POST', '/api/vault/personal/mobile/assert/finish', { challengeId: b.json.challengeId, ...p.get(b.json.challenge) }, PHONE)
  expect(f.json.ok).toBe(true)
  return f.json.gestureToken
}

describe('off loopback, a personal action never raises Windows Hello', () => {
  test('without a passkey or the opt-in, reveal is refused in words and no prompt is raised', async () => {
    const g0 = hello.gestures
    const r = await http('POST', '/api/vault/personal/reveal', { id: itemId, field: 'password', code: codeAt() }, PHONE)
    expect(r.json).toMatchObject({ ok: false, code: 'mobile-gesture-required' })
    expect(r.json.value).toBeUndefined()
    expect(hello.gestures).toBe(g0)
  })
})

describe('registering a phone passkey', () => {
  test('needs the code AND Windows Hello on the computer; a plain-http page is refused', async () => {
    expect((await http('POST', '/api/vault/personal/mobile/register/begin', { code: codeAt() }, PHONE_HTTP)).json.code).toBe('insecure-context')
    const g0 = hello.gestures
    expect((await http('POST', '/api/vault/personal/mobile/register/begin', {}, PHONE)).json.code).toBe('not-approved')
    await registerPhone()
    expect(hello.gestures).toBe(g0 + 1)
    const v = await http('GET', '/api/vault/personal/mobile', undefined, LOCAL)
    expect(v.json.passkeys).toEqual([expect.objectContaining({ label: 'Pixel', rpId: RP })])
    expect(JSON.stringify(v.json)).not.toContain('spki')
  })
})

describe('a passkey token is single use and bound to the action', () => {
  test('reveal with a token; the same token twice, or for another field, is refused', async () => {
    const p = await registerPhone()
    const g0 = hello.gestures
    const t = await token(p, 'personal-reveal', `${itemId}:password`)
    const ok = await http('POST', '/api/vault/personal/reveal', { id: itemId, field: 'password', gestureToken: t }, PHONE)
    expect(ok.json.value).toBe('MARKER-pw')
    expect((await http('POST', '/api/vault/personal/reveal', { id: itemId, field: 'password', gestureToken: t }, PHONE)).json.ok).toBe(false)
    const t2 = await token(p, 'personal-reveal', `${itemId}:password`)
    expect((await http('POST', '/api/vault/personal/reveal', { id: itemId, field: 'login', gestureToken: t2 }, PHONE)).json.ok).toBe(false)
    expect(hello.gestures).toBe(g0)
  })
  test('edit from the phone with an edit token for THAT item; a reveal token does not edit', async () => {
    const p = await registerPhone()
    const rt = await token(p, 'personal-reveal', `${itemId}:password`)
    expect((await http('POST', '/api/vault/personal/edit', { id: itemId, expectedVersion: 1, item: { kind: 'login', name: 'X' }, gestureToken: rt }, PHONE)).json.code).toBe('mobile-gesture-required')
    const et = await token(p, 'personal-edit', itemId)
    expect((await http('POST', '/api/vault/personal/edit', { id: itemId, expectedVersion: 1, item: { kind: 'login', name: 'Banco 2' }, gestureToken: et }, PHONE)).json.meta.name).toBe('Banco 2')
  })
  test('a token expires after 60 s', async () => {
    const p = await registerPhone()
    const t = await token(p, 'personal-reveal', `${itemId}:password`)
    T += 61_000
    expect((await http('POST', '/api/vault/personal/reveal', { id: itemId, field: 'password', gestureToken: t }, PHONE)).json.ok).toBe(false)
  })
})

describe('the opt-in code window', () => {
  test('turned on only from the computer (code + Hello); then a fresh code reveals for 30 s — reveals only', async () => {
    expect((await http('POST', '/api/vault/personal/mobile/code-reveal', { enabled: true, code: codeAt() }, PHONE)).json.code).toBe('desktop-only')
    expect((await http('POST', '/api/vault/personal/mobile/code-reveal', { enabled: true, code: codeAt() })).json.ok).toBe(true)
    next()
    expect((await http('POST', '/api/vault/personal/reveal', { id: itemId, field: 'password' }, PHONE)).status).toBe(401)
    expect((await http('POST', '/api/vault/personal/reveal', { id: itemId, field: 'password', code: codeAt() }, PHONE)).json.value).toBe('MARKER-pw')
    expect((await http('POST', '/api/vault/personal/reveal', { id: itemId, field: 'login' }, PHONE)).json.value).toBe('me')
    // never edit by code from the phone
    expect((await http('POST', '/api/vault/personal/edit', { id: itemId, expectedVersion: 1, item: { kind: 'login', name: 'Y' }, code: codeAt() }, PHONE)).json.ok).toBe(false)
    T += 31_000
    expect((await http('POST', '/api/vault/personal/reveal', { id: itemId, field: 'login' }, PHONE)).status).toBe(401)
  })
  test('removing a passkey is the computer\'s', async () => {
    await registerPhone()
    expect((await http('POST', '/api/vault/personal/mobile/passkeys/remove', { id: 'x', code: codeAt() }, PHONE)).json.code).toBe('desktop-only')
  })
})

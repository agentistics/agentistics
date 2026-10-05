/**
 * Review of v2.103.2 (vault) — H2, M1, M2, M3. Fake protectors and a fake clock; nothing is spawned and
 * nothing under ~/.agentistics is touched.
 *
 *  H2  the Hello that OPENED the vault covers one action only for the page whose unlock reply carried the
 *      proof, in its session, for the action it declared — a forged-Origin local caller gets the gesture.
 *  M1  an `.env` import that REPLACES a stored value costs the edit's gesture.
 *  M2  a secret created with "Sempre confirmar" OFF costs the gesture once.
 *  M3  the no-proof rows (list, import, …) are for this computer; a remote caller owes the code / grant.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base32Decode, hotp, type Protector, type ProtectorId, type UnwrapResult } from '@agentistics/vault'
import { FRESH_PRESENCE_MS, __resetVaultForTests, __setVaultClockForTests, sealToFile } from './service'
import { REMOTE_ROWS, VAULT_ACTION_ROWS, __resetGateForTests, rowFor } from './gate'
import { __resetPersonalForTests } from './personal'
import { handleVaultHttp } from './http'

const STORE = new Map<string, Uint8Array>()
type Fake = Protector & { gestures: number; deny: boolean }
function fake(id: ProtectorId): Fake {
  const self: Fake = {
    id, gestures: 0, deny: false,
    label: () => `${id} (fake)`,
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) { STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: '2026-10-05T00:00:00.000Z' } } },
    async unwrap(_r: unknown, kid: string): Promise<UnwrapResult> {
      if (id === 'hello') { if (self.deny) return { ok: false, kind: 'denied', reason: 'presence-cancelled' }; self.gestures++ }
      const d = STORE.get(`${id}:${kid}`)
      return d ? { ok: true, dek: new Uint8Array(d) } : { ok: false, kind: 'missing', reason: 'presence-lost: credential-deleted' }
    },
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
let dpapi = fake('dpapi'), hello = fake('hello')
let grant: string | undefined

type J = Record<string, any>
interface Who { session?: string; fresh?: string; peer?: string; host?: string; grant?: string | null }
/** A page on THIS computer by default; `peer`/`host` make it a LAN / tailnet caller. */
async function http(method: 'GET' | 'POST', path: string, body?: unknown, who: Who = {}): Promise<{ status: number; json: J }> {
  const host = who.host ?? 'localhost:47292'
  const g = who.grant === undefined ? grant : who.grant
  const headers: Record<string, string> = {
    host, 'sec-fetch-site': 'same-origin',
    ...(g ? { 'x-vault-grant': g } : {}), ...(who.fresh ? { 'x-vault-fresh': who.fresh } : {}),
    ...(method === 'POST' ? { 'content-type': 'application/json', origin: `http://${host}` } : {}),
  }
  const req = new Request(`http://${host}${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) })
  const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: who.session ?? 'local', peer: who.peer ?? '127.0.0.1' })
  if (!res) return { status: 404, json: {} }
  const text = await res.text()
  const json = text.startsWith('{') ? JSON.parse(text) : {}
  if (typeof json.grant === 'string' && !who.peer) grant = json.grant
  return { status: res.status, json }
}
const REMOTE: Who = { peer: '100.64.0.7', host: 'desk.tailnet.example:47292', grant: null }

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-review2103-'))
  STORE.clear(); grant = undefined
  dpapi = fake('dpapi'); hello = fake('hello')
  T = 1_800_000_000_000
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: [dpapi, hello], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock); __resetGateForTests(clock); __resetPersonalForTests(clock)
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('TEST-NOT-A-SECRET'))
  expect((await http('POST', '/api/vault/local-proof')).status).toBe(200)
  const a = await http('POST', '/api/vault/authenticator/begin', {})
  seed = base32Decode(a.json.secret)
  expect((await http('POST', '/api/vault/authenticator/confirm', { code: codeAt() })).status).toBe(200)
  next()
  expect((await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: codeAt() })).status).toBe(200)
  next()
  const r = await http('POST', '/api/vault/recovery/begin', {})
  const typed = (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!)
  expect((await http('POST', '/api/vault/recovery/confirm', { typed })).status).toBe(200)
  next()
})
afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-review2103-done-')), 'vault') }) })

const secret = { kind: 'login', name: 'Banco', fields: { login: 'eu@example.com', password: 'MARKER-pw' } }
async function create(item: J = secret): Promise<string> {
  const c = await http('POST', '/api/vault/personal', { item })
  expect(c.status).toBe(200)
  return c.json.meta.id
}
/** Lock, then unlock with Hello as the composer does; answers the reply's single-use proof (if any). */
async function lockAndUnlock(forAction?: string, who: Who = {}): Promise<string | undefined> {
  expect((await http('POST', '/api/vault/lock', {})).status).toBe(200)
  const u = await http('POST', '/api/vault/unlock', forAction ? { for: forAction } : {}, who)
  expect(u.json.ok).toBe(true)
  if (u.json.state === 'pending-stepup') expect((await http('POST', '/api/vault/unlock/code', { code: codeAt() }, who)).status).toBe(200)
  return u.json.fresh
}
const grantTo = (sessionId: string, id: string, who: Who = {}) => http('POST', '/api/vault/personal/grants', { sessionId, itemIds: [id] }, who)

describe('H2 — the fresh-unlock proof is bound to the page, its session and its action', () => {
  test('a forged-Origin local caller within 90 s does NOT get the free send; the page that unlocked does', async () => {
    const id = await create()
    const token = await lockAndUnlock('personal-grant:sess-1')
    expect(typeof token).toBe('string')
    T += 10_000
    // Any local process can claim Origin: http://localhost — without the reply's token it owes Hello.
    hello.deny = true
    const forged = await grantTo('sess-1', id)
    expect(forged.json.ok).toBe(false)
    expect(forged.json.code).toBe('presence-cancelled')
    // The page whose unlock reply carried the proof sends with NO second prompt (Hello still denied).
    const page = await grantTo('sess-1', id, { fresh: token })
    expect(page.json.ok).toBe(true)
    // Single-use: the same token does not cover a second send.
    expect((await grantTo('sess-1', id, { fresh: token })).json.ok).toBe(false)
  })
  test('the proof covers only the action it was declared for, in the session that unlocked', async () => {
    const id = await create()
    const token = await lockAndUnlock('personal-grant:sess-1')
    hello.deny = true
    expect((await grantTo('sess-2', id, { fresh: token })).json.ok).toBe(false)
    expect((await grantTo('sess-1', id, { fresh: token, session: 'someone-else' })).json.ok).toBe(false)
    expect((await http('POST', '/api/vault/personal/reveal', { id, field: 'password' }, { fresh: token })).json.value).toBeUndefined()
    // None of those consumed it: the right request still goes through.
    expect((await grantTo('sess-1', id, { fresh: token })).json.ok).toBe(true)
  })
  test('it expires after 90 s, and an unlock that declared nothing hands out no proof', async () => {
    const id = await create()
    const token = await lockAndUnlock('personal-grant:sess-1')
    T += FRESH_PRESENCE_MS + 1
    hello.deny = true
    expect((await grantTo('sess-1', id, { fresh: token })).json.ok).toBe(false)
    hello.deny = false
    expect(await lockAndUnlock()).toBeUndefined()
    const g0 = hello.gestures
    expect((await http('POST', '/api/vault/personal/reveal', { id, field: 'password' })).json.value).toBe('MARKER-pw')
    expect(hello.gestures).toBe(g0 + 1)
  })
  test('a reveal declared at unlock is covered once; a junk declaration is ignored', async () => {
    const id = await create()
    const token = await lockAndUnlock(`personal-reveal:${id}:password`)
    hello.deny = true
    expect((await http('POST', '/api/vault/personal/reveal', { id, field: 'login' }, { fresh: token })).json.ok).toBe(false)
    expect((await http('POST', '/api/vault/personal/reveal', { id, field: 'password' }, { fresh: token })).json.value).toBe('MARKER-pw')
    hello.deny = false
    expect(await lockAndUnlock('list; rm -rf /')).toBeUndefined()
  })
})

describe('M1 — import "replace" costs the edit gesture', () => {
  test('replace asks Hello once (denied = nothing changes); import/skip ask nothing', async () => {
    await create({ kind: 'env', name: 'API_KEY', fields: { value: 'old' } })
    const preview = async (text: string) => (await http('POST', '/api/vault/personal/import/preview', { text })).json.token
    hello.deny = true
    const t1 = await preview('API_KEY=MARKER-new')
    const no = await http('POST', '/api/vault/personal/import/commit', { token: t1, choices: [{ key: 'API_KEY', action: 'replace' }] })
    expect(no.json.ok).toBe(false)
    const items = (await http('GET', '/api/vault/personal')).json.items as J[]
    expect(items.find(i => i.name === 'API_KEY')!.version).toBe(1)
    hello.deny = false
    const g0 = hello.gestures
    const t2 = await preview('API_KEY=MARKER-new\nOTHER=1')
    const ok = await http('POST', '/api/vault/personal/import/commit', { token: t2, choices: [{ key: 'API_KEY', action: 'replace' }, { key: 'OTHER', action: 'import' }] })
    expect(ok.json).toMatchObject({ ok: true, created: 1, replaced: 1 })
    expect(hello.gestures).toBe(g0 + 1)
    const g1 = hello.gestures
    const t3 = await preview('NEW_ONE=1')
    expect((await http('POST', '/api/vault/personal/import/commit', { token: t3, choices: [{ key: 'NEW_ONE', action: 'import' }] })).json.ok).toBe(true)
    expect(hello.gestures).toBe(g1)
  })
})

describe('M2 — "Sempre confirmar" OFF at creation costs Hello once', () => {
  test('confirmEach:false on create asks the gesture; the default (ON) asks nothing', async () => {
    const g0 = hello.gestures
    await create()
    expect(hello.gestures).toBe(g0)
    hello.deny = true
    const no = await http('POST', '/api/vault/personal', { item: { ...secret, name: 'Off', confirmEach: false } })
    expect(no.json.ok).toBe(false)
    expect(((await http('GET', '/api/vault/personal')).json.items as J[]).some(i => i.name === 'Off')).toBe(false)
    hello.deny = false
    const ok = await http('POST', '/api/vault/personal', { item: { ...secret, name: 'Off', confirmEach: false } })
    expect(ok.json.ok).toBe(true)
    expect(hello.gestures).toBe(g0 + 1)
  })
})

describe('M3 — the no-proof rows are for THIS computer', () => {
  test('the table: remote callers get the code + read grant back for exactly the no-proof rows', () => {
    for (const [action, row] of Object.entries(REMOTE_ROWS)) {
      const base = VAULT_ACTION_ROWS[action as keyof typeof VAULT_ACTION_ROWS]
      expect(base).toMatchObject({ code: false, gesture: false })
      expect(row).toMatchObject({ code: true, grant: 'read' })
      expect(rowFor(action as keyof typeof VAULT_ACTION_ROWS, { session: 'http:local', loopback: true })).toBe(base)
      expect(rowFor(action as keyof typeof VAULT_ACTION_ROWS, { session: 'socket' })).toBe(base)
      expect(rowFor(action as keyof typeof VAULT_ACTION_ROWS, { session: 'http:local', loopback: false })).toBe(row!)
    }
  })
  test('a LAN / tailnet caller cannot list, read the inventory, import or reveal a confirm-off secret without the code', async () => {
    const off = (await http('POST', '/api/vault/personal', { item: { ...secret, name: 'Off', confirmEach: false } })).json.meta.id
    for (const p of ['/api/vault/personal', '/api/vault/personal/grants', `/api/vault/personal/versions?id=${off}`]) {
      const r = await http('GET', p, undefined, REMOTE)
      expect(r.status).toBe(401)
      expect(JSON.stringify(r.json)).not.toContain('Banco')
    }
    const inv = await http('GET', '/api/vault', undefined, REMOTE)
    expect(inv.json.needsStepUp).toBe(true)
    expect(inv.json.view.gates.list).toMatchObject({ code: true })
    expect((await http('POST', '/api/vault/personal/import/preview', { text: 'K=1' }, REMOTE)).status).toBe(401)
    const rv = await http('POST', '/api/vault/personal/reveal', { id: off, field: 'password' }, REMOTE)
    expect(rv.json.value).toBeUndefined()
    // With the code (what a phone that opened the vault already holds as its grant), it is answered.
    const r2 = await http('POST', '/api/vault/personal/reveal', { id: off, field: 'password', code: codeAt() }, REMOTE)
    expect(r2.json.value).toBe('MARKER-pw')
  })
  test('this computer still asks nothing for the list or a confirm-off reveal', async () => {
    const off = (await http('POST', '/api/vault/personal', { item: { ...secret, name: 'Off', confirmEach: false } })).json.meta.id
    grant = undefined
    expect((await http('GET', '/api/vault/personal')).status).toBe(200)
    const g0 = hello.gestures
    expect((await http('POST', '/api/vault/personal/reveal', { id: off, field: 'password' })).json.value).toBe('MARKER-pw')
    expect(hello.gestures).toBe(g0)
  })
})

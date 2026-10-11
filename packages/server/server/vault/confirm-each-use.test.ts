/**
 * VAULT.PERSONAL P1 — every gate row server-side, versions, trash, tamper, key rotation, the `.env`
 * import, and THE LINT: a value never leaves except through `reveal`. Fake protectors and a fake clock;
 * nothing is spawned and nothing under ~/.agentistics is touched.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, renameSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base32Decode, hotp, type Protector, type ProtectorId, type UnwrapResult } from '@agentistics/vault'
import { __resetVaultForTests, __setVaultClockForTests, sealToFile, vaultDir } from './service'
import { __resetGateForTests } from './gate'
import { __resetPersonalForTests, personalRoot } from './personal'
import { handleVaultHttp } from './http'
import { __resetGrantsForTests, __setConfirmEachUseForTests, authorizeUse, grantSession, pendingUseRequests } from './grants'

const STORE = new Map<string, Uint8Array>()
type Fake = Protector & { gestures: number; deny: boolean }
function fake(id: ProtectorId): Fake {
  const self: Fake = {
    id, gestures: 0, deny: false,
    label: () => `${id} (fake)`,
    async probe() { return { ok: true as const } },
    async wrap(dek: Uint8Array, kid: string) { STORE.set(`${id}:${kid}`, new Uint8Array(dek)); return { ok: true as const, record: { type: id, createdAt: '2026-10-03T00:00:00.000Z' } } },
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
let dir = ''
let dpapi = fake('dpapi'), hello = fake('hello')
let grant: string | undefined
const BODIES: { path: string; text: string }[] = []

type J = Record<string, any>
const RP = 'box.tail1234.ts.net'
const PHONE = { host: `${RP}:47292`, origin: `http://${RP}:47292`, peer: '100.64.0.7' }
const LOCAL = { host: 'localhost:47292', origin: 'http://localhost:47292', peer: '127.0.0.1' }
async function http(method: 'GET' | 'POST', path: string, body?: unknown, where = LOCAL, withGrant = true): Promise<{ status: number; json: J }> {
  const headers: Record<string, string> = { host: where.host, 'sec-fetch-site': 'same-origin', ...(grant && withGrant ? { 'x-vault-grant': grant } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', origin: where.origin } : {}) }
  const req = new Request(`${where.origin}${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) })
  const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'local', peer: where.peer })
  if (!res) return { status: 404, json: {} }
  const text = await res.text()
  BODIES.push({ path, text })
  const json = text.startsWith('{') ? JSON.parse(text) : {}
  if (typeof json.grant === 'string') grant = json.grant
  return { status: res.status, json }
}

async function fresh(withPresence = true): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-personal-'))
  STORE.clear(); BODIES.length = 0; grant = undefined
  dpapi = fake('dpapi'); hello = fake('hello')
  T = 1_800_000_000_000
  __resetVaultForTests({ dir: join(dir, 'vault'), lang: 'en', protectors: withPresence ? [dpapi, hello] : [dpapi], autoInit: { candidates: [dpapi] } })
  __setVaultClockForTests(clock); __resetGateForTests(clock); __resetPersonalForTests(clock)
  await sealToFile(join(dir, 'gh.sealed'), 'github-backup', 'github-backup', new TextEncoder().encode('TEST-NOT-A-SECRET'))
  if (withPresence) expect((await http('POST', '/api/vault/local-proof')).status).toBe(200)
  const a = await http('POST', '/api/vault/authenticator/begin', withPresence ? {} : { setupCode: (await import('./gate')).mintSetupCode().code })
  seed = base32Decode(a.json.secret)
  expect((await http('POST', '/api/vault/authenticator/confirm', { code: codeAt() })).status).toBe(200)
  next()
}
async function presenceOn(): Promise<void> {
  expect((await http('POST', '/api/vault/presence/enroll', { protector: 'hello', code: codeAt() })).status).toBe(200)
  next()
  const r = await http('POST', '/api/vault/recovery/begin', {})
  const typed = (r.json.positions as number[]).map(p => (r.json.words as string[])[p - 1]!)
  expect((await http('POST', '/api/vault/recovery/confirm', { typed })).status).toBe(200)
  next()
}

afterAll(async () => { __resetVaultForTests({ dir: join(await mkdtemp(join(tmpdir(), 'agentistics-cfu-done-')), 'vault') }) })
beforeEach(async () => { await fresh(); __resetGrantsForTests(clock) })

const key = { kind: 'api-key', name: 'OpenAI', fields: { value: 'MARKER-http-cfu' } }
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms))
async function pending(): Promise<string> {
  for (let i = 0; i < 300 && pendingUseRequests().length === 0; i++) await tick()
  return pendingUseRequests()[0]!.id
}
async function ask(): Promise<{ waiting: ReturnType<typeof authorizeUse>; id: string }> {
  const m = (await http('POST', '/api/vault/personal', { item: key, code: codeAt() })).json.meta
  await grantSession('s1', [m.id], [])
  __setConfirmEachUseForTests(true)
  const waiting = authorizeUse('s1', 'vault://openai', { command: 'echo hi', harness: 'codex' })
  return { waiting, id: await pending() }
}

describe('the confirmEachUse setter (VAULT.V4 §3.1)', () => {
  test('it is gated by the code, persisted in the view, audited, and reversible', async () => {
    grant = undefined // no live 5-minute read grant: the code is owed
    const view0 = (await http('GET', '/api/vault')).json
    expect(view0.confirmEachUse ?? false).toBe(false)
    const refused = await http('POST', '/api/vault/confirm-each-use', { enabled: true, code: '000000' })
    expect(refused.json.ok).toBe(false)
    expect((await http('POST', '/api/vault/confirm-each-use', { enabled: 'yes', code: codeAt() })).json.ok).toBe(false)
    const on = await http('POST', '/api/vault/confirm-each-use', { enabled: true, code: codeAt() })
    expect(on.json.ok).toBe(true)
    const { vaultConfirmEachUse } = await import('./service')
    expect(vaultConfirmEachUse()).toBe(true)
    expect((await http('GET', '/api/vault')).json.confirmEachUse).toBe(true)
    next()
    expect((await http('POST', '/api/vault/confirm-each-use', { enabled: false, code: codeAt() })).json.ok).toBe(true)
    expect(vaultConfirmEachUse()).toBe(false)
    const audit = readFileSync(join(vaultDir(), 'audit.jsonl'), 'utf8')
    expect(audit.match(/vault\.set-confirm-each-use/g)).toHaveLength(2)
  })
})

describe('use requests over HTTP (VAULT.V4 §3.4–3.5)', () => {
  test('the list carries no value; approve on this computer needs the presence proof, then opens', async () => {
    await presenceOn()
    const { waiting, id } = await ask()
    const list = await http('GET', '/api/vault/personal/use-requests')
    expect(list.json.requests).toHaveLength(1)
    expect(JSON.stringify(list.json)).not.toContain('MARKER')
    expect(list.json.requests[0]).toMatchObject({ id, name: 'OpenAI', harness: 'codex', command: 'echo hi' })
    // the vault is already open, so no unlock minted a token: the gesture is raised in the service, and a refused one leaves it pending
    hello.deny = true
    const refused = await http('POST', `/api/vault/personal/use/${id}/approve`, {})
    expect(refused.json.ok).toBe(false)
    expect(pendingUseRequests()).toHaveLength(1)
    hello.deny = false
    const g0 = hello.gestures
    const ok = await http('POST', `/api/vault/personal/use/${id}/approve`, {})
    expect(ok.json).toEqual({ ok: true })
    expect(hello.gestures).toBeGreaterThan(g0)
    expect(JSON.stringify(ok.json)).not.toContain('MARKER')
    expect(await waiting).toEqual({ ok: true, value: 'MARKER-http-cfu' })
  })

  test('DENY never asks for the presence gesture — on this computer or from a phone — only an authenticated session', async () => {
    await presenceOn()
    const { waiting, id } = await ask()
    const hello0 = hello.gestures
    const denied = await http('POST', `/api/vault/personal/use/${id}/deny`, {})
    expect(denied.json).toEqual({ ok: true })
    expect(hello.gestures).toBe(hello0)
    expect(await waiting).toEqual({ ok: false, code: 'use-denied' })
    const again = await http('POST', `/api/vault/personal/use/${id}/deny`, {})
    expect(again.json.ok).toBe(false)
  })

  test('from a phone: the list needs a session, approve needs a phone gesture token, deny needs neither the token nor Hello', async () => {
    await presenceOn()
    const { waiting, id } = await ask()
    // a phone with NO vault grant (no session proof) is refused the list and the deny
    const noList = await http('GET', '/api/vault/personal/use-requests', undefined, PHONE, false)
    expect(noList.json.ok).not.toBe(true)
    expect(JSON.stringify(noList.json)).not.toContain('MARKER')
    const noDeny = await http('POST', `/api/vault/personal/use/${id}/deny`, {}, PHONE, false)
    expect(noDeny.json.ok).not.toBe(true)
    expect(pendingUseRequests()).toHaveLength(1)
    // approve without the biometric token is refused with its own code
    const noToken = await http('POST', `/api/vault/personal/use/${id}/approve`, {}, PHONE)
    expect(noToken.json).toMatchObject({ ok: false, code: 'mobile-gesture-required' })
    expect(pendingUseRequests()).toHaveLength(1)
    // with the session, deny works without any gesture
    const denied = await http('POST', `/api/vault/personal/use/${id}/deny`, {}, PHONE)
    expect(denied.json).toEqual({ ok: true })
    expect(await waiting).toEqual({ ok: false, code: 'use-denied' })
  })
})

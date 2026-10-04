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
async function http(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: J }> {
  const headers: Record<string, string> = { host: 'localhost:47292', 'sec-fetch-site': 'same-origin', ...(grant ? { 'x-vault-grant': grant } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', origin: 'http://localhost:47292' } : {}) }
  const req = new Request(`http://localhost:47292${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) })
  const res = await handleVaultHttp(req, new URL(req.url), { cors: {}, session: 'local', peer: '127.0.0.1' })
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
const login = { kind: 'login', name: 'Banco Exemplo', tags: ['pessoal'], notes: 'conta corrente', url: 'https://banco.example', fields: { login: 'eu@example.com', password: 'MARKER-hunter2-Δ' } }

afterAll(() => { __resetVaultForTests({ dir: join(tmpdir(), 'agentistics-personal-done', 'vault') }) })
beforeEach(async () => { await fresh() })

describe('gate rows (spec §3)', () => {
  test('list and create need the code once (5-min read grant); the list carries metadata only', async () => {
    grant = undefined
    expect((await http('GET', '/api/vault/personal')).status).toBe(401)
    const c = await http('POST', '/api/vault/personal', { item: login, code: codeAt() })
    expect(c.status).toBe(200)
    expect(c.json.meta).toMatchObject({ kind: 'login', name: 'Banco Exemplo', fields: ['login', 'password'], version: 1 })
    const l = await http('GET', '/api/vault/personal')
    expect(l.status).toBe(200)
    expect(l.json.items).toHaveLength(1)
    expect(JSON.stringify(l.json)).not.toContain('MARKER')
    expect(JSON.stringify(l.json)).not.toContain('eu@example.com')
  })
  test('reveal asks the gesture EVERY time, never a grant; with presence on the code per policy (daily → none)', async () => {
    await presenceOn()
    const c = await http('POST', '/api/vault/personal', { item: login, code: codeAt() })
    const id = c.json.meta.id
    const g0 = hello.gestures
    const r1 = await http('POST', '/api/vault/personal/reveal', { id, field: 'password' })
    expect(r1.json).toMatchObject({ ok: true, value: 'MARKER-hunter2-Δ' })
    await http('POST', '/api/vault/personal/reveal', { id, field: 'login' })
    expect(hello.gestures).toBe(g0 + 2)
    hello.deny = true
    const no = await http('POST', '/api/vault/personal/reveal', { id, field: 'password' })
    expect(no.json.ok).toBe(false)
    expect(no.json.value).toBeUndefined()
  })
  test('without presence, reveal asks the code fresh — a grant never stands for it', async () => {
    await fresh(false)
    const id = (await http('POST', '/api/vault/personal', { item: login, code: codeAt() })).json.meta.id
    next()
    expect((await http('POST', '/api/vault/personal/reveal', { id, field: 'password' })).status).toBe(401)
    expect((await http('POST', '/api/vault/personal/reveal', { id, field: 'password', code: codeAt() })).json.value).toBe('MARKER-hunter2-Δ')
  })
  test('edit and trash ask the gesture FRESH (owner rule); a denied gesture changes nothing', async () => {
    await presenceOn()
    const m = (await http('POST', '/api/vault/personal', { item: login, code: codeAt() })).json.meta
    hello.deny = true
    expect((await http('POST', '/api/vault/personal/edit', { id: m.id, expectedVersion: 1, item: { ...login, name: 'X' } })).json.ok).toBe(false)
    expect((await http('POST', '/api/vault/personal/trash', { id: m.id, expectedVersion: 1 })).json.ok).toBe(false)
    hello.deny = false
    const g0 = hello.gestures
    const e = await http('POST', '/api/vault/personal/edit', { id: m.id, expectedVersion: 1, item: { kind: 'login', name: 'Banco Novo' } })
    expect(e.json.meta).toMatchObject({ version: 2, name: 'Banco Novo', fields: ['login', 'password'] }) // fields carried forward
    expect(hello.gestures).toBe(g0 + 1)
  })
  test('restore-version and purge ask the code FRESH even with a live grant, plus the gesture', async () => {
    await presenceOn()
    const m = (await http('POST', '/api/vault/personal', { item: login, code: codeAt() })).json.meta
    await http('POST', '/api/vault/personal/edit', { id: m.id, expectedVersion: 1, item: { ...login, fields: { password: 'second' } } })
    expect((await http('POST', '/api/vault/personal/restore-version', { id: m.id, version: 1, expectedVersion: 2 })).status).toBe(401)
    next()
    const r = await http('POST', '/api/vault/personal/restore-version', { id: m.id, version: 1, expectedVersion: 2, code: codeAt() })
    expect(r.json.meta.version).toBe(3)
    expect((await http('POST', '/api/vault/personal/reveal', { id: m.id, field: 'password' })).json.value).toBe('MARKER-hunter2-Δ')
    expect((await http('POST', '/api/vault/personal/purge', { id: m.id })).status).toBe(401)
    next()
    expect((await http('POST', '/api/vault/personal/purge', { id: m.id, code: codeAt() })).json.ok).toBe(true)
    expect((await http('GET', '/api/vault/personal')).json.items).toHaveLength(0)
  })
  test('the table carries every personal row, so the page draws its icons from the server', async () => {
    const v = await http('GET', '/api/vault')
    for (const k of ['personal-list', 'personal-reveal', 'personal-edit', 'personal-trash', 'personal-purge', 'personal-restore-version']) expect(v.json.gates[k]).toBeDefined()
  })
})

describe('versions, CAS, trash, tamper, rotation', () => {
  test('11 edits keep the newest 10 versions; a stale expectedVersion is a conflict', async () => {
    const m = (await http('POST', '/api/vault/personal', { item: { kind: 'password', name: 'p', fields: { password: 'v1' } }, code: codeAt() })).json.meta
    for (let v = 1; v <= 11; v++) expect((await http('POST', '/api/vault/personal/edit', { id: m.id, expectedVersion: v, item: { kind: 'password', name: 'p', fields: { password: `v${v + 1}` } } })).json.ok).toBe(true)
    const files = readdirSync(join(personalRoot(), 'items', m.id)).filter(f => f.endsWith('.meta.sealed'))
    expect(files).toHaveLength(10)
    const c = await http('POST', '/api/vault/personal/edit', { id: m.id, expectedVersion: 5, item: { kind: 'password', name: 'p' } })
    expect(c.json).toMatchObject({ ok: false, code: 'version-conflict', version: 12 })
    expect((await http('GET', `/api/vault/personal/versions?id=${m.id}`)).json.versions).toHaveLength(10)
  })
  test('trash keeps 30 days, restore brings it back, and after 30 days it is gone from disk', async () => {
    const m = (await http('POST', '/api/vault/personal', { item: login, code: codeAt() })).json.meta
    const t = await http('POST', '/api/vault/personal/trash', { id: m.id, expectedVersion: 1 })
    expect(t.json.meta.deletedAt).not.toBeNull()
    const r = await http('POST', '/api/vault/personal/restore', { id: m.id, expectedVersion: 2 })
    expect(r.json.meta.deletedAt).toBeNull()
    await http('POST', '/api/vault/personal/trash', { id: m.id, expectedVersion: 3 })
    T += 31 * 24 * 60 * 60_000
    grant = undefined
    expect((await http('GET', '/api/vault/personal', undefined)).status).toBe(401)
    const l = await http('GET', `/api/vault/personal`)
    void l
    // a fresh code (the grant expired with the month)
    const { requireVaultStepUp } = await import('./gate')
    expect((await requireVaultStepUp('personal-list', { session: 'http:local', code: codeAt() })).ok).toBe(true)
    const { listItems } = await import('./personal')
    expect(await listItems()).toHaveLength(0)
    expect(readdirSync(join(personalRoot(), 'items'))).not.toContain(m.id)
  })
  test('a file swapped between two items does not open (the sealed name binds id + version)', async () => {
    const a = (await http('POST', '/api/vault/personal', { item: { kind: 'note', name: 'A', fields: { value: 'aaa' } }, code: codeAt() })).json.meta
    const b = (await http('POST', '/api/vault/personal', { item: { kind: 'note', name: 'B', fields: { value: 'bbb' } } })).json.meta
    renameSync(join(personalRoot(), 'items', b.id, 'v000001.value.sealed'), join(personalRoot(), 'items', a.id, 'v000001.value.sealed'))
    const { revealField } = await import('./personal')
    expect((await revealField(a.id, 'value')).ok).toBe(false)
  })
  test('presence enrolment ROTATES the data key and personal records survive it', async () => {
    const m = (await http('POST', '/api/vault/personal', { item: login, code: codeAt() })).json.meta
    const kidBefore = JSON.parse(readFileSync(join(vaultDir(), 'vault.json'), 'utf8')).kid
    await presenceOn()
    const kidAfter = JSON.parse(readFileSync(join(vaultDir(), 'vault.json'), 'utf8')).kid
    expect(kidAfter).not.toBe(kidBefore)
    expect((await http('POST', '/api/vault/personal/reveal', { id: m.id, field: 'password' })).json.value).toBe('MARKER-hunter2-Δ')
  })
})

describe('groups', () => {
  test('create, move in/out, rename; deleting a group moves its items out, never deletes them', async () => {
    const g = (await http('POST', '/api/vault/personal/groups', { name: 'pelvie', code: codeAt() })).json.group
    const m = (await http('POST', '/api/vault/personal', { item: { ...login, groupId: g.id } })).json.meta
    expect(m.groupId).toBe(g.id)
    const out = await http('POST', '/api/vault/personal/move', { id: m.id, expectedVersion: 1, groupId: null })
    expect(out.json.meta.groupId).toBeNull()
    await http('POST', '/api/vault/personal/move', { id: m.id, expectedVersion: 2, groupId: g.id })
    expect((await http('POST', '/api/vault/personal/groups/rename', { id: g.id, expectedVersion: 1, name: 'Pelvie' })).json.group.name).toBe('Pelvie')
    const d = await http('POST', '/api/vault/personal/groups/delete', { id: g.id })
    expect(d.json).toMatchObject({ ok: true, moved: 1 })
    const l = await http('GET', '/api/vault/personal')
    expect(l.json.groups).toHaveLength(0)
    expect(l.json.items[0].groupId).toBeNull()
  })
})

describe('.env import', () => {
  test('preview answers keys and clashes, never a value; commit imports, skips, renames and replaces', async () => {
    await http('POST', '/api/vault/personal', { item: { kind: 'env', name: 'API_KEY', fields: { value: 'old' } }, code: codeAt() })
    const p = await http('POST', '/api/vault/personal/import/preview', { text: 'export API_KEY=MARKER-new\nDB_URL="postgres://u:MARKER-pw@h/db"\nOTHER=1\n# c\n' })
    expect(p.json.keys.map((k: J) => k.key)).toEqual(['API_KEY', 'DB_URL', 'OTHER'])
    expect(p.json.keys[0].clash).not.toBeNull()
    expect(JSON.stringify(p.json)).not.toContain('MARKER')
    const c = await http('POST', '/api/vault/personal/import/commit', {
      token: p.json.token,
      choices: [{ key: 'API_KEY', action: 'replace' }, { key: 'DB_URL', action: 'rename', name: 'PROD_DB_URL' }, { key: 'OTHER', action: 'skip' }],
    })
    expect(c.json).toMatchObject({ ok: true, created: 1, replaced: 1, skipped: 1 })
    const items = (await http('GET', '/api/vault/personal')).json.items as J[]
    expect(items.map(i => i.name).sort()).toEqual(['API_KEY', 'PROD_DB_URL'])
    expect(items.find(i => i.name === 'API_KEY')!.version).toBe(2)
    // the token is single use
    expect((await http('POST', '/api/vault/personal/import/commit', { token: p.json.token, choices: [] })).json.code).toBe('no-import')
  })
  test('a clash left as "import" is never overwritten', async () => {
    await http('POST', '/api/vault/personal', { item: { kind: 'env', name: 'K', fields: { value: 'keep' } }, code: codeAt() })
    const p = await http('POST', '/api/vault/personal/import/preview', { text: 'K=new' })
    const c = await http('POST', '/api/vault/personal/import/commit', { token: p.json.token, choices: [{ key: 'K', action: 'import' }] })
    expect(c.json).toMatchObject({ created: 0, skipped: 1 })
  })
})

/**
 * THE LINT (spec §5): a marker value is sealed, every route is driven, and the marker appears ONLY in
 * the body of `/api/vault/personal/reveal` — never in another body, never in audit.jsonl (which also
 * never carries the secret's NAME), never on stdout/stderr.
 */
describe('no value leaves except through reveal', () => {
  test('marker in bodies, audit and console', async () => {
    const out: string[] = []
    const ow = process.stdout.write.bind(process.stdout), ew = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true }) as typeof process.stdout.write
    process.stderr.write = ((s: string | Uint8Array) => { out.push(String(s)); return true }) as typeof process.stderr.write
    try {
      await presenceOn()
      BODIES.length = 0
      const g = (await http('POST', '/api/vault/personal/groups', { name: 'grp', code: codeAt() })).json.group
      const m = (await http('POST', '/api/vault/personal', { item: { ...login, groupId: g.id } })).json.meta
      await http('GET', '/api/vault/personal')
      await http('GET', `/api/vault/personal/versions?id=${m.id}`)
      await http('POST', '/api/vault/personal/reveal', { id: m.id, field: 'password' })
      await http('POST', '/api/vault/personal/edit', { id: m.id, expectedVersion: 1, item: { kind: 'login', name: 'Banco Exemplo', notes: 'n2' } })
      await http('POST', '/api/vault/personal/move', { id: m.id, expectedVersion: 2, groupId: null })
      await http('POST', '/api/vault/personal/trash', { id: m.id, expectedVersion: 3 })
      await http('POST', '/api/vault/personal/restore', { id: m.id, expectedVersion: 4 })
      next()
      await http('POST', '/api/vault/personal/restore-version', { id: m.id, version: 1, expectedVersion: 5, code: codeAt() })
      const p = await http('POST', '/api/vault/personal/import/preview', { text: 'K=MARKER-hunter2-Δ' })
      await http('POST', '/api/vault/personal/import/commit', { token: p.json.token, choices: [{ key: 'K', action: 'import' }] })
      await http('GET', '/api/vault')
      await http('GET', '/api/vault/credentials')
      next()
      await http('POST', '/api/vault/personal/purge', { id: m.id, code: codeAt() })
    } finally { process.stdout.write = ow; process.stderr.write = ew }
    const leaks = BODIES.filter(b => b.text.includes('MARKER') && b.path !== '/api/vault/personal/reveal').map(b => b.path)
    expect(leaks).toEqual([])
    expect(BODIES.some(b => b.path === '/api/vault/personal/reveal' && b.text.includes('MARKER'))).toBe(true)
    const audit = readFileSync(join(vaultDir(), 'audit.jsonl'), 'utf8')
    expect(audit).not.toContain('MARKER')
    expect(audit).not.toContain('Banco Exemplo')
    expect(audit).toContain('vault.personal-reveal')
    expect(out.join('')).not.toContain('MARKER')
    // and nothing on disk holds it in the clear
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
    for (const f of walk(dir)) expect(readFileSync(f).includes(Buffer.from('MARKER')), f).toBe(false)
  })
})

describe('§8 grants over HTTP', () => {
  test('granting asks the gesture fresh; the answer carries references and a briefing, never a value', async () => {
    await presenceOn()
    const m = (await http('POST', '/api/vault/personal', { item: login, code: codeAt() })).json.meta
    hello.deny = true
    expect((await http('POST', '/api/vault/personal/grants', { sessionId: 'abc123', itemIds: [m.id] })).json.ok).toBe(false)
    hello.deny = false
    const g0 = hello.gestures
    const r = await http('POST', '/api/vault/personal/grants', { sessionId: 'abc123', itemIds: [m.id] })
    expect(r.json.ok).toBe(true)
    expect(hello.gestures).toBe(g0 + 1)
    expect(r.json.refs.map((x: J) => x.ref)).toEqual(['vault://banco-exemplo/login', 'vault://banco-exemplo/password'])
    expect(JSON.stringify(r.json)).not.toContain('MARKER')
    expect(JSON.stringify(r.json)).not.toContain('eu@example.com')
    const l = await http('GET', '/api/vault/personal/grants')
    expect(l.json.grants[0].sessionId).toBe('abc123')
    expect((await http('POST', '/api/vault/personal/grants/revoke', { sessionId: 'abc123' })).json.revoked).toBe(true)
  })
})

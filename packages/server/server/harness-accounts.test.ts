import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexIdentity, createHarnessAccounts, probeAccountIdentity, __setHarnessAccountsForTest, IDENTITY_PROBES, ISOLATION_ENV } from './harness-accounts'
import { handleAccountsRequest } from './accounts-web'
import { routeCapability } from './capability-guard'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'accounts-test-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const identity = { key: 'sample-account', label: 'Sample account', plan: 'Plus' }

test('registers identities, caches probes for 60 seconds, preserves availability after refresh and restart', async () => {
  let now = 1000, calls = 0
  const file = join(dir, 'accounts.json')
  const store = createHarnessAccounts({ file, now: () => now, probe: async () => { calls++; return identity } })
  expect((await store.list(['codex']))[0]).toMatchObject({ ...identity, id: expect.stringMatching(/^acc_[a-f0-9]{12}$/), root: null, harness: 'codex', available: true, firstSeen: 1000, lastSeen: 1000 })
  await store.setAvailable('codex', identity.key, false)
  now += 59_999
  expect((await store.current(['codex']))[0]?.available).toBe(false)
  expect(calls).toBe(1)
  now += 1
  expect((await store.current(['codex']))[0]?.available).toBe(false)
  expect(calls).toBe(2)
  const restarted = createHarnessAccounts({ file, probe: async () => identity })
  expect((await restarted.list(['codex']))[0]?.available).toBe(false)
  expect(JSON.parse(await readFile(file, 'utf8')).accounts[0].firstSeen).toBe(1000)
})

test('codex reader touches only account_id and returns no credential fields', () => {
  const raw = { account_id: 'sample-account' }
  // Accessors fail if the whitelist starts reading credential fields; no secret fixture values.
  for (const key of ['tokens', 'access_token', 'refresh_token', 'id_token', 'OPENAI_API_KEY']) {
    Object.defineProperty(raw, key, { get() { throw new Error('Credential field accessed') } })
  }
  expect(codexIdentity(raw)).toEqual({ key: 'sample-account', label: 'sample-account' })
  expect(codexIdentity({})).toEqual({ key: 'default', label: 'Conta padrão' })
})

test('probe timeout and errors fall back without throwing', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), timeoutMs: 15,
    probe: harness => harness === 'claude' ? new Promise(() => {}) : Promise.reject(new Error('Unavailable')) })
  const accounts = await store.current(['claude', 'codex'])
  expect(accounts.map(a => a.key)).toEqual(['default', 'default'])
})

test('real copilot config probe accepts leading JSONC comment lines and preserves slashes inside strings', async () => {
  const copilotHome = join(dir, 'copilot-home')
  await mkdir(copilotHome, { recursive: true })
  await writeFile(join(copilotHome, 'config.json'), [
    '// Copilot configuration fixture',
    '  // Another full-line comment',
    '{',
    '  // Identity metadata',
    '  "lastLoggedInUser": { "login": "fixture//user", "host": "github.com" },',
    '  "documentation": "https://example.invalid/config",',
    '  "token": "FAKE_JSONC_TOKEN"',
    '}',
  ].join('\r\n'))
  const result = await probeAccountIdentity('copilot', { copilotHome })
  expect(result).toEqual({ key: 'github.com:fixture//user', label: 'fixture//user' })
  expect(JSON.stringify(result)).not.toContain('FAKE')
})

test('unknown identity after restart inherits the latest confirmed login even with tied timestamps', async () => {
  const file = join(dir, 'accounts.json')
  let key = 'first-login'
  let now = 1000
  const store = createHarnessAccounts({ file, now: () => now, probe: async () => ({ key, label: key }) })
  await store.current(['codex'])
  await store.setAvailable('codex', key, false)
  key = 'second-login'
  now += 60_000
  expect((await store.current(['codex']))[0]?.available).toBe(true)
  // Return to an older known account with the same timestamp as the second account.
  const returning = createHarnessAccounts({ file, now: () => now, probe: async () => ({ key: 'first-login', label: 'First' }) })
  expect((await returning.current(['codex']))[0]?.available).toBe(false)
  const beforeFailure = await readFile(file, 'utf8')
  const restarted = createHarnessAccounts({ file, now: () => now, probe: async () => codexIdentity({}) })
  expect((await restarted.current(['codex']))[0]).toMatchObject({ key: 'default', available: false })
  expect(await readFile(file, 'utf8')).toBe(beforeFailure)
  const changed = createHarnessAccounts({ file, now: () => now, probe: async () => ({ key: 'second-login', label: 'Second' }) })
  expect((await changed.current(['codex']))[0]?.available).toBe(true)
  const failedAgain = createHarnessAccounts({ file, probe: async () => { throw new Error('Unavailable') } })
  expect((await failedAgain.current(['codex']))[0]).toMatchObject({ key: 'default', available: true })
})

test('GET and PATCH round trip an encoded account key and reject malformed requests', async () => {
  __setHarnessAccountsForTest(createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => ({ key: 'github.com:sample/user', label: 'sample' }) }))
  const get = () => handleAccountsRequest(new Request('http://localhost/api/accounts'), ['copilot'])
  expect((await (await get()).json()).accounts[0].available).toBe(true)
  const patch = (body: unknown, key = 'github.com%3Asample%2Fuser') => handleAccountsRequest(new Request(`http://localhost/api/accounts/copilot/${key}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), ['copilot'])
  expect((await (await patch({ available: false })).json()).account.available).toBe(false)
  expect((await (await get()).json()).accounts[0].available).toBe(false)
  expect((await patch({ available: true })).status).toBe(200)
  expect((await (await get()).json()).accounts[0].available).toBe(true)
  expect((await patch({ available: 'false' })).status).toBe(400)
  expect((await patch({ available: false }, 'unknown')).status).toBe(404)
  expect(routeCapability('/api/accounts')).toBe('localTranscripts')
  expect(routeCapability('/api/accounts/copilot/sample')).toBe('localTranscripts')
})


test('v1 migrates once, binds the newest confirmed identity per harness, and persists private v2 storage', async () => {
  const file = join(dir, 'accounts.json')
  await writeFile(file, JSON.stringify([
    { ...identity, harness: 'codex', key: 'older', available: false, firstSeen: 1, lastSeen: 10 },
    { ...identity, harness: 'codex', key: 'newer', firstSeen: 2, lastSeen: 20 },
    { ...identity, harness: 'codex', key: 'default', firstSeen: 3, lastSeen: 30 },
    { ...identity, harness: 'copilot', key: 'github.com:user', firstSeen: 4, lastSeen: 15 },
  ]))
  const store = createHarnessAccounts({ file, probe: async () => { throw new Error('Unavailable') } })
  const data = await store.readAccounts()
  expect(data.version).toBe(2)
  expect(data.accounts).toHaveLength(4)
  expect(new Set(data.accounts.map(a => a.id)).size).toBe(4)
  for (const account of data.accounts) {
    expect(account.id).toMatch(/^acc_[a-f0-9]{12}$/)
    expect(account.root).toBeNull()
  }
  expect(data.accounts[0]?.available).toBe(false)
  expect(data.bindings).toEqual({ 'codex:': data.accounts[1]!.id, 'copilot:': data.accounts[3]!.id })
  expect(data.segments).toEqual({})
  const disk = await readFile(file, 'utf8')
  expect(await store.readAccounts()).toEqual(data)
  expect(await createHarnessAccounts({ file }).readAccounts()).toEqual(data)
  expect(await readFile(file, 'utf8')).toBe(disk)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
})

test('two roots retain independent bindings and caches for one harness', async () => {
  const calls: Array<string | null> = []
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async (_, root) => {
    calls.push(root)
    return { key: root!, label: 'Owner label' }
  } })
  const first = await store.current('codex', '/first')
  const second = await store.current('codex', '/second')
  expect(first.id).not.toBe(second.id)
  expect((await store.current('codex', '/first')).id).toBe(first.id)
  expect(calls).toEqual(['/first', '/second'])
  const data = await store.readAccounts()
  expect(data.accounts).toHaveLength(2)
  expect(data.bindings).toEqual({ 'codex:/first': first.id, 'codex:/second': second.id })
})

test('binding adopts a known id, plan, nickname, segment and unavailable setting in a second root', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), now: () => 1000 })
  const first = await store.bind('/first', { ...identity, harness: 'codex' })
  expect(first.previous).toBeUndefined()
  await store.setAvailable('codex', identity.key, false)
  await store.setNickname(first.account.id, 'Work')
  await store.startSegment(first.account.id, 900)
  const second = await store.bind('/second', { key: identity.key, label: 'Updated owner label', harness: 'codex' })
  expect(second.account).toMatchObject({ id: first.account.id, root: '/second', available: false, nickname: 'Work', plan: 'Plus', firstSeen: 1000 })
  expect(await store.byId(first.account.id)).toEqual(second.account)
  const changed = await store.bind('/second', { harness: 'codex', key: 'other', label: 'Other' })
  expect(changed.previous?.id).toBe(first.account.id)
  expect(changed.previous?.root).toBeNull()
  expect(changed.account.id).not.toBe(first.account.id)
  expect((await store.readAccounts()).segments).toEqual({ [first.account.id]: 900 })
  expect(await store.byId('unknown')).toBeNull()
})

test('failed root probes preserve the binding, availability, lastSeen and file across restart', async () => {
  const file = join(dir, 'accounts.json')
  let now = 1000
  const store = createHarnessAccounts({ file, now: () => now, probe: async () => identity })
  const account = await store.current('claude', '/root')
  await store.setAvailable('claude', identity.key, false)
  const disk = await readFile(file, 'utf8')
  now += 60_000
  const restarted = createHarnessAccounts({ file, now: () => now, probe: async () => { throw new Error('Unavailable') } })
  expect(await restarted.current('claude', '/root')).toMatchObject({ id: account.id, available: false, lastSeen: 1000 })
  expect((await restarted.readAccounts()).bindings['claude:/root']).toBe(account.id)
  expect(await readFile(file, 'utf8')).toBe(disk)
})

test('concurrent store instances cannot lose accounts or mint duplicate migration ids', async () => {
  const file = join(dir, 'nested', 'accounts.json')
  const options = { file, probe: async (_: unknown, root: string | null) => ({ key: root!, label: 'Owner label' }) }
  const first = createHarnessAccounts(options)
  const second = createHarnessAccounts(options)
  const accounts = await Promise.all([first.current('codex', '/one'), second.current('codex', '/two')])
  expect((await first.readAccounts()).accounts.map(a => a.id).sort()).toEqual(accounts.map(a => a.id).sort())
  await writeFile(file, JSON.stringify([{ ...identity, harness: 'codex', firstSeen: 1, lastSeen: 1 }]))
  const migrated = await Promise.all([first.readAccounts(), second.readAccounts()])
  expect(migrated[0]).toEqual(migrated[1])
})

test('forced probes bypass only the requested root cache', async () => {
  let calls = 0
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => ({ key: `login-${++calls}`, label: 'Owner label' }) })
  const first = await store.current('codex', '/one')
  const second = await store.current('codex', '/two')
  expect((await store.forceProbe('codex', '/one')).key).toBe('login-3')
  const changed = await store.current('codex', '/one')
  expect(changed.id).not.toBe(first.id)
  expect((await store.current('codex', '/two')).id).toBe(second.id)
  expect(calls).toBe(3)
})

test('root probes read only whitelisted identity fields and key API mode without reading credentials', async () => {
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ account_id: 'root-account', tokens: { access_token: 'FAKE_TOKEN' } }))
  expect(await probeAccountIdentity('codex', dir)).toEqual({ key: 'root-account', label: 'root-account' })
  await writeFile(join(dir, 'config.json'), JSON.stringify({ lastLoggedInUser: { host: 'example.invalid', login: 'owner' }, token: 'FAKE_TOKEN' }))
  expect(await probeAccountIdentity('copilot', dir)).toEqual({ key: 'example.invalid:owner', label: 'owner' })
  const raw = { auth_mode: 'apikey' }
  Object.defineProperty(raw, 'OPENAI_API_KEY', { get() { throw new Error('Credential field accessed') } })
  expect(codexIdentity(raw)).toEqual({ key: 'apikey', label: 'apikey' })
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'FAKE_KEY' }))
  expect(await probeAccountIdentity('codex', dir)).toEqual({ key: 'apikey', label: 'apikey' })
})

test('meterless harnesses key canonical roots and expose isolation capabilities from tables', async () => {
  const alias = join(dir, 'alias')
  const root = join(dir, 'root')
  const other = join(dir, 'other')
  await mkdir(root)
  await mkdir(other)
  await symlink(root, alias)
  for (const harness of ['gemini', 'kimi'] as const) {
    expect(IDENTITY_PROBES[harness]).toBeNull()
    const result = await probeAccountIdentity(harness, root)
    expect(result.key).toMatch(/^root:[a-f0-9]{12}$/)
    expect(await probeAccountIdentity(harness, alias)).toEqual(result)
    expect((await probeAccountIdentity(harness, other)).key).not.toBe(result.key)
  }
  expect(IDENTITY_PROBES.antigravity).toBeNull()
  expect(ISOLATION_ENV).toEqual({ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', copilot: 'COPILOT_HOME', gemini: 'GEMINI_CLI_HOME', kimi: 'KIMI_CODE_HOME', antigravity: null, opencode: null })
})

test('real claude probe passes the selected root and returns per-seat keys with fallback identity fields', async () => {
  const bin = join(dir, 'bin')
  await mkdir(bin)
  const executable = join(bin, 'claude')
  await writeFile(executable, '#!/bin/sh\ncat "$CLAUDE_CONFIG_DIR/status.json"\n')
  await chmod(executable, 0o700)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    for (const [fields, expected] of [
      [{ orgId: 'org', email: 'seat@example.invalid', subscriptionType: 'team' }, { key: 'org:seat@example.invalid', label: 'seat@example.invalid', plan: 'team' }],
      [{ orgId: 'org', email: 'other@example.invalid' }, { key: 'org:other@example.invalid', label: 'other@example.invalid' }],
      [{ orgId: 'org' }, { key: 'org', label: 'org' }],
      [{ email: 'seat@example.invalid' }, { key: 'seat@example.invalid', label: 'seat@example.invalid' }],
      [{}, { key: 'default', label: 'Conta padrão' }],
    ] as const) {
      await writeFile(join(dir, 'status.json'), JSON.stringify({ ...fields, access_token: 'FAKE_TOKEN' }))
      expect(await probeAccountIdentity('claude', dir)).toEqual(expected)
    }
  } finally { process.env.PATH = path }
})

test('PATCH by id updates availability and nickname while retaining legacy PATCH support', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => identity })
  __setHarnessAccountsForTest(store)
  const account = await store.current('codex')
  const patch = (id: string, body: unknown) => handleAccountsRequest(new Request(`http://localhost/api/accounts/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), ['codex'])
  expect((await (await patch(account.id, { available: false, nickname: 'Work' })).json()).account).toMatchObject({ id: account.id, available: false, nickname: 'Work' })
  expect((await (await patch(account.id, { nickname: '' })).json()).account.nickname).toBe('')
  for (const body of [{}, null, [], { available: 'no' }, { nickname: false }]) expect((await patch(account.id, body)).status).toBe(400)
  expect((await patch('unknown', { nickname: 'Work' })).status).toBe(404)
  expect((await patch('%xx', { nickname: 'Work' })).status).toBe(400)
  expect((await handleAccountsRequest(new Request(`http://localhost/api/accounts/${account.id}`), ['codex'])).status).toBe(405)
})

test('the identity registry never logs labels, emails or probe documents', async () => {
  const source = await readFile(join(import.meta.dir, 'harness-accounts.ts'), 'utf8')
  expect(source).not.toMatch(/console\s*(?:\.|\[)/)
})

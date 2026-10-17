import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { codexIdentity, createHarnessAccounts, probeAccountIdentity, sameLogin, __setHarnessAccountsForTest, IDENTITY_PROBES, ISOLATION_ENV } from './harness-accounts'
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
  expect((await store.list(['codex']))[0]).toEqual({ ...identity, id: expect.stringMatching(/^acc_[0-9a-f]{12}$/), root: null, harness: 'codex', available: true, firstSeen: 1000, lastSeen: 1000 })
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
  expect((await (await patch(account.id, { nickname: '  A\nB\u0007' + 'x'.repeat(60) })).json()).account.nickname).toBe(('A B ' + 'x'.repeat(60)).slice(0, 40))
  expect((await (await patch(account.id, { nickname: '' })).json()).account).not.toHaveProperty('nickname')
  for (const body of [{}, null, [], { available: 'no' }, { nickname: false }]) expect((await patch(account.id, body)).status).toBe(400)
  expect((await patch('unknown', { nickname: 'Work' })).status).toBe(404)
  expect((await patch('%xx', { nickname: 'Work' })).status).toBe(400)
  expect((await handleAccountsRequest(new Request(`http://localhost/api/accounts/${account.id}`), ['codex'])).status).toBe(405)
})

test('the identity registry never logs labels, emails or probe documents', async () => {
  const source = await readFile(join(import.meta.dir, 'harness-accounts.ts'), 'utf8')
  expect(source).not.toMatch(/console\s*(?:\.|\[)/)
})

test('a fresh lock never fails reads; writes wait and then refuse', async () => {
  const file = join(dir, 'accounts.json')
  const store = createHarnessAccounts({ file, probe: async () => identity })
  const known = await store.current('codex')
  await mkdir(`${file}.lock`)
  expect((await store.readAccounts()).accounts).toHaveLength(1)
  expect((await store.byId(known.id))?.id).toBe(known.id)
  expect((await store.list(['codex']))).toHaveLength(1)
  const started = Date.now()
  await expect(store.setAvailable('codex', identity.key, false)).rejects.toThrow('lock unavailable')
  expect(Date.now() - started).toBeGreaterThanOrEqual(4000)
  expect((await store.readAccounts()).accounts[0]!.available).toBe(true)
}, 15_000)

test('a write waits for a manually held lock and proceeds once it is released', async () => {
  const file = join(dir, 'accounts.json')
  const store = createHarnessAccounts({ file, probe: async () => identity })
  await store.current('codex')
  await mkdir(`${file}.lock`)
  let done = false
  const pending = store.setAvailable('codex', identity.key, false).then(r => { done = true; return r })
  await new Promise(r => setTimeout(r, 300))
  expect(done).toBe(false)
  await rm(`${file}.lock`, { recursive: true })
  expect((await pending)?.available).toBe(false)
})

test('a v2 document is normalised field by field', async () => {
  const file = join(dir, 'accounts.json')
  await writeFile(file, JSON.stringify({ version: 2, accounts: [{ id: 'acc_aaaaaaaaaaaa', harness: 'codex', key: 'k', label: 'L', root: null, available: true, firstSeen: 1, lastSeen: 1 }, { nope: 1 }] }))
  const data = await createHarnessAccounts({ file }).readAccounts()
  expect(data.accounts).toHaveLength(1)
  expect(data.bindings).toEqual({})
  expect(data.segments).toEqual({})
})

test('unknown versions and unparseable files are backed up (0600) before being overwritten', async () => {
  for (const content of [JSON.stringify({ version: 3, accounts: [{ keep: 'me' }] }), '{ not json']) {
    const file = join(dir, `accounts-${content.length}.json`)
    await writeFile(file, content)
    const store = createHarnessAccounts({ file, probe: async () => identity })
    await store.current('codex')
    const backups = (await readdir(dir)).filter(n => n.startsWith(`${file.split('/').pop()}.bak.`))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(dir, backups[0]!), 'utf8')).toBe(content)
    expect((await stat(join(dir, backups[0]!))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2)
  }
})

test('v1 duplicates of one (harness,key) merge into a single account', async () => {
  const file = join(dir, 'accounts.json')
  await writeFile(file, JSON.stringify([
    { ...identity, harness: 'codex', available: false, firstSeen: 5, lastSeen: 10 },
    { ...identity, label: 'Newer', harness: 'codex', firstSeen: 2, lastSeen: 20 },
  ]))
  const data = await createHarnessAccounts({ file }).readAccounts()
  expect(data.accounts).toHaveLength(1)
  expect(data.accounts[0]).toMatchObject({ label: 'Newer', available: false, firstSeen: 2, lastSeen: 20 })
  expect(Object.values(data.bindings)).toEqual([data.accounts[0]!.id])
})

test('roots are normalised once: trailing slashes and relative segments share one binding', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async (_, root) => ({ key: root!, label: 'x' }) })
  const a = await store.current('codex', '/one/')
  const b = await store.current('codex', '/one/../one')
  expect(b.id).toBe(a.id)
  expect(Object.keys((await store.readAccounts()).bindings)).toEqual(['codex:/one'])
})

test('v1 file under a held lock: reads never expose ids that differ from the persisted ones', async () => {
  const file = join(dir, 'accounts.json')
  await writeFile(file, JSON.stringify([{ harness: 'codex', key: 'k1', label: 'L', available: true, firstSeen: 1, lastSeen: 2 }]))
  const store = createHarnessAccounts({ file, probe: async () => identity })
  await mkdir(`${file}.lock`)
  const during = [await store.readAccounts(), await store.readAccounts()]
  expect(during.flatMap(d => d.accounts.map(a => a.id))).toEqual([])
  expect(JSON.parse(await readFile(file, 'utf8'))).toBeInstanceOf(Array)
  await rm(`${file}.lock`, { recursive: true })
  const persisted = await store.readAccounts()
  expect(persisted.accounts).toHaveLength(1)
  expect(JSON.parse(await readFile(file, 'utf8')).accounts[0].id).toBe(persisted.accounts[0]!.id)
  expect((await store.readAccounts()).accounts[0]!.id).toBe(persisted.accounts[0]!.id)
}, 15_000)

const bindOnce = (store: ReturnType<typeof createHarnessAccounts>) => store.bind('/r', { ...identity, harness: 'codex' })

test('a failed backup propagates, keeps the original bytes, caches no marker and is retried later', async () => {
  const file = join(dir, 'accounts.json')
  const original = JSON.stringify({ version: 9, accounts: [{ keep: 'me' }] })
  await writeFile(file, original)
  let fail = true
  const attempts: string[] = []
  const store = createHarnessAccounts({
    file, probe: async () => identity,
    writeBackup: async (path, raw) => {
      attempts.push(path)
      if (fail) throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' })
      await writeFile(path, raw, { mode: 0o600, flag: 'wx' })
    },
  })
  await expect(bindOnce(store)).rejects.toThrow('injected ENOSPC')
  expect(attempts).toHaveLength(1)
  expect(await readFile(file, 'utf8')).toBe(original)
  fail = false
  await bindOnce(store)
  expect(attempts).toHaveLength(2)
  const baks = (await readdir(dir)).filter(n => n.includes('.bak.'))
  expect(baks).toHaveLength(1)
  expect(await readFile(join(dir, baks[0]!), 'utf8')).toBe(original)
  expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2)
  expect(JSON.parse(await readFile(file, 'utf8')).accounts[0].key).toBe(identity.key)
})

test('backup name collisions are retried, then exhaustion throws and the original survives', async () => {
  const file = join(dir, 'accounts.json')
  const original = '{ not json'
  await writeFile(file, original)
  let attempts = 0
  const store = createHarnessAccounts({
    file, probe: async () => identity,
    writeBackup: async () => { attempts++; throw Object.assign(new Error('exists'), { code: 'EEXIST' }) },
  })
  await expect(bindOnce(store)).rejects.toThrow('exists')
  expect(attempts).toBe(3)
  expect(await readFile(file, 'utf8')).toBe(original)
  let calls = 0
  const retry = createHarnessAccounts({
    file, probe: async () => identity,
    writeBackup: async (path, raw) => {
      if (calls++ === 0) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      await writeFile(path, raw, { mode: 0o600, flag: 'wx' })
    },
  })
  await bindOnce(retry)
  expect(calls).toBe(2)
})


test('L1: a late older segment write never moves the persisted boundary backwards', async () => {
  const file = join(dir, 'accounts.json')
  const first = createHarnessAccounts({ file })
  const second = createHarnessAccounts({ file })
  const { account } = await first.bind('/first', { ...identity, harness: 'codex' })
  await first.startSegment(account.id, 2000)
  await second.startSegment(account.id, 1000)
  expect((await second.readAccounts()).segments[account.id]).toBe(2000)
})

test('a login whose probe key changed spelling keeps its account instead of minting a twin', async () => {
  const file = join(dir, 'accounts.json')
  const org = '00000000-0000-4000-8000-000000000002'
  await writeFile(file, JSON.stringify({ version: 2, segments: {}, bindings: { 'claude:': 'acc_legacy000000' },
    accounts: [{ id: 'acc_legacy000000', root: null, key: org, harness: 'claude', label: 'a@example.invalid', available: true, firstSeen: 1, lastSeen: 2 }] }))
  const store = createHarnessAccounts({ file, now: () => 10, probe: async () => ({ key: `${org}:a@example.invalid`, label: 'a@example.invalid' }) })
  const account = await store.current('claude')
  expect(account.id).toBe('acc_legacy000000')
  expect(account.key).toBe(`${org}:a@example.invalid`)
  expect((await store.readAccounts()).accounts).toHaveLength(1)
})

test('an org id alone never merges two people of one team', async () => {
  const file = join(dir, 'accounts.json')
  const org = '00000000-0000-4000-8000-000000000003'
  await writeFile(file, JSON.stringify({ version: 2, segments: {}, bindings: {},
    accounts: [{ id: 'acc_teammate0000', root: null, key: org, harness: 'claude', label: 'b@example.invalid', available: true, firstSeen: 1, lastSeen: 2 }] }))
  const store = createHarnessAccounts({ file, probe: async () => ({ key: `${org}:a@example.invalid`, label: 'a@example.invalid' }) })
  expect((await store.current('claude')).id).not.toBe('acc_teammate0000')
  expect((await store.readAccounts()).accounts).toHaveLength(2)
})

test('registry twins are folded on read: bindings, segments and an alias follow the survivor', async () => {
  const file = join(dir, 'accounts.json')
  await writeFile(file, JSON.stringify({ version: 2, segments: { acc_gemlegacy0000: 50 }, bindings: { 'gemini:': 'acc_gemroot00000' },
    accounts: [
      { id: 'acc_gemlegacy0000', root: null, key: 'default', harness: 'gemini', label: 'Conta padrão', nickname: 'Home', available: true, firstSeen: 1, lastSeen: 5 },
      { id: 'acc_gemroot00000', root: null, key: 'root:abcdef012345', harness: 'gemini', label: 'Default account', available: true, firstSeen: 3, lastSeen: 9 },
    ] }))
  const store = createHarnessAccounts({ file })
  const data = await store.readAccounts()
  expect(data.accounts).toHaveLength(1)
  expect(data.accounts[0]).toMatchObject({ id: 'acc_gemroot00000', nickname: 'Home', firstSeen: 1, lastSeen: 9 })
  expect(data.aliases).toEqual({ acc_gemlegacy0000: 'acc_gemroot00000' })
  expect(data.segments).toEqual({ acc_gemroot00000: 50 })
  expect((await store.byId('acc_gemlegacy0000'))?.id).toBe('acc_gemroot00000')
  // The fold is persisted, so every process reads the same single record.
  expect(JSON.parse(await readFile(file, 'utf8')).accounts).toHaveLength(1)
})

test('equal keys alone never fold: an org-only key needs the same e-mail, `default` the same root', () => {
  const org = '00000000-0000-4000-8000-000000000004'
  const rec = (key: string, label: string, root: string | null = null, harness: 'claude' | 'gemini' = 'claude') => ({ harness, key, label, root })
  // Two people of one team org, recorded under the legacy org-only key.
  expect(sameLogin(rec(org, 'a@example.invalid'), rec(org, 'b@example.invalid'))).toBe(false)
  expect(sameLogin(rec(org, org), rec(org, org))).toBe(false)
  expect(sameLogin(rec(org, 'A@example.invalid'), rec(org, 'a@example.invalid'))).toBe(true)
  expect(sameLogin(rec(`${org}:a@example.invalid`, 'a@example.invalid'), rec(`${org}:a@example.invalid`, 'a@example.invalid'))).toBe(true)
  expect(sameLogin(rec('default', 'Conta padrão'), rec('default', 'Conta padrão'))).toBe(true)
  expect(sameLogin(rec('default', 'Conta padrão', '/x'), rec('default', 'Conta padrão', '/y'))).toBe(false)
  // Probe-less `default`: only a compatible root says it is one login.
  expect(sameLogin(rec('default', 'Conta padrão', '/home/a/.gemini', 'gemini'), rec('default', 'Conta padrão', '/home/b/.gemini', 'gemini'))).toBe(false)
  expect(sameLogin(rec('default', 'Conta padrão', '/home/a/.gemini', 'gemini'), rec('default', 'Conta padrão', '/home/a/.gemini/', 'gemini'))).toBe(true)
})

test('a registry holding two teammates under one org-only key keeps both on read', async () => {
  const file = join(dir, 'accounts.json')
  const org = '00000000-0000-4000-8000-000000000005'
  await writeFile(file, JSON.stringify({ version: 2, segments: {}, bindings: {}, accounts: [
    { id: 'acc_mate_a000000', root: null, key: org, harness: 'claude', label: 'a@example.invalid', available: true, firstSeen: 1, lastSeen: 2 },
    { id: 'acc_mate_b000000', root: '/tmp/b', key: org, harness: 'claude', label: 'b@example.invalid', available: true, firstSeen: 1, lastSeen: 3 },
    { id: 'acc_gem_a0000000', root: '/tmp/ga', key: 'default', harness: 'gemini', label: 'Conta padrão', available: true, firstSeen: 1, lastSeen: 2 },
    { id: 'acc_gem_b0000000', root: '/tmp/gb', key: 'default', harness: 'gemini', label: 'Conta padrão', available: true, firstSeen: 1, lastSeen: 3 },
  ] }))
  const data = await createHarnessAccounts({ file }).readAccounts()
  expect(data.accounts.map(a => a.id).sort()).toEqual(['acc_gem_a0000000', 'acc_gem_b0000000', 'acc_mate_a000000', 'acc_mate_b000000'])
  expect(data.aliases).toBeUndefined()
})

test('a writer holding an id that was folded away writes to the survivor', async () => {
  const file = join(dir, 'accounts.json')
  await writeFile(file, JSON.stringify({ version: 2, segments: {}, bindings: { 'gemini:': 'acc_gemroot00000' }, accounts: [
    { id: 'acc_gemlegacy0000', root: null, key: 'default', harness: 'gemini', label: 'Conta padrão', available: true, firstSeen: 1, lastSeen: 5 },
    { id: 'acc_gemroot00000', root: null, key: 'root:abcdef012345', harness: 'gemini', label: 'Default account', available: true, firstSeen: 3, lastSeen: 9 },
  ] }))
  // Its own locked read performs the fold: the nickname still lands.
  const writer = createHarnessAccounts({ file })
  expect((await writer.update('acc_gemlegacy0000', { nickname: 'Home' }))?.id).toBe('acc_gemroot00000')
  // Another store folded it long ago; this one still holds the old id.
  await createHarnessAccounts({ file }).readAccounts()
  expect((await writer.update('acc_gemlegacy0000', { available: false }))?.available).toBe(false)
  await writer.startSegment('acc_gemlegacy0000', 77)
  expect((await writer.retire('acc_gemlegacy0000'))?.id).toBe('acc_gemroot00000')
  const disk = JSON.parse(await readFile(file, 'utf8'))
  expect(disk.accounts).toHaveLength(1)
  expect(disk.accounts[0]).toMatchObject({ id: 'acc_gemroot00000', nickname: 'Home', available: false, retired: true })
  expect(disk.segments).toEqual({ acc_gemroot00000: 77 })
})

// Two people of one team org, each bound to their own root under the legacy org-only key.
const TEAM_ORG = '00000000-0000-4000-8000-000000000006'
async function writeTeammates(file: string) {
  await writeFile(file, JSON.stringify({ version: 2, segments: {}, bindings: { 'claude:/tmp/ta': 'acc_team_a000000', 'claude:/tmp/tb': 'acc_team_b000000' }, accounts: [
    { id: 'acc_team_a000000', root: '/tmp/ta', key: TEAM_ORG, harness: 'claude', label: 'a@example.invalid', nickname: 'Ana', available: true, firstSeen: 1, lastSeen: 2 },
    { id: 'acc_team_b000000', root: '/tmp/tb', key: TEAM_ORG, harness: 'claude', label: 'b@example.invalid', available: false, firstSeen: 1, lastSeen: 3 },
  ] }))
}

test('adoption never moves a teammate onto another person by an equal org-only key', async () => {
  const file = join(dir, 'accounts.json')
  await writeTeammates(file)
  // The probe names the org and no e-mail: only the root's own binding says whose login it is.
  const store = createHarnessAccounts({ file, probe: async () => ({ key: TEAM_ORG, label: TEAM_ORG }) })
  expect((await store.current('claude', '/tmp/tb')).id).toBe('acc_team_b000000')
  expect((await store.current('claude', '/tmp/ta')).id).toBe('acc_team_a000000')
  // An unbound root with the same org-only key is nobody known: a new row, never A or B.
  const other = await store.current('claude', '/tmp/tc')
  expect(['acc_team_a000000', 'acc_team_b000000']).not.toContain(other.id)
  expect((await store.current('claude', '/tmp/tc')).id).toBe(other.id)
  const disk = JSON.parse(await readFile(file, 'utf8'))
  const byId = Object.fromEntries(disk.accounts.map((a: { id: string }) => [a.id, a]))
  expect(byId.acc_team_a000000).toMatchObject({ root: '/tmp/ta', label: 'a@example.invalid', nickname: 'Ana' })
  expect(byId.acc_team_b000000).toMatchObject({ root: '/tmp/tb', label: 'b@example.invalid', available: false })
  expect(disk.bindings['claude:/tmp/tb']).toBe('acc_team_b000000')
})

test('a direct bind of two teammates under one org-only key returns two accounts', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json') })
  const a = await store.bind('/tmp/ta', { harness: 'claude', key: TEAM_ORG, label: 'a@example.invalid' })
  const b = await store.bind('/tmp/tb', { harness: 'claude', key: TEAM_ORG, label: 'b@example.invalid' })
  expect(a.account.id).not.toBe(b.account.id)
  // The same person again (same e-mail) is the same account.
  expect((await store.bind('/tmp/ta2', { harness: 'claude', key: TEAM_ORG, label: 'a@example.invalid' })).account.id).toBe(a.account.id)
})

test('a bound root switching between two e-mails of one org rebinds, never relabels', async () => {
  const file = join(dir, 'accounts.json')
  await writeTeammates(file)
  const store = createHarnessAccounts({ file })
  await store.update('acc_team_b000000', { nickname: 'Bia' })
  // B's root now reports A's e-mail under the same org-only key: that is A, not B renamed.
  const toA = await store.bind('/tmp/tb', { harness: 'claude', key: TEAM_ORG, label: 'a@example.invalid' })
  expect(toA.account.id).toBe('acc_team_a000000')
  // A third e-mail on the same root is a new person: a new row, A untouched.
  const toC = await store.bind('/tmp/tb', { harness: 'claude', key: TEAM_ORG, label: 'c@example.invalid' })
  expect(['acc_team_a000000', 'acc_team_b000000']).not.toContain(toC.account.id)
  // And back to B.
  expect((await store.bind('/tmp/tb', { harness: 'claude', key: TEAM_ORG, label: 'b@example.invalid' })).account.id).toBe('acc_team_b000000')
  // A probe with no person evidence keeps the bound account.
  expect((await store.bind('/tmp/tb', { harness: 'claude', key: TEAM_ORG, label: TEAM_ORG })).account.id).toBe('acc_team_b000000')
  const data = await createHarnessAccounts({ file }).readAccounts()
  const byId = Object.fromEntries(data.accounts.map(a => [a.id, a]))
  expect(byId.acc_team_a000000).toMatchObject({ label: 'a@example.invalid', nickname: 'Ana' })
  expect(byId.acc_team_b000000).toMatchObject({ label: 'b@example.invalid', nickname: 'Bia', available: false })
  expect(data.accounts.filter(a => a.harness === 'claude')).toHaveLength(3)
  expect(data.aliases ?? {}).toEqual({})
})

test('v1 migration keeps two teammates under one org-only key apart', async () => {
  const file = join(dir, 'accounts.json')
  await writeFile(file, JSON.stringify([
    { harness: 'claude', key: TEAM_ORG, label: 'a@example.invalid', available: false, firstSeen: 1, lastSeen: 5 },
    { harness: 'claude', key: TEAM_ORG, label: 'b@example.invalid', firstSeen: 2, lastSeen: 9 },
    { harness: 'claude', key: TEAM_ORG, label: 'A@example.invalid', firstSeen: 3, lastSeen: 7 },
  ]))
  const data = await createHarnessAccounts({ file }).readAccounts()
  const claude = data.accounts.filter(a => a.harness === 'claude')
  expect(claude).toHaveLength(2)
  const a = claude.find(x => x.label.toLowerCase() === 'a@example.invalid')!
  const b = claude.find(x => x.label === 'b@example.invalid')!
  expect(a).toMatchObject({ available: false, firstSeen: 1, lastSeen: 7 })
  expect(b).toMatchObject({ available: true, firstSeen: 2, lastSeen: 9 })
  const disk = JSON.parse(await readFile(file, 'utf8'))
  expect(disk.accounts).toHaveLength(2)
})

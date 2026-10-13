import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexIdentity, createHarnessAccounts, probeAccountIdentity, __setHarnessAccountsForTest } from './harness-accounts'
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
  expect((await store.list(['codex']))[0]).toEqual({ ...identity, harness: 'codex', available: true, firstSeen: 1000, lastSeen: 1000 })
  await store.setAvailable('codex', identity.key, false)
  now += 59_999
  expect((await store.current(['codex']))[0]?.available).toBe(false)
  expect(calls).toBe(1)
  now += 1
  expect((await store.current(['codex']))[0]?.available).toBe(false)
  expect(calls).toBe(2)
  const restarted = createHarnessAccounts({ file, probe: async () => identity })
  expect((await restarted.list(['codex']))[0]?.available).toBe(false)
  expect(JSON.parse(await readFile(file, 'utf8'))[0].firstSeen).toBe(1000)
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

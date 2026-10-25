import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { createControlHost, type StartHost } from '../cli-start'
import { createHarnessAccounts, __setHarnessAccountsForTest } from '../harness-accounts'
import { updatePreferences } from '../preferences'
import { __setSessionBackendForTest } from './index'
import { __setFleetHostForTest, runFleetSpawn, spawnResponse } from './fleet-web'
import { __setHarnessAgentsReaderForTest } from './harness-agents-io'
import { start } from './cli-session'
import { parseSessionArgs } from './cli-parse'
import { addSession, patchSession, readRegistry, removeSession } from './registry'
import { ensureSessionIdentityKey } from './session-identity'
import { defaultRoleDeps, loadRoles } from './session-roles'
import type { SessionBackend } from './types'

const savedId = process.env.AGENTOP_MANAGED_ID
const savedAccounts = process.env.AGENTISTICS_MULTI_ACCOUNT
const renames: Array<{ id: string; title: string }> = []
const alive = new Set<string>()
const owned = new Set<string>()
const backend = {
  id: 'tmux', unavailable: async () => undefined,
  spawn: async ({ id }: { id: string }) => { alive.add(id); owned.add(id) },
  list: async () => [...alive].map(id => ({ id })),
  capture: async () => [], kill: async () => true,
} as unknown as SessionBackend
const renameHost = {
  renameSession: async (id: string, title: string) => {
    renames.push({ id, title })
    await patchSession(id, { label: title })
    return { ok: true, message: 'renamed' }
  },
} as unknown as StartHost

beforeAll(async () => {
  __setSessionBackendForTest(backend)
  __setHarnessAgentsReaderForTest(async () => [])
  await ensureSessionIdentityKey()
  await updatePreferences(() => ({ lang: 'en' }))
})
afterEach(() => {
  for (const lang of ['en', 'pt'] as const) __setFleetHostForTest(lang, null)
  if (savedId === undefined) delete process.env.AGENTOP_MANAGED_ID
  else process.env.AGENTOP_MANAGED_ID = savedId
  if (savedAccounts === undefined) delete process.env.AGENTISTICS_MULTI_ACCOUNT
  else process.env.AGENTISTICS_MULTI_ACCOUNT = savedAccounts
})
afterAll(async () => {
  for (const id of owned) await removeSession(id)
  __setSessionBackendForTest(null)
  __setHarnessAgentsReaderForTest(null)
  __setHarnessAccountsForTest(createHarnessAccounts({ file: join(AGENTISTICS_DATA_DIR, 'accounts.json') }))
})

async function parent(id: string) {
  renames.length = 0
  __setFleetHostForTest('en', renameHost)
  alive.add(id)
  owned.add(id)
  await addSession({ id, harness: 'claude', cwd: process.cwd(), label: `Parent ${id}`, conversationId: `conv-${id}`, createdAt: new Date().toISOString(), parentSessionId: 'former-leader', parentConversationId: 'former-conversation' })
  process.env.AGENTOP_MANAGED_ID = id
}
async function assertPromoted(id: string, childId: string) {
  const roles = await loadRoles(await defaultRoleDeps())
  expect(roles.roles[`conv-${id}`]).toBe('leader')
  expect(roles.origins?.[`conv-${id}`]).toBe('inferred')
  expect(renames).toContainEqual({ id, title: `[ LEADER ] - Parent ${id}` })
  expect(renames.some(r => r.id === childId && r.title.includes('[ LEADER ]'))).toBe(false)
  const rows = await readRegistry()
  expect(rows.find(r => r.id === id)).toMatchObject({ label: `[ LEADER ] - Parent ${id}` })
  expect(rows.find(r => r.id === id)?.parentSessionId).toBeUndefined()
  expect(rows.find(r => r.id === id)?.parentConversationId).toBeUndefined()
  expect(rows.find(r => r.id === childId)?.parentSessionId).toBe(id)
}

describe('promotion through the spawn entry points', () => {
  test('CLI --role worker promotes its verified automatic parent', async () => {
    const id = 'entry-cli-parent'
    await parent(id)
    const cmd = parseSessionArgs(['claude', '--bg', '--force', '--role', 'worker', '--cwd', process.cwd(), '--name', 'Explicit worker', '-p', 'x'])
    if (cmd.kind !== 'start') throw new Error('not start')
    expect(await start(cmd, backend, { settleMs: 1 })).toBe(0)
    const child = (await readRegistry()).find(r => r.parentSessionId === id)!
    expect(child).toBeDefined()
    await assertPromoted(id, child.id)
  }, 60_000)
  test('host filing infers worker and spawnManaged promotes the parent', async () => {
    const id = 'entry-host-parent'
    await parent(id)
    const host = createControlHost('en', { suspend: async (fn: () => Promise<unknown>) => fn() } as never)
    const out = await host.spawnSession!({ harness: 'claude', cwd: process.cwd(), attach: false, parentSessionId: id, parentVerified: true, force: true, label: 'Inferred worker', prompt: 'x' })
    expect(out.ok).toBe(true)
    expect(out.note).toContain('LEADER')
    const child = (await readRegistry()).find(r => r.id === out.id)!
    const roles = await loadRoles(await defaultRoleDeps())
    expect(roles.roles[child.conversationId!]).toBe('worker')
    await assertPromoted(id, child.id)
  }, 60_000)
})

describe('web handoff account fallback at the route/host boundary', () => {
  test.each(['en', 'pt'] as const)('returns the refused account reason in %s without an admission override', async lang => {
    process.env.AGENTISTICS_MULTI_ACCOUNT = '1'
    const store = createHarnessAccounts({ file: join(AGENTISTICS_DATA_DIR, `inherit-accounts-${lang}.json`) })
    __setHarnessAccountsForTest(store)
    const old = await store.bind('/retired-test-root', { harness: 'claude', key: 'old', label: 'Old test account' })
    const good = await store.bind(null, { harness: 'claude', key: 'good', label: 'Good test account' })
    await store.retire(old.account.id)
    const id = `account-parent-${lang}`
    owned.add(id)
    await addSession({ id, harness: 'claude', cwd: process.cwd(), createdAt: new Date().toISOString(), accountId: old.account.id })
    const requested: unknown[] = []
    __setFleetHostForTest(lang, {
      startableHarnesses: async () => [{ id: 'claude', supportsModel: true, efforts: [] }],
      spawnSession: async (req: Parameters<NonNullable<StartHost['spawnSession']>>[0]) => { requested.push(req); return { ok: true, id: 'successor', message: 'Started', note: 'Host notice.' } },
    } as unknown as StartHost)
    const out = await runFleetSpawn(lang, { harness: 'claude', cwd: process.cwd(), handoff: true, parent: id })
    expect(out.ok).toBe(true)
    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({ accountId: good.account.id })
    expect(out.overridden).toBeUndefined()
    expect(out.note).toContain('Host notice.')
    expect(out.note).toContain(lang === 'pt' ? 'escolha automática' : 'automatic choice')
    expect(out.note).toContain(lang === 'pt' ? 'removida' : 'removed')
  })
  test('spawnResponse keeps an independent host notice', () => {
    expect(spawnResponse({ ok: true, message: 'Started', note: 'Notice' }, 'en')).toEqual({ ok: true, message: 'Started', note: 'Notice' })
  })
})

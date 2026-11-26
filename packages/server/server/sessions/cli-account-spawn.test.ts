/**
 * PLAN.ACCOUNTS D3 — the CLI doors (`session start --account`, `session batch`) through the real
 * handlers: the registry row carries the account and the pane's env carries its root.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setHarnessAccountsForTest, createHarnessAccounts } from '../harness-accounts'
import { batch, start } from './cli-session'
import { readRegistry } from './registry'
import type { ManagedSession, SessionBackend } from './types'
import { isolateAgentEnv } from './agent-env.testing'

// A spawn door reads AGENTOP_*/AGENTISTICS_* from the shell it runs in (inside a managed session: the caller's identity and the feature
// switches): every test starts from a bare agent environment and gets it back.
isolateAgentEnv({ AGENTISTICS_MULTI_ACCOUNT: '1' }) // the one switch this file sets (beforeAll), re-applied after each clearing

for (const k of Object.keys(process.env)) if (k.startsWith('GIT_') && k !== 'GIT_TERMINAL_PROMPT') delete process.env[k]

let dir = ''
let savedFlag: string | undefined
let savedCaller: string | undefined
let homeId = ''
let secondId = ''
const secondRoot = () => join(dir, 'accounts', 'claude', 'r_2')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'acct-d3-'))
  savedFlag = process.env.AGENTISTICS_MULTI_ACCOUNT
  savedCaller = process.env.AGENTOP_MANAGED_ID
  process.env.AGENTISTICS_MULTI_ACCOUNT = '1'
  delete process.env.AGENTOP_MANAGED_ID
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => ({ key: 'default', label: 'x' }) })
  __setHarnessAccountsForTest(store)
  homeId = (await store.bind(null, { harness: 'claude', key: 'org:home', label: 'home' })).account.id
  secondId = (await store.bind(secondRoot(), { harness: 'claude', key: 'org:two', label: 'two' })).account.id
  // The default root's account is OFF for agents.
  await store.update(homeId, { available: false })
})
afterAll(() => {
  if (savedFlag === undefined) delete process.env.AGENTISTICS_MULTI_ACCOUNT
  else process.env.AGENTISTICS_MULTI_ACCOUNT = savedFlag
  if (savedCaller !== undefined) process.env.AGENTOP_MANAGED_ID = savedCaller
  rmSync(dir, { recursive: true, force: true })
})

/** A backend that records the spawn (row + env) and refuses it, so nothing runs and the row goes away. */
function recorder() {
  const seen: { row?: ManagedSession; env?: Record<string, string>; unsetEnv?: string[] }[] = []
  const backend = {
    id: 'tmux', unavailable: async () => undefined,
    spawn: async (req: { id: string; env?: Record<string, string>; unsetEnv?: string[] }) => {
      seen.push({ row: (await readRegistry()).find(m => m.id === req.id), env: req.env, unsetEnv: req.unsetEnv })
      throw new Error('pane refused')
    },
    list: async () => [], capture: async () => [], kill: async () => {},
  } as unknown as SessionBackend
  return { seen, backend }
}
async function quiet<T>(f: () => Promise<T>): Promise<T> {
  const log = console.log, err = console.error
  console.log = () => {}; console.error = () => {}
  try { return await f() } finally { console.log = log; console.error = err }
}

describe('session batch — the automatic pick never lands on a hidden account', () => {
  test('a batch item without --account runs on the visible account, in its root', async () => {
    const { seen, backend } = recorder()
    await quiet(() => batch({ kind: 'batch', task: 'acct-d3 batch', json: true, force: true, sharedCwd: true,
      specs: [{ harness: 'claude', prompt: 'x', cwd: process.cwd() }] } as Parameters<typeof batch>[0], backend))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.row?.accountId).toBe(secondId)
    expect(seen[0]!.env?.CLAUDE_CONFIG_DIR).toBe(secondRoot())
  })
})

describe('session start --account', () => {
  test('the owner may name the account that is off for agents (default root: inherited isolation removed)', async () => {
    const { seen, backend } = recorder()
    await quiet(() => start({ kind: 'start', harness: 'claude', background: true, prompt: 'x', cwd: process.cwd(), force: true, sharedCwd: true, account: homeId } as Parameters<typeof start>[0], backend))
    expect(seen[0]!.row?.accountId).toBe(homeId)
    expect(seen[0]!.unsetEnv).toEqual(['CLAUDE_CONFIG_DIR'])
    expect(seen[0]!.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
  test('an unknown account starts nothing', async () => {
    const { seen, backend } = recorder()
    const code = await quiet(() => start({ kind: 'start', harness: 'claude', background: true, prompt: 'x', cwd: process.cwd(), force: true, sharedCwd: true, account: 'acc_nope' } as Parameters<typeof start>[0], backend))
    expect(code).toBe(1)
    expect(seen).toEqual([])
  })
  test('flag off: no account is resolved or stamped', async () => {
    process.env.AGENTISTICS_MULTI_ACCOUNT = '0'
    try {
      const { seen, backend } = recorder()
      await quiet(() => start({ kind: 'start', harness: 'claude', background: true, prompt: 'x', cwd: process.cwd(), force: true, sharedCwd: true } as Parameters<typeof start>[0], backend))
      expect(seen[0]!.row?.accountId).toBeUndefined()
      expect(seen[0]!.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    } finally { process.env.AGENTISTICS_MULTI_ACCOUNT = '1' }
  })
})

describe('the host door (the cockpit wizard) decides through the same rule', () => {
  test('a fresh cockpit spawn takes the visible account and stamps it, never the hidden default', async () => {
    const { hostSpawnAccount } = await import('./spawn-account-io')
    expect(await hostSpawnAccount({ harness: 'claude' }, 'en')).toEqual({ ok: true, accountId: secondId })
    expect(await hostSpawnAccount({ harness: 'claude', callerVerified: true }, 'en')).toEqual({ ok: true, accountId: secondId })
  })
  test('an already-decided request and a login session pass through untouched', async () => {
    const { hostSpawnAccount } = await import('./spawn-account-io')
    expect(await hostSpawnAccount({ harness: 'claude', accountDecided: true }, 'en')).toEqual({ ok: true })
    expect(await hostSpawnAccount({ harness: 'claude', login: true }, 'en')).toEqual({ ok: true })
    expect(await hostSpawnAccount({ harness: 'claude', accountId: homeId }, 'en')).toEqual({ ok: true, accountId: homeId })
  })
  test('flag off: an agent is still refused the hidden default login; the owner is not', async () => {
    process.env.AGENTISTICS_MULTI_ACCOUNT = '0'
    try {
      const { hostSpawnAccount } = await import('./spawn-account-io')
      const agent = await hostSpawnAccount({ harness: 'claude', callerVerified: true }, 'en')
      expect(agent.ok).toBe(false)
      if (!agent.ok) expect(agent.message).toContain('off for agents')
      expect(await hostSpawnAccount({ harness: 'claude' }, 'en')).toEqual({ ok: true })
    } finally { process.env.AGENTISTICS_MULTI_ACCOUNT = '1' }
  })
  test('an agent reopening a row whose account is off for agents is refused; the owner reopens it', async () => {
    const { recordedSpawnAccount } = await import('./spawn-account-io')
    expect(await recordedSpawnAccount(homeId, { agentCaller: true, harness: 'claude' }))
      .toEqual({ ok: false, reason: 'account_unavailable', detail: homeId })
    expect(await recordedSpawnAccount(homeId, { harness: 'claude' })).toEqual({ ok: true, account: { id: homeId, root: null } })
    // A row recorded before accounts runs in the default root — whose login is off for agents.
    expect((await recordedSpawnAccount(undefined, { agentCaller: true, harness: 'claude' })).ok).toBe(false)
  })
})

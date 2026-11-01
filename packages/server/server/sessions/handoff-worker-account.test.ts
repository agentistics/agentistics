import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountBudget } from '@agentistics/core'
import { __setHarnessAccountsForTest, createHarnessAccounts } from '../harness-accounts'
import { start } from './cli-session'
import { parseSessionArgs } from './cli-parse'
import { addSession, readRegistry } from './registry'
import { __setHarnessAgentsReaderForTest } from './harness-agents-io'
import { ensureSpawnRole } from './session-roles'
import { isolateAgentEnv } from './agent-env.testing'
import type { ManagedSession, SessionBackend } from './types'

isolateAgentEnv()
const NOW = Date.now()
const row = (account: string, o: Partial<AccountBudget> = {}): AccountBudget => ({
  harness: 'claude', plan: 'max', account, fiveHourPct: 20, weekPct: 30, weekResetsAt: NOW + 3 * 86_400_000, daysToWeekReset: 3, dailyBudgetPct: 20,
  status: 'ok', updatedAt: NOW, stale: false, spawnable: true, ...o,
}) as AccountBudget
let budgets: AccountBudget[] = []
const realPlanLimits = { ...(await import('../plan-limits')) }
mock.module('../plan-limits', () => ({ ...realPlanLimits, planLimitsPayload: async () => ({ budgets }) }))

let dir = ''; let home = ''; let second = ''; let savedFlag: string | undefined
const saved = process.env.AGENTOP_MANAGED_ID
beforeAll(async () => {
  __setHarnessAgentsReaderForTest(async () => [])
  dir = mkdtempSync(join(tmpdir(), 'handoff-worker-acct-'))
  savedFlag = process.env.AGENTISTICS_MULTI_ACCOUNT
  process.env.AGENTISTICS_MULTI_ACCOUNT = '1'
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => ({ key: 'default', label: 'x' }) })
  __setHarnessAccountsForTest(store)
  home = (await store.bind(null, { harness: 'claude', key: 'org:home', label: 'home' })).account.id
  second = (await store.bind(join(dir, 'r2'), { harness: 'claude', key: 'org:two', label: 'two' })).account.id
})
afterAll(() => {
  __setHarnessAgentsReaderForTest(null)
  mock.module('../plan-limits', () => realPlanLimits)
  if (savedFlag === undefined) delete process.env.AGENTISTICS_MULTI_ACCOUNT; else process.env.AGENTISTICS_MULTI_ACCOUNT = savedFlag
  rmSync(dir, { recursive: true, force: true })
})
afterEach(() => { if (saved === undefined) delete process.env.AGENTOP_MANAGED_ID; else process.env.AGENTOP_MANAGED_ID = saved })

const backend = () => ({ id: 'tmux', unavailable: async () => undefined, list: async () => [], spawn: async () => {}, capture: async () => [], kill: async () => true }) as unknown as SessionBackend
const errs: string[] = []
const handoff = async (parent: string) => {
  process.env.AGENTOP_MANAGED_ID = parent
  const cmd = parseSessionArgs(['claude', '--bg', '--force', '--handoff', '--cwd', process.cwd(), '-p', 'x'])
  if (cmd.kind !== 'start') throw new Error('not a start')
  const before = new Set((await readRegistry()).map(r => r.id))
  const log = console.log; const err = console.error
  console.log = () => {}; console.error = (...a: unknown[]) => { errs.push(a.join(' ')) }
  try { expect(await start(cmd, backend(), { settleMs: 50, provesCaller: async () => true })).toBe(0) } finally { console.log = log; console.error = err }
  return (await readRegistry()).find(r => !before.has(r.id))!
}
const worker = async (id: string, accountId?: string) => {
  await addSession({ id, harness: 'claude', cwd: process.cwd(), createdAt: new Date().toISOString(), conversationId: `conv-${id}`, parentSessionId: 'lead', ...(accountId ? { accountId } : {}) } as ManagedSession)
  await ensureSpawnRole([`conv-${id}`, id], 'worker')
}

describe('worker hand-off account', () => {
  test('inherits the parent\'s account even when it is over its threshold', async () => {
    budgets = [row(home, { fiveHourPct: 97 }), row(second, { fiveHourPct: 10 })]
    await worker('hwa-keep', home)
    expect((await handoff('hwa-keep')).accountId).toBe(home)
  }, 60_000)
  test('a parent with no account asks the router, like a leader hand-off', async () => {
    budgets = [row(home, { fiveHourPct: 97 }), row(second, { fiveHourPct: 10 })]
    await worker('hwa-ask')
    expect((await handoff('hwa-ask')).accountId).toBe(second)
  }, 60_000)
  test('the router is really asked: with no room anywhere it says so', async () => {
    budgets = [row(home, { fiveHourPct: 97 }), row(second, { fiveHourPct: 98 })]
    await worker('hwa-noroom')
    errs.length = 0
    await handoff('hwa-noroom')
    expect(errs.join('\n')).toContain('No account has room')
  }, 60_000)
})

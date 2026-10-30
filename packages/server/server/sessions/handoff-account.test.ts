import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountBudget } from '@agentistics/core'
import { __setHarnessAccountsForTest, createHarnessAccounts } from '../harness-accounts'

const NOW = Date.now()
const row = (account: string, o: Partial<AccountBudget> = {}): AccountBudget => ({
  harness: 'claude', plan: 'max', account, fiveHourPct: 20, weekPct: 30, weekResetsAt: NOW + 3 * 86_400_000, daysToWeekReset: 3, dailyBudgetPct: 20,
  status: 'ok', updatedAt: NOW, stale: false, spawnable: true, ...o,
}) as AccountBudget
let budgets: AccountBudget[] = []
// `mock.module` outlives this file in the same `bun test` process: keep the real module and put it back in afterAll.
const realPlanLimits = { ...(await import('../plan-limits')) }
mock.module('../plan-limits', () => ({ ...realPlanLimits, planLimitsPayload: async () => ({ budgets }) }))

let dir = ''
let home = ''
let second = ''
let savedFlag: string | undefined
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'handoff-acct-'))
  savedFlag = process.env.AGENTISTICS_MULTI_ACCOUNT
  process.env.AGENTISTICS_MULTI_ACCOUNT = '1'
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => ({ key: 'default', label: 'x' }) })
  __setHarnessAccountsForTest(store)
  home = (await store.bind(null, { harness: 'claude', key: 'org:home', label: 'home' })).account.id
  second = (await store.bind(join(dir, 'r2'), { harness: 'claude', key: 'org:two', label: 'two' })).account.id
})
afterAll(() => {
  mock.module('../plan-limits', () => realPlanLimits)
  if (savedFlag === undefined) delete process.env.AGENTISTICS_MULTI_ACCOUNT; else process.env.AGENTISTICS_MULTI_ACCOUNT = savedFlag
  rmSync(dir, { recursive: true, force: true })
})

describe('handoffAccountChoice (CONTA.AUTO B)', () => {
  test('the predecessor\'s account is over its threshold: the successor takes the account with room', async () => {
    const { handoffAccountChoice } = await import('./spawn-account-io')
    budgets = [row(home, { fiveHourPct: 97 }), row(second, { fiveHourPct: 10 })]
    expect(await handoffAccountChoice({ harness: 'claude', agentCaller: true, predecessor: { id: 'p1', cwd: '/w', harness: 'claude', accountId: home } })).toEqual({ id: second, room: true })
  })
  test('nobody has room, no reading, or accounts off: no opinion — the ordinary rule decides', async () => {
    const { handoffAccountChoice } = await import('./spawn-account-io')
    budgets = []
    expect(await handoffAccountChoice({ harness: 'claude', agentCaller: true })).toBeUndefined()
    budgets = [row(home), row(second)]
    process.env.AGENTISTICS_MULTI_ACCOUNT = '0'
    expect(await handoffAccountChoice({ harness: 'claude', agentCaller: true })).toBeUndefined()
    process.env.AGENTISTICS_MULTI_ACCOUNT = '1'
  })
  test('nobody has room: the account whose window reopens first, flagged room:false — and never the limited predecessor\'s', async () => {
    const { handoffAccountChoice } = await import('./spawn-account-io')
    budgets = [row(home, { fiveHourPct: 97, weekResetsAt: NOW + 86_400_000 }), row(second, { weekPct: 99, weekResetsAt: NOW + 3 * 86_400_000 })]
    const pick = await handoffAccountChoice({ harness: 'claude', agentCaller: true, predecessor: { id: 'p1', cwd: '/w', harness: 'claude', accountId: home } })
    expect(pick).toMatchObject({ id: home, room: false }) // nobody limited: the soonest reset, said aloud by the caller
  })
  test('an account off for agents is never chosen for an agent\'s successor', async () => {
    const { handoffAccountChoice } = await import('./spawn-account-io')
    const { readAccounts } = await import('../harness-accounts')
    const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => ({ key: 'default', label: 'x' }) })
    await store.update(second, { available: false })
    budgets = [row(home, { fiveHourPct: 97 }), row(second, { fiveHourPct: 5 })]
    expect((await handoffAccountChoice({ harness: 'claude', agentCaller: true }))?.id).not.toBe(second)
    expect(await handoffAccountChoice({ harness: 'claude', agentCaller: false })).toMatchObject({ id: second, room: true }) // the OWNER may use it
    await store.update(second, { available: true })
    void readAccounts
  })
})

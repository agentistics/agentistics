import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSchedule, PlanLimits } from '@agentistics/core'
import { __setHarnessAccountsForTest, createHarnessAccounts, readAccounts } from './harness-accounts'
import { __setAgentScheduleDepsForTest, evaluateAgentSchedules, setAccountAgentSchedule, toggleAccountAgentUse } from './agent-schedule-host'
import { handleAccountsRequest } from './accounts-web'

let dir = ''
let limits: PlanLimits[] = []
let notified = 0
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m) // 2026-11-02 = Monday
const sched: AgentSchedule = { enabled: true, days: { mon: { windows: [{ from: '09:00', to: '12:00' }], maxDailyPct: 10 } } }
const account = async () => (await readAccounts()).accounts.find(a => a.id === 'acc_1')!

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-sched-'))
  const file = join(dir, 'accounts.json')
  writeFileSync(file, JSON.stringify({ version: 2, bindings: {}, segments: {}, accounts: [
    { id: 'acc_1', root: null, key: 'k1', harness: 'claude', label: 'A', available: true, firstSeen: 1, lastSeen: 1 },
  ] }))
  __setHarnessAccountsForTest(createHarnessAccounts({ file, probe: async () => ({ key: 'default', label: 'x' }) }))
  limits = []
  notified = 0
  __setAgentScheduleDepsForTest({ limits: async () => limits, notify: () => { notified++ } })
})
afterEach(() => { __setAgentScheduleDepsForTest(null); rmSync(dir, { recursive: true, force: true }) })

const week = (usedPct: number): PlanLimits => ({ harness: 'claude', account: 'acc_1', windows: [{ kind: 'week', usedPct, resetsAt: 9e12 }], updatedAt: 1, source: 'claude-usage-api' })

describe('agent schedule host', () => {
  test('saving a schedule outside its window turns the account off for agents', async () => {
    await setAccountAgentSchedule('acc_1', sched, at(2, 14))
    expect((await account()).available).toBe(false)
    expect(notified).toBe(1)
  })
  test('the window opening turns it on; the daily ceiling turns it off again', async () => {
    limits = [week(40)]
    await setAccountAgentSchedule('acc_1', sched, at(2, 8))
    expect((await account()).available).toBe(false)
    expect(await evaluateAgentSchedules(at(2, 9, 1))).toEqual(['acc_1'])
    expect((await account()).available).toBe(true)
    limits = [week(50)]
    await evaluateAgentSchedules(at(2, 10))
    expect((await account()).available).toBe(false)
  })
  test('manual on beats the schedule; turning it off returns to the schedule', async () => {
    await setAccountAgentSchedule('acc_1', sched, at(2, 14))
    await toggleAccountAgentUse('acc_1', true, at(2, 14))
    expect(await account()).toMatchObject({ available: true, agentManual: 'on' })
    await evaluateAgentSchedules(at(2, 15))
    expect((await account()).available).toBe(true)
    await toggleAccountAgentUse('acc_1', false, at(2, 15))
    const a = await account()
    expect(a.available).toBe(false)
    expect(a.agentManual).toBeUndefined()
  })
  test('without a schedule the switch is the plain flag and the evaluator touches nothing', async () => {
    await toggleAccountAgentUse('acc_1', false, at(2, 10))
    expect((await account()).available).toBe(false)
    expect(await evaluateAgentSchedules(at(2, 10))).toEqual([])
    expect((await account()).available).toBe(false)
  })
})

describe('PATCH/GET /api/accounts', () => {
  const req = (body: unknown) => new Request('http://x/api/accounts/acc_1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  test('refuses an invalid schedule', async () => {
    const r = await handleAccountsRequest(req({ agentSchedule: { enabled: true, days: { mon: { windows: [{ from: '25:00', to: '10:00' }] } } } }), ['claude'])
    expect(r.status).toBe(400)
  })
  test('saves a schedule and reports the effective state with its reason', async () => {
    const r = await handleAccountsRequest(req({ agentSchedule: { enabled: true, days: {} } }), ['claude'])
    expect(r.status).toBe(200)
    const body = await r.json() as { account: { available: boolean; agentUse?: { reason: string; on: boolean } } }
    expect(body.account.available).toBe(false)
    expect(body.account.agentUse).toMatchObject({ on: false, reason: 'day-off' })
    const g = await handleAccountsRequest(new Request('http://x/api/accounts'), ['claude'])
    const list = await g.json() as { accounts: { id: string; agentUse?: { reason: string } }[] }
    expect(list.accounts.find(a => a.id === 'acc_1')?.agentUse?.reason).toBe('day-off')
  })
  test('removing the schedule (null) drops it and the reason', async () => {
    await handleAccountsRequest(req({ agentSchedule: { enabled: true, days: {} } }), ['claude'])
    const r = await handleAccountsRequest(req({ agentSchedule: null }), ['claude'])
    const body = await r.json() as { account: { agentSchedule?: unknown; agentUse?: unknown } }
    expect(body.account.agentSchedule).toBeUndefined()
    expect(body.account.agentUse).toBeUndefined()
  })
  test('all-day day is on at 00:00 and 23:59; the weekly ceiling turns it off, no reading never does', async () => {
    const full: AgentSchedule = { enabled: true, maxWeeklyPct: 50, days: { mon: { windows: [], allDay: true } } }
    limits = [week(10)]
    await setAccountAgentSchedule('acc_1', full, at(2, 0, 0))
    expect((await account()).available).toBe(true)
    await evaluateAgentSchedules(at(2, 23, 59))
    expect((await account()).available).toBe(true)
    limits = [week(50)]
    await evaluateAgentSchedules(at(2, 23, 59))
    expect((await account()).available).toBe(false)
    limits = []
    await evaluateAgentSchedules(at(2, 23, 59))
    expect((await account()).available).toBe(true)
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSchedule, PlanLimits } from '@agentistics/core'
import { __setHarnessAccountsForTest, createHarnessAccounts, readAccounts } from './harness-accounts'
import { __setAgentScheduleDepsForTest, evaluateAgentSchedules, setAccountAgentSchedule, setAccountAgentUse, toggleAccountAgentUse } from './agent-schedule-host'
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
  test('the override is STICKY: free at any hour, and it does not clear itself when the schedule agrees', async () => {
    await setAccountAgentSchedule('acc_1', sched, at(2, 14))
    await setAccountAgentUse('acc_1', { agentOverride: true }, {}, at(2, 14))
    expect(await account()).toMatchObject({ available: true, agentOverride: true, agentUseEnabled: true })
    await evaluateAgentSchedules(at(2, 10)) // inside the window: the schedule agrees
    await evaluateAgentSchedules(at(2, 15)) // outside again: still free
    expect(await account()).toMatchObject({ available: true, agentOverride: true })
    await setAccountAgentUse('acc_1', { agentOverride: false }, {}, at(2, 15))
    expect((await account()).available).toBe(false) // back to the schedule
  })
  test('Agenda off wins over everything, the override included; turning it on returns to the schedule', async () => {
    await setAccountAgentSchedule('acc_1', sched, at(2, 10))
    expect((await account()).available).toBe(true)
    await setAccountAgentUse('acc_1', { agentUseEnabled: false, agentOverride: true }, {}, at(2, 10))
    expect(await account()).toMatchObject({ available: false, agentUseEnabled: false, agentOverride: true })
    await setAccountAgentUse('acc_1', { agentUseEnabled: true }, {}, at(2, 10))
    expect(await account()).toMatchObject({ available: true, agentOverride: true })
  })
  test('without a schedule the master is the plain flag', async () => {
    await toggleAccountAgentUse('acc_1', false, at(2, 10))
    expect(await account()).toMatchObject({ available: false, agentUseEnabled: false })
    await toggleAccountAgentUse('acc_1', true, at(2, 10))
    expect((await account()).available).toBe(true)
  })
})

describe('migration of the old manual override', () => {
  const seed = async (extra: Record<string, unknown>) => {
    const file = join(dir, 'accounts.json')
    writeFileSync(file, JSON.stringify({ version: 2, bindings: {}, segments: {}, accounts: [
      { id: 'acc_1', root: null, key: 'k1', harness: 'claude', label: 'A', available: true, firstSeen: 1, lastSeen: 1, agentSchedule: sched, ...extra },
    ] }))
    __setHarnessAccountsForTest(createHarnessAccounts({ file, probe: async () => ({ key: 'default', label: 'x' }) }))
  }
  test("agentManual 'on' becomes a sticky override and is dropped from the record", async () => {
    await seed({ agentManual: 'on' })
    await evaluateAgentSchedules(at(2, 14))
    const a = await account()
    expect(a).toMatchObject({ available: true, agentUseEnabled: true, agentOverride: true })
    expect(a.agentManual).toBeUndefined()
  })
  test("agentManual 'off' becomes Agenda off", async () => {
    await seed({ agentManual: 'off' })
    await evaluateAgentSchedules(at(2, 10))
    expect(await account()).toMatchObject({ available: false, agentUseEnabled: false, agentOverride: false })
  })
  test('a scheduled record with no manual choice becomes enabled, no override', async () => {
    await seed({ available: false })
    await evaluateAgentSchedules(at(2, 10))
    expect(await account()).toMatchObject({ available: true, agentUseEnabled: true, agentOverride: false })
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
  test('removing the schedule (null) drops it; the account is then simply available', async () => {
    await handleAccountsRequest(req({ agentSchedule: { enabled: true, days: {} } }), ['claude'])
    const r = await handleAccountsRequest(req({ agentSchedule: null }), ['claude'])
    const body = await r.json() as { account: { agentSchedule?: unknown; available: boolean; agentUse?: { reason: string } } }
    expect(body.account.agentSchedule).toBeUndefined()
    expect(body.account.available).toBe(true)
    expect(body.account.agentUse?.reason).toBe('no-schedule')
  })
  test('ONE request carries the switches, the schedule and the nickname together', async () => {
    const r = await handleAccountsRequest(req({
      agentUseEnabled: true, agentOverride: true, nickname: 'Pessoal',
      agentSchedule: { enabled: true, days: { mon: { windows: [{ from: '08:00', to: '12:00' }, { from: '14:00', to: '20:00' }] } } },
    }), ['claude'])
    expect(r.status).toBe(200)
    const body = await r.json() as { account: { nickname?: string; available: boolean; agentOverride?: boolean; agentUseEnabled?: boolean; agentSchedule?: AgentSchedule; agentUse?: { reason: string; enabled: boolean; override: boolean } } }
    expect(body.account).toMatchObject({ nickname: 'Pessoal', available: true, agentOverride: true, agentUseEnabled: true })
    expect(body.account.agentSchedule?.days.mon?.windows).toHaveLength(2) // several ranges on one day survive
    expect(body.account.agentUse).toMatchObject({ reason: 'override-on', enabled: true, override: true })
  })
  test('Agenda off reports agenda-off, and the legacy {available} body is the same master switch', async () => {
    const r = await handleAccountsRequest(req({ agentUseEnabled: false }), ['claude'])
    const body = await r.json() as { account: { available: boolean; agentUse?: { reason: string } } }
    expect(body.account.available).toBe(false)
    expect(body.account.agentUse?.reason).toBe('agenda-off')
    const legacy = await handleAccountsRequest(req({ available: true }), ['claude'])
    expect(((await legacy.json()) as { account: { available: boolean } }).account.available).toBe(true)
  })
  test('refuses a non-boolean switch and an empty body', async () => {
    expect((await handleAccountsRequest(req({ agentOverride: 'yes' }), ['claude'])).status).toBe(400)
    expect((await handleAccountsRequest(req({}), ['claude'])).status).toBe(400)
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

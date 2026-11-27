/**
 * CONTAS.AVISO-LIDER — the host half: each trigger, the override/schedule matrix, workers never told,
 * dedupe persisted on the account record (survives a restart), flapping.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountAvailableForAgents, type AgentSchedule, type PlanLimits } from '@agentistics/core'
import { __setHarnessAccountsForTest, createHarnessAccounts, readAccounts } from './harness-accounts'
import {
  __setAccountNoticeDepsForTest, __setAgentScheduleDepsForTest, agentUseView, checkAccountAvailability,
  setAccountAgentUse, evaluateAgentSchedules,
} from './agent-schedule-host'

let dir = '', file = ''
let hold = false, loginBroken = false
let sent: { id: string; text: string }[] = []
let rows: { id: string; conversationId?: string; running: boolean }[] = []
let roles: Record<string, string> = {}
const limits: PlanLimits[] = []
// 2026-11-26 is a Thursday; window 09:00-18:00.
const at = (h: number, m = 0, day = 26) => new Date(2026, 10, day, h, m)
const sched: AgentSchedule = { enabled: true, days: { thu: { windows: [{ from: '09:00', to: '18:00' }] } } }
const account = async () => (await readAccounts()).accounts.find(a => a.id === 'acc_1')!

function install(): void {
  __setHarnessAccountsForTest(createHarnessAccounts({ file, probe: async () => ({ key: 'default', label: 'x' }) }))
  __setAccountNoticeDepsForTest({
    // The same facts the real observer reads off plan-limits: the visible flag, the login, the hold.
    observe: async now => {
      const a = await account()
      const view = agentUseView(a, limits, now)
      return [{
        id: a.id, label: 'Nayara', harness: 'Claude Code', plan: 'Max 5x',
        available: accountAvailableForAgents({ visible: a.available, spawnable: !loginBroken, status: hold ? 'hold' : 'ok' }),
        ...(view ? { reason: view.reason } : {}), ...(view?.reason === 'in-window' ? { until: '18:00' } : {}),
      }]
    },
    rows: async () => rows,
    roleOf: async id => roles[id],
    send: async (id, text) => { sent.push({ id, text }); return { ok: true } },
    lang: async () => 'pt',
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acct-notice-'))
  file = join(dir, 'accounts.json')
  writeFileSync(file, JSON.stringify({ version: 2, bindings: {}, segments: {}, accounts: [
    { id: 'acc_1', root: null, key: 'k1', harness: 'claude', label: 'A', available: true, firstSeen: 1, lastSeen: 1 },
  ] }))
  hold = false; loginBroken = false; sent = []
  rows = [{ id: 'lead1', running: true }, { id: 'work1', running: true }, { id: 'lead-gone', running: false }]
  roles = { lead1: 'leader', work1: 'worker', 'lead-gone': 'leader' }
  __setAgentScheduleDepsForTest({ limits: async () => limits, notify: () => {} })
  install()
})
afterEach(() => {
  __setAccountNoticeDepsForTest(null); __setAgentScheduleDepsForTest(null)
  rmSync(dir, { recursive: true, force: true })
})

/** Put the account into a known UNAVAILABLE state seen by the notifier (first sight records only). */
async function seedUnavailable(now: Date) {
  await setAccountAgentUse('acc_1', { agentUseEnabled: true, agentOverride: false, agentSchedule: sched }, {}, now)
  expect(await checkAccountAvailability(now)).toEqual([])
  expect((await account()).agentAvailability?.available).toBe(false)
}

describe('triggers', () => {
  test('the schedule window opens -> leaders told once, with the window end', async () => {
    await seedUnavailable(at(8, 30))
    await evaluateAgentSchedules(at(9, 0))
    expect(await checkAccountAvailability(at(9, 0))).toEqual(['acc_1'])
    expect(sent).toEqual([{ id: 'lead1', text: '[agentistics · conta] A conta Nayara (Claude Code, Max 5x) está disponível para agentes: dentro da agenda até 18:00. Veja agentistics_plan_limits antes de abrir sessões.' }])
    await evaluateAgentSchedules(at(9, 1))
    expect(await checkAccountAvailability(at(9, 1))).toEqual([])
    expect(sent).toHaveLength(1)
  })
  test('the user enables the account (Agenda on) -> told', async () => {
    await setAccountAgentUse('acc_1', { agentUseEnabled: false }, {}, at(10))
    await checkAccountAvailability(at(10))
    await setAccountAgentUse('acc_1', { agentUseEnabled: true }, {}, at(10, 30))
    expect(await checkAccountAvailability(at(10, 30))).toEqual(['acc_1'])
    expect(sent.map(s => s.id)).toEqual(['lead1'])
  })
  test('override on outside the window -> told (override wins)', async () => {
    await seedUnavailable(at(20))
    await setAccountAgentUse('acc_1', { agentOverride: true }, {}, at(20, 5))
    expect(await checkAccountAvailability(at(20, 5))).toEqual(['acc_1'])
    expect(sent[0]!.text).toContain(': sobrescrito ligado.')
  })
  test('switched on with override OFF outside the window -> NOT available -> nothing', async () => {
    await setAccountAgentUse('acc_1', { agentUseEnabled: false, agentSchedule: sched }, {}, at(20))
    await checkAccountAvailability(at(20))
    await setAccountAgentUse('acc_1', { agentUseEnabled: true, agentOverride: false }, {}, at(20, 5))
    expect((await account()).available).toBe(false)
    expect(await checkAccountAvailability(at(20, 5))).toEqual([])
    expect(sent).toEqual([])
  })
  test('login re-done (expired -> ok) -> told', async () => {
    loginBroken = true
    await checkAccountAvailability(at(10))
    loginBroken = false
    expect(await checkAccountAvailability(at(10, 20))).toEqual(['acc_1'])
  })
  test('a hold lifted by a 5 h / weekly reset -> told', async () => {
    hold = true
    await checkAccountAvailability(at(10))
    hold = false
    expect(await checkAccountAvailability(at(15))).toEqual(['acc_1'])
  })
})

describe('edges', () => {
  test('workers and stopped sessions are never told', async () => {
    rows.push({ id: 'lead2', running: true }); roles.lead2 = 'leader'
    hold = true; await checkAccountAvailability(at(10))
    hold = false; await checkAccountAvailability(at(10, 30))
    expect(sent.map(s => s.id).sort()).toEqual(['lead1', 'lead2'])
  })
  test('going unavailable sends nothing', async () => {
    await checkAccountAvailability(at(10))
    hold = true
    expect(await checkAccountAvailability(at(10, 5))).toEqual([])
    expect(sent).toEqual([])
    expect((await account()).agentAvailability).toMatchObject({ available: false, since: at(10, 5).getTime() })
  })
  test('dedupe persists across a restart: the state is on the account record, not in memory', async () => {
    hold = true; await checkAccountAvailability(at(10))
    hold = false; await checkAccountAvailability(at(10, 30))
    expect(sent).toHaveLength(1)
    // "Restart": a fresh accounts store and fresh deps read the same file.
    install()
    expect(await checkAccountAvailability(at(10, 31))).toEqual([])
    expect(await checkAccountAvailability(at(11))).toEqual([])
    expect(sent).toHaveLength(1)
  })
  test('flapping inside 10 min: no new notice; a later transition is told again', async () => {
    hold = true; await checkAccountAvailability(at(10))
    hold = false; await checkAccountAvailability(at(10, 1))
    hold = true; await checkAccountAvailability(at(10, 3))
    hold = false; expect(await checkAccountAvailability(at(10, 6))).toEqual([])
    hold = true; await checkAccountAvailability(at(10, 8))
    hold = false; expect(await checkAccountAvailability(at(10, 20))).toEqual(['acc_1'])
    expect(sent).toHaveLength(2)
  })
  test('a first sight (boot) announces nothing, available or not', async () => {
    expect(await checkAccountAvailability(at(10))).toEqual([])
    expect(sent).toEqual([])
  })
  test('concurrent runs (tick + edit) send once', async () => {
    hold = true; await checkAccountAvailability(at(10))
    hold = false
    const both = await Promise.all([checkAccountAvailability(at(10, 30)), checkAccountAvailability(at(10, 30))])
    expect(both.flat()).toEqual(['acc_1'])
    expect(sent).toHaveLength(1)
  })
})

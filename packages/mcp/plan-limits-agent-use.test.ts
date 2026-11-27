import { describe, expect, test } from 'bun:test'
import { planLimitsTool } from './plan-limits-tool'

/** CONTAS.AGENDA-SALVAR: what an agent reading `agentistics_plan_limits` sees of the two switches. */
describe('agentistics_plan_limits — the two agent-use switches and the reason', () => {
  test('an account the Agenda switch turned off is NOT named (hidden outright, like a manual off)', () => {
    const out = planLimitsTool(undefined, {
      budgets: [],
      hiddenFromAgents: [{ harness: 'claude', account: 'acc_1', accountLabel: 'x@y.z', agentUse: { on: false, reason: 'agenda-off', enabled: false, override: false } }],
    })
    expect(out.offBySchedule).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('claude')
  })
  test('an account the schedule keeps off IS named, with its reason and no label', () => {
    const out = planLimitsTool(undefined, {
      budgets: [],
      hiddenFromAgents: [{ harness: 'claude', account: 'acc_1', accountLabel: 'x@y.z', agentUse: { on: false, reason: 'outside-window', enabled: true, override: false } }],
    })
    expect(out.offBySchedule).toEqual([{ harness: 'claude', account: 'acc_1', reason: 'outside-window' }])
    expect(JSON.stringify(out)).not.toContain('x@y.z')
  })
  test('a visible row carries the switches and the reason (override-on) as the server computed them', () => {
    const out = planLimitsTool(undefined, {
      budgets: [{ harness: 'claude', account: 'acc_2', agentUse: { on: true, reason: 'override-on', enabled: true, override: true } }],
    })
    expect(out.budgets[0].agentUse).toEqual({ on: true, reason: 'override-on', enabled: true, override: true })
    expect(out.offBySchedule).toBeUndefined()
  })
  test('CONTAS.AVISO-LIDER: a visible row says since when it is available (availableSince, epoch ms)', () => {
    const out = planLimitsTool(undefined, {
      budgets: [{ harness: 'claude', account: 'acc_2', availableSince: 1_790_000_000_000, agentUse: { on: true, reason: 'in-window', enabled: true, override: false } }],
    })
    expect(out.budgets[0].availableSince).toBe(1_790_000_000_000)
  })
})

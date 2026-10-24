import { describe, expect, test } from 'bun:test'
import type { PlanLimits } from '@agentistics/core'
import { defaultPick, limitsFor, pickerRows, spentUntil, unavailableReason } from './accountPicker'
import type { SwitchInfo } from './accountSwitch'

const now = Date.UTC(2026, 9, 24, 12, 0)
const H = 3_600_000
const lim = (harness: PlanLimits['harness'], account: string, five: number, week: number, plan = 'Max'): PlanLimits => ({
  harness, account, plan, source: 'harness', updatedAt: now,
  windows: [{ kind: '5h', usedPct: five, resetsAt: now + 2 * H }, { kind: 'week', usedPct: week, resetsAt: now + 50 * H }],
} as unknown as PlanLimits)

const info: SwitchInfo = {
  ok: true, supported: true, limit: null,
  current: { id: 'acc_a', label: 'a@x', harness: 'claude' },
  options: [
    { id: 'acc_b', harness: 'claude', label: 'b@x', recommended: true },
    { id: 'acc_c', harness: 'claude', label: 'c@x' },
    { id: 'acc_k', harness: 'codex', label: 'k@x', plan: 'Plus' },
  ],
  unavailable: [
    { id: 'acc_h', harness: 'claude', label: 'h@x', reason: 'not_agentic' },
    { id: 'acc_o', harness: 'copilot', label: 'o@x', reason: 'signed_out' },
  ],
}

describe('pickerRows', () => {
  const limits = [lim('claude', 'acc_a', 40, 10), lim('claude', 'acc_b', 100, 30), lim('claude', 'acc_c', 10, 100), lim('codex', 'default', 5, 5, 'Plus')]
  const rows = pickerRows(info, limits, now, 'en')
  test('current first, then the server targets in order, then the accounts that are not targets', () => {
    expect(rows.map(r => `${r.key}:${r.kind}`)).toEqual([
      'claude:acc_a:current', 'claude:acc_b:disabled', 'claude:acc_c:disabled', 'codex:acc_k:option',
      'claude:acc_h:disabled', 'copilot:acc_o:disabled',
    ])
  })
  test('a spent target is disabled until its LATEST spent window renews', () => {
    expect(rows[1]!.reason).toMatch(/^At its limit · resets /)
    expect(spentUntil(limits[1]!, now)).toBe(now + 2 * H)
    expect(spentUntil(lim('claude', 'x', 100, 100), now)).toBe(now + 50 * H)
    expect(spentUntil(lim('claude', 'x', 99, 10), now)).toBeNull()
    expect(spentUntil(null, now)).toBeNull()
  })
  test('the server reasons are worded; another harness is a hand-off', () => {
    expect(rows[4]!.reason).toBe('Not available for agent use')
    expect(rows[5]!.reason).toBe('Not signed in on this machine')
    expect(rows[3]!.handoff).toBe(true)
    expect(rows[0]!.handoff).toBe(false)
    expect(unavailableReason('cant_carry', 'pt')).toBe('Este assistente não leva a conversa para outra conta')
  })
  test('readings: exact account, else a lone legacy `default` meter; never a guess between two', () => {
    expect(rows[3]!.limits?.account).toBe('default')
    expect(limitsFor([lim('claude', 'default', 1, 1), lim('claude', 'acc_z', 1, 1)], 'claude', 'acc_q')).toBeNull()
    expect(limitsFor(null, 'claude', 'acc_a')).toBeNull()
    expect(pickerRows(info, null, now, 'pt').every(r => r.limits === null)).toBe(true)
  })
  test('no reading is not a refusal: the account stays pickable', () => {
    expect(pickerRows(info, [], now, 'pt').filter(r => r.kind === 'option').map(r => r.id)).toEqual(['acc_b', 'acc_c', 'acc_k'])
  })
  test('the default pick skips a spent recommendation', () => {
    expect(defaultPick(rows)).toBe('codex:acc_k')
    expect(defaultPick(pickerRows(info, [], now, 'pt'))).toBe('claude:acc_b')
    expect(defaultPick(pickerRows({ ...info, options: [] }, [], now, 'pt'))).toBe('')
  })
  test('the default pick stays on the same assistant even when the router prefers another', () => {
    const routerOnCodex: SwitchInfo = { ...info, options: info.options.map(o => ({ ...o, recommended: o.harness === 'codex' })) }
    expect(defaultPick(pickerRows(routerOnCodex, [], now, 'en'))).toBe('claude:acc_b')
  })
  test('a missing CLI is said as a fact about this computer, not a capability', () => {
    expect(unavailableReason('harness_unavailable', 'pt')).toBe('Não encontrado neste computador')
    expect(unavailableReason('harness_unavailable', 'en')).toBe('Not found on this computer')
  })
})

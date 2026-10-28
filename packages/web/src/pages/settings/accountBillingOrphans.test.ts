import { describe, expect, test } from 'bun:test'
import type { BillingSettings } from '@agentistics/core'
import { orphanTimelines, upcomingPeriod, withoutOrphan } from './accountBilling'

const plan = (id: string, from: string) => ({ id, mode: 'subscription' as const, planId: 'claude-max-5x', price: { amount: 100, currency: 'USD' as const }, from })

describe('a plan that starts later is still a plan (CONTAS.MAC.NOVO)', () => {
  test('the earliest future period is found; one in force is not upcoming', () => {
    expect(upcomingPeriod([plan('a', '2026-12-01'), plan('b', '2026-11-01')], '2026-10-28')?.id).toBe('b')
    expect(upcomingPeriod([plan('a', '2026-10-28')], '2026-10-28')).toBeNull()
  })
})

describe('orphan plans — stored, edited by no row, and removable (CONTAS.MAC.NOVO)', () => {
  const billing: BillingSettings = {
    profiles: { codex: { periods: [plan('d', '2026-01-01')] } },
    accountProfiles: { 'claude:gone': { periods: [plan('o', '2026-01-01')] }, 'claude:c1': { periods: [plan('m', '2026-01-01')] } },
  }
  const rows = [{ scope: { kind: 'own' as const, id: 'c1', harness: 'claude' as const } }]
  test('an account that left the list and a default nobody prices on are orphans; a row\'s own is not', () => {
    expect(orphanTimelines(billing, rows).map(o => o.key).sort()).toEqual(['claude:gone', 'default:codex'])
  })
  test('a fresh machine with only the assistant row: its default is used, nothing is orphan', () => {
    expect(orphanTimelines({ profiles: { claude: { periods: [plan('x', '2026-01-01')] } } }, [{ scope: { kind: 'default', harness: 'claude' } }])).toEqual([])
  })
  test('removing an orphan drops exactly that timeline', () => {
    const [acc, def] = [orphanTimelines(billing, rows).find(o => o.kind === 'account')!, orphanTimelines(billing, rows).find(o => o.kind === 'default')!]
    expect(withoutOrphan(billing, acc).accountProfiles).toEqual({ 'claude:c1': billing.accountProfiles!['claude:c1']! })
    expect(withoutOrphan(billing, def).profiles).toEqual({})
  })
})

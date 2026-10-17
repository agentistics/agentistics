import { describe, expect, test } from 'bun:test'
import { computePlanCost, normalizeBillingSettings, type BillingSettings } from '@agentistics/core'
import { createAccountMutator } from './accountMutations'
import {
  accountsNeedingPlan, answerNotice, billableAccounts, capabilityNotes, matchDetectedPlan, noticeAccounts, planSummary, toggleAvailability, withAccountPeriods,
  type BillingAccount,
} from './accountBilling'

const acc = (id: string, o: Partial<BillingAccount> = {}): BillingAccount => ({
  id, harness: 'claude', key: id, label: `${id}@x.io`, root: null, available: true, firstSeen: Date.parse('2026-09-01T00:00:00Z'), ...o,
})
let n = 0
const newId = () => `bp_t${++n}`
const none: BillingSettings = { profiles: {} }

describe('accountsNeedingPlan', () => {
  test('two accounts, no plan anywhere: both ask; one answer removes only that notice', () => {
    const accounts = [acc('a', { plan: 'max' }), acc('b', { firstSeen: Date.parse('2026-09-02T00:00:00Z') })]
    expect(accountsNeedingPlan(accounts, none, ['claude']).map(a => a.id)).toEqual(['a', 'b'])
    const answered = answerNotice(none, accounts[0]!, 'anthropic-pro', '2026-10-16', newId)!
    expect(answered.accountProfiles?.a?.periods).toHaveLength(1)
    expect(accountsNeedingPlan(accounts, answered, ['claude']).map(a => a.id)).toEqual(['b'])
  })

  test('the notice disappears after a pick, and after "not sure" (prices as unknown, not 0)', () => {
    const [a] = [acc('a'), acc('b')]
    const accounts = [a!, acc('b')]
    const unknown = answerNotice(none, a!, null, '2026-10-16', newId)!
    expect(unknown.accountProfiles?.a?.periods[0]?.mode).toBe('unknown')
    expect(accountsNeedingPlan(accounts, unknown, ['claude']).map(x => x.id)).toEqual(['b'])
    const cost = computePlanCost({
      timeline: undefined, window: { from: '2026-10-01', to: '2026-10-10' }, brlRate: 5,
      accounts: [{ id: 'a', harness: 'claude' }], accountProfiles: unknown.accountProfiles,
    })
    expect(cost.unavailable).toBe(true)
    expect(cost.subscriptionCostUSD).toBe(0)
  })

  test('the harness default covers the oldest account only', () => {
    const billing = normalizeBillingSettings({ profiles: { claude: { periods: [{ id: 'd', mode: 'subscription', planId: 'anthropic-pro', price: { amount: 20, currency: 'USD' }, from: '2026-01-01' }] } } })
    expect(accountsNeedingPlan([acc('a'), acc('b', { firstSeen: Date.parse('2026-09-05T00:00:00Z') })], billing, ['claude']).map(a => a.id)).toEqual(['b'])
  })

  test('the PRIMARY case: a first account with no plan reported and no default asks which plan it is', () => {
    expect(accountsNeedingPlan([acc('solo')], none, ['claude']).map(a => a.id)).toEqual(['solo'])
  })

  test('a notice stays listed while its answer is saving or failed, and goes once the account is priced', () => {
    const a = acc('a'); const b = acc('b')
    // answered optimistically (no longer "needing a plan") but still in flight: kept
    expect(noticeAccounts([b], [a, b], new Set(['a'])).map(x => x.id)).toEqual(['b', 'a'])
    // stored: neither needs a plan nor is in flight
    expect(noticeAccounts([b], [a, b], new Set()).map(x => x.id)).toEqual(['b'])
    // already listed once, never twice
    expect(noticeAccounts([a], [a], new Set(['a'])).map(x => x.id)).toEqual(['a'])
  })

  test('hidden, retired and unidentified accounts are never priced here', () => {
    const list = [acc('a'), acc('r', { retired: true }), acc('', { harness: 'claude' })]
    expect(billableAccounts(list, 'claude').map(a => a.id)).toEqual(['a'])
  })
})

describe('two Claude accounts hold their own plan; cost basis reflects both', () => {
  test('accountProfiles written per id round-trip through normalize and sum in C', () => {
    let b = answerNotice(none, acc('a'), 'anthropic-pro', '2026-10-16', newId)!
    b = answerNotice(b, acc('b'), 'anthropic-max-20x', '2026-10-16', newId) ?? withAccountPeriods(b, 'b', [{ id: 'q', mode: 'subscription', planId: 'anthropic-max-20x', price: { amount: 200, currency: 'USD' }, from: '2026-09-01' }])
    const back = normalizeBillingSettings(JSON.parse(JSON.stringify(b)))
    expect(Object.keys(back.accountProfiles ?? {}).sort()).toEqual(['a', 'b'])
    const refs = [{ id: 'a', harness: 'claude' as const }, { id: 'b', harness: 'claude' as const }]
    const window = { from: '2026-10-01', to: '2026-10-30' }
    const both = computePlanCost({ timeline: undefined, window, brlRate: 5, accounts: refs, accountProfiles: back.accountProfiles })
    const onlyA = computePlanCost({ timeline: undefined, window, brlRate: 5, accounts: refs.slice(0, 1), accountProfiles: { a: back.accountProfiles!.a! } })
    expect(both.subscriptionCostUSD).toBeGreaterThan(onlyA.subscriptionCostUSD)
    expect(both.segments).toHaveLength(2)
  })

  test('planSummary: own plan, inherited default, none', () => {
    const b = normalizeBillingSettings({
      profiles: { claude: { periods: [{ id: 'd', mode: 'subscription', planId: 'anthropic-pro', price: { amount: 20, currency: 'USD' }, from: '2026-01-01' }] } },
      accountProfiles: { a: { periods: [{ id: 'o', mode: 'subscription', planId: 'anthropic-max-20x', price: { amount: 100, currency: 'USD' }, from: '2026-01-01' }] } },
    })
    expect(planSummary(b, acc('a'), '2026-10-16').source).toBe('own')
    expect(planSummary(b, acc('z'), '2026-10-16').source).toBe('default')
    expect(planSummary(none, acc('z'), '2026-10-16')).toEqual({ name: null, source: 'none' })
  })
})

describe('availability switch', () => {
  test('PATCHes /api/accounts/<id> with the flipped flag, by id', async () => {
    const calls: { id: string; body: unknown }[] = []
    const mutator = createAccountMutator<BillingAccount>(async (id, body) => {
      calls.push({ id, body })
      return { ok: true, json: async () => ({ account: acc(id, { available: false }) }) }
    })
    const res = await toggleAvailability(mutator, acc('acc_2'))
    expect(calls).toEqual([{ id: 'acc_2', body: { available: false } }])
    expect(res.status).toBe('ok')
  })
})

test('matchDetectedPlan prefills from the harness-reported plan, never guessing', () => {
  expect(matchDetectedPlan('claude', undefined)).toBe('')
  expect(matchDetectedPlan('claude', 'zzz-unknown')).toBe('')
})

test('capability sentences per harness', () => {
  expect(capabilityNotes('claude')).toEqual([])
  expect(capabilityNotes('gemini')).toEqual(['noMeter', 'noIdentity'])
  expect(capabilityNotes('antigravity')).toEqual(['noMeter', 'noIdentity', 'singleAccount'])
})

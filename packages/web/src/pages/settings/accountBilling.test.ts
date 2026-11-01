import { describe, expect, test } from 'bun:test'
import { computePlanCost, normalizeBillingSettings, type BillingSettings } from '@agentistics/core'
import { createAccountMutator } from './accountMutations'
import {
  saveThenClose, saveErrorPlace, planCoverageText, planAbsentText,
  ownPeriods, REPORTS_LIMITS, accountsNeedingPlan, answerNotice, billableAccounts, billingRows, closeBefore, defaultStart, foldUnnamed, planOptionsFor, rowScope, scopePeriods, withScopePeriods, capabilityNotes, matchDetectedPlan, noticeAccounts, planSummary, toggleAvailability, withAccountPeriods,
  limitsForRow, planDraftWrites, detectedPlanId,
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
    expect(answered.accountProfiles?.['claude:a']?.periods).toHaveLength(1)
    expect(accountsNeedingPlan(accounts, answered, ['claude']).map(a => a.id)).toEqual(['b'])
  })

  test('the notice disappears after a pick, and after "not sure" (prices as unknown, not 0)', () => {
    const [a] = [acc('a'), acc('b')]
    const accounts = [a!, acc('b')]
    const unknown = answerNotice(none, a!, null, '2026-10-16', newId)!
    expect(unknown.accountProfiles?.['claude:a']?.periods[0]?.mode).toBe('unknown')
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
    b = answerNotice(b, acc('b'), 'anthropic-max-20x', '2026-10-16', newId) ?? withAccountPeriods(b, acc('b'), [{ id: 'q', mode: 'subscription', planId: 'anthropic-max-20x', price: { amount: 200, currency: 'USD' }, from: '2026-09-01' }])
    const back = normalizeBillingSettings(JSON.parse(JSON.stringify(b)))
    expect(Object.keys(back.accountProfiles ?? {}).sort()).toEqual(['claude:a', 'claude:b'])
    const refs = [{ id: 'a', harness: 'claude' as const }, { id: 'b', harness: 'claude' as const }]
    const window = { from: '2026-10-01', to: '2026-10-30' }
    const both = computePlanCost({ timeline: undefined, window, brlRate: 5, accounts: refs, accountProfiles: back.accountProfiles })
    const onlyA = computePlanCost({ timeline: undefined, window, brlRate: 5, accounts: refs.slice(0, 1), accountProfiles: { 'claude:a': back.accountProfiles!['claude:a']! } })
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
  expect(capabilityNotes('antigravity')).toEqual(['noIdentity', 'singleAccount'])
})

describe('R3 saveThenClose', () => {
  test('a refused write keeps the drawer (and its draft); a stored one closes it', async () => {
    let closed = 0
    expect(await saveThenClose(async () => false, () => { closed++ })).toBe(false)
    expect(closed).toBe(0)
    expect(await saveThenClose(async () => true, () => { closed++ })).toBe(true)
    expect(closed).toBe(1)
  })
})

describe('L4/L5 saveErrorPlace', () => {
  const err = { msg: 'x', id: 'a' as string | null }
  test('shown once: drawer while open, page otherwise', () => {
    expect(saveErrorPlace(err, { a: 'failed' }, true)).toBe('drawer')
    expect(saveErrorPlace(err, { a: 'failed' }, false)).toBe('page')
    expect(saveErrorPlace({ msg: 'x', id: null }, {}, true)).toBe('drawer')
  })
  test('a failure carried by a later stored write is no longer reported', () => {
    expect(saveErrorPlace(err, {}, true)).toBeNull()
    expect(saveErrorPlace(null, {}, true)).toBeNull()
  })
})

const sub = (planId: string, from = '2026-09-01') => ({ id: newId(), mode: 'subscription' as const, planId, price: { amount: 100, currency: 'USD' as const }, from })
const L = (h: string) => ({ claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI' } as Record<string, string>)[h] ?? h

describe('rowScope — the timeline a row prices on is the one core counts', () => {
  test('own first; the default goes to the FIRST account without one; nobody else inherits it', () => {
    const a = acc('a'), b = acc('b', { firstSeen: Date.parse('2026-09-02T00:00:00Z') }), c = acc('c', { firstSeen: Date.parse('2026-09-03T00:00:00Z') })
    const billing: BillingSettings = { profiles: { claude: { periods: [sub('anthropic-max-5x')] } }, accountProfiles: { a: { periods: [sub('anthropic-pro')] } } }
    const mine = [a, b, c]
    expect(rowScope(billing, mine, a)).toEqual({ kind: 'own', id: 'a', harness: 'claude' })
    expect(rowScope(billing, mine, b)).toEqual({ kind: 'default', harness: 'claude' })
    expect(rowScope(billing, mine, c)).toEqual({ kind: 'none', id: 'c', harness: 'claude' })
    expect(accountsNeedingPlan(mine, billing, ['claude']).map(x => x.id)).toEqual(['c'])
  })
  test('writing a scope back touches only that timeline', () => {
    const billing: BillingSettings = { profiles: { claude: { periods: [sub('anthropic-max-5x')] } } }
    const p = sub('anthropic-pro')
    expect(withScopePeriods(billing, { kind: 'default', harness: 'claude' }, [p]).profiles.claude?.periods).toEqual([p])
    const own = withScopePeriods(billing, { kind: 'none', id: 'x', harness: 'claude' }, [p])
    expect(own.accountProfiles?.['claude:x']?.periods).toEqual([p])
    expect(own.profiles.claude?.periods).toHaveLength(1)
    expect(scopePeriods(own, { kind: 'own', id: 'x', harness: 'claude' })).toEqual([p])
    expect(withScopePeriods(billing, { kind: 'default', harness: 'claude' }, []).profiles.claude).toBeUndefined()
  })
})

describe('billingRows — one row per account, nothing said twice', () => {
  test('a nickname takes the title; the login moves to the subtitle beside the assistant', () => {
    const rows = billingRows([acc('a', { label: 'me@x.io' }), acc('b', { nickname: 'Work', label: 'w@x.io', firstSeen: Date.parse('2026-09-02T00:00:00Z') })], none, ['claude'], L as never, false)
    expect(rows.map(r => [r.title, r.sub])).toEqual([['me@x.io', 'Claude Code'], ['Work', 'Claude Code · w@x.io']])
    for (const r of rows) expect(r.sub.includes(r.title)).toBe(false)
  })
  test('the reserve row (id "") never becomes a row beside an identified account', () => {
    const rows = billingRows([acc('acc_1', { harness: 'codex', label: 'Conta padrão' }), acc('', { harness: 'codex', label: 'Conta padrão' })], none, ['codex'], L as never, true)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('Codex CLI')
    expect(rows[0]!.sub).toBe('')
  })
  test('an assistant with no identified account is one row on its own timeline; two unnamed accounts are numbered', () => {
    const rows = billingRows([acc('', { harness: 'gemini', label: 'Conta padrão' }), acc('k1', { harness: 'codex', label: 'Conta padrão' }), acc('k2', { harness: 'codex', label: 'Default account', firstSeen: Date.parse('2026-09-05T00:00:00Z') })], none, ['codex', 'gemini'], L as never, false)
    expect(rows.map(r => [r.key, r.title])).toEqual([['codex:k1', 'Codex CLI #1'], ['codex:k2', 'Codex CLI #2'], ['harness:gemini', 'Gemini CLI']])
    expect(rows[2]!.scope).toEqual({ kind: 'default', harness: 'gemini' })
    expect(rows[2]!.account).toBeNull()
    expect(rows[2]!.sub).toBe('account not reported')
  })
})

describe('planCoverageText', () => {
  const row = (mode: 'subscription' | 'api' | 'thirdparty' | 'unknown') => ({ plan: { mode }, problem: false })
  test('only known, sound current plans count; absent and unknown plans remain unset', () => {
    const rows = [row('subscription'), row('api'), row('unknown'), row('unknown'), { plan: null, problem: false }, { ...row('subscription'), problem: true }]
    expect(planCoverageText(rows, 'pt')).toBe('2 de 6 com plano informado · 4 sem informar')
    expect(planCoverageText(rows, 'en')).toBe('2 of 6 with a plan · 4 not set')
  })
  test('all plans set: omit the unset suffix', () => {
    const rows = Array.from({ length: 6 }, () => row('subscription'))
    expect(planCoverageText(rows, 'pt')).toBe('6 de 6 com plano informado')
    expect(planCoverageText(rows, 'en')).toBe('6 of 6 with a plan')
    expect(planCoverageText([row('thirdparty')], 'pt')).toBe('1 de 1 com plano informado')
  })
})

describe('closeBefore — the seam of a plan change', () => {
  test('the plan in force ends the day before its successor starts; others are untouched', () => {
    const a = { id: 'a', mode: 'subscription' as const, planId: 'anthropic-max-5x', price: { amount: 100, currency: 'USD' as const }, from: '2026-09-01' }
    const b = { ...a, id: 'b', from: '2026-05-01', to: '2026-08-31' }
    expect(closeBefore([a, b], 'a', '2026-10-17')).toEqual([{ ...a, to: '2026-10-16' }, b])
  })
  test('a seam before the old plan began is not applied', () => {
    const a = { id: 'a', mode: 'subscription' as const, planId: 'anthropic-pro', price: { amount: 20, currency: 'USD' as const }, from: '2026-09-01' }
    expect(closeBefore([a], 'a', '2026-08-01')).toEqual([a])
  })
})

describe('foldUnnamed — a sign-in the harness cannot name is not a second account', () => {
  const ph = (id: string, o: Partial<BillingAccount> = {}) => acc(id, { harness: 'gemini', label: 'Default account', key: `root:${id}`, ...o })
  const rows = (accounts: BillingAccount[], billing = none) =>
    billingRows(accounts, billing, ['gemini'], () => 'Gemini CLI', true)

  test('two unnamed accounts of one harness are ONE row, titled without a number', () => {
    const r = rows([ph('g1'), ph('g2', { firstSeen: Date.parse('2026-09-05T00:00:00Z') })])
    expect(r.map(x => x.key)).toEqual(['gemini:g1'])
    expect(r[0]!.title).toBe('Gemini CLI')
    expect(r[0]!.scope).toEqual({ kind: 'none', id: 'g1', harness: 'gemini' })
  })

  test('the kept row is the one carrying a plan of its own', () => {
    const billing: BillingSettings = { profiles: {}, accountProfiles: { g2: { periods: [{ id: 'p', mode: 'unknown', from: '2026-09-01' }] } } }
    expect(rows([ph('g1'), ph('g2')], billing).map(x => x.key)).toEqual(['gemini:g2'])
  })

  test('beside exactly one named account, the unnamed one folds into it', () => {
    const r = rows([ph('g1'), acc('g2', { harness: 'gemini', label: 'me@x.io' })])
    expect(r.map(x => x.key)).toEqual(['gemini:g2'])
  })

  test('beside two named accounts it stays its own row (no telling which it is)', () => {
    const r = rows([ph('g0'), acc('g1', { harness: 'gemini', label: 'a@x.io' }), acc('g2', { harness: 'gemini', label: 'b@x.io' })])
    expect(r).toHaveLength(3)
  })

  test('an unnamed account under a real identity key is not a fallback: never folded', () => {
    expect(foldUnnamed([ph('g1', { key: 'uuid-1' }), ph('g2', { key: 'uuid-2' })], none).map(a => a.id)).toEqual(['g1', 'g2'])
  })

  test('a nickname names an account; a single unnamed account is untouched', () => {
    expect(foldUnnamed([ph('g1', { nickname: 'Work' }), ph('g2')], none).map(a => a.id)).toEqual(['g1'])
    expect(foldUnnamed([ph('g1')], none).map(a => a.id)).toEqual(['g1'])
  })

  test('the folded duplicate raises no "which plan?" notice', () => {
    expect(accountsNeedingPlan([ph('g1'), ph('g2')], none, ['gemini']).map(a => a.id)).toEqual(['g1'])
  })

  test('the real shape: 8 registry rows for 6 accounts read as 6 rows', () => {
    const accounts = [
      acc('c', { label: 'z@x.io', nickname: 'Principal' }),
      acc('x', { harness: 'codex', label: 'ChatGPT 1a58', nickname: 'Principal' }),
      ph('g1'), ph('g2'),
      acc('p', { harness: 'copilot', label: 'blp' }),
      ph('a1', { harness: 'antigravity' }), ph('a2', { harness: 'antigravity' }),
      ph('k', { harness: 'kimi' }),
    ]
    const r = billingRows(accounts, none, ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi'], h => h, true)
    expect(r.map(x => x.key)).toEqual(['claude:c', 'codex:x', 'gemini:g1', 'copilot:p', 'antigravity:a1', 'kimi:k'])
  })
})

describe('planOptionsFor', () => {
  test('Codex lists only ChatGPT plans plus the "other" entries', () => {
    const ids = planOptionsFor('codex').map(p => p.id)
    expect(ids.some(id => id.startsWith('anthropic'))).toBe(false)
    expect(ids).toContain('other')
    expect(ids).toContain('api-payg')
  })
  test('a plan already chosen from elsewhere stays listed', () => {
    expect(planOptionsFor('codex', 'anthropic-pro').map(p => p.id)).toContain('anthropic-pro')
  })
})

describe('defaultStart', () => {
  test('no earlier plan: today', () => {
    expect(defaultStart([], '2026-10-17')).toBe('2026-10-17')
  })
  test('the day after the last earlier plan ended', () => {
    expect(defaultStart([
      { id: 'a', mode: 'unknown', from: '2026-09-01', to: '2026-09-30' },
      { id: 'b', mode: 'unknown', from: '2026-10-04', to: '2026-10-15' },
    ], '2026-10-17')).toBe('2026-10-16')
  })
  test('never a day in the future', () => {
    expect(defaultStart([{ id: 'a', mode: 'unknown', from: '2026-10-01', to: '2026-10-20' }], '2026-10-17')).toBe('2026-10-17')
  })
})


test('Codex billing never prints the generated ChatGPT id label, keeping real names and emails', () => {
  const make = (label: string, nickname?: string) => billingRows([
    acc('codex-id', { harness: 'codex', label, ...(nickname ? { nickname } : {}) }),
  ], none, ['codex'], () => 'Codex CLI', true)[0]!
  expect(make('ChatGPT 1a583a5f', 'Principal')).toMatchObject({ title: 'Principal', sub: 'Codex CLI' })
  expect(make('ChatGPT 1a583a5f')).toMatchObject({ title: 'Codex CLI', sub: '' })
  expect(make('person@example.com', 'Principal')).toMatchObject({ title: 'Principal', sub: 'Codex CLI · person@example.com' })
  expect(make('Jane Doe', 'Principal').sub).toBe('Codex CLI · Jane Doe')
  expect(make('Jane Doe').title).toBe('Jane Doe')
})

describe('limitsForRow', () => {
  const lim = (harness: string, mark: number) => ({ harness, account: 'default', updatedAt: mark, windows: [] }) as never
  test('two assistants on the default account each get their own limits', () => {
    const limits = [lim('claude', 1), lim('antigravity', 2)]
    const account = { id: 'default' } as never
    expect(limitsForRow(limits, { harness: 'antigravity', account })?.updatedAt).toBe(2)
    expect(limitsForRow(limits, { harness: 'claude', account })?.updatedAt).toBe(1)
    expect(limitsForRow(limits, { harness: 'codex', account })).toBeNull()
    expect(limitsForRow(limits, { harness: 'claude', account: null })).toBeNull()
  })
})

describe('billingRows — the title is never repeated in the subtitle', () => {
  test('two assistants whose only account is "default" are titled by the assistant and say nothing under it', () => {
    const rows = billingRows([acc('default', { harness: 'claude', label: 'Claude Code' }), acc('default', { harness: 'antigravity', label: 'Antigravity' })], none, ['claude', 'antigravity'], L as never, false)
    for (const r of rows) expect(r.sub === r.title || r.sub.split(' · ').includes(r.title)).toBe(false)
    expect(rows.map(r => r.key)).toEqual(['claude:default', 'antigravity:default'])
    expect(rows.map(r => r.harness)).toEqual(['claude', 'antigravity'])
  })
})

describe('accountProfiles — keyed harness:account', () => {
  const p1 = sub('anthropic-pro'), p2 = sub('anthropic-max-5x')
  const claude = acc('default', { harness: 'claude' }), agy = acc('default', { harness: 'antigravity' })
  test('two `default` accounts of different assistants keep separate own timelines', () => {
    let b = withAccountPeriods(none, claude, [p1])
    b = withAccountPeriods(b, agy, [p2])
    expect(Object.keys(b.accountProfiles ?? {}).sort()).toEqual(['antigravity:default', 'claude:default'])
    expect(ownPeriods(b, claude)).toEqual([p1])
    expect(ownPeriods(b, agy)).toEqual([p2])
    expect(rowScope(b, [claude], claude)).toEqual({ kind: 'own', id: 'default', harness: 'claude' })
    expect(withAccountPeriods(b, claude, []).accountProfiles?.['claude:default']).toBeUndefined()
    expect(ownPeriods(withAccountPeriods(b, claude, []), agy)).toEqual([p2])
  })
  test('a bare-id key written by an older build is still read, and replaced on the next write', () => {
    const legacy: BillingSettings = { profiles: {}, accountProfiles: { acc_1: { periods: [p1] } } }
    const a = acc('acc_1')
    expect(ownPeriods(legacy, a)).toEqual([p1])
    expect(Object.keys(withAccountPeriods(legacy, a, [p2]).accountProfiles ?? {})).toEqual(['claude:acc_1'])
  })
})

describe('config B — Antigravity and Claude both on `default`, plus a second Claude account', () => {
  const accounts = [
    acc('default', { harness: 'antigravity', label: 'Antigravity', firstSeen: 1 }),
    acc('default', { harness: 'claude', label: 'Claude Code', firstSeen: 2 }),
    acc('acc_claude00002', { harness: 'claude', label: 'Claude Code', firstSeen: 3 }),
  ]
  const names = (h: string) => ({ claude: 'Claude Code', antigravity: 'Antigravity' } as Record<string, string>)[h] ?? h
  test('two Claude accounts are told apart in Billing, Antigravity stays plain', () => {
    const rows = billingRows(accounts, none, ['claude', 'antigravity'], names as never, false)
    expect(rows.map(r => r.title)).toEqual(['Claude Code #1', 'Claude Code #2', 'Antigravity'])
    expect(rows.map(r => r.sub)).toEqual(['', '', ''])
  })
  test('the name the server already numbered wins, so every screen says the same thing', () => {
    const labels = { 'claude:default': 'Claude Code #2', 'claude:acc_claude00002': 'Claude Code #1' }
    const rows = billingRows(accounts, none, ['claude'], names as never, false, labels)
    expect(rows.map(r => r.title)).toEqual(['Claude Code #2', 'Claude Code #1'])
  })
  test('each row finds its own limits; Antigravity is not left "not reported"', () => {
    const lim = (harness: string, account: string) => ({ harness, account, updatedAt: 1, windows: [] }) as never
    const limits = [lim('claude', 'default'), lim('claude', 'acc_claude00002'), lim('antigravity', 'default')]
    const rows = billingRows(accounts, none, ['claude', 'antigravity'], names as never, false)
    expect(rows.map(r => limitsForRow(limits, r) !== null)).toEqual([true, true, true])
    expect(REPORTS_LIMITS.has('antigravity')).toBe(true)
  })
})

describe('a meter filed under a folded sign-in is the row\'s meter', () => {
  test('the unnamed fallback beside Antigravity\'s account is folded, and its reading still reaches the row', () => {
    const named = acc('default', { harness: 'antigravity', label: 'Antigravity', key: 'antigravity:default', firstSeen: 1 })
    const ghost = acc('acc_ghost', { harness: 'antigravity', label: 'Default account', key: 'root:abc', firstSeen: 2 })
    const rows = billingRows([named, ghost], none, ['antigravity'], (() => 'Antigravity') as never, false)
    expect(rows).toHaveLength(1)
    const lim = { harness: 'antigravity', account: 'acc_ghost', updatedAt: 1, windows: [] } as never
    expect(limitsForRow([lim], rows[0]!)).toBe(lim)
    expect(limitsForRow([{ ...(lim as object), harness: 'claude' } as never], rows[0]!)).toBeNull()
  })
})

describe('CONTA.SEM.PLANO — a prefilled plan is saved, and the row says it was detected', () => {
  const prefilled = { id: '', planId: 'anthropic-max-5x', label: '', amount: '100', currency: 'USD' as const, from: '2026-10-28', to: '', ongoing: true }
  test('Save on an untouched drawer prefilled from detection WRITES the plan', () => {
    // The drawer remembers what it opened with; a prefilled new period equals it, and Save used to close without writing.
    expect(planDraftWrites(prefilled, prefilled)).toBe(true)
  })
  test('a blank new period the user did not touch writes nothing (a nickname-only save stays possible)', () => {
    const blank = { ...prefilled, planId: '', amount: '' }
    expect(planDraftWrites(blank, blank)).toBe(false)
  })
  test('a stored period opened and left untouched writes nothing; an edited one does', () => {
    const stored = { ...prefilled, id: 'bp_1' }
    expect(planDraftWrites(stored, stored)).toBe(false)
    expect(planDraftWrites({ ...stored, amount: '200' }, stored)).toBe(true)
  })
  test('detectedPlanId: the account\'s own reported plan first, then a harness detection', () => {
    const a = { id: 'c1', harness: 'claude' as const, key: 'c1', label: 'x', root: null, available: true, plan: 'max_5x' }
    expect(detectedPlanId('claude', a, [])).toBe(matchDetectedPlan('claude', 'max_5x'))
    const det = [{ harness: 'claude' as const, mode: 'subscription' as const, planId: 'anthropic-pro', source: 'credentials' as const, evidenceEn: '', evidencePt: '', confidence: 'exact' as const, proposalOnly: true as const }]
    expect(detectedPlanId('claude', { ...a, plan: undefined }, det)).toBe('anthropic-pro')
    expect(detectedPlanId('claude', null, [{ ...det[0]!, source: 'none' as const }])).toBe('')
  })
})

describe('planAbsentText — the session card agrees with this screen', () => {
  test('OpenCode has no plan quota: never "has not reported yet"', () => {
    expect(planAbsentText('opencode', 'OpenCode', true)).toBe('Sem cota de plano no OpenCode — não há limites de plano a mostrar.')
    expect(planAbsentText('opencode', 'OpenCode', false)).toBe('No plan quota for OpenCode — there are no plan limits to show.')
  })
  test('a harness that reports limits is still waiting; one that never does says so', () => {
    expect(planAbsentText('claude', 'Claude Code', false)).toContain('has not reported plan limits yet')
    expect(planAbsentText('gemini', 'Gemini', false)).toBe('Gemini does not report plan limits.')
  })
})

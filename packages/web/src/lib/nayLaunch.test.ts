import { describe, expect, test } from 'bun:test'
import { accountChoices, effortOptions, launchSummary, modelOptions, normalizeChoice, withHarness } from './nayLaunch'
import type { HarnessAnswer } from './wizardSteps'

const H: HarnessAnswer[] = [
  { id: 'claude', label: 'Claude Code', modelSuggestions: ['opus'], models: [{ id: 'opus', label: 'Opus 5.5' }], supportsModel: true, efforts: ['low', 'high'] },
  { id: 'kimi', label: 'Kimi Code', modelSuggestions: [], models: [], supportsModel: false, efforts: [] },
  { id: 'codex', label: 'Codex', modelSuggestions: ['gpt-5.5'], models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], modelFreeText: true, supportsModel: true, efforts: [] },
]

describe('nay launch options', () => {
  test('only what the CLI accepts: no model picker without a model flag, no effort picker without efforts', () => {
    expect(modelOptions(H[1], false)).toBeNull()
    expect(effortOptions(H[2], false)).toBeNull()
    expect(modelOptions(H[0], true)!.map(o => o.value)).toEqual(['', 'opus'])
    expect(effortOptions(H[0], false)!.map(o => o.value)).toEqual(['', 'low', 'high'])
  })
  test('a typed id on a free-text CLI stays selectable', () => {
    expect(modelOptions(H[2], false, 'gpt-6')!.some(o => o.value === 'gpt-6')).toBe(true)
  })
  test('normalizing drops what does not belong to the harness, and falls back to Claude Code', () => {
    expect(normalizeChoice({ harness: 'gone', model: 'opus', effort: 'high' }, H)).toEqual({ harness: 'claude', model: 'opus', effort: 'high', account: '' })
    expect(normalizeChoice({ harness: 'kimi', model: 'opus', effort: 'high' }, H)).toEqual({ harness: 'kimi', model: '', effort: '', account: '' })
    expect(normalizeChoice({ harness: 'codex', model: 'gpt-6' }, H)).toEqual({ harness: 'codex', model: 'gpt-6', effort: '', account: '' })
  })
  test('changing the harness clears model and effort', () => {
    expect(withHarness({ harness: 'claude', model: 'opus', effort: 'high', account: 'a' }, 'codex')).toEqual({ harness: 'codex', model: '', effort: '', account: '' })
  })
  test('the header summary never implies a choice nobody made', () => {
    expect(launchSummary({ harness: 'claude', model: 'opus', effort: 'high' }, 'Claude Code', H[0], false)).toBe('Claude Code · Opus 5.5 · high')
    expect(launchSummary({ harness: 'claude' }, 'Claude Code', H[0], true)).toBe('Claude Code · modelo padrão')
    expect(launchSummary({ harness: 'kimi' }, 'Kimi Code', H[1], false)).toBe('Kimi Code')
  })
})

import { harnessOptions } from './nayLaunch'
test('the product name wins over the bare CLI label', () => {
  expect(harnessOptions([{ id: 'claude', label: 'claude', modelSuggestions: [], supportsModel: true, efforts: [] }], { claude: 'Claude Code' }))
    .toEqual([{ value: 'claude', label: 'Claude Code' }])
})

describe('account choices', () => {
  const now = 1_000_000
  const win = (usedPct: number) => ({ kind: 'week' as const, usedPct, resetsAt: now + 3_600_000 })
  const L = (account: string, usedPct: number, harness = 'claude') =>
    ({ harness, account, windows: [win(usedPct)], updatedAt: now, source: 'x' }) as never
  const limits = [L('a1', 38), L('a2', 91), L('o1', 10, 'codex')]
  test('lists only the harness\'s accounts, with the room left', () => {
    const r = accountChoices(limits, { 'claude:a1': 'Principal' }, 'claude', now)
    expect(r.accounts.map(a => [a.value, a.label, a.freePct, a.nearLimit])).toEqual([['a1', 'Principal', 62, false], ['a2', 'a2', 9, true]])
  })
  test('automatic is the one with most room', () => {
    const r = accountChoices(limits, { 'claude:a1': 'Principal' }, 'claude', now)
    expect(r.auto).toMatchObject({ value: '', label: 'Principal', freePct: 62 })
  })
  test('no known account = no field', () => {
    expect(accountChoices(limits, {}, 'gemini', now).auto).toBeNull()
    expect(accountChoices(null, {}, 'claude', now).accounts).toEqual([])
  })
})

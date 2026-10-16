import { describe, expect, test } from 'bun:test'
import type { PlanLimits } from '@agentistics/core'
import { accountKey, accountState, accountTitle, accountWhose, nextOpen, summarizeHarnesses, worstBars, type AccountRowData } from './accountsSummary'

const NOW = 1_000_000
const acc = (o: Partial<AccountRowData> & { id: string }): AccountRowData => ({
  harness: 'claude', key: o.id, label: 'x@y.z', root: null, available: true, ...o,
})
const lim = (harness: PlanLimits['harness'], account: string, five: number, week: number): PlanLimits => ({
  harness, account, updatedAt: NOW, source: 'claude-stream',
  windows: [
    { kind: '5h', usedPct: five, resetsAt: NOW + 3_600_000 },
    { kind: 'week', usedPct: week, resetsAt: NOW + 86_400_000 },
  ],
})

describe('summarizeHarnesses', () => {
  const accounts = [
    acc({ id: 'a1' }), acc({ id: 'a2', available: false }), acc({ id: 'a3', retired: true }),
    acc({ id: 'c1', harness: 'codex' }),
    acc({ id: 'g1', harness: 'gemini', label: 'Conta padrão' }),
  ]
  const limits = [lim('claude', 'a1', 20, 40), lim('claude', 'a2', 10, 90), lim('claude', 'a3', 99, 99), lim('codex', 'c1', 5, 5)]
  const out = summarizeHarnesses(accounts, limits, NOW, ['claude', 'codex', 'gemini', 'kimi'])

  test('counts accounts, agents-on and hidden; harnesses with none are absent', () => {
    expect(out.map(s => s.harness)).toEqual(['claude', 'codex', 'gemini'])
    const c = out[0]!
    expect([c.total, c.agentsOn, c.hidden, c.signedOut]).toEqual([3, 1, 1, 1])
  })
  test('worst bars are the highest 5h and the highest week among accounts still signed in', () => {
    const w = out[0]!.worst!.windows
    expect(w.find(x => x.kind === '5h')!.usedPct).toBe(20)
    expect(w.find(x => x.kind === 'week')!.usedPct).toBe(90)
  })
  test('crossed maxima: each window is picked independently, keeping its own reset', () => {
    const a = lim('claude', 'x', 95, 10)
    const b = lim('claude', 'y', 20, 94)
    b.windows[1]!.resetsAt = NOW + 5_000_000
    const w = worstBars([a, b], NOW)!.windows
    expect(w.map(x => [x.kind, x.usedPct])).toEqual([['5h', 95], ['week', 94]])
    expect(w.find(x => x.kind === 'week')!.resetsAt).toBe(NOW + 5_000_000)
    expect(worstBars([], NOW)).toBeNull()
  })
  test('no reported window means no bar, never a zero', () => {
    expect(out[2]!.worst).toBeNull()
  })
  test('state: signed-out account → needs-login; failed switch → error wins', () => {
    expect(out[0]!.state).toBe('needs-login')
    expect(out[1]!.state).toBe('ok')
    const failed = summarizeHarnesses(accounts, limits, NOW, ['claude'], new Set(['a1']))
    expect(failed[0]!.state).toBe('error')
    expect(failed[0]!.failed).toBe(1)
  })
  test('null limits (not loaded) yields no worst', () => {
    expect(summarizeHarnesses(accounts, null, NOW, ['claude'])[0]!.worst).toBeNull()
  })
})

describe('unidentified accounts (id "")', () => {
  const accounts = [acc({ id: '', harness: 'gemini', label: 'Conta padrão' }), acc({ id: '', harness: 'codex', label: 'Conta padrão' })]
  test('own presentation key, state "unconfirmed", never counted as signed in or agents-on', () => {
    expect(new Set(accounts.map(accountKey)).size).toBe(2)
    expect(accountState(accounts[0]!)).toBe('unconfirmed')
    const out = summarizeHarnesses(accounts, null, NOW, ['codex', 'gemini'])
    expect(out.map(s => [s.total, s.agentsOn, s.hidden, s.unconfirmed, s.state])).toEqual([[1, 0, 0, 1, 'unconfirmed'], [1, 0, 0, 1, 'unconfirmed']])
  })
  test('an identified account keeps its id as key; retired reads signed-out', () => {
    expect(accountKey(acc({ id: 'a1' }))).toBe('a1')
    expect(accountState(acc({ id: 'a1', retired: true }))).toBe('signed-out')
    expect(accountState(acc({ id: 'a1' }))).toBe('signed-in')
  })
})

describe('titles', () => {
  test('placeholder spellings in any case are no label and no nickname', () => {
    for (const p of ['Default account', 'default ACCOUNT', 'conta padrão', 'Conta Padrão']) {
      expect(accountTitle({ label: p }, 'Codex', false)).toBe('Codex account')
      expect(accountTitle({ nickname: p, label: 'a@b' }, 'Codex', false)).toBe('a@b')
      expect(accountWhose({ label: p }, false)).toContain('does not say')
    }
  })
  test('nickname → login → harness account, never a bare "Conta padrão"', () => {
    expect(accountTitle({ nickname: 'Freela', label: 'a@b' }, 'Gemini CLI', true)).toBe('Freela')
    expect(accountTitle({ label: 'a@b' }, 'Gemini CLI', true)).toBe('a@b')
    expect(accountTitle({ label: 'Conta padrão' }, 'Gemini CLI', true)).toBe('Conta do Gemini CLI')
    expect(accountTitle({ label: 'Conta padrão' }, 'Gemini CLI', false)).toBe('Gemini CLI account')
  })
  test('whose: login under a nickname; says so when the harness cannot tell', () => {
    expect(accountWhose({ nickname: 'Freela', label: 'a@b' }, false)).toBe('a@b')
    expect(accountWhose({ label: 'a@b' }, false)).toBeNull()
    expect(accountWhose({ label: 'Conta padrão' }, false)).toContain('does not say')
  })
})

describe('nextOpen', () => {
  test('one at a time; pressing the open one closes it', () => {
    expect(nextOpen(null, 'claude')).toBe('claude')
    expect(nextOpen('claude', 'codex')).toBe('codex')
    expect(nextOpen('codex', 'codex')).toBeNull()
  })
})

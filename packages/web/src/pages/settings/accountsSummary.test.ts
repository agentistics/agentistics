import { describe, expect, test } from 'bun:test'
import type { PlanLimits } from '@agentistics/core'
import { accountTitle, accountWhose, nextOpen, summarizeHarnesses, type AccountRowData } from './accountsSummary'

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
  test('worst bar is the highest window among accounts still signed in', () => {
    expect(out[0]!.worst?.account).toBe('a2')
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

describe('titles', () => {
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

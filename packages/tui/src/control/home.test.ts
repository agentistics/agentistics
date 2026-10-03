import { describe, expect, test } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import { ageOf, compactTokens, homeLayout, machineLine, money, resumeRows, statusGlyph, todayFigures } from './home'
import { taskRows } from './tabs/Tasks'
import type { ControlSession } from './types'

const meta = (id: string, start: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
  session_id: id, project_path: '/r', start_time: start, harness: 'claude', model: 'claude-sonnet-4-6',
  input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over,
} as SessionMeta)
const row = (id: string, state: ControlSession['state'], over: Partial<ControlSession> = {}): ControlSession =>
  ({ id, title: id, harness: 'claude', cwd: '/r', project: 'r', state, stateLabel: state, attached: false, actionable: true, ...over } as ControlSession)
const NOW = new Date('2026-10-03T15:00:00.000Z')

describe('home layout (GL-07 / D-TUI-10)', () => {
  test('108 columns: four cards; 80: two (resume, your tasks)', () => {
    expect(homeLayout(108)).toMatchObject({ narrow: false, cards: ['today', 'resume', 'tasks', 'providers'] })
    expect(homeLayout(108).cardWidth * 4 + 4).toBeLessThanOrEqual(108)
    expect(homeLayout(80)).toMatchObject({ narrow: true, cards: ['resume', 'tasks'] })
    expect(homeLayout(80).cardWidth * 2 + 2).toBeLessThanOrEqual(80)
  })
})

describe('today (HM-03)', () => {
  test('the UTC day, all four counters, live from the fleet, a streak ending today, 14 days of spark', () => {
    const sessions = [
      meta('a', '2026-10-03T01:00:00.000Z', { cache_read_input_tokens: 500 }),
      meta('b', '2026-10-02T23:30:00.000Z'),
      meta('c', '2026-10-01T10:00:00.000Z'),
      meta('old', '2026-09-20T10:00:00.000Z'),
    ]
    const f = todayFigures(sessions, [row('x', 'working'), row('y', 'closed')], NOW)
    expect(f.sessions).toBe(1)
    expect(f.tokens).toBe(1600)
    expect(f.costUSD).toBeGreaterThan(0)
    expect(f.live).toBe(1)
    expect(f.streak).toBe(3)
    expect(f.spark).toHaveLength(14)
    expect(f.spark.at(-1)).toBeCloseTo(f.costUSD!, 10)
  })
  test('N/A is never 0: no reported counter → tokens null; nothing today → cost null', () => {
    const f = todayFigures([meta('a', '2026-10-03T01:00:00.000Z', { input_tokens: undefined, output_tokens: undefined, cache_read_input_tokens: undefined, cache_creation_input_tokens: undefined })], [], NOW)
    expect(f.tokens).toBeNull()
    expect(todayFigures([], [], NOW)).toMatchObject({ costUSD: null, tokens: null, sessions: 0, streak: 0 })
    expect(money(null)).toBe('N/A')
    expect(compactTokens(null)).toBe('N/A')
  })
  test('a streak is not broken by a morning: today empty counts back from yesterday', () => {
    expect(todayFigures([meta('b', '2026-10-02T10:00:00.000Z'), meta('c', '2026-10-01T10:00:00.000Z')], [], NOW).streak).toBe(2)
  })
})

describe('resume (HM-04)', () => {
  test('live first, newest first; external and lost left out; a closed row only when it can reopen', () => {
    const now = NOW.getTime()
    const rows = resumeRows([
      row('ext', 'unknown', { startedAt: now }),
      row('old', 'closed', { endedAt: now - 5e6, resume: { sessionId: 's', title: 't' } }),
      row('gone', 'closed', { endedAt: now - 1e3 }),
      row('work', 'working', { startedAt: now - 9e6, task: 'Parser fix', cost: '$1.20' }),
      row('new', 'waiting', { startedAt: now - 6e4 }),
    ], now)
    expect(rows.map(r => r.id)).toEqual(['new', 'work', 'old'])
    expect(rows[1]).toMatchObject({ task: 'Parser fix', cost: '$1.20', age: '2h' })
  })
})

describe('resume merges the native sessions (HM-04)', () => {
  test('running fleet rows first, then native and closed rows by recency; a native row opens in code', () => {
    const now = NOW.getTime()
    const rows = resumeRows(
      [row('work', 'working', { startedAt: now - 9e6 }), row('old', 'closed', { endedAt: now - 7e6, resume: { sessionId: 's', title: 't' } })],
      now, 3,
      [{ sessionId: 'ses_a', title: 'Parser fix', task: 't-0539 Parser', updatedAt: new Date(now - 6e4).toISOString(), status: 'open' }],
    )
    expect(rows.map(r => [r.id, r.native])).toEqual([['work', false], ['ses_a', true], ['old', false]])
    expect(rows[1]).toMatchObject({ task: 't-0539 Parser', age: '1m', stateLabel: 'native · open' })
  })
})

describe('glyphs, ages, machine line', () => {
  test('status glyphs by the board vocabulary', () => {
    expect(statusGlyph('in_progress').glyph).toBe('◐')
    expect(statusGlyph('blocked').tone).toBe('warn')
    expect(statusGlyph('custom-status').glyph).toBe('○')
  })
  test('ageOf', () => {
    expect(ageOf(NOW.getTime() - 30e3, NOW.getTime())).toBe('now')
    expect(ageOf(NOW.getTime() - 3 * 864e5, NOW.getTime())).toBe('3d')
  })
  test('machine line', () => {
    expect(machineLine([row('a', 'working'), row('b', 'waiting-approval'), row('c', 'closed')])).toEqual({ others: 2, need: 1 })
  })
})

describe('tasks tab rows (TK-01)', () => {
  test('a heading per status in the order given, then its tasks', () => {
    const t = (id: string, status: string, statusLabel: string) => ({ id, ref: id, title: id, status, statusLabel })
    const rows = taskRows([t('a', 'in_progress', 'In progress'), t('b', 'in_progress', 'In progress'), t('c', 'todo', 'To do')])
    expect(rows.map(r => (r.kind === 'head' ? `#${r.label}:${r.count}` : r.task.id))).toEqual(['#In progress:2', 'a', 'b', '#To do:1', 'c'])
  })
})

import { describe, expect, test } from 'bun:test'
import { effectiveTimes, fmtActive } from './subtaskRollup'
import type { SubtaskView } from '../../lib/tasks'

const rollup = {} as SubtaskView['rollup']
const view = (times?: SubtaskView['times']): SubtaskView => ({ id: 's1', rollup, stats: null, ...(times ? { times } : {}) })
const sub = { id: 's1', startedAt: '2026-09-01T00:00:00Z', deliveredAt: '2026-09-01T01:00:00Z' }

describe('effectiveTimes', () => {
  test('the sessions\' times win over the subtask\'s status stamps', () => {
    const r = effectiveTimes([view({ startedAt: '2026-10-01T10:00:00Z', completedAt: null, durationMs: null, activeMinutes: 42, source: 'sessions' })], sub)
    expect(r).toEqual({ startedAt: '2026-10-01T10:00:00Z', activeMinutes: 42 })
  })
  test('a server that sends no times falls back to the stamps', () => {
    expect(effectiveTimes([view()], sub)).toEqual({ startedAt: sub.startedAt, completedAt: sub.deliveredAt, activeMinutes: null })
    expect(effectiveTimes([], sub).startedAt).toBe(sub.startedAt)
  })
  test('fmtActive in both languages', () => {
    expect(fmtActive(42, 'pt')).toBe('ativo 42min')
    expect(fmtActive(65, 'pt')).toBe('ativo 1h 5min')
    expect(fmtActive(65, 'en')).toBe('active 1h 5m')
    expect(fmtActive(120, 'en')).toBe('active 2h')
  })
})

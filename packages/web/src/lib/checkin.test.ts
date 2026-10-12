import { describe, expect, it } from 'bun:test'
import { buildCheckinPatch, CHECKIN_ITEMS, formatNextRun, formatSkipped } from './checkin'

describe('checkin helpers', () => {
  it('contains the six contract items', () => {
    expect(CHECKIN_ITEMS.map(item => item.id)).toEqual(['fleet', 'handbacks', 'limits', 'releases', 'mcp-configs', 'handoff'])
  })
  it('formats next run and pause state', () => {
    const now = Date.UTC(2026, 9, 11, 20, 0)
    expect(formatNextRun(now + 12 * 60_000, now)).toContain('em 12 min')
    expect(formatNextRun(null, now)).toBe('pausado')
  })

  it('formats skipped rounds in both languages', () => {
    const skipped = { count: 2, lastAt: new Date(2026, 0, 2, 3, 4).getTime() }
    expect(formatSkipped(skipped, true)).toContain('2 rodadas puladas (nada mudou)')
    expect(formatSkipped(skipped, false)).toContain('2 skipped rounds (nothing changed)')
  })
  it('builds a config patch without sharing checklist objects', () => {
    const current = { intervalMin: 30 as const, paused: null, checklist: [{ id: 'fleet' as const, enabled: true }] }
    const checklist = [{ id: 'fleet' as const, enabled: false }]
    const next = buildCheckinPatch(current, { checklist })
    expect(next).toEqual({ ...current, checklist })
    expect(next.checklist).not.toBe(checklist)
  })
})

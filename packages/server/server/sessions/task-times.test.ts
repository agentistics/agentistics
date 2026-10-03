import { describe, expect, test } from 'bun:test'
import { pieceTimes, spanOf, unionActiveMinutes } from './task-times'

const H = 3_600_000
const t0 = Date.parse('2026-10-01T10:00:00Z')
const sp = (startH: number, endH: number, activeMin: number | null) =>
  ({ startMs: t0 + startH * H, endMs: t0 + endH * H, activeMin })

describe('pieceTimes', () => {
  test('no session: the status stamps answer, duration from them, no active time', () => {
    const r = pieceTimes({ spans: [], done: true, statusStartedAt: '2026-10-01T10:00:00Z', statusDeliveredAt: '2026-10-01T12:00:00Z' })
    expect(r).toMatchObject({ startedAt: '2026-10-01T10:00:00Z', completedAt: '2026-10-01T12:00:00Z', durationMs: 2 * H, activeMinutes: null, source: 'status' })
  })
  test('nothing at all is null, never a zero', () => {
    expect(pieceTimes({ spans: [], done: false })).toEqual({ startedAt: null, completedAt: null, durationMs: null, activeMinutes: null, source: null })
  })
  test('a session wins over the status stamps', () => {
    const r = pieceTimes({
      spans: [sp(1, 3, 90)], done: true,
      statusStartedAt: '2026-09-01T00:00:00Z', statusDeliveredAt: '2026-09-02T00:00:00Z',
    })
    expect(r.source).toBe('sessions')
    expect(r.startedAt).toBe(new Date(t0 + H).toISOString())
    expect(r.completedAt).toBe(new Date(t0 + 3 * H).toISOString())
    expect(r.durationMs).toBe(2 * H)
  })
  test('a session linked later overrides retroactively (same inputs, one more span)', () => {
    const before = pieceTimes({ spans: [], done: true, statusStartedAt: '2026-10-01T00:00:00Z', statusDeliveredAt: '2026-10-01T01:00:00Z' })
    const after = pieceTimes({ spans: [sp(5, 6, 30)], done: true, statusStartedAt: '2026-10-01T00:00:00Z', statusDeliveredAt: '2026-10-01T01:00:00Z' })
    expect(before.source).toBe('status')
    expect(after.startedAt).toBe(new Date(t0 + 5 * H).toISOString())
  })
  test('reopen with a gap: wall duration spans the gap, active time does not', () => {
    const r = pieceTimes({ spans: [sp(0, 1, 50), sp(10, 11, 40)], done: true })
    expect(r.durationMs).toBe(11 * H)
    expect(r.activeMinutes).toBe(90)
  })
  test('overlapping sessions are not double counted', () => {
    const r = pieceTimes({ spans: [sp(0, 2, 100), sp(1, 3, 100)], done: true })
    expect(r.durationMs).toBe(3 * H)
    expect(r.activeMinutes).toBe(150)
    expect(r.activeMinutes!).toBeLessThanOrEqual(180)
  })
  test('not done: no completed and no duration, even with sessions', () => {
    const r = pieceTimes({ spans: [sp(0, 2, 60)], done: false })
    expect(r.startedAt).not.toBeNull()
    expect(r.completedAt).toBeNull()
    expect(r.durationMs).toBeNull()
    expect(r.activeMinutes).toBe(60)
  })
  test('status delivery is ignored while not done', () => {
    expect(pieceTimes({ spans: [], done: false, statusStartedAt: '2026-10-01T00:00:00Z', statusDeliveredAt: '2026-10-01T01:00:00Z' }).completedAt).toBeNull()
  })
  test('sessions that measured no active time give null, not 0', () => {
    expect(unionActiveMinutes([sp(0, 1, null)])).toBeNull()
  })
})

describe('spanOf', () => {
  test('prefers the meta, falls back to the row, refuses a span with no start', () => {
    expect(spanOf({ metaStart: '2026-10-01T10:00:00Z', metaEnd: '2026-10-01T11:00:00Z', activeMin: 30 })).toEqual({ startMs: t0, endMs: t0 + H, activeMin: 30 })
    expect(spanOf({ rowCreatedAt: '2026-10-01T10:00:00Z' })).toEqual({ startMs: t0, endMs: t0, activeMin: null })
    expect(spanOf({})).toBeNull()
  })
})

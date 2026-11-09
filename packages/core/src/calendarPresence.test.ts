import { describe, expect, test } from 'bun:test'
import { brtDay, brtDayStartMs, filterCalendar, pieceOnDay, piecePresence, type CalPiece, type CalendarReply } from './deliveryCalendar'

const NOW = Date.parse('2026-11-09T15:00:00.000Z') // Mon 09, 12:00 BRT
const H = 3600_000, D = 24 * H

const piece = (o: Partial<CalPiece> & { key: string }): CalPiece => ({
  taskId: 't', taskTitle: 'T', subtaskId: null, title: o.key, stage: 'running', version: null, harness: null, model: null, priority: null,
  active: true, startedAtMs: null, stageSinceMs: null, trail: [], stageEta: { kind: 'none', reason: null }, publishEta: { kind: 'none', reason: null },
  publishedAtMs: null, dueDate: null, confirmed: false, late: false, ...o,
})
const days = (p: CalPiece) => {
  const out: string[] = []
  for (let d = brtDay(NOW - 30 * D); d <= brtDay(NOW + 3 * D); d = brtDay(brtDayStartMs(d) + 36 * H)) if (pieceOnDay(p, d, NOW)) out.push(d)
  return out
}

describe('one rule for "what is on this day"', () => {
  test('an open piece with no ETA is on the days it had real activity, not on every day since it started', () => {
    const p = piece({ key: 'a', startedAtMs: NOW - 20 * D, stageSinceMs: NOW - 10 * D })
    expect(days(p)).toEqual([brtDay(NOW - 20 * D), brtDay(NOW - 10 * D)])
  })
  test('today counts only with activity in the last 24h', () => {
    expect(pieceOnDay(piece({ key: 'a', startedAtMs: NOW - 20 * D, stageSinceMs: NOW - 30 * H }), brtDay(NOW), NOW)).toBe(false)
    expect(pieceOnDay(piece({ key: 'a', startedAtMs: NOW - 20 * D, stageSinceMs: NOW - 2 * H }), brtDay(NOW), NOW)).toBe(true)
  })
  test('a past ETA does not stretch the piece either', () => {
    const p = piece({ key: 'a', startedAtMs: NOW - 20 * D, stageSinceMs: NOW - 10 * D, publishEta: { kind: 'estimate', atMs: NOW - 5 * D, confidence: 'low' } })
    expect(pieceOnDay(p, brtDay(NOW - 7 * D), NOW)).toBe(false)
    expect(pieceOnDay(p, brtDay(NOW - 10 * D), NOW)).toBe(true)
  })
  test('a future ETA keeps the whole start-to-ETA period', () => {
    const p = piece({ key: 'a', startedAtMs: NOW - 5 * D, stageSinceMs: NOW - 5 * D, publishEta: { kind: 'estimate', atMs: NOW + 2 * D, confidence: 'high' } })
    expect(pieceOnDay(p, brtDay(NOW - 3 * D), NOW)).toBe(true)
    expect(pieceOnDay(p, brtDay(NOW + 2 * D), NOW)).toBe(true)
    expect(pieceOnDay(p, brtDay(NOW + 3 * D), NOW)).toBe(false)
  })
  test('a published piece covers start to publication', () => {
    const p = piece({ key: 'a', stage: 'published', startedAtMs: NOW - 4 * D, publishedAtMs: NOW - 2 * D })
    expect(days(p)).toEqual([brtDay(NOW - 4 * D), brtDay(NOW - 3 * D), brtDay(NOW - 2 * D)])
  })
  test('no activity data and no ETA: the piece is never extended', () => {
    expect(piecePresence(piece({ key: 'a' }), NOW)).toEqual([])
    expect(days(piece({ key: 'a' }))).toEqual([])
  })
  test('the API window and the screen use the same function', () => {
    const ps = [
      piece({ key: 'a', startedAtMs: NOW - 20 * D, stageSinceMs: NOW - 10 * D }),
      piece({ key: 'b', startedAtMs: NOW - 1 * D, stageSinceMs: NOW - 1 * H }),
      piece({ key: 'c', startedAtMs: NOW - 20 * D, stageSinceMs: NOW - 9 * D }),
    ]
    const reply = { nowMs: NOW, pieces: ps, versions: [], marks: [] } as unknown as CalendarReply
    for (const d of [brtDay(NOW - 20 * D), brtDay(NOW - 10 * D), brtDay(NOW - 9 * D), brtDay(NOW - 1 * D), brtDay(NOW)]) {
      const win = filterCalendar(reply, { fromMs: brtDayStartMs(d), toMs: brtDayStartMs(d) + D - 1 }).pieces.map(p => p.key)
      expect(win).toEqual(ps.filter(p => pieceOnDay(p, d, NOW)).map(p => p.key))
    }
  })
})

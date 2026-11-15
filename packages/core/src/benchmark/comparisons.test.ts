import { describe, expect, test } from 'bun:test'
import { buildComparisons, COMPARISON_SIDES, GROUP_MIN, taskSides } from './comparisons'
import type { HistorySubtaskRow } from './history'

const H = 3_600_000
const sub = (id: string, o: Partial<HistorySubtaskRow> = {}): HistorySubtaskRow => ({
  id, title: id, status: 'done', size: 'M', sessions: 2, costUSD: 4, costPartial: false, wallMs: 2 * H, activeMs: null, qaRounds: 1, reworked: false, lines: 200, ...o,
})
const many = (n: number, f: (i: number) => HistorySubtaskRow) => Array.from({ length: n }, (_, i) => f(i))

describe('server-side comparisons (one source for HTTP, MCP and the screen)', () => {
  const subs = [
    ...many(4, i => sub(`o${i}`, { qaRounds: 1, costUSD: 2, wallMs: H, sessions: 1 })),
    ...many(4, i => sub(`m${i}`, { qaRounds: 3, reworked: true, costUSD: 5, wallMs: 4 * H, sessions: 5 })),
  ]

  test('two comparisons keyed qa and sessions (never "id": the MCP strips ids), with n, ratios and per-size pairs', () => {
    expect(GROUP_MIN).toBe(3)
    const c = buildComparisons(subs)
    expect(c.map(x => x.key)).toEqual(['qa', 'sessions'])
    const qa = c[0]!
    expect([qa.nA, qa.nB, qa.cost!.ratio, qa.wall!.ratio]).toEqual([4, 4, 2.5, 4])
    expect(qa.cost!.sizes).toEqual([{ size: 'M', medA: 2, medB: 5, ratio: 2.5, nA: 4, nB: 4 }])
    expect(qa.third).toMatchObject({ kind: 'sessions' })
    expect(c[1]!.third).toMatchObject({ kind: 'rework', rateA: 0, rateB: 1 })
  })

  test('every per-size pair gives its own ratio, and with one size that is the headline multiplier', () => {
    const qa = buildComparisons(subs)[0]!
    const p = qa.cost!.sizes[0]!
    expect(p.ratio).toBe(qa.cost!.ratio)
  })

  test('the second comparison is 1 session x 5+: a 4-session piece is NOT in the "5+" side', () => {
    const four = [
      ...many(4, i => sub(`o${i}`, { sessions: 1, costUSD: 2 })),
      ...many(4, i => sub(`f${i}`, { sessions: 4, costUSD: 50 })),
    ]
    expect(buildComparisons(four).find(x => x.key === 'sessions')).toBeUndefined()
    const five = [...many(4, i => sub(`o${i}`, { sessions: 1, costUSD: 2 })), ...many(4, i => sub(`f${i}`, { sessions: 5, costUSD: 50 }))]
    const s = buildComparisons(five).find(x => x.key === 'sessions')!
    expect([s.nA, s.nB, s.cost!.ratio]).toEqual([4, 4, 25])
  })

  test('a side with fewer than 3 pieces of a size is not compared; nothing comparable = no comparison', () => {
    expect(buildComparisons([...many(2, i => sub(`o${i}`, { qaRounds: 1 })), ...many(2, i => sub(`m${i}`, { qaRounds: 3, reworked: true }))])).toEqual([])
  })

  test('pieces with no duration (wallMs null) stay out of the time ratio and its n', () => {
    const withZero = [...subs, ...many(5, i => sub(`z${i}`, { qaRounds: 1, sessions: 1, wallMs: null, costUSD: 2 }))]
    const qa = buildComparisons(withZero)[0]!
    expect(qa.wall!.sizes[0]!.nA).toBe(4)          // the 5 unmeasured ones are not counted as 0 min
    expect(qa.wall!.ratio).toBe(4)
    expect(qa.cost!.sizes[0]!.nA).toBe(9)          // but they do have a cost
  })
})

describe('taskSides: one task as the prototype\'s "um → outro"', () => {
  test('the QA sides: median piece of 1 round against 2+ rounds, per column; defects and acceptance are not recorded', () => {
    const t = taskSides([
      sub('a', { qaRounds: 1, costUSD: 2, sessions: 1, wallMs: H }), sub('b', { qaRounds: 1, costUSD: 4, sessions: 3, wallMs: 3 * H }),
      sub('c', { qaRounds: 3, costUSD: 9, sessions: 6, wallMs: null, costPartial: true }),
    ], 'qa')
    expect(t.nA).toBe(2); expect(t.nB).toBe(1)
    expect(t.sessions).toEqual([2, 6]); expect(t.costUSD).toEqual([3, 9]); expect(t.qaRounds).toEqual([1, 3])
    expect(t.wallMs).toEqual([2 * H, null])            // a side with nothing measured is null, never 0
    expect(t.costPartial).toEqual([false, true])
    expect(t.defects).toEqual([null, null]); expect(t.accepted).toEqual([null, null])
  })
  test('a side with no piece is null on every column; the sessions sides are 1 and 5+', () => {
    const t = taskSides([sub('a', { sessions: 1 }), sub('b', { sessions: 2 })], 'sessions')
    expect(t.nA).toBe(1); expect(t.nB).toBe(0)
    expect(t.sessions).toEqual([1, null]); expect(t.costUSD[1]).toBeNull()
  })
  test('buildComparisons and taskSides share one definition of the sides', () => {
    expect(COMPARISON_SIDES.qa.b(sub('x', { qaRounds: 2 }))).toBe(true)
    expect(COMPARISON_SIDES.qa.a(sub('x', { qaRounds: null }))).toBe(false)
  })
})

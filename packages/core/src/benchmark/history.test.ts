import { describe, expect, test } from 'bun:test'
import { BUCKETS, SIZE_LINES, buildHistory, qaRoundsFromLabels, sizeOfLines, type HistoryPieceInput } from './history'

const H = 3_600_000
const piece = (id: string, taskId: string, o: Partial<HistoryPieceInput> = {}): HistoryPieceInput => ({
  id, taskId, title: `piece ${id}`, status: 'done',
  sessions: [{ id: `${id}-s1`, harness: 'claude', costUSD: 2 }], lines: 50, startMs: 0, endMs: 2 * H, qaRounds: 1, activeMs: H / 2, ...o,
})
const tasks = [{ id: 'T1', title: 'Task one' }, { id: 'T2', title: 'Task two' }]

describe('size by lines (ANALISE: small < 100, large >= 500)', () => {
  test('thresholds', () => {
    expect(SIZE_LINES).toEqual({ mediumFrom: 100, largeFrom: 500 })
    expect([0, 99, 100, 499, 500, 18000].map(sizeOfLines)).toEqual(['S', 'S', 'M', 'M', 'L', 'L'])
    expect(sizeOfLines(null)).toBeNull()
  })
})

describe('buildHistory — pieces, tasks, buckets, coverage', () => {
  const pieces = [
    piece('a', 'T1'),
    piece('b', 'T1', { sessions: [{ id: 'b1', harness: 'claude', costUSD: 4 }, { id: 'b2', harness: 'codex', costUSD: null }], qaRounds: 3, lines: 600 }),
    piece('c', 'T2', { sessions: [{ id: 'c1', harness: 'codex', costUSD: null }], qaRounds: null, activeMs: null, lines: null }),
    piece('d', 'T2', { status: 'in_progress' }),                 // not delivered: not a piece
    piece('e', 'T2', { sessions: [] }),                          // no linked session: not a piece
  ]
  const h = buildHistory({ pieces, tasks })

  test('only done / in_review pieces WITH a linked session count', () => {
    expect(h.pieces).toBe(3)
    expect(h.tasks.map(t => t.id).sort()).toEqual(['T1', 'T2'])
  })

  test('a task row sums its pieces and lists the subtasks with both time and cost', () => {
    const t1 = h.tasks.find(t => t.id === 'T1')!
    expect(t1.title).toBe('Task one')
    expect(t1.pieces).toBe(2)
    expect(t1.sessions).toBe(3)
    expect(t1.costUSD).toBe(6)                  // priced sessions only: 2 + 4, never a share of an unpriced one
    expect(t1.costPartial).toBe(true)           // piece b has an unpriced codex session
    expect(t1.size).toBe('L')                   // 650 lines
    expect(t1.qaRounds).toBe(4)
    expect(t1.subtasks.map(s => s.id)).toEqual(['a', 'b'])
    const b = t1.subtasks[1]!
    expect([b.costUSD, b.costPartial, b.qaRounds, b.reworked, b.size, b.sessions]).toEqual([4, true, 3, true, 'L', 2])
    expect(b.wallMs).toBe(2 * H)
  })

  test('what could not be measured is null, never zero', () => {
    const c = h.tasks.find(t => t.id === 'T2')!.subtasks[0]!
    expect([c.costUSD, c.qaRounds, c.reworked, c.activeMs, c.size]).toEqual([null, null, null, null, null])
    expect(c.costPartial).toBe(false)
    expect(h.tasks.find(t => t.id === 'T2')!.costUSD).toBeNull()
  })

  test('buckets by sessions per piece: 1, 2–3, 4–6, 7+, with median cost, median time and rework rate', () => {
    expect(BUCKETS.map(b => b.label)).toEqual(['1', '2-3', '4-6', '7+'])
    const many = [
      ...pieces,
      piece('f', 'T3', { sessions: Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, harness: 'claude', costUSD: 1 })), qaRounds: 1, endMs: 10 * H }),
      piece('g', 'T3', { sessions: Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, harness: 'claude', costUSD: 3 })), qaRounds: 2, endMs: 20 * H }),
    ]
    const r = buildHistory({ pieces: many, tasks: [...tasks, { id: 'T3', title: 'T3' }] })
    const by = Object.fromEntries(r.buckets.map(b => [b.label, b]))
    expect(by['1']!.pieces).toBe(2)                         // a, c
    expect(by['1']!.costMedianUSD).toBe(2)                  // only a is priced
    expect(by['1']!.nCost).toBe(1)
    expect(by['2-3']!.pieces).toBe(1)                       // b
    expect(by['2-3']!.reworkRate).toBe(1)                   // b has 3 QA rounds
    expect(by['4-6']!.pieces).toBe(1)
    expect(by['4-6']!.wallMedianMs).toBe(10 * H)
    expect(by['4-6']!.reworkRate).toBe(0)
    expect(by['7+']!.reworkRate).toBe(1)
    expect(by['1']!.nRework).toBe(1)                        // c has no QA record
  })

  test('coverage says how much of the pieces carry data and which harnesses have no cost', () => {
    expect(h.coverage.pieces).toBe(3)
    expect(h.coverage.withCost).toBe(2)
    expect(h.coverage.withQa).toBe(2)
    expect(h.coverage.harnessesWithoutCost).toEqual(['codex'])
    expect(h.coverage.pctWithCost).toBeCloseTo(66.7, 1)
  })

  test('a period keeps only pieces that ended inside it', () => {
    const r = buildHistory({ pieces, tasks, filters: { fromMs: 3 * H, toMs: 9 * H } })
    expect(r.pieces).toBe(0)
    expect(buildHistory({ pieces, tasks, filters: { fromMs: 0, toMs: 3 * H } }).pieces).toBe(3)
  })

  test('nothing in, nothing invented', () => {
    const r = buildHistory({ pieces: [], tasks: [] })
    expect(r.pieces).toBe(0)
    expect(r.tasks).toEqual([])
    expect(r.buckets.every(b => b.pieces === 0 && b.costMedianUSD === null && b.reworkRate === null)).toBe(true)
    expect(r.coverage.pctWithCost).toBeNull()
  })
})

describe('QA rounds read from the labels of the QA sessions (indicative: the flow records no structured verdict)', () => {
  test('no QA-labelled session means unknown, not zero', () => {
    expect(qaRoundsFromLabels([])).toBeNull()
    expect(qaRoundsFromLabels(['ALM.QAFIX1 · PT + componentes (Sonnet)', 'Implementar parser'])).toBeNull()
  })
  test('one round per QA session, or the highest round a label states', () => {
    expect(qaRoundsFromLabels(['QA · Agentask novo (Codex)'])).toBe(1)
    expect(qaRoundsFromLabels(['QA · Agentask novo (Codex)', 'QA · Agentask novo (Gemini)'])).toBe(2)
    expect(qaRoundsFromLabels(['QA v2.103.2 · rodada 3 (Copilot)'])).toBe(3)
    expect(qaRoundsFromLabels(['QUAL.6 · re-QA r2 Agentask A (Copilot)'])).toBe(2)
    expect(qaRoundsFromLabels(['QA2 · Agentask proposta A (Codex)'])).toBe(2)
  })
})

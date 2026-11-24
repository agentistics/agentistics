import { describe, expect, test } from 'bun:test'
import { BUCKETS, SIZE_LINES, buildHistory, modelFamily, qaRoundsFromLabels, reviewRoundsFromHistory, sizeOfLines, type HistoryPieceInput } from './history'

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

  test('buckets by sessions per piece, as in the approved prototype: 1, 2, 3–4, 5+ (median cost, median time, rework rate)', () => {
    expect(BUCKETS.map(b => b.label)).toEqual(['1', '2', '3-4', '5+'])
    const ss = (p: string, n: number, c: number) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, harness: 'claude', costUSD: c }))
    const many = [
      ...pieces,
      piece('f', 'T3', { sessions: ss('f', 4, 1), qaRounds: 1, endMs: 10 * H }),
      piece('f3', 'T3', { sessions: ss('h', 3, 1), qaRounds: 1, endMs: 6 * H }),
      piece('g', 'T3', { sessions: ss('g', 5, 3), qaRounds: 2, endMs: 20 * H }),
    ]
    const r = buildHistory({ pieces: many, tasks: [...tasks, { id: 'T3', title: 'T3' }] })
    const by = Object.fromEntries(r.buckets.map(b => [b.label, b]))
    expect(by['1']!.pieces).toBe(2)                         // a, c
    expect(by['1']!.costMedianUSD).toBe(2)                  // only a is priced
    expect(by['1']!.nCost).toBe(1)
    expect(by['2']!.pieces).toBe(1)                         // b
    expect(by['2']!.reworkRate).toBe(1)                     // b has 3 QA rounds
    expect(by['3-4']!.pieces).toBe(2)                       // 3 and 4 sessions
    expect(by['3-4']!.wallMedianMs).toBe(8 * H)
    expect(by['3-4']!.reworkRate).toBe(0)
    expect(by['5+']!.pieces).toBe(1)                        // exactly 5 sessions is already "5+"
    expect(by['5+']!.reworkRate).toBe(1)
    expect(by['1']!.nRework).toBe(1)                        // c has no QA record
  })

  test('a piece whose start equals its delivery has NO duration: null, out of every time median, counted in the coverage', () => {
    const z = piece('z', 'T1', { startMs: 5 * H, endMs: 5 * H })
    const real = [piece('r1', 'T1'), piece('r2', 'T1'), piece('r3', 'T1')]
    const r = buildHistory({ pieces: [...real, z], tasks })
    expect(r.tasks[0]!.subtasks.find(s => s.id === 'z')!.wallMs).toBeNull()
    expect(r.buckets.find(b => b.label === '1')!.wallMedianMs).toBe(2 * H)    // would be 2h either way with 3 reals; n tells it
    expect(r.buckets.find(b => b.label === '1')!.nWall).toBe(3)
    expect(r.coverage.withWall).toBe(3)
    expect(r.coverage.withoutDuration).toBe(1)
    // a piece with no delivery instant yet is "not finished", a different fact: it is not counted as "no duration"
    const open = buildHistory({ pieces: [...real, piece('u', 'T1', { status: 'in_review', endMs: null })], tasks })
    expect(open.coverage.withoutDuration).toBe(0)
    expect(open.coverage.withWall).toBe(3)
    // a task made only of such pieces has no wall time at all, not "0 min"
    expect(buildHistory({ pieces: [z], tasks }).tasks[0]!.wallMs).toBeNull()
    // and a task's span ignores the zero-length piece's instants
    expect(r.tasks[0]!.wallMs).toBe(2 * H)
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

describe('BENCHMARK.LACUNAS — model, harness, acceptance, the task as a whole', () => {
  test('modelFamily names only the families it knows', () => {
    expect(['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'gpt-6.1-sol', null].map(modelFamily)).toEqual(['opus', 'sonnet', 'haiku', null, null])
  })
  test('a piece takes the model and harness of its author, never of the leader or QA', () => {
    const h = buildHistory({ pieces: [piece('a', 'T1', { sessions: [
      { id: 'l', harness: 'claude', costUSD: 50, model: 'claude-opus-5-5', role: 'leader' },
      { id: 'w', harness: 'codex', costUSD: 1, model: 'claude-sonnet-5', role: 'worker' },
      { id: 'q', harness: 'claude', costUSD: 30, model: 'claude-opus-5-5', role: 'qa' },
    ] })], tasks })
    expect(h.tasks[0]!.subtasks[0]).toMatchObject({ model: 'sonnet', harness: 'codex' })
  })
  test('accepted follows the owner: done is validated, in_review is not yet (null)', () => {
    const h = buildHistory({ pieces: [piece('a', 'T1'), piece('b', 'T1', { status: 'in_review' })], tasks })
    expect(h.tasks[0]!.subtasks.map(s => s.accepted)).toEqual([true, null])
  })
  test('the task overall is the median over ALL pieces, even when no comparison side has one (2-4 sessions)', () => {
    const three = (id: string, cost: number) => piece(id, 'T1', { sessions: [1, 2, 3].map(n => ({ id: `${id}${n}`, harness: 'claude', costUSD: cost / 3 })) })
    const h = buildHistory({ pieces: [three('a', 3), three('b', 9)], tasks })
    const t = h.tasks[0]!
    expect(t.sides.sessions.costUSD).toEqual([null, null])
    expect(t.overall).toMatchObject({ pieces: 2, sessions: 3, costUSD: 6, wallMs: 2 * H })
  })
  test('review rounds come from the phase history: each entry into review is a round; none = unknown', () => {
    expect(reviewRoundsFromHistory([{ to: 'revisao_lider' }, { to: 'ajuste' }, { to: 'revisao_lider' }, { to: 'ci' }])).toBe(2)
    expect(reviewRoundsFromHistory([{ to: 'executando' }])).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'
import { brtDay, buildCalendar, filterCalendar, type CalPiece, type CalVersion } from '@agentistics/core'
import {
  startedPiecesOfDay, addDays, addMonths, agendaOf, byPriority, dayBlocks, fitWeek, monthCells, pieceSegments, rangeLabel, stepAnchor, versionDays,
  weekDays, weekRibbons, weekdayMon0, packIntervals, swipeDay, placeColumn,
} from './calendarModel'

describe('placeColumn (thin phone columns: one full-width card, overlaps become a +N chip)', () => {
  const MIN = 60_000
  const ev = (id: string, fromMin: number, durMin: number) => ({ id, fromMs: fromMin * MIN, toMs: (fromMin + durMin) * MIN })
  test('separate events each keep a card and say nothing more', () => {
    const out = placeColumn([ev('a', 600, 60), ev('b', 720, 60)], 0)
    expect(out.map(i => i.kind)).toEqual(['card', 'card'])
    expect(out.every(i => i.kind === 'card' && i.hidden === 0)).toBe(true)
  })
  test('overlapping events show the first card and ONE chip below it counting the rest', () => {
    const out = placeColumn([ev('a', 600, 90), ev('b', 620, 30), ev('c', 640, 30)], 0)
    expect(out.map(i => i.kind)).toEqual(['card', 'chip'])
    const [card, chip] = out
    expect(card).toMatchObject({ id: 'a', top: 600, height: 90, hidden: 2 })
    expect(chip).toMatchObject({ top: 690, height: 44, count: 2 })
  })
  test('short events never produce a target under 44px, and ones inside its footprint are hidden', () => {
    const out = placeColumn([ev('a', 600, 5), ev('b', 610, 5), ev('c', 660, 5), ev('d', 700, 5)], 0)
    for (const i of out) expect(i.height).toBeGreaterThanOrEqual(44)
    expect(out.map(i => i.kind)).toEqual(['card', 'chip', 'card'])
    expect(out[1]).toMatchObject({ kind: 'chip', count: 2 }) // b (610) and c (660, inside the chip's 644..688)
    expect(out[2]).toMatchObject({ kind: 'card', id: 'd' })
  })
  test('no two targets of a column overlap', () => {
    const out = placeColumn(Array.from({ length: 12 }, (_, i) => ev(`e${i}`, i * 17, 25)), 0)
    for (let i = 1; i < out.length; i++) expect(out[i]!.top).toBeGreaterThanOrEqual(out[i - 1]!.top + out[i - 1]!.height)
  })
})

const NOW = Date.parse('2026-11-07T18:40:00.000Z') // Sat 07/11 15h40 BRT
const H = 3600_000
const piece = (o: Partial<CalPiece> & { key: string }): CalPiece => ({
  taskId: 't', taskTitle: 'T', subtaskId: 's', title: o.key, stage: 'qa', version: '2.202.0', harness: 'claude', model: null, priority: 'high',
  active: true, startedAtMs: NOW - 4 * H, stageSinceMs: NOW - H, trail: [], stageEta: { kind: 'none', reason: null }, publishEta: { kind: 'none', reason: null },
  publishedAtMs: null, dueDate: null, confirmed: false, late: false, ...o,
})
const version = (o: Partial<CalVersion> & { version: string }): CalVersion => ({ state: 'planned', atMs: null, basis: 'none', confidence: null, pieceKeys: [], stageCounts: {}, ...o })

test('phone swipes ignore vertical gestures and cross month/year boundaries by calendar days', () => {
  expect(swipeDay('2026-12-31', -80, 10, 1)).toBe('2027-01-01')
  expect(swipeDay('2026-12-31', -80, 10, 7)).toBe('2027-01-07')
  expect(swipeDay('2026-12-31', 80, 100, 7)).toBe('2026-12-31')
  expect(swipeDay('2026-12-31', 10, 0, 1)).toBe('2026-12-31')
})

test('phone overlapping intervals share columns only in their connected group', () => {
  const packed = packIntervals([{ fromMs: 0, toMs: 10 }, { fromMs: 5, toMs: 15 }, { fromMs: 10, toMs: 20 }, { fromMs: 20, toMs: 30 }])
  expect(packed.map(e => [e.lane, e.lanes])).toEqual([[0, 2], [1, 2], [0, 2], [0, 1]])
  expect(packIntervals([])).toEqual([])
})

describe('day arithmetic', () => {
  test('Monday-first weeks: 2026-11-07 is a Saturday (5)', () => {
    expect(weekdayMon0('2026-11-07')).toBe(5)
    expect(weekDays('2026-11-07')[0]).toBe('2026-11-02')
    expect(weekDays('2026-11-07')[6]).toBe('2026-11-08')
  })
  test('month grid is 42 cells starting on a Monday, flagging the days outside the month', () => {
    const c = monthCells('2026-11-15')
    expect(c).toHaveLength(42)
    expect(c[0]).toEqual({ day: '2026-10-26', inMonth: false })
    expect(c.filter(x => x.inMonth)).toHaveLength(30)
  })
  test('month steps clamp the day (31 Jan + 1 month = 28 Feb)', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(stepAnchor('week', '2026-11-07', 1)).toBe('2026-11-14')
    expect(stepAnchor('month', '2026-11-07', -1)).toBe('2026-10-07')
  })
  test('labels in both languages', () => {
    expect(rangeLabel('month', '2026-11-07', true)).toBe('novembro de 2026')
    expect(rangeLabel('month', '2026-11-07', false)).toBe('November 2026')
    expect(rangeLabel('week', '2026-11-07', true)).toBe('2 – 8 de novembro')
    expect(rangeLabel('schedule', '2026-11-07', true)).toBe('Sáb 07 – Dom 08')
    expect(rangeLabel('day', '2026-11-07', true)).toBe('Sábado, 7 de novembro')
  })
})

describe('ribbons', () => {
  const today = '2026-11-07'
  test('a published version is a one-day ribbon on its BRT day', () => {
    const v = version({ version: '2.201.1', state: 'published', atMs: Date.parse('2026-11-07T17:12:00.000Z'), basis: 'published' })
    expect(versionDays(v, [], today)).toEqual({ start: '2026-11-07', end: '2026-11-07' })
  })
  test('a planned version runs from where its work began to the expected day; a late-night UTC hour stays on the BRT day', () => {
    const p = piece({ key: 'a', startedAtMs: Date.parse('2026-11-05T15:00:00.000Z') })
    const v = version({ version: '2.202.0', atMs: Date.parse('2026-11-09T02:30:00.000Z'), basis: 'estimate', pieceKeys: ['a'] })
    expect(versionDays(v, [p], today)).toEqual({ start: '2026-11-05', end: '2026-11-08' })
  })
  test('no estimate = a single marker on today, never a made-up date', () => {
    expect(versionDays(version({ version: '2.204.0' }), [], today)).toEqual({ start: today, end: today })
  })
  test('overlapping ribbons take different lanes; a span crossing the week edge says it continues', () => {
    const days = weekDays(today)
    const vs = [
      version({ version: '2.202.0', atMs: Date.parse('2026-11-10T15:00:00.000Z'), basis: 'estimate', pieceKeys: ['a'] }),
      version({ version: '2.201.2', atMs: Date.parse('2026-11-07T15:00:00.000Z'), basis: 'estimate', pieceKeys: ['b'] }),
    ]
    const ps = [piece({ key: 'a', startedAtMs: Date.parse('2026-11-06T15:00:00.000Z') }), piece({ key: 'b', startedAtMs: Date.parse('2026-11-06T15:00:00.000Z') })]
    const r = weekRibbons(days, vs, ps, today)
    expect(r).toHaveLength(2)
    expect(new Set(r.map(x => x.lane)).size).toBe(2)
    expect(r.find(x => x.version === '2.202.0')!.contRight).toBe(true)
  })
})

describe('agenda', () => {
  test('timed entries first by time, due days last; accounts renewing the same day are ONE entry', () => {
    const out = agendaOf('2026-11-07', {
      versions: [version({ version: '2.201.2', atMs: Date.parse('2026-11-07T22:00:00.000Z') }), version({ version: '2.201.1', state: 'published', atMs: Date.parse('2026-11-07T17:12:00.000Z') })],
      pieces: [],
      marks: [
        { kind: 'account-reset', atMs: Date.parse('2026-11-07T19:21:00.000Z'), harness: 'codex', account: 'a', label: 'ChatGPT', window: '5h' },
        { kind: 'account-reset', atMs: Date.parse('2026-11-07T19:51:00.000Z'), harness: 'opencode', account: 'b', label: 'OpenCode', window: '5h' },
        { kind: 'task-due', day: '2026-11-07', taskId: 't', label: 'Prazo', priority: null },
      ],
    })
    expect(out.map(e => e.kind)).toEqual(['version', 'resets', 'version', 'due'])
    expect(out[1]).toMatchObject({ kind: 'resets', items: [{ label: 'ChatGPT' }, { label: 'OpenCode' }] })
  })
})

describe('time axis', () => {
  test('segments: the real trail, then ONE expected span to the estimate', () => {
    const p = piece({
      key: 'a', trail: [{ stage: 'running', enteredMs: NOW - 4 * H, ms: 3 * H }, { stage: 'qa', enteredMs: NOW - H, ms: H }],
      publishEta: { kind: 'estimate', atMs: NOW + 6 * H, confidence: 'high' },
    })
    const s = pieceSegments(p, NOW)
    expect(s.map(x => x.stage)).toEqual(['running', 'qa', 'expected'])
    expect(s[2]).toMatchObject({ fromMs: NOW, toMs: NOW + 6 * H })
  })
  test('no estimate = no expected span', () => {
    expect(pieceSegments(piece({ key: 'a' }), NOW).some(s => s.stage === 'expected')).toBe(false)
  })
  test('day blocks clip to the day and mark the expected rest', () => {
    const p = piece({ key: 'a', stageEta: { kind: 'estimate', atMs: NOW + 3 * H, confidence: null }, publishEta: { kind: 'estimate', atMs: NOW + 30 * H, confidence: 'low' } })
    const today = dayBlocks(p, '2026-11-07', NOW)
    expect(today.some(b => !b.expected)).toBe(true)
    expect(today.every(b => b.toMs <= Date.parse('2026-11-08T03:00:00.000Z'))).toBe(true)
    expect(dayBlocks(p, '2026-11-09', NOW)).toEqual([])
  })
  test('fitWeek: nothing is hidden when everything fits; no "+N"', () => {
    const rs = weekRibbons(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'],
      [version({ version: '1.0', state: 'published', atMs: Date.parse('2026-11-03T15:00:00Z') })], [], '2026-11-07')
    const f = fitWeek({ ribbons: rs, dues: [0, 0, 0, 0, 0, 0, 0], cap: 3 })
    expect(f.ribbons).toHaveLength(1)
    expect(f.more).toEqual([0, 0, 0, 0, 0, 0, 0])
  })
  test('fitWeek: 4 versions on one day with room for 3 rows show 3 + a "+1" that counts the hidden one', () => {
    const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']
    const at = Date.parse('2026-11-06T15:00:00Z')
    const vs = ['2.200.0', '2.200.4', '2.200.5', '2.200.6'].map(v => version({ version: v, state: 'published', atMs: at }))
    const rs = weekRibbons(days, vs, [], '2026-11-07')
    expect(rs).toHaveLength(4)
    const f = fitWeek({ ribbons: rs, dues: [0, 0, 0, 0, 0, 0, 0], cap: 3 })
    expect(f.ribbons).toHaveLength(3)
    expect(f.more[4]).toBe(1)
    expect(f.more.reduce((a, b) => a + b, 0)).toBe(1)
  })
  test('fitWeek: due chips are counted too, never dropped (the old slice(0, 2))', () => {
    const f = fitWeek({ ribbons: [], dues: [0, 5, 0, 0, 0, 0, 0], cap: 3 })
    expect(f.dues[1]).toBe(3)
    expect(f.more[1]).toBe(2)
  })
  test('fitWeek: a row too short for any chip still says how many are there', () => {
    const f = fitWeek({ ribbons: [], dues: [1, 0, 0, 0, 0, 0, 0], cap: 0 })
    expect(f.dues[0]).toBe(0)
    expect(f.more[0]).toBe(1)
  })
  test('urgent sorts before low; no priority last', () => {
    const l = [piece({ key: 'n', priority: null }), piece({ key: 'l', priority: 'low' }), piece({ key: 'u', priority: 'urgent' })].sort(byPriority)
    expect(l.map(x => x.key)).toEqual(['u', 'l', 'n'])
  })
})

describe('a piece with no version and no estimate is placed by its start (LIVE.EM-ANDAMENTO-E-LIDER r2)', () => {
  const NOW = Date.parse('2026-11-09T15:00:00.000Z')
  const START = NOW - 600_000
  // The shape `delivery/calendar.ts` hands the builder for a leader working alone: task level, running, no estimate.
  const reply = buildCalendar({
    nowMs: NOW,
    lives: [{
      key: 't', taskId: 't', taskTitle: 'Engine', subtaskId: null, title: 'Engine', stage: 'running', startedAtMs: START, stageSinceMs: START,
      harnesses: ['claude'], models: ['opus'], eta: { kind: 'none' }, stageEta: { kind: 'none' }, publishEta: { kind: 'none', reason: 'no-history' }, deliveredAtMs: null,
    }],
    records: [], tasks: [{ id: 't', title: 'Engine', status: 'in_progress' }], subtasks: [], resets: [],
  })
  const day = brtDay(START)
  const pieces = filterCalendar(reply, { tasks: 'active' }).pieces

  test('the week / phone agenda lists it on the day the work began', () => {
    const e = agendaOf(day, { versions: [], pieces, marks: [] })
    expect(e.map(x => x.kind === 'piece' && x.piece.key)).toEqual(['t'])
    expect(e[0]).toMatchObject({ kind: 'piece', state: 'started', atMs: START })
  })
  test('the month cell has a chip for it on that day, and not on another', () => {
    expect(startedPiecesOfDay(day, pieces).map(p => p.key)).toEqual(['t'])
    expect(startedPiecesOfDay(brtDay(START - 2 * 86_400_000), pieces)).toEqual([])
  })
  test('a piece with an estimate keeps its estimate day; one with a version stays on its release', () => {
    const withEta = { ...pieces[0]!, publishEta: { kind: 'estimate' as const, atMs: NOW + 5 * 86_400_000, confidence: 'low' as const } }
    expect(startedPiecesOfDay(day, [withEta])).toEqual([])
    expect(startedPiecesOfDay(day, [{ ...pieces[0]!, version: '2.205.0' }])).toEqual([])
  })
})

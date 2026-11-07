import { describe, expect, test } from 'bun:test'
import type { CalPiece, CalVersion } from '@agentistics/core'
import {
  addDays, addMonths, agendaOf, byPriority, dayBlocks, monthCells, pieceSegments, rangeLabel, stepAnchor, versionDays,
  weekDays, weekRibbons, weekdayMon0,
} from './calendarModel'

const NOW = Date.parse('2026-11-07T18:40:00.000Z') // Sat 07/11 15h40 BRT
const H = 3600_000
const piece = (o: Partial<CalPiece> & { key: string }): CalPiece => ({
  taskId: 't', taskTitle: 'T', subtaskId: 's', title: o.key, stage: 'qa', version: '2.202.0', harness: 'claude', model: null, priority: 'high',
  active: true, startedAtMs: NOW - 4 * H, stageSinceMs: NOW - H, trail: [], stageEta: { kind: 'none', reason: null }, publishEta: { kind: 'none', reason: null },
  publishedAtMs: null, dueDate: null, confirmed: false, late: false, ...o,
})
const version = (o: Partial<CalVersion> & { version: string }): CalVersion => ({ state: 'planned', atMs: null, basis: 'none', confidence: null, pieceKeys: [], stageCounts: {}, ...o })

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
  test('urgent sorts before low; no priority last', () => {
    const l = [piece({ key: 'n', priority: null }), piece({ key: 'l', priority: 'low' }), piece({ key: 'u', priority: 'urgent' })].sort(byPriority)
    expect(l.map(x => x.key)).toEqual(['u', 'l', 'n'])
  })
})

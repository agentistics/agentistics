import { describe, expect, test } from 'bun:test'
import { buildCalendar, type CalPiece } from '@agentistics/core'
import { buildTree, dayAxis, dayLeftOut, dayPieces, flattenTree, pieceSpanOf, progressOf, spanOf, weekAxis, weekPieces, isUndated } from './cronogramaTree'
import { toggleCollapsed } from './cronogramaCollapsed'

const NOW = Date.parse('2026-11-14T18:39:00.000Z') // Sat 14/11 15h39 BRT
const H = 3600_000
const live = (sub: string, stage: 'qa' | 'queue' | 'running' | 'published', o: Record<string, unknown> = {}) => ({
  key: `t/${sub}`, taskId: 't', taskTitle: 'Engine', subtaskId: sub, title: `Peça ${sub}`, stage, startedAtMs: NOW - 5 * H, stageSinceMs: NOW - H,
  harnesses: [], models: [], trail: [], eta: { kind: 'none' as const }, stageEta: { kind: 'none' as const }, publishEta: { kind: 'none' as const },
  deliveredAtMs: stage === 'published' ? NOW - 2 * H : null, ...o,
})
const pieces = (): CalPiece[] => buildCalendar({
  nowMs: NOW,
  lives: [
    live('a1', 'published'), live('a2', 'qa', { publishEta: { kind: 'estimate', atMs: NOW + 3 * H } }),
    live('r1', 'running'), live('r3', 'queue', { startedAtMs: null, stageSinceMs: null }), live('e1', 'published'),
  ],
  records: [], tasks: [{ id: 't', title: 'Engine', status: 'in_progress' }],
  subtasks: [
    { id: 'ga', taskId: 't', title: 'Adaptadores' }, { id: 'a1', taskId: 't', title: 'A1', parentGroupId: 'ga' }, { id: 'a2', taskId: 't', title: 'A2', parentGroupId: 'ga' },
    { id: 'gr', taskId: 't', title: 'Runtime' }, { id: 'r1', taskId: 't', title: 'R1', parentGroupId: 'gr' }, { id: 'r3', taskId: 't', title: 'R3', parentGroupId: 'gr' },
    { id: 'e1', taskId: 't', title: 'E1' },
  ], resets: [],
}).pieces

describe('tree', () => {
  test('task → group → subtask, a loose subtask hangs off the task', () => {
    const t = buildTree(pieces())
    expect(t).toHaveLength(1)
    expect(t[0]!.kind).toBe('task')
    expect(t[0]!.children.map(c => [c.kind, c.title])).toEqual(expect.arrayContaining([['group', 'Adaptadores'], ['group', 'Runtime'], ['sub', 'Peça e1']]))
    expect(t[0]!.children.find(c => c.title === 'Adaptadores')!.children).toHaveLength(2)
  })
  test('collapse hides the descendants; connectors know whether siblings follow', () => {
    const t = buildTree(pieces())
    const all = flattenTree(t, new Set())
    expect(all).toHaveLength(8)
    const folded = flattenTree(t, new Set(['task:t']))
    expect(folded).toHaveLength(1)
    const g = flattenTree(t, new Set([t[0]!.children[0]!.id]))
    expect(g.length).toBe(all.length - t[0]!.children[0]!.children.length)
    // the first group still has a sibling below it, so its children keep a continuing line at that level
    expect(all[2]!.guides).toEqual(['none', 'line'])
  })
  test('percent = delivered leaves / leaves, rounded DOWN; only parents have it', () => {
    const t = buildTree(pieces())[0]!
    expect(progressOf(t)).toEqual({ done: 2, total: 5, percent: 40 })
    const g = t.children.find(c => c.title === 'Adaptadores')!
    expect(progressOf(g)).toEqual({ done: 1, total: 2, percent: 50 })
    const third = { ...t, children: [t.children[0]!, t.children[1]!, t.children[2]!] }
    expect(progressOf(third).percent).toBe(Math.floor((100 * progressOf(third).done) / progressOf(third).total))
  })
  test('2 of 3 delivered is 66 %, never 67 (floor, not round)', () => {
    const ps = buildCalendar({
      nowMs: NOW,
      lives: [live('x1', 'published'), live('x2', 'published'), live('x3', 'running')],
      records: [], tasks: [{ id: 't', title: 'Engine', status: 'in_progress' }], subtasks: [], resets: [],
    }).pieces
    expect(progressOf(buildTree(ps)[0]!)).toEqual({ done: 2, total: 3, percent: 66 })
  })
  test('toggleCollapsed adds and removes', () => {
    expect(toggleCollapsed([], 'x')).toEqual(['x'])
    expect(toggleCollapsed(['x'], 'x')).toEqual([])
  })
})

describe('bars', () => {
  const ps = pieces()
  const by = (k: string) => ps.find(p => p.key === `t/${k}`)!
  test('start is the REAL start; delivered ends at the delivery instant', () => {
    const s = pieceSpanOf(by('a1'), NOW)!
    expect(s.startMs).toBe(NOW - 5 * H)
    expect(s.endMs).toBe(NOW - 2 * H)
    expect(s.delivered).toBe(true)
  })
  test('open with an ETA ends at the ETA; open with none ends at now', () => {
    expect(pieceSpanOf(by('a2'), NOW)!.endMs).toBe(NOW + 3 * H)
    expect(pieceSpanOf(by('r1'), NOW)!.endMs).toBe(NOW)
  })
  test('no real start: no bar, and never a 00:00 anywhere', () => {
    expect(pieceSpanOf(by('r3'), NOW)).toBeNull()
    expect(isUndated(by('r3'))).toBe(true)
  })
  test('a parent is the union of its dated children; no dated child, no bar', () => {
    const t = buildTree(ps)[0]!
    const g = t.children.find(c => c.title === 'Adaptadores')!
    expect(spanOf(g, NOW)).toEqual({ startMs: NOW - 5 * H, endMs: NOW + 3 * H, delivered: false })
    const onlyUndated = buildTree([by('r3')])[0]!
    expect(spanOf(onlyUndated, NOW)).toBeNull()
  })
})

describe('axes', () => {
  const ps = pieces()
  test('week axis is 14 day columns from Monday', () => {
    const a = weekAxis('2026-11-09')
    expect(a.units).toBe(14)
    expect(weekPieces(ps, a, NOW).length).toBe(ps.length) // undated ones are listed (chip on today)
  })
  test('day axis starts at 07h, earlier only when a bar starts earlier; undated pieces show on today only', () => {
    expect(dayAxis('2026-11-14', [{ startMs: NOW - 3 * H, endMs: NOW, delivered: false }]).units).toBe(17)
    expect(dayAxis('2026-11-14', [{ startMs: NOW - 12 * H, endMs: NOW, delivered: false }]).units).toBe(24 - 3)
    expect(dayPieces(ps, '2026-11-14', NOW, '2026-11-14').some(p => p.key === 't/r3')).toBe(true)
    expect(dayPieces(ps, '2026-11-13', NOW, '2026-11-14').some(p => p.key === 't/r3')).toBe(false)
  })
  test('day lists only pieces with ACTIVITY on the day; a piece merely open for weeks is left out and counted', () => {
    const stale = buildCalendar({
      nowMs: NOW,
      lives: [live('old', 'running', { startedAtMs: NOW - 30 * 24 * H, stageSinceMs: NOW - 30 * 24 * H }), live('act', 'running')],
      records: [], tasks: [{ id: 't', title: 'Engine', status: 'in_progress' }], subtasks: [], resets: [],
    }).pieces
    const keys = dayPieces(stale, '2026-11-14', NOW, '2026-11-14').map(p => p.key)
    expect(keys).toEqual(['t/act'])
    expect(dayLeftOut(stale, '2026-11-14', NOW, '2026-11-14')).toBe(1)
  })
})

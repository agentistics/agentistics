import { describe, expect, test } from 'bun:test'
import {
  brtDay, brtDayStartMs, brtParts, buildCalendar, calendarToIcs, compareVersions, filterCalendar,
  type CalLiveInput,
} from './deliveryCalendar'

const NOW = Date.parse('2026-11-07T18:40:00.000Z') // 15:40 BRT, Sat 07
const H = 3600_000

const live = (o: Partial<CalLiveInput> & { key: string; taskId: string; stage: CalLiveInput['stage'] }): CalLiveInput => ({
  taskTitle: `Task ${o.taskId}`, subtaskId: o.key.split('/')[1] ?? null, title: `Piece ${o.key}`,
  startedAtMs: NOW - 5 * H, stageSinceMs: NOW - H, harnesses: ['claude'], models: ['opus'],
  eta: { kind: 'estimate', confidence: 'high' }, stageEta: { kind: 'none', reason: 'no-history' },
  publishEta: { kind: 'estimate', atMs: NOW + 6 * H }, deliveredAtMs: null, ...o,
})

const base = () => buildCalendar({
  nowMs: NOW,
  lives: [
    live({ key: 't1/a', taskId: 't1', stage: 'qa' }),
    live({ key: 't1/b', taskId: 't1', stage: 'running', eta: { kind: 'none', reason: 'no-history' }, publishEta: { kind: 'none', reason: 'no-history' } }),
    live({ key: 't2/c', taskId: 't2', stage: 'published', deliveredAtMs: NOW - 2 * H }),
  ],
  records: [
    { subtaskId: 'a', taskId: 't1', phase: 'qa', versionTarget: '2.202.0' },
    { subtaskId: 'b', taskId: 't1', phase: 'executando', versionTarget: '2.202.0' },
    { subtaskId: 'c', taskId: 't2', phase: 'publicado', versionTarget: '2.201.1', publishedAt: '2026-11-07T17:12:00.000Z' },
    { subtaskId: 'old', taskId: 't3', phase: 'publicado', versionTarget: '2.200.6', publishedAt: '2026-10-31T12:00:00.000Z' },
    { subtaskId: 'dflt', taskId: 't1', phase: 'fila', versionTarget: 'next' },
  ],
  tasks: [
    { id: 't1', title: 'Esteira', status: 'in_progress', priority: 'high', dueDate: '2026-11-12' },
    { id: 't2', title: 'Fila', status: 'done', priority: 'urgent' },
    { id: 't3', title: 'Modo autônomo', status: 'done', dueDate: '2026-11-05' },
  ],
  subtasks: [{ id: 'old', taskId: 't3', title: 'Modo autônomo: liga e desliga' }],
  resets: [{ harness: 'codex', account: 'a1', label: 'ChatGPT', window: '5h', resetsAt: NOW + 30 * 60_000 }],
})

describe('BRT day arithmetic', () => {
  test('a 23:30 BRT instant is still that BRT day, whatever UTC says', () => {
    const ms = Date.parse('2026-11-08T02:30:00.000Z')
    expect(brtDay(ms)).toBe('2026-11-07')
    expect(brtParts(ms)).toEqual({ day: '2026-11-07', hour: 23, minute: 30 })
    expect(brtDayStartMs('2026-11-07')).toBe(Date.parse('2026-11-07T03:00:00.000Z'))
  })
  test('versions sort numerically', () => { expect(['2.10.0', '2.9.0', '2.202.0'].sort(compareVersions)).toEqual(['2.9.0', '2.10.0', '2.202.0']) })
})

describe('buildCalendar', () => {
  const c = base()
  test('a published piece carries the record publishedAt, not the delivery stamp', () => {
    const p = c.pieces.find(x => x.key === 't2/c')!
    expect(p.publishedAtMs).toBe(Date.parse('2026-11-07T17:12:00.000Z'))
    expect(p.active).toBe(false)
    expect(p.confirmed).toBe(true)
  })
  test('a published record that left the Live line still enters as history, titled from the book', () => {
    const p = c.pieces.find(x => x.key === 't3/old')!
    expect(p.title).toBe('Modo autônomo: liga e desliga')
    expect(p.version).toBe('2.200.6')
    expect(p.active).toBe(false)
  })
  test('a record the Live line does not draw (planned work, no session) is still a piece — with NO estimate', () => {
    const r = buildCalendar({
      nowMs: NOW, lives: [],
      records: [{ subtaskId: 'p', taskId: 't1', phase: 'executando', versionTarget: '2.203.0', firstAt: '2026-11-07T10:00:00.000Z', lastAt: '2026-11-07T12:00:00.000Z' }],
      tasks: [{ id: 't1', title: 'Esteira', status: 'in_progress', priority: 'high' }], subtasks: [{ id: 'p', taskId: 't1', title: 'Peça p' }], resets: [],
    })
    expect(r.pieces[0]).toMatchObject({ key: 't1/p', title: 'Peça p', stage: 'running', version: '2.203.0', active: true, publishedAtMs: null, startedAtMs: Date.parse('2026-11-07T10:00:00.000Z') })
    expect(r.pieces[0]!.publishEta.kind).toBe('none')
    expect(r.versions[0]).toMatchObject({ version: '2.203.0', state: 'planned', atMs: null, basis: 'none' })
  })
  test('`next` is a deferral, not a version', () => {
    expect(c.versions.some(v => v.version === 'next')).toBe(false)
  })
  test('a version with one piece unable to estimate is `partial`: a date from the others, never invented for it', () => {
    const v = c.versions.find(x => x.version === '2.202.0')!
    expect(v.state).toBe('planned')
    expect(v.basis).toBe('partial')
    expect(v.atMs).toBe(NOW + 6 * H)
  })
  test('a version whose every piece cannot estimate has NO date', () => {
    const r = buildCalendar({
      nowMs: NOW, lives: [live({ key: 'x/y', taskId: 'x', stage: 'queue', eta: { kind: 'none' }, publishEta: { kind: 'none', reason: 'not-started' } })],
      records: [{ subtaskId: 'y', taskId: 'x', phase: 'fila', versionTarget: '2.203.0' }], tasks: [], subtasks: [], resets: [],
    })
    expect(r.versions[0]).toMatchObject({ version: '2.203.0', atMs: null, basis: 'none' })
  })
  test('a fully published version states the real instant', () => {
    const v = c.versions.find(x => x.version === '2.201.1')!
    expect(v).toMatchObject({ state: 'published', basis: 'published', atMs: Date.parse('2026-11-07T17:12:00.000Z') })
  })
  test('marks: an account renewal and an open task due day; a closed task has none', () => {
    expect(c.marks.filter(m => m.kind === 'account-reset')).toHaveLength(1)
    const due = c.marks.filter(m => m.kind === 'task-due')
    expect(due.map(m => m.kind === 'task-due' && m.taskId)).toEqual(['t1'])
  })
  test('a piece past its publish ETA is late', () => {
    const r = buildCalendar({ nowMs: NOW, lives: [live({ key: 'z/q', taskId: 'z', stage: 'qa', publishEta: { kind: 'estimate', atMs: NOW - H } })], records: [], tasks: [], subtasks: [], resets: [] })
    expect(r.pieces[0]!.late).toBe(true)
  })
})

describe('filterCalendar', () => {
  const c = base()
  test('default = tasks being worked on: only active pieces, and versions that carry one', () => {
    const v = filterCalendar(c)
    expect(v.pieces.map(p => p.key).sort()).toEqual(['t1/a', 't1/b', 't1/dflt'])
    // 2.201.1 and 2.200.6 are history: context, kept while nothing narrows by piece.
    expect(v.versions.map(x => x.version)).toEqual(['2.200.6', '2.201.1', '2.202.0'])
  })
  test('narrowing by a piece dimension drops history versions', () => {
    expect(filterCalendar(c, { harnesses: ['claude'] }).versions.map(x => x.version)).toEqual(['2.202.0'])
  })
  test('task filter matches id or part of the title, case-insensitive', () => {
    expect(filterCalendar(c, { task: 'TASK T1', tasks: 'all' }).pieces.map(p => p.key).sort()).toEqual(['t1/a', 't1/b'])
    expect(filterCalendar(c, { task: 't2', tasks: 'all' }).pieces.map(p => p.key)).toEqual(['t2/c'])
  })
  test('confirmedOnly drops pieces that have no confident estimate', () => {
    expect(filterCalendar(c, { confirmedOnly: true }).pieces.map(p => p.key)).toEqual(['t1/a'])
  })
  test('version + stage + priority filters combine', () => {
    expect(filterCalendar(c, { versions: ['2.202.0'], stages: ['running'], priorities: ['high'] }).pieces.map(p => p.key)).toEqual(['t1/b'])
  })
  test('the period keeps what touches it', () => {
    const day = (d: string) => ({ fromMs: brtDayStartMs(d), toMs: brtDayStartMs(d) + 86_400_000 - 1 })
    expect(filterCalendar(c, { tasks: 'all', ...day('2026-11-07') }).pieces.length).toBeGreaterThan(0)
    expect(filterCalendar(c, { tasks: 'all', ...day('2026-12-25') }).pieces).toEqual([])
  })
  test('a due mark follows the task filter', () => {
    expect(filterCalendar(c).marks.some(m => m.kind === 'task-due')).toBe(true)
    expect(filterCalendar(c, { task: 'fila', tasks: 'all' }).marks.some(m => m.kind === 'task-due')).toBe(false)
  })
})

describe('calendarToIcs', () => {
  test('one event per expected or real publication, CRLF-terminated, escaped', () => {
    const ics = calendarToIcs(filterCalendar(base(), { tasks: 'all' }), NOW)
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics).toContain('SUMMARY:2.201.1 · published')
    expect(ics).toContain('UID:p-t1/a@agentistics')
    expect(ics).not.toContain('UID:p-t1/b@') // no estimate, no event
  })
})

import { describe, expect, test } from 'bun:test'
import { brtDayStartMs, buildCalendar, calendarToIcs, filterCalendar, type CalLiveInput } from './deliveryCalendar'

const NOW = Date.parse('2026-11-17T15:00:00.000Z')
const H = 3600_000

const live = (o: Partial<CalLiveInput> & { key: string; stage: CalLiveInput['stage'] }): CalLiveInput => ({
  taskId: 't1', taskTitle: 'Task', subtaskId: o.key.split('/')[1] ?? null, title: `Piece ${o.key}`,
  startedAtMs: NOW - 5 * H, stageSinceMs: NOW - H, harnesses: ['claude'], models: ['opus'],
  eta: { kind: 'estimate', confidence: 'low' }, stageEta: { kind: 'none', reason: 'no-history' },
  publishEta: { kind: 'estimate', atMs: NOW + 8 * 24 * H }, deliveredAtMs: null, ...o,
})
const sub = (id: string, extra: Record<string, unknown> = {}) => ({ id, taskId: 't1', title: id, ...extra })
const build = (o: { lives?: CalLiveInput[]; records?: unknown[]; subtasks?: unknown[]; tasks?: unknown[]; inferredVersions?: Record<string, string>; releases?: unknown[] }) =>
  buildCalendar({ nowMs: NOW, resets: [], lives: [], records: [], subtasks: [], tasks: [{ id: 't1', title: 'Task', status: 'in_progress' }], ...o } as never)

describe('1 · a piece with a due date is planned for that date', () => {
  test('publishEta is the due day, marked as the owner\'s planned date, and not late before it', () => {
    const r = build({ lives: [live({ key: 't1/a', stage: 'running' })], subtasks: [sub('a', { dueDate: '2026-11-19' })] })
    const p = r.pieces[0]!
    expect(p.publishEta.kind).toBe('estimate')
    if (p.publishEta.kind === 'estimate') {
      expect(p.publishEta.confidence).toBe('owner')
      expect(p.publishEta.atMs).toBeGreaterThanOrEqual(brtDayStartMs('2026-11-19'))
      expect(p.publishEta.atMs).toBeLessThan(brtDayStartMs('2026-11-20'))
    }
    expect(p.late).toBe(false)
    expect(p.confirmed).toBe(true)
  })
  test('the .ics event of the piece sits on the due day, not on the Live forecast', () => {
    const r = build({ lives: [live({ key: 't1/a', stage: 'running' })], subtasks: [sub('a', { dueDate: '2026-11-19' })] })
    const ics = calendarToIcs(filterCalendar(r, { tasks: 'all' }), NOW)
    expect(ics).toContain('DTSTART:20261119T')
  })
  test('late only once the due date has passed', () => {
    const r = build({ lives: [live({ key: 't1/a', stage: 'running' })], subtasks: [sub('a', { dueDate: '2026-11-16' })] })
    expect(r.pieces[0]!.late).toBe(true)
  })
})

describe('2 · overdue is a due date that passed, not a stage median', () => {
  test('a stage past its median with no due date keeps the ceiling forecast, flagged for review, never "no date"', () => {
    const r = build({ lives: [live({ key: 't1/a', stage: 'leader', overdueSinceMs: NOW - 3 * H, ceilingEtaMs: NOW + 2 * 24 * H,
      publishEta: { kind: 'none', reason: 'beyond-range' } })], subtasks: [sub('a')] })
    const p = r.pieces[0]!
    expect(p.publishEta).toMatchObject({ kind: 'estimate', atMs: NOW + 2 * 24 * H, confidence: 'low' })
    expect(p.review).toBe(true)
    expect(p.overdueSinceMs).toBeNull()
    expect(p.late).toBe(false)
  })
  test('with a due date still ahead, a stage past its median is not overdue either', () => {
    const r = build({ lives: [live({ key: 't1/a', stage: 'leader', overdueSinceMs: NOW - 3 * H })], subtasks: [sub('a', { dueDate: '2026-11-25' })] })
    expect(r.pieces[0]).toMatchObject({ overdueSinceMs: null, late: false })
  })
  test('a passed due date makes it overdue since that day', () => {
    const r = build({ lives: [live({ key: 't1/a', stage: 'leader' })], subtasks: [sub('a', { dueDate: '2026-11-10' })] })
    expect(r.pieces[0]!.overdueSinceMs).not.toBeNull()
    expect(r.pieces[0]!.late).toBe(true)
  })
})

describe('2b · a ceiling forecast already in the past is not a forecast', () => {
  test('ceilingEtaMs < now: no date, flagged for review, never drawn on a past day', () => {
    const r = build({ lives: [live({ key: 't1/a', stage: 'leader', overdueSinceMs: NOW - 3 * H, ceilingEtaMs: NOW - 2 * 24 * H,
      publishEta: { kind: 'none', reason: 'beyond-range' } })], subtasks: [sub('a')] })
    const p = r.pieces[0]!
    expect(p.publishEta).toEqual({ kind: 'none', reason: 'review' })
    expect(p.review).toBe(true)
    expect(p.late).toBe(false)
    expect(calendarToIcs(filterCalendar(r, { tasks: 'all' }), NOW)).not.toContain('DTSTART:20261115')
  })
  test('no piece of a mixed set carries an estimate before now', () => {
    const r = build({ lives: [
      live({ key: 't1/a', stage: 'leader', overdueSinceMs: NOW - H, ceilingEtaMs: NOW - 30 * 24 * H, publishEta: { kind: 'none', reason: 'x' } }),
      live({ key: 't1/b', stage: 'qa', overdueSinceMs: NOW - H, ceilingEtaMs: NOW + 24 * H, publishEta: { kind: 'none', reason: 'x' } }),
    ], subtasks: [sub('a'), sub('b')] })
    for (const p of r.pieces) if (p.publishEta.kind === 'estimate') expect(p.publishEta.atMs).toBeGreaterThanOrEqual(NOW)
    expect(r.pieces.find(p => p.key === 't1/b')!.publishEta.kind).toBe('estimate')
  })
})

describe('4b · a parked piece is never overdue, even with the filter on Tudo', () => {
  test.each(['ideias_adiado', 'abandoned'])('%s with a passed due date: overdueSinceMs null, absent from the overdue block', status => {
    const r = build({ lives: [live({ key: 't1/a', stage: 'running' })], subtasks: [sub('a', { status, dueDate: '2026-11-01' })] })
    expect(r.pieces[0]!.overdueSinceMs).toBeNull()
    const all = filterCalendar(r, { tasks: 'all' })
    expect(all.pieces).toHaveLength(1)
    expect(all.pieces.filter(p => p.overdueSinceMs != null)).toHaveLength(0)
  })
  test('a record-only parked piece is not overdue either', () => {
    const r = build({ records: [{ subtaskId: 'a', taskId: 't1', phase: 'fila' }], subtasks: [sub('a', { status: 'ideias_adiado', dueDate: '2026-11-01' })] })
    expect(r.pieces[0]!.overdueSinceMs).toBeNull()
  })
})

describe('3 · a piece with a due date and no session still appears, on its date', () => {
  test('a queued live piece with no start gets the due day, not not-started', () => {
    const r = build({ lives: [live({ key: 't1/a', stage: 'queue', startedAtMs: null, publishEta: { kind: 'none', reason: 'not-started' } })], subtasks: [sub('a', { dueDate: '2026-11-21' })] })
    expect(r.pieces[0]!.publishEta).toMatchObject({ kind: 'estimate', confidence: 'owner' })
  })
  test('a record-only piece (no Live card) with a due day is planned on it', () => {
    const r = build({ records: [{ subtaskId: 'a', taskId: 't1', phase: 'fila' }], subtasks: [sub('a', { dueDate: '2026-11-21' })] })
    expect(r.pieces[0]!.publishEta).toMatchObject({ kind: 'estimate', confidence: 'owner' })
    expect(r.pieces[0]!.late).toBe(false)
    const ics = calendarToIcs(filterCalendar(r, { tasks: 'all' }), NOW)
    expect(ics).toContain('DTSTART:20261121T')
  })
  test('a record-only piece with no due day keeps "not-started"', () => {
    const r = build({ records: [{ subtaskId: 'a', taskId: 't1', phase: 'fila' }], subtasks: [sub('a')] })
    expect(r.pieces[0]!.publishEta).toEqual({ kind: 'none', reason: 'not-started' })
  })
})

describe('4 · deferred and abandoned pieces are not active', () => {
  test.each(['ideias_adiado', 'abandoned'])('a live piece whose subtask is %s is inactive and never late', status => {
    const r = build({ lives: [live({ key: 't1/a', stage: 'running' })], subtasks: [sub('a', { status, dueDate: '2026-11-01' })] })
    expect(r.pieces[0]).toMatchObject({ active: false, late: false })
    expect(filterCalendar(r, {}).pieces).toHaveLength(0)
  })
  test('a record-only deferred piece is inactive', () => {
    const r = build({ records: [{ subtaskId: 'a', taskId: 't1', phase: 'fila' }], subtasks: [sub('a', { status: 'ideias_adiado' })] })
    expect(r.pieces.every(p => !p.active)).toBe(true)
  })
})

describe('5 · a piece already proven published leaves leader/ci as published', () => {
  const releases = [{ version: '2.214.0', publishedAt: '2026-11-15T12:00:00.000Z' }]
  test('declared on a later, unreleased version but the commit is proven in an earlier tag', () => {
    const r = build({
      lives: [live({ key: 't1/a', stage: 'ci', startedAtMs: Date.parse('2026-11-10T10:00:00.000Z') })], subtasks: [sub('a')],
      records: [{ subtaskId: 'a', taskId: 't1', phase: 'ci', versionTarget: '2.215.0' }],
      inferredVersions: { 't1/a': '2.214.0' }, releases,
    })
    expect(r.pieces[0]).toMatchObject({ stage: 'published', version: '2.214.0', late: false })
  })
  test('the same on a record-only piece in leader', () => {
    const r = build({
      subtasks: [sub('a', { status: 'in_review' })],
      records: [{ subtaskId: 'a', taskId: 't1', phase: 'revisao_lider', versionTarget: '2.215.0', firstAt: '2026-11-10T10:00:00.000Z' }],
      inferredVersions: { 't1/a': '2.214.0' }, releases,
    })
    expect(r.pieces[0]).toMatchObject({ stage: 'published', version: '2.214.0' })
  })
})

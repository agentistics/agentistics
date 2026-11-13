import { expect, test } from 'bun:test'
import { buildCalendar, type CalLiveInput } from './deliveryCalendar'

const NOW = Date.parse('2026-11-13T01:50:00.000Z')
const H = 3600_000

const live = (o: Partial<CalLiveInput> & { key: string; taskId: string; stage: CalLiveInput['stage'] }): CalLiveInput => ({
  taskTitle: 'Parent', subtaskId: o.key.split('/')[1] ?? null, title: `Piece ${o.key}`,
  startedAtMs: NOW - 50 * H, stageSinceMs: NOW - 10 * H, harnesses: ['codex'], models: ['luna'],
  eta: { kind: 'estimate', confidence: 'low' }, stageEta: { kind: 'estimate', atMs: NOW + 48 * H },
  publishEta: { kind: 'estimate', atMs: NOW + 96 * H }, deliveredAtMs: null, ...o,
})
const base = {
  nowMs: NOW, resets: [], records: [],
  tasks: [{ id: 't1', title: 'Parent', status: 'in_progress', dueDate: '2026-11-14' }],
  subtasks: [{ id: 'a', taskId: 't1', title: 'A' }, { id: 'b', taskId: 't1', title: 'B', dueDate: '2026-11-20' }],
}

test('in_review + a published version reads as published, not as leader review', () => {
  const reply = buildCalendar({
    ...base,
    lives: [live({ key: 't1/a', taskId: 't1', stage: 'leader' }), live({ key: 't1/b', taskId: 't1', stage: 'leader' })],
    records: [{ subtaskId: 'a', taskId: 't1', phase: 'revisao_lider', versionTarget: '2.205.1' }],
    releases: [{ version: '2.205.1', publishedAt: '2026-11-03T12:00:00.000Z' }],
  })
  const a = reply.pieces.find(p => p.subtaskId === 'a')!
  expect(a).toMatchObject({ stage: 'published', version: '2.205.1', active: false, confirmed: true, late: false })
  expect(a.publishedAtMs).toBe(Date.parse('2026-11-03T12:00:00.000Z'))
  expect(a.publishEta).toMatchObject({ kind: 'none', reason: 'final' })
  expect(reply.pieces.find(p => p.subtaskId === 'b')!.stage).toBe('leader') // nothing proves b shipped
  expect(reply.versions.find(v => v.version === '2.205.1')).toMatchObject({ state: 'published', pieceKeys: ['t1/a'] })
})

test('a piece running a NEW round on a shipped version is not flipped to published', () => {
  const reply = buildCalendar({
    ...base, lives: [live({ key: 't1/a', taskId: 't1', stage: 'running' })],
    records: [{ subtaskId: 'a', taskId: 't1', phase: 'executando', versionTarget: '2.205.1' }],
    releases: [{ version: '2.205.1', publishedAt: '2026-11-03T12:00:00.000Z' }],
  })
  expect(reply.pieces[0]!.stage).toBe('running')
})

test('a version PROVEN by the host (tag contains the commit) is linked to a piece with no record', () => {
  const reply = buildCalendar({
    ...base, lives: [live({ key: 't1/a', taskId: 't1', stage: 'leader' })],
    releases: [{ version: '2.210.1', publishedAt: '2026-11-12T20:00:00.000Z' }],
    inferredVersions: { 't1/a': '2.210.1' },
  })
  expect(reply.pieces[0]).toMatchObject({ stage: 'published', version: '2.210.1' })
  expect(reply.versions.find(v => v.version === '2.210.1')!.pieceKeys).toEqual(['t1/a'])
})

test('a piece shows its own due date; the parent task day is only a parent mark', () => {
  const reply = buildCalendar({
    ...base, lives: [live({ key: 't1/a', taskId: 't1', stage: 'running' }), live({ key: 't1/b', taskId: 't1', stage: 'running' })],
  })
  const a = reply.pieces.find(p => p.subtaskId === 'a')!, b = reply.pieces.find(p => p.subtaskId === 'b')!
  expect(a.dueDate).toBeNull()
  expect(a.parentDueDate).toBe('2026-11-14')
  expect(b.dueDate).toBe('2026-11-20')
  expect(reply.marks.filter(m => m.kind === 'task-due')).toHaveLength(1)
})

test('the parent due day never makes an undated piece late', () => {
  const reply = buildCalendar({
    ...base, nowMs: Date.parse('2026-11-16T12:00:00.000Z'),
    lives: [live({ key: 't1/a', taskId: 't1', stage: 'running', publishEta: { kind: 'none' } })],
  })
  expect(reply.pieces[0]).toMatchObject({ dueDate: null, late: false })
})

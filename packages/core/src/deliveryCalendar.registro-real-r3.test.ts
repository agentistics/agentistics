import { expect, test } from 'bun:test'
import { buildCalendar, filterCalendar, type CalLiveInput } from './deliveryCalendar'

/**
 * CALENDARIO.REGISTRO-REAL r3 — an INFERRED version (the host's proof: a release tag carries the delivered commit)
 *  - is accepted only when it is one of the releases the calendar already shows (an old real tag outside that list
 *    used to become a fake "planned · no estimate" version drawn on TODAY, stealing the lane of the real release);
 *  - links a piece to a version only when the piece IS published under it — an open piece (queue, a new round) is
 *    never counted under a published release;
 *  - reaches the pieces the delivery flow tracks but the Live does not draw (record-only), like any other.
 */

const NOW = Date.parse('2026-11-13T12:00:00.000Z')
const H = 3600_000

const live = (o: Partial<CalLiveInput> & { key: string; taskId: string; stage: CalLiveInput['stage'] }): CalLiveInput => ({
  taskTitle: 'Parent', subtaskId: o.key.split('/')[1] ?? null, title: `Piece ${o.key}`,
  startedAtMs: NOW - 50 * H, stageSinceMs: NOW - 10 * H, harnesses: ['codex'], models: ['luna'],
  eta: { kind: 'estimate', confidence: 'low' }, stageEta: { kind: 'estimate', atMs: NOW + 48 * H },
  publishEta: { kind: 'estimate', atMs: NOW + 96 * H }, deliveredAtMs: null, ...o,
})
const base = {
  nowMs: NOW, resets: [], records: [],
  tasks: [{ id: 't1', title: 'Parent', status: 'in_progress' }],
  subtasks: [{ id: 'a', taskId: 't1', title: 'A' }, { id: 'b', taskId: 't1', title: 'B' }, { id: 'c', taskId: 't1', title: 'C' }],
  releases: [
    { version: '2.211.0', publishedAt: '2026-11-13T10:00:00.000Z' },
    { version: '2.204.4', publishedAt: '2026-11-10T03:30:00.000Z' },
  ],
}

test('an inferred version the release list does not know (an old real tag) is dropped — no planned ribbon, no fake version', () => {
  const reply = buildCalendar({
    ...base, lives: [live({ key: 't1/a', taskId: 't1', stage: 'leader' })],
    inferredVersions: { 't1/a': '2.113.0' },
  })
  expect(reply.pieces[0]).toMatchObject({ stage: 'leader', version: null })
  expect(reply.versions.find(v => v.version === '2.113.0')).toBeUndefined()
  expect(reply.versions.filter(v => v.state === 'planned')).toHaveLength(0)
  // the real release of today is still there, published, on its own day
  expect(reply.versions.find(v => v.version === '2.211.0')).toMatchObject({ state: 'published', atMs: Date.parse('2026-11-13T10:00:00.000Z') })
})

test('an inferred version in the release list publishes the piece waiting on the leader', () => {
  const reply = buildCalendar({ ...base, lives: [live({ key: 't1/a', taskId: 't1', stage: 'leader' })], inferredVersions: { 't1/a': '2.204.4' } })
  expect(reply.pieces[0]).toMatchObject({ stage: 'published', version: '2.204.4' })
  expect(reply.versions.find(v => v.version === '2.204.4')!.pieceKeys).toEqual(['t1/a'])
})

test('an OPEN piece (queue / new round) is never counted under a published release by an inferred version', () => {
  const reply = buildCalendar({
    ...base,
    lives: [live({ key: 't1/a', taskId: 't1', stage: 'queue' }), live({ key: 't1/b', taskId: 't1', stage: 'running' })],
    inferredVersions: { 't1/a': '2.204.4', 't1/b': '2.204.4' },
  })
  for (const p of reply.pieces) expect(p.version).toBeNull()
  expect(reply.pieces.map(p => p.stage)).toEqual(['queue', 'running'])
  expect(reply.versions.find(v => v.version === '2.204.4')!.pieceKeys).toEqual([])
})

test('a new round DECLARED against an already published release keeps its target but is not on that release card', () => {
  const reply = buildCalendar({
    ...base,
    lives: [live({ key: 't1/a', taskId: 't1', stage: 'running' }), live({ key: 't1/b', taskId: 't1', stage: 'leader' })],
    records: [
      { subtaskId: 'a', taskId: 't1', phase: 'executando', versionTarget: '2.204.4' },
      { subtaskId: 'b', taskId: 't1', phase: 'revisao_lider', versionTarget: '2.204.4' },
    ],
  })
  expect(reply.pieces.find(p => p.key === 't1/a')).toMatchObject({ stage: 'running', version: '2.204.4' })
  expect(reply.versions.find(v => v.version === '2.204.4')).toMatchObject({ state: 'published', pieceKeys: ['t1/b'], stageCounts: { published: 1 } })
})

test('a published release whose only declared pieces are still open stays on the (filtered) calendar', () => {
  const reply = buildCalendar({
    ...base, lives: [live({ key: 't1/a', taskId: 't1', stage: 'queue' })],
    records: [{ subtaskId: 'a', taskId: 't1', phase: 'fila', versionTarget: '2.204.4' }],
  })
  expect(filterCalendar(reply, {}).versions.find(v => v.version === '2.204.4')).toMatchObject({ state: 'published', pieceKeys: [] })
})

test('a record-only piece published with no version target takes the proven version', () => {
  const reply = buildCalendar({
    ...base, lives: [],
    records: [{ subtaskId: 'c', taskId: 't1', phase: 'publicado', publishedAt: '2026-11-10T04:00:00.000Z' }],
    inferredVersions: { 't1/c': '2.204.4' },
  })
  expect(reply.pieces[0]).toMatchObject({ key: 't1/c', stage: 'published', version: '2.204.4' })
  expect(reply.versions.find(v => v.version === '2.204.4')!.pieceKeys).toEqual(['t1/c'])
})

test('a record-only piece waiting on the leader whose proven version went out is published under it', () => {
  const reply = buildCalendar({
    ...base, lives: [],
    records: [{ subtaskId: 'c', taskId: 't1', phase: 'revisao_lider', firstAt: '2026-11-08T00:00:00.000Z', lastAt: '2026-11-09T00:00:00.000Z' }],
    inferredVersions: { 't1/c': '2.204.4' },
  })
  expect(reply.pieces[0]).toMatchObject({ stage: 'published', version: '2.204.4', publishedAtMs: Date.parse('2026-11-10T03:30:00.000Z') })
})

test('a record-only piece in a new round keeps its stage and is not counted under the inferred release', () => {
  const reply = buildCalendar({
    ...base, lives: [],
    records: [{ subtaskId: 'c', taskId: 't1', phase: 'executando' }],
    inferredVersions: { 't1/c': '2.204.4' },
  })
  expect(reply.pieces[0]).toMatchObject({ stage: 'running', version: null })
})

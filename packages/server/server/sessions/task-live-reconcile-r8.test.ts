import { expect, test } from 'bun:test'
import { buildLive } from './task-live'
import { describeLive } from './task-live-view'
import { buildTaskDetail } from './task-report'
import { boardReviewTargets } from '../delivery/review-board'

const nowMs = Date.parse('2026-11-09T01:19:31.980Z')
const old = '2026-10-16T16:48:22.645Z'
const taskId = 't-e1dea7cd6f'
const task = { id: taskId, title: 'Engine completa', status: 'in_review', createdAt: old, updatedAt: old }
const sub = (id: string, extra = {}) => ({ id, taskId, title: id, status: 'in_review', done: false, createdAt: old, updatedAt: old, ...extra })
const detail = (subtasks: object[], sessions: object[] = [], taskExtra = {}) => buildTaskDetail({
  task: { ...task, ...taskExtra }, subtasks, rows: sessions, metas: new Map(), attempts: [], comments: [], files: [], costOf: () => 0,
} as never)
const view = (details: ReturnType<typeof detail>[], extra = {}) => describeLive({
  reply: buildLive({ details, nowMs, events: [], ...extra }), rows: [], leaderIds: new Set(), nowMs, filters: { period: 'all' },
})

test('r7 no-repos s-a7e7d9df9f stays antiga before and after the lookup cache is populated', () => {
  const details = [detail([sub('s-a7e7d9df9f')])]
  expect(view(details).deliveries.find(d => d.subtaskId === 's-a7e7d9df9f')?.old).toBe(true)
  expect(view(details, { unchecked: new Set(['s-a7e7d9df9f']), uncheckedWhy: new Map([['s-a7e7d9df9f', 'no-repos']]) }).deliveries.find(d => d.subtaskId === 's-a7e7d9df9f')?.old).toBe(true)
})

test('r7 empty group s-97ca9d04b5 cannot go back to queue after a manual completion', () => {
  const details = [detail([sub('s-97ca9d04b5', { isGroup: true, status: 'done', done: true, updatedAt: new Date(nowMs).toISOString(), deliveredAt: new Date(nowMs).toISOString() })])]
  expect(view(details).deliveries.find(d => d.subtaskId === 's-97ca9d04b5')).toMatchObject({ stage: 'completed', status: 'done' })
})

test('r7 s-3c7e645a58 remains in Tudo after completion even if its only filed sessions are leaders', () => {
  const reply = buildLive({ details: [detail([sub('s-3c7e645a58', { status: 'done', done: true, updatedAt: new Date(nowMs).toISOString(), deliveredAt: '2026-10-16T11:43:46.892Z' })], [{ id: 'leader', taskId, subtaskId: 's-3c7e645a58', harness: 'claude', createdAt: old, endedAt: old }])], nowMs, events: [] })
  const result = describeLive({ reply, rows: [], leaderIds: new Set(['leader']), nowMs, filters: { period: 'all' } })
  expect(result.deliveries.find(d => d.subtaskId === 's-3c7e645a58')).toMatchObject({ stage: 'completed' })
})

test('r9: by default Tudo carries Concluído only inside the period; period "all" brings the rest', () => {
  const details = [detail([sub('s-3c7e645a58', { status: 'done', done: true })])]
  const at = (period?: 'all') => describeLive({ reply: buildLive({ details, nowMs, events: [] }), rows: [], leaderIds: new Set(), nowMs, ...(period ? { filters: { period } } : {}) })
  expect(at().deliveries).toHaveLength(0)
  expect(at('all').deliveries).toHaveLength(1)
})

test('task-level Cold start is eligible by the same age rule', () => {
  expect(view([detail([], [], { id: 't-d9e9fff3f6' })]).deliveries[0]).toMatchObject({ old: true, stage: 'leader' })
})

test('NATIVO.ALCANCE with todo members is not adopted as a raw in_review group', () => {
  const subtasks = [sub('s-081a453723', { isGroup: true }), sub('s-9c0e4cfaed', { parentGroupId: 's-081a453723', status: 'todo' })]
  expect(boardReviewTargets({ tasks: [task], subtasks } as never)).toEqual([])
})

test('a piece that finished without release proof stays in Tudo and never in queue or Published', () => {
  const v = view([detail([sub('s-3c7e645a58', { status: 'done', done: true })])])
  expect(v.view.counts).toMatchObject({ all: 1, queue: 0, published: 0 })
})

test('no-repos cannot borrow a matching commit from a different checkout to claim publication', () => {
  const extra = { unchecked: new Set(['s-a7e7d9df9f']), uncheckedWhy: new Map([['s-a7e7d9df9f', 'no-repos']]), publishedShas: new Set(['abc12345']) }
  expect(view([detail([sub('s-a7e7d9df9f', { notes: 'sha abc12345' })])], extra).deliveries[0]).toMatchObject({ stage: 'leader', old: true })
  expect(view([detail([sub('s-a7e7d9df9f', { status: 'done', notes: 'sha abc12345' })])], extra).deliveries[0]).toMatchObject({ stage: 'completed' })
})

test('Engine task with open subtasks is not a second review card', () => {
  const details = [detail([sub('s-081a453723')], [{ id: 'direct', taskId, harness: 'claude', createdAt: old }])]
  expect(view(details).deliveries.some(d => d.subtaskId === null && d.stage === 'leader')).toBe(false)
})

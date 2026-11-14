import { describe, expect, test } from 'bun:test'
import { buildLive, cleanDeliveryRecord, legacyReviewShaPieces } from './task-live'
import { describeLive } from './task-live-view'
import { buildTaskDetail } from './task-report'

// LIVE.COLETA-LIMPA: the git-sha collector must clean the stored record exactly as buildLive does, or a piece buildLive
// would publish is never asked about git. Invariant: buildLive says `published` given the git answer => the collector asked.
const nowMs = Date.parse('2026-11-13T15:00:00.000Z')
const old = '2026-11-12T10:00:00.000Z'
const taskId = 't-x'
const task = { id: taskId, title: 'T', status: 'in_progress', createdAt: old, updatedAt: old }
const sub = (id: string, extra = {}) => ({ id, taskId, title: id, status: 'in_review', done: false, createdAt: old, updatedAt: old, ...extra })
const detail = (subtasks: object[]) => buildTaskDetail({ task, subtasks, rows: [], metas: new Map(), attempts: [], comments: [], files: [], costOf: () => 0 } as never)
const sha = '3cad21b582268546dcede622845cd4612b49a15c'
const notes = { notes: `entrega commit ${sha}` }
const done = { ...notes, status: 'done', done: true }

function run(s: object, rec: object | null) {
  const dl = new Map(rec ? [['s-1', rec]] : [])
  const reply = buildLive({ details: [detail([s])], nowMs, events: [], deliveries: dl as never, publishedShas: new Set([sha]) })
  const d = describeLive({ reply, rows: [], leaderIds: new Set(), nowMs, filters: { period: 'all', tab: 'all' } as never }).deliveries
  return { stage: d.find(x => x.subtaskId === 's-1')?.stage ?? null, collected: legacyReviewShaPieces([detail([s])], [], dl as never).has(sha) }
}

const cases: [string, object, object | null][] = [
  ['in_review, no record', sub('s-1', notes), null],
  ['in_review + revisao_lider', sub('s-1', notes), { phase: 'revisao_lider' }],
  ['in_review + pr_merge', sub('s-1', notes), { phase: 'pr_merge' }],
  ['in_review + ci', sub('s-1', notes), { phase: 'ci' }],
  ['in_review + qa', sub('s-1', notes), { phase: 'qa' }],
  ['in_review + stale fila', sub('s-1', notes), { phase: 'fila' }],
  ['in_review + dequeued executando', sub('s-1', notes), { phase: 'executando', dequeued: true }],
  ['in_review + dequeued pr_merge', sub('s-1', notes), { phase: 'pr_merge', dequeued: true }],
  ['done, no record', sub('s-1', done), null],
  ['done + ci', sub('s-1', done), { phase: 'ci' }],
  ['done + dequeued publicado', sub('s-1', done), { phase: 'publicado', dequeued: true }],
]

describe('sha collector cleans the record like buildLive', () => {
  for (const [name, s, r] of cases) test(`invariant: ${name}`, () => {
    const o = run(s, r)
    if (o.stage === 'published') expect(o.collected).toBe(true)
  })

  test('the pieces the table says turn Publicado do so', () => {
    for (const n of ['in_review + dequeued pr_merge', 'in_review + stale fila', 'in_review + dequeued executando', 'done + dequeued publicado']) {
      const c = cases.find(x => x[0] === n)!
      expect(run(c[1], c[2])).toEqual({ stage: 'published', collected: true })
    }
  })

  test('cleanDeliveryRecord: dequeued or stale fila on a closed piece is no record', () => {
    expect(cleanDeliveryRecord({ phase: 'pr_merge', dequeued: true } as { phase: string; dequeued?: boolean }, 'in_review')).toBeUndefined()
    expect(cleanDeliveryRecord({ phase: 'fila' } as { phase: string; dequeued?: boolean }, 'done')).toBeUndefined()
    expect(cleanDeliveryRecord({ phase: 'fila' } as { phase: string; dequeued?: boolean }, 'in_progress')?.phase).toBe('fila')
    expect(cleanDeliveryRecord(undefined, 'done')).toBeUndefined()
  })
})

import { expect, test } from 'bun:test'
import { buildLive } from './task-live'
import { describeLive } from './task-live-view'
import { buildTaskDetail } from './task-report'

// LIVE.STATUS-IGNORADO: a delivery record parked in `revisao_lider` must not outvote the board status.
const nowMs = Date.parse('2026-11-13T15:00:00.000Z')
const old = '2026-11-12T10:00:00.000Z'
const taskId = 't-e1dea7cd6f'
const task = { id: taskId, title: 'Engine', status: 'in_progress', createdAt: old, updatedAt: old }
const sub = (id: string, extra = {}) => ({ id, taskId, title: id, status: 'in_review', done: false, createdAt: old, updatedAt: old, ...extra })
const detail = (subtasks: object[], sessions: object[] = []) => buildTaskDetail({
  task, subtasks, rows: sessions, metas: new Map(), attempts: [], comments: [], files: [], costOf: () => 0,
} as never)
const rec = (extra = {}) => ({ phase: 'revisao_lider', ...extra })
const live = (subtasks: object[], deliveries: Map<string, object>, sessions: object[] = [], extra = {}) => {
  const reply = buildLive({ details: [detail(subtasks, sessions)], nowMs, events: [], deliveries: deliveries as never, ...extra })
  return describeLive({ reply, rows: [], leaderIds: new Set(), nowMs, filters: { period: 'all', tab: 'active' } as never }).deliveries
}

test('abandoned subtask with a leader-phase record leaves the active columns', () => {
  const out = live([sub('s-aband', { status: 'abandoned' })], new Map([['s-aband', rec()]]))
  expect(out.filter(d => d.subtaskId === 's-aband' && d.stage === 'leader')).toHaveLength(0)
})

test('in_progress subtask with a leader-phase record shows as running when a live session is filed', () => {
  const out = live([sub('s-rework', { status: 'in_progress' })], new Map([['s-rework', rec()]]),
    [{ id: 'w1', taskId, subtaskId: 's-rework', harness: 'claude', createdAt: nowMs ? '2026-11-13T14:00:00.000Z' : old }])
  const d = out.find(x => x.subtaskId === 's-rework')
  expect(d?.stage).not.toBe('leader')
})

test('in_progress subtask with a leader-phase record and no session never sits in leader review', () => {
  const out = live([sub('s-rework2', { status: 'in_progress' })], new Map([['s-rework2', rec()]]))
  expect(out.find(x => x.subtaskId === 's-rework2' && x.stage === 'leader')).toBeUndefined()
})

test('blocked subtask with a leader-phase record shows as blocked', () => {
  const out = live([sub('s-blk', { status: 'blocked', blockedReason: 'esperando o dono' })], new Map([['s-blk', rec()]]))
  const d = out.find(x => x.subtaskId === 's-blk')
  expect(d?.stage).toBe('blocked')
})

test('blocked from a review record keeps its originStage (leader); an owner wait states its reason once', () => {
  const b = live([sub('s-blk3', { status: 'blocked', blockedReason: 'esperando o dono' })], new Map([['s-blk3', rec()]])).find(x => x.subtaskId === 's-blk3')
  expect(b?.block?.originStage).toBe('leader')
  const g = live([sub('s-gate3')], new Map([['s-gate3', rec({ humanGates: ['revisao_lider'], revision: 3, asked: { revisao_lider: 3 }, approvals: {} })]])).find(x => x.subtaskId === 's-gate3')
  expect(g?.block?.reason).toBe('decisao_do_dono')
  expect(g?.block?.text).toBeNull()
})

test('a real in_review subtask with a leader-phase record stays in leader review (control)', () => {
  const out = live([sub('s-ok')], new Map([['s-ok', rec()]]))
  expect(out.find(x => x.subtaskId === 's-ok')?.stage).toBe('leader')
})

test('leader-phase record whose commit is in a published release leaves leader review (published)', () => {
  const extra = { publishedShas: new Set(['abc12345']) }
  const sh = [sub('s-pub', { notes: 'commit abc12345' })]
  const dl = new Map([['s-pub', rec()]])
  expect(live(sh, dl, [], extra).find(x => x.subtaskId === 's-pub')).toBeUndefined()
  const reply = buildLive({ details: [detail(sh)], nowMs, events: [], deliveries: dl as never, ...extra })
  const all = describeLive({ reply, rows: [], leaderIds: new Set(), nowMs, filters: { period: 'all', tab: 'all' } as never }).deliveries
  expect(all.find(x => x.subtaskId === 's-pub')?.stage).toBe('published')
})

test('a record piece whose commit a published tag holds becomes Publicado THROUGH the collection and the git question', async () => {
  const { legacyReviewShaPieces } = await import('./task-live')
  const { publishedAmong, releaseTagsIdle, resetReleaseTagsForTest } = await import('./release-tags')
  await resetReleaseTagsForTest()
  const sha = '1cad21b582268546dcede622845cd4612b49a15c'
  const sh = [sub('s-pub2', { notes: `entrega commit ${sha}` })]
  const dl = new Map([['s-pub2', rec()]])
  const pieces = legacyReviewShaPieces([detail(sh)], [], dl as never)
  expect([...pieces.keys()]).toContain(sha)
  const asked: string[] = []
  const ask = async (s: string) => { asked.push(s); return true }
  publishedAmong([...pieces.keys()], nowMs, ask)   // first read: answer arrives in the background
  await releaseTagsIdle()
  const publishedShas = publishedAmong([...pieces.keys()], nowMs, ask)   // next read: cached, no new git call
  expect(asked).toEqual([sha])
  expect(live(sh, dl, [], { publishedShas }).find(x => x.subtaskId === 's-pub2')).toBeUndefined()
  const reply = buildLive({ details: [detail(sh)], nowMs, events: [], deliveries: dl as never, publishedShas })
  const all = describeLive({ reply, rows: [], leaderIds: new Set(), nowMs, filters: { period: 'all', tab: 'all' } as never }).deliveries
  expect(all.find(x => x.subtaskId === 's-pub2')?.stage).toBe('published')
  await resetReleaseTagsForTest()
})

test('a record already published asks git nothing; a stale fila on a piece in review is no record, so it IS asked (same cleaning as buildLive)', async () => {
  const { legacyReviewShaPieces } = await import('./task-live')
  const sha = '2cad21b582268546dcede622845cd4612b49a15c'
  const sh = [sub('s-p', { notes: `entrega commit ${sha}` }), sub('s-q', { notes: `entrega commit ${sha}` })]
  const dl = new Map([['s-p', rec({ phase: 'publicado' })], ['s-q', rec({ phase: 'fila' })]])
  const got = legacyReviewShaPieces([detail(sh)], [], dl as never)
  expect(got.get(sha)?.map(x => x.subtaskId)).toEqual(['s-q'])
})

test('R2: an in_review piece whose record is pr_merge/ci is NOT collected for git (buildLive never promotes it); done + non-publicado still is', async () => {
  const { legacyReviewShaPieces } = await import('./task-live')
  const sha = '3cad21b582268546dcede622845cd4612b49a15c'
  const inReview = [sub('s-m', { notes: `entrega commit ${sha}` }), sub('s-c', { notes: `entrega commit ${sha}` })]
  const dl = new Map([['s-m', rec({ phase: 'pr_merge' })], ['s-c', rec({ phase: 'ci' })]])
  expect(legacyReviewShaPieces([detail(inReview)], [], dl as never).size).toBe(0)
  // Still collected: leader review (promoted to Publicado) and a done piece with any open record (Publicado vs Concluído).
  const lead = new Map([['s-m', rec()]])
  expect([...legacyReviewShaPieces([detail([sub('s-m', { notes: `entrega commit ${sha}` })])], [], lead as never).keys()]).toContain(sha)
  const done = new Map([['s-d', rec({ phase: 'ci' })]])
  expect([...legacyReviewShaPieces([detail([sub('s-d', { status: 'done', notes: `entrega commit ${sha}` })])], [], done as never).keys()]).toContain(sha)
  // And the answer is indeed not used: a published tag leaves a pr_merge card in merge.
  const reply = buildLive({ details: [detail([sub('s-m', { notes: `entrega commit ${sha}` })])], nowMs, events: [], deliveries: new Map([['s-m', rec({ phase: 'pr_merge' })]]) as never, publishedShas: new Set([sha]) })
  const all = describeLive({ reply, rows: [], leaderIds: new Set(), nowMs, filters: { period: 'all', tab: 'all' } as never }).deliveries
  expect(all.find(x => x.subtaskId === 's-m')?.stage).toBe('merge')
})

// ---- Item D2: work waiting on the USER is shown as waiting on the user, never as leader review.
test('a leader-phase piece with an open human gate shows as waiting on the owner (blocked · decisao_do_dono)', () => {
  const r = rec({ humanGates: ['revisao_lider'], revision: 3, asked: { revisao_lider: 3 }, approvals: {} })
  const d = live([sub('s-gate')], new Map([['s-gate', r]])).find(x => x.subtaskId === 's-gate')
  expect(d?.stage).toBe('blocked')
  expect(d?.block).toMatchObject({ reason: 'decisao_do_dono', unlocker: 'owner', originStage: 'leader' })
})

test('a leader-phase piece with an open question in the task queue shows as waiting on the owner', () => {
  const d = live([sub('s-ask')], new Map([['s-ask', rec({ queueAsk: { at: '2026-11-13T10:00:00.000Z', delivered: true } })]])).find(x => x.subtaskId === 's-ask')
  expect(d?.stage).toBe('blocked')
  expect(d?.block?.unlocker).toBe('owner')
})

test('an answered gate returns the piece to leader review', () => {
  const r = rec({ humanGates: ['revisao_lider'], revision: 3, asked: { revisao_lider: 3 }, approvals: { revisao_lider: { revision: 3, decision: 'yes' } } })
  expect(live([sub('s-done-gate')], new Map([['s-done-gate', r]])).find(x => x.subtaskId === 's-done-gate')?.stage).toBe('leader')
})

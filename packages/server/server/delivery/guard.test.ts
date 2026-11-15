/**
 * S2a — the pure half of the store guard (spec §2.2, §2.5): the ladder rank of a board piece / a delivery phase, which pieces
 * a write RAISES, and the decision function. No IO here; the host (`guard-host.ts`) and the hooks have their own tests.
 */
import { describe, expect, test } from 'bun:test'
import {
  GuardRefused, boardRaises, deliveryRaises, decideGuard, phaseRank, refusalOfOutcome, stageRank,
  type BoardSlice, type GuardContext,
} from './guard'

const statuses = [
  { id: 'todo', stage: 'queue' }, { id: 'in_progress', stage: 'running' }, { id: 'in_review', stage: 'leader' },
  { id: 'pr_merge', stage: 'merge' }, { id: 'ci', stage: 'ci' }, { id: 'done', stage: 'published' },
  { id: 'rev-ready', stage: 'leader' }, { id: 'shipped', stage: 'published' }, { id: 'blocked', stage: 'blocked' },
]
const slice = (subs: Array<Record<string, unknown>>, tasks: Array<Record<string, unknown>> = [{ id: 't1', status: 'in_progress' }]): BoardSlice =>
  ({ tasks: tasks as never, subtasks: subs.map(s => ({ taskId: 't1', ...s })) as never, statuses })

describe('rank — stored stage, never the label', () => {
  test('stage → rank is the §2.2 ladder', () => {
    expect([stageRank('running'), stageRank('qa'), stageRank('blocked'), stageRank('leader'), stageRank('merge'), stageRank('ci'), stageRank('published'), stageRank('completed'), stageRank(null)]).toEqual([0, 0, 0, 1, 2, 3, 4, 5, 0])
  })
  test('phase → rank', () => {
    expect([phaseRank('fila'), phaseRank('executando'), phaseRank('qa'), phaseRank('ajuste'), phaseRank('bloqueado'), phaseRank('revisao_lider'), phaseRank('pr_merge'), phaseRank('ci'), phaseRank('publicado')]).toEqual([0, 0, 0, 0, 0, 1, 2, 3, 4])
  })
})

describe('boardRaises — entity by entity', () => {
  test('a subtask moved in_progress → in_review raises to 1; a custom "Review ready" and "Shipped" status do too (stored stage)', () => {
    const before = slice([{ id: 's1', status: 'in_progress' }])
    expect(boardRaises(before, slice([{ id: 's1', status: 'in_review' }])).map(r => [r.key, r.rank])).toEqual([['s1', 1]])
    expect(boardRaises(before, slice([{ id: 's1', status: 'rev-ready' }])).map(r => r.rank)).toEqual([1])
    expect(boardRaises(before, slice([{ id: 's1', status: 'shipped' }])).map(r => r.rank)).toEqual([4])
  })
  test('lowering, staying and rank-0 moves raise nothing', () => {
    const rev = slice([{ id: 's1', status: 'in_review' }])
    expect(boardRaises(rev, slice([{ id: 's1', status: 'in_progress' }]))).toEqual([])
    expect(boardRaises(rev, rev)).toEqual([])
    expect(boardRaises(slice([{ id: 's1', status: 'todo' }]), slice([{ id: 's1', status: 'blocked' }]))).toEqual([])
  })
  test('the ci SIGNAL alone raises (rank 3; a published tag, 4)', () => {
    const before = slice([{ id: 's1', status: 'in_progress' }])
    expect(boardRaises(before, slice([{ id: 's1', status: 'in_progress', ci: { mergedMain: true, releaseGreen: false, tagPublished: false, tag: null, pr: null } }])).map(r => r.rank)).toEqual([3])
    expect(boardRaises(before, slice([{ id: 's1', status: 'in_progress', ci: { mergedMain: true, releaseGreen: true, tagPublished: true, tag: 'v1', pr: 1 } }])).map(r => r.rank)).toEqual([4])
  })
  test('a group MEMBER is not a piece; a task with subtasks is not a piece; a task with none is', () => {
    const before = slice([{ id: 'g', status: 'in_progress', isGroup: true }, { id: 'm', status: 'in_progress', parentGroupId: 'g' }])
    const after = slice([{ id: 'g', status: 'in_progress', isGroup: true }, { id: 'm', status: 'in_review', parentGroupId: 'g' }], [{ id: 't1', status: 'done' }])
    expect(boardRaises(before, after)).toEqual([])
    const lone = (status: string) => slice([], [{ id: 't1', status }])
    expect(boardRaises(lone('in_progress'), lone('in_review')).map(r => [r.key, r.subtaskId])).toEqual([['t1', undefined]])
  })
  test('a NEW subtask or newly exposed task in review needs authorization', () => {
    expect(boardRaises(slice([]), slice([{ id: 'n', status: 'in_review' }])).map(r => r.key)).toEqual(['n'])
    const withSub = slice([{ id: 's1', status: 'in_progress' }], [{ id: 't1', status: 'in_review' }])
    const without = slice([], [{ id: 't1', status: 'in_review' }])
    expect(boardRaises(withSub, without).map(r => r.key)).toEqual(['t1'])
    expect(boardRaises(slice([{ id: 'm', status: 'in_review', parentGroupId: 'g' }]), slice([{ id: 'm', status: 'in_review' }])).map(r => r.key)).toEqual(['m'])
  })
})

describe('deliveryRaises', () => {
  const rec = (phase: string) => ({ phase })
  test('revisao_lider / pr_merge / ci / publicado and advanced adoption need authorization', () => {
    expect(deliveryRaises({ p: rec('qa') }, { p: rec('revisao_lider') }).map(r => [r.key, r.rank])).toEqual([['p', 1]])
    expect(deliveryRaises({ p: rec('revisao_lider') }, { p: rec('ci') }).map(r => r.rank)).toEqual([3])
    expect(deliveryRaises({ p: rec('ci') }, { p: rec('revisao_lider') })).toEqual([])
    expect(deliveryRaises({}, { p: rec('revisao_lider') }).map(r => r.key)).toEqual(['p'])
  })
})

describe('decideGuard', () => {
  const raised = [{ key: 's1', taskId: 't1', subtaskId: 's1', rank: 1 }]
  const ctx: GuardContext = { principal: { kind: 'unattributed' } }
  const ok = { ok: true as const, ids: ['ev-1'], sha256: ['aa'], headSha: 'h', category: 'screen' }
  const missing = { ok: false as const, code: 'evidence_required', message: 'needs a screenshot', messagePt: 'precisa de print', missing: ['desktop screenshot'] }

  test('rule off decides nothing (the caller never even gathers facts)', () => {
    expect(decideGuard({ rule: 'off', raised, ctx: undefined, outcomes: {} })).toEqual({ verdict: 'pass' })
  })
  test('on, no context → fail closed (guard_context_required), even with evidence', () => {
    const r = decideGuard({ rule: 'on', raised, ctx: undefined, outcomes: { s1: ok } })
    expect(r).toMatchObject({ verdict: 'refuse', refusal: { code: 'guard_context_required' } })
  })
  test('on, context + good outcome → pass with the targets; context + refused outcome → that refusal verbatim', () => {
    expect(decideGuard({ rule: 'on', raised, ctx, outcomes: { s1: ok } })).toMatchObject({ verdict: 'pass', passed: [{ key: 's1', outcome: ok }] })
    expect(decideGuard({ rule: 'on', raised, ctx, outcomes: { s1: missing } })).toMatchObject({ verdict: 'refuse', refusal: { code: 'evidence_required', piece: 's1' } })
  })
  test('shadow never refuses: it reports what would have been refused', () => {
    expect(decideGuard({ rule: 'shadow', raised, ctx, outcomes: { s1: missing } })).toMatchObject({ verdict: 'pass', wouldRefuse: [{ code: 'evidence_required', piece: 's1' }] })
    expect(decideGuard({ rule: 'shadow', raised, ctx: undefined, outcomes: {} })).toMatchObject({ verdict: 'pass', wouldRefuse: [{ code: 'guard_context_required' }] })
  })
  test('GuardRefused carries the code, both sentences and the missing list', () => {
    const e = new GuardRefused(refusalOfOutcome('s1', missing))
    expect(e).toMatchObject({ code: 'evidence_required', status: 422, piece: 's1', missing: ['desktop screenshot'] })
    expect(e.message).toBe('needs a screenshot'); expect(e.messagePt).toBe('precisa de print')
  })
})

/**
 * S2a — the pure half of the store guard (spec §2.2, §2.5): the ladder rank of a board piece / a delivery phase, which pieces
 * a write RAISES, and the decision function. No IO here; the host (`guard-host.ts`) and the hooks have their own tests.
 */
import { describe, expect, test } from 'bun:test'
import {
  GuardRefused, boardRaises, deliveryRaises, deliveryTamper, decideGuard, phaseRank, refusalOfOutcome, stageRank,
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

describe('r3 N4 — bindings a protected piece may not change without authorization', () => {
  test('M1: a HEAD change on a delivery at rank ≥ 1 is a protected change (headSha is in the binding)', () => {
    const was = { phase: 'revisao_lider', taskId: 't1', revision: 3, headSha: 'a'.repeat(40) }
    expect(deliveryRaises({ p: was }, { p: { ...was, headSha: 'b'.repeat(40) } }).map(r => [r.key, r.rank])).toEqual([['p', 1]])
    expect(deliveryRaises({ p: { ...was, phase: 'qa' } }, { p: { ...was, phase: 'qa', headSha: 'b'.repeat(40) } })).toEqual([])
  })
  test('M7: a CI-signal change on a subtask at rank ≥ 1 is a protected change, at the same rank', () => {
    const ci = (tag: string) => ({ mergedMain: true, releaseGreen: false, tagPublished: false, tag, pr: null })
    const before = slice([{ id: 's1', status: 'in_review', ci: ci('v1') }])
    const after = slice([{ id: 's1', status: 'in_review', ci: ci('v2') }])
    expect(boardRaises(before, after).map(r => [r.key, r.rank])).toEqual([['s1', 3]])
    expect(boardRaises(before, before)).toEqual([])
  })
})

describe('r3 N1 — deliveryTamper: the capture round and its evidence are append-only', () => {
  const item = (id: string, revision: number) => ({ id, sha256: id.repeat(4), revision })
  const rec = () => ({ taskId: 't1', revision: 4, history: [{ from: 'qa', to: 'ajuste', revision: 3 }, { from: 'ajuste', to: 'qa', revision: 4 }], evidence: [item('e1', 1), item('e2', 4)], evidenceHistory: [{ sha256: 'x', revision: 1 }] })
  const codes = (b: object, a: object, ctx = false) => deliveryTamper({ p: b as never }, { p: a as never }, ctx).map(r => r.code)
  test('GAP-1: dropping the ajuste entry is refused for every writer, context or not', () => {
    const a = rec(); a.history = a.history.filter(h => h.to !== 'ajuste')
    expect(codes(rec(), a)).toEqual(['evidence_binding_protected'])
    expect(codes(rec(), a, true)).toEqual(['evidence_binding_protected'])
    // …and so is rewriting it in place (same length: the ajuste relabelled, or its revision moved down).
    const relabelled = rec(); relabelled.history = relabelled.history.map(h => h.to === 'ajuste' ? { ...h, to: 'qa' } : h)
    expect(codes(rec(), relabelled)).toEqual(['evidence_binding_protected'])
    const lowered = rec(); lowered.history = lowered.history.map(h => h.to === 'ajuste' ? { ...h, revision: 1 } : h)
    expect(codes(rec(), lowered, true)).toEqual(['evidence_binding_protected'])
  })
  test('GAP-2: relabelling an existing item to the current revision is refused for every writer', () => {
    const a = rec(); a.evidence = a.evidence.map(i => ({ ...i, revision: 4 }))
    expect(codes(rec(), a, true)).toEqual(['evidence_binding_protected'])
  })
  test('a forged item, a removed item and a removed record need a context; a revision never goes back', () => {
    const forged = rec(); forged.evidence = [...forged.evidence, item('e9', 4)]
    expect(codes(rec(), forged)).toEqual(['evidence_binding_protected'])
    expect(codes(rec(), forged, true)).toEqual([])
    const dropped = rec(); dropped.evidence = dropped.evidence.slice(1)
    expect(codes(rec(), dropped)).toEqual(['evidence_binding_protected'])
    expect(codes(rec(), dropped, true)).toEqual([])
    expect(deliveryTamper({ p: rec() as never }, {}, false).map(r => r.code)).toEqual(['evidence_binding_protected'])
    expect(deliveryTamper({}, { p: rec() as never }, false).map(r => r.code)).toEqual(['evidence_binding_protected'])
    const back = rec(); back.revision = 2
    expect(codes(rec(), back, true)).toEqual(['evidence_binding_protected'])
    const evh = rec(); evh.evidenceHistory = []
    expect(codes(rec(), evh, true)).toEqual(['evidence_binding_protected'])
  })
  test('appending history, raising the revision and unrelated fields are never refused', () => {
    const a = rec(); a.history = [...a.history, { from: 'qa', to: 'ajuste', revision: 5 }]; a.revision = 5
    expect(codes(rec(), { ...a, branch: 'x' })).toEqual([])
  })
  test('the refusal is bilingual and names the piece', () => {
    const a = rec(); a.history = []
    const [r] = deliveryTamper({ p: rec() as never }, { p: a as never }, true)
    expect(r).toMatchObject({ piece: 'p' }); expect(r!.message).toContain('append-only'); expect(r!.messagePt).toContain('só crescem')
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

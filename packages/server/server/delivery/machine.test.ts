import { describe, expect, test } from 'bun:test'
import {
  EDGES, PHASES, newDelivery, nextPhases, planBlock, planTransition, planUnblock, planWatch, refusalStatus, resolveBlockReason,
  BLOCK_DEFER_AFTER_MS, BLOCK_WAKE_EVERY_MS, type DeliveryRecord, type GateName, type Phase, type TransitionInput,
} from './machine'

const at = '2026-11-07T00:00:00.000Z'
const ctx = (autonomous = true) => ({ at, actor: 'leader-1', autonomous })

/** A record sitting in `phase` with every gate it could need already green for its revision. */
function sitting(phase: Phase, extra: Partial<DeliveryRecord> = {}): DeliveryRecord {
  const r = newDelivery({ subtaskId: 's1', taskId: 't1', at })
  r.phase = phase
  r.headSha = 'abc'
  if (phase === 'revisao_lider') r.qaSha = 'abc'
  if (phase === 'ci' || phase === 'pr_merge') r.qaSha = 'abc'
  Object.assign(r, extra)
  const ok = (g: GateName) => ({ ok: true, at, revision: r.revision })
  for (const g of ['predispatch', 'vaga', 'salvo', 'qa-modelo', 'cabeca', 'delecoes', 'mergeado', 'release'] as GateName[]) r.gates[g] = ok(g)
  // The `mergeado` gate establishes the merge sha from the PR; a record sitting in pr_merge carries it as the gate would have left it.
  // So does a review the tick found MERGED (FLUXO.CICLO-COMPLETO: revisao_lider → ci).
  if (phase === 'pr_merge' || phase === 'revisao_lider') r.mergeSha = 'm1'
  return r
}

const inputFor: Record<string, TransitionInput> = {
  'qa>revisao_lider': { verdict: 'APROVADO', findings: 'all green' },
  'qa>ajuste': { verdict: 'REPROVADO', findings: 'button misaligned' },
  'revisao_lider>pr_merge': { reviewedSha: 'abc' },
  'revisao_lider>ajuste': { detail: 'rename the flag' },
  'revisao_lider>ci': { detail: 'PR #7 merged — found by the flow' },
  'pr_merge>revisao_lider': { detail: 'merge conflict' },
  'ci>revisao_lider': { detail: 'release.yml failed' },
}

describe('every valid transition', () => {
  for (const key of Object.keys(EDGES)) {
    test(key, () => {
      const [from, to] = key.split('>') as [Phase, Phase]
      const plan = planTransition(sitting(from), to, inputFor[key] ?? {}, ctx())
      expect(plan.ok).toBe(true)
      if (plan.ok) {
        expect(plan.next.phase).toBe(to)
        expect(plan.next.revision).toBe(2)
        expect(plan.next.history.at(-1)).toMatchObject({ from, to })
      }
    })
  }
})

describe('every skipped transition is refused', () => {
  const all = PHASES.filter(p => p !== 'bloqueado')
  for (const from of all) for (const to of all) {
    if (from === to || EDGES[`${from}>${to}`]) continue
    test(`${from} → ${to}`, () => {
      const plan = planTransition(sitting(from), to, { verdict: 'APROVADO', findings: 'x', reviewedSha: 'abc', mergeSha: 'm', detail: 'd' }, ctx())
      expect(plan.ok).toBe(false)
      if (!plan.ok) { expect(plan.code).toBe('fase_pulada'); expect(refusalStatus(plan)).toBe(422); expect(plan.sentence).toContain(`${from} → ${to}`) }
    })
  }
})

test("the owner's print case: executando → revisao_lider is refused and says QA comes first", () => {
  const plan = planTransition(sitting('executando'), 'revisao_lider', {}, ctx())
  expect(plan.ok).toBe(false)
  if (!plan.ok) { expect(plan.code).toBe('fase_pulada'); expect(plan.sentence).toContain('QA') }
})

test('ajuste never goes straight to the leader review', () => {
  const plan = planTransition(sitting('ajuste'), 'revisao_lider', {}, ctx())
  expect(!plan.ok && plan.code).toBe('fase_pulada')
  expect(nextPhases('ajuste')).toEqual(['qa'])
})

test('a failed merge goes back to the leader review, and from there to ajuste → qa', () => {
  const failed = planTransition(sitting('pr_merge', { mergeSha: 'x' }), 'revisao_lider', { detail: 'checks red' }, ctx())
  expect(failed.ok).toBe(true)
  if (!failed.ok) return
  expect(failed.next.mergeSha).toBeUndefined()
  const back = planTransition(failed.next, 'ajuste', { detail: 'fix the check' }, ctx())
  expect(back.ok && back.next.phase).toBe('ajuste')
  expect(nextPhases('pr_merge').sort()).toEqual(['ci', 'revisao_lider'])
})

test('missing evidence is refused with what is missing (not a skip)', () => {
  const r = sitting('executando'); delete r.gates.salvo
  const plan = planTransition(r, 'qa', {}, ctx())
  expect(!plan.ok && plan.code).toBe('portao')
  expect(!plan.ok && plan.sentence).toContain('salvo')
})

test('a gate result from an older revision is stale', () => {
  const r = sitting('fila'); r.gates.vaga = { ok: true, at, revision: 0 }
  const plan = planTransition(r, 'executando', {}, ctx())
  expect(!plan.ok && plan.sentence).toContain('vaga')
})

test('QA approval needs the qa-modelo gate (same model refused upstream)', () => {
  const r = sitting('qa'); r.gates['qa-modelo'] = { ok: false, at, revision: r.revision, reason: 'same model' }
  const plan = planTransition(r, 'revisao_lider', inputFor['qa>revisao_lider']!, ctx())
  expect(!plan.ok && plan.sentence).toContain('same model')
})

test('leader review must cover the very sha QA approved', () => {
  const plan = planTransition(sitting('revisao_lider'), 'pr_merge', { reviewedSha: 'zzz' }, ctx())
  expect(plan.ok).toBe(false)
  const moved = planTransition(sitting('revisao_lider', { headSha: 'new' }), 'pr_merge', { reviewedSha: 'abc' }, ctx())
  expect(!moved.ok && moved.sentence).toContain('HEAD mudou')
})

test('the merge sha comes from the record (the mergeado gate), never from the caller', () => {
  const bare = sitting('pr_merge'); delete bare.mergeSha
  const refused = planTransition(bare, 'ci', { mergeSha: 'caller-made-up' }, ctx())
  expect(!refused.ok && refused.sentence).toContain('sha do merge')
  const ok = planTransition(sitting('pr_merge'), 'ci', { mergeSha: 'caller-made-up' }, ctx())
  expect(ok.ok && ok.next.mergeSha).toBe('m1')
  const stale = sitting('pr_merge'); stale.gates.mergeado = { ok: true, at, revision: 0 }
  expect(planTransition(stale, 'ci', {}, ctx()).ok).toBe(false)
})

test('qa → revisao_lider needs a HEAD the salvo gate verified', () => {
  const r = sitting('qa'); delete r.headSha
  const plan = planTransition(r, 'revisao_lider', inputFor['qa>revisao_lider']!, ctx())
  expect(!plan.ok && plan.sentence).toContain('salvo')
})

describe('block', () => {
  test('returns to the stored origin phase and never elsewhere', () => {
    const b = planBlock(sitting('qa'), 'externo', 'GitHub down', ctx())
    expect(b.ok && b.next.phase).toBe('bloqueado')
    if (!b.ok) return
    expect(b.next.origin).toBe('qa')
    expect(planTransition(b.next, 'revisao_lider', {}, ctx()).ok).toBe(false)
    const wrong = planUnblock(b.next, { at, actor: 'l', to: 'revisao_lider' })
    expect(!wrong.ok && wrong.code).toBe('fase_pulada')
    const back = planUnblock(b.next, { at, actor: 'l' })
    expect(back.ok && back.next.phase).toBe('qa')
    expect(back.ok && back.next.block).toBeUndefined()
  })
  test('closed reasons only, and not from publicado', () => {
    expect(planBlock(sitting('qa'), 'tired', 'x', ctx()).ok).toBe(false)
    expect(planBlock(sitting('publicado'), 'externo', 'x', ctx()).ok).toBe(false)
  })
  test('autonomous mode never yields an owner decision; reason 6 is the leader\'s safe path (deferred)', () => {
    for (const asked of ['decisao_do_dono', 'fora_das_autorizacoes'] as const) {
      const b = planBlock(sitting('pr_merge'), asked, 'needs the Apple subscription', ctx(true))
      expect(b.ok).toBe(true)
      if (!b.ok) continue
      expect(b.next.block!.reason).toBe('fora_das_autorizacoes')
      expect(b.next.block!.unlocker).toBe('leader')
      expect(b.next.block!.deferredAt).toBe(at)
      expect(b.next.versionTarget).toBe('next')
    }
  })
  test('with autonomous OFF reason 6 is the owner\'s decision', () => {
    const b = planBlock(sitting('pr_merge'), 'fora_das_autorizacoes', 'spend money', ctx(false))
    expect(b.ok && b.next.block!.reason).toBe('decisao_do_dono')
    expect(b.ok && b.next.block!.unlocker).toBe('owner')
    expect(resolveBlockReason('limite', false)).toBe('limite')
  })
})

describe('human gates', () => {
  const gated = () => sitting('revisao_lider', { humanGates: ['pr_merge'] })
  test('autonomous ON: skipped and recorded "pulado: modo autônomo"', () => {
    const plan = planTransition(gated(), 'pr_merge', { reviewedSha: 'abc' }, ctx(true))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.skipped).toEqual({ phase: 'pr_merge', at, outcome: 'pulado: modo autônomo' })
    expect(plan.next.skips).toHaveLength(1)
  })
  test('autonomous OFF: waits for the owner (409), passes with approval, refuses a rejection', () => {
    const waiting = planTransition(gated(), 'pr_merge', { reviewedSha: 'abc' }, ctx(false))
    expect(!waiting.ok && waiting.code).toBe('aguardando_dono')
    expect(!waiting.ok && refusalStatus(waiting)).toBe(409)
    const approved = gated(); approved.approvals.pr_merge = { decision: 'approve', at, revision: approved.revision }
    expect(planTransition(approved, 'pr_merge', { reviewedSha: 'abc' }, ctx(false)).ok).toBe(true)
    const rejected = gated(); rejected.approvals.pr_merge = { decision: 'reject', at, revision: rejected.revision, note: 'not now' }
    const r = planTransition(rejected, 'pr_merge', { reviewedSha: 'abc' }, ctx(false))
    expect(!r.ok && r.code).toBe('dono_reprovou')
  })
  test('an approval from an older revision does not count', () => {
    const r = gated(); r.approvals.pr_merge = { decision: 'approve', at, revision: 0 }
    expect(planTransition(r, 'pr_merge', { reviewedSha: 'abc' }, ctx(false)).ok).toBe(false)
  })
  test('off by default', () => { expect(newDelivery({ subtaskId: 'a', taskId: 'b', at }).humanGates).toEqual([]) })
})

describe('watch', () => {
  const blocked = (reason: Parameters<typeof planBlock>[1], sinceMs: number, extra: Record<string, unknown> = {}) => {
    const b = planBlock(sitting('executando'), reason, 'x', { at: new Date(sinceMs).toISOString(), actor: 'l', autonomous: false })
    if (!b.ok) throw new Error('block')
    Object.assign(b.next.block!, extra)
    return b.next
  }
  const t0 = Date.parse(at)
  test('wakes the leader on entry and every 30 min, defers after 2 h', () => {
    expect(planWatch([blocked('limite', t0)], { nowMs: t0 + 60_000, autonomous: true, dependencyDone: () => false })[0]?.kind).toBe('wake-leader')
    expect(planWatch([blocked('limite', t0, { lastWakeAt: new Date(t0 + 60_000).toISOString() })], { nowMs: t0 + 120_000, autonomous: true, dependencyDone: () => false })).toEqual([])
    expect(planWatch([blocked('limite', t0, { lastWakeAt: at })], { nowMs: t0 + BLOCK_WAKE_EVERY_MS, autonomous: true, dependencyDone: () => false })[0]?.kind).toBe('wake-leader')
    expect(planWatch([blocked('maquina', t0, { lastWakeAt: at })], { nowMs: t0 + BLOCK_DEFER_AFTER_MS + 1, autonomous: true, dependencyDone: () => false })[0]?.kind).toBe('defer')
  })
  test('a dependency unblocks itself when its blockers finish', () => {
    expect(planWatch([blocked('dependencia', t0)], { nowMs: t0 + 1, autonomous: true, dependencyDone: () => true })[0]?.kind).toBe('unblock-dependency')
    expect(planWatch([blocked('dependencia', t0)], { nowMs: t0 + 1, autonomous: true, dependencyDone: () => false })).toEqual([])
  })
  test('autonomous ON converts a waiting owner decision to the leader', () => {
    expect(planWatch([blocked('decisao_do_dono', t0)], { nowMs: t0 + 1, autonomous: true, dependencyDone: () => false })[0]?.kind).toBe('convert-owner-block')
    expect(planWatch([blocked('decisao_do_dono', t0)], { nowMs: t0 + 1, autonomous: false, dependencyDone: () => false })[0]?.kind).toBe('wake-leader')
  })
})

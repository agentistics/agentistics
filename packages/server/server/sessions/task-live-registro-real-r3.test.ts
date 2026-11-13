import { describe, expect, test } from 'bun:test'
import { prepareForecastHistory, recordTrailOf, resolvePieceForecast, stageTypicals, type Sample } from './task-live'
import type { TaskDetail } from './task-report'

/**
 * CALENDARIO.REGISTRO-REAL r3 — why every forecast collapsed to "now + 15 min" and 155 open pieces read overdue.
 * The delivery records' phase history on the real store is BOOKKEEPING: 106 adoptions ("adotada: a subtarefa já estava
 * em revisao_lider…"), 107 release declarations made after the fact and 75 reconcile moves, against 4 live dispatches.
 * Round 1 timed those entries as stage visits: "leader" came out at a 1.3 h median and "ci" at 12 min (the seconds
 * between an adoption and a declaration), so every piece sitting in review was overdue and the rest were projected at
 * the 15-minute floor; round 1 had also switched the stage ceilings off once whole-piece publications existed.
 */

const NOW = Date.parse('2026-11-13T07:40:00Z')
const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()

/** A record exactly as the real store writes one for an adopted legacy piece later declared in a release. */
const adoptedThenDeclared = (adoptedAt: number, declaredAt: number) => [
  { from: 'fila', to: 'revisao_lider', at: iso(adoptedAt), actor: 'flow:entrega', detail: 'adotada: a subtarefa já estava em revisao_lider no quadro quando o fluxo a conheceu' },
  { from: 'revisao_lider', to: 'ci', at: iso(declaredAt), actor: 'flow:reconcile', detail: 'release 2.201.0 declarada por flow:reconcile (merge db7bf2f38, agentistics/agentistics)' },
  { from: 'ci', to: 'publicado', at: iso(declaredAt), actor: 'flow:reconcile', detail: 'release 2.201.0 verde e tag 2.201.0 publicada' },
]

describe('record trails time only what was observed live', () => {
  test('an adopted piece declared in a release later gives NO measured visit', () => {
    const t = recordTrailOf(adoptedThenDeclared(NOW - 30 * H, NOW - 30 * H + 40_000), NOW - 30 * H + 40_000)
    expect(t.map(v => v.stage)).toEqual(['leader', 'ci', 'published'])
    expect(stageTypicals([t, t, t, t])).toEqual({})
  })
  test('a leader declaring a release by hand (session actor) is bookkeeping too', () => {
    const t = recordTrailOf([
      { from: 'fila', to: 'ci', at: iso(NOW - 5 * H), actor: '4d5d2f3215', detail: 'release v2.201.2 declarada por 4d5d2f3215 (merge 05fa4d6af, agentistics/agentistics)' },
      { from: 'ci', to: 'publicado', at: iso(NOW - 5 * H), actor: '4d5d2f3215', detail: 'release v2.201.2 verde e tag v2.201.2 publicada' },
    ], NOW - 5 * H)
    expect(stageTypicals([t, t, t])).toEqual({})
  })
  test('transitions the flow observed live are still measured', () => {
    const trails = [0, 1, 2].map(i => recordTrailOf([
      { from: 'fila', to: 'executando', at: iso(NOW - (20 + i) * H), actor: 's1', detail: 'sessão abc aberta pelo pré-dispatch' },
      { from: 'executando', to: 'qa', at: iso(NOW - (12 + i) * H), actor: 's1', detail: 'handback' },
      { from: 'qa', to: 'revisao_lider', at: iso(NOW - (8 + i) * H), actor: 's2', detail: 'APROVADO' },
      { from: 'revisao_lider', to: 'publicado', at: iso(NOW - 2 * H), actor: 'flow:entrega', detail: 'tag publicada' },
    ], NOW - 2 * H))
    const typ = stageTypicals(trails)
    expect(typ.running?.n).toBe(3)
    expect(typ.qa?.n).toBe(3)
    expect(typ.leader?.n).toBe(3)
  })
})

function detail(subtasks: unknown[], sessions: unknown[]): TaskDetail {
  return {
    task: { id: 't1', title: 'Task', status: 'in_progress', createdAt: iso(NOW - 999 * H), updatedAt: iso(NOW - H) },
    attempts: [], rollup: {} as never, stats: {} as never, comments: [], commentThreads: [], threads: [], files: [],
    subtaskRollups: [], times: { startedAt: null, completedAt: null, durationMs: null, activeMinutes: null, source: null },
    subtasks, sessions,
  } as unknown as TaskDetail
}

describe('the QA store shape: published pieces whose records are all adoption + declaration', () => {
  const subs = [1, 2, 3, 4, 5].map(i => ({ id: `p${i}`, taskId: 't1', title: `P${i}`, done: true, status: 'done', createdAt: iso(NOW - 300 * H), updatedAt: iso(NOW - 20 * H) }))
  const d = detail(subs, subs.map((s, i) => ({ id: `s${i}`, harness: 'claude', cwd: '/x', attemptId: null, subtaskId: s.id, createdAt: iso(NOW - 200 * H), model: 'opus', tokens: null, costUSD: null, rounds: null })))
  ;(d as unknown as { subtaskRollups: unknown[] }).subtaskRollups = subs.map((s, i) => ({ id: s.id, times: { source: 'sessions', startedAt: iso(NOW - (100 + 10 * i) * H), completedAt: iso(NOW - 40 * H), durationMs: (60 + 10 * i) * H, activeMinutes: 60 } }))
  const deliveries = new Map(subs.map((s, i) => [s.id, {
    phase: 'publicado', publishedAt: iso(NOW - (30 - i) * H), history: adoptedThenDeclared(NOW - (60 + i) * H, NOW - (30 - i) * H),
  }]))
  const h = prepareForecastHistory({ details: [d], events: [], nowMs: NOW, deliveries: deliveries as never })

  test('no stage typical is invented from bookkeeping', () => {
    expect(h.typicals.leader).toBeUndefined()
    expect(h.typicals.ci).toBeUndefined()
  })

  test('open pieces get FUTURE ETAs spread by stage and by how long they have sat there', () => {
    const fc = (stage: 'leader' | 'running' | 'merge', sinceH: number) => resolvePieceForecast({
      nowMs: NOW, startedAtMs: NOW - (sinceH + 10) * H, stage, sinceMs: NOW - sinceH * H, origin: null,
      harness: 'claude', model: 'opus', cohorts: h.cohorts, typicals: h.typicals,
    })
    const cases = [fc('leader', 2), fc('leader', 30), fc('leader', 60), fc('running', 5), fc('merge', 3)]
    const stageAt = cases.map(c => (c.stageEta.kind === 'estimate' ? c.stageEta.atMs : NaN))
    const publishAt = cases.map(c => (c.publishEta.kind === 'estimate' ? c.publishEta.atMs : NaN))
    for (const at of [...stageAt, ...publishAt]) expect(at).toBeGreaterThan(NOW + 15 * 60_000)
    // spread: not one instant — five pieces, five different stage ETAs
    expect(new Set(stageAt).size).toBe(5)
    // the stage ETA is never after the publication
    cases.forEach((c, i) => expect(stageAt[i]!).toBeLessThanOrEqual(publishAt[i]!))
  })

  test('a piece past its stage ceiling is overdue, one well inside it is not', () => {
    const fresh = resolvePieceForecast({ nowMs: NOW, startedAtMs: NOW - 12 * H, stage: 'leader', sinceMs: NOW - 2 * H, origin: null, harness: 'claude', model: 'opus', cohorts: h.cohorts, typicals: h.typicals })
    expect(fresh.publishEta.kind).toBe('estimate')
    const stale = resolvePieceForecast({ nowMs: NOW, startedAtMs: NOW - 200 * H, stage: 'leader', sinceMs: NOW - 100 * H, origin: null, harness: 'claude', model: 'opus', cohorts: h.cohorts, typicals: h.typicals })
    expect(stale.publishEta).toMatchObject({ kind: 'none', reason: 'beyond-range' })
  })
})

describe('board events that measured something outrank a LONGER record trail of bookkeeping', () => {
  test('3 events with real durations beat 4 bookkeeping record entries', () => {
    const subs = [1, 2, 3, 4].map(i => ({ id: `q${i}`, taskId: 't1', title: `Q${i}`, done: true, status: 'done', createdAt: iso(NOW - 300 * H), updatedAt: iso(NOW - 20 * H) }))
    const d = detail(subs, subs.map((s, i) => ({ id: `s${i}`, harness: 'claude', cwd: '/x', attemptId: null, subtaskId: s.id, createdAt: iso(NOW - 200 * H), model: 'opus', tokens: null, costUSD: null, rounds: null })))
    ;(d as unknown as { subtaskRollups: unknown[] }).subtaskRollups = subs.map(s => ({ id: s.id, times: { source: 'sessions', startedAt: iso(NOW - 100 * H), completedAt: iso(NOW - 30 * H), durationMs: 70 * H, activeMinutes: 60 } }))
    const events = subs.flatMap((s, i) => [
      { id: `${s.id}-a`, taskId: 't1', subtaskId: s.id, actor: 'x', kind: 'status', to: 'in_progress', at: iso(NOW - (60 + i) * H) },
      { id: `${s.id}-b`, taskId: 't1', subtaskId: s.id, actor: 'x', kind: 'status', to: 'in_review', at: iso(NOW - 50 * H) },
      { id: `${s.id}-c`, taskId: 't1', subtaskId: s.id, actor: 'x', kind: 'status', to: 'done', at: iso(NOW - 40 * H) },
    ])
    const deliveries = new Map(subs.map(s => [s.id, {
      phase: 'publicado', publishedAt: iso(NOW - 30 * H),
      history: [
        { from: 'fila', to: 'fila', at: iso(NOW - 35 * H), actor: 'flow:entrega', detail: 'dequeue: board status is in_review; this piece is no longer queued' },
        ...adoptedThenDeclared(NOW - 33 * H, NOW - 30 * H),
        { from: 'publicado', to: 'publicado', at: iso(NOW - 29 * H), actor: 'flow:reconcile', detail: 'reconciliação' },
      ],
    }]))
    const h = prepareForecastHistory({ details: [d], events: events as never, nowMs: NOW, deliveries: deliveries as never })
    expect(h.typicals.leader).toMatchObject({ n: 4, medianMs: 10 * H })
    expect(h.typicals.running?.n).toBe(4)
  })
})

describe('a stage WITH measured history still answers from it, not from the ceiling', () => {
  test('measured leader typical (3 h) → the stage ETA is ~3 h after entering, not +3 days', () => {
    const samples: Sample[] = [10, 12, 14].map((x, i) => ({ key: `k${i}`, harness: 'codex', model: 'luna', taskType: null, endpoint: 'publication', startedAtMs: NOW - 40 * H, completedAtMs: NOW - 30 * H, durationMs: x * H }))
    const f = resolvePieceForecast({
      nowMs: NOW, startedAtMs: NOW - 5 * H, stage: 'leader', sinceMs: NOW - H, origin: null, harness: 'codex', model: 'luna', samples,
      typicals: { leader: { medianMs: 3 * H, p25Ms: 2.5 * H, p75Ms: 3.5 * H, n: 5 } },
    })
    expect(f.stageEta.kind).toBe('estimate')
    if (f.stageEta.kind === 'estimate') expect(f.stageEta.atMs).toBeLessThan(NOW + 6 * H)
  })
})

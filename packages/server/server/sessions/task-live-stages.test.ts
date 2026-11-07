import { describe, expect, test } from 'bun:test'
import {
  blockOf, buildLive, ciSignalOf, stageOfStatus, stepOf, estimateStages, nextStageOf, stageTypicals, trailOf, type StageTypical, type StageVisit,
} from './task-live'
import { describeLive, workerWord, type FleetRowLite } from './task-live-view'
import type { TaskDetail } from './task-report'
import type { TaskEvent } from './task-model'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const H = 3600_000, MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

function detail(over: Partial<TaskDetail> & { subtasks: TaskDetail['subtasks']; sessions: TaskDetail['sessions'] }, task: object = {}): TaskDetail {
  return {
    task: { id: 't1', title: 'Task one', status: 'in_progress', createdAt: iso(NOW - 52 * 24 * H), updatedAt: iso(NOW - H), startedAt: iso(NOW - 52 * 24 * H), ...task },
    attempts: [], rollup: {} as never, stats: {} as never, comments: [], commentThreads: [], threads: [], files: [],
    subtaskRollups: [], times: { startedAt: iso(NOW - 52 * 24 * H), completedAt: null, durationMs: null, activeMinutes: null, source: 'status' },
    ...over,
  } as TaskDetail
}
const sub = (id: string, status: string, extra: object = {}) => ({
  id, taskId: 't1', title: `Sub ${id}`, done: status === 'done', status, createdAt: iso(NOW - 50 * H), updatedAt: iso(NOW - 2 * H), ...extra,
})
const sess = (id: string, subtaskId: string | null, extra: object = {}) => ({
  id, harness: 'claude', cwd: '/x', attemptId: null, subtaskId, createdAt: iso(NOW - 3 * H), model: 'opus',
  tokens: null, costUSD: null, rounds: null, ...extra,
})
const ev = (id: string, at: number, extra: Partial<TaskEvent>): TaskEvent => ({ id, taskId: 't1', actor: 'x', kind: 'status', at: iso(at), ...extra })

describe('"total" is the piece\'s real work, never the task\'s age', () => {
  test('a 52-day-old task with a piece started 90 minutes ago reports 90 minutes', () => {
    const r = buildLive({
      nowMs: NOW, events: [],
      details: [detail({
        subtasks: [sub('a', 'in_progress')] as never,
        sessions: [sess('s1', 'a', { createdAt: iso(NOW - 90 * MIN) })] as never,
        subtaskRollups: [{ id: 'a', times: { startedAt: iso(NOW - 90 * MIN), completedAt: null, durationMs: null, activeMinutes: null, source: 'sessions' } }] as never,
      })],
    })
    const d = r.deliveries[0]!
    expect(d.workMs).toBe(90 * MIN)
    expect(d.startedAtMs).toBe(NOW - 90 * MIN)
  })
  test('a piece with no session falls back to nothing, not to the task\'s 52 days', () => {
    const r = buildLive({
      nowMs: NOW, events: [],
      details: [detail({ subtasks: [sub('g', 'in_review')] as never, sessions: [] })],
    })
    const d = r.deliveries[0]!
    expect(d.workMs).toBeNull()
    expect(d.startedAtMs).toBeNull()
  })
  test('measured active minutes win over the wall span', () => {
    const r = buildLive({
      nowMs: NOW, events: [],
      details: [detail({
        subtasks: [sub('a', 'in_progress')] as never,
        sessions: [sess('s1', 'a', { createdAt: iso(NOW - 5 * H) })] as never,
        subtaskRollups: [{ id: 'a', times: { startedAt: iso(NOW - 5 * H), completedAt: null, durationMs: null, activeMinutes: 42, source: 'sessions' } }] as never,
      })],
    })
    expect(r.deliveries[0]!.workMs).toBe(42 * MIN)
  })
})

describe('the stage trail and the two estimates', () => {
  const visit = (stage: StageVisit['stage'], enteredMs: number, ms: number): StageVisit => ({ stage, enteredMs, ms })
  test('trailOf walks the status events and runs the last visit to now', () => {
    const t = trailOf([
      ev('1', NOW - 6 * H, { to: 'in_progress' }), ev('2', NOW - 3 * H, { to: 'in_review' }), ev('3', NOW - 3 * H + 1, { kind: 'comment', detail: 'x' }),
    ], NOW)
    expect(t.map(v => [v.stage, v.ms])).toEqual([['running', 3 * H], ['leader', 3 * H]])
  })
  test('typicals need three closed visits and ignore the open one', () => {
    const trails = [1, 2, 3].map(i => [visit('running', 0, i * H), visit('leader', i * H, 99 * H)])
    const t = stageTypicals(trails)
    expect(t.running).toMatchObject({ medianMs: 2 * H, n: 3 })
    expect(t.leader).toBeUndefined()
  })
  const typ = (m: number, n = 5): StageTypical => ({ medianMs: m, p75Ms: m * 1.5, n })
  test('next stage ETA = stage start + typical; publication sums the stages still ahead', () => {
    const e = estimateStages({
      stage: 'running', origin: null, sinceMs: NOW - 30 * MIN, nowMs: NOW,
      typicals: { running: typ(2 * H), qa: typ(H), leader: typ(30 * MIN), merge: typ(20 * MIN), ci: typ(10 * MIN) }, totalEta: { kind: 'none', reason: 'no-history' },
    })
    expect(e.stageEta).toMatchObject({ kind: 'estimate', atMs: NOW - 30 * MIN + 2 * H, nextStage: 'qa' })
    expect(e.publishEta).toMatchObject({ kind: 'estimate', source: 'stages', atMs: NOW - 30 * MIN + 2 * H + H + 30 * MIN + 20 * MIN + 10 * MIN })
  })
  test('a stage with no history says so; the whole-piece estimate answers publication and says where it came from', () => {
    const e = estimateStages({
      stage: 'qa', origin: null, sinceMs: NOW - 10 * MIN, nowMs: NOW, typicals: {},
      totalEta: { kind: 'estimate', atMs: NOW + 3 * H, plusMinusMs: 1, confidence: 'low', basis: { n: 4, scope: 'harness', harness: 'claude', model: null, medianMs: 1 } },
    })
    expect(e.stageEta).toEqual({ kind: 'none', reason: 'no-history' })
    expect(e.publishEta).toMatchObject({ kind: 'estimate', source: 'total', atMs: NOW + 3 * H, n: 4 })
  })
  test('past the typical range there is no number, and the typical time travels with the refusal', () => {
    const e = estimateStages({ stage: 'running', origin: null, sinceMs: NOW - 9 * H, nowMs: NOW, typicals: { running: typ(H) }, totalEta: { kind: 'none', reason: 'no-history' } })
    expect(e.stageEta).toMatchObject({ kind: 'none', reason: 'beyond-range', typicalMs: H })
  })
  test('published has nothing left to estimate; blocked returns to its origin', () => {
    expect(estimateStages({ stage: 'published', origin: null, sinceMs: NOW, nowMs: NOW, typicals: {}, totalEta: { kind: 'none', reason: 'no-history' } }).stageEta).toEqual({ kind: 'none', reason: 'final' })
    expect(nextStageOf('blocked', 'qa')).toBe('qa')
    expect(nextStageOf('adjust')).toBe('leader')
    expect(nextStageOf('merge')).toBe('ci')
    expect(nextStageOf('ci')).toBe('published')
  })
})

describe('CI · publicando and the per-stage step', () => {
  test('a status worded CI · publicando is its own stage, between merge and published', () => {
    expect(stageOfStatus('ci_gate', 'CI · publicando')).toBe('ci')
    expect(stageOfStatus('s1', 'PR / merge')).toBe('merge')
    expect(stageOfStatus('s2', 'Publicado')).toBe('published')
  })
  test('the signal is rendered from a field the flow states, never invented', () => {
    expect(ciSignalOf({ releaseGreen: true, tag: 'v2.200.8', pr: 1351 })).toEqual({ mergedMain: true, releaseGreen: true, tagPublished: false, tag: 'v2.200.8', pr: 1351 })
    expect(ciSignalOf(undefined)).toBeNull()
    expect(ciSignalOf('x')).toBeNull()
    const r = buildLive({
      nowMs: NOW, events: [],
      details: [detail({ subtasks: [sub('a', 'ci_gate')] as never, sessions: [sess('s1', 'a')] as never })],
    })
    // an unplaced custom status without a label is not a stage; with the label it is, and carries an honest "not yet" signal
    const r2 = buildLive({ nowMs: NOW, events: [], statusLabel: id => (id === 'ci_gate' ? 'CI · publicando' : undefined), details: [detail({ subtasks: [sub('a', 'ci_gate')] as never, sessions: [sess('s1', 'a')] as never })] })
    expect(r.deliveries[0]!.stage).toBe('running') // live session fallback: not guessed into CI
    expect(r2.deliveries[0]).toMatchObject({ stage: 'ci', ci: { mergedMain: true, releaseGreen: false, tagPublished: false } })
  })
  test('the step is the newest `step` event of THIS stage; nothing reported means null', () => {
    const e = (id: string, at: number, to: string): TaskEvent => ({ id, taskId: 't1', actor: 'x', kind: 'step', at: iso(at), to })
    expect(stepOf([e('1', NOW - H, '2'), e('2', NOW - 10 * MIN, '3')], NOW - 2 * H)).toBe(3)
    expect(stepOf([e('1', NOW - 3 * H, '4')], NOW - 2 * H)).toBeNull() // from an earlier stage
    expect(stepOf([], null)).toBeNull()
    expect(stepOf([e('1', NOW, 'x')], null)).toBeNull()
  })
})

describe('Bloqueado', () => {
  test('a blocked status is its own stage and carries who lifts it and where it returns', () => {
    const r = buildLive({
      nowMs: NOW,
      events: [ev('1', NOW - 5 * H, { subtaskId: 'a', to: 'in_review' }), ev('2', NOW - 2 * H, { subtaskId: 'a', to: 'blocked' })],
      details: [detail({ subtasks: [sub('a', 'blocked')] as never, sessions: [sess('s1', 'a')] as never }, {})],
    })
    const d = r.deliveries[0]!
    expect(d.stage).toBe('blocked')
    expect(d.block).toMatchObject({ originStage: 'leader', unlocker: 'leader', reason: 'pedido_de_bloqueio' })
  })
  test('reasons: exact code, words, sibling dependency; only the owner-reserved one is the owner\'s', () => {
    expect(blockOf({ text: 'decisao_do_dono: assinatura Apple', dependsOn: 0, originStage: null })).toMatchObject({ reason: 'decisao_do_dono', unlocker: 'owner', text: 'assinatura Apple' })
    expect(blockOf({ text: 'todas as contas em 90% do limite', dependsOn: 0, originStage: null })).toMatchObject({ reason: 'limite', unlocker: 'leader' })
    expect(blockOf({ text: null, dependsOn: 2, originStage: null })).toMatchObject({ reason: 'dependencia', unlocker: 'self' })
    expect(blockOf({ text: 'memória abaixo de 2 GB', dependsOn: 0, originStage: null }).reason).toBe('maquina')
    expect(blockOf({ text: 'CI do GitHub fora', dependsOn: 0, originStage: null }).reason).toBe('externo')
  })
})

describe('a card never leaves without a word (item r) — one test per path that drops a piece', () => {
  const hiddenOf = (subs: object[], sessions: object[] = [], events: TaskEvent[] = []) =>
    buildLive({ nowMs: NOW, events, details: [detail({ subtasks: subs as never, sessions: sessions as never })] }).hidden
  test('running with its sessions ended -> no-live-session', () => {
    expect(hiddenOf([sub('a', 'in_progress')], [sess('s1', 'a', { endedAt: iso(NOW - MIN) })])).toEqual([
      expect.objectContaining({ key: 't1/a', reason: 'no-live-session', stage: 'running' }),
    ])
  })
  test('a status nobody can place -> status-unplaced (recent only; backlog/abandoned never)', () => {
    expect(hiddenOf([sub('a', 'zebra', { updatedAt: iso(NOW - H) })])).toEqual([expect.objectContaining({ reason: 'status-unplaced' })])
    expect(hiddenOf([sub('a', 'zebra', { updatedAt: iso(NOW - 40 * H) })])).toEqual([])
    expect(hiddenOf([sub('a', 'abandoned', { updatedAt: iso(NOW - H) }), sub('b', 'backlog', { updatedAt: iso(NOW - H) })])).toEqual([])
  })
  test('published more than 24 h ago -> published-old (and a year-old one is not worth a line)', () => {
    const h = hiddenOf([sub('a', 'done', { deliveredAt: iso(NOW - 30 * H) }), sub('b', 'done', { deliveredAt: iso(NOW - 400 * 24 * H) })])
    expect(h.map(x => [x.key, x.reason])).toEqual([['t1/a', 'published-old']])
  })
  test('queue entry that lost its staged session -> queue-idle', () => {
    expect(hiddenOf([sub('a', 'todo', { updatedAt: iso(NOW - H) })])).toEqual([expect.objectContaining({ reason: 'queue-idle', stage: 'queue' })])
    expect(hiddenOf([sub('a', 'todo', { updatedAt: iso(NOW - 30 * H) })])).toEqual([])
  })
  test('an on-the-line piece is never reported hidden', () => {
    expect(hiddenOf([sub('a', 'in_progress')], [sess('s1', 'a')])).toEqual([])
  })
  test('the reply is bounded', () => {
    const subs = Array.from({ length: 400 }, (_, i) => sub(`x${i}`, 'in_progress', { updatedAt: iso(NOW - H) }))
    expect(hiddenOf(subs).length).toBe(300)
  })
})

describe('the leaders band', () => {
  const row = (id: string, state: string, x: Partial<FleetRowLite> = {}): FleetRowLite => ({ id, title: id, harness: 'claude', state, ...x })
  const reply = (ds: object[]) => ({ generatedAt: 'x', deliveries: ds as never, samples: 0, hidden: [], sessionTasks: {} })
  test('the last action is a sentence, never JSON, and the leader carries its effort', () => {
    const v = describeLive({
      reply: reply([]),
      rows: [
        row('L', 'working', { title: '[ LÍDER ] - Motor', effort: 'high', lastLines: ['↳ {"message":{"to":"2ad6ecbd30","kind":"handback","from":"W1"}}'] }),
        row('W1', 'waiting', { title: 'LIVE.LIDERES · cartões', parentSessionId: 'L' }),
      ],
      leaderIds: new Set(['L']), nowMs: NOW, lang: 'pt',
    })
    expect(v.leaders[0]).toMatchObject({ effort: 'high', currentAction: 'handback de LIVE.LIDERES · cartões' })
    expect(JSON.stringify(v.leaders[0])).not.toContain('"kind"')
  })
  test('a worker sitting idle after delivering is not "waiting for you"', () => {
    expect(workerWord('waiting', 'leader')).toBe('awaiting-review')
    expect(workerWord('waiting', 'qa')).toBe('delivered')
    expect(workerWord('waiting', 'running')).toBe('idle')
    expect(workerWord('waiting-approval', 'running')).toBe('needs-you')
    expect(workerWord('working', 'qa')).toBe('working')
    expect(workerWord('waiting', 'blocked')).toBe('blocked')
    expect(workerWord('waiting-approval', 'blocked')).toBe('needs-you')
  })
  test('a leader\'s own filing is not a column card', () => {
    const d = { key: 't1', taskId: 't1', taskTitle: 'Engine', subtaskId: null, title: 'Engine', status: 'in_progress', stage: 'running', stageSinceMs: 0, startedAtMs: 0, sessionIds: ['L'], harnesses: [], models: [], efforts: [], eta: { kind: 'none', reason: 'no-history' }, workMs: null, trail: [], stageEta: { kind: 'none', reason: 'no-history' }, publishEta: { kind: 'none', reason: 'no-history' }, block: null, lastAction: null, blockedReason: null, deliveredAtMs: null }
    const v = describeLive({ reply: reply([d]), rows: [row('L', 'working')], leaderIds: new Set(['L']), nowMs: NOW })
    expect(v.deliveries).toEqual([])
    expect(v.leaders[0]!.taskId).toBe('t1')
  })
})

describe('FLUXO.ENTREGA-DSL: the Live is a projection of the delivery record', () => {
  test('the record phase decides the stage, over the board status', () => {
    const r = buildLive({
      nowMs: NOW, events: [],
      details: [detail({ subtasks: [sub('a', 'in_progress')] as never, sessions: [sess('s1', 'a')] as never })],
      deliveries: new Map([['a', { phase: 'qa' }]]),
    })
    expect(r.deliveries[0]!.stage).toBe('qa')
    expect(r.deliveries[0]!.phase).toBe('qa')
  })
  test('a blocked record carries its own reason and origin; CI reads the record signal', () => {
    const blocked = buildLive({
      nowMs: NOW, events: [],
      details: [detail({ subtasks: [sub('a', 'blocked')] as never, sessions: [] })],
      deliveries: new Map([['a', { phase: 'bloqueado', origin: 'pr_merge', block: { reason: 'fora_das_autorizacoes', text: 'Apple' } }]]),
    }).deliveries[0]!
    expect(blocked.block).toMatchObject({ reason: 'fora_das_autorizacoes', unlocker: 'leader', originStage: 'merge' })
    const ci = buildLive({
      nowMs: NOW, events: [],
      details: [detail({ subtasks: [sub('a', 'ci')] as never, sessions: [] })],
      deliveries: new Map([['a', { phase: 'ci', ci: { mergedMain: true, releaseGreen: true, tagPublished: false, tag: 'v2.200.8', pr: 9 } }]]),
    }).deliveries[0]!
    expect(ci.ci).toEqual({ mergedMain: true, releaseGreen: true, tagPublished: false, tag: 'v2.200.8', pr: 9 })
  })
  test('a queued piece shows its pre-dispatch and the expected slot', () => {
    const q = buildLive({
      nowMs: NOW, events: [],
      details: [detail({ subtasks: [sub('a', 'todo', { stagedSession: { prompt: 'p', harness: 'codex', model: 'gpt-5.5', effort: 'high', account: 'acc_2' } })] as never, sessions: [] })],
      deliveries: new Map([['a', { phase: 'fila', gates: { vaga: { ok: false, reason: 'no slot: 4 workers running (machine ceiling 4)', at: iso(NOW) } } }]]),
    }).deliveries[0]!
    expect(q.stage).toBe('queue')
    expect(q.staged).toEqual({ harness: 'codex', model: 'gpt-5.5', effort: 'high', account: 'acc_2' })
    expect(q.slot).toMatchObject({ ok: false })
  })
})

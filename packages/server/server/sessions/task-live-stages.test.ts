import { describe, expect, test } from 'bun:test'
import {
  ARCHIVED_CAP, HIDDEN_CAP, awaitingApprovalOf, blockOf, buildLive, ciSignalOf, estimateEta, legacyReviewShas, shasIn, stageOfStatus, stepOf, estimateStages, nextStageOf, stageTypicals, trailOf, type StageTypical, type StageVisit,
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

describe('every delivery carries the Agentask priority (a subtask has none of its own: it inherits its task\'s)', () => {
  const live = (task: object) => buildLive({
    nowMs: NOW, events: [],
    details: [detail({ subtasks: [sub('a', 'in_progress')] as never, sessions: [sess('s1', 'a')] as never }, task)],
  }).deliveries[0]!
  test('the task\'s priority reaches its subtask pieces and its own task-level piece', () => {
    expect(live({ priority: 'urgent' }).priority).toBe('urgent')
    expect(live({ priority: 'high' }).priority).toBe('high')
    const taskLevel = buildLive({ nowMs: NOW, events: [], details: [detail({ subtasks: [], sessions: [sess('s1', null)] as never }, { priority: 'medium' })] }).deliveries[0]!
    expect(taskLevel.priority).toBe('medium')
  })
  test('absent, the legacy none and a typo are low — never `none` and never medium', () => {
    expect(live({}).priority).toBe('low')
    expect(live({ priority: 'none' }).priority).toBe('low')
    expect(live({ priority: 'asap' }).priority).toBe('low')
  })
})

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
    // MED 4: the book alone proves nothing runs — wall time appears only through a live fleet agent (describeLive).
    expect(d.workMs).toBeNull()
    expect(d.startedAtMs).toBe(NOW - 90 * MIN)
    const live = describeLive({ reply: r, rows: [{ id: 's1', title: 's', harness: 'claude', state: 'working' }], leaderIds: new Set(), nowMs: NOW })
    expect(live.deliveries[0]!.workMs).toBe(90 * MIN)
    const gone = describeLive({ reply: r, rows: [], leaderIds: new Set(), nowMs: NOW })
    expect(gone.deliveries[0]!.workMs).toBeNull()
  })
  test('MED 4: a forgotten session the book thinks open for 33 days reads no total', () => {
    const r = buildLive({
      nowMs: NOW, events: [],
      details: [detail({
        subtasks: [sub('f', 'in_progress')] as never,
        sessions: [sess('old', 'f', { createdAt: iso(NOW - 33 * 24 * H) })] as never,
      })],
    })
    expect(r.deliveries[0]!.workMs).toBeNull()
    const v = describeLive({ reply: r, rows: [], leaderIds: new Set(), nowMs: NOW })
    expect(v.deliveries[0]!.workMs).toBeNull()
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
  test('published more than 24 h ago lands in history (newest first), a year-old one does not', () => {
    const r = buildLive({ nowMs: NOW, events: [], details: [detail({ subtasks: [
      sub('a', 'done', { deliveredAt: iso(NOW - 30 * H) }), sub('b', 'done', { deliveredAt: iso(NOW - 5 * 24 * H) }),
      sub('c', 'done', { deliveredAt: iso(NOW - 400 * 24 * H) }), sub('d', 'done', { deliveredAt: iso(NOW - 2 * H) }),
    ] as never, sessions: [] as never })] })
    expect((r.history ?? []).map(x => x.key)).toEqual(['t1/a', 't1/b'])
    expect(r.deliveries.map(x => x.key)).toEqual(['t1/d'])
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
  const reply = (ds: object[]) => ({ generatedAt: 'x', deliveries: ds as never, samples: 0, hidden: [], archived: [], archivedTotal: 0, sessionTasks: {} })
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
    const d = { key: 't1', taskId: 't1', taskTitle: 'Engine', subtaskId: null, title: 'Engine', status: 'in_progress', stage: 'running', stageSinceMs: 0, startedAtMs: 0, sessionIds: ['L'], harnesses: [], models: [], efforts: [], eta: { kind: 'none', reason: 'no-history' }, workMs: null, trail: [], stageEta: { kind: 'none', reason: 'no-history' }, publishEta: { kind: 'none', reason: 'no-history' }, block: null, lastAction: null, blockedReason: null, priority: 'low', deliveredAtMs: null }
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
  test('BLOQUEIO.ORFAO r3 · a TASK-level record (keyed by the task id) decides the stage of a task with no subtasks, as a subtask record does', () => {
    // The board still reads `blocked` (e.g. the deferral could not write it) but the record says the piece is back in the queue.
    const q = buildLive({
      nowMs: NOW, events: [],
      details: [detail({ subtasks: [], sessions: [sess('s1', null)] as never }, { status: 'blocked', blockedReason: 'esperando a chave' })],
      deliveries: new Map([['t1', { phase: 'fila' }]]),
    }).deliveries.find(d => d.subtaskId === null)!
    expect(q.stage).toBe('queue')
    expect(q.phase).toBe('fila')
    // and the same record in a real block carries its own reason, not the board's
    const b = buildLive({
      nowMs: NOW, events: [],
      details: [detail({ subtasks: [], sessions: [] }, { status: 'blocked' })],
      deliveries: new Map([['t1', { phase: 'bloqueado', origin: 'fila', block: { reason: 'externo', text: 'CI fora do ar' } }]]),
    }).deliveries.find(d => d.subtaskId === null)!
    expect(b.stage).toBe('blocked')
    expect(b.block).toMatchObject({ originStage: 'queue' })
    expect(b.phase).toBe('bloqueado')
  })
})

describe('estimates never contradict each other (MED 5)', () => {
  const typ = (medianMs: number): StageTypical => ({ medianMs, p75Ms: medianMs * 2, n: 5 })
  test('publication is never before the next stage when the stage sum is unknowable', () => {
    // `leader` has history, `merge`/`ci` do not -> publication falls back to the whole-piece estimate, which
    // used to land 30 min BEFORE the next-stage estimate.
    const r = estimateStages({
      stage: 'leader', origin: null, sinceMs: NOW - 10 * MIN, nowMs: NOW, typicals: { leader: typ(60 * MIN) },
      totalEta: { kind: 'estimate', atMs: NOW + 30 * MIN, plusMinusMs: 1, confidence: 'low', basis: { n: 4, scope: 'harness', harness: 'claude', model: null, medianMs: 1 } },
    })
    expect(r.stageEta.kind).toBe('estimate')
    expect(r.publishEta.kind).toBe('estimate')
    if (r.stageEta.kind === 'estimate' && r.publishEta.kind === 'estimate') expect(r.publishEta.atMs).toBeGreaterThanOrEqual(r.stageEta.atMs)
  })
  test('past the median it says slower than usual, never "now"', () => {
    const r = estimateStages({
      stage: 'leader', origin: null, sinceMs: NOW - 70 * MIN, nowMs: NOW, typicals: { leader: typ(60 * MIN) },
      totalEta: { kind: 'estimate', atMs: NOW, plusMinusMs: 1, confidence: 'low', basis: { n: 4, scope: 'harness', harness: 'claude', model: null, medianMs: 1 } },
    })
    expect(r.stageEta).toMatchObject({ kind: 'none', reason: 'beyond-range' })
    expect(r.publishEta).toMatchObject({ kind: 'none', reason: 'beyond-range' })
  })
  test('the whole-piece estimate is none (not "now") once the piece is past the median', () => {
    const samples = [1, 2, 3].map(i => ({ harness: 'claude', model: 'opus', durationMs: i * H }))
    expect(estimateEta({ nowMs: NOW, startedAtMs: NOW - 3 * H, harness: 'claude', model: 'opus', samples })).toMatchObject({ kind: 'none', reason: 'beyond-range' })
    const ok = estimateEta({ nowMs: NOW, startedAtMs: NOW - 30 * MIN, harness: 'claude', model: 'opus', samples })
    expect(ok.kind === 'estimate' && ok.atMs > NOW).toBe(true)
  })
})

describe('Publicado from a release tag, and the legacy review archive (HIGH 3)', () => {
  const reviewSub = (id: string, ageH: number, extra: object = {}) => sub(id, 'in_review', { updatedAt: iso(NOW - ageH * H), ...extra })
  test('shasIn reads a commit id the piece names and ignores a hex-looking word', () => {
    expect(shasIn('delivered in commit 41C546605 on the branch')).toEqual(['41c546605'])
    expect(shasIn('the decade deadbeef is a word')).toEqual([])
    expect(shasIn('sha: abcdef0123456789abcdef0123456789abcdef01')).toEqual(['abcdef0123456789abcdef0123456789abcdef01'])
  })
  test('a legacy in_review piece whose commit a release tag contains is Publicado', () => {
    const details = [detail({ subtasks: [reviewSub('p', 5, { notes: 'handback: sha 41c546605' })] as never, sessions: [] })]
    expect(legacyReviewShas(details, [])).toEqual(['41c546605'])
    const r = buildLive({ nowMs: NOW, events: [], details, publishedShas: new Set(['41c546605']) })
    expect(r.deliveries[0]).toMatchObject({ stage: 'published', status: 'in_review' })
    const not = buildLive({ nowMs: NOW, events: [], details, publishedShas: new Set() })
    expect(not.deliveries[0]).toMatchObject({ stage: 'leader' })
  })
  test('the delivered commit named in the subtask handback COMMENT counts (the real board keeps it there); a second sha beside an unpublished one does not publish', () => {
    const comment = (body: string, at: number) => ({ id: `c${at}`, taskId: 't1', subtaskId: 'p', author: 'w', body, createdAt: iso(NOW - at * H) })
    const mk = (comments: object[]) => [detail({ subtasks: [reviewSub('p', 5)] as never, sessions: [], comments: comments as never })]
    const details = mk([comment('old note: sha 1111111a', 9), comment('handback ok — commit db490b75, rebased on commit 41c546605', 6)])
    expect(legacyReviewShas(details, []).sort()).toEqual(['41c546605', 'db490b75']) // the OLDER comment's sha is not read
    expect(buildLive({ nowMs: NOW, events: [], details, publishedShas: new Set(['db490b75', '41c546605']) }).deliveries[0]).toMatchObject({ stage: 'published' })
    // only the second one is in a tag -> the delivered commit is not -> still review
    expect(buildLive({ nowMs: NOW, events: [], details, publishedShas: new Set(['41c546605']) }).deliveries[0]).toMatchObject({ stage: 'leader' })
    // an OLDER comment's sha does not publish a newer handback that names another commit
    expect(buildLive({ nowMs: NOW, events: [], details, publishedShas: new Set(['1111111a']) }).deliveries[0]).toMatchObject({ stage: 'leader' })
  })
  test('old legacy review cards with no live session and no published commit leave the column — counted and listed, never silent', () => {
    const subs = Array.from({ length: 80 }, (_, i) => reviewSub(`o${i}`, 100 + i))
    const r = buildLive({ nowMs: NOW, events: [], details: [detail({ subtasks: subs as never, sessions: [] })] })
    expect(r.deliveries).toHaveLength(0)
    expect(r.archivedTotal).toBe(80)
    expect(r.archived).toHaveLength(ARCHIVED_CAP)
    expect(r.archived[0]).toMatchObject({ reason: 'legacy-review-old', title: 'Sub o0' })
  })
  test('a fresh review card, or one with a live session, stays in Revisão do líder; a delivery record exempts it', () => {
    const details = [detail({
      subtasks: [reviewSub('fresh', 5), reviewSub('alive', 200), reviewSub('flow', 200)] as never,
      sessions: [sess('s', 'alive')] as never,
    })]
    const r = buildLive({ nowMs: NOW, events: [], details, deliveries: new Map([['flow', { phase: 'revisao_lider' }]]) })
    expect(r.deliveries.map(d => d.subtaskId).sort()).toEqual(['alive', 'flow', 'fresh'])
    expect(r.archivedTotal).toBe(0)
  })
})

describe('hidden is bounded NEWEST first, and a stale no-live-session piece is not a departure (LOW 14)', () => {
  test('the cap keeps the most recent', () => {
    const subs = Array.from({ length: HIDDEN_CAP + 20 }, (_, i) => sub(`n${i}`, 'in_progress', { updatedAt: iso(NOW - (i + 1) * 1000) }))
    const r = buildLive({ nowMs: NOW, events: [], details: [detail({ subtasks: subs as never, sessions: [] })] })
    expect(r.hidden).toHaveLength(HIDDEN_CAP)
    expect(r.hidden[0]!.title).toBe('Sub n0')
    expect(r.hidden.some(h => h.title === `Sub n${HIDDEN_CAP + 19}`)).toBe(false)
  })
  test('a piece untouched for days with no live session is not listed as having just left', () => {
    const r = buildLive({ nowMs: NOW, events: [], details: [detail({ subtasks: [sub('x', 'in_progress', { updatedAt: iso(NOW - 3 * 24 * H) })] as never, sessions: [] })] })
    expect(r.hidden).toHaveLength(0)
  })
})

describe('M5 — a human gate waiting on the owner is projected to the card', () => {
  const base = { phase: 'revisao_lider', revision: 4, humanGates: ['pr_merge'] }
  test('asked at this revision and unanswered → the card carries it', () => {
    expect(awaitingApprovalOf({ ...base, asked: { pr_merge: 4 } })).toEqual({ phase: 'pr_merge' })
  })
  test('never asked, asked at an older revision, or already answered → nothing', () => {
    expect(awaitingApprovalOf({ ...base })).toBeNull()
    expect(awaitingApprovalOf({ ...base, asked: { pr_merge: 3 } })).toBeNull()
    expect(awaitingApprovalOf({ ...base, asked: { pr_merge: 4 }, approvals: { pr_merge: { revision: 4, decision: 'approve' } } })).toBeNull()
    expect(awaitingApprovalOf(undefined)).toBeNull()
  })
})

describe('HOSTILE r3 re-QA (Opus) — BLOQUEIO.ORFAO, the Live side', () => {
  // LOW-1 (r3 re-QA): leader decision r4 — documented, not fixed in this batch.
  test.skip('HQ6 · a blocked TASK the Live shows as its own card (subtasks + a live direct session) is a piece the vigia discovers', async () => {
    const { blockedPiecesOf } = await import('../delivery/gates')
    const r = buildLive({
      nowMs: NOW, events: [],
      details: [detail({ subtasks: [sub('a', 'todo')] as never, sessions: [sess('d', null)] as never }, { status: 'blocked', blockedReason: 'esperando a chave' })],
    })
    const card = r.deliveries.find(d => d.subtaskId === null)
    expect(card?.stage).toBe('blocked') // the Live shows a Bloqueado card for the task itself
    const found = blockedPiecesOf({
      tasks: [{ id: 't1', title: 'Task one', status: 'blocked', updatedAt: iso(NOW - 30 * H), blockedReason: 'esperando a chave' }],
      subtasks: [{ id: 'a', taskId: 't1', title: 'Sub a', status: 'todo', updatedAt: iso(NOW - 2 * H) }],
    })
    expect(found.map(p => p.id)).toContain('t1')
  })

  test('HQ7 · a pure adoption the board released to In review leaves NO record behind, so the Live shows the board status (a review card)', () => {
    // r4: reconcileAdopted DELETES the pure adoption on release (service.test.ts covers it); with no record the Live reads the board.
    const control = buildLive({ nowMs: NOW, events: [], details: [detail({ subtasks: [sub('a', 'in_review')] as never, sessions: [] })] })
    expect(control.deliveries.find(d => d.subtaskId === 'a')?.stage).toBe('leader')
  })
})

import { describe, expect, test } from 'bun:test'
import { describeLive, liveSentence, type FleetRowLite } from './task-live-view'
import type { LiveDelivery, LiveReply } from './task-live'

const NOW = 1_000_000
const d = (over: Partial<LiveDelivery>): LiveDelivery => ({
  key: 't/a', taskId: 't', taskTitle: 'Task', subtaskId: 'a', title: 'Piece', status: 'in_progress', stage: 'running',
  stageSinceMs: 0, startedAtMs: 0, sessionIds: [], harnesses: [], models: [], eta: { kind: 'none', reason: 'no-history' },
  lastAction: null, blockedReason: null, deliveredAtMs: null, priority: 'low',
  workMs: null, efforts: [], trail: [], stageEta: { kind: 'none', reason: 'no-history' }, publishEta: { kind: 'none', reason: 'no-history' }, block: null, ci: null, step: null, ...over,
})
const reply = (ds: LiveDelivery[]): LiveReply => ({ generatedAt: 'x', deliveries: ds, samples: 0, hidden: [], sessionTasks: {} })
const row = (id: string, state: string, x: Partial<FleetRowLite> = {}): FleetRowLite => ({ id, title: id, harness: 'claude', state, ...x })

describe('describeLive', () => {
  test('joins agent state; a dialog waiting on a person is stalled', () => {
    const v = describeLive({
      reply: reply([d({ key: '1', sessionIds: ['a'] }), d({ key: '2', sessionIds: ['b'] })]),
      rows: [row('a', 'working', { model: 'opus', accountId: 'acc' }), row('b', 'waiting-approval')],
      leaderIds: new Set(), nowMs: NOW,
    })
    expect(v.deliveries[0]).toMatchObject({ liveState: 'working', stalled: false })
    expect(v.deliveries[0]!.agents[0]).toMatchObject({ model: 'opus', accountId: 'acc' })
    expect(v.deliveries[1]).toMatchObject({ liveState: 'needs-you', stalled: true })
    expect(v.summary).toMatchObject({ deliveries: 2, agentsWorking: 1, stalled: 1 })
  })
  test('review exposes only a same-task live leader, and failed fleet reads stay unknown', () => {
    const review = d({ key: 't/a', taskId: 't', taskTitle: 'Task', stage: 'leader' })
    const available = describeLive({ reply: reply([review]), rows: [row('lead', 'working', { task: 't' })], leaderIds: new Set(['lead']), nowMs: NOW })
    expect(available.deliveries[0]).toMatchObject({ leaderAvailability: 'available' })

    const otherTask = describeLive({ reply: reply([review]), rows: [row('other', 'working', { task: 'other-task' })], leaderIds: new Set(['other']), nowMs: NOW })
    expect(otherTask.deliveries[0]).toMatchObject({ leaderAvailability: 'absent', leaderAvailabilityReason: 'no live leader is filed on this task' })

    const dead = describeLive({ reply: reply([review]), rows: [row('lead', 'lost', { task: 't' })], leaderIds: new Set(['lead']), nowMs: NOW })
    expect(dead.deliveries[0]!.leaderAvailability).toBe('absent')

    const unknown = describeLive({ reply: reply([review]), rows: [], leaderIds: new Set(), fleetRead: 'unknown', nowMs: NOW })
    expect(unknown.deliveries[0]).toMatchObject({ leaderAvailability: 'unknown', leaderAvailabilityReason: 'leader availability could not be read from the fleet' })
  })
  test('filters: by task name, stage and stalled-only', () => {
    const ds = [d({ key: '1', taskTitle: 'Alpha', stage: 'qa' }), d({ key: '2', taskId: 'u', taskTitle: 'Beta', stage: 'running', blockedReason: 'x' }), d({ key: '3', stage: 'adjust', blockedReason: 'waits' })]
    const run = (filters: object) => describeLive({ reply: reply(ds), rows: [], leaderIds: new Set(), nowMs: NOW, filters }).deliveries.map(x => x.key)
    expect(run({ task: 'alp' })).toEqual(['1'])
    expect(run({ stage: 'qa' })).toEqual(['1'])
    expect(run({ stalledOnly: true })).toEqual(['3'])
  })
  test('the screen\'s tabs (same rules as the web): Em andamento = every open stage, Na fila, Publicado in its period, Tudo', () => {
    const H = 3600_000, NOWMS = 400 * H
    const ds = [
      d({ key: 'q', stage: 'queue' }), d({ key: 'b', stage: 'blocked' }), d({ key: 'r', stage: 'running', sessionIds: ['w'] }),
      d({ key: 'p', stage: 'published', deliveredAtMs: NOWMS - 2 * H }), d({ key: 'p3', stage: 'published', deliveredAtMs: NOWMS - 72 * H }),
    ]
    const hist = [d({ key: 'p40', stage: 'published', deliveredAtMs: NOWMS - 40 * 24 * H })]
    const old = [d({ key: 'o', stage: 'leader', old: true })]
    const view = (filters: object) => describeLive({
      reply: { ...reply(ds), history: hist, oldReviews: old }, rows: [row('w', 'working')], leaderIds: new Set(), nowMs: NOWMS, filters,
    })
    const keys = (filters: object) => view(filters).deliveries.map(x => x.key)
    expect(keys({ tab: 'active' })).toEqual(['b', 'r'])
    expect(keys({ tab: 'queue' })).toEqual(['q'])
    expect(keys({ tab: 'published' })).toEqual(['p'])
    expect(keys({ tab: 'published', period: '7d' })).toEqual(['p', 'p3'])
    expect(keys({ tab: 'published', period: 'all' })).toEqual(['p', 'p3', 'p40'])
    expect(keys({ tab: 'all', period: '7d' })).toEqual(['q', 'b', 'r', 'o', 'p', 'p3'])
    expect(keys({})).toEqual(keys({ tab: 'all' }))
    // The counts are the screen's tab numbers, and each equals the list that tab returns.
    const v = view({ tab: 'all', period: '7d' }).view
    expect(v.counts).toEqual({ active: 2, queue: 1, published: 2, all: 6 })
    for (const tab of ['active', 'queue', 'published', 'all'] as const) expect(view({ tab, period: '7d' }).deliveries).toHaveLength(v.counts[tab])
    // The old review never counts as active work.
    expect(view({ tab: 'all' }).summary.deliveries).toBe(3)
  })
  test('each stage is listed highest priority first (ties: longest in the stage); `sort` changes it', () => {
    const ds = [
      d({ key: 'low', stage: 'running', priority: 'low', stageSinceMs: 10 }), d({ key: 'urg', stage: 'running', priority: 'urgent', stageSinceMs: 900 }),
      d({ key: 'hi-old', stage: 'running', priority: 'high', stageSinceMs: 5 }), d({ key: 'hi-new', stage: 'running', priority: 'high', stageSinceMs: 50 }),
      d({ key: 'qa-low', stage: 'qa', priority: 'low' }), d({ key: 'qa-urg', stage: 'qa', priority: 'urgent' }),
    ]
    const run = (filters: object) => describeLive({ reply: reply(ds), rows: [], leaderIds: new Set(), nowMs: NOW, filters }).deliveries.map(x => x.key)
    expect(run({})).toEqual(['urg', 'hi-old', 'hi-new', 'low', 'qa-urg', 'qa-low'])
    expect(run({ sort: 'recent' })).toEqual(['urg', 'hi-new', 'low', 'hi-old', 'qa-low', 'qa-urg'].map(k => k))
    expect(run({ sort: 'time-in-stage' })).toEqual(['hi-old', 'low', 'hi-new', 'urg', 'qa-low', 'qa-urg'])
  })
  test('leaders are their own band, never a delivery: current action, workers, awaiting', () => {
    const v = describeLive({
      reply: reply([]),
      rows: [
        row('L', 'working', { lastLines: ['', '  reviewing PR #12  '] }),
        row('w1', 'working', { parentSessionId: 'L' }),
        row('w2', 'waiting-approval', { parentSessionId: 'L' }),
        row('other', 'working'),
      ],
      leaderIds: new Set(['L']), nowMs: NOW,
    })
    expect(v.leaders).toHaveLength(1)
    expect(v.leaders[0]).toMatchObject({ id: 'L', currentAction: 'reviewing PR #12' })
    expect(v.leaders[0]!.workers.map(w => w.id)).toEqual(['w1', 'w2'])
    expect(v.leaders[0]!.awaiting.map(a => a.id)).toEqual(['w2'])
    expect(v.deliveries).toEqual([])
  })
  test('sentence says what is known and does not invent an ETA', () => {
    const v = describeLive({ reply: reply([d({ sessionIds: ['a'] })]), rows: [row('a', 'working')], leaderIds: new Set(), nowMs: NOW })
    expect(liveSentence(v, NOW)).toBe('1 active delivery · 1 agent working · none stalled · no delivery has an estimate yet')
  })
})

describe('the leader model is the transcript\'s, not the harness default (MED 9)', () => {
  test('observedModel outranks the spawn model on leaders, workers and agents', () => {
    const v = describeLive({
      reply: reply([d({ key: 'k', sessionIds: ['w'] })]),
      rows: [
        row('L', 'working', { model: 'opus[1m]', observedModel: 'claude-opus-5-5' }),
        row('w', 'working', { parentSessionId: 'L', model: 'sonnet', observedModel: 'claude-sonnet-5-5' }),
      ],
      leaderIds: new Set(['L']), nowMs: NOW,
    })
    expect(v.leaders[0]!.model).toBe('claude-opus-5-5')
    expect(v.leaders[0]!.workers[0]!.model).toBe('claude-sonnet-5-5')
    expect(v.deliveries[0]!.agents[0]!.model).toBe('claude-sonnet-5-5')
  })
  test('LOW-6: when the cap cut older pieces the view says how many, and only where it matters', () => {
    const H = 3600_000, NOWMS = 400 * H
    const hist = [d({ key: 'p40', stage: 'published', deliveredAtMs: NOWMS - 40 * 24 * H })]
    const capped = { ...reply([]), history: hist, historyTotal: 5 }
    const v = (filters: object) => describeLive({ reply: capped, rows: [], leaderIds: new Set(), nowMs: NOWMS, filters }).view
    expect(v({ tab: 'published', period: 'all' }).capped).toEqual({ cap: 400, omitted: 4 })
    expect(v({ tab: 'all', period: 'all' }).capped).toEqual({ cap: 400, omitted: 4 })
    // 24 h: the oldest kept piece is already outside it, so nothing the cap cut could have been inside.
    expect(v({ tab: 'published', period: '24h' }).capped).toBeNull()
    expect(v({ tab: 'queue', period: 'all' }).capped).toBeNull()
    expect(describeLive({ reply: { ...reply([]), history: hist }, rows: [], leaderIds: new Set(), nowMs: NOWMS, filters: { period: 'all' } }).view.capped).toBeNull()
  })
  test('LOW-7: the view states the EFFECTIVE tab and period, and which were defaulted', () => {
    const run = (filters: object) => describeLive({ reply: reply([]), rows: [], leaderIds: new Set(), nowMs: NOW, filters }).view
    expect(run({})).toMatchObject({ tab: 'all', period: '24h', defaulted: ['tab', 'period'] })
    expect(run({ tab: 'queue' })).toMatchObject({ tab: 'queue', period: '24h', defaulted: ['period'] })
    expect(run({ tab: 'queue', period: '7d' }).defaulted).toEqual([])
  })
  test('LOW-8: a live worker on a piece published over 24 h ago is not listed as "published" under its leader', () => {
    const H = 3600_000, NOWMS = 400 * H
    const old = d({ key: 'old', stage: 'published', deliveredAtMs: NOWMS - 48 * H, sessionIds: ['w1'] })
    const fresh = d({ key: 'fresh', stage: 'published', deliveredAtMs: NOWMS - H, sessionIds: ['w2'] })
    const v = describeLive({
      reply: { ...reply([fresh]), history: [old] }, leaderIds: new Set(['L']), nowMs: NOWMS,
      rows: [row('L', 'working'), row('w1', 'working', { parentSessionId: 'L' }), row('w2', 'working', { parentSessionId: 'L' })],
    })
    const ws = v.leaders[0]!.workers
    expect(ws.find(w => w.id === 'w1')).toMatchObject({ stage: null, cardKey: null })
    expect(ws.find(w => w.id === 'w2')).toMatchObject({ stage: 'published', cardKey: 'fresh' })
  })
  test('with no observation the registry model stays, and none stays null', () => {
    const v = describeLive({ reply: reply([]), rows: [row('L', 'working', { model: 'opus' }), row('M', 'working')], leaderIds: new Set(['L', 'M']), nowMs: NOW })
    expect(v.leaders.map(l => l.model)).toEqual(['opus', null])
  })
})

describe('a leader working alone gets a card (LIVE.EM-ANDAMENTO-E-LIDER)', () => {
  const leaderPiece = d({ key: 't', subtaskId: null, title: 'Task', sessionIds: ['L'], startedAtMs: 1, stageSinceMs: 1, workMs: 99 })
  const run = (ds: LiveDelivery[], tab: 'all' | 'active' = 'active') => describeLive({
    reply: reply(ds), rows: [row('L', 'working', { createdMs: 777 })], leaderIds: new Set(['L']), nowMs: NOW, filters: { tab },
  })
  test('no open subtask piece: ONE card, marked, on the leader session\'s own clock, no invented estimate', () => {
    const v = run([leaderPiece])
    expect(v.deliveries).toHaveLength(1)
    expect(v.deliveries[0]).toMatchObject({ key: 't', leaderPiece: true, liveState: 'working', startedAtMs: 777, stageSinceMs: 777, workMs: null, eta: { kind: 'none' } })
    expect(v.view.counts.active).toBe(1)
  })
  test('an open subtask piece: the leader stays in the band, no duplicate card', () => {
    const v = run([leaderPiece, d({ key: 't/a', subtaskId: 'a', stage: 'queue' })], 'all')
    expect(v.deliveries.map(x => x.key)).toEqual(['t/a'])
  })
  test('only finished subtasks: the leader is doing the work, so it gets the card', () => {
    const v = run([leaderPiece, d({ key: 't/a', subtaskId: 'a', stage: 'published', deliveredAtMs: NOW }), d({ key: 't/b', subtaskId: 'b', stage: 'completed', deliveredAtMs: NOW })], 'all')
    expect(v.deliveries.map(x => x.key).sort()).toEqual(['t', 't/a', 't/b'])
    expect(v.deliveries.find(x => x.key === 't')!.leaderPiece).toBe(true)
  })
  // r2: the last subtask finishing rolls the task up to done; a LIVE leader filed on it keeps its one card.
  const doneTask = d({ key: 't', subtaskId: null, title: 'Task', status: 'done', stage: 'completed', sessionIds: ['L'], startedAtMs: 1, stageSinceMs: 1, deliveredAtMs: NOW })
  const finishedSub = d({ key: 't/a', subtaskId: 'a', stage: 'completed', deliveredAtMs: NOW })
  const runDone = (state: string) => describeLive({
    reply: reply([doneTask, finishedSub]), rows: [row('L', state, { createdMs: 777 })], leaderIds: new Set(['L']), nowMs: NOW, filters: { tab: 'active' },
  })
  for (const state of ['working', 'waiting', 'waiting-approval', 'idle']) {
    test(`task rolled up to done, leader ${state}: it keeps its one leader card`, () => {
      const v = runDone(state)
      expect(v.deliveries.map(x => x.key)).toEqual(['t'])
      expect(v.deliveries[0]).toMatchObject({ leaderPiece: true, stage: 'running', startedAtMs: 777 })
    })
  }
  test('task rolled up to done, leader exited or gone: no card (old tasks do not come back)', () => {
    expect(runDone('exited').deliveries).toEqual([])
    expect(runDone('lost').deliveries).toEqual([])
  })
  test('a done task with a live WORKER (no leader) gets no leader card', () => {
    const v = describeLive({ reply: reply([doneTask, finishedSub]), rows: [row('L', 'working')], leaderIds: new Set(), nowMs: NOW, filters: { tab: 'active' } })
    expect(v.deliveries).toEqual([])
  })
  test('a worker piece is never marked as a leader piece', () => {
    const v = describeLive({ reply: reply([d({ key: 'w', subtaskId: null, sessionIds: ['W'] })]), rows: [row('W', 'working')], leaderIds: new Set(), nowMs: NOW })
    expect(v.deliveries[0]!.leaderPiece).toBeUndefined()
  })
})

describe('Em andamento no longer needs an agent on the piece', () => {
  const run = (ds: LiveDelivery[]) => describeLive({ reply: reply(ds), rows: [], leaderIds: new Set(), nowMs: NOW, filters: { tab: 'active' } }).deliveries.map(x => x.key)
  test('blocked and adjusting with no agent are in; queue, published, completed and old stay out', () => {
    expect(run([
      d({ key: 'b', stage: 'blocked' }), d({ key: 'j', stage: 'adjust' }), d({ key: 'q', stage: 'queue' }),
      d({ key: 'p', stage: 'published', deliveredAtMs: NOW }), d({ key: 'c', stage: 'completed', deliveredAtMs: NOW }), d({ key: 'o', stage: 'leader', old: true }),
    ])).toEqual(['b', 'j'])
  })
})

describe('a leader filed directly on a subtask (owner scope addition)', () => {
  test('the subtask piece keeps its card (only task-level filings are dropped), its agent is the leader, and the task gets no extra card', () => {
    const sub = d({ key: 't/a', subtaskId: 'a', sessionIds: ['L'], startedAtMs: 5 })
    const v = describeLive({ reply: reply([sub, d({ key: 't', subtaskId: null, sessionIds: ['L'] })]), rows: [row('L', 'working', { createdMs: 9 })], leaderIds: new Set(['L']), nowMs: NOW, filters: { tab: 'active' } })
    expect(v.deliveries.map(x => x.key)).toEqual(['t/a'])
    // The web draws the Leader badge from "an agent of this card is a leader" (LiveDelivery roleOf).
    expect(v.deliveries[0]!.agents.map(a => a.id)).toEqual(['L'])
    expect(v.leaders.map(l => l.id)).toEqual(['L'])
  })
})

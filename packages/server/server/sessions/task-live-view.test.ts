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
const reply = (ds: LiveDelivery[]): LiveReply => ({ generatedAt: 'x', deliveries: ds, samples: 0, hidden: [], archived: [], archivedTotal: 0, sessionTasks: {} })
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
  test('filters: by task name, stage and stalled-only', () => {
    const ds = [d({ key: '1', taskTitle: 'Alpha', stage: 'qa' }), d({ key: '2', taskId: 'u', taskTitle: 'Beta', stage: 'running', blockedReason: 'x' }), d({ key: '3', stage: 'adjust', blockedReason: 'waits' })]
    const run = (filters: object) => describeLive({ reply: reply(ds), rows: [], leaderIds: new Set(), nowMs: NOW, filters }).deliveries.map(x => x.key)
    expect(run({ task: 'alp' })).toEqual(['1'])
    expect(run({ stage: 'qa' })).toEqual(['1'])
    expect(run({ stalledOnly: true })).toEqual(['3'])
  })
  test('the screen\'s switches (same rules as the web): "apenas ativas" is the stages after the queue, "exibir fila" the queue', () => {
    const ds = [d({ key: 'q', stage: 'queue' }), d({ key: 'b', stage: 'blocked' }), d({ key: 'r', stage: 'running' }), d({ key: 'p', stage: 'published', deliveredAtMs: 1 })]
    const run = (filters: object) => describeLive({ reply: reply(ds), rows: [], leaderIds: new Set(), nowMs: NOW, filters }).deliveries.map(x => x.key)
    expect(run({})).toEqual(['q', 'b', 'r', 'p'])
    expect(run({ onlyActive: true, showQueue: false })).toEqual(['b', 'r', 'p'])
    expect(run({ onlyActive: false, showQueue: true })).toEqual(['q'])
    expect(run({ onlyActive: false, showQueue: false })).toEqual([])
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
  test('with no observation the registry model stays, and none stays null', () => {
    const v = describeLive({ reply: reply([]), rows: [row('L', 'working', { model: 'opus' }), row('M', 'working')], leaderIds: new Set(['L', 'M']), nowMs: NOW })
    expect(v.leaders.map(l => l.model)).toEqual(['opus', null])
  })
})

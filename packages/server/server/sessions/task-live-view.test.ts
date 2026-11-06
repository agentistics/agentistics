import { describe, expect, test } from 'bun:test'
import { describeLive, liveSentence, type FleetRowLite } from './task-live-view'
import type { LiveDelivery, LiveReply } from './task-live'

const NOW = 1_000_000
const d = (over: Partial<LiveDelivery>): LiveDelivery => ({
  key: 't/a', taskId: 't', taskTitle: 'Task', subtaskId: 'a', title: 'Piece', status: 'in_progress', stage: 'running',
  stageSinceMs: 0, startedAtMs: 0, sessionIds: [], harnesses: [], models: [], eta: { kind: 'none', reason: 'no-history' },
  lastAction: null, blockedReason: null, deliveredAtMs: null, ...over,
})
const reply = (ds: LiveDelivery[]): LiveReply => ({ generatedAt: 'x', deliveries: ds, samples: 0 })
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

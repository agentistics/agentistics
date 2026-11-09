import { describe, expect, test } from 'bun:test'
import { describeLive } from './task-live-view'
import type { LiveDelivery, LiveReply } from './task-live'

/**
 * QA LIVE.FILTROS-V2 round 2 (48d03652a); fixed in round 3. `view.capped` is the whole board's number, but the sentence around it (tool description, screen) says
 * THIS answer's count is not the total. Measured on the copy of the real board, MCP and GET alike:
 *   task=t-9e7f358801  → published 62, recount from tasks.json 62, none of it cut, `capped {cap:400, omitted:109}`
 *   stage=queue        → 8 pieces, a stage the cap never touches, `capped {cap:400, omitted:109}`
 * A fix may need per-task totals on the reply: adjust the fixture if so, not the assertion.
 */
const H = 3600_000, NOW = 400 * H
const d = (over: Partial<LiveDelivery>): LiveDelivery => ({
  key: 't/a', taskId: 't', taskTitle: 'Task', subtaskId: 'a', title: 'Piece', status: 'done', stage: 'published',
  stageSinceMs: 0, startedAtMs: 0, sessionIds: [], harnesses: [], models: [], eta: { kind: 'none', reason: 'no-history' },
  lastAction: null, blockedReason: null, deliveredAtMs: NOW - 40 * 24 * H, priority: 'low',
  workMs: null, efforts: [], trail: [], stageEta: { kind: 'none', reason: 'no-history' }, publishEta: { kind: 'none', reason: 'no-history' }, block: null, ci: null,
  ...over,
} as LiveDelivery)

const capped = (filters: object) => describeLive({
  // 2 kept (both of task `kept`), 100 more existed: none of those is `kept`'s, because every one of its pieces is in the list.
  reply: { generatedAt: 'x', deliveries: [d({ key: 'q', taskId: 'kept', stage: 'queue', deliveredAtMs: null })], samples: 0, hidden: [], sessionTasks: {},
    history: [d({ key: 'a', taskId: 'kept' }), d({ key: 'b', taskId: 'kept' })], historyTotal: 102, cutByTask: { other: { title: 'Other', history: 100, oldReviews: 0 } } } as LiveReply,
  rows: [], leaderIds: new Set(), nowMs: NOW, filters,
}).view.capped

describe('the cap notice speaks of THIS answer', () => {
  test('sanity: no filter, the board\'s own cut is stated', () => expect(capped({ tab: 'all', period: 'all' })).toEqual({ cap: 400, omitted: 100 }))
  test('a stage the cap never touches claims no cut', () => expect(capped({ tab: 'all', period: 'all', stage: 'queue' })).toBeNull())
  test('a task that lost nothing to the cap claims no cut', () => expect(capped({ tab: 'published', period: 'all', task: 'kept' })).toBeNull())
})

/**
 * QA LIVE.FILTROS-V2 (e3dce1394): the screen's whole pipeline, server to columns, over one wire.
 *
 * `useLiveDeliveries` fetches a bare `/api/tasks/live`, so the route calls `describeLive` with no filters. The
 * screen then draws `joinLive([...deliveries, ...history, ...oldReviews])` through `filterCards`/`tabCounts`.
 * Whatever the wire carries, the screen's numbers for a period must equal what the MCP tool answers for it.
 *
 * `test.failing` marks the bugs this QA found: each one is RED in substance today, and the moment the bug is fixed bun
 * reports it as a failure so the fix has to turn it into a plain `test`. The DOM tests never saw this because they hand
 * the view a `reply` already holding `history`/`oldReviews`, a shape the server stopped sending.
 */
import { describe, expect, test } from 'bun:test'
import { describeLive } from './task-live-view'
import type { LiveDelivery, LiveReply } from './task-live'
import { byStage, filterCards, joinLive, orderColumns, tabCounts, type LiveDeliveryRecord } from '../../../web/src/components/tasks/liveDeliveryModel'

const H = 3600_000
const NOW = 2000 * H

const piece = (over: Partial<LiveDelivery> & { key: string; stage: LiveDelivery['stage'] }): LiveDelivery => ({
  taskId: 'T', taskTitle: 'Task', subtaskId: over.key, title: over.key, status: 'x',
  stageSinceMs: NOW - H, startedAtMs: NOW - 2 * H, sessionIds: [], harnesses: [], models: [], efforts: [],
  eta: { kind: 'none', reason: 'not-started' }, workMs: null, trail: [],
  stageEta: { kind: 'none' }, publishEta: { kind: 'none' }, block: null, ci: null, step: null, stepSource: null, stepSignal: null,
  lastAction: null, blockedReason: null, priority: 'low', deliveredAtMs: null, staged: null, slot: null, phase: null,
  awaitingApproval: null, queue: null,
  ...over,
} as unknown as LiveDelivery)

const REPLY: LiveReply = {
  generatedAt: new Date(NOW).toISOString(), samples: 0, hidden: [], sessionTasks: {},
  deliveries: [
    piece({ key: 'q', stage: 'queue' }),
    piece({ key: 'p2h', stage: 'published', deliveredAtMs: NOW - 2 * H }),
  ],
  history: [
    piece({ key: 'p3d', stage: 'published', deliveredAtMs: NOW - 72 * H }),
    piece({ key: 'p20d', stage: 'published', deliveredAtMs: NOW - 20 * 24 * H }),
    piece({ key: 'p60d', stage: 'published', deliveredAtMs: NOW - 60 * 24 * H }),
  ],
  oldReviews: [piece({ key: 'old', stage: 'leader', old: true })],
} as unknown as LiveReply

type P = '24h' | '7d' | '30d' | 'all'
/** What the browser holds after `fetch('/api/tasks/live?tab=all&period=<p>')` (the one request the screen makes), through JSON. */
const wire = (period: P) => JSON.parse(JSON.stringify(describeLive({ reply: REPLY, rows: [], leaderIds: new Set(), nowMs: NOW, filters: { tab: 'all', period } }))) as {
  deliveries: LiveDeliveryRecord[]
}
/** The cards exactly as `LiveDelivery.tsx` builds them. */
const screenCards = (period: P) => joinLive(wire(period).deliveries, [])

const drawn = (period: P) =>
  filterCards(screenCards(period), { taskIds: [], tab: 'published', period, nowMs: NOW }).map(c => c.d.key).sort()
const countsAgree = (period: P) => {
  const mcp = describeLive({ reply: REPLY, rows: [], leaderIds: new Set(), nowMs: NOW, filters: { tab: 'published', period } }).view.counts
  expect(tabCounts(screenCards(period), { taskIds: [], period, nowMs: NOW })).toEqual(mcp)
}

describe('HIGH: the Publicado period reaches the SCREEN', () => {
  test('24h: the Publicado tab draws the last 24 h', () => expect(drawn('24h')).toEqual(['p2h']))
  test('24h: the screen\'s counts equal the MCP tool\'s', () => countsAgree('24h'))
  test('7d: the Publicado tab draws what the period covers', () => expect(drawn('7d')).toEqual(['p2h', 'p3d']))
  test('7d: the screen\'s counts equal the MCP tool\'s', () => countsAgree('7d'))
  test('30d: the Publicado tab draws what the period covers', () => expect(drawn('30d')).toEqual(['p20d', 'p2h', 'p3d']))
  test('30d: the screen\'s counts equal the MCP tool\'s', () => countsAgree('30d'))
  test('all: the Publicado tab draws what the period covers', () => expect(drawn('all')).toEqual(['p20d', 'p2h', 'p3d', 'p60d']))
  test('all: the screen\'s counts equal the MCP tool\'s', () => countsAgree('all'))
  test('an old legacy review reaches the screen, in Tudo only', () => {
    const cards = screenCards('all')
    expect(filterCards(cards, { taskIds: [], tab: 'all', period: '24h', nowMs: NOW }).map(c => c.d.key)).toContain('old')
    for (const tab of ['active', 'queue', 'published'] as const) {
      expect(filterCards(cards, { taskIds: [], tab, period: 'all', nowMs: NOW }).map(c => c.d.key)).not.toContain('old')
    }
  })
})

describe('MED: an old legacy review does not bury the live ones', () => {
  // Real board, 08/11: Revisão do líder holds 239 cards, 201 old; the first 12 are all old and the last live one is at
  // position 238. Same priority ties on "longest in the stage", and an old one is old BY DEFINITION (over 72 h).
  test('in a column, every current card comes before the old ones, under the default sort', () => {
    const cards = joinLive([
      { ...piece({ key: 'current', stage: 'leader', stageSinceMs: NOW - H }) },
      { ...piece({ key: 'antiga', stage: 'leader', old: true, stageSinceMs: NOW - 800 * H }) },
    ] as unknown as LiveDeliveryRecord[], [])
    expect(orderColumns(byStage(cards), 'priority').leader.map(c => c.d.key)).toEqual(['current', 'antiga'])
  })
})

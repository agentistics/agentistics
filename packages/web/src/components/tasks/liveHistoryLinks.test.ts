import { describe, expect, test } from 'bun:test'
import { sessionLinks } from './liveSessionLinks'
import { joinLive, type LeaderRecord, type LiveDeliveryRecord } from './liveDeliveryModel'
import type { FleetRow } from '../../lib/fleet'

const NOW = new Date(2026, 10, 7, 12, 0, 0).getTime()
const H = 3600_000, D = 24 * H
const rec = (over: Partial<LiveDeliveryRecord> = {}): LiveDeliveryRecord => ({
  key: 't/a', taskId: 't', taskTitle: 'Task', subtaskId: 'a', title: 'Piece', status: 'done', stage: 'published',
  stageSinceMs: null, startedAtMs: null, sessionIds: [], harnesses: ['claude'], models: [], eta: { kind: 'none', reason: 'not-started' },
  lastAction: null, blockedReason: null, deliveredAtMs: null, ...over,
})
const row = (id: string, title = id): FleetRow => ({
  id, title, harness: 'claude', cwd: '/x', project: 'p', state: 'working', stateLabel: 'working', actionable: false, attachCommand: '', verbs: [],
})

describe('abrir sessão — author, QA and leader links', () => {
  const leader: LeaderRecord = {
    id: 'L', title: 'Motor', harness: 'claude', model: null, state: 'working', currentAction: null,
    workers: [{ id: 'w1', title: 'w1', state: 'working' }], awaiting: [],
  }
  test('one link per live session, role by who it is, the leader of the piece added', () => {
    const c = joinLive([rec({ stage: 'qa', sessionIds: ['w1', 'q1', 'gone'] })], [row('w1'), row('q1', 'QA da peça')])[0]!
    expect(sessionLinks(c, [row('w1'), row('q1', 'QA da peça'), row('L')], [leader])).toEqual([
      { role: 'author', id: 'w1' }, { role: 'qa', id: 'q1' }, { role: 'leader', id: 'L' },
    ])
  })
  test('no session the fleet carries -> no link at all', () => {
    const c = joinLive([rec({ sessionIds: ['x'] })], [])[0]!
    expect(sessionLinks(c, [], [])).toEqual([])
  })
})

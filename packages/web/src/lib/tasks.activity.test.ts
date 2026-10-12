import { describe, expect, test } from 'bun:test'
import { groupActivity, type TaskEvent } from './tasks'

const event = (id: string, kind: string, state?: TaskEvent['state'], at = id): TaskEvent => ({
  id, taskId: 'task', at, actor: 'leader', kind, ...(state ? { state } : {}),
})

describe('groupActivity', () => {
  test('collapses consecutive ok check-ins and keeps their order', () => {
    const result = groupActivity([event('3', 'checkin', 'ok'), event('2', 'checkin', 'ok'), event('1', 'status')])
    expect(result).toHaveLength(2)
    expect('grouped' in result[0]! && result[0].events.map(e => e.id)).toEqual(['3', '2'])
  })

  test('a different event breaks an ok run', () => {
    const result = groupActivity([event('4', 'checkin', 'ok'), event('3', 'status'), event('2', 'checkin', 'ok')])
    expect(result.map(e => e.id)).toEqual(['4', '3', '2'])
  })

  test('single ok and non-ok check-ins never become groups', () => {
    const result = groupActivity([event('3', 'checkin', 'resolved'), event('2', 'checkin', 'needs_you'), event('1', 'checkin', 'ok')])
    expect(result).toHaveLength(3)
    expect(result.every(e => !('grouped' in e))).toBe(true)
  })

  test('filter modes include all, hide check-ins, or only check-ins', () => {
    const events = [event('3', 'checkin', 'ok'), event('2', 'status'), event('1', 'checkin', 'resolved')]
    expect(groupActivity(events, 'all').map(e => e.kind)).toEqual(['checkin', 'status', 'checkin'])
    expect(groupActivity(events, 'without-checkins').map(e => e.kind)).toEqual(['status'])
    expect(groupActivity(events, 'only-checkins').map(e => e.kind)).toEqual(['checkin', 'checkin'])
  })
})

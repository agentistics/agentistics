import { expect, test } from 'bun:test'
import { fleetLiveRows, fleetLiveUrl } from './fleetLiveGet'

test('idle revalidation and new-session lookup accept compact and old servers', () => {
  expect(fleetLiveUrl('en')).toBe('/api/fleet?lang=en&format=compact-v1')
  expect(fleetLiveRows({ sessions: [{ id: 'new', state: 'waiting' }] })).toEqual([{ id: 'new', state: 'waiting' }])
  expect(fleetLiveRows({ rows: [{ id: 'old', state: 'waiting' }], sessions: [{ id: 'different' }] })).toEqual([{ id: 'old', state: 'waiting' }])
  expect(fleetLiveRows({})).toEqual([])
})

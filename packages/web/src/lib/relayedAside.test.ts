import { expect, test } from 'bun:test'
import { relayedTabAvailable } from './relayedAside'

test('only the metrics tab is filled on a central; every tab that reads the machine is not', () => {
  expect(relayedTabAvailable('metrics')).toBe(true)
  for (const id of ['live', 'gallery', 'skills', 'agents', 'forks', 'workflows', 'mcps', 'prs', 'tasks'] as const) {
    expect(relayedTabAvailable(id)).toBe(false)
  }
})

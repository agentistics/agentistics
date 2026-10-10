import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { markUpgradeRunningForTest, releaseOnFailure, upgradeInFlight } from './upgrade-web'

test('a failed upgrade child clears the busy flag', () => {
  const c = new EventEmitter()
  markUpgradeRunningForTest()
  releaseOnFailure(c)
  expect(upgradeInFlight()).toBe(true)
  c.emit('exit', 1)
  expect(upgradeInFlight()).toBe(false)
})
test('a successful exit keeps it', () => {
  const c = new EventEmitter()
  markUpgradeRunningForTest()
  releaseOnFailure(c)
  c.emit('exit', 0)
  expect(upgradeInFlight()).toBe(true)
})

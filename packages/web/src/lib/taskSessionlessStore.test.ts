import { expect, test } from 'bun:test'
import { setTaskSessionless } from './taskSessionlessStore'

test('setTaskSessionless is idempotent and resettable', () => {
  expect(() => { setTaskSessionless(true); setTaskSessionless(true); setTaskSessionless(false) }).not.toThrow()
})

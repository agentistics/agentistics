import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { startDataRefresh } from './dataRefresh'

beforeAll(() => GlobalRegistrator.register({ width: 390, height: 844 }))
afterAll(async () => GlobalRegistrator.unregister())

test('the default DOM path arms, rearms and clears REAL timers without a foreign receiver', async () => {
  // Happy DOM binds its globals, so unlike browser WebIDL it accepts a foreign receiver. Enforce
  // that receiver contract while delegating every operation to the real timers, with real time.
  // No timers option is passed to startDataRefresh: this must exercise its production defaults.
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  let armed = 0, cleared = 0, reads = 0
  globalThis.setTimeout = function (this: unknown, ...args: Parameters<typeof setTimeout>) {
    if (this !== undefined && this !== globalThis && this !== window) throw new TypeError('Illegal invocation')
    armed++
    return realSet(...args)
  } as typeof setTimeout
  globalThis.clearTimeout = function (this: unknown, ...args: Parameters<typeof clearTimeout>) {
    if (this !== undefined && this !== globalThis && this !== window) throw new TypeError('Illegal invocation')
    cleared++
    return realClear(...args)
  } as typeof clearTimeout
  let stop: (() => void) | undefined
  try {
    stop = startDataRefresh({ working: true, document, window, refresh: () => { reads++ }, healthy: () => false, pause: () => {} })
    expect(armed).toBe(1)
    window.dispatchEvent(new Event('focus'))
    expect(reads).toBe(1)
    expect(armed).toBe(2)
    expect(cleared).toBe(1)
    stop(); stop = undefined
    expect(cleared).toBe(2)
    // Yield through a real timer after disposal; the removed focus handler cannot rearm a poll.
    await new Promise<void>(resolve => realSet(resolve, 20))
    window.dispatchEvent(new Event('focus'))
    expect(reads).toBe(1)
    expect(armed).toBe(2)
  } finally {
    stop?.()
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
})

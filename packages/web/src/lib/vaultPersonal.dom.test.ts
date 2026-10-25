import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { CLIPBOARD_CLEAR_MS, copyWithAutoClear } from './vaultPersonal'

beforeAll(() => GlobalRegistrator.register({ width: 390, height: 844 }))
afterAll(async () => GlobalRegistrator.unregister())

test('default clipboard auto-clear uses REAL browser timers without a foreign receiver', async () => {
  // Happy DOM binds timers. Enforce browser receiver validity while still scheduling and clearing
  // real timers; no timers argument or fake clock is supplied to copyWithAutoClear.
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const delays: (number | undefined)[] = []
  const writes: string[] = []
  let clears = 0
  globalThis.setTimeout = function (this: unknown, ...args: Parameters<typeof setTimeout>) {
    if (this !== undefined && this !== globalThis && this !== window) throw new TypeError('Illegal invocation')
    delays.push(args[1])
    return realSet(...args)
  } as typeof setTimeout
  globalThis.clearTimeout = function (this: unknown, ...args: Parameters<typeof clearTimeout>) {
    if (this !== undefined && this !== globalThis && this !== window) throw new TypeError('Illegal invocation')
    clears++
    return realClear(...args)
  } as typeof clearTimeout
  let copy: ReturnType<typeof copyWithAutoClear> | undefined
  try {
    copy = copyWithAutoClear('test clipboard text', { writeText: async text => { writes.push(text) } })
    expect(await copy.done).toBe(true)
    expect(writes).toEqual(['test clipboard text'])
    expect(delays).toEqual([CLIPBOARD_CLEAR_MS])
    copy.cancel(); copy = undefined
    expect(clears).toBe(1)
    expect(writes).toEqual(['test clipboard text', ''])
    await new Promise<void>(resolve => realSet(resolve, 20))
    expect(writes).toEqual(['test clipboard text', ''])
    expect(delays).toEqual([30_000])
  } finally {
    copy?.cancel()
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
})

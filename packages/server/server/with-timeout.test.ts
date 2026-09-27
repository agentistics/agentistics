import { test, expect } from 'bun:test'
import { heapStats } from 'bun:jsc'
import { withTimeout, type TimerFns } from './with-timeout'

/** Injected timers, so the test sees exactly what is armed and what is cleared. */
function fakeTimers() {
  const armed = new Map<number, () => void>()
  let next = 1
  const cleared: number[] = []
  const timers: TimerFns = {
    set: (fn, _ms) => { const id = next++; armed.set(id, fn); return id },
    clear: id => { cleared.push(id as number); armed.delete(id as number) },
  }
  return { timers, armed, cleared }
}

test('a promise that RESOLVES clears its timer — nothing is left holding the result', async () => {
  const { timers, armed, cleared } = fakeTimers()
  const big = { payload: 'x'.repeat(1000) }
  expect(await withTimeout(Promise.resolve(big), 300_000, 'late', timers)).toBe(big)
  expect(cleared).toEqual([1])
  expect(armed.size).toBe(0)
})

test('a promise that REJECTS clears its timer too, and the rejection passes through', async () => {
  const { timers, armed, cleared } = fakeTimers()
  await expect(withTimeout(Promise.reject(new Error('boom')), 300_000, 'late', timers)).rejects.toThrow('boom')
  expect(cleared).toEqual([1])
  expect(armed.size).toBe(0)
})

test('a promise that outlives the deadline rejects with the given message', async () => {
  const { timers, armed } = fakeTimers()
  const out = withTimeout(new Promise<never>(() => {}), 300_000, 'Request timed out after 5 minutes', timers)
  armed.get(1)!()
  await expect(out).rejects.toThrow('Request timed out after 5 minutes')
})

test('with the REAL timers, no Timeout survives a settled call', async () => {
  // The defect this pins: a bare `Promise.race([work, new Promise(r => setTimeout(reject, 300_000))])`
  // leaves the timer armed for five minutes after `work` settles, and the timer's closure chain
  // (timer -> reject -> the race's reactions -> the race promise) keeps the RESULT alive with it —
  // one full ApiResponse per build, measured at 481 MB of heap before the timers expired.
  //
  // A cleared Timeout's cell is freed lazily, so a handful may still be counted right after a GC
  // (measured 2-5 of 200). The bare race leaves ALL of them (measured 202 of 200), so the bound is
  // set far from both: one armed timer per call is what fails it.
  const timeouts = () => { Bun.gc(true); return (heapStats().objectTypeCounts as Record<string, number>).Timeout ?? 0 }
  const before = timeouts()
  for (let i = 0; i < 100; i++) {
    await withTimeout(Promise.resolve(i), 300_000, 'late')
    await withTimeout(Promise.reject(new Error('x')), 300_000, 'late').catch(() => {})
  }
  await Bun.sleep(10)
  expect(timeouts() - before).toBeLessThan(40)
})

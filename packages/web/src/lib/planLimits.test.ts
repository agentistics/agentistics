import { afterEach, expect, spyOn, test } from 'bun:test'
// The store follows the shared SSE stream; nothing streams in a unit test.
;(globalThis as { EventSource?: unknown }).EventSource ??= class { addEventListener() {} removeEventListener() {} close() {} }
import * as events from './eventStream'
import * as store from './planLimits'
const { __setPlanLimitsForTest, failureOfStatus, FETCH_TIMEOUT_MS, planLimitsSnapshot, retryDelayMs, subscribePlanLimits } = store

test('first-answer retry backs off and is capped', () => {
  expect([0, 1, 2, 3].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000])
  expect(retryDelayMs(10)).toBe(15_000)
})

test('a refusal is final; anything else is worth retrying', () => {
  expect(failureOfStatus(401)).toBe('unauthorized')
  expect(failureOfStatus(403)).toBe('unavailable')
  expect(failureOfStatus(404)).toBe('unavailable')
  expect(failureOfStatus(500)).toBe('slow')
  expect(failureOfStatus(503)).toBe('slow')
})

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; __setPlanLimitsForTest(null) })
const settle = () => new Promise(r => setTimeout(r, 20))

for (const status of [401, 403, 404]) test(`${status} stops the store: one request and no retry`, async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response('{}', { status }) }) as unknown as typeof fetch
  const off = subscribePlanLimits(() => {})
  await settle()
  expect(planLimitsSnapshot()).toMatchObject({ limits: null, failure: status === 401 ? 'unauthorized' : 'unavailable' })
  await new Promise(r => setTimeout(r, 1_200)) // past the first backoff step
  expect(calls).toBe(1)
  off()
})

test('a request that throws (timeout, dropped connection) says "slow" and keeps the answer pending', async () => {
  globalThis.fetch = (async () => { throw new DOMException('timed out', 'TimeoutError') }) as unknown as typeof fetch
  const off = subscribePlanLimits(() => {})
  await settle()
  expect(planLimitsSnapshot()).toMatchObject({ limits: null, failure: 'slow' })
  off()
})

test('an answer clears the failure', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ limits: [], budgets: [], readings: [] }), { status: 200 })) as unknown as typeof fetch
  const off = subscribePlanLimits(() => {})
  await settle()
  expect(planLimitsSnapshot()).toMatchObject({ limits: [], failure: null })
  off()
})


test('a hung fetch is aborted at the configured deadline and retries to a real answer', async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const deadline = spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(10))
  let calls = 0
  let signal: AbortSignal | null | undefined
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    calls++
    signal = init?.signal
    if (calls > 1) return Promise.resolve(new Response('{"limits":[]}'))
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }))
  }) as typeof fetch
  const off = subscribePlanLimits(() => {})
  try {
    await settle()
    expect(deadline).toHaveBeenCalledWith(10_000)
    expect(FETCH_TIMEOUT_MS).toBe(10_000)
    expect(signal?.aborted).toBe(true)
    expect(planLimitsSnapshot()).toMatchObject({ limits: null, failure: 'slow' })
    await new Promise(r => setTimeout(r, 1_100))
    expect(calls).toBe(2)
    expect(planLimitsSnapshot()).toMatchObject({ limits: [], failure: null })
  } finally { off(); deadline.mockRestore() }
})


test('a refusal also cancels a retry already scheduled by an earlier failure', async () => {
  const handlers = new Map<string, (event: MessageEvent) => void>()
  const subscribe = spyOn(events, 'subscribeEvent').mockImplementation((type, handler) => {
    handlers.set(type, handler)
    return () => { handlers.delete(type) }
  })
  let calls = 0
  globalThis.fetch = (async () => new Response('{}', { status: ++calls === 1 ? 500 : 403 })) as unknown as typeof fetch
  const off = subscribePlanLimits(() => {})
  try {
    await settle()
    expect(planLimitsSnapshot().failure).toBe('slow')
    handlers.get('plan-limits')!({} as MessageEvent)
    await settle()
    expect(planLimitsSnapshot().failure).toBe('unavailable')
    await new Promise(r => setTimeout(r, 1_100))
    expect(calls).toBe(2)
  } finally { off(); subscribe.mockRestore() }
})

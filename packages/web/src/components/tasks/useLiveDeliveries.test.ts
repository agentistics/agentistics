import { afterEach, expect, test } from 'bun:test'
import { cachedLiveReply, LIVE_CACHE_MAX_AGE_MS, prefetchLiveReply, resetLiveCache } from './useLiveDeliveries'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; resetLiveCache() })

test('prefetch reads the line once at a time and the cache then answers at once', async () => {
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ generatedAt: 'x', deliveries: [], samples: 0 }), { status: 200 }) }) as unknown as typeof fetch
  expect(cachedLiveReply()).toBeNull()
  await Promise.all([prefetchLiveReply(), prefetchLiveReply()])
  expect(calls).toBe(1)
  expect(cachedLiveReply()).toMatchObject({ generatedAt: 'x' })
})

test('a stale cache is not served, and a failed prefetch stays silent', async () => {
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  await prefetchLiveReply()
  expect(cachedLiveReply(Date.now() + LIVE_CACHE_MAX_AGE_MS + 1000)).toBeNull()
  resetLiveCache()
  globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
  await prefetchLiveReply()
  expect(cachedLiveReply()).toBeNull()
})

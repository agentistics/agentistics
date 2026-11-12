import { afterEach, expect, test } from 'bun:test'
import { classifyRouteError, fetchRouteJson, retryBackoffMs } from './routeTransport'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('classifies network and HTTP failures without leaking route errors to global state', () => {
  expect(classifyRouteError(new TypeError('Failed to fetch')).kind).toBe('unreachable')
  expect(classifyRouteError(undefined, 503)).toMatchObject({ kind: 'server', status: 503 })
  expect(classifyRouteError(undefined, 404).kind).toBe('refused')
})

test('the route deadline covers a response whose body never arrives', async () => {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    await new Promise<void>(resolve => (init?.signal as AbortSignal).addEventListener('abort', () => resolve(), { once: true }))
    throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }) as unknown as typeof fetch
  await expect(fetchRouteJson('/slow', { timeoutMs: 5, hardTimeoutMs: 10 })).rejects.toMatchObject({ kind: 'timeout' })
})

test('slow deadline only reports slow; a later response still renders', async () => {
  globalThis.fetch = (async () => {
    await new Promise(resolve => setTimeout(resolve, 15))
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch
  let slow = false
  await expect(fetchRouteJson<{ ok: boolean }>('/slow', { timeoutMs: 5, hardTimeoutMs: 100, onSlow: () => { slow = true } })).resolves.toEqual({ ok: true })
  expect(slow).toBe(true)
})

test('retry backoff is bounded and increases between attempts', () => {
  expect(retryBackoffMs(0)).toBe(250)
  expect(retryBackoffMs(3)).toBeGreaterThan(retryBackoffMs(2))
  expect(retryBackoffMs(99)).toBe(4000)
})

import { describe, expect, test } from 'bun:test'
import { fetchFleetNewWithRetry } from './fleetNewRetry'

describe('fetchFleetNewWithRetry', () => {
  test('retries non-OK responses and returns the first successful body', async () => {
    let calls = 0
    const body = await fetchFleetNewWithRetry<{ ok: boolean }>('/api/fleet/new', {
      maxAttempts: 3, retryDelaysMs: [0], sleep: async () => {},
      fetchImpl: async () => {
        calls += 1
        return calls === 3
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response('', { status: 503 })
      },
    })
    expect(calls).toBe(3)
    expect(body).toEqual({ ok: true })
  })

  test('stops immediately when its signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await expect(fetchFleetNewWithRetry('/api/fleet/new', {
      signal: controller.signal, fetchImpl: async () => { calls += 1; return new Response('{}') },
    })).rejects.toBeDefined()
    expect(calls).toBe(0)
  })

  test('aborts a request that exceeds the per-attempt timeout', async () => {
    let aborted = false
    await expect(fetchFleetNewWithRetry('/api/fleet/new', {
      timeoutMs: 1, maxAttempts: 1,
      fetchImpl: async (_url, init) => await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
      }),
    })).rejects.toBeDefined()
    expect(aborted).toBe(true)
  })
})

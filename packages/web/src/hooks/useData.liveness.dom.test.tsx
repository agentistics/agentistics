import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useData } from './useData'
import { eventStream } from '../lib/eventStream'
import { LIVENESS_MS, LIVENESS_TIMEOUT_MS } from '../lib/startupLoad'
import { setFinaleForTest } from '../lib/finaleGate'

const realFetch = globalThis.fetch
const realInterval = globalThis.setInterval
const realTimeout = globalThis.setTimeout
let root: Root | undefined
let subscription: ReturnType<typeof spyOn>
let seen: ReturnType<typeof useData>
function Probe() { seen = useData(); return null }

beforeAll(() => {
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  subscription = spyOn(eventStream, 'subscribe').mockReturnValue(() => {})
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  globalThis.fetch = realFetch
  globalThis.setInterval = realInterval
  globalThis.setTimeout = realTimeout
  localStorage.clear()
  document.body.innerHTML = ''
})
afterAll(async () => { subscription.mockRestore(); await GlobalRegistrator.unregister() })

async function mountHealthProbe() {
  let probe: (() => void) | undefined
  let deadline: (() => void) | undefined
  let mode: 'busy' | 'offline' | 'ok' = 'busy'
  let checks = 0
  globalThis.setInterval = ((callback: () => void, ms?: number) => {
    if (ms === LIVENESS_MS) probe = callback
    return realInterval(callback, ms)
  }) as typeof setInterval
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    if (ms === LIVENESS_TIMEOUT_MS) deadline = callback
    return realTimeout(callback, ms)
  }) as typeof setTimeout
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    if (url === '/api/health') {
      checks++
      if (mode === 'offline') return Promise.reject(new TypeError('Failed to fetch'))
      if (mode === 'busy') return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }
    return Promise.resolve(Response.json(String(url).startsWith('/api/data')
      ? { statsCache: {}, sessions: [], projects: [] } : { ok: true }))
  }) as typeof fetch
  setFinaleForTest({ active: false, updatedAt: null })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Probe />))
  expect(seen.data).not.toBeNull()
  return {
    checks: () => checks,
    tick: async (next: typeof mode) => {
      mode = next
      await act(async () => { probe!(); if (mode === 'busy') deadline!() })
    },
  }
}

test('a health deadline under connection contention stays unknown; actual connection failures still show offline and recover', async () => {
  const health = await mountHealthProbe()
  await health.tick('busy')
  expect(health.checks()).toBe(1)
  expect(seen.offline).toBeNull()
  await health.tick('ok')
  expect(seen.offline).toBeNull()
  await health.tick('offline')
  expect(seen.offline?.kind).toBe('unreachable')
  await health.tick('ok')
  expect(seen.offline).toBeNull()
})

test('three consecutive health deadlines report a hung server; any answer resets the timeout streak', async () => {
  const health = await mountHealthProbe()
  await health.tick('busy')
  await health.tick('busy')
  expect(seen.offline).toBeNull()
  await health.tick('ok')
  await health.tick('busy')
  await health.tick('busy')
  expect(seen.offline).toBeNull()
  await health.tick('busy')
  expect(seen.offline?.kind).toBe('unreachable')
  await health.tick('ok')
  expect(seen.offline).toBeNull()
  await health.tick('busy')
  await health.tick('busy')
  expect(seen.offline).toBeNull()
})

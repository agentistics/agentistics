import { afterEach, expect, test } from 'bun:test'
import type { CleanScanState, CleanWebPlan } from '@agentistics/core'
import { backgroundCleanScan, cancelCleanScan, finalizeCleanScan, readCleanScan, startCleanScan, subscribeCleanScan } from './cleanScan'
const originalFetch = globalThis.fetch
const scan: CleanScanState = { id: 'scan', state: 'scanning', step: 2, label: 'measuring', progress: .4, etaMs: 1000, startedAt: 1, elapsedMs: 10,
  foundBytes: 4096, itemCount: 1, projectCount: 0, projectTotal: 1, log: [], background: false }
const plan: CleanWebPlan = { scanId: 'scan', scannedAt: 100, elapsedMs: 99, items: [], reclaimable: { bytes: 0, count: 0 } }
let unsubscribe: (() => void) | undefined
function respond(fn: (path: string, method: string) => unknown | Promise<unknown>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const value = await fn(String(input), init?.method ?? 'GET')
    return Response.json(value)
  }) as typeof fetch
}
afterEach(async () => {
  unsubscribe?.(); unsubscribe = undefined
  respond(() => ({ ok: true }))
  await finalizeCleanScan()
  globalThis.fetch = originalFetch
})
test('starts only on the plan request, sends background/cancel as POST and exposes live progress', async () => {
  const calls: string[] = []
  respond((path, method) => {
    calls.push(`${method} ${path}`)
    if (path.endsWith('/background')) return { ...scan, background: true }
    if (path.endsWith('/cancel')) return { ...scan, state: 'cancelled' }
    return scan
  })
  await startCleanScan()
  expect(readCleanScan().scan?.progress).toBe(.4)
  await backgroundCleanScan()
  expect(readCleanScan().scan?.background).toBe(true)
  await cancelCleanScan()
  expect(readCleanScan().scan?.state).toBe('cancelled')
  expect(calls).toEqual(['GET /api/clean/plan', 'POST /api/clean/background', 'POST /api/clean/cancel'])
})
test('opening a ready plan retains its scan identity and finalize forgets the result', async () => {
  respond(() => plan)
  await startCleanScan()
  expect(readCleanScan().plan?.scanId).toBe('scan')
  respond(() => ({ ok: true }))
  await finalizeCleanScan()
  expect(readCleanScan()).toEqual({ scan: null, plan: null, error: false })
})
test('a delayed poll cannot resurrect a finalized scan, and polling never starts a new scan', async () => {
  let release!: (value: unknown) => void
  const paths: string[] = []
  respond(path => {
    paths.push(path)
    if (path.endsWith('/scan')) return new Promise(resolve => { release = resolve })
    return { ok: true }
  })
  unsubscribe = subscribeCleanScan(() => {})
  await finalizeCleanScan()
  release({ ...scan, state: 'ready' })
  // Let the in-memory Response body and its promise continuations drain.
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(readCleanScan().scan).toBeNull()
  expect(paths).toEqual(['/api/clean/scan', '/api/clean/finalize'])
})

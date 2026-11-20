import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import { harnessPollDelay, HARNESS_POLL_FAST_MS, HARNESS_POLL_SLOW_MS } from './useChatHarnesses'

let createRoot: typeof import('react-dom/client').createRoot
let useChatHarnesses: typeof import('./useChatHarnesses').useChatHarnesses
const originalFetch = globalThis.fetch
let polls = 0
let ready = false
let reloadRef: (() => void) | null = null

beforeAll(async () => {
  GlobalRegistrator.register({ width: 1280, height: 800 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async () => {
    polls++
    return Response.json([
      { id: 'claude', label: 'claude', installed: true, authReady: true, ready: true, models: [], defaultModel: '', setup: {} },
      { id: 'codex', label: 'codex', installed: true, authReady: ready, ready, models: [], defaultModel: '', setup: {} },
    ])
  }) as unknown as typeof fetch
  createRoot = (await import('react-dom/client')).createRoot
  useChatHarnesses = (await import('./useChatHarnesses')).useChatHarnesses
})
afterAll(async () => { globalThis.fetch = originalFetch; await GlobalRegistrator.unregister() })
afterEach(() => { jest.useRealTimers() })

function Probe() { reloadRef = useChatHarnesses(true).reload; return null }
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}
// Stepped by one second: timers a tick schedules (and the state they set) must settle between steps.
const advance = async (ms: number) => { for (let left = ms; left > 0; left -= 1000) await act(async () => { jest.advanceTimersByTime(Math.min(1000, left)); await Promise.resolve() }); if (ms === 0) await act(async () => { await Promise.resolve() }) }

describe('harnessPollDelay', () => {
  test('4 s for the first 2 minutes, 30 s after', () => {
    expect(harnessPollDelay(0)).toBe(HARNESS_POLL_FAST_MS)
    expect(harnessPollDelay(119_999)).toBe(HARNESS_POLL_FAST_MS)
    expect(harnessPollDelay(120_000)).toBe(HARNESS_POLL_SLOW_MS)
  })
})

describe('useChatHarnesses polling with a harness installed but not signed in', () => {
  test('quick, then backs off; hidden tab polls nothing; visible/reload restore the quick cadence', async () => {
    jest.useFakeTimers()
    polls = 0; ready = false; setHidden(false)
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(createElement(Probe)))
      await advance(0)
      const first = polls
      expect(first).toBeGreaterThanOrEqual(1)

      // first two minutes: one poll per 4 s
      await advance(40_000)
      const fast = polls - first
      expect(fast).toBeGreaterThanOrEqual(9)
      expect(fast).toBeLessThanOrEqual(11)

      // after the window: one per 30 s
      await advance(100_000)
      const before = polls
      await advance(120_000)
      const slow = polls - before
      expect(slow).toBeGreaterThanOrEqual(3)
      expect(slow).toBeLessThanOrEqual(5)

      // hidden: nothing, however long (document.hidden guard)
      setHidden(true)
      await advance(0)
      const hiddenFrom = polls
      await advance(300_000)
      expect(polls - hiddenFrom).toBe(0)

      // visible again: an immediate re-check and the quick cadence is back
      setHidden(false)
      await advance(0)
      const resumed = polls
      expect(resumed - hiddenFrom).toBeGreaterThanOrEqual(1)
      await advance(20_000)
      expect(polls - resumed).toBeGreaterThanOrEqual(4)

      // slow again, then an explicit reload (picker opened) restores the quick cadence
      await advance(150_000)
      await advance(60_000)
      const slowAgain = polls
      await advance(60_000)
      expect(polls - slowAgain).toBeLessThanOrEqual(3)
      await act(async () => { reloadRef!(); await Promise.resolve() })
      const afterReload = polls
      await advance(20_000)
      expect(polls - afterReload).toBeGreaterThanOrEqual(4)

      // a sign-in is still picked up, and then everything stops
      ready = true
      await advance(40_000)
      const settled = polls
      await advance(300_000)
      expect(polls - settled).toBe(0)
    } finally { setHidden(false); await act(async () => root.unmount()); host.remove() }
  })
})

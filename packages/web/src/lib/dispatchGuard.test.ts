import { describe, expect, it } from 'bun:test'
import { endDispatch, tryBeginDispatch, type DispatchGuard } from './dispatchGuard'

describe('tryBeginDispatch / endDispatch', () => {
  it('the first call begins and returns true', () => {
    const guard: DispatchGuard = { current: false }
    expect(tryBeginDispatch(guard)).toBe(true)
    expect(guard.current).toBe(true)
  })

  it('a second call while still dispatching is refused, and does not disturb the guard', () => {
    // The exact race this guard exists to close: two click handlers running back to back, before
    // React has re-rendered the disabled button.
    const guard: DispatchGuard = { current: false }
    expect(tryBeginDispatch(guard)).toBe(true)
    expect(tryBeginDispatch(guard)).toBe(false)
    expect(tryBeginDispatch(guard)).toBe(false)
    expect(guard.current).toBe(true)
  })

  it('endDispatch clears it, so the next call can begin again', () => {
    const guard: DispatchGuard = { current: false }
    tryBeginDispatch(guard)
    endDispatch(guard)
    expect(guard.current).toBe(false)
    expect(tryBeginDispatch(guard)).toBe(true)
  })

  it('endDispatch on an already-clear guard is a no-op, not an error', () => {
    const guard: DispatchGuard = { current: false }
    expect(() => endDispatch(guard)).not.toThrow()
    expect(guard.current).toBe(false)
  })
})

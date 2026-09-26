import { describe, expect, it } from 'bun:test'
import { fmtGB } from './useIdleSessions'

/**
 * `fmtGB` is the only pure piece of this hook — the hook itself (`useIdleSessions`) is untested here
 * per the task brief: it polls hardware, reads shared prefs and pushes notifications, none of which
 * this package can drive without a React test harness (see `packages/tui`'s own note on the same
 * limitation for `useHardwarePressureWatch`, which is instead reduced to a pure `pressureWatchStep`).
 */
describe('fmtGB', () => {
  it('formats bytes as GB with one decimal', () => {
    expect(fmtGB(1024 ** 3)).toBe('1.0 GB')
    expect(fmtGB(2.15 * 1024 ** 3)).toBe('2.1 GB')
  })
  it('rounds rather than truncating', () => {
    expect(fmtGB(1.05 * 1024 ** 3)).toBe('1.1 GB')
  })
  it('handles zero', () => {
    expect(fmtGB(0)).toBe('0.0 GB')
  })
})

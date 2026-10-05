import { describe, expect, test } from 'bun:test'
import { WARN_INITIAL, nextWarn, WARN_BEFORE_MS } from './vaultExpiry'

describe('nextWarn', () => {
  test('warns once when the countdown crosses 5 minutes, not before, not again', () => {
    let s = WARN_INITIAL
    const fires: boolean[] = []
    for (const ms of [20 * 60_000, 6 * 60_000, WARN_BEFORE_MS, 4 * 60_000, 2 * 60_000, 30_000]) {
      const r = nextWarn(s, ms); s = r.state; fires.push(r.fire)
    }
    expect(fires).toEqual([false, false, true, false, false, false])
  })
  test('an extension (countdown back above 5 min) re-arms the next warning', () => {
    let s = nextWarn(WARN_INITIAL, 4 * 60_000).state
    s = nextWarn(s, 30 * 60_000).state
    expect(nextWarn(s, 4 * 60_000).fire).toBe(true)
  })
  test('locked (null) or already due (0) never warns', () => {
    expect(nextWarn(WARN_INITIAL, null).fire).toBe(false)
    expect(nextWarn(WARN_INITIAL, 0).fire).toBe(false)
  })
  test('a window that is itself 5 minutes or less never warns', () => {
    expect(nextWarn(WARN_INITIAL, 4 * 60_000, 5 * 60_000).fire).toBe(false)
  })
})

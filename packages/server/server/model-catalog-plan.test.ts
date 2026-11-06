import { describe, expect, test } from 'bun:test'
import { catalogStale, retryDelayMs } from './model-catalog-plan'

const SIX_HOURS = 6 * 60 * 60_000

describe('catalogStale', () => {
  test('a cold harness is always due', () => {
    expect(catalogStale(undefined, SIX_HOURS, 0)).toBe(true)
  })

  test('a SUCCESSFUL read keeps the full TTL', () => {
    const e = { at: 1_000, ok: true, failures: 0 }
    expect(catalogStale(e, SIX_HOURS, 1_000 + SIX_HOURS)).toBe(false)
    expect(catalogStale(e, SIX_HOURS, 1_000 + SIX_HOURS + 1)).toBe(true)
  })

  test('a FAILED read is asked again within seconds, not after six hours (the Mac picker stayed empty for 6 h)', () => {
    const e = { at: 1_000, ok: false, failures: 1 }
    expect(catalogStale(e, SIX_HOURS, 1_000 + 29_000)).toBe(false)
    expect(catalogStale(e, SIX_HOURS, 1_000 + 31_000)).toBe(true)
  })

  test('consecutive failures back off, then hold', () => {
    expect(retryDelayMs(1)).toBe(30_000)
    expect(retryDelayMs(2)).toBe(120_000)
    expect(retryDelayMs(3)).toBe(600_000)
    expect(retryDelayMs(40)).toBe(600_000)
  })

  test('the backoff never exceeds the source TTL', () => {
    const e = { at: 0, ok: false, failures: 9 }
    expect(catalogStale(e, 60_000, 61_000)).toBe(true)
  })
})

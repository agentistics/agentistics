import { describe, expect, test } from 'bun:test'
import { NO_FALLBACK, helloErrored, helloFallback } from './helloFallback'

describe('Windows Hello fallback — a failure is not a cancel', () => {
  test('only an error or a timeout counts as Hello failing', () => {
    expect(helloErrored('presence-unavailable')).toBe(true)
    expect(helloErrored('presence-timeout')).toBe(true)
    expect(helloErrored('presence-cancelled')).toBe(false)
    expect(helloErrored('presence-lost')).toBe(false)
    expect(helloErrored('stepup-frozen')).toBe(false)
    expect(helloErrored(undefined)).toBe(false)
  })
  test('a CANCEL offers nothing extra, whatever is registered', () => {
    expect(helloFallback('presence-cancelled', { passkeys: 2 })).toEqual(NO_FALLBACK)
  })
  test('(A) default: a Hello error with a phone registered → approve on the phone', () => {
    expect(helloFallback('presence-unavailable', { passkeys: 1 })).toEqual({ phone: true, phoneMissing: false })
  })
  test('(A) with no phone registered → say how to get one (recovery stays the last resort)', () => {
    expect(helloFallback('presence-timeout', { passkeys: 0 })).toEqual({ phone: false, phoneMissing: true })
  })
  test('COFRE.DESBLOQUEIO: there is no "code alone" fallback any more', () => {
    expect(Object.keys(helloFallback('presence-unavailable', { passkeys: 0 }))).not.toContain('codeOnly')
  })
})

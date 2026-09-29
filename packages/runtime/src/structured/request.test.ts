import { describe, expect, test } from 'bun:test'
import { decideAttempt, DEFAULT_MAX_RETRIES, MAX_RETRIES_CEILING, prepareStructured } from './request.ts'

const S = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }

describe('prepareStructured', () => {
  test('maxRetries defaults to 2 (three attempts)', () => {
    const r = prepareStructured({ schema: S })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.prepared).toMatchObject({ maxRetries: DEFAULT_MAX_RETRIES, maxAttempts: 3 })
    expect(DEFAULT_MAX_RETRIES).toBe(2)
  })
  test('0..5 are accepted, and 5 is the ceiling', () => {
    expect(MAX_RETRIES_CEILING).toBe(5)
    for (let n = 0; n <= 5; n++) expect(prepareStructured({ schema: S, maxRetries: n }).ok).toBe(true)
  })
  test('above 5, negative or fractional is refused at request time, in a sentence', () => {
    for (const n of [6, 100, -1, 1.5, Number.NaN]) {
      const r = prepareStructured({ schema: S, maxRetries: n })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.code).toBe('max-retries')
        expect(r.sentence).toContain('maxRetries')
      }
    }
  })
  test('an unsupported schema and an unsatisfiable one are refused with different codes', () => {
    const a = prepareStructured({ schema: { type: 'string', pattern: 'x' } })
    const b = prepareStructured({ schema: { enum: [] } })
    expect(a.ok || b.ok).toBe(false)
    if (!a.ok) { expect(a.code).toBe('unsupported'); expect(a.sentence).toContain('"pattern"') }
    if (!b.ok) { expect(b.code).toBe('unsatisfiable'); expect(b.sentence).toContain('no model call was made') }
  })
})

describe('decideAttempt — the retry policy as a function of attempts', () => {
  test('a valid value is accepted on any attempt', () => {
    for (let k = 1; k <= 6; k++) expect(decideAttempt(k, true, 5)).toBe('accept')
  })
  test('an invalid one retries until maxRetries + 1 attempts are spent', () => {
    expect(decideAttempt(1, false, 2)).toBe('retry')
    expect(decideAttempt(2, false, 2)).toBe('retry')
    expect(decideAttempt(3, false, 2)).toBe('exhausted')
    expect(decideAttempt(1, false, 0)).toBe('exhausted')
  })
})

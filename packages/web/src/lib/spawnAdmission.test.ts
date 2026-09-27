import { describe, expect, it } from 'bun:test'
import { forcedNote, isAdmissionRefusal, type AdmissionRefusal } from './spawnAdmission'

const VALID_REFUSAL: AdmissionRefusal = {
  reason: 'no-room',
  requested: 3,
  fits: 1,
  availableBytes: 1_000_000_000,
  swapUsedBytes: 500_000_000,
  swapTotalBytes: 8_000_000_000,
  costBytes: 300_000_000,
  costBasis: 'measured',
  used: 2,
  max: 4,
}

describe('isAdmissionRefusal', () => {
  it('detects the exact memory-budget refusal shape', () => {
    expect(isAdmissionRefusal({
      ok: false,
      code: 'memory_budget',
      message: 'Not enough memory to start 3 sessions: only 1 fits.',
      refusal: VALID_REFUSAL,
    })).toBe(true)
  })

  it('detects the swap-alarm reason too', () => {
    expect(isAdmissionRefusal({
      ok: false,
      code: 'memory_budget',
      message: 'Swap is 97% full.',
      refusal: { ...VALID_REFUSAL, reason: 'swap', fits: 0 },
    })).toBe(true)
  })

  it('is false for a plain ok:false refusal with no code (an ordinary spawn error)', () => {
    expect(isAdmissionRefusal({ ok: false, message: 'Unknown harness: foo' })).toBe(false)
  })

  it('is false for ok:false with an unrelated code', () => {
    expect(isAdmissionRefusal({ ok: false, code: 'some_other_code', message: 'x' })).toBe(false)
  })

  it('is false for ok:true (a success is never a refusal)', () => {
    expect(isAdmissionRefusal({ ok: true, message: 'Session started', id: 'abc' })).toBe(false)
  })

  it('is false when refusal is missing entirely', () => {
    expect(isAdmissionRefusal({ ok: false, code: 'memory_budget', message: 'x' })).toBe(false)
  })

  it('is false when refusal is missing a required field', () => {
    const { fits: _fits, ...rest } = VALID_REFUSAL
    expect(isAdmissionRefusal({ ok: false, code: 'memory_budget', message: 'x', refusal: rest })).toBe(false)
  })

  it('is false when a refusal field has the wrong type', () => {
    expect(isAdmissionRefusal({
      ok: false,
      code: 'memory_budget',
      message: 'x',
      refusal: { ...VALID_REFUSAL, requested: '3' },
    })).toBe(false)
  })

  it('is false when reason is not one of the two known values', () => {
    expect(isAdmissionRefusal({
      ok: false,
      code: 'memory_budget',
      message: 'x',
      refusal: { ...VALID_REFUSAL, reason: 'out-of-disk' },
    })).toBe(false)
  })

  it('is false for null, undefined, and non-object input', () => {
    expect(isAdmissionRefusal(null)).toBe(false)
    expect(isAdmissionRefusal(undefined)).toBe(false)
    expect(isAdmissionRefusal('memory_budget')).toBe(false)
    expect(isAdmissionRefusal(42)).toBe(false)
  })

  it('is false when message is missing or not a string', () => {
    expect(isAdmissionRefusal({ ok: false, code: 'memory_budget', refusal: VALID_REFUSAL })).toBe(false)
    expect(isAdmissionRefusal({ ok: false, code: 'memory_budget', message: 7, refusal: VALID_REFUSAL })).toBe(false)
  })
})

describe('forcedNote', () => {
  it('returns the note on a forced admission', () => {
    expect(forcedNote({
      ok: true,
      id: 'abc',
      message: 'Session started',
      overridden: true,
      note: 'Started anyway, overriding the memory check: …',
    })).toBe('Started anyway, overriding the memory check: …')
  })

  it('is null when overridden is absent', () => {
    expect(forcedNote({ ok: true, id: 'abc', message: 'Session started' })).toBeNull()
  })

  it('is null when overridden is false', () => {
    expect(forcedNote({ ok: true, id: 'abc', message: 'Session started', overridden: false })).toBeNull()
  })

  it('is null when overridden is truthy but not the literal `true`', () => {
    expect(forcedNote({ ok: true, overridden: 1, note: 'x' })).toBeNull()
    expect(forcedNote({ ok: true, overridden: 'true', note: 'x' })).toBeNull()
  })

  it('is null when overridden is true but note is missing or not a string', () => {
    expect(forcedNote({ ok: true, overridden: true })).toBeNull()
    expect(forcedNote({ ok: true, overridden: true, note: 42 })).toBeNull()
  })

  it('is null for null, undefined, and non-object input', () => {
    expect(forcedNote(null)).toBeNull()
    expect(forcedNote(undefined)).toBeNull()
    expect(forcedNote('x')).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'
import { createRunScheduler } from './scheduler.ts'

describe('createRunScheduler — a ceiling, never a timer', () => {
  test('acquires up to the ceiling, then refuses with a named code and sentence', () => {
    const s = createRunScheduler({ ceiling: 2 })
    const a = s.tryAcquire()
    const b = s.tryAcquire()
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(s.inFlight()).toBe(2)

    const c = s.tryAcquire()
    expect(c.ok).toBe(false)
    if (!c.ok) {
      expect(c.code).toBe('at-ceiling')
      expect(c.sentence.length).toBeGreaterThan(0)
    }
  })

  test('release frees a slot for a later acquire — never a timer, only a release', () => {
    const s = createRunScheduler({ ceiling: 1 })
    const a = s.tryAcquire()
    expect(a.ok).toBe(true)
    expect(s.tryAcquire().ok).toBe(false)
    if (a.ok) a.release()
    expect(s.inFlight()).toBe(0)
    expect(s.tryAcquire().ok).toBe(true)
  })

  test('release is idempotent — releasing twice never lets the ceiling drift upward', () => {
    const s = createRunScheduler({ ceiling: 1 })
    const a = s.tryAcquire()
    if (a.ok) { a.release(); a.release() }
    expect(s.inFlight()).toBe(0)
  })

  test('a ceiling below 1 is floored to 1', () => {
    const s = createRunScheduler({ ceiling: 0 })
    expect(s.ceiling).toBe(1)
  })
})

import { describe, expect, test } from 'bun:test'
import { bootstrapInterval, poissonScoreInterval, wilsonInterval } from './interval'
import { percentile } from '../deliveryMetrics'

const median = (v: number[]) => percentile(v, 0.5)

describe('wilsonInterval', () => {
  test('matches the textbook value for 5 of 10', () => {
    const i = wilsonInterval(5, 10)!
    expect(i.lo).toBeCloseTo(0.2366, 3)
    expect(i.hi).toBeCloseTo(0.7634, 3)
    expect(i.method).toBe('wilson')
  })
  test('never leaves [0,1] and has no interval for an empty sample', () => {
    const i = wilsonInterval(0, 4)!
    expect(i.lo).toBe(0)
    expect(i.hi).toBeLessThan(1)
    expect(wilsonInterval(0, 0)).toBeNull()
  })
})

describe('poissonScoreInterval', () => {
  test('is per unit of exposure and brackets the rate', () => {
    const i = poissonScoreInterval(100, 4)!
    expect(i.lo).toBeLessThan(25)
    expect(i.hi).toBeGreaterThan(25)
    expect(i.lo).toBeCloseTo(20.5, 0)
    expect(poissonScoreInterval(3, 0)).toBeNull()
  })
})

describe('bootstrapInterval', () => {
  test('is deterministic for the same seed and brackets the statistic', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]
    const a = bootstrapInterval(v, median)!
    const b = bootstrapInterval(v, median)!
    expect(a).toEqual(b)
    expect(a.lo).toBeLessThanOrEqual(median(v)!)
    expect(a.hi).toBeGreaterThanOrEqual(median(v)!)
    expect(a.method).toBe('bootstrap')
  })
  test('one value has no interval; identical values collapse to a point', () => {
    expect(bootstrapInterval([3], median)).toBeNull()
    const c = bootstrapInterval([2, 2, 2, 2], median)!
    expect([c.lo, c.hi]).toEqual([2, 2])
  })
})

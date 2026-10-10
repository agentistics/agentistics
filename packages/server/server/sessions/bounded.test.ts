import { describe, expect, test } from 'bun:test'
import { bounded } from './bounded'

describe('bounded', () => {
  test('returns the value when it settles in time', async () => {
    expect(await bounded(Promise.resolve(7), 50, 0)).toBe(7)
  })
  test('returns the fallback when the work never settles', async () => {
    expect(await bounded(new Promise<number>(() => {}), 20, -1)).toBe(-1)
  })
  test('returns the fallback when the work rejects', async () => {
    expect(await bounded(Promise.reject(new Error('x')), 50, -2)).toBe(-2)
  })
})

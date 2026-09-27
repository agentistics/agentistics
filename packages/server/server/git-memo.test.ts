import { test, expect } from 'bun:test'
import { sweepExpired, type Memo } from './git'

test('an expired memo row is REMOVED, not merely skipped on read', () => {
  const ttl = 600_000
  const memo = new Map<string, Memo<number>>()
  // A key per commit sha, as `statsMemo` has: 10k commits' worth of rows, all long expired.
  for (let i = 0; i < 10_000; i++) memo.set(`sha${i}\0`, { at: 0, value: i })
  memo.set('fresh', { at: 5_000_000, value: 1 })

  expect(sweepExpired(memo, 5_000_000 + ttl - 1, ttl)).toBe(10_000)
  expect([...memo.keys()]).toEqual(['fresh'])
})

test('a row exactly at the TTL is expired — the same boundary memoRead uses', () => {
  const memo = new Map<string, Memo<string>>([['a', { at: 1000, value: 'x' }]])
  expect(sweepExpired(memo, 1000 + 600_000, 600_000)).toBe(1)
  expect(memo.size).toBe(0)
})

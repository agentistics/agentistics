import { test, expect } from 'bun:test'
import { retainKeys } from './prune-keys'

test('keys not seen this tick are dropped; seen ones keep their values', () => {
  const m = new Map<number, string>([[1, 'a'], [2, 'b'], [3, 'c']])
  retainKeys(m, new Set([2, 3, 99]))
  expect([...m]).toEqual([[2, 'b'], [3, 'c']])
})

test('an empty tick empties the map — a pid that is gone holds nothing', () => {
  const m = new Map<number, string>([[1, 'a']])
  retainKeys(m, new Set())
  expect(m.size).toBe(0)
})

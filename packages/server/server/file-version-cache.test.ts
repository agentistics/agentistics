import { test, expect } from 'bun:test'
import { FileVersionCache } from './file-version-cache'

test('a new version of a file REPLACES its entry — the superseded one is not retained', () => {
  const c = new FileVersionCache<string>(10)
  for (let v = 0; v < 50; v++) c.set('/a.jsonl', `v${v}`, `summary ${v}`)
  expect(c.size).toBe(1)
  expect(c.get('/a.jsonl', 'v49')).toBe('summary 49')
})

test('a stale version is a miss, never the old value', () => {
  const c = new FileVersionCache<string>(10)
  c.set('/a.jsonl', 'v1', 'old')
  expect(c.get('/a.jsonl', 'v2')).toBeUndefined()
  expect(c.get('/a.jsonl', 'v1')).toBe('old')
})

test('distinct files beyond the cap evict the least recently used one', () => {
  const c = new FileVersionCache<number>(3)
  c.set('/a', 'x', 1)
  c.set('/b', 'x', 2)
  c.set('/c', 'x', 3)
  expect(c.get('/a', 'x')).toBe(1) // touching /a makes /b the oldest
  c.set('/d', 'x', 4)
  expect(c.size).toBe(3)
  expect(c.get('/b', 'x')).toBeUndefined()
  expect(c.get('/a', 'x')).toBe(1)
  expect(c.get('/c', 'x')).toBe(3)
  expect(c.get('/d', 'x')).toBe(4)
})

test('the cap holds under any number of distinct files', () => {
  const c = new FileVersionCache<number>(100)
  for (let i = 0; i < 10_000; i++) c.set(`/f${i}`, 'x', i)
  expect(c.size).toBe(100)
  expect(c.get('/f9999', 'x')).toBe(9999)
  expect(c.get('/f0', 'x')).toBeUndefined()
})

test('a capacity below one is refused rather than silently caching nothing', () => {
  expect(() => new FileVersionCache<number>(0)).toThrow()
})

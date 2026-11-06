import { describe, expect, test } from 'bun:test'
import { effectiveView, hasStoredView, pickDefaultLane, resolveLane } from './mobileLanes'

const lanes = (...p: [string, number][]) => p.map(([status, count]) => ({ status, count }))

describe('pickDefaultLane', () => {
  test('prefers a non-empty in-progress-like lane', () => {
    expect(pickDefaultLane(lanes(['todo', 3], ['in_progress', 2], ['done', 9]))).toBe('in_progress')
  })
  test('skips an empty in-progress lane', () => {
    expect(pickDefaultLane(lanes(['todo', 0], ['in_progress', 0], ['blocked', 1]))).toBe('blocked')
  })
  test('falls back to the first lane when all are empty; null when none', () => {
    expect(pickDefaultLane(lanes(['todo', 0], ['done', 0]))).toBe('todo')
    expect(pickDefaultLane([])).toBeNull()
  })
})

describe('resolveLane', () => {
  test('keeps a valid selection, drops a stale one', () => {
    const l = lanes(['todo', 1], ['in_progress', 1])
    expect(resolveLane('todo', l)).toBe('todo')
    expect(resolveLane('gone', l)).toBe('in_progress')
  })
})

describe('effectiveView', () => {
  test('phone without stored choice -> board; stored wins; desktop untouched', () => {
    expect(effectiveView('overview', true, false)).toBe('board')
    expect(effectiveView('table', true, true)).toBe('table')
    expect(effectiveView('overview', false, false)).toBe('overview')
  })
})

describe('hasStoredView', () => {
  test('a stored Live Delivery choice counts, so a phone keeps it instead of falling back to the board', () => {
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null }
    store.set('k', JSON.stringify({ view: 'live' }))
    expect(hasStoredView('k')).toBe(true)
    store.set('k', JSON.stringify({ view: 'nonsense' }))
    expect(hasStoredView('k')).toBe(false)
    delete (globalThis as { localStorage?: unknown }).localStorage
  })
})

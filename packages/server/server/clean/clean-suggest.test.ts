import { describe, expect, test } from 'bun:test'
import { MIN_BYTES, shouldSuggest, suggestionText, WEEK_MS, weekIsUp } from './clean-suggest'

describe('clean suggestion', () => {
  test('once a week at most, and only when at least 1 GB can be freed', () => {
    expect(shouldSuggest({ lastAt: null, nowMs: 0, bytes: MIN_BYTES })).toBe(true)
    expect(shouldSuggest({ lastAt: null, nowMs: 0, bytes: MIN_BYTES - 1 })).toBe(false)
    expect(shouldSuggest({ lastAt: 0, nowMs: WEEK_MS - 1, bytes: 5 * MIN_BYTES })).toBe(false)
    expect(weekIsUp(0, WEEK_MS)).toBe(true)
    expect(weekIsUp(0, WEEK_MS - 1)).toBe(false)
  })
  test('the notification names the size and the command', () => {
    expect(suggestionText(2.7 * MIN_BYTES, 5, 'en')).toEqual({ title: 'agentop clean can free 2.7 GB', message: '5 merged worktree(s) or stale node_modules. Run `agentop clean` to see the list and confirm.' })
    expect(suggestionText(2 * MIN_BYTES, 1, 'pt').title).toBe('agentop clean pode liberar 2.0 GB')
  })
})

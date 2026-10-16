import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentUsedPct, newerLimits, parseClaudeUsageResponse, planBudget, PLAN_LIMITS_STALE_MS } from './planLimits'

const body = () => JSON.parse(readFileSync(join(import.meta.dir, '__fixtures__', 'plan-limits-claude-usage.json'), 'utf8'))
const AT = Date.parse('2026-10-16T05:00:00Z')

describe('parseClaudeUsageResponse — the /api/oauth/usage body (captured, credential-free)', () => {
  test('reads both windows; utilization is already a percentage', () => {
    const l = parseClaudeUsageResponse(body(), AT)!
    expect(l.harness).toBe('claude')
    expect(l.account).toBe('default')
    expect(l.source).toBe('claude-usage-api')
    expect(l.updatedAt).toBe(AT)
    expect(l.windows).toEqual([
      { kind: '5h', usedPct: 41, resetsAt: Date.parse('2026-10-16T06:20:00.118343+00:00') },
      { kind: 'week', usedPct: 6, resetsAt: Date.parse('2026-10-23T01:00:00.118366+00:00') },
    ])
  })
  test('a window not opened yet (0, no reset) is a real 0, already renewed', () => {
    const l = parseClaudeUsageResponse({ five_hour: { utilization: 0, resets_at: null }, seven_day: body().seven_day }, AT)!
    expect(l.windows[0]).toEqual({ kind: '5h', usedPct: 0, resetsAt: AT })
  })
  test('a non-zero percentage with no readable reset is dropped, never kept forever', () => {
    const l = parseClaudeUsageResponse({ five_hour: { utilization: 30, resets_at: null }, seven_day: body().seven_day }, AT)!
    expect(l.windows.map(w => w.kind)).toEqual(['week'])
  })
  test('nothing usable is null, never a zero record', () => {
    expect(parseClaudeUsageResponse({}, AT)).toBeNull()
    expect(parseClaudeUsageResponse({ five_hour: null, seven_day: null }, AT)).toBeNull()
    expect(parseClaudeUsageResponse('nope', AT)).toBeNull()
    expect(parseClaudeUsageResponse({ error: { type: 'authentication_error' } }, AT)).toBeNull()
  })
  test('a fresh usage-api reading replaces an older stream reading for the same account', () => {
    const fresh = parseClaudeUsageResponse(body(), AT)!
    const old = { ...fresh, source: 'claude-stream' as const, updatedAt: AT - 3 * 86_400_000 }
    expect(newerLimits(old, fresh)).toBe(fresh)
  })
})

describe('staleness and renewal reach the budget', () => {
  test('a reset in the past does not keep the old usage', () => {
    const l = parseClaudeUsageResponse(body(), AT)!
    const after = Date.parse('2026-10-16T07:00:00Z')
    expect(currentUsedPct(l.windows[0]!, after)).toBe(0)
    expect(planBudget(l, after).fiveHourPct).toBe(0)
  })
  test('an old reading is flagged stale with its age, a fresh one is not', () => {
    const l = parseClaudeUsageResponse(body(), AT)!
    expect(planBudget(l, AT + 60_000)).toMatchObject({ stale: false, updatedAt: AT, fiveHourPct: 41 })
    expect(planBudget(l, AT + PLAN_LIMITS_STALE_MS + 1).stale).toBe(true)
  })
})

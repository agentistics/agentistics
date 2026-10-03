import { describe, expect, test } from 'bun:test'
import { nativeUsageOf } from './nativeUsage'

describe('nativeUsageOf — the native calls card', () => {
  test('nothing to show is null (no card), never a zero row', () => {
    expect(nativeUsageOf({ groups: [] })).toBeNull()
    expect(nativeUsageOf(null)).toBeNull()
  })
  test('a provider-stated cost is kept; an unpriced model stays unpriced, not guessed', () => {
    const u = nativeUsageOf({ groups: [
      { key: { model: 'aion-labs/aion-2.0', provider: 'openai-compatible' }, metrics: { responses: { count: 2 }, tokens: { total: 52, input: 20, output: 32 }, cost: { usd: 0.00007, pricedRows: 2, unpricedRows: 0, partial: false } } },
      { key: { model: 'mystery/x', provider: 'openai-compatible' }, metrics: { responses: { count: 1 }, tokens: { total: 10 }, cost: { usd: 0, pricedRows: 0, unpricedRows: 1, partial: true } } },
    ] })!
    expect(u.rows.map(r => [r.model, r.costUSD])).toEqual([['aion-labs/aion-2.0', 0.00007], ['mystery/x', null]])
    expect(u.calls).toBe(3)
    expect(u.costUSD).toBeCloseTo(0.00007)
    expect(u.costPartial).toBe(true) // one row could not be priced: the total is a floor
  })
})

import { nativeCard } from './nativeUsage'
describe('nativeCard — shown whenever the engine is present', () => {
  test('engine + no calls: card shows (empty state)', () => expect(nativeCard(true, null)).toEqual({ show: true, usage: null }))
  test('no engine, no calls: hidden', () => expect(nativeCard(false, null).show).toBe(false))
  test('no engine but usage on record: shown', () => {
    const u = nativeUsageOf({ groups: [{ key: { model: 'm' }, metrics: { responses: { count: 1 }, tokens: { total: 1 } } }] })
    expect(nativeCard(false, u).show).toBe(true)
  })
})

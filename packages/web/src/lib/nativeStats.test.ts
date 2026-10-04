import { describe, expect, test } from 'bun:test'
import { nativeSessionStats } from './nativeStats'
import type { RunLineView } from './nativeRuns'

const run = (over: Partial<RunLineView> = {}): RunLineView => ({
  runId: 'r', responses: 2, costMeasured: true, cacheShare: 0.5,
  tokens: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, total: 360 },
  costUSD: 0.02, context: { tokens: 40_000, window: 200_000, fraction: 0.2 }, model: 'claude-sonnet-4.6', ...over,
})

describe('nativeSessionStats — the composer\'s metrics card from the engine\'s real usage', () => {
  test('sums every billed run; the gauge is the latest run\'s; messages from the chat', () => {
    const s = nativeSessionStats({
      sessionId: 'ses_1', model: 'x',
      runs: [run(), run({ runId: 'r2', context: { tokens: 90_000, window: 200_000, fraction: 0.45 } })],
      turns: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'ok' }, { role: 'assistant', text: '' }],
    })
    expect(s.tokens).toEqual({ input: 200, output: 100, cacheRead: 400, cacheWrite: 20 })
    expect(s.costUSD).toBeCloseTo(0.04)
    expect(s.context).toEqual({ fraction: 0.45, used: 90_000, window: 200_000 })
    expect(s.messages).toEqual({ user: 1, assistant: 1 })
    expect(s.model).toBe('claude-sonnet-4.6')
  })
  test('a run the engine could not measure makes the WHOLE figure unknown — never a partial sum', () => {
    const s = nativeSessionStats({ sessionId: 's', runs: [run(), run({ tokens: null, costUSD: null })], turns: [] })
    expect(s.tokens).toBeNull()
    expect(s.costUSD).toBeNull()
  })
  test('no billed run yet, or an unknown window: no gauge (the ring is then absent), never 0%', () => {
    expect(nativeSessionStats({ sessionId: 's', runs: [], turns: null }).context).toBeNull()
    expect(nativeSessionStats({ sessionId: 's', runs: [run({ context: { tokens: 5, window: null, fraction: null } })], turns: [] }).context).toBeNull()
  })
})

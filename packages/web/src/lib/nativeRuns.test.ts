import { describe, expect, test } from 'bun:test'
import { contextGauge, parseRuns, runLineText, type RunLineView } from './nativeRuns'

const run = (p: Partial<RunLineView> = {}): RunLineView => ({
  runId: 'run_1', responses: 1, tokens: { input: 100, output: 50, cacheRead: 9_000, cacheWrite: 850, total: 10_000 },
  costUSD: 0.04, costMeasured: false, cacheShare: 0.9, context: { tokens: 68_000, window: 200_000, fraction: 0.34 }, ...p,
})

describe('H6 in the native chat', () => {
  test('one line per run, in both languages', () => {
    expect(runLineText(run(), 'en')).toMatch(/^10\.0K tokens · .+ \(estimated\) · cache 90% · context 34% of 200\.0K$/)
    expect(runLineText(run({ costUSD: null, tokens: null }), 'pt')).toBe('tokens não medidos · sem preço · cache 90% · contexto 34% de 200.0K')
  })
  test('the gauge reads the latest run that measured one; an unknown window is no gauge', () => {
    expect(contextGauge([run(), run({ runId: 'run_2', context: { tokens: 1, window: 200_000, fraction: 0.5 } })])?.fraction).toBe(0.5)
    expect(contextGauge([run({ context: { tokens: 10, window: null, fraction: null } })])).toBeNull()
    expect(contextGauge([])).toBeNull()
  })
  test('untrusted input never throws', () => {
    expect(parseRuns(null)).toEqual([])
    expect(parseRuns({ runs: [{ runId: 1 }, run()] })).toHaveLength(1)
  })
})

describe('H24 in the native chat', () => {
  test('each run\'s line names the model it was priced on', () => {
    expect(runLineText({ runId: 'r', responses: 1, tokens: null, costUSD: null, costMeasured: false, cacheShare: null, context: null, model: 'claude-sonnet-4-6' }, 'en'))
      .toBe('claude-sonnet-4-6 · tokens not measured · no price')
  })
})

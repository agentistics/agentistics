import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NativeRunsStrip } from './NativeRunsStrip'
import type { RunLineView } from '../../lib/nativeRuns'

const run = (runId: string, fraction: number): RunLineView => ({
  runId, responses: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, costUSD: 0.01, costMeasured: true,
  cacheShare: 0, context: { tokens: fraction * 200_000, window: 200_000, fraction },
})

describe('H6: the runs strip in the native chat', () => {
  test('the gauge for the latest run, its line, and the earlier runs folded', () => {
    const html = renderToStaticMarkup(<NativeRunsStrip runs={[run('a', 0.1), run('b', 0.42)]} lang="en" />)
    expect(html).toContain('aria-valuenow="42"')
    expect(html).toContain('Last run: 2 tokens')
    expect(html).toContain('Earlier runs (1)')
  })
  test('nothing before a run billed a response: an empty strip is not a zero', () => {
    expect(renderToStaticMarkup(<NativeRunsStrip runs={[]} lang="pt" />)).toBe('')
  })
})

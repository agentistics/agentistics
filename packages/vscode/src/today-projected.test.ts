import { describe, expect, it } from 'bun:test'
import type { MetricsQueryFn } from '@agentistics/core'
// The server's own query over an in-memory reader (test-only import).
import { parseMetricsQuery, runMetricsQuery } from '../../server/server/runtime-metrics-query'
import { costFact, fakeReader, runFact } from '../../server/server/runtime-metrics-fixtures'
import { projectedToday } from './today-projected'

const query = (): MetricsQueryFn => {
  const r = fakeReader(
    [
      // A session that STARTED yesterday and spent today: today's spend is today's.
      costFact({ sessionId: 'old', day: '2026-08-31', costUSD: 7 }),
      costFact({ sessionId: 'old', day: '2026-09-01', costUSD: 2 }),
      costFact({ sessionId: 'new', day: '2026-09-01', costUSD: 1 }),
      costFact({ sessionId: 'new', day: '2026-09-01', agentId: 'sub', subagent: true, costUSD: 5 }),
    ],
    [runFact({ sessionId: 'old', runId: 'r0', day: '2026-08-31' }), runFact({ sessionId: 'new', runId: 'r1', day: '2026-09-01' })],
  )
  return async p => {
    const parsed = parseMetricsQuery(p)
    if (!parsed.ok) throw new Error(`bad query ${p}`)
    return { ok: true, body: await runMetricsQuery(r, parsed.query) }
  }
}

describe('projectedToday (A4.5)', () => {
  it("is today's billed spend, main agent: yesterday's session counts for what it spent today", async () => {
    const t = await projectedToday(query(), new Date('2026-09-01T12:00:00.000Z'))
    expect(t.costUSD).toBe(3)
    expect(t.tokens).toBe(740)
    expect(t.sessions).toBe(2)
  })

  it('a day with nothing billed is a real zero', async () => {
    expect(await projectedToday(query(), new Date('2026-09-05T12:00:00.000Z'))).toEqual({ costUSD: 0, tokens: 0, sessions: 0 })
  })
})

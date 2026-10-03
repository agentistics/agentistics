import React from 'react'
import { describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { emptyStatsCache, type AppData, type MetricsQueryFn } from '@agentistics/core'
// The server's own query over an in-memory reader (test-only import): the figures are checked against
// the real `/api/runtime/metrics` contract.
import { parseMetricsQuery, runMetricsQuery } from '../../server/server/runtime-metrics-query'
import { costFact, fakeReader, runFact } from '../../server/server/runtime-metrics-fixtures'
import { projectedFigures } from './projected-figures'
import { loadProjectedFigures } from './data/useProjectedFigures'
import { Harnesses } from './screens/Harnesses'
import { Overview } from './screens/Overview'
import { strings } from './i18n'

const reader = () => fakeReader(
  [
    costFact({ sessionId: 's1', day: '2026-09-01' }),
    costFact({ sessionId: 's1', day: '2026-09-02', agentId: 'sub', subagent: true, costUSD: 5 }),
    costFact({ sessionId: 's2', harness: 'codex', model: 'gpt-5.5', project: '/home/u/other', costUSD: 2 }),
  ],
  [
    runFact({ sessionId: 's1', runId: 'r1' }),
    runFact({ sessionId: 's2', runId: 'r2', harness: 'codex', model: 'gpt-5.5', project: '/home/u/other' }),
  ],
)
const query = (r = reader()): MetricsQueryFn => async p => {
  const parsed = parseMetricsQuery(p)
  if (!parsed.ok) throw new Error(`bad query ${p}`)
  return { ok: true, body: await runMetricsQuery(r, parsed.query) }
}

describe('projected dashboard figures (A4.6)', () => {
  test('harness rows: main-agent tokens (all four counters) and cost; messages and agents are null', async () => {
    const f = await projectedFigures(query())
    expect(f.source).toBe('projections')
    expect(f.harnesses).toEqual([
      { harness: 'claude', sessions: 1, messages: null, tokens: 370, costUSD: 1, agents: null },
      { harness: 'codex', sessions: 1, messages: null, tokens: 370, costUSD: 2, agents: null },
    ])
    expect(f.totals).toEqual({ sessions: 2, tokens: 740, costUSD: 3, messages: null })
  })

  test('projects and models, ordered by cost like the legacy screens', async () => {
    const f = await projectedFigures(query())
    expect(f.projects.map(p => [p.name, p.path, p.costUSD, p.lastActivity])).toEqual([
      ['other', '/home/u/other', 2, '2026-09-01'],
      ['app', '/home/u/app', 1, '2026-09-02'],
    ])
    expect(f.models.map(m => m.model)).toEqual(['gpt-5.5', 'claude-sonnet-5'])
  })

  test('the harness filter scopes every figure', async () => {
    const f = await projectedFigures(query(), 'codex')
    expect(f.harnesses.map(h => h.harness)).toEqual(['codex'])
    expect(f.projects.map(p => p.path)).toEqual(['/home/u/other'])
  })

  test('a refusal reads as null: the screens draw the legacy figures', async () => {
    const off = (async () => new Response(JSON.stringify({ error: 'projections_disabled' }), { status: 404 })) as unknown as typeof fetch
    expect(await loadProjectedFigures('http://x', null, off)).toBeNull()
  })

  test('the screens draw the projected figures, with N/A / — where nothing is projected', async () => {
    const figures = await projectedFigures(query())
    const data = { statsCache: emptyStatsCache(), sessions: [], projects: [], allSessions: [], harnesses: ['claude'] } as unknown as AppData
    const s = strings('en')
    const h = render(<Harnesses data={data} figures={figures} s={s} width={80} height={10} />)
    const frame = (h.lastFrame() ?? '').replace(/\[[0-9;]*m/g, '')
    expect(frame).toContain('Codex')
    expect(frame).toContain('N/A')
    const o = render(<Overview data={data} figures={figures} s={s} width={120} height={20} streak={0} />)
    expect((o.lastFrame() ?? '').replace(/\[[0-9;]*m/g, '')).toContain('—')
  })
})

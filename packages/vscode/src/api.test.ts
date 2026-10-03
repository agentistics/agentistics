import { describe, expect, it } from 'bun:test'
import { isTimeout } from './api'

/**
 * `isTimeout` is what keeps a slow server from being reported as a dead one — see the `slow`
 * `LinkState` and `AgentopClient.fleet`. It has to recognise exactly what `AbortSignal.timeout()`
 * throws and nothing else, or a real connection failure (server not running, wrong port) would
 * read as "just slow" and never offer the "start it" action.
 */
describe('isTimeout', () => {
  it('recognises the DOMException AbortSignal.timeout() rejects fetch with', () => {
    const err = new DOMException('The operation timed out.', 'TimeoutError')
    expect(isTimeout(err)).toBe(true)
  })

  it('does not mistake a connection failure for a timeout', () => {
    const err = new Error('Unable to connect. Is the computer able to access the url?')
    expect(isTimeout(err)).toBe(false)
  })

  it('does not mistake an explicit user abort for a timeout', () => {
    const err = new DOMException('The operation was aborted.', 'AbortError')
    expect(isTimeout(err)).toBe(false)
  })

  it('handles a non-Error thrown value without throwing itself', () => {
    expect(isTimeout('not an error')).toBe(false)
    expect(isTimeout(undefined)).toBe(false)
  })
})

import { AgentopClient } from './api'

/** A throwaway local server on an ephemeral port: the client's real fetch path, end to end. */
function serve(routes: Record<string, () => Response>) {
  const hits: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      hits.push(path)
      return routes[path]?.() ?? new Response('{}', { status: 404 })
    },
  })
  return { api: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) }
}

describe('AgentopClient.today (A4.5)', () => {
  const now = new Date('2026-09-01T12:00:00.000Z')
  const data = () => Response.json({ sessions: [{ session_id: 's', start_time: '2026-09-01T01:00:00Z', input_tokens: 10, output_tokens: 0, model: 'claude-sonnet-4-6' }] })

  it('projected: a refusal (gate off, 404) reads /api/data as before', async () => {
    const s = serve({
      '/api/runtime/metrics': () => Response.json({ error: 'projections_disabled' }, { status: 404 }),
      '/api/data': data,
    })
    try {
      const t = await new AgentopClient(s.api, 'en').today(now, { projected: true })
      expect(t?.sessions).toBe(1)
      expect(s.hits).toContain('/api/data')
    } finally { s.stop() }
  })

  it('projected: an answer from the projections never reads /api/data', async () => {
    const page = (metrics: Record<string, unknown>) => Response.json({ groups: [{ key: {}, metrics }], page: { nextCursor: null } })
    let n = 0
    const s = serve({
      '/api/runtime/metrics': () => (n++ === 0 ? page({ cost: { usd: 2.5 }, tokens: { total: 900 } }) : page({ cost: { usd: 2.5 }, tokens: { total: 900 }, sessions: { count: 3 } })),
      '/api/data': data,
    })
    try {
      const t = await new AgentopClient(s.api, 'en').today(now, { projected: true })
      expect(t?.costUSD).toBe(2.5)
      expect(t?.tokens).toBe(900)
      expect(s.hits).not.toContain('/api/data')
    } finally { s.stop() }
  })

  it('not opted in: /api/data only', async () => {
    const s = serve({ '/api/data': data })
    try {
      expect((await new AgentopClient(s.api, 'en').today(now))?.sessions).toBe(1)
      expect(s.hits).toEqual(['/api/data'])
    } finally { s.stop() }
  })
})

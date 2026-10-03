import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { AUTH_PUBLIC } from './index-routes'
import { routeCapability } from './capability-guard'
import type { ProjectionReader } from './projections/facts'
import { handleRuntimeMetricsRequest, MAX_ANSWER_LAG, projectionsEnabled, RUNTIME_METRICS_PATH } from './runtime-metrics-web'
import { costFact, fakeReader } from './runtime-metrics-fixtures'

/** A reader that fails the test the moment anything touches it. */
const untouchable: ProjectionReader = {
  costFacts() { throw new Error('reader touched') },
  runFacts() { throw new Error('reader touched') },
  status() { throw new Error('reader touched') },
}

const get = (qs = '') => {
  const url = new URL(`http://x${RUNTIME_METRICS_PATH}${qs}`)
  return [new Request(url), url] as const
}

describe('the flag', () => {
  it('absent reads ON (the default since the backfill item); only an explicit negative turns it off', () => {
    expect(projectionsEnabled(undefined)).toBe(true)
    expect(projectionsEnabled('')).toBe(true)
    expect(projectionsEnabled('0')).toBe(false)
    expect(projectionsEnabled('off')).toBe(false)
    expect(projectionsEnabled('false')).toBe(false)
    for (const v of ['1', 'true', 'on', 'yes', ' ON ']) expect(projectionsEnabled(v)).toBe(true)
  })
  it('off → projections_disabled, nothing touched (not even a bad query string is parsed)', async () => {
    const [req, url] = get('?bogus=1')
    const out = await handleRuntimeMetricsRequest(req, url, { flag: '0', central: false, reader: untouchable })
    expect(out.status).toBe(404)
    expect((out.body as { error: string }).error).toBe('projections_disabled')
  })
})

describe('the route', () => {
  it('on a central it refuses with a sentence, without touching the reader', async () => {
    const [req, url] = get()
    const out = await handleRuntimeMetricsRequest(req, url, { flag: '1', central: true, reader: untouchable })
    expect(out.status).toBe(409)
    expect((out.body as { error: string }).error).toBe('unsupported_on_central')
  })
  it('no reader wired → projections_unavailable', async () => {
    const [req, url] = get()
    const out = await handleRuntimeMetricsRequest(req, url, { flag: '1', central: false, reader: null })
    expect(out.status).toBe(503)
  })
  it('non-GET → 405', async () => {
    const url = new URL(`http://x${RUNTIME_METRICS_PATH}`)
    const out = await handleRuntimeMetricsRequest(new Request(url, { method: 'POST' }), url, { flag: '1', central: false, reader: untouchable })
    expect(out.status).toBe(405)
  })
  it('the first import not complete → projections_backfilling (every surface reads /api/data), reader untouched', async () => {
    const [req, url] = get()
    const out = await handleRuntimeMetricsRequest(req, url, {
      flag: '1', central: false, reader: untouchable,
      backfill: { pending: true, progress: { v: 1, identity: 'i', state: 'running', startedAt: 's', updatedAt: 'u', written: 42 } },
    })
    expect(out.status).toBe(503)
    expect(out.body).toMatchObject({ error: 'projections_backfilling', progress: { state: 'running', written: 42 } })
  })
  it('the projections far behind the journal → projections_catching_up, never a partial answer', async () => {
    const [req, url] = get()
    const reader = fakeReader([costFact()], [], { cursor: 10, journalHead: 10 + MAX_ANSWER_LAG + 1, versions: {}, rebuilding: false })
    const out = await handleRuntimeMetricsRequest(req, url, { flag: '1', central: false, reader })
    expect(out.status).toBe(503)
    expect(out.body).toMatchObject({ error: 'projections_catching_up', lag: MAX_ANSWER_LAG + 1 })
    const near = fakeReader([costFact()], [], { cursor: 10, journalHead: 10 + MAX_ANSWER_LAG, versions: {}, rebuilding: false })
    expect((await handleRuntimeMetricsRequest(req, url, { flag: '1', central: false, reader: near })).status).toBe(200)
  })
  it('bad input → 400 with the code', async () => {
    const [req, url] = get('?metrics=vibes')
    const out = await handleRuntimeMetricsRequest(req, url, { flag: '1', central: false, reader: untouchable })
    expect(out.status).toBe(400)
    expect((out.body as { code: string }).code).toBe('unknown_metric')
  })
  it('answers a query', async () => {
    const [req, url] = get('?metrics=cost')
    const out = await handleRuntimeMetricsRequest(req, url, { flag: 'on', central: false, reader: fakeReader([costFact({ costUSD: 2 })], []) })
    expect(out.status).toBe(200)
    expect((out.body as { groups: { metrics: { cost: { usd: number } } }[] }).groups[0]!.metrics.cost.usd).toBe(2)
  })
})

describe('registration', () => {
  it('is guarded by localTranscripts before it answers', () => {
    expect(routeCapability(RUNTIME_METRICS_PATH)).toBe('localTranscripts')
  })
  it('is authenticated by default: not in AUTH_PUBLIC', () => {
    expect(AUTH_PUBLIC.has(RUNTIME_METRICS_PATH)).toBe(false)
  })
  it('index.ts routes it through the handler with the per-request deps and safeError', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const at = src.indexOf("url.pathname === '/api/runtime/metrics'")
    expect(at).toBeGreaterThan(-1)
    const block = src.slice(at, at + 700)
    expect(block).toContain('liveRuntimeMetricsDeps(TEAM_CENTRAL)')
    expect(block).toContain('safeError(')
    // The guard and the auth gate run before every route; the route must come after them.
    expect(at).toBeGreaterThan(src.indexOf('const needed = routeCapability(url.pathname)'))
    expect(at).toBeGreaterThan(src.indexOf('!AUTH_PUBLIC.has(url.pathname)'))
  })
})

describe('LIVE C5 — the projection catch-up is single-flight, coalesced and bounded', () => {
  it('due requests while a pass runs set ONE dirty bit: exactly one more pass, never a queue', async () => {
    const { maybeCatchUp, catchUpStateForTests, closeRuntimeMetricsStore, CATCH_UP_EVERY_MS, CATCH_UP_MAX_PAGES } = await import('./runtime-metrics-web')
    closeRuntimeMetricsStore()
    let passes = 0
    let release: () => void = () => {}
    const store = {
      reader: {} as never,
      store: {} as never,
      close() {},
      catchUp: () => { passes++; return passes === 1 ? new Promise<unknown>(r => { release = () => r({ state: 'done' }) }) : Promise.resolve({ state: 'done' }) },
    }
    const t0 = 1_000_000
    maybeCatchUp(store, t0)
    for (let i = 1; i <= 4; i++) maybeCatchUp(store, t0 + i * CATCH_UP_EVERY_MS) // each one due
    expect(catchUpStateForTests()).toEqual({ running: true, dirty: true })
    release()
    await new Promise(r => setTimeout(r, 10))
    expect(passes).toBe(2)
    expect(catchUpStateForTests()).toEqual({ running: false, dirty: false })
    expect(CATCH_UP_MAX_PAGES).toBeGreaterThan(0)
    closeRuntimeMetricsStore()
  })
})

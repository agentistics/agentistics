/**
 * The host side of the engine contract, driven against the fake engine.
 *
 * Everything the host hands over here is the REAL public value — the exposure capabilities, the
 * bounded body reader, the error sanitiser, the capability guard's own table — so `tsc` proves the
 * host's types satisfy `EngineHostServices`, and the tests prove the load-time judgement refuses
 * what it must. No real engine and no integration code is involved.
 */
import { describe, expect, it } from 'bun:test'
import {
  ENGINE_API_VERSION,
  checkEngine,
  hasReplay,
  type Engine,
  type EngineAuditEvent,
  type EngineHostServices,
  type EngineStatus,
  type ReplayCursor,
} from '@agentistics/engine-api'
import { CAPS } from '../exposure'
import { readJsonLimited } from '../limits'
import { safeError } from '../errors'
import { routeCapability } from '../capability-guard'
import { FAKE_EVENTS, createEngine, makeFakeEngine, type FakeEngine } from './fixtures/fake-engine'

function hostServices(opts: { central?: boolean; audit?: EngineAuditEvent[] } = {}): EngineHostServices {
  return {
    paths: { dataDir: '/tmp/x', defaultDataDir: '/tmp/x', contentDir: '/tmp/x/content', home: '/tmp', harnessRoots: {} },
    journal: { sink: async () => null, status: () => ({ state: 'disabled', reason: 'no-integrations' }) },
    protectedPaths: [],
    caps: CAPS,
    isCentral: () => opts.central ?? false,
    flag: () => false,
    audit: e => { opts.audit?.push(e) },
    readJsonLimited,
    safeError,
    spawnBudget: async () => ({ budget: { max: 1, used: 0, left: 1, percent: 0 } }),
    notify: () => {},
    lang: () => 'en',
    tasks: {
      fileNative: async () => ({ ok: false, reason: 'not in this build' }),
      unfileNative: async () => {},
    },
    readers: {},
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  }
}

/** The load decision a host makes, in the shape the product will report it. */
async function load<E extends Engine>(
  create: (host: EngineHostServices) => Promise<E>,
  host: EngineHostServices,
): Promise<{ status: EngineStatus; engine: E | null }> {
  const engine = await create(host)
  const refusals = checkEngine(engine, ENGINE_API_VERSION, routeCapability)
  if (refusals.some(r => r.kind === 'api-mismatch')) {
    await engine.dispose()
    return { status: { present: false, reason: 'api-mismatch' }, engine: null }
  }
  if (refusals.length > 0) {
    await engine.dispose()
    return { status: { present: false, reason: 'load-failed' }, engine: null }
  }
  return { status: { present: true, manifest: engine.manifest }, engine }
}

/** Route dispatch as the host will do it: the first route whose reserved prefix owns the path. */
async function dispatch(engine: Engine, req: Request): Promise<Response | null> {
  const url = new URL(req.url)
  for (const r of engine.routes) {
    if (url.pathname === r.prefix || url.pathname.startsWith(`${r.prefix}/`)) return r.handle(req, url)
  }
  return null
}

describe('the fake engine against the host seam', () => {
  it('loads: the contract version matches and every route passes the guard table', async () => {
    const { status, engine } = await load(makeFakeEngine(), hostServices())
    expect(status.present).toBe(true)
    if (status.present) expect(status.manifest.apiVersion).toBe(ENGINE_API_VERSION)
    expect(engine).not.toBeNull()
  })

  it('the default export has the one shape a real engine package exports', async () => {
    const engine = await createEngine(hostServices())
    expect(checkEngine(engine, ENGINE_API_VERSION, routeCapability)).toEqual([])
    await engine.dispose()
  })

  it('an engine built against another major is refused and disposed', async () => {
    let made: FakeEngine | null = null
    const create = async (h: EngineHostServices) => (made = await makeFakeEngine({ apiVersion: '2.0.0' })(h))
    const { status, engine } = await load(create, hostServices())
    expect(status).toEqual({ present: false, reason: 'api-mismatch' })
    expect(engine).toBeNull()
    expect(made!.disposed()).toBe(true)
  })

  it('an engine route that declares a weaker capability than the guard table is refused', async () => {
    const create = async (h: EngineHostServices) => {
      const e = await makeFakeEngine()(h)
      return { ...e, routes: e.routes.map(r => ({ ...r, capability: 'localTranscripts' as const })) }
    }
    const { status } = await load(create, hostServices())
    expect(status).toEqual({ present: false, reason: 'load-failed' })
  })

  it('an engine route outside the reserved prefixes is refused', async () => {
    const create = async (h: EngineHostServices) => {
      const e = await makeFakeEngine()(h)
      return { ...e, routes: [...e.routes, { ...e.routes[0]!, prefix: '/api/exec' }] }
    }
    const { status } = await load(create, hostServices())
    expect(status).toEqual({ present: false, reason: 'load-failed' })
  })

  it('dispatches a route through the host services it was handed', async () => {
    const audit: EngineAuditEvent[] = []
    const { engine } = await load(makeFakeEngine(), hostServices({ audit }))
    const res = await dispatch(engine!, new Request('http://localhost/api/provider/echo', {
      method: 'POST',
      body: JSON.stringify({ say: 'hi' }),
    }))
    expect(res?.status).toBe(200)
    expect(await res!.json()).toEqual({ said: 'hi', lang: 'en' })
    expect(audit.map(a => a.action)).toEqual(['provider.set'])
  })

  it('a path the engine does not own answers null — the host then says 404', async () => {
    const { engine } = await load(makeFakeEngine(), hostServices())
    expect(await dispatch(engine!, new Request('http://localhost/api/provider/other'))).toBeNull()
    expect(await dispatch(engine!, new Request('http://localhost/api/data'))).toBeNull()
  })

  it('an oversized body is refused by the host reader, not buffered', async () => {
    const { engine } = await load(makeFakeEngine(), hostServices())
    const res = await dispatch(engine!, new Request('http://localhost/api/provider/echo', {
      method: 'POST',
      body: JSON.stringify({ say: 'x'.repeat(4096) }),
    }))
    expect(res?.status).toBe(400)
    expect(await res!.json()).toEqual({ error: 'too_large' })
  })

  it('dispatches a command, and the command reads the host, not the environment', async () => {
    const run = async (central: boolean) => {
      const { engine } = await load(makeFakeEngine(), hostServices({ central }))
      const out: string[] = []
      const err: string[] = []
      const cmd = engine!.commands.find(c => c.verb === 'provider')!
      const code = await cmd.run(['list'], { out: l => { out.push(l) }, err: l => { err.push(l) } })
      return { code, out, err }
    }
    expect(await run(false)).toEqual({ code: 0, out: ['provider list'], err: [] })
    expect((await run(true)).code).toBe(1)
  })

  it('replays in chunks, and folding the chunks equals folding it whole', async () => {
    const { engine } = await load(makeFakeEngine(), hostServices())
    const claude = engine!.integrations.claude!
    expect(hasReplay(claude)).toBe(true)
    if (!hasReplay(claude)) return
    const [source] = await claude.replay.discover()
    const seen: string[] = []
    let cursor: ReplayCursor = null
    for (let i = 0; i < 10; i++) {
      const batch = await claude.replay.replay(source!, cursor)
      if (batch.events.length === 0) break
      seen.push(...batch.events.map(e => e.eventId))
      cursor = batch.cursor
    }
    expect(seen).toEqual(FAKE_EVENTS.map(e => e.eventId))
  })

  it('a harness with no replay is a declared absence, never a crash', async () => {
    const { engine } = await load(makeFakeEngine(), hostServices())
    const codex = engine!.integrations.codex!
    expect(hasReplay(codex)).toBe(false)
    expect(codex.replayAbsent).toContain('codex')
    expect(engine!.integrations.gemini).toBeUndefined()
  })

  it('reports health and disposes', async () => {
    const { engine } = await load(makeFakeEngine(), hostServices())
    expect((await engine!.health!()).map(i => i.severity)).toEqual(['info'])
    await engine!.dispose()
    expect(engine!.disposed()).toBe(true)
  })
})

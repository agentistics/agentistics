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
  type EngineSpawnBudget,
  type EngineStatus,
  type ReplayCursor,
} from '@agentistics/engine-api'
import { CAPS } from '../exposure'
import { readJsonLimited } from '../limits'
import { safeError } from '../errors'
import { routeCapability } from '../capability-guard'
import { FAKE_EVENTS, createEngine, makeFakeEngine, type FakeEngine } from './fixtures/fake-engine'
import { buildReuseSurface } from './reuse-surface'
import { engineSpawnBudget, hostFloor, hostServices as realHostServices } from './load'
import { HOME_DIR, OPENCODE_DB_PATH } from '../config'
import { omittedSecrets } from '../backup/backup-plan'
import { admitSpawn } from '../sessions/spawn-admission'
import { memoryBudget } from '../sessions/memory-budget'
import { commandSummary } from '../sessions/shell-writes'
import { REUSE_SURFACE_MEMBERS, floored, missingReuseMembers } from '@agentistics/engine-api'

const GiB = 1024 * 1024 * 1024

/** The host's REAL reuse surface — what `hostServices()` hands an engine. */
const READERS = await buildReuseSurface()

function hostServices(opts: {
  central?: boolean
  audit?: EngineAuditEvent[]
  readers?: EngineHostServices['readers']
  origins?: string[]
  dev?: boolean
  globs?: readonly string[]
  budget?: EngineSpawnBudget
} = {}): EngineHostServices {
  return {
    paths: {
      dataDir: '/tmp/x', defaultDataDir: '/tmp/x', contentDir: '/tmp/x/content', home: '/tmp', harnessRoots: {},
      opencodeDbPath: '/tmp/elsewhere/opencode.db',
    },
    journal: { sink: async () => null, status: () => ({ state: 'disabled', reason: 'no-integrations' }) },
    protectedGlobs: opts.globs ?? [],
    protectedPaths: [],
    caps: CAPS,
    isCentral: () => opts.central ?? false,
    flag: () => false,
    audit: e => { opts.audit?.push(e) },
    readJsonLimited,
    safeError,
    spawnBudget: async () => opts.budget ?? { budget: { max: 1, used: 0, left: 1, percent: 0 }, unmeasured: false },
    notify: () => {},
    lang: () => 'en',
    tasks: {
      fileNative: async () => ({ ok: false, reason: 'not in this build' }),
      unfileNative: async () => {},
    },
    readers: opts.readers ?? READERS,
    originPolicy: () => ({ allowedOrigins: opts.origins ?? [], dev: opts.dev ?? false }),
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

  it('1.2: reads the reuse surface, the origin policy and the opencode file the host handed over', async () => {
    const { engine } = await load(makeFakeEngine(), hostServices({ origins: ['https://ok.example'] }))
    const ask = (origin: string) => dispatch(engine!, new Request(
      'http://localhost/api/provider/reuse?cmd=cd%20/x%20%26%26%20bun%20test&tool=shell',
      { headers: { origin } },
    ))
    const ok = await (await ask('https://ok.example'))!.json()
    expect(ok.summary).toBe(commandSummary('cd /x && bun test'))
    expect(ok.tool).toBe(READERS.canonicalTool('codex', 'shell'))
    expect(ok.originAllowed).toBe(true)
    expect(ok.dev).toBe(false)
    expect(ok.opencodeDbPath).toBe('/tmp/elsewhere/opencode.db')
    expect((await (await ask('https://evil.example'))!.json()).originAllowed).toBe(false)
  })

  it('1.2: an incomplete reuse surface is named member by member, never half-used', async () => {
    const { planTranscriptRead: _, ...partial } = READERS
    const { engine } = await load(makeFakeEngine(), hostServices({ readers: partial as EngineHostServices['readers'] }))
    const res = await dispatch(engine!, new Request('http://localhost/api/provider/reuse'))
    expect(res?.status).toBe(503)
    expect(await res!.json()).toEqual({ missing: ['planTranscriptRead'] })
  })
})

describe('the real host services (1.2)', () => {
  it('hand over every reuse member, the host\'s own functions', async () => {
    const h = await realHostServices()
    expect(missingReuseMembers(h.readers)).toEqual([])
    expect(Object.keys(READERS).sort()).toEqual([...REUSE_SURFACE_MEMBERS].sort())
    expect(h.readers.commandSummary).toBe(commandSummary)
  })

  it('name the opencode database file the host resolved, and its origin policy', async () => {
    const h = await realHostServices()
    expect(h.paths.opencodeDbPath).toBe(OPENCODE_DB_PATH)
    const p = h.originPolicy()
    expect(Array.isArray(p.allowedOrigins)).toBe(true)
    expect(p.dev).toBe(process.env.SERVE_STATIC !== '1')
  })
})

describe('1.3: the floor arrives as globs, the budget carries its alarm and whether it was measured', () => {
  const HOME = '/home/u'
  const real = hostFloor(omittedSecrets(), HOME)
  const at = (p: string) => new Request(`http://localhost/api/provider/floor?path=${encodeURIComponent(p)}`)

  it('an engine reading protectedGlobs floors a .key file under a harness home, flat and nested', async () => {
    const h = { ...hostServices({ globs: real.globs }), paths: { ...hostServices().paths, home: HOME } }
    const { engine } = await load(makeFakeEngine(), h)
    const ask = async (p: string) => (await (await dispatch(engine!, at(p)))!.json()).floored
    expect(await ask(`${HOME}/.claude/x.key`)).toBe(true)
    expect(await ask(`${HOME}/.claude/sessions/1.abc/creds.key.json`)).toBe(true)
    expect(await ask(`${HOME}/.claude/.credentials.json`)).toBe(true)
    expect(await ask(`${HOME}/work/repo/src/hotkey.keymap.ts`)).toBe(false)
  })

  it('every backup-plan secret row outside the data dir lands on the floor', () => {
    const rows = omittedSecrets().filter(r => !r.pattern.startsWith('.agentistics'))
    expect(rows.length).toBeGreaterThan(5)
    for (const r of rows) {
      const p = r.pattern.split('#')[0]!
      const sample = r.match === 'contains' && !p.includes('/') ? `${HOME}/.claude/sessions/1${p}` : `${HOME}/${p}`
      expect({ row: r.pattern, floored: floored(real.globs, sample, HOME) }).toEqual({ row: r.pattern, floored: true })
    }
  })

  it('the 1.2 protectedPaths withdraws nothing it carried, and now carries the contains globs too', () => {
    for (const r of omittedSecrets()) expect(real.paths).toContain(`${HOME}/${r.pattern}`)
    expect(real.paths.some(p => p.startsWith(`${HOME}/.claude/`) && p.endsWith('*.key*'))).toBe(true)
  })

  it('unmeasured admits and says so; a measured max 0 refuses; the swap alarm refuses whatever left says', async () => {
    const admission = async (budget: EngineSpawnBudget) => {
      const { engine } = await load(makeFakeEngine(), hostServices({ budget }))
      return (await (await dispatch(engine!, new Request('http://localhost/api/provider/admission?n=1')))!.json())
    }
    expect(await admission(engineSpawnBudget(null))).toEqual({ admit: true, unmeasured: true })
    expect(await admission({ budget: { max: 0, used: 0, left: 0, percent: 99 }, unmeasured: false }))
      .toEqual({ admit: false, reason: 'no-room', fits: 0 })
    expect(await admission({ budget: { max: 9, used: 1, left: 8, percent: 90, alarm: 'swap' }, unmeasured: false }))
      .toEqual({ admit: false, reason: 'swap', fits: 0 })
  })
})

describe('engineSpawnBudget — the same measurement admitSpawn decides from', () => {
  const sample = (swapUsed: number) => ({ total: 16 * GiB, available: 8 * GiB, swapTotal: 4 * GiB, swapUsed })
  const measured = (swapUsed: number, sessions = 2) => ({
    sample: sample(swapUsed),
    budget: memoryBudget({ sample: sample(swapUsed), sessionBytes: sessions * 500 * 1024 * 1024, sessions }),
  })

  it('null is unmeasured, never a zero budget read as "no room"', () => {
    expect(engineSpawnBudget(null).unmeasured).toBe(true)
    expect(admitSpawn(null, 1)).toMatchObject({ admit: true, unmeasured: true })
  })

  it('a tripped swap alarm is carried, and admitSpawn refuses on the very same read', () => {
    const read = measured(Math.round(3.9 * GiB))
    const e = engineSpawnBudget(read)
    expect(e).toMatchObject({ unmeasured: false, budget: { alarm: 'swap' } })
    expect(e.budget.left).toBeGreaterThan(0)
    expect(admitSpawn(read, 1)).toMatchObject({ admit: false, refusal: { reason: 'swap' } })
  })

  it('a calm machine carries no alarm and the same numbers admitSpawn reads', () => {
    const read = measured(0)
    const e = engineSpawnBudget(read)
    expect(e.unmeasured).toBe(false)
    expect(e.budget.alarm).toBeUndefined()
    expect(e.budget).toMatchObject({ max: read.budget.max, used: read.budget.used, left: read.budget.left })
  })
})

describe('the real host services (1.3)', () => {
  it('hand over the floor derived from the backup plan, as globs and as 1.2 paths', async () => {
    const h = await realHostServices()
    const expected = hostFloor(omittedSecrets(), HOME_DIR)
    expect([...h.protectedGlobs]).toEqual([...expected.globs])
    expect([...h.protectedPaths]).toEqual([...expected.paths])
    expect(h.protectedGlobs.some(g => g.endsWith('/**/*.key*'))).toBe(true)
  })

  it('answer the spawn budget with an explicit unmeasured flag', async () => {
    const b = await (await realHostServices()).spawnBudget()
    expect(typeof b.unmeasured).toBe('boolean')
  })
})

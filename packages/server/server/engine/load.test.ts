/**
 * The host's engine door (`load.ts`), the CLI verbs (`cli.ts`), the journal fed through it, and the
 * slot generator — driven against the FAKE engine and against no engine at all, so both builds are
 * exercised by public CI whichever slot this checkout happens to hold.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import type { CreateEngine, EngineHostServices } from '@agentistics/engine-api'
import { CAPS } from '../exposure'
import { readJsonLimited } from '../limits'
import { safeError } from '../errors'
import { analyzeJournalStatus, appendEngineHealth } from '../health'
import type { HealthIssue } from '@agentistics/core'
import { createShadow } from '../journal/shadow'
import { openJournal } from '../journal/journal'
import { renderJournalStatus, type JournalReport } from '../cli-journal'
import { chooseSlot, renderSlot } from '../../scripts/engine-slot'
import { engine, engineDisabled, engineIntegrations, engineStatus, loadEngine, refusalLine, resetEngineForTests } from './load'
import { ENGINE_ABSENT_EXIT, engineHelpLines, isEngineVerb, resolveEngineVerb } from './cli'
import { makeFakeEngine, type FakeEngineOptions } from './fixtures/fake-engine'
import { buildReuseSurface } from './reuse-surface'

const READERS = await buildReuseSurface()

function host(): EngineHostServices<AgentisticsEvent> {
  return {
    paths: { dataDir: '/tmp/x', defaultDataDir: '/tmp/x', contentDir: '/tmp/x/c', home: '/tmp', harnessRoots: {}, opencodeDbPath: '/tmp/x/opencode.db' },
    journal: { sink: async () => null, status: () => ({ state: 'disabled', reason: 'flag-off' }) },
    protectedGlobs: [],
    protectedPaths: [],
    caps: CAPS,
    isCentral: () => false,
    flag: () => false,
    audit: () => {},
    readJsonLimited,
    safeError,
    spawnBudget: async () => ({ budget: { max: 1, used: 0, left: 1, percent: 0 }, unmeasured: false }),
    notify: () => {},
    lang: () => 'en',
    tasks: { fileNative: async () => ({ ok: false, reason: 'test' }), unfileNative: async () => {} },
    readers: READERS,
    originPolicy: () => ({ allowedOrigins: [], dev: false }),
    now: () => new Date('2026-09-30T12:00:00.000Z'),
  }
}

/** The fake engine is written against the minimal event mirror; the host instantiates it with its own. */
const fake = (o: FakeEngineOptions = {}) => makeFakeEngine(o) as unknown as CreateEngine<AgentisticsEvent>
const quiet = { host, log: () => {}, env: {} }

// `loadEngine` answers once per process, and another test file in the same run may already have
// loaded the real slot — so every test starts from an unloaded host, not only the ones after it.
beforeEach(() => resetEngineForTests())
afterEach(() => resetEngineForTests())

describe('loadEngine — the community build and the official one', () => {
  it('a null slot is a community build: no engine, no integrations, said as such', async () => {
    expect(await loadEngine({ ...quiet, create: null })).toEqual({ present: false, reason: 'community-build' })
    expect(engine()).toBeNull()
    expect(engineIntegrations()).toEqual({})
    expect(engineStatus()).toEqual({ present: false, reason: 'community-build' })
  })

  it('an engine in the slot is loaded, judged and frozen', async () => {
    const st = await loadEngine({ ...quiet, create: fake() })
    expect(st.present).toBe(true)
    expect(Object.keys(engineIntegrations())).toEqual(['claude', 'codex'])
    expect(Object.isFrozen(engine()!.routes)).toBe(true)
  })

  it('AGENTISTICS_ENGINE=0 switches a present engine off without creating it', async () => {
    let created = 0
    const create: CreateEngine<AgentisticsEvent> = async h => { created++; return fake()(h) }
    expect(await loadEngine({ ...quiet, create, env: { AGENTISTICS_ENGINE: '0' } })).toEqual({ present: false, reason: 'disabled' })
    expect(created).toBe(0)
    expect(engineDisabled({ AGENTISTICS_ENGINE: 'off' })).toBe(true)
    expect(engineDisabled({ AGENTISTICS_ENGINE: '1' })).toBe(false)
    expect(engineDisabled({})).toBe(false)
  })

  it('a contract mismatch is refused, logged and runs as a community build', async () => {
    const log: string[] = []
    expect(await loadEngine({ ...quiet, log: l => { log.push(l) }, create: fake({ apiVersion: '2.0.0' }) }))
      .toEqual({ present: false, reason: 'api-mismatch' })
    expect(engine()).toBeNull()
    expect(log.some(l => l.includes('contract 2.0.0'))).toBe(true)
  })

  it('an engine that throws at creation never takes the host down', async () => {
    const create: CreateEngine<AgentisticsEvent> = async () => { throw new Error('boom') }
    const log: string[] = []
    expect(await loadEngine({ ...quiet, log: l => { log.push(l) }, create })).toEqual({ present: false, reason: 'load-failed' })
    expect(log.join('\n')).toContain('ref ')
  })

  it('a route that would weaken the guard on its prefix is refused at load', async () => {
    const create: CreateEngine<AgentisticsEvent> = async h => {
      const e = await fake()(h)
      return { ...e, routes: e.routes.map(r => ({ ...r, capability: 'localTranscripts' as const })) }
    }
    expect(await loadEngine({ ...quiet, create })).toEqual({ present: false, reason: 'load-failed' })
  })

  it('loads once: a second caller gets the first answer', async () => {
    await loadEngine({ ...quiet, create: null })
    expect(await loadEngine({ ...quiet, create: fake() })).toEqual({ present: false, reason: 'community-build' })
  })

  it('every refusal has its own sentence', () => {
    expect(refusalLine({ kind: 'route-not-reserved', prefix: '/api/exec' })).toContain('/api/exec')
    expect(refusalLine({ kind: 'duplicate-command', verb: 'code' })).toContain('code')
    expect(refusalLine({ kind: 'route-capability', prefix: '/api/provider', declared: 'localChat', expected: 'localShell' }))
      .toContain('localShell')
  })
})

describe('the engine verbs at the command line', () => {
  it('recognises exactly the three verbs', () => {
    expect(['code', 'provider', 'ingest'].every(isEngineVerb)).toBe(true)
    expect(isEngineVerb('server')).toBe(false)
    expect(isEngineVerb(undefined)).toBe(false)
  })

  it('a community build SAYS the verb is in the official build, in both languages', () => {
    const en = resolveEngineVerb('code', { present: false, reason: 'community-build' }, [], 'en')
    expect('refuse' in en && en.refuse).toContain('official build')
    const pt = resolveEngineVerb('code', { present: false, reason: 'community-build' }, [], 'pt')
    expect('refuse' in pt && pt.refuse).toContain('build oficial')
    expect(ENGINE_ABSENT_EXIT).toBe(2)
  })

  it('each absent reason is a different sentence', () => {
    const reasons = ['community-build', 'disabled', 'api-mismatch', 'load-failed'] as const
    const said = reasons.map(reason => {
      const d = resolveEngineVerb('provider', { present: false, reason }, [], 'en')
      return 'refuse' in d ? d.refuse : ''
    })
    expect(new Set(said).size).toBe(reasons.length)
  })

  it('an engine without the verb says so, and one with it runs it', async () => {
    const e = await fake()(host())
    const st = { present: true as const, manifest: e.manifest }
    const missing = resolveEngineVerb('code', st, e.commands, 'en')
    expect('refuse' in missing && missing.refuse).toContain('does not provide it')
    const found = resolveEngineVerb('provider', st, e.commands, 'en')
    expect('run' in found && found.run.verb).toBe('provider')
  })

  it('the help lists every engine verb, marking the ones this build lacks', async () => {
    const none = engineHelpLines(null).join('\n')
    for (const v of ['code', 'provider', 'ingest']) expect(none).toContain(`  ${v}`)
    expect(none.match(/\(official build\)/g)?.length).toBe(3)
    const e = await fake()(host())
    const some = engineHelpLines(e.commands).join('\n')
    expect(some).toContain('fake provider command')
    expect(some.match(/\(official build\)/g)?.length).toBe(2)
  })
})

describe('the journal, fed through the engine', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'agentistics-engine-')); dirs.push(d); return d }

  it('with no integrations the journal is on, EMPTY, and says why — no file is opened', async () => {
    const dir = tmp()
    const statusPath = join(dir, 'journal.db.status.json')
    let opened = 0
    let registered: (() => unknown) | null = null
    const shadow = createShadow({
      enabled: true,
      integrations: {},
      open: async () => { opened++; throw new Error('must not open') },
      statusPath,
      registerStatus: s => { registered = s },
    })
    expect(await shadow.ingest([{ session_id: 'a' }])).toEqual({ status: 'off', reason: 'no-integrations' })
    expect(opened).toBe(0)
    expect(JSON.parse(readFileSync(statusPath, 'utf8')).off).toBe('no-integrations')
    const issues: HealthIssue[] = []
    analyzeJournalStatus((registered as unknown as () => Parameters<typeof analyzeJournalStatus>[0])(), issues)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.severity).toBe('info')
    expect(issues[0]!.id).toBe('journal-no-integrations')
  })

  it("with the engine's integrations it replays through them (a getter, read per run)", async () => {
    const dir = tmp()
    const e = await fake()(host())
    let registry = {}
    const journal = await openJournal({ path: join(dir, 'journal.db') })
    const shadow = createShadow({
      enabled: true,
      integrations: () => registry,
      open: async () => journal,
      statusPath: null,
      stamps: null,
      registerStatus: () => {},
    })
    expect((await shadow.ingest([{ session_id: 'fake-session' }])).status).toBe('off')
    registry = e.integrations
    const ran = await shadow.ingest([{ session_id: 'fake-session' }])
    expect(ran.status).toBe('ran')
    if (ran.status === 'ran') expect(ran.sources).toBe(1)
    journal.close()
  })

  it('`agentop journal status` says the same sentence', () => {
    const report: JournalReport = {
      path: '/x/journal.db', present: false, pathKind: 'local', flag: '1', sinceBoot: null, differential: null,
      noIntegrations: true,
    }
    expect(renderJournalStatus(report)).toContain('no integration to feed the journal')
    expect(renderJournalStatus({ ...report, noIntegrations: false })).not.toContain('Feeder')
  })

  it("an engine's health that throws contributes one issue and never takes the check down", async () => {
    const issues: HealthIssue[] = []
    await appendEngineHealth(issues, async () => { throw new Error('boom') })
    expect(issues.map(i => i.id)).toEqual(['engine-health-failed'])
    await appendEngineHealth(issues, null)
    expect(issues).toHaveLength(1)
  })
})

describe('the slot generator', () => {
  const base = { nullRequested: false, engineDir: undefined, packageExists: false }

  it('chooses in order: --null, an engine dir, the package, else null', () => {
    expect(chooseSlot({ ...base, nullRequested: true, engineDir: '/e', packageExists: true })).toEqual({ kind: 'null' })
    expect(chooseSlot({ ...base, engineDir: '/e', packageExists: true })).toEqual({ kind: 'dir', dir: '/e' })
    expect(chooseSlot({ ...base, packageExists: true })).toEqual({ kind: 'package' })
    expect(chooseSlot(base)).toEqual({ kind: 'null' })
    expect(chooseSlot({ ...base, engineDir: '  ' })).toEqual({ kind: 'null' })
  })

  it('the null slot names no engine; the others import exactly one', () => {
    const nul = renderSlot({ kind: 'null' }, '/r/packages/server/server')
    expect(nul).toContain('createEngine: CreateEngine<AgentisticsEvent> | null = null')
    expect(nul).not.toMatch(/from '(\.\/engine|@agentistics\/engine')/)
    expect(renderSlot({ kind: 'package' }, '/r')).toContain("from '@agentistics/engine'")
    expect(renderSlot({ kind: 'dir', dir: '/r/engine/src/index.ts' }, '/r/packages/server/server'))
      .toContain("from '../../../engine/src/index.ts'")
  })
})

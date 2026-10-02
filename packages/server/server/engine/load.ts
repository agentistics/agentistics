/**
 * engine/load.ts — the host's ONE door to an engine.
 *
 * `engine-slot.generated.ts` says WHICH engine this build carries (or `null`: the community build);
 * this module creates it once, judges it against the contract, and hands the rest of the host three
 * answers: `engine()`, `engineIntegrations()` and `engineStatus()`. Nothing else in the host names
 * the slot, the in-tree engine or an engine package.
 *
 * Rules it exists to hold:
 * - **A failed or mismatched engine never takes the product down.** Creating it throws → logged
 *   with a `safeError` ref, `load-failed`. A contract version this host cannot serve →
 *   `api-mismatch`. A route or command the host refuses → `load-failed`, with every refusal logged.
 *   In all three the host runs as a community build.
 * - **An engine route may not weaken the guard on its own door.** `checkEngine` is given the
 *   capability guard's own table, so a route declaring any other capability than the one this
 *   repository holds for its prefix is refused.
 * - **`AGENTISTICS_ENGINE=0` switches a present engine off** (`disabled`) — the free path on an
 *   official binary, for a person who wants it.
 * - **Loading is lazy and happens once.** A process that never asks never loads one, and `bin/cli.ts`
 *   imports the slot for every command — so every heavy import sits behind a call.
 */
import {
  ENGINE_API_VERSION,
  checkEngine,
  protectedGlobs,
  type CreateEngine,
  type Engine,
  type EngineHostServices,
  type EngineRefusal,
  type EngineSpawnBudget,
  type EngineStatus,
  type IntegrationRegistry,
} from '@agentistics/engine-api'
import type { AgentisticsEvent } from '@agentistics/core'
import type { SpawnBudget } from '../sessions/spawn-admission'
import { createEngine as slotEngine } from '../engine-slot.generated'
import { engineSecrets, routeEngineVaultAudit } from '../vault/engine-secrets'

export type HostEngine = Engine<AgentisticsEvent>
export type HostIntegrations = IntegrationRegistry<AgentisticsEvent>

interface Loaded {
  status: EngineStatus
  engine: HostEngine | null
}

let loaded: Loaded | null = null
let loading: Promise<Loaded> | null = null

export interface LoadEngineOptions {
  /** Default: the slot. `null` = the community build. */
  create?: CreateEngine<AgentisticsEvent> | null
  /** Default: the real host services (`hostServices()`). */
  host?: () => Promise<EngineHostServices<AgentisticsEvent>> | EngineHostServices<AgentisticsEvent>
  /** Default `process.env`. */
  env?: Record<string, string | undefined>
  /** Default `console.error`. */
  log?: (line: string) => void
}

/** PURE. The sentence a refusal is logged with. */
export function refusalLine(r: EngineRefusal): string {
  switch (r.kind) {
    case 'api-mismatch': return `the engine was built against contract ${r.engine}; this host serves ${r.host}`
    case 'route-not-reserved': return `the engine offered a route under ${r.prefix}, which is not a reserved prefix`
    case 'route-capability': return `the engine declared ${r.declared} for ${r.prefix}; the host's guard holds ${r.expected ?? 'nothing'} there`
    case 'duplicate-command': return `the engine offered the verb ${r.verb} twice`
  }
}

/** PURE. `AGENTISTICS_ENGINE=0` (or `false`/`off`/`no`) switches a present engine off. */
export function engineDisabled(env: Record<string, string | undefined>): boolean {
  const v = env.AGENTISTICS_ENGINE?.trim().toLowerCase()
  return v === '0' || v === 'false' || v === 'off' || v === 'no'
}

/**
 * Creates and judges the engine. Never throws. The first call's options win: this is a process-wide
 * decision, and a second caller asking with different options is asking a question that was already
 * answered (tests reset with `resetEngineForTests`).
 */
export function loadEngine(opts: LoadEngineOptions = {}): Promise<EngineStatus> {
  if (loaded) return Promise.resolve(loaded.status)
  loading ??= doLoad(opts).then(l => { loaded = l; return l })
  return loading.then(l => l.status)
}

async function doLoad(opts: LoadEngineOptions): Promise<Loaded> {
  const create = opts.create === undefined ? slotEngine : opts.create
  const env = opts.env ?? process.env
  const log = opts.log ?? ((l: string) => console.error(l))
  if (create === null) return { status: { present: false, reason: 'community-build' }, engine: null }
  if (engineDisabled(env)) return { status: { present: false, reason: 'disabled' }, engine: null }

  let engine: HostEngine
  try {
    const host = await (opts.host ?? hostServices)()
    engine = await create(host)
  } catch (err) {
    const { safeError } = await import('../errors')
    const safe = safeError(err, { verbose: false })
    log(`[engine] the engine failed to load (ref ${safe.body.ref}) — running as a community build`)
    log(safe.logLine)
    return { status: { present: false, reason: 'load-failed' }, engine: null }
  }

  const { routeCapability } = await import('../capability-guard')
  const refusals = checkEngine(engine, ENGINE_API_VERSION, routeCapability)
  if (refusals.length > 0) {
    for (const r of refusals) log(`[engine] refused: ${refusalLine(r)}`)
    try { await engine.dispose() } catch { /* a dispose that throws changes nothing here */ }
    const mismatch = refusals.some(r => r.kind === 'api-mismatch')
    log(`[engine] the engine was not loaded — running as a community build`)
    return { status: { present: false, reason: mismatch ? 'api-mismatch' : 'load-failed' }, engine: null }
  }

  // Frozen: what was judged is what runs. A route list mutated after the check would be a route the
  // guard never saw.
  Object.freeze(engine.routes)
  Object.freeze(engine.commands)
  return { status: { present: true, manifest: engine.manifest }, engine }
}

/** The loaded engine, or `null` (not loaded yet, community build, disabled, refused). */
export function engine(): HostEngine | null {
  return loaded?.engine ?? null
}

/** The engine's integrations, or `{}`. What the journal is fed from — `{}` feeds it nothing. */
export function engineIntegrations(): HostIntegrations {
  return loaded?.engine?.integrations ?? {}
}

/**
 * What this process knows NOW. Before a load has finished, a build with no engine in its slot is
 * already known to be a community build; one with an engine is answered once `loadEngine` resolves
 * — callers that report it (`/api/engine`, `--version`) await the load first.
 */
export function engineStatus(): EngineStatus {
  if (loaded) return loaded.status
  return { present: false, reason: slotEngine === null ? 'community-build' : 'load-failed' }
}

/** Whether this BUILD carries an engine at all, answered without loading it. */
export function buildHasEngine(): boolean {
  return slotEngine !== null
}

export async function disposeEngine(): Promise<void> {
  const e = loaded?.engine
  if (!e) return
  try { await e.dispose() } catch { /* never on the way out */ }
}

/** Tests only. */
export function resetEngineForTests(): void {
  loaded = null
  loading = null
}

/**
 * PURE. The policy floor handed to an engine, from the backup plan's `secret` rows.
 *
 * `globs` is the floor (1.3) — `protectedGlobs()` from the contract, so the host and every engine
 * derive it ONE way. `paths` is the 1.2 member, kept for an engine built against 1.2: the old
 * `$HOME`-joined rows (so nothing it used to receive is withdrawn) plus the absolute form of every
 * glob, which is how a `contains` row such as `.key` reaches an engine that only reads paths.
 */
export function hostFloor(
  secrets: readonly { pattern: string; match: 'prefix' | 'contains' }[],
  home: string,
): { globs: readonly string[]; paths: readonly string[] } {
  const globs = protectedGlobs(secrets)
  const root = home.replace(/\/+$/, '')
  const paths = new Set<string>(secrets.map(r => `${root}/${r.pattern}`))
  for (const g of globs) paths.add(g.startsWith('~/') ? `${root}/${g.slice(2)}` : g)
  return { globs: Object.freeze(globs), paths: Object.freeze([...paths].sort()) }
}

/**
 * PURE. The admission measurement as an engine reads it — from the SAME `readSpawnBudget()` result
 * `admitSpawn` decides from. `null` (no `/proc/meminfo`) is `unmeasured: true` with a zero budget
 * that carries no meaning; a measured budget carries its swap alarm, which refuses first.
 */
export function engineSpawnBudget(read: SpawnBudget | null): EngineSpawnBudget {
  if (!read) return { budget: { max: 0, used: 0, left: 0, percent: 0 }, unmeasured: true }
  const b = read.budget
  return {
    budget: { max: b.max, used: b.used, left: b.left, percent: b.percent, ...(b.alarm ? { alarm: b.alarm } : {}) },
    unmeasured: false,
  }
}

/**
 * The real host services. Everything machine-specific an engine may use arrives here; each member
 * reads the host's own module rather than re-deriving it, and the heavy ones are imported lazily.
 */
export async function hostServices(): Promise<EngineHostServices<AgentisticsEvent>> {
  const [config, { CAPS }, { readJsonLimited }, { safeError }, { omittedSecrets }] = await Promise.all([
    import('../config'),
    import('../exposure'),
    import('../limits'),
    import('../errors'),
    import('../backup/backup-plan'),
  ])
  const floor = hostFloor(omittedSecrets(), config.HOME_DIR)

  // The mode a machine was CONFIGURED in, read once: a central never runs an engine's runtime, and
  // the host's own `TEAM_CENTRAL` is only half of that answer.
  let centralPref = false
  let lang: 'en' | 'pt' = 'en'
  try {
    const { readPreferences } = await import('../preferences')
    const prefs = await readPreferences()
    const mode: string | undefined = prefs.team?.mode
    centralPref = mode === 'central'
    lang = prefs.lang === 'pt' ? 'pt' : 'en'
  } catch { /* an unreadable preferences file leaves the defaults */ }

  const { buildReuseSurface } = await import('./reuse-surface')
  const readers = await buildReuseSurface()

  let journal: import('../journal/types').Journal | null = null
  return {
    paths: {
      dataDir: config.AGENTISTICS_DATA_DIR,
      defaultDataDir: config.DEFAULT_AGENTISTICS_DATA_DIR,
      contentDir: config.CONTENT_DIR,
      home: config.HOME_DIR,
      harnessRoots: {
        claude: config.CLAUDE_DIR,
        codex: config.CODEX_DIR,
        gemini: config.GEMINI_DIR,
        copilot: config.COPILOT_DIR,
        antigravity: config.ANTIGRAVITY_DIR,
        kimi: config.KIMI_DIR,
        opencode: config.OPENCODE_DIR,
      },
      opencodeDbPath: config.OPENCODE_DB_PATH,
    },
    journal: {
      async sink() {
        if (!config.JOURNAL_ENABLED) return null
        if (!journal) {
          const { openJournal } = await import('../journal/journal')
          journal = await openJournal()
        }
        const j = journal
        return j.status().state === 'open' ? { append: events => j.append([...events]) } : null
      },
      status() {
        if (!journal) return config.JOURNAL_ENABLED ? { state: 'closed' } : { state: 'disabled', reason: 'flag-off' }
        const s = journal.status()
        return s.reason === undefined ? { state: s.state } : { state: s.state, reason: s.reason }
      },
    },
    // The policy floor is DERIVED from the backup plan's `secret` rows — the one table that already
    // names every credential path on this machine — never restated.
    protectedGlobs: floor.globs,
    protectedPaths: floor.paths,
    caps: CAPS,
    isCentral: () => config.TEAM_CENTRAL || centralPref,
    flag: name => (name === 'provider' ? config.providerFlagOn() : process.env.AGENTISTICS_INGEST === '1'),
    audit: e => {
      // 1.5: `vault.*` events go to the machine's own vault/audit.jsonl, never to Mongo.
      if (routeEngineVaultAudit(e)) return
      void import('../audit').then(m => m.writeAudit(e)).catch(() => {})
    },
    readJsonLimited,
    safeError,
    spawnBudget: async () => {
      const { readSpawnBudget } = await import('../sessions/memory-probe')
      return engineSpawnBudget(await readSpawnBudget())
    },
    notify: n => {
      void import('../sse').then(m => m.broadcastNotification(n)).catch(() => {})
    },
    lang: () => lang,
    // Filing a native session on the board arrives with the native runtime; until then the ONE write
    // into a public store an engine may make is refused in words rather than faked.
    tasks: {
      fileNative: async () => ({ ok: false, reason: 'this build has no native sessions to file' }),
      unfileNative: async () => {},
    },
    readers,
    // `SERVE_STATIC` is `sse.ts`'s own reading of the same variable; importing `sse` here would load
    // the embedded dashboard for every engine load.
    originPolicy: () => ({ allowedOrigins: [...config.ALLOWED_ORIGINS], dev: process.env.SERVE_STATIC !== '1' }),
    // 1.5 — the vault, restricted to `engine/…` purposes (vault/engine-secrets.ts).
    secrets: engineSecrets(),
    now: () => new Date(),
  }
}

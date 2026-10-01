/**
 * kit.ts — the engine conformance kit (spec §9, C2: "the same contract test in both repos").
 *
 * `runEngineConformance(createEngine, opts)` creates an engine against a host the caller supplies and
 * judges EVERYTHING the contract promises the host about it — the version, the manifest, the routes
 * and commands the host would refuse, the integration registry's shape and totality, and that a
 * capability is either provided or declared absent, never a crash. It returns findings rather than
 * throwing on the first one, so a failing engine is described whole.
 *
 * It imports `@agentistics/engine-api` and nothing else on purpose: spec §9 puts this kit IN the
 * contract package (`engine-api` exports `runEngineConformance` as a test-only entry). Contract 1.1
 * does not carry it yet, so it lives here and is written to move there verbatim — no import to
 * rewrite, no engine internal named. The public repository's fake engine can then run the very same
 * kit, which is what makes it one contract test rather than two that agree by accident.
 */
import {
  ENGINE_API_VERSION,
  RESERVED_PREFIXES,
  apiCompatible,
  checkEngine,
  hasReplay,
  type CapabilityName,
  type CreateEngine,
  type Engine,
  type EngineEvent,
  type EngineHostServices,
  type HarnessId,
} from '@agentistics/engine-api'

export interface ConformanceOptions<E extends EngineEvent> {
  /** The host the engine is created against. Its harness roots should point at EMPTY directories:
   *  the kit asks every replay to discover, and a real store would make that slow and personal. */
  host: EngineHostServices<E>
  /** The host's own guard table (`capability-guard.ts`'s `routeCapability`). */
  capabilityFor: (prefix: string) => CapabilityName | null
  /** The contract version the HOST serves. Default: the linked engine-api's. */
  hostApiVersion?: string
  /** When given, the registry must cover exactly these harnesses (spec §9: the engine's CI asserts
   *  totality over `HARNESS_ORDER`, since the contract type itself is `Partial`). */
  totalOver?: readonly HarnessId[]
}

export interface ConformanceFinding {
  /** A short stable id, so a test can assert which check failed. */
  check: string
  detail: string
}

export interface ConformanceReport {
  ok: boolean
  findings: ConformanceFinding[]
  /** What was judged — the manifest as created, for the report a person reads. */
  manifest: Engine<EngineEvent>['manifest'] | null
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/
const VERBS = ['code', 'provider', 'ingest'] as const

export async function runEngineConformance<E extends EngineEvent>(
  create: CreateEngine<E>,
  opts: ConformanceOptions<E>,
): Promise<ConformanceReport> {
  const findings: ConformanceFinding[] = []
  const fail = (check: string, detail: string) => findings.push({ check, detail })
  const hostApi = opts.hostApiVersion ?? ENGINE_API_VERSION

  let engine: Engine<E>
  try {
    engine = await create(opts.host)
  } catch (err) {
    fail('create', `createEngine(host) threw: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false, findings, manifest: null }
  }

  // ── manifest ─────────────────────────────────────────────────────────────────────────────────
  const m = engine.manifest
  if (m.name !== 'agentistics-engine') fail('manifest.name', `expected 'agentistics-engine', got ${JSON.stringify(m.name)}`)
  if (!SEMVER.test(m.version)) fail('manifest.version', `not a semver: ${JSON.stringify(m.version)}`)
  if (!SEMVER.test(m.apiVersion)) fail('manifest.apiVersion', `not a semver: ${JSON.stringify(m.apiVersion)}`)
  else if (!apiCompatible(hostApi, m.apiVersion)) fail('api-compatible', `built against ${m.apiVersion}; this host serves ${hostApi}`)

  // ── what the host itself would refuse at load ────────────────────────────────────────────────
  for (const r of checkEngine(engine, hostApi, opts.capabilityFor)) {
    // api-mismatch is already reported above, in words that name both sides.
    if (r.kind !== 'api-mismatch') fail(`host-refuses:${r.kind}`, JSON.stringify(r))
  }

  // ── routes ───────────────────────────────────────────────────────────────────────────────────
  for (const route of engine.routes) {
    if (!(RESERVED_PREFIXES as readonly string[]).includes(route.prefix)) continue // already refused above
    // A path under the prefix that no engine can mean: the route must answer `null` ("not mine",
    // the host's 404) — never claim it, and never throw into the host's request loop. Four nonsense
    // segments deep on purpose: one segment under a prefix is routinely a real parameter
    // (`/api/provider/:id`), and a probe a legitimate route matches judges nothing.
    const url = new URL(`http://127.0.0.1${route.prefix}/__conformance__/no/such/path`)
    try {
      const res = await route.handle(new Request(url, { method: 'GET' }), url, { clientIp: '127.0.0.1' })
      if (res !== null) fail('route.unknown-path', `${route.prefix} answered ${res.status} for a path it cannot serve; expected null`)
    } catch (err) {
      fail('route.throws', `${route.prefix} threw on an unknown sub-path: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── commands ─────────────────────────────────────────────────────────────────────────────────
  for (const c of engine.commands) {
    if (!(VERBS as readonly string[]).includes(c.verb)) fail('command.verb', `unknown verb ${JSON.stringify(c.verb)}`)
    for (const lang of ['en', 'pt'] as const) {
      if (!c.summary?.[lang] || c.summary[lang].trim() === '') fail('command.summary', `${c.verb} has no ${lang} summary`)
    }
    if (typeof c.run !== 'function') fail('command.run', `${c.verb} has no run()`)
  }

  // ── integrations ─────────────────────────────────────────────────────────────────────────────
  const reg = engine.integrations
  const ids = Object.keys(reg) as HarnessId[]
  if (opts.totalOver) {
    const want = [...opts.totalOver].sort()
    const have = [...ids].sort()
    if (JSON.stringify(want) !== JSON.stringify(have)) fail('integrations.total', `covers [${have.join(', ')}], expected [${want.join(', ')}]`)
  }
  const replaying: HarnessId[] = []
  const living: HarnessId[] = []
  for (const id of ids) {
    const i = reg[id]
    if (!i) { fail('integration.entry', `${id} is present with no entry`); continue }
    if (i.id !== id) fail('integration.id', `${id}'s entry names itself ${JSON.stringify(i.id)}`)
    if (typeof i.version !== 'string' || i.version.trim() === '') fail('integration.version', `${id} has an empty adapterVersion`)
    const hasR = i.replay !== undefined
    const hasA = typeof i.replayAbsent === 'string' && i.replayAbsent.trim() !== ''
    if (hasR === hasA) fail('integration.replay-xor-absent', `${id} must state EITHER a replay OR why it has none`)
    if (hasReplay(i)) {
      replaying.push(id)
      // Total: an unreadable or empty store yields `[]`, never a throw (contract, `HarnessReplay`).
      try {
        const found = await i.replay.discover()
        if (!Array.isArray(found)) fail('replay.discover', `${id}.discover() did not answer a list`)
      } catch (err) {
        fail('replay.discover', `${id}.discover() threw over an empty store: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (i.live) living.push(id)
  }
  const same = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
  if (!same(m.provides.replay, replaying)) fail('manifest.replay', `declares [${m.provides.replay.join(', ')}], the registry replays [${replaying.join(', ')}]`)
  if (!same(m.provides.live, living)) fail('manifest.live', `declares [${m.provides.live.join(', ')}], the registry is live for [${living.join(', ')}]`)

  // ── a declared absence is never a crash ─────────────────────────────────────────────────────
  if (engine.codeHost !== undefined && typeof engine.codeHost !== 'function') fail('codeHost', 'present but not a function')
  if (m.provides.nativeRuntime && engine.codeHost === undefined) fail('codeHost', 'manifest declares a native runtime but offers no code host')
  if (engine.health) {
    try {
      const issues = await engine.health()
      if (!Array.isArray(issues)) fail('health', 'health() did not answer a list')
    } catch (err) {
      fail('health', `health() threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try {
    await engine.dispose()
  } catch (err) {
    fail('dispose', `dispose() threw: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { ok: findings.length === 0, findings, manifest: m }
}

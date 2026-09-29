/**
 * engine.ts — what an engine gives the host, and how the host judges it at load.
 *
 * The engine package has ONE export, `createEngine: CreateEngine`. A capability it does not provide
 * is a DECLARED absence in its manifest, never a crash, and a failed or mismatched engine never
 * takes the product down: the host logs it and runs as a community build (`EngineStatus`).
 */
import type { HarnessId, ProviderId, CapabilityName, EngineEvent, EngineHealthIssue } from './mirrors'
import type { IntegrationRegistry } from './integration'
import type { EngineHostServices, PersonAsker } from './host'
import { apiCompatible } from './version'

export interface EngineManifest {
  name: 'agentistics-engine'
  /** The engine's own release. */
  version: string
  /** The contract version it was built against. */
  apiVersion: string
  /** What this engine can do HERE. */
  provides: {
    nativeRuntime: boolean
    replay: HarnessId[]
    live: HarnessId[]
    providers: ProviderId[]
  }
}

/** The host serves every engine route AFTER its capability guard, auth gate and Host allowlist. */
export interface EngineRoute {
  /** Must be one of `RESERVED_PREFIXES`; the host refuses anything else at load. */
  prefix: string
  /** The capability the host's own guard table holds for `prefix` — never a new one. */
  capability: CapabilityName
  /** `null` = not mine; the host answers 404. */
  handle(req: Request, url: URL): Promise<Response | null>
}

/** The only prefixes an engine route may live under. There is no field for a public route. */
export const RESERVED_PREFIXES = [
  '/api/runtime/sessions',
  '/api/provider',
  '/api/ingest',
  '/v1/logs',
  '/v1/metrics',
] as const

export type ReservedPrefix = (typeof RESERVED_PREFIXES)[number]

export interface CommandIO {
  out(line: string): void
  err(line: string): void
}

export interface EngineCommand {
  verb: 'code' | 'provider' | 'ingest'
  /** Help text in both languages; the host prints it in `agentop --help`. */
  summary: Record<'en' | 'pt', string>
  /** Exit code. */
  run(args: string[], io: CommandIO): Promise<number>
  /** A full-screen command — the host must know BEFORE it takes the tty. */
  wantsTty?(args: string[], tty: { stdin: boolean; stdout: boolean }): boolean
}

/**
 * The control center's `code` tab. Opaque in this version: its event types join the contract when
 * the tab does (a minor bump). The host only ever passes it back to the renderer it came with.
 */
export interface CodeHost {
  readonly kind: 'code-host'
  dispose(): Promise<void>
}

export interface Engine<E extends EngineEvent = EngineEvent> {
  manifest: EngineManifest
  /** Replay + live per harness. PARTIAL on purpose. */
  integrations: IntegrationRegistry<E>
  routes: EngineRoute[]
  commands: EngineCommand[]
  /** Absent = no `code` tab. */
  codeHost?: (askerFor: (sessionId: string) => PersonAsker) => Promise<CodeHost>
  /** Health checks the engine contributes. */
  health?: () => Promise<EngineHealthIssue[]>
  dispose(): Promise<void>
}

export type CreateEngine<E extends EngineEvent = EngineEvent> = (
  host: EngineHostServices<E>,
) => Promise<Engine<E>>

export type EngineAbsentReason = 'community-build' | 'api-mismatch' | 'load-failed' | 'disabled'

export type EngineStatus =
  | { present: true; manifest: EngineManifest }
  | { present: false; reason: EngineAbsentReason }

/** PURE. Is `prefix` one of the reserved ones? Exact match — no sub-path, no trailing slash. */
export function isReservedPrefix(prefix: string): prefix is ReservedPrefix {
  return (RESERVED_PREFIXES as readonly string[]).includes(prefix)
}

export type EngineRefusal =
  | { kind: 'api-mismatch'; host: string; engine: string }
  | { kind: 'route-not-reserved'; prefix: string }
  | { kind: 'route-capability'; prefix: string; declared: CapabilityName; expected: CapabilityName | null }
  | { kind: 'duplicate-command'; verb: EngineCommand['verb'] }

/**
 * PURE. The host's load-time judgement of an engine: the contract version, and every route and
 * command it offers. `capabilityFor` is the host's OWN guard table — a route whose declared
 * capability differs from it is refused, so an engine can never weaken the guard on its prefix.
 * An empty list means the engine may be loaded.
 */
export function checkEngine(
  engine: Pick<Engine<EngineEvent>, 'manifest' | 'routes' | 'commands'>,
  hostApiVersion: string,
  capabilityFor: (prefix: string) => CapabilityName | null,
): EngineRefusal[] {
  const refusals: EngineRefusal[] = []
  if (!apiCompatible(hostApiVersion, engine.manifest.apiVersion)) {
    refusals.push({ kind: 'api-mismatch', host: hostApiVersion, engine: engine.manifest.apiVersion })
  }
  for (const r of engine.routes) {
    if (!isReservedPrefix(r.prefix)) {
      refusals.push({ kind: 'route-not-reserved', prefix: r.prefix })
      continue
    }
    const expected = capabilityFor(r.prefix)
    if (expected !== r.capability) {
      refusals.push({ kind: 'route-capability', prefix: r.prefix, declared: r.capability, expected })
    }
  }
  const seen = new Set<string>()
  for (const c of engine.commands) {
    if (seen.has(c.verb)) refusals.push({ kind: 'duplicate-command', verb: c.verb })
    seen.add(c.verb)
  }
  return refusals
}

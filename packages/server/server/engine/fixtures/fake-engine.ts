/**
 * fixtures/fake-engine.ts — a TEST-ONLY engine, for public CI.
 *
 * It implements `createEngine(host)` against `@agentistics/engine-api` and nothing else: no
 * provider, no runtime, no real integration, no file read. Its integration replays a fixed list of
 * events held in memory; its route and command answer from the host services they were handed.
 * That is exactly enough to exercise the HOST side of the contract (load, version check, route
 * guard, command dispatch, dispose) with no engine present.
 *
 * Never import this from product code — it lives under `fixtures/` for that reason.
 */
import {
  ENGINE_API_VERSION,
  type CreateEngine,
  type Engine,
  type EngineEvent,
  type EngineHostServices,
  type ReplaySource,
} from '@agentistics/engine-api'

export const FAKE_ENGINE_VERSION = '0.0.0-fake'

/** The events the fake `claude` integration replays, two per call at most. */
export const FAKE_EVENTS: readonly EngineEvent[] = [
  { eventId: 'fake-1', type: 'session.started', occurredAt: '2026-09-29T10:00:00.000Z' },
  { eventId: 'fake-2', type: 'turn.started', occurredAt: '2026-09-29T10:00:01.000Z' },
  { eventId: 'fake-3', type: 'turn.ended', occurredAt: '2026-09-29T10:00:05.000Z' },
]

const SOURCE: ReplaySource = { sessionId: 'fake-session', sourceRef: 'fake://session' }

export interface FakeEngineOptions {
  /** Override the contract version the engine claims — how a test builds a mismatched engine. */
  apiVersion?: string
}

/** A fake engine that also exposes whether it was disposed. */
export type FakeEngine = Engine & { readonly disposed: () => boolean }

export function makeFakeEngine(opts: FakeEngineOptions = {}): (host: EngineHostServices) => Promise<FakeEngine> {
  return async host => {
    let disposed = false
    return {
      manifest: {
        name: 'agentistics-engine',
        version: FAKE_ENGINE_VERSION,
        apiVersion: opts.apiVersion ?? ENGINE_API_VERSION,
        provides: { nativeRuntime: false, replay: ['claude'], live: [], providers: [] },
      },
      integrations: {
        claude: {
          id: 'claude',
          version: FAKE_ENGINE_VERSION,
          capabilities: {},
          replay: {
            discover: async () => [SOURCE],
            replay: async (source, cursor) => {
              if (source.sessionId !== SOURCE.sessionId) return { events: [], cursor }
              const from = cursor === null ? 0 : Number(cursor)
              const events = FAKE_EVENTS.slice(from, from + 2)
              return { events: [...events], cursor: String(from + events.length) }
            },
          },
        },
        codex: {
          id: 'codex',
          version: FAKE_ENGINE_VERSION,
          capabilities: {},
          replayAbsent: 'the fake engine carries no codex integration',
        },
      },
      routes: [
        {
          prefix: '/api/provider',
          capability: 'localShell',
          async handle(req, url) {
            if (url.pathname !== '/api/provider/echo') return null
            const body = await host.readJsonLimited<{ say?: unknown }>(req, 1024)
            if (!body.ok) return Response.json({ error: body.error }, { status: 400 })
            host.audit({ action: 'provider.set', ip: '127.0.0.1', meta: { fake: true } })
            return Response.json({ said: body.value.say ?? null, lang: host.lang() })
          },
        },
      ],
      commands: [
        {
          verb: 'provider',
          summary: { en: 'fake provider command', pt: 'comando de provedor falso' },
          async run(args, io) {
            if (host.isCentral()) {
              io.err('refused: a central runs no engine command')
              return 1
            }
            io.out(`provider ${args.join(' ')}`.trim())
            return 0
          },
        },
      ],
      health: async () => [
        { id: 'fake-engine', severity: 'info', title: 'fake engine loaded', description: 'test fixture' },
      ],
      async dispose() {
        disposed = true
      },
      disposed: () => disposed,
    }
  }
}

/** The ONE export shape a real engine package has. */
export const createEngine: CreateEngine = makeFakeEngine()

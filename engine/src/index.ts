/**
 * @agentistics/engine — the ONE export the host loads: `createEngine` (spec §2, contract 1.2).
 *
 * What it does, in order:
 *  1. installs the host (`host.ts`) — every default that used to read the public `config.ts` reads
 *     these services from now on;
 *  2. takes the host's reuse surface (`host.readers`, contract 1.2 — `reuse.ts`, spec §6), and
 *     refuses an incomplete one by throwing: the host then runs as a community build;
 *  3. builds the integration registry — TOTAL over `HarnessId` (spec §9) — and derives the
 *     manifest's `replay` from it rather than restating it;
 *  4. offers the provider route and the `provider` verb, exactly as the public tree's
 *     `engine/in-tree.ts` packaged them before the move;
 *  5. offers the native sessions (B4, replayed by ES.6a): the `/api/runtime/sessions` route — every
 *     B4 resource nested under that ONE reserved prefix (leader decision Q-4) — and the `code` verb.
 *
 * What it does NOT offer yet, and why: `ingest` (live ingestion, A5) lives on
 * `feat/a5-live-ingestion` and arrives by its own step-6 replay. Absent from `commands`, the host
 * answers `agentop ingest` with its own "not provided yet" sentence. `codeHost` is offered (the session
 * host the `code` tab will drive), but the control center's `code` TAB that renders it arrives with
 * `held/feat/harness-tui-p2` — until then the public host does not read it.
 *
 * Everything heavy is imported inside a handler: the host imports the slot for every command, and
 * `agentop --version` must not pay for the AI SDK.
 */
import {
  type CreateEngine,
  type Engine,
  type EngineCommand,
  type EngineRoute,
} from '@agentistics/engine-api'
import { HARNESS_ORDER, type AgentisticsEvent, type HarnessId } from '@agentistics/core'
import { installHost } from './host'
import { installReaders, readersSource } from './reuse'
import { createIntegrations, hasReplay } from './integrations/types'
import pkg from '../package.json' with { type: 'json' }

export const ENGINE_NAME = 'agentistics-engine' as const
/** This engine's own release (`engine/package.json`), not the host's and not the contract's. */
export const ENGINE_VERSION: string = pkg.version

/**
 * The contract version this engine was WRITTEN against — a constant here, never the
 * `ENGINE_API_VERSION` of whatever engine-api it happens to be linked to: read from the linked copy,
 * the engine would always claim the host's own version and `apiCompatible` would judge nothing.
 * Bumped by hand, in the same change that starts using something a newer contract adds.
 */
export const BUILT_AGAINST_API = '1.2.0'

/** The providers the `provider` verb can store a key for and call. */
const PROVIDERS = ['anthropic', 'openai-compatible'] as const

export const createEngine: CreateEngine<AgentisticsEvent> = async host => {
  installHost(host)
  installReaders(host.readers)

  const providerRoute: EngineRoute = {
    prefix: '/api/provider',
    capability: 'localShell',
    async handle(req, url, ctx) {
      const { handleProviderRequest } = await import('./provider-web')
      try {
        const out = await handleProviderRequest(req, url.pathname, ctx?.clientIp ?? 'unknown', { dev: host.originPolicy().dev })
        return out === null ? null : Response.json(out.body, { status: out.status })
      } catch (err) {
        // A PUT body carries a key, so an unexpected failure is rendered NON-verbose regardless of
        // profile — the `/api/backup/github/setup` rule.
        const safe = host.safeError(err, { verbose: false })
        console.error(safe.logLine)
        return Response.json({
          code: safe.body.error,
          sentence: `an unexpected error occurred — see the server log (ref ${safe.body.ref}).`,
          ref: safe.body.ref,
        }, { status: 500 })
      }
    },
  }

  const providerCommand: EngineCommand = {
    verb: 'provider',
    summary: {
      en: "Manage a provider API key for the native runtime (BETA, off by default — set AGENTISTICS_PROVIDER=1). The key is entered at a hidden prompt or via --stdin, never on the command line ('provider key set|status|remove'; 'provider try anthropic' makes one real, billed call)",
      pt: "Gerencia a chave de API de um provedor para o runtime nativo (BETA, desligado por padrão — defina AGENTISTICS_PROVIDER=1). A chave entra por um prompt oculto ou por --stdin, nunca na linha de comando ('provider key set|status|remove'; 'provider try anthropic' faz uma chamada real, cobrada)",
    },
    async run(args) {
      const { runProvider } = await import('./cli-provider')
      return runProvider(args)
    },
  }

  const sessionsRoute: EngineRoute = {
    prefix: '/api/runtime/sessions',
    capability: 'localShell',
    async handle(req, url) {
      const { handleRuntimeSessionsRequest } = await import('./runtime-sessions-web')
      try {
        const out = await handleRuntimeSessionsRequest(req, url)
        if (out === null) return null
        if (out.kind === 'stream') {
          return new Response(out.stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
          })
        }
        return Response.json(out.body, { status: out.status })
      } catch (err) {
        // A message body is a person's prompt: an unexpected failure is rendered NON-verbose.
        const safe = host.safeError(err, { verbose: false })
        console.error(safe.logLine)
        return Response.json(safe.body, { status: 500 })
      }
    },
  }

  const codeCommand: EngineCommand = {
    verb: 'code',
    summary: {
      en: "BETA — the terminal front door onto a native session: runs a conversation against your stored Anthropic key, asking you here for anything not allowlisted ('code [--model <id>] [prompt]'; 'code --resume <id>'; 'code ls')",
      pt: "BETA — a porta de entrada no terminal para uma sessão nativa: conduz uma conversa com a sua chave Anthropic guardada, perguntando aqui por tudo que não está na lista permitida ('code [--model <id>] [prompt]'; 'code --resume <id>'; 'code ls')",
    },
    async run(args, io) {
      const { runCode } = await import('./cli-code')
      return runCode(args, { stdout: line => io.out(line), stderr: line => io.err(line) })
    },
  }

  const integrations = createIntegrations()
  const replay: HarnessId[] = HARNESS_ORDER.filter(h => hasReplay(integrations[h]))

  const engine: Engine<AgentisticsEvent> = {
    manifest: {
      name: ENGINE_NAME,
      version: ENGINE_VERSION,
      apiVersion: BUILT_AGAINST_API,
      provides: { nativeRuntime: true, replay, live: [], providers: [...PROVIDERS] },
    },
    integrations,
    routes: [providerRoute, sessionsRoute],
    commands: [providerCommand, codeCommand],
    async codeHost(askerFor) {
      const { createCodeHost } = await import('./cli-code')
      return createCodeHost(askerFor)
    },
    async dispose() {},
  }
  return engine
}

/** Where this engine's reused public functions came from — `host` once `createEngine` ran. */
export { readersSource }

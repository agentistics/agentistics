/**
 * engine/in-tree.ts — the engine code that still lives in the public tree, behind the contract.
 *
 * TRANSITIONAL. The migration moves the integrations and the provider verb into the engine
 * repository; until it does, this file packages what is here as one `createEngine`, so the host
 * already reaches it ONLY through `engine-slot.generated.ts` → `engine/load.ts` and never by
 * importing it. When the code moves this file is deleted, and `scripts/engine-slot.ts` falls back to
 * the null slot on its own.
 *
 * Everything heavy is imported inside `createEngine` or a handler: the slot is imported by
 * `bin/cli.ts` for every command, and `agentop --version` must not pay for seven integrations.
 */
import {
  ENGINE_API_VERSION,
  type CreateEngine,
  type Engine,
  type EngineCommand,
  type EngineRoute,
} from '@agentistics/engine-api'
import { HARNESS_ORDER, type AgentisticsEvent, type HarnessId } from '@agentistics/core'

/** The in-tree engine ships with the host, so it carries the host's own release. */
export const IN_TREE_ENGINE_NAME = 'agentistics-engine' as const

export const createEngine: CreateEngine<AgentisticsEvent> = async host => {
  const [{ INTEGRATIONS, hasReplay }, { CURRENT_VERSION }] = await Promise.all([
    import('../integrations/types'),
    import('../version'),
  ])

  const providerRoute: EngineRoute = {
    prefix: '/api/provider',
    capability: 'localShell',
    async handle(req, url, ctx) {
      const { handleProviderRequest } = await import('../provider-web')
      const { SERVE_STATIC } = await import('../sse')
      try {
        const out = await handleProviderRequest(req, url.pathname, ctx?.clientIp ?? 'unknown', { dev: !SERVE_STATIC })
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
      const { runProvider } = await import('../cli-provider')
      return runProvider(args)
    },
  }

  const replay: HarnessId[] = HARNESS_ORDER.filter(h => hasReplay(INTEGRATIONS[h]))
  const engine: Engine<AgentisticsEvent> = {
    manifest: {
      name: IN_TREE_ENGINE_NAME,
      version: CURRENT_VERSION,
      apiVersion: ENGINE_API_VERSION,
      provides: { nativeRuntime: false, replay, live: [], providers: ['anthropic', 'openai-compatible'] },
    },
    integrations: INTEGRATIONS,
    routes: [providerRoute],
    commands: [providerCommand],
    async dispose() {},
  }
  return engine
}

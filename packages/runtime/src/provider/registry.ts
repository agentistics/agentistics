/**
 * registry.ts — every provider, a decision, built from what the HOST injects (spec
 * docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §4.1).
 *
 * TOTAL over `ProviderId` (P1's `INTEGRATIONS` rule): a provider with no client is a declared `null`
 * with its reason beside it (`PROVIDER_CLIENT_ABSENT`), and removing `anthropic` fails the build.
 *
 * This used to be a module-level constant over a module-level `ANTHROPIC_CLIENT` whose resolver read
 * the key store and whose captures went to a host path. D23 moved both decisions to the host, so
 * the registry is a FUNCTION of them: there is no client without a resolver and a capture directory.
 */
import type { ProviderId } from '@agentistics/core'
import type { ProviderClient } from './client.ts'
import { createAnthropicClient, type AnthropicClientDeps } from './anthropic/client.ts'

export interface ProviderClientsDeps {
  anthropic: AnthropicClientDeps
}

export function createProviderClients(deps: ProviderClientsDeps): Record<ProviderId, ProviderClient | null> {
  return {
    anthropic: createAnthropicClient(deps.anthropic),
    // B5 — the OpenAI Responses / Chat Completions usage map is not verified yet (spec §5.2).
    openai: null,
    // B5 — Gemini `generateContent` usage map not verified yet (spec §5.2).
    google: null,
    // B5 — Moonshot/Kimi routing is not a direct provider call B1 makes.
    moonshot: null,
    // Not a vendor: the bucket for models no provider claims. Nothing to call.
    other: null,
  }
}

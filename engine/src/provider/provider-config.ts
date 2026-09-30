/**
 * provider-config.ts — the provider verb's own configuration, moved out of the public `config.ts`.
 *
 * Providers exist only for the native runtime (spec §1), so their closed tables (which endpoints a
 * key may be stored for, their kinds and default base URLs) belong to the engine. What is still the
 * MACHINE's — where the key store lives, whether the feature flag is on, whether this is a central —
 * comes from the host (`../host.ts`), never from this file or the environment.
 */
import { join } from 'node:path'
import { host, providerKeysDir } from '../host'

/** The native runtime's feature flag. ABSENT reads as OFF: with it off no provider module is
 *  loaded, no credential file is read, and every `agentop provider` verb but `status` refuses in a
 *  sentence. Kept in ONE exported constant so renaming the flag is one line. */
export const PROVIDER_FLAG_ENV = 'AGENTISTICS_PROVIDER'

/**
 * Is the native runtime's feature flag on? The HOST reads it (`EngineHostServices.flag`), so a test
 * or a host decides — this module never reads the environment. `env`, when given, is the pure form the
 * tests use: only `'1'` turns it on, the convention every other `AGENTISTICS_*` switch follows.
 */
export function providerFlagOn(env?: Record<string, string | undefined>): boolean {
  if (env) return env[PROVIDER_FLAG_ENV] === '1'
  return host().flag('provider')
}

/** Whether this machine is a central — the host's answer (`TEAM_CENTRAL` OR preferences), never
 *  re-derived here. A central never runs the runtime. */
export function isCentralHost(): boolean {
  return host().isCentral()
}

/**
 * The OpenAI-compatible ENDPOINTS a machine may configure (B5a, contract D1). CLOSED: each one is a
 * named instance of the Chat Completions protocol with its own stored base URL and (usually) key, and
 * the id doubles as the key FILE name — so a new endpoint is a line here, never a free-form string
 * that reaches a path.
 */
export type OpenAICompatibleEndpointId = 'openai' | 'openrouter' | 'deepseek' | 'litellm' | '9router' | 'ollama'
export const OPENAI_COMPATIBLE_ENDPOINTS: readonly OpenAICompatibleEndpointId[] =
  ['openai', 'openrouter', 'deepseek', 'litellm', '9router', 'ollama']

export function isOpenAICompatibleEndpoint(id: unknown): id is OpenAICompatibleEndpointId {
  return typeof id === 'string' && (OPENAI_COMPATIBLE_ENDPOINTS as readonly string[]).includes(id)
}

/** Who stands behind an endpoint's usage figures (contract D2) — never inferred from a URL. */
export type EndpointKind = 'direct' | 'router' | 'local'

export interface EndpointPreset {
  kind: EndpointKind
  /** The documented default base URL, or `null` when there is none and `--base-url` is REQUIRED. */
  defaultBaseUrl: string | null
  /** May the endpoint be stored with NO key (`--no-key`)? Only a local server that takes none. */
  keyOptional: boolean
  /** Human name for a sentence ("the key is still valid at …"). */
  label: string
}

/** Contract D2 (kinds) + D6 (defaults). `Record<OpenAICompatibleEndpointId, …>`, so a new endpoint
 *  fails the build until its row is written. */
export const ENDPOINT_PRESETS: Readonly<Record<OpenAICompatibleEndpointId, EndpointPreset>> = {
  openai: { kind: 'direct', defaultBaseUrl: 'https://api.openai.com/v1', keyOptional: false, label: 'OpenAI' },
  openrouter: { kind: 'router', defaultBaseUrl: 'https://openrouter.ai/api/v1', keyOptional: false, label: 'OpenRouter' },
  deepseek: { kind: 'direct', defaultBaseUrl: 'https://api.deepseek.com/v1', keyOptional: false, label: 'DeepSeek' },
  // No default: a LiteLLM proxy lives wherever its operator put it.
  litellm: { kind: 'router', defaultBaseUrl: null, keyOptional: false, label: 'the LiteLLM proxy' },
  '9router': { kind: 'router', defaultBaseUrl: 'http://localhost:20128/v1', keyOptional: false, label: '9router' },
  ollama: { kind: 'local', defaultBaseUrl: 'http://localhost:11434/v1', keyOptional: true, label: 'Ollama' },
}

/** The providers a key may be STORED for. Closed, and deliberately narrower than core's
 *  `ProviderId`: Anthropic (B1, owner decision D3) plus the six OpenAI-compatible endpoints (B5a).
 *  An endpoint is keyed by its ENDPOINT id, never by `'openai-compatible'` — one protocol, six files. */
export type KeyedProviderId = 'anthropic' | OpenAICompatibleEndpointId
export const KEYED_PROVIDERS: readonly KeyedProviderId[] = ['anthropic', ...OPENAI_COMPATIBLE_ENDPOINTS]

export function isKeyedProvider(id: unknown): id is KeyedProviderId {
  return typeof id === 'string' && (KEYED_PROVIDERS as readonly string[]).includes(id)
}

/** A provider id is interpolated into a path only after this check, the `safeConnId` rule — and
 *  since the set is closed, every name it lets through is a plain `[a-z0-9]+` word (no separator, no
 *  dot, no traversal), asserted once more below so a future entry cannot widen it by accident. */
export function providerKeyFile(provider: KeyedProviderId, dir: string = providerKeysDir()): string {
  if (!isKeyedProvider(provider) || !/^[a-z0-9]+$/.test(provider)) {
    throw new Error(`invalid provider id: ${JSON.stringify(provider)}`)
  }
  return join(dir, `${provider}.json`)
}


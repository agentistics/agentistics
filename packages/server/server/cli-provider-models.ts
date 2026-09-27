/**
 * cli-provider-models.ts — `agentop provider models <endpoint> [--json]` (B5a.3).
 *
 * Lists the models an OpenAI-compatible endpoint (D1: openai / openrouter / deepseek / litellm /
 * 9router / ollama) currently answers for, straight from the endpoint's own `GET <baseUrl>/models`
 * — never a hardcoded table anywhere in this file or in `@agentistics/runtime`'s
 * `provider/openai-compatible/models.ts`, which this module is written to sit in front of.
 *
 * This module is deliberately self-contained: it imports nothing from `config.ts`,
 * `credentials.ts` or `cli-provider.ts`, and it never touches a real network or a real
 * `~/.agentistics`. Every side effect — resolving the stored endpoint, and the actual model-listing
 * call — is INJECTED through `ProviderModelsCliDeps`; `cli-provider.ts`'s `modelsDepsOf` adapts it
 * to `readEndpointCredential` (whose opaque handle is passed on as-is) and to
 * `@agentistics/runtime`'s `createModelLister(...).list`. This mirrors `cli-provider.ts`'s own
 * `ProviderCliDeps` shape (injected stdout/stderr, `isCentral`, `flagOn`) so the two verbs read as
 * one family once wired together.
 *
 * The closed list of endpoint ids is injected (`knownEndpoints`, `config.ts`'s
 * `OPENAI_COMPATIBLE_ENDPOINTS`) and checked FIRST, so an argument outside it is refused without
 * being repeated back; "not configured yet" and the unreadable cases come from `resolveEndpoint`.
 *
 * Never prints the endpoint's stored key, and never holds it: `resolveEndpoint` answers an opaque
 * `CredentialHandle`, which is handed unrevealed to `listModels` (the runtime lister reveals it
 * inline in the request header — `provider-secrets.lint.test.ts` lists that file as a HOLDER), and
 * every printed line comes from `ProviderModelsListResult`, which never carries a key field at all.
 * A failure sentence prints the reason CODE and the HTTP status only — never the response body.
 */

import type { CredentialHandle } from '@agentistics/runtime'

// ---------------------------------------------------------------------------
// The minimal shapes this verb needs from the runtime's model lister — mirrors
// `packages/runtime/src/provider/openai-compatible/models.ts`'s `ListedModel` / `ModelListResult`
// field for field. Defined locally (rather than imported) because that runtime module is not yet
// exported through `@agentistics/runtime`'s barrel (`packages/runtime/src/index.ts`) at the time
// this file was written — the integrator wires the real function in, whose return value already
// satisfies this shape structurally.
// ---------------------------------------------------------------------------

export interface ProviderModelsListedModel {
  id: string
  ownedBy?: string
  contextLength?: number
  created?: number
}

export type ProviderModelsListResult =
  | { ok: true; models: ProviderModelsListedModel[]; fetchedAt: string; fromCache: boolean; dropped: number }
  | {
      ok: false
      reason: 'http-error' | 'network' | 'not-json' | 'bad-shape' | 'unauthorized'
      status?: number
    }

/** What `resolveEndpoint` hands back for a configured endpoint — never logged, never printed. */
export interface ResolvedProviderEndpoint {
  baseUrl: string
  /** The opaque handle over the stored key, `null` for a keyless endpoint (Ollama with
   *  `--no-key`). This module never reveals it: it is passed straight to `listModels`, and the
   *  runtime lister reveals it inline in the one request it sends. */
  credential: CredentialHandle | null
}

export type ResolveEndpointResult =
  | { ok: true; endpoint: ResolvedProviderEndpoint }
  | { ok: false; reason: 'unknown-endpoint' | 'not-stored' | 'unreadable' | 'permissions-too-open' }

// ---------------------------------------------------------------------------
// Dependencies — every side effect this module performs is injectable, exactly as
// `cli-provider.ts`'s `ProviderCliDeps` is: the test suite drives the whole surface (a central, the
// flag, an unconfigured endpoint, a network failure) without a real terminal, a real key file or a
// real HTTP call.
// ---------------------------------------------------------------------------

export interface ProviderModelsCliDeps {
  stdout: (line: string) => void
  stderr: (line: string) => void
  /** `TEAM_CENTRAL` (env) OR the effective `preferences.team.mode === 'central'` — the same rule
   *  `cli-provider.ts`'s `isCentral` follows. A central never runs the native runtime and never
   *  reaches out to an endpoint on its own account. */
  isCentral: () => Promise<boolean>
  /** `providerFlagOn()` — the native runtime's feature flag. Absent reads as OFF. */
  flagOn: () => boolean
  /** Resolves the endpoint's stored base URL and opaque key handle (or `null` for a keyless one) —
   *  `credentials.ts`'s `readEndpointCredential`, adapted in `cli-provider.ts`. */
  resolveEndpoint: (endpointId: string) => Promise<ResolveEndpointResult>
  /** The closed set of endpoint ids (`config.ts`'s `OPENAI_COMPATIBLE_ENDPOINTS`). An argument
   *  outside it is refused BEFORE anything else and is never repeated back: that position is
   *  exactly where a mistyped key lands (`agentop provider models sk-or-…`). */
  knownEndpoints: readonly string[]
  /** The model lister's `list` method (`@agentistics/runtime`'s `createModelLister(...).list`),
   *  injected so a test never touches a network or a real endpoint. */
  listModels: (args: {
    endpointId: string
    baseUrl: string
    credential: CredentialHandle | null
  }) => Promise<ProviderModelsListResult>
}

// ---------------------------------------------------------------------------
// Argument parsing — pure, so "never echo what the user typed on a bad flag" is checkable from the
// return value alone. Unlike a KEY, an endpoint id is not a secret (it is one of a small closed
// set of public names: openai, openrouter, deepseek, litellm, 9router, ollama) and IS echoed back
// in refusal sentences below — the "never echo" rule in `cli-provider.ts` is about a value that
// could be a mistyped API key, which an endpoint id never resembles.
// ---------------------------------------------------------------------------

export type ProviderModelsParse =
  | { kind: 'ok'; endpointId: string; json: boolean }
  | { kind: 'usage' }
  | { kind: 'unknown-flag'; flag: string }

export function parseProviderModelsArgs(rest: string[]): ProviderModelsParse {
  if (rest.length === 0 || rest[0]!.startsWith('-')) return { kind: 'usage' }
  const endpointId = rest[0]!
  let json = false
  for (const tok of rest.slice(1)) {
    if (tok === '--json') {
      json = true
      continue
    }
    if (tok.startsWith('--')) return { kind: 'unknown-flag', flag: tok }
    // A bare extra positional — usage, not a flag refusal.
    return { kind: 'usage' }
  }
  return { kind: 'ok', endpointId, json }
}

export const PROVIDER_MODELS_USAGE = 'usage: agentop provider models <endpoint> [--json]'

const CENTRAL_REFUSAL =
  'a central never runs the native runtime and cannot list an endpoint\'s models.'

const FLAG_OFF_REFUSAL =
  'AGENTISTICS_PROVIDER is off — set AGENTISTICS_PROVIDER=1 to use the native runtime.'

export function endpointRefusalSentence(
  endpointId: string,
  reason: Extract<ResolveEndpointResult, { ok: false }>['reason'],
): string {
  switch (reason) {
    case 'unknown-endpoint':
      // Never echoes the argument (see `knownEndpoints`).
      return 'not a known openai-compatible endpoint.'
    case 'not-stored':
      return `${endpointId}: no endpoint configured — run \`agentop provider key set ${endpointId}\` first.`
    case 'unreadable':
      return `${endpointId}: the stored endpoint record could not be read.`
    case 'permissions-too-open':
      return `${endpointId}: the stored endpoint file's permissions are too open — see \`agentop provider key status ${endpointId}\`.`
  }
}

export function modelsFailureSentence(
  endpointId: string,
  result: Extract<ProviderModelsListResult, { ok: false }>,
): string {
  switch (result.reason) {
    case 'unauthorized':
      return `${endpointId}: the stored key was rejected${result.status !== undefined ? ` (HTTP ${result.status})` : ''} — see \`agentop provider key status ${endpointId}\`.`
    case 'http-error':
      return `${endpointId}: the endpoint answered with an error${result.status !== undefined ? ` (HTTP ${result.status})` : ''}.`
    case 'network':
      return `${endpointId}: could not reach the endpoint (network error).`
    case 'not-json':
      return `${endpointId}: the endpoint's answer was not JSON.`
    case 'bad-shape':
      return `${endpointId}: the endpoint's answer did not carry a models list in a shape this reader understands.`
  }
}

/** One line per model: the id, plus the context length when the endpoint stated one. Never the
 *  key, never anything from `ownedBy`/`created` (kept in the type for `--json` consumers, but the
 *  plain listing is deliberately narrow — this is a picker aid, not a full dump). */
function modelLine(m: ProviderModelsListedModel): string {
  return m.contextLength === undefined ? m.id : `${m.id}  (context ${m.contextLength})`
}

function countLine(result: Extract<ProviderModelsListResult, { ok: true }>): string {
  const parts = [`${result.models.length} model${result.models.length === 1 ? '' : 's'}`]
  if (result.dropped > 0) parts.push(`${result.dropped} dropped`)
  if (result.fromCache) parts.push('cached')
  return parts.join(', ') + '.'
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runProviderModels(args: string[], deps: ProviderModelsCliDeps): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    deps.stdout(PROVIDER_MODELS_USAGE)
    return 0
  }

  const parsed = parseProviderModelsArgs(args)
  if (parsed.kind === 'usage') {
    deps.stderr(PROVIDER_MODELS_USAGE)
    return 2
  }
  if (parsed.kind === 'unknown-flag') {
    deps.stderr('unknown flag — see `agentop provider models --help`')
    return 2
  }

  const { endpointId, json } = parsed

  // The closed-set check comes FIRST and its refusal names what was EXPECTED, never what was GIVEN
  // (`cli-provider.ts`'s never-echo rule): every later sentence may name the id because it is known.
  if (!deps.knownEndpoints.includes(endpointId)) {
    deps.stderr(`unknown endpoint — supported: ${deps.knownEndpoints.join(', ')}`)
    return 2
  }

  // The flag and the central check run BEFORE anything is resolved or fetched — the same ordering
  // `cli-provider.ts`'s `runSet`/`runRemove`/`runTry` use, so a refusal never costs a stored-record
  // read or a real HTTP call it is about to reject anyway.
  if (!deps.flagOn()) {
    deps.stderr(FLAG_OFF_REFUSAL)
    return 1
  }
  if (await deps.isCentral()) {
    deps.stderr(CENTRAL_REFUSAL)
    return 1
  }

  const resolved = await deps.resolveEndpoint(endpointId)
  if (!resolved.ok) {
    deps.stderr(endpointRefusalSentence(endpointId, resolved.reason))
    return 1
  }

  const result = await deps.listModels({
    endpointId,
    baseUrl: resolved.endpoint.baseUrl,
    credential: resolved.endpoint.credential,
  })

  if (!result.ok) {
    deps.stderr(modelsFailureSentence(endpointId, result))
    return 1
  }

  if (json) {
    // The whole result, still never a key — `ProviderModelsListResult`'s `ok:true` branch has no
    // field that could carry one.
    deps.stdout(
      JSON.stringify({
        models: result.models,
        fetchedAt: result.fetchedAt,
        fromCache: result.fromCache,
        dropped: result.dropped,
      }),
    )
    return 0
  }

  for (const m of result.models) deps.stdout(modelLine(m))
  deps.stdout(countLine(result))
  return 0
}

/**
 * anthropic/client.ts — IO. The ONE `ProviderClient` implementation for Anthropic (B1.4a, spec
 * docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §4.1, §4.4, §4.5, §6.3.2 Guard 1).
 *
 * This module is a HOLDER of the provider key (`provider-secrets.lint.test.ts`): it is the only
 * file allowed to call `CredentialHandle.reveal()` and to name the SDK's key option. The revealed
 * string lives inside `invokeOnce`'s closure for exactly the span of one `createAnthropic({...})`
 * call — it is never assigned to a variable that outlives that call, never logged, never returned.
 *
 * `invokeOnce` drives ONE HTTP request through the AI SDK's `generateText` purely to get Anthropic's
 * request/response mechanics right (headers, no SDK-side retries, streaming off, tool declarations
 * without `execute`). Every FACT the caller receives — usage, content, messageId, servedModel,
 * stopReason, requestId — is read from the RAW captured exchange via `./raw.ts`, never from the
 * SDK's own parsed result: "nothing hidden by the SDK" (spec §4.1). The SDK's typed usage is read
 * only as a cross-check (`readSdkUsageCrossCheck`); a divergence is a counter, never a silent
 * correction.
 *
 * **Why the explicit `baseURL` and `apiKey` options matter, verified against the installed
 * `@ai-sdk/anthropic@4.0.58` (`dist/index.js`):**
 * - `createAnthropic`'s `baseURL` resolution is `normalizeBaseURL(loadOptionalSetting({settingValue:
 *   options.baseURL, environmentVariableName: 'ANTHROPIC_BASE_URL'}))`, and `loadOptionalSetting`
 *   (`@ai-sdk/provider-utils`) returns `settingValue` UNCHANGED whenever it is a string — it reads
 *   the environment variable only when the caller passed `undefined`. Passing our own
 *   `ANTHROPIC_BASE_URL_CONSTANT` explicitly is therefore what stops an ambient `ANTHROPIC_BASE_URL`
 *   from silently redirecting a request carrying our key (B1.2's measured finding).
 * - The API key header is built by `getHeaders()`'s `loadApiKey({apiKey: options.apiKey, …})`, which
 *   returns `options.apiKey` unchanged whenever it is a string and reads the ANTHROPIC_API_KEY
 *   environment variable only when the caller passed no `apiKey` at all. Passing `handle.reveal()`
 *   explicitly is what stops that same fallback.
 * - `createAnthropic`'s own default, with no `baseURL` option at all, is `normalizeBaseURL(undefined)
 *   → ANTHROPIC_API_VERSIONED_URL = "https://api.anthropic.com" + "/v1"` — confirming
 *   `ANTHROPIC_BASE_URL_CONSTANT` below is exactly the SDK's own default form.
 */
import { generateText, jsonSchema, stepCountIs } from 'ai'
import type { ModelMessage, TextPart, ToolCallPart, ToolResultPart, ToolSet } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import {
  ANTHROPIC_EDIT_POLICY,
  classifyProviderError,
  type ClassifierInput,
  type ProviderError,
} from '@agentistics/core'
import { createCapturingFetch, writeCapture as defaultWriteCapture } from '../capture.ts'
import { resolveCredential } from '../credentials.ts'
import { readAnthropicExchange, readSdkUsageCrossCheck } from './raw.ts'
import type {
  CaptureRef,
  CredentialHandle,
  CredentialRef,
  CredentialResolver,
  InvocationResult,
  ProviderClient,
  ProviderMessage,
  ProviderMessagePart,
  ProviderRequest,
  ProviderToolDecl,
  RawExchange,
} from '../client.ts'

/**
 * Anthropic's own versioned base URL — OURS, never read from `ANTHROPIC_BASE_URL` (see module doc).
 * Matches `@ai-sdk/anthropic@4.0.58`'s own default form exactly (`ANTHROPIC_API_URL + '/v1'`).
 */
export const ANTHROPIC_BASE_URL_CONSTANT = 'https://api.anthropic.com/v1'

/** Bumped on any mapping change (M §14 rule 1). */
const ADAPTER_VERSION = '1'

/**
 * Counters `invokeOnce` increments on a swallowed divergence (spec §11 — `agentop provider status`
 * reads these). `resetAnthropicCounters` exists for tests only; nothing in the running server ever
 * needs to zero them.
 */
export const anthropicCounters = { sdk_usage_divergence: 0, request_id_missing: 0 }

export function resetAnthropicCounters(): void {
  anthropicCounters.sdk_usage_divergence = 0
  anthropicCounters.request_id_missing = 0
}

/** Wraps `resolveCredential` (`../credentials.ts`) for provider `'anthropic'`; refuses any other
 *  provider's ref outright rather than asking the store about a key it could never have stored. */
const DEFAULT_RESOLVER: CredentialResolver = {
  async resolve(ref: CredentialRef) {
    if (ref.provider !== 'anthropic') return { ok: false, reason: 'wrong-provider' }
    return resolveCredential('anthropic')
  },
}

export interface AnthropicClientDeps {
  resolver?: CredentialResolver
  fetchImpl?: typeof fetch
  /** forwarded to `writeCapture`'s `opts.dir` — absent means capture.ts's own default (CONTENT_DIR). */
  captureDir?: string
  writeCapture?: typeof defaultWriteCapture
  now?: () => Date
  monotonicNow?: () => number
}

interface ResolvedDeps {
  resolver: CredentialResolver
  fetchImpl: typeof fetch
  captureDir: string | undefined
  writeCapture: typeof defaultWriteCapture
  now: () => Date
  monotonicNow: () => number
}

function resolveDeps(deps: AnthropicClientDeps): ResolvedDeps {
  return {
    resolver: deps.resolver ?? DEFAULT_RESOLVER,
    fetchImpl: deps.fetchImpl ?? fetch,
    captureDir: deps.captureDir,
    writeCapture: deps.writeCapture ?? defaultWriteCapture,
    now: deps.now ?? (() => new Date()),
    monotonicNow: deps.monotonicNow ?? (() => performance.now()),
  }
}

// ---------------------------------------------------------------------------
// ProviderMessage[] -> the AI SDK's ModelMessage[] — a WIRE-FORMAT translation only, never a content
// edit (spec §4.6: "B1 rewrites no history", "messages are sent verbatim"). Anthropic's own wire
// puts a tool result back as the NEXT `user` turn; the AI SDK's `ModelMessage` instead gives a tool
// result its own `role: 'tool'` message (verified in the installed `@ai-sdk/provider-utils`'s
// `ModelMessage = SystemModelMessage | UserModelMessage | AssistantModelMessage | ToolModelMessage`
// and `ToolContent = Array<ToolResultPart | ToolApprovalResponse>`). So a `ProviderMessage{role:
// 'user'}` carrying a `tool_result` part is split into a `tool` message (its results) and, if plain
// text remains alongside it, a separate `user` message for that text — order preserved.
// ---------------------------------------------------------------------------

type ToolResultLike = Extract<ProviderMessagePart, { type: 'tool_result' }>

/** `toolCallId -> toolName`, scanned from every `tool_use` part in the whole request. Anthropic's own
 *  `tool_result` blocks carry no name (only `tool_use_id`), but the AI SDK's `ToolResultPart`
 *  requires one — this is the one place that gap is bridged. A result naming an id nobody declared
 *  (never emitted by this product, but not impossible in a hand-built request) falls back to
 *  `'unknown'` rather than throwing: sending *something* keeps the call moving, and this fallback is
 *  never sent to Anthropic un-mapped. */
function toolNameById(messages: ProviderMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === 'tool_use') names.set(part.id, part.name)
    }
  }
  return names
}

function toolResultOutput(part: ToolResultLike): ToolResultPart['output'] {
  return part.isError ? { type: 'error-text', value: part.content } : { type: 'text', value: part.content }
}

function mapAssistantPart(
  part: ProviderMessagePart,
  names: Map<string, string>,
): TextPart | ToolCallPart | ToolResultPart {
  if (part.type === 'text') return { type: 'text', text: part.text }
  if (part.type === 'tool_use') {
    return { type: 'tool-call', toolCallId: part.id, toolName: part.name, input: part.input }
  }
  // A tool_result under the assistant role is not a shape B1 ever emits, but `AssistantContent`
  // allows it on the wire — carried rather than dropped.
  return {
    type: 'tool-result',
    toolCallId: part.toolUseId,
    toolName: names.get(part.toolUseId) ?? 'unknown',
    output: toolResultOutput(part),
  }
}

/** `ProviderMessage[]` -> `ModelMessage[]`. Pure, and the only place this shape translation happens. */
export function mapMessages(messages: ProviderMessage[]): ModelMessage[] {
  const names = toolNameById(messages)
  const out: ModelMessage[] = []

  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push(
        message.role === 'assistant'
          ? { role: 'assistant', content: message.content }
          : { role: 'user', content: message.content },
      )
      continue
    }

    if (message.role === 'assistant') {
      out.push({ role: 'assistant', content: message.content.map(p => mapAssistantPart(p, names)) })
      continue
    }

    const toolResults = message.content.filter((p): p is ToolResultLike => p.type === 'tool_result')
    const textParts = message.content.filter(
      (p): p is Extract<ProviderMessagePart, { type: 'text' }> => p.type === 'text',
    )

    if (toolResults.length > 0) {
      out.push({
        role: 'tool',
        content: toolResults.map(p => ({
          type: 'tool-result' as const,
          toolCallId: p.toolUseId,
          toolName: names.get(p.toolUseId) ?? 'unknown',
          output: toolResultOutput(p),
        })),
      })
    }
    if (textParts.length > 0) {
      out.push({ role: 'user', content: textParts.map(p => ({ type: 'text' as const, text: p.text })) })
    }
  }

  return out
}

/** `ProviderToolDecl[]` -> the AI SDK's `ToolSet`. Declarations only, no `execute` — B1 executes no
 *  tool (B3 does). `t.inputSchema` is a raw, user-declared JSON Schema object; `jsonSchema()` is the
 *  AI SDK's own wrapper for exactly that shape (verified in `@ai-sdk/provider-utils`'s
 *  `declare function jsonSchema<OBJECT>(jsonSchema: JSONSchema7 | …): Schema<OBJECT>`). */
export function mapTools(tools: ProviderToolDecl[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined
  const out: ToolSet = {}
  for (const t of tools) {
    // `ProviderToolDecl.inputSchema` is `Record<string, unknown>` (an arbitrary caller-supplied JSON
    // Schema object) while `jsonSchema()` is typed against the `json-schema` package's `JSONSchema7`
    // — the same shape, different declared type; cast rather than importing a third-party type this
    // module has no other reason to depend on.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out[t.name] = { description: t.description, inputSchema: jsonSchema(t.inputSchema as any) }
  }
  return out
}

// ---------------------------------------------------------------------------
// Failure classification (spec §4.3, §6.3.3: the classifier never sees a whole SDK error object).
// ---------------------------------------------------------------------------

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

async function tryWriteCapture(ex: RawExchange, deps: ResolvedDeps): Promise<CaptureRef | undefined> {
  try {
    return await deps.writeCapture(ex, { dir: deps.captureDir })
  } catch {
    // writeCapture itself never throws (capture.ts's own contract) — this is one more layer of
    // "a capture ref is never load-bearing for the call's own result" defense.
    return undefined
  }
}

/** No request was ever sent — `maxTokens` failed local validation before any HTTP attempt. */
function invalidMaxTokensError(): ProviderError {
  return {
    kind: 'invalid-request',
    retryable: false,
    usageOutcome: 'none-reported',
    userCode: 'provider.request_invalid',
  }
}

/**
 * No usable credential — mapped onto the closest kind the taxonomy has, `authentication` (spec
 * §4.3's "authentication" row: the call could never have authenticated without one). No request
 * ever left, so `usageOutcome` is `'none-reported'` per its own doc comment ("…or the request
 * provably never left"), not `'unknown'`.
 */
function credentialRefusalError(): ProviderError {
  return {
    kind: 'authentication',
    retryable: false,
    usageOutcome: 'none-reported',
    userCode: 'provider.no_credential',
  }
}

type GenerateTextResultLike = Awaited<ReturnType<typeof generateText>>

async function callGenerateText(
  req: ProviderRequest,
  handle: CredentialHandle,
  capturingFetch: typeof fetch,
): Promise<{ ok: true; result: GenerateTextResultLike } | { ok: false; err: unknown }> {
  try {
    // The revealed key lives in THIS function only, passed straight into `createAnthropic`'s
    // options object for this one call — never assigned to a variable that outlives it, never
    // logged (spec §6.3.2 Guard 1; module doc above).
    const anthropicProvider = createAnthropic({
      apiKey: handle.reveal(),
      baseURL: ANTHROPIC_BASE_URL_CONSTANT,
      fetch: capturingFetch,
    })
    const result = await generateText({
      model: anthropicProvider(req.model),
      system: req.system,
      messages: mapMessages(req.messages),
      tools: mapTools(req.tools),
      maxOutputTokens: req.maxTokens,
      // The SDK's own retry loop would make a failed attempt invisible (R13 §5) — the runtime's
      // `retry.ts` owns retries, one `invokeOnce` per HTTP attempt (spec §4.5, condition 4).
      maxRetries: 0,
      abortSignal: req.signal,
      // One `invokeOnce` = one HTTP request = one step. With no `execute` on any declared tool the
      // SDK has nothing to feed back into a second step regardless, so this is a stated bound, not
      // merely a hint (condition 3).
      stopWhen: stepCountIs(1),
    })
    return { ok: true, result }
  } catch (err) {
    return { ok: false, err }
  }
}

/**
 * The client's core (spec §4.1, §4.4, §4.5). Exported directly so tests (and `retry.ts`) can inject
 * `deps` without touching the module-level singleton `ANTHROPIC_CLIENT` below. Never throws.
 */
export async function invokeOnce(
  req: ProviderRequest,
  attempt: number,
  deps: AnthropicClientDeps = {},
): Promise<InvocationResult> {
  const d = resolveDeps(deps)
  const startedAt = d.now().toISOString()
  const startMono = d.monotonicNow()
  const elapsed = () => d.monotonicNow() - startMono

  const commonFields = {
    invocationId: req.correlation.invocationId,
    attempt,
    provider: 'anthropic' as const,
    requestedModel: req.model,
    startedAt,
  }

  const failed = (
    error: ProviderError,
    extra: { requestId?: string; capture?: CaptureRef } = {},
  ): InvocationResult => ({
    ...commonFields,
    latencyMs: elapsed(),
    status: 'failed',
    error,
    ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
    ...(extra.capture !== undefined ? { capture: extra.capture } : {}),
  })

  // Local validation — Anthropic requires `max_tokens` and a default is a guess (spec §4.1). No
  // request is built, let alone sent.
  if (!Number.isInteger(req.maxTokens) || req.maxTokens <= 0) {
    return failed(invalidMaxTokensError())
  }

  const resolution = await d.resolver.resolve(req.credential)
  if (!resolution.ok) {
    return failed(credentialRefusalError())
  }
  const handle: CredentialHandle = resolution.handle

  const capturing = createCapturingFetch(d.fetchImpl)
  const outcome = await callGenerateText(req, handle, capturing.fetch)

  if (!outcome.ok) {
    const exchanges = capturing.exchanges()
    if (exchanges.length > 0) {
      const ex = exchanges[0]!
      const capture = await tryWriteCapture(ex, d)
      const read = readAnthropicExchange(ex)
      if (!read.ok) {
        return failed(classifyProviderError(read.classifier), { requestId: read.requestId, capture })
      }
      // A 2xx, readable Message — yet the SDK still threw for a reason the wire cannot explain.
      // Neither the transport branch nor `readAnthropicExchange`'s own failure path applies, so this
      // is an honest `sdk-rejected` residue rather than a guessed HTTP-shaped kind.
      const classifier: ClassifierInput = { sdkRejected: true, requestSent: true }
      if (read.requestId !== undefined) classifier.requestIdHeader = read.requestId
      return failed(classifyProviderError(classifier), { requestId: read.requestId, capture })
    }

    const classifier: ClassifierInput = isAbort(outcome.err, req.signal)
      ? { transport: 'aborted' }
      : capturing.requestSent()
        ? { transport: 'network', requestSent: true }
        : { sdkRejected: true, requestSent: false }
    return failed(classifyProviderError(classifier))
  }

  const { result } = outcome
  const exchanges = capturing.exchanges()

  // One `invokeOnce` = one HTTP request = at most one billed response (spec §4.1). Either fact
  // failing is treated identically: a response this layer cannot trust as exactly one exchange.
  if (result.steps.length !== 1 || exchanges.length !== 1) {
    const ex = exchanges[0]
    const requestId = ex?.headers['request-id']
    const capture = ex !== undefined ? await tryWriteCapture(ex, d) : undefined
    const classifier: ClassifierInput = { responseUnreadable: true }
    if (requestId !== undefined) classifier.requestIdHeader = requestId
    return failed(classifyProviderError(classifier), { requestId, capture })
  }

  const ex = exchanges[0]!
  const read = readAnthropicExchange(ex)
  const capture = await tryWriteCapture(ex, d)

  if (!read.ok) {
    return failed(classifyProviderError(read.classifier), { requestId: read.requestId, capture })
  }

  const sdkUsage = result.steps[0]!.usage
  const cross = readSdkUsageCrossCheck(sdkUsage, read.usage)
  if (cross.divergent) anthropicCounters.sdk_usage_divergence += 1
  if (read.requestId === undefined) anthropicCounters.request_id_missing += 1

  return {
    ...commonFields,
    latencyMs: elapsed(),
    status: 'completed',
    messageId: read.messageId,
    servedModel: read.servedModel,
    usage: read.usage,
    usageAnomalies: read.usageAnomalies,
    stopReason: read.stopReason,
    content: read.content,
    ...(read.requestId !== undefined ? { requestId: read.requestId } : {}),
    ...(capture !== undefined ? { capture } : {}),
  }
}

/** Builds a fresh `ProviderClient` over `deps` — the default export uses no overrides at all. */
export function createAnthropicClient(deps: AnthropicClientDeps = {}): ProviderClient {
  return {
    provider: 'anthropic',
    adapterVersion: ADAPTER_VERSION,
    capabilities: { streaming: false, editPolicy: ANTHROPIC_EDIT_POLICY },
    invokeOnce: (req, attempt) => invokeOnce(req, attempt, deps),
  }
}

export const ANTHROPIC_CLIENT: ProviderClient = createAnthropicClient()

/**
 * anthropic/client.ts — IO. The ONE `ProviderClient` implementation for Anthropic (B1.4a, spec
 * docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §4.1, §4.4, §4.5, §6.3.2 Guard 1).
 *
 * This module is a HOLDER of the provider key (`provider-secrets.lint.test.ts`): it is the only
 * file allowed to call `CredentialHandle.reveal()` and to name the SDK's key option. It never FINDS
 * a key: the `CredentialResolver` is injected by the host (`AnthropicClientDeps.resolver`, D23 — the
 * runtime reads no host store), as is the capture directory (`captureDir`). The revealed
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
 * `streamOnce` (B2.1, `ProviderClient.stream`) is the same contract over `streamText`: one HTTP
 * request, the SDK as transport only, the capturing fetch TEEING the SSE body so deltas reach the
 * caller as they arrive, and every fact read from the raw events by the pure `./raw-stream.ts`.
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
import { generateText, jsonSchema, stepCountIs, streamText } from 'ai'
import type { ModelMessage, TextPart, ToolCallPart, ToolResultPart, ToolSet } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import {
  ANTHROPIC_EDIT_POLICY,
  classifyProviderError,
  type ClassifierInput,
  type ProviderError,
} from '@agentistics/core'
import {
  createCapturingFetch,
  createStreamingCapturingFetch,
  writeCapture as defaultWriteCapture,
  type ObservedStream,
} from '../capture.ts'
import { readAnthropicExchange, readSdkUsageCrossCheck } from './raw.ts'
import { readRateLimit } from '../rate-limit.ts'
import {
  createAnthropicStreamReader,
  createSseDecoder,
  type StreamBodyEnd,
} from './raw-stream.ts'
import { createToolCallAssembler as defaultCreateToolCallAssembler, type ToolCallAssembler } from '../tool-call-stream.ts'
import type {
  CaptureRef,
  CredentialHandle,
  CredentialResolver,
  InvocationResult,
  ProviderClient,
  ProviderMessage,
  ProviderMessagePart,
  ProviderRequest,
  ProviderStreamEvent,
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

export interface AnthropicClientDeps {
  /** REQUIRED — injected by the host (in agentop, over `server/provider/credentials.ts`). The runtime
   *  has no store of its own to fall back on, so there is no default. */
  resolver: CredentialResolver
  /** REQUIRED — forwarded to `writeCapture`'s `opts.dir`. The host decides where raw captures live
   *  (in agentop, `<AGENTISTICS_DIR>/content`); the runtime has no default path. */
  captureDir: string
  fetchImpl?: typeof fetch
  writeCapture?: typeof defaultWriteCapture
  now?: () => Date
  monotonicNow?: () => number
  /** the streamed path's tool-call assembler (`../tool-call-stream.ts`); injected by tests only */
  createToolCallAssembler?: (tools?: ProviderToolDecl[]) => ToolCallAssembler
}

interface ResolvedDeps {
  resolver: CredentialResolver
  fetchImpl: typeof fetch
  captureDir: string
  writeCapture: typeof defaultWriteCapture
  now: () => Date
  monotonicNow: () => number
  createToolCallAssembler: (tools?: ProviderToolDecl[]) => ToolCallAssembler
}

function resolveDeps(deps: AnthropicClientDeps): ResolvedDeps {
  return {
    resolver: deps.resolver,
    fetchImpl: deps.fetchImpl ?? fetch,
    captureDir: deps.captureDir,
    writeCapture: deps.writeCapture ?? defaultWriteCapture,
    now: deps.now ?? (() => new Date()),
    monotonicNow: deps.monotonicNow ?? (() => performance.now()),
    createToolCallAssembler: deps.createToolCallAssembler ?? defaultCreateToolCallAssembler,
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
    const start = out.length
    mapOne(message)
    // A breakpoint goes on the LAST message this one became (a tool result splits into two).
    if (message.cache && out.length > start) {
      const last = out[out.length - 1]!
      last.providerOptions = { ...last.providerOptions, anthropic: { cacheControl: message.cache } }
    }
  }
  return out

  function mapOne(message: ProviderMessage): void {
    if (typeof message.content === 'string') {
      out.push(
        message.role === 'assistant'
          ? { role: 'assistant', content: message.content }
          : { role: 'user', content: message.content },
      )
      return
    }

    if (message.role === 'assistant') {
      out.push({ role: 'assistant', content: message.content.map(p => mapAssistantPart(p, names)) })
      return
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

/** `system` as a plain string, or — when a cache breakpoint is asked for — as the one system message
 *  the AI SDK lets carry `providerOptions`. Without `system` there is nothing to mark. */
export function mapSystem(req: Pick<ProviderRequest, 'system' | 'systemCache'>) {
  if (req.system === undefined || !req.systemCache) return req.system
  return {
    role: 'system' as const,
    content: req.system,
    providerOptions: { anthropic: { cacheControl: req.systemCache } },
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
      system: mapSystem(req),
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
 * `deps` without building a client. Never throws.
 */
export async function invokeOnce(
  req: ProviderRequest,
  attempt: number,
  deps: AnthropicClientDeps,
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
    rateLimit: readRateLimit('anthropic', ex.headers, d.now()),
    ...(read.requestId !== undefined ? { requestId: read.requestId } : {}),
    ...(capture !== undefined ? { capture } : {}),
  }
}

// ---------------------------------------------------------------------------
// Streaming (B2.1). One `streamOnce` = one HTTP request = at most one billed response, exactly like
// `invokeOnce`; the retry stays outside. The AI SDK's `streamText` is the TRANSPORT only (headers,
// no SDK retries, tool declarations without `execute`); the capturing fetch TEES the SSE body, and
// the events the caller sees — and every fact on the terminal result — come from OUR branch of the
// raw bytes through the pure `./raw-stream.ts`, never from the SDK's parts or aggregate (§22.1.1
// conditions 1 and 3). The SDK's branch is drained in the background so the request completes
// normally; its per-step usage is read only as the same cross-check `invokeOnce` makes.
// ---------------------------------------------------------------------------

interface SdkStreamOutcome {
  /** the SDK's `finish-step` usage, for the cross-check only; absent when it never got that far */
  sdkUsage?: unknown
}

/**
 * Starts `streamText` over the teeing fetch and drains its `fullStream`, never throwing. The
 * revealed key lives in THIS function only, passed straight into `createAnthropic`'s options object
 * for this one call (spec §6.3.2 Guard 1; module doc above).
 *
 * `onError` is a no-op on purpose: the SDK's default writes the whole error object to
 * `console.error`, and a failure is classified from the raw exchange anyway. Supplying it without
 * `streamRetries` keeps the SDK's stream-retry machinery off (it arms only when BOTH are given), so a
 * mid-stream error can never make the SDK send a second request.
 */
function drainSdkStream(
  req: ProviderRequest,
  handle: CredentialHandle,
  streamingFetch: typeof fetch,
  signal: AbortSignal,
): Promise<SdkStreamOutcome> {
  return (async () => {
    const outcome: SdkStreamOutcome = {}
    try {
      const anthropicProvider = createAnthropic({
        apiKey: handle.reveal(),
        baseURL: ANTHROPIC_BASE_URL_CONSTANT,
        fetch: streamingFetch,
      })
      const result = streamText({
        model: anthropicProvider(req.model),
        system: mapSystem(req),
        messages: mapMessages(req.messages),
        tools: mapTools(req.tools),
        maxOutputTokens: req.maxTokens,
        maxRetries: 0,
        abortSignal: signal,
        stopWhen: stepCountIs(1),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === 'finish-step') outcome.sdkUsage = part.usage
      }
    } catch {
      // Classified from the raw exchange (or from the absence of one) by the caller.
    }
    return outcome
  })()
}

const NO_REQUEST: unique symbol = Symbol('no-request')

/**
 * The streamed attempt. See `ProviderClient.stream`'s contract: iterating never throws, the last
 * event is always `end`, exactly once, and `end.result` is what `invokeOnce` would have returned for
 * the same exchange — `failed` for an HTTP error, an in-band `error` on a 200, a body that ended
 * before `message_stop`, an abort, or anything unreadable; never a half-completed `completed`.
 *
 * Abort: `req.signal` aborting mid-body ends the attempt `failed` / `aborted`, unless the body had
 * already delivered `message_stop` — then the response was received whole and is `completed`. A
 * consumer that stops iterating early (breaks out of its `for await`) aborts the HTTP request too,
 * and receives no `end` (it has left).
 *
 * The raw capture is written when OUR branch of the body ends — cleanly or not — so a failed stream
 * is captured as far as it got, with the allowlisted headers.
 */
export async function* streamOnce(
  req: ProviderRequest,
  attempt: number,
  deps: AnthropicClientDeps,
): AsyncGenerator<ProviderStreamEvent, void, undefined> {
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

  let ended = false
  const end = (result: InvocationResult): ProviderStreamEvent => {
    ended = true
    return { type: 'end', result }
  }

  // Our own controller, so a consumer that walks away can cancel the request; the caller's signal
  // is forwarded into it.
  const internal = new AbortController()
  const forwardAbort = () => internal.abort()
  const aborted = () => req.signal?.aborted === true

  try {
    if (!Number.isInteger(req.maxTokens) || req.maxTokens <= 0) {
      yield end(failed(invalidMaxTokensError()))
      return
    }
    const resolution = await d.resolver.resolve(req.credential)
    if (!resolution.ok) {
      yield end(failed(credentialRefusalError()))
      return
    }

    req.signal?.addEventListener('abort', forwardAbort, { once: true })
    if (aborted()) internal.abort()

    const capturing = createStreamingCapturingFetch(d.fetchImpl)
    const sdk = drainSdkStream(req, resolution.handle, capturing.fetch, internal.signal)

    const first: ObservedStream | null | typeof NO_REQUEST = await Promise.race([
      capturing.observed,
      sdk.then((): typeof NO_REQUEST => NO_REQUEST),
    ])

    if (first === null || first === NO_REQUEST) {
      // No response head was ever observed: the call rejected before one (abort, network), or the
      // SDK failed before sending anything.
      await sdk
      const classifier: ClassifierInput = aborted()
        ? { transport: 'aborted' }
        : capturing.requestSent()
          ? { transport: 'network', requestSent: true }
          : { sdkRejected: true, requestSent: false }
      yield end(failed(classifyProviderError(classifier)))
      return
    }

    const requestId = first.headers['request-id']
    const isOk = first.status >= 200 && first.status < 300
    const decoder = new TextDecoder()
    const sse = createSseDecoder()
    const reader = createAnthropicStreamReader({
      ...(requestId !== undefined ? { requestId } : {}),
      assembler: d.createToolCallAssembler(req.tools),
    })
    let raw = ''
    let bodyEnd: StreamBodyEnd = 'complete'

    if (first.body !== null) {
      const bodyReader = first.body.getReader()
      try {
        for (;;) {
          const { done, value } = await bodyReader.read()
          if (done) break
          const text = decoder.decode(value, { stream: true })
          raw += text
          if (!isOk) continue
          for (const frame of sse.push(text)) {
            for (const ev of reader.accept(frame)) yield ev
          }
        }
        const tail = decoder.decode()
        raw += tail
        if (isOk) {
          for (const frame of [...sse.push(tail), ...sse.end()]) {
            for (const ev of reader.accept(frame)) yield ev
          }
        }
      } catch (err) {
        raw += decoder.decode()
        bodyEnd = isAbort(err, req.signal) || aborted() ? 'aborted' : 'errored'
      } finally {
        try { bodyReader.releaseLock() } catch { /* already released */ }
      }
    }

    const sdkOutcome = await sdk
    const ex: RawExchange = { status: first.status, headers: first.headers, body: raw }
    const capture = await tryWriteCapture(ex, d)
    const extra = { requestId, capture }

    if (capturing.requestCount() !== 1) {
      const classifier: ClassifierInput = { responseUnreadable: true }
      if (requestId !== undefined) classifier.requestIdHeader = requestId
      yield end(failed(classifyProviderError(classifier), extra))
      return
    }

    if (!isOk) {
      const read = readAnthropicExchange(ex)
      const classifier: ClassifierInput = read.ok ? { httpStatus: first.status, responseUnreadable: true } : read.classifier
      yield end(failed(classifyProviderError(classifier), { requestId: read.ok ? requestId : read.requestId, capture }))
      return
    }

    const verdict = reader.finish(bodyEnd)
    for (const ev of verdict.events) yield ev
    if (!verdict.ok) {
      yield end(failed(verdict.error, extra))
      return
    }

    if (sdkOutcome.sdkUsage !== undefined && readSdkUsageCrossCheck(sdkOutcome.sdkUsage, verdict.usage).divergent) {
      anthropicCounters.sdk_usage_divergence += 1
    }
    if (requestId === undefined) anthropicCounters.request_id_missing += 1

    yield end({
      ...commonFields,
      latencyMs: elapsed(),
      status: 'completed',
      messageId: verdict.messageId,
      servedModel: verdict.servedModel,
      usage: verdict.usage,
      usageAnomalies: verdict.usageAnomalies,
      stopReason: verdict.stopReason,
      content: verdict.content,
      toolCallFailures: verdict.toolCallFailures,
      rateLimit: readRateLimit('anthropic', ex.headers, d.now()),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(capture !== undefined ? { capture } : {}),
    })
  } catch {
    // Nothing above is meant to throw; if something did, the contract still holds: one `end`.
    if (!ended) yield end(failed(classifyProviderError({ sdkRejected: true })))
  } finally {
    req.signal?.removeEventListener('abort', forwardAbort)
    // A consumer that left before `end` must not leave the request running.
    if (!ended) internal.abort()
  }
}

/** Builds a `ProviderClient` over `deps` — the host binds its resolver and capture directory here. */
export function createAnthropicClient(deps: AnthropicClientDeps): ProviderClient {
  return {
    provider: 'anthropic',
    adapterVersion: ADAPTER_VERSION,
    capabilities: { streaming: true, editPolicy: ANTHROPIC_EDIT_POLICY },
    invokeOnce: (req, attempt) => invokeOnce(req, attempt, deps),
    stream: (req, attempt) => streamOnce(req, attempt, deps),
  }
}

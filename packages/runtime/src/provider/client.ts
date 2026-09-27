/**
 * client.ts — the `ProviderClient` contract and the registry of clients (spec
 * docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §4.1).
 *
 * One call of `invokeOnce` = one HTTP request = at most one billed response = one
 * `ModelInvocation`. The retry lives OUTSIDE the client (`retry.ts`, §4.5), so a client cannot hide
 * an attempt. `invokeOnce` never throws: every failure, an SDK rejection and an abort included, is
 * a `status: 'failed'` value, and a failed result has no `usage` property at all — a zeroed
 * invocation is a confident 0 for a call that may have been billed.
 *
 * This module is a NON-holder of the credential: it names the opaque `CredentialRef` and the
 * `CredentialHandle` TYPE only (declared in `./credential.ts`). The places a key is unwrapped are
 * `anthropic/client.ts` and `openai-compatible/client.ts` (`provider-secrets.lint.test.ts`, Guard 1).
 *
 * There is no module-level client registry: a client needs a `CredentialResolver` and a capture
 * directory, and both belong to the HOST (D23 — the runtime reads no host path and no host store).
 * `createProviderClients` builds the registry from what the host injects.
 */
import type {
  EditPolicy,
  ProviderError,
  ProviderId,
  ProviderUsage,
  StopReason,
  UsageAnomaly,
} from '@agentistics/core'
import type { CredentialRef } from './credential.ts'
import type { CostStatement, UsageCertainty } from './openai-compatible/usage.ts'

export type { CredentialHandle, CredentialRef, CredentialResolution, CredentialResolver } from './credential.ts'

export interface CallCorrelation {
  /** minted by the caller, `inv_` prefix — the grouping key of an invocation's attempts */
  invocationId: string
  sessionId?: string
  runId?: string
  agentId?: string
  taskId?: string
}

/** One content block of a message sent to the provider. Sent verbatim — B1 rewrites no history (§4.6). */
export type ProviderMessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

/** Marks a prompt prefix as cacheable. The cache breakpoint sits at the END of what it is set on;
 *  Anthropic caches everything up to and including that block. `ttl` absent = the provider's
 *  default (5 minutes). Never journaled — it shapes the request, and the resulting cache activity
 *  comes back on `usage` (cacheRead / cacheWrite / cacheWriteByTtl). */
// A type alias, not an interface: the AI SDK's `providerOptions` is a JSON-object type, and only an
// alias is assignable to its index signature.
export type ProviderCacheControl = {
  type: 'ephemeral'
  ttl?: '5m' | '1h'
}

export interface ProviderMessage {
  role: 'user' | 'assistant'
  content: string | ProviderMessagePart[]
  /** Optional: put a cache breakpoint after this message. */
  cache?: ProviderCacheControl
}

/** A tool DECLARATION only: B1 executes no tool (B3). */
export interface ProviderToolDecl {
  name: string
  description?: string
  /** JSON Schema of the tool input */
  inputSchema: Record<string, unknown>
}

export interface ProviderRequest {
  /** the REQUESTED id; the served one comes back on the result */
  model: string
  system?: string
  /** Optional: put a cache breakpoint after the system prompt. No effect without `system`. */
  systemCache?: ProviderCacheControl
  messages: ProviderMessage[]
  tools?: ProviderToolDecl[]
  /** required: Anthropic requires it and a default is a guess */
  maxTokens: number
  signal?: AbortSignal
  correlation: CallCorrelation
  credential: CredentialRef
}

/** What came back, for the caller. Never journaled. */
export type ProviderContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  /** any other block kind (thinking, server tool results, …) — carried by its raw type, never dropped */
  | { type: 'other'; rawType: string }

/** `{sha256, bytes}` of one attempt's raw capture in the content store (`capture.ts`). */
export interface CaptureRef {
  sha256: string
  bytes: number
}

/**
 * The one HTTP exchange of an attempt, as the capturing fetch saw it. `headers` has ALREADY passed
 * through the calling client's allowlist (`anthropic/raw.ts` `allowlistHeaders` by default,
 * `openai-compatible/raw.ts` `allowlistOpenAICompatibleHeaders` for that client) — request headers
 * are never here.
 */
export interface RawExchange {
  status: number
  headers: Record<string, string>
  body: string
}

export interface InvocationCommon {
  invocationId: string
  /** 1-based; one attempt = one HTTP request = one ModelInvocation */
  attempt: number
  provider: ProviderId
  requestedModel: string
  /** wall clock, ISO — the occurredAt of `model.invoked` */
  startedAt: string
  /** monotonic (performance.now) delta, never a wall-clock subtraction */
  latencyMs: number
  /** header `request-id` (on failure, the body's `request_id` when the header is absent); absent = not stated */
  requestId?: string
  /** absent when the capture could not be written (or there was no response to capture) */
  capture?: CaptureRef
}

export type InvocationResult =
  | (InvocationCommon & {
      status: 'completed'
      /** body `id`, msg_… — the ModelInvocation identity (§4.4) */
      messageId: string
      /** body `model`; may differ from requestedModel */
      servedModel: string
      /** read from the RAW body, never from the SDK aggregate */
      usage: ProviderUsage
      /** divergences met while reading the raw usage; empty on a clean read */
      usageAnomalies: UsageAnomaly[]
      stopReason: StopReason
      content: ProviderContent[]
      /** streamed tool calls that could not be assembled (B2); absent on a non-streamed call */
      toolCallFailures?: ToolCallFailure[]
      /** B5a — WHO made the statement the counters come from (`openai-compatible/usage.ts`). Absent
       *  on a client that does not grade it (Anthropic: always the billing vendor's own API). */
      usageCertainty?: UsageCertainty
      /** B5a — a cost the ENDPOINT itself stated (a router's own figure), or why there is none.
       *  Never a table price and never the fallback rate. Absent on a client that does not state it. */
      cost?: CostStatement
      /** B5a — runtime-local divergence codes met while reading the usage (e.g.
       *  `cached-exceeds-prompt`). Absent on a client that does not produce them. */
      usageNotes?: string[]
    })
  | (InvocationCommon & {
      status: 'failed'
      error: ProviderError
      messageId?: undefined
    })

// ── Streaming (B2) — an OPTIONAL capability ─────────────────────────────────────────────────────
//
// A client that cannot stream stays a valid `ProviderClient`: it declares `streaming: false` and has
// no `stream` method. A caller asking such a client to stream is REFUSED in words
// (`provider/stream.ts` `openProviderStream`), never left waiting on an iterator that never yields.
//
// One call of `stream` is still ONE attempt = one HTTP request = at most one billed response: the
// retry stays outside, exactly as for `invokeOnce`. The facts on the terminal result (usage,
// messageId, servedModel, stopReason, requestId) are read from the RAW captured SSE, never from the
// SDK's aggregate, and a mid-stream failure — an HTTP 200 whose body carries an in-band `error`
// event, or a body that ends before `message_stop` — ends in `status: 'failed'`, never in a
// half-completed `completed` (master §22).

/**
 * One chunk of a live answer, in the order the provider sent it. `index` is the provider's content
 * block index. Deltas are EPHEMERAL: they exist for readers watching live and are not the record —
 * the record is the terminal `end` event's `InvocationResult`.
 */
export type ProviderStreamEvent =
  /** the response began: the provider accepted the request (→ `model.started`) */
  | { type: 'started'; requestId?: string; messageId?: string; servedModel?: string }
  /** a piece of answer text */
  | { type: 'text-delta'; index: number; text: string }
  /** a piece of a tool call's arguments, as the provider sent it — partial JSON TEXT, not an object */
  | { type: 'tool-call-delta'; index: number; id: string; name: string; partialJson: string }
  /** a tool call whose arguments have been accumulated, parsed and validated. Never executed here (B3). */
  | { type: 'tool-call'; index: number; id: string; name: string; input: unknown }
  /**
   * a tool call whose arguments could NOT be assembled into a valid call. It is never offered as a
   * `tool-call`, so nothing can execute it. The attempt itself may still be `completed` — the
   * response was billed and its usage is real; the failure belongs to the call, not the invocation.
   */
  | { type: 'tool-call-failed'; failure: ToolCallFailure }
  /** a running output-token figure when the provider states one mid-stream. Never summed. */
  | { type: 'usage'; outputTokensSoFar: number }
  /** ALWAYS the last event, exactly once. `result` is what `invokeOnce` would have returned. */
  | { type: 'end'; result: InvocationResult }

/** Why one streamed tool call could not be assembled. A named failure, never a silent drop. */
export interface ToolCallFailure {
  index: number
  id: string
  name: string
  /**
   * `malformed`: the accumulated text is not JSON. `truncated`: the block never closed, or closed
   * with incomplete JSON because the response hit its token limit. `not-object`: valid JSON that is
   * not an object (a tool input is always an object). `unknown-tool`: a name no declared tool has.
   */
  reason: 'malformed' | 'truncated' | 'not-object' | 'unknown-tool'
  /** a sentence CODE rendered by i18n; never the raw arguments (they can hold conversation text) */
  userCode: string
}

/** A live attempt. Iterating never throws; the final event is always `end`. */
export type ProviderStream = AsyncIterable<ProviderStreamEvent>

export interface ProviderClient {
  readonly provider: ProviderId
  /** bumped on any mapping change (M §14 rule 1) */
  readonly adapterVersion: string
  /** `streaming: true` promises a `stream` method; `false` promises none */
  readonly capabilities: { streaming: boolean; editPolicy: EditPolicy }
  /** never throws */
  invokeOnce(req: ProviderRequest, attempt: number): Promise<InvocationResult>
  /** present only when `capabilities.streaming` is true. Never throws; always ends with `end`. */
  stream?(req: ProviderRequest, attempt: number): ProviderStream
}

/** Why a provider has no client — a sentence code, rendered by the caller. */
export const PROVIDER_CLIENT_ABSENT: Record<Exclude<ProviderId, 'anthropic'>, string> = {
  openai: 'provider.not_in_b1',
  google: 'provider.not_in_b1',
  moonshot: 'provider.not_in_b1',
  // B5a — the client exists, but only when the host configured an endpoint (`createProviderClients`
  // given `openaiCompatible`). Absent deps = nothing to call, said in words rather than a null.
  'openai-compatible': 'provider.not_configured',
  other: 'provider.not_a_vendor',
}

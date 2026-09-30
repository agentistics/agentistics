/**
 * openai-compatible/raw.ts — PURE. Turns the exact bytes of one Chat Completions HTTP exchange (the
 * capturing fetch's `{status, headers, body}`, `../capture.ts`) into either a completed invocation's
 * identity, usage and content, or the ALLOWLISTED facts `@agentistics/core`'s `classifyProviderError`
 * accepts. No fs, no fetch, no clock — every fact comes from the `RawExchange` it is given.
 *
 * Sources: docs/superpowers/research/12-provider-apis.md §2.1 (usage), §2.2 (request identity), §2.7
 * (rate-limit headers), §2.8 (errors), §2.9 (finish reasons), §4 (OpenRouter), §5 (Ollama), §7 (traps);
 * spec docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §4.1, §4.3, §4.4, §6.3.3, §7.
 *
 * A NON-holder of the key: it only ever sees the RESPONSE side of an exchange, and the response
 * headers have already passed through `allowlistOpenAICompatibleHeaders` below before anything here
 * reads them.
 *
 * Usage is NOT normalised here. `./usage.ts` (`readOpenAICompatibleUsage`, contract D4) owns the
 * per-endpoint arithmetic — prompt tokens include the cached sub-count on this wire (research 12
 * trap 2), reasoning is a sub-count of completion (trap 1) — and this module hands it the WHOLE body.
 */
import type { ClassifierInput, ProviderUsage, StopReason, UsageAnomaly } from '@agentistics/core'
import type { ProviderContent, RawExchange } from '../client.ts'
import {
  readOpenAICompatibleUsage,
  type CostStatement,
  type OpenAICompatibleEndpointKind,
  type UsageCertainty,
} from './usage.ts'

/**
 * The exact response-header names this client may ever keep, lower-case, each written down on
 * purpose with its reason. An ALLOWLIST, never a denylist (spec §6.3.3, §7): anything not named here
 * — `openai-organization` / `openai-project` (ACCOUNT identifiers, excluded on the same ground as
 * Anthropic's organization/workspace ids, O-10), `set-cookie`, every `cf-*` edge header, every other
 * router's own headers — is dropped by construction rather than enumerated to exclude.
 */
export const OPENAI_COMPATIBLE_HEADER_ALLOWLIST: readonly string[] = [
  // OpenAI's request id (research 12 §2.2: "Unique identifier for this API request (used in
  // troubleshooting)") — the support/correlation id, carried as `requestId` on every attempt.
  'x-request-id',
  // How long to wait before a retry on 429/503 (research 12 §2.7) — the retry plan honours it.
  'retry-after',
  // How the body is encoded — needed to re-read a capture correctly.
  'content-type',
  // Server clock at response time — the same reason Anthropic's capture keeps it: it anchors a
  // capture in time for a support ticket and lets clock skew be judged. Not an identifier.
  'date',
  // OpenAI's server-side processing time (research 12 §2.2 "other response meta headers") — lets a
  // latency figure be split between the provider and the network. A duration, not an identifier.
  'openai-processing-ms',
  // LiteLLM proxy's OWN statement of what the call cost, and its call id for support. NOT covered by
  // research 12 (which surveys no LiteLLM headers): named from LiteLLM's proxy documentation and
  // UNVERIFIED against a live proxy. Kept in the capture only — nothing reads them as a cost yet, so
  // a wrong name costs nothing but an absent header.
  'x-litellm-response-cost',
  'x-litellm-call-id',
  // OpenRouter documents NO response header for its generation id (research 12 §4.2) — the body `id`
  // (`gen-…`) IS that id and is read from the body, so no OpenRouter header is named here.
]

/** OpenAI's rate-limit headers (`x-ratelimit-limit-requests`, `-remaining-tokens`, `-reset-…`, and the
 *  project-scoped `…-project-tokens` variants — research 12 §2.7). Limits and counters, not identifiers;
 *  every one of them is kept. */
export const OPENAI_COMPATIBLE_HEADER_PREFIX = 'x-ratelimit-'

function isAllowlisted(name: string): boolean {
  return OPENAI_COMPATIBLE_HEADER_ALLOWLIST.includes(name) || name.startsWith(OPENAI_COMPATIBLE_HEADER_PREFIX)
}

/** Copies only the allowlisted headers, lower-casing names first (header names are case-insensitive
 *  on the wire). Accepts a `Headers`, a plain record (a fixture read back from JSON) or any iterable of
 *  pairs — the same inputs `anthropic/raw.ts`'s `allowlistHeaders` accepts. */
export function allowlistOpenAICompatibleHeaders(
  headers: Headers | Record<string, string> | Iterable<[string, string]>,
): Record<string, string> {
  const out: Record<string, string> = {}
  const isIterable = typeof (headers as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  const pairs: Iterable<[string, string]> = isIterable
    ? (headers as Iterable<[string, string]>)
    : Object.entries(headers as Record<string, string>)
  for (const [rawName, value] of pairs) {
    const name = rawName.toLowerCase()
    if (isAllowlisted(name)) out[name] = value
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// Stop reason. `@agentistics/core`'s `stop-reason.ts` maps ANTHROPIC only and says each provider's own
// mapping lives at that provider's boundary — this is that boundary for the Chat Completions wire.
// ---------------------------------------------------------------------------

/**
 * `choices[0].finish_reason` → the neutral vocabulary (research 12 §2.9, §5.5). Every value not
 * named here — `function_call`, Ollama's operational `load`/`unload`, a router's own word, `null` —
 * becomes `{ kind: 'other', raw }`: an unrecognised reason is NEVER read as a normal finish.
 *
 * - `stop` → `end-turn`. Chat Completions uses one word for "finished" and "hit a stop sequence";
 *   this client never sends stop sequences, so `stop` here can only be the former.
 * - `content_filter` → `refusal` with `category: 'content_filter'` — the output was withheld by the
 *   provider's policy layer; the raw word is kept as the category so it is never flattened.
 * - `function_call` stays `other`: it is the DEPRECATED single-function form, whose call lives on
 *   `message.function_call`, which this reader does not turn into a `tool_use` — calling it
 *   `tool-use` would promise a tool call the content does not carry.
 */
export function fromChatCompletionsFinishReason(raw: unknown): StopReason {
  if (typeof raw !== 'string') return { kind: 'other', raw: null }
  switch (raw) {
    case 'stop':
      return { kind: 'end-turn' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'tool_calls':
      return { kind: 'tool-use' }
    case 'content_filter':
      return { kind: 'refusal', category: 'content_filter' }
    default:
      return { kind: 'other', raw }
  }
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** `function.arguments` is a JSON STRING on this wire (research 12 trap 10) — parsed when it parses,
 *  carried VERBATIM when it does not (never replaced by `{}`), and taken as-is if a server already
 *  sent an object (Ollama's shape is unverified, research 12 §5.4). */
function toolInput(args: unknown): unknown {
  if (typeof args !== 'string') return args
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}

/** `choices[0].message` → `ProviderContent[]`. Text, tool calls, and every other thing the message
 *  carries (a refusal string, a reasoning trace) are kept — the last two by their raw field name. */
export function toChatContent(message: unknown): ProviderContent[] {
  if (!isPlainObject(message)) return []
  const out: ProviderContent[] = []

  const content = message.content
  if (typeof content === 'string') {
    if (content.length > 0) out.push({ type: 'text', text: content })
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (isPlainObject(part) && part.type === 'text' && typeof part.text === 'string') {
        out.push({ type: 'text', text: part.text })
      } else {
        const t = isPlainObject(part) ? part.type : undefined
        out.push({ type: 'other', rawType: typeof t === 'string' ? t : 'unknown' })
      }
    }
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = isPlainObject(call) && isPlainObject(call.function) ? call.function : undefined
      if (isPlainObject(call) && typeof call.id === 'string' && fn && typeof fn.name === 'string') {
        out.push({ type: 'tool_use', id: call.id, name: fn.name, input: toolInput(fn.arguments) })
      } else {
        out.push({ type: 'other', rawType: 'tool_call' })
      }
    }
  }

  // Carried by name, never dropped and never mistaken for the answer: OpenAI's `refusal` string,
  // DeepSeek's `reasoning_content`, OpenRouter's `reasoning`.
  for (const field of ['refusal', 'reasoning_content', 'reasoning'] as const) {
    const v = message[field]
    if (typeof v === 'string' && v.length > 0) out.push({ type: 'other', rawType: field })
  }
  return out
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

export interface OpenAICompatibleExchangeOk {
  ok: true
  /** body `id` — `chatcmpl-…` on OpenAI, the `gen-…` GENERATION id on OpenRouter (research 12 §4.2) */
  messageId: string
  /** body `model`; may differ from the requested one (a router names the upstream it chose) */
  servedModel: string
  /** header `x-request-id`; absent when not sent (OpenRouter, Ollama) — never synthesised */
  requestId?: string
  usage: ProviderUsage
  usageAnomalies: UsageAnomaly[]
  usageNotes: string[]
  usageCertainty: UsageCertainty
  cost: CostStatement
  stopReason: StopReason
  content: ProviderContent[]
}

export interface OpenAICompatibleExchangeFailed {
  ok: false
  classifier: ClassifierInput
  requestId?: string
}

export type OpenAICompatibleExchangeResult = OpenAICompatibleExchangeOk | OpenAICompatibleExchangeFailed

/**
 * Error `type`/`code` values this reader PASSES to the classifier. Only quota exhaustion, and only
 * so the classifier's own rule sends it to `http-other` (a 4xx: not retried): research 12 §2.8 says a
 * 429 covers "credit exhausted … spend or usage limits" and that retrying billing/quota errors "won't
 * restore API access". Every other vendor type is withheld, because the classifier's status table
 * speaks Anthropic's `error.type` words — OpenAI's own 401 says `invalid_request_error`, and passing it
 * would demote a key rejection to `http-other`. Withheld, the status alone classifies it.
 */
const PASSED_ERROR_TYPES: readonly string[] = ['insufficient_quota']

/**
 * The one place this wire meets our types. Never throws, on any input.
 *
 * - 2xx with an object body carrying string `id` and `model` and a readable `choices[0]` → completed.
 * - 2xx carrying an in-band `error` object, or `finish_reason: "error"` (OpenRouter's in-band failure,
 *   research 12 trap 5), or no readable `id`/`model`/`choices[0]` → `response-unreadable`: a status
 *   that succeeded is not a body this reader can trust.
 * - non-2xx → the status, `retry-after`, the request id, and (see `PASSED_ERROR_TYPES`) nothing else.
 *   The body's `error.message` is never read — it is provider text and may quote the request.
 */
export function readOpenAICompatibleExchange(
  ex: RawExchange,
  kind: OpenAICompatibleEndpointKind,
): OpenAICompatibleExchangeResult {
  const requestIdHeader = ex.headers['x-request-id']

  let parsed: unknown
  try {
    parsed = JSON.parse(ex.body)
  } catch {
    parsed = undefined
  }
  const body = isPlainObject(parsed) ? parsed : undefined

  if (ex.status >= 200 && ex.status < 300) {
    const choice = Array.isArray(body?.choices) && isPlainObject(body.choices[0]) ? body.choices[0] : undefined
    const inBandError = isPlainObject(body?.error) || choice?.finish_reason === 'error'
    const messageId = body?.id
    const servedModel = body?.model
    if (
      body !== undefined && !inBandError && choice !== undefined
      && typeof messageId === 'string' && messageId.length > 0 && typeof servedModel === 'string'
    ) {
      const read = readOpenAICompatibleUsage(body, kind)
      const result: OpenAICompatibleExchangeOk = {
        ok: true,
        messageId,
        servedModel,
        usage: read.usage,
        usageAnomalies: read.anomalies,
        usageNotes: read.notes,
        usageCertainty: read.certainty,
        cost: read.cost,
        stopReason: fromChatCompletionsFinishReason(choice.finish_reason),
        content: toChatContent(choice.message),
      }
      if (requestIdHeader !== undefined) result.requestId = requestIdHeader
      return result
    }
    const classifier: ClassifierInput = { httpStatus: ex.status, responseUnreadable: true }
    if (requestIdHeader !== undefined) classifier.requestIdHeader = requestIdHeader
    return requestIdHeader !== undefined ? { ok: false, classifier, requestId: requestIdHeader } : { ok: false, classifier }
  }

  const errorObj = isPlainObject(body?.error) ? body.error : undefined
  const quota = [errorObj?.type, errorObj?.code].find(
    (v): v is string => typeof v === 'string' && PASSED_ERROR_TYPES.includes(v),
  )
  const retryAfterHeader = ex.headers['retry-after']

  const classifier: ClassifierInput = { httpStatus: ex.status, requestSent: true }
  if (quota !== undefined) classifier.errorType = quota
  if (retryAfterHeader !== undefined) classifier.retryAfterHeader = retryAfterHeader
  if (requestIdHeader !== undefined) classifier.requestIdHeader = requestIdHeader
  return requestIdHeader !== undefined ? { ok: false, classifier, requestId: requestIdHeader } : { ok: false, classifier }
}

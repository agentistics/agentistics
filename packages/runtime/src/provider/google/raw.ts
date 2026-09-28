/**
 * google/raw.ts — PURE. Turns the exact bytes of one `generateContent` HTTP exchange (the capturing
 * fetch's `{status, headers, body}`, `../capture.ts`) into either a completed invocation's usage and
 * content, or the ALLOWLISTED facts `@agentistics/core`'s `classifyProviderError` accepts. No fs, no
 * fetch, no clock — every fact comes from the `RawExchange` it is given. A NON-holder of the key: it
 * only ever sees the RESPONSE side, and the response headers have already passed through
 * `allowlistGoogleHeaders` below.
 *
 * Sources (read 2026-09-28): https://ai.google.dev/api/generate-content — `GenerateContentResponse`
 * (`candidates`, `promptFeedback`, `usageMetadata`, `modelVersion`, `responseId`), `Candidate`,
 * `FinishReason`, `Part`, `FunctionCall` ("id: Optional. Unique identifier of the function call.").
 * Usage arithmetic lives in `./usage.ts` and nowhere else.
 *
 * ## Identity — Google states no request id, so none is invented
 *
 * Anthropic's `request-id` and OpenAI's `x-request-id` are documented RESPONSE HEADERS; the Gemini
 * reference documents no such header (research 12 §3.2, re-checked 2026-09-28 against the response
 * headers the reference lists: none). So a Google attempt carries NO `requestId` and NO `messageId`
 * (`''` — `emit.ts` keys such a completion on `(invocationId, attempt)`, exactly like a failure), and
 * the runtime marks the correlation `inferred` (`correlationBasis`, `../client.ts`): a cross-layer
 * join has only `(agentId, startedAt, model)`.
 *
 * `GenerateContentResponse.responseId` DOES exist ("Output only. responseId is used to identify each
 * response."). It is not adopted as `messageId` here: the brief for this item is "no providerRequestId",
 * the field's stability across the paths a gateway or transcript reader would take is unverified
 * without a live call, and keying `model.completed` on an id that turns out to be reused would
 * collapse distinct billed responses into one event. It stays in the raw capture (the body is kept
 * whole), which is where a later decision can read it from — recorded as an open item in the handback.
 *
 * ## What a "completed" response is
 *
 * A 2xx object body with no `error` and a readable `candidates[0]` — or, when the PROMPT was blocked,
 * a `promptFeedback.blockReason` and no candidate at all (still an accepted, possibly billed call:
 * `refusal` with the block reason as the category). An in-band `error` object on a 2xx, or a body with
 * neither, is `response-unreadable` — never a completed invocation read around a hole.
 */
import {
  classifyProviderError,
  type ClassifierInput,
  type ProviderError,
  type ProviderUsage,
  type StopReason,
  type UsageAnomaly,
} from '@agentistics/core'
import type { ProviderContent, RawExchange } from '../client.ts'
import type { CostStatement, UsageCertainty } from '../openai-compatible/usage.ts'
import { readGoogleUsage, type ToolUsePromptUsage } from './usage.ts'

/**
 * The exact response-header names this client may ever keep, lower-case, each with its reason. An
 * ALLOWLIST, never a denylist (spec §6.3.3): anything not named here is dropped by construction.
 * Google documents no request-id, rate-limit or server-timing response header, so none is named —
 * a header nobody documented is one this list cannot vouch for.
 */
export const GOOGLE_HEADER_ALLOWLIST: readonly string[] = [
  // How long to wait before a retry, when a 429/503 carries one (RFC 9110). Not a Gemini-documented
  // header — kept because `classifyProviderError` reads it and its absence costs nothing.
  'retry-after',
  // How the body is encoded — needed to re-read a capture correctly.
  'content-type',
  // Server clock at response time — anchors a capture in time. Not an identifier.
  'date',
]

/** Copies only the allowlisted headers, lower-casing names first. Accepts a `Headers`, a plain record
 *  (a fixture read back from JSON) or any iterable of pairs — the same inputs the other clients' take. */
export function allowlistGoogleHeaders(
  headers: Headers | Record<string, string> | Iterable<[string, string]>,
): Record<string, string> {
  const out: Record<string, string> = {}
  const isIterable = typeof (headers as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  const pairs: Iterable<[string, string]> = isIterable
    ? (headers as Iterable<[string, string]>)
    : Object.entries(headers as Record<string, string>)
  for (const [rawName, value] of pairs) {
    const name = rawName.toLowerCase()
    if (GOOGLE_HEADER_ALLOWLIST.includes(name)) out[name] = value
  }
  return out
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// Stop reason. `@agentistics/core`'s `stop-reason.ts` maps ANTHROPIC only and says each provider's own
// mapping lives at that provider's boundary — this is that boundary for Gemini's `finishReason`.
// ---------------------------------------------------------------------------

/** `FinishReason` values that are the provider's policy layer withholding output (research 12 §3.8:
 *  "a much larger, more granular safety-oriented enum"). The last two are in the reference's own enum
 *  (https://ai.google.dev/api/generate-content, `FinishReason`, read 2026-09-28) and describe generated
 *  images withheld for policy — the same class as `IMAGE_SAFETY`. */
const REFUSAL_FINISH_REASONS: readonly string[] = [
  'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION',
]

/**
 * `candidates[0].finishReason` → the neutral vocabulary. Never `end-turn` for a word not recognised.
 *
 * - `STOP` → `end-turn`, EXCEPT when the answer carries a function call: Gemini ends a tool-calling
 *   turn with `STOP` too, so the reason alone would call a request-to-run-a-tool "the model finished".
 *   `hasFunctionCall` is what turns it into `tool-use`.
 * - `MAX_TOKENS` → `max-tokens`.
 * - the six policy reasons → `refusal`, the raw word kept as the category so it is never flattened.
 * - everything else — `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, `OTHER`, `LANGUAGE`,
 *   `FINISH_REASON_UNSPECIFIED`, a word this reader has never met, an absent value — is
 *   `{ kind: 'other', raw }`.
 */
export function fromGoogleFinishReason(raw: unknown, hasFunctionCall = false): StopReason {
  if (typeof raw !== 'string') return { kind: 'other', raw: null }
  if (raw === 'STOP') return { kind: hasFunctionCall ? 'tool-use' : 'end-turn' }
  if (raw === 'MAX_TOKENS') return { kind: 'max-tokens' }
  if (REFUSAL_FINISH_REASONS.includes(raw)) return { kind: 'refusal', category: raw }
  return { kind: 'other', raw }
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** A tool call id Google did not state (`FunctionCall.id` is optional) — minted LOCALLY, never on the
 *  wire, so the runtime can pair the result back to the call. The pair on the wire is the NAME. */
export function localCallId(ordinal: number): string {
  return `google-call-${ordinal}`
}

/** The keys of a `Part` that name what kind of part it is, most specific first. */
const PART_KINDS: readonly string[] = [
  'functionCall', 'functionResponse', 'executableCode', 'codeExecutionResult', 'inlineData', 'fileData', 'text',
]

/**
 * `content.parts` → `ProviderContent[]`. Text is text; a `thought: true` text part is a thought
 * SUMMARY and is carried as `{type:'other', rawType:'thought'}`, never mistaken for the answer. A
 * `functionCall` becomes a `tool_use` whose `input` is the already-parsed `args` object (Google hands
 * over an object, not partial JSON — master §22); absent `args` is `{}` (a tool with no arguments).
 * Every other part is carried by its raw kind, never dropped.
 */
export function toGoogleContent(parts: unknown): ProviderContent[] {
  if (!Array.isArray(parts)) return []
  const out: ProviderContent[] = []
  let calls = 0
  for (const part of parts) {
    if (!isPlainObject(part)) {
      out.push({ type: 'other', rawType: 'unknown' })
      continue
    }
    const call = part.functionCall
    if (isPlainObject(call) && typeof call.name === 'string') {
      const ordinal = calls++
      const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : localCallId(ordinal)
      out.push({ type: 'tool_use', id, name: call.name, input: call.args === undefined ? {} : call.args })
    } else if (typeof part.text === 'string') {
      if (part.thought === true) out.push({ type: 'other', rawType: 'thought' })
      else if (part.text.length > 0) out.push({ type: 'text', text: part.text })
    } else {
      out.push({ type: 'other', rawType: PART_KINDS.find(k => k in part) ?? 'unknown' })
    }
  }
  return out
}

/** True when `content` carries a tool call (drives `STOP` → `tool-use`). */
export function hasToolUse(content: readonly ProviderContent[]): boolean {
  return content.some(c => c.type === 'tool_use')
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

export interface GoogleExchangeOk {
  ok: true
  /** always `''`: Google states no request id and this client adopts no response id (module doc) */
  messageId: ''
  servedModel: string
  usage: ProviderUsage
  usageAnomalies: UsageAnomaly[]
  usageNotes: string[]
  usageCertainty: UsageCertainty
  cost: CostStatement
  toolUsePrompt?: ToolUsePromptUsage
  stopReason: StopReason
  content: ProviderContent[]
}

export interface GoogleExchangeFailed {
  ok: false
  classifier: ClassifierInput
}

export type GoogleExchangeResult = GoogleExchangeOk | GoogleExchangeFailed

/**
 * An in-band `error` on a 2xx (or a streamed chunk) → `ProviderError`. Google's error object is
 * `{code, message, status}` with `code` the HTTP status number, so the kind comes from the ONE status
 * table (`classifyProviderError`) rather than a second copy of it. Stated as what the wire carried —
 * `httpStatus: 200` — and always `usageOutcome: 'unknown'`: the response had been accepted and may
 * have generated (and billed) output before it broke, which `decideRetry` therefore never retries.
 * `error.message` is never read — it is provider text and may quote the request.
 */
export function classifyGoogleInBandError(error: unknown): ProviderError {
  const code = isPlainObject(error) ? error.code : undefined
  if (typeof code === 'number' && Number.isInteger(code) && code >= 400 && code < 600) {
    return { ...classifyProviderError({ httpStatus: code }), httpStatus: 200, usageOutcome: 'unknown' }
  }
  return { ...classifyProviderError({ httpStatus: 200 }), usageOutcome: 'unknown' }
}

/**
 * The one place a non-streamed Gemini response meets our types. Never throws, on any input.
 * `requestedModel` is the fallback for `servedModel` when the body states no `modelVersion`, and the
 * fallback is SAID (`served-model-unstated` in `usageNotes`).
 */
export function readGoogleExchange(ex: RawExchange, requestedModel: string): GoogleExchangeResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(ex.body)
  } catch {
    parsed = undefined
  }
  const body = isPlainObject(parsed) ? parsed : undefined

  if (ex.status >= 200 && ex.status < 300) {
    const candidate = Array.isArray(body?.candidates) && isPlainObject(body.candidates[0]) ? body.candidates[0] : undefined
    const feedback = isPlainObject(body?.promptFeedback) ? body.promptFeedback : undefined
    const blockReason = typeof feedback?.blockReason === 'string' ? feedback.blockReason : undefined

    if (body !== undefined && !isPlainObject(body.error) && (candidate !== undefined || blockReason !== undefined)) {
      const read = readGoogleUsage(body.usageMetadata)
      const content = candidate !== undefined && isPlainObject(candidate.content) ? toGoogleContent(candidate.content.parts) : []
      const stopReason: StopReason = candidate !== undefined
        ? fromGoogleFinishReason(candidate.finishReason, hasToolUse(content))
        : { kind: 'refusal', category: blockReason }
      const served = typeof body.modelVersion === 'string' && body.modelVersion.length > 0 ? body.modelVersion : undefined
      const notes = served === undefined ? [...read.notes, 'served-model-unstated'] : read.notes
      const result: GoogleExchangeOk = {
        ok: true,
        messageId: '',
        servedModel: served ?? requestedModel,
        usage: read.usage,
        usageAnomalies: read.anomalies,
        usageNotes: notes,
        usageCertainty: read.certainty,
        cost: read.cost,
        stopReason,
        content,
      }
      if (read.toolUsePrompt) result.toolUsePrompt = read.toolUsePrompt
      return result
    }
    return { ok: false, classifier: { httpStatus: ex.status, responseUnreadable: true } }
  }

  // Non-2xx: the status and `retry-after` only. The body's `error.message` is never read, and
  // Google's `error.status` words (`RESOURCE_EXHAUSTED`, …) are not the classifier's `error.type`
  // vocabulary, so they are withheld — the status alone classifies (same reading as the openai reader).
  const classifier: ClassifierInput = { httpStatus: ex.status, requestSent: true }
  const retryAfterHeader = ex.headers['retry-after']
  if (retryAfterHeader !== undefined) classifier.retryAfterHeader = retryAfterHeader
  return { ok: false, classifier }
}

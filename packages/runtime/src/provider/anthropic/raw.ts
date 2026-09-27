/**
 * anthropic/raw.ts — PURE. Turns the exact bytes of one Anthropic HTTP exchange (the capturing
 * fetch's `{status, headers, body}`, `capture.ts`) into either a completed invocation's identity,
 * usage and content, or the ALLOWLISTED facts a caller hands to `@agentistics/core`'s
 * `classifyProviderError` to get a `ProviderError`. No fs, no fetch, no `Date.now()` — every fact
 * comes from the `RawExchange` it is given.
 *
 * spec: docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §4.1, §4.3, §4.4, §5.1, §6.3.3, §7.
 *
 * This module is a NON-holder of the provider key (§6.3.2): it never receives the key in the first
 * place, only the response side of an exchange the credential travelled on request headers of —
 * and `RawExchange.headers` (see `../client.ts`) has already passed through `allowlistHeaders`
 * below by the time anything here reads it.
 */
import {
  fromAnthropicStopReason,
  fromAnthropicUsage,
  type ClassifierInput,
  type ProviderUsage,
  type StopReason,
  type UsageAnomaly,
} from '@agentistics/core'
import type { ProviderContent, RawExchange } from '../client.ts'

/**
 * The exact response-header names this layer may ever keep, lower-case. An ALLOWLIST, never a
 * denylist (spec §6.3.3, §7): the fields named here are the ones a caller (a retry decision, a
 * support ticket) needs, and everything else — including the account identifiers
 * `anthropic-organization-id` / `anthropic-workspace-id` (pending owner call O-10) and any
 * cookie-shaped header — is dropped by construction rather than enumerated to exclude.
 */
export const CAPTURED_HEADER_ALLOWLIST: readonly string[] = [
  'request-id',
  'retry-after',
  'content-type',
  'date',
]

/** Rate-limit headers vary by resource (`anthropic-ratelimit-requests-limit`, `-tokens-remaining`, …); every one of them is kept. */
export const CAPTURED_HEADER_PREFIX = 'anthropic-ratelimit-'

function isAllowlistedHeaderName(name: string): boolean {
  return CAPTURED_HEADER_ALLOWLIST.includes(name) || name.startsWith(CAPTURED_HEADER_PREFIX)
}

/**
 * Copies only the allowlisted headers out of whatever shape a caller happens to be holding them in
 * — a `Headers` instance (both the capturing fetch's live response and `Headers` are iterable of
 * `[name, value]` pairs), a plain record (a recorded fixture read back from JSON), or any other
 * iterable of pairs. Header names are lower-cased first: HTTP header names are case-insensitive on
 * the wire and the allowlist above is spelled in lower case, so comparing anything else would miss
 * a differently-cased header from a real response.
 */
export function allowlistHeaders(
  headers: Headers | Record<string, string> | Iterable<[string, string]>,
): Record<string, string> {
  const out: Record<string, string> = {}
  const isIterable = typeof (headers as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  const pairs: Iterable<[string, string]> = isIterable
    ? (headers as Iterable<[string, string]>)
    : Object.entries(headers as Record<string, string>)

  for (const [rawName, value] of pairs) {
    const name = rawName.toLowerCase()
    if (isAllowlistedHeaderName(name)) out[name] = value
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** `body.content[]` → `ProviderContent[]`. Anything that is not `text`/`tool_use` is carried by its own raw type — never dropped (spec §4.1). */
function toProviderContent(raw: unknown): ProviderContent[] {
  if (!Array.isArray(raw)) return []
  const out: ProviderContent[] = []
  for (const block of raw) {
    if (!isPlainObject(block)) continue
    const type = block.type
    if (type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text })
      continue
    }
    if (type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
      continue
    }
    out.push({ type: 'other', rawType: typeof type === 'string' ? type : 'unknown' })
  }
  return out
}

/** One completed exchange: identity, usage and content read straight off the response body. */
export interface AnthropicExchangeOk {
  ok: true
  /** body `id`, `msg_…` — the `ModelInvocation` identity (spec §4.4) */
  messageId: string
  /** body `model`; may differ from the requested model on a server-side fallback */
  servedModel: string
  /** header `request-id`; absent when the response did not carry one — never synthesised */
  requestId?: string
  usage: ProviderUsage
  usageAnomalies: UsageAnomaly[]
  stopReason: StopReason
  content: ProviderContent[]
}

/** A failed exchange, reduced to the allowlist `classifyProviderError` accepts (spec §6.3.3: the classifier never sees an error object whole). */
export interface AnthropicExchangeFailed {
  ok: false
  classifier: ClassifierInput
  requestId?: string
  requestIdSource?: 'header' | 'body'
}

export type AnthropicExchangeResult = AnthropicExchangeOk | AnthropicExchangeFailed

/**
 * The one place Anthropic's wire shape meets our types. Never throws on any input, including a
 * body that is not JSON at all, or JSON that is not an object.
 *
 * - A 2xx whose body parses as an object carrying string `id` and `model` fields is read as a
 *   completed `Message`: usage goes through `fromAnthropicUsage` (never invented — every counter
 *   this reader could not find is `fromAnthropicUsage`'s own `missing` list, not a value made up
 *   here), the stop reason through `fromAnthropicStopReason`, and every content block is carried.
 * - A 2xx that cannot be read as a `Message` (unparseable body, or no `id`) is `response-unreadable`
 *   — a status that succeeded is not the same fact as a body this reader can trust (spec §4.4: "a
 *   2xx body with no `id` is `response-unreadable`, not a completed invocation with a made-up
 *   identity").
 * - Any non-2xx status is reduced to `ClassifierInput`'s allowlisted fields only: the status, the
 *   body's `error.type`, `error.details.error_code`, the `retry-after` header, and both possible
 *   request-id sources — never the body's `error.message`, which this function does not read.
 */
export function readAnthropicExchange(ex: RawExchange): AnthropicExchangeResult {
  const requestIdHeader = ex.headers['request-id']

  let parsed: unknown
  try {
    parsed = JSON.parse(ex.body)
  } catch {
    parsed = undefined
  }
  const body = isPlainObject(parsed) ? parsed : undefined

  if (ex.status >= 200 && ex.status < 300) {
    const messageId = body?.id
    const servedModel = body?.model
    if (body !== undefined && typeof messageId === 'string' && typeof servedModel === 'string') {
      const { usage, anomalies } = fromAnthropicUsage(body.usage)
      const stopReason = fromAnthropicStopReason(body.stop_reason, body.stop_details)
      const content = toProviderContent(body.content)
      const result: AnthropicExchangeOk = {
        ok: true,
        messageId,
        servedModel,
        usage,
        usageAnomalies: anomalies,
        stopReason,
        content,
      }
      if (requestIdHeader !== undefined) result.requestId = requestIdHeader
      return result
    }

    const classifier: ClassifierInput = { httpStatus: ex.status, responseUnreadable: true }
    if (requestIdHeader !== undefined) classifier.requestIdHeader = requestIdHeader
    const failed: AnthropicExchangeFailed = { ok: false, classifier }
    if (requestIdHeader !== undefined) {
      failed.requestId = requestIdHeader
      failed.requestIdSource = 'header'
    }
    return failed
  }

  const errorObj = isPlainObject(body?.error) ? body.error : undefined
  const errorType = typeof errorObj?.type === 'string' ? errorObj.type : undefined
  const errorDetails = isPlainObject(errorObj?.details) ? errorObj.details : undefined
  const errorCode = typeof errorDetails?.error_code === 'string' ? errorDetails.error_code : undefined
  const retryAfterHeader = ex.headers['retry-after']
  const requestIdBody = typeof body?.request_id === 'string' ? body.request_id : undefined

  const classifier: ClassifierInput = { httpStatus: ex.status, requestSent: true }
  if (errorType !== undefined) classifier.errorType = errorType
  if (errorCode !== undefined) classifier.errorCode = errorCode
  if (retryAfterHeader !== undefined) classifier.retryAfterHeader = retryAfterHeader
  if (requestIdHeader !== undefined) classifier.requestIdHeader = requestIdHeader
  if (requestIdBody !== undefined) classifier.requestIdBody = requestIdBody

  const failed: AnthropicExchangeFailed = { ok: false, classifier }
  if (requestIdHeader !== undefined) {
    failed.requestId = requestIdHeader
    failed.requestIdSource = 'header'
  } else if (requestIdBody !== undefined) {
    failed.requestId = requestIdBody
    failed.requestIdSource = 'body'
  }
  return failed
}

/**
 * How the SDK's own typed usage relates to the raw counters `readAnthropicExchange` already
 * derived — a CROSS-CHECK only (spec §4.1: "the SDK's typed usage is read only as a cross-check, a
 * divergence is a counter"), never a second source: the raw body always wins, and this function
 * cannot override anything because it has no way to write `usage` back.
 *
 * Two typed shapes exist for "the SDK's usage" and this function accepts either, because which one
 * a caller ends up holding depends on where in the call it reads from:
 *
 * - the PROVIDER-level shape `@ai-sdk/anthropic`'s own `convertAnthropicUsage` produces (measured
 *   in the installed `@ai-sdk/anthropic@4.0.58` at `dist/index.js:2153-2200`, matching this spec's
 *   citations of `LanguageModelV4Usage.inputTokens.{noCache,cacheRead,cacheWrite}` and
 *   `.outputTokens.total`): `{ inputTokens: {total, noCache, cacheRead, cacheWrite}, outputTokens:
 *   {total, text, reasoning} }`;
 * - the flat shape the `ai` package's own `generateText` result exposes as `result.usage`
 *   (measured in the installed `ai@7.0.107` at `dist/index.d.ts:320-367`, type `LanguageModelUsage`):
 *   `{ inputTokens: number, inputTokenDetails: {noCacheTokens, cacheReadTokens, cacheWriteTokens},
 *   outputTokens: number, outputTokenDetails: {textTokens, reasoningTokens}, totalTokens, raw? }`.
 *
 * Only the four flat counters are compared (`input`, `output`, `cacheRead`, `cacheWrite`); a field
 * the SDK shape does not state is simply not checked, never treated as a divergence.
 */
export function readSdkUsageCrossCheck(
  sdkUsage: unknown,
  raw: ProviderUsage,
): { divergent: boolean; fields: string[] } {
  const counters = extractSdkCounters(sdkUsage)
  if (counters === undefined) return { divergent: false, fields: [] }

  const fields: string[] = []
  if (counters.input !== undefined && counters.input !== raw.input) fields.push('input')
  if (counters.output !== undefined && counters.output !== raw.output) fields.push('output')
  if (counters.cacheRead !== undefined && counters.cacheRead !== raw.cacheRead) fields.push('cacheRead')
  if (counters.cacheWrite !== undefined && counters.cacheWrite !== raw.cacheWrite) fields.push('cacheWrite')
  return { divergent: fields.length > 0, fields }
}

interface SdkCounters {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function extractSdkCounters(sdkUsage: unknown): SdkCounters | undefined {
  if (!isPlainObject(sdkUsage)) return undefined

  const nestedInput = isPlainObject(sdkUsage.inputTokens) ? sdkUsage.inputTokens : undefined
  const nestedOutput = isPlainObject(sdkUsage.outputTokens) ? sdkUsage.outputTokens : undefined
  if (nestedInput !== undefined || nestedOutput !== undefined) {
    return {
      input: numberOrUndefined(nestedInput?.noCache),
      cacheRead: numberOrUndefined(nestedInput?.cacheRead),
      cacheWrite: numberOrUndefined(nestedInput?.cacheWrite),
      output: numberOrUndefined(nestedOutput?.total),
    }
  }

  if (typeof sdkUsage.inputTokens === 'number' || typeof sdkUsage.outputTokens === 'number') {
    const details = isPlainObject(sdkUsage.inputTokenDetails) ? sdkUsage.inputTokenDetails : undefined
    return {
      input: numberOrUndefined(details?.noCacheTokens),
      cacheRead: numberOrUndefined(details?.cacheReadTokens),
      cacheWrite: numberOrUndefined(details?.cacheWriteTokens),
      output: numberOrUndefined(sdkUsage.outputTokens),
    }
  }

  return undefined
}

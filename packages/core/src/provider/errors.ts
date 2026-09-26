/**
 * The provider error taxonomy — B1 spec §4.3 (docs/superpowers/specs/2026-09-25-runtime-b1-provider.md).
 *
 * PURE. A closed union of failure kinds and a TOTAL classifier over an ALLOWLIST of facts
 * (`ClassifierInput`). The classifier never sees an SDK error object whole: those carry response
 * headers and the request body (spec §6.3.3), and an allowlist makes "what else did it carry"
 * irrelevant.
 *
 * NO KIND CARRIES USAGE. A failed attempt may have been billed (`usageOutcome: 'unknown'`); a zeroed
 * usage object on it would be a confident 0 for a call nobody can price.
 */

export type ProviderErrorKind =
  | 'invalid-request'
  | 'authentication'
  | 'billing'
  | 'permission'
  | 'not-found'
  | 'conflict'
  | 'request-too-large'
  | 'rate-limited'
  | 'spend-cap'
  | 'api-error'
  | 'provider-timeout'
  | 'overloaded'
  | 'http-other'
  | 'network'
  | 'client-timeout'
  | 'aborted'
  /** the SDK threw with zero completed steps and no HTTP classification */
  | 'sdk-rejected'
  /** a 2xx whose body cannot be read as a Message */
  | 'response-unreadable'

/**
 * The ALLOWLIST: the only facts about a failed attempt the classifier may read. Every field is a
 * primitive; nothing here can hold a header map, a request body or a credential.
 */
export interface ClassifierInput {
  httpStatus?: number
  /** body `error.type` */
  errorType?: string
  /** body `error.details.error_code` */
  errorCode?: string
  /** the raw `retry-after` header value (seconds) */
  retryAfterHeader?: string
  /** the `request-id` response header */
  requestIdHeader?: string
  /** the body's `request_id` (error bodies only) — used when the header is absent */
  requestIdBody?: string
  transport?: 'network' | 'client-timeout' | 'aborted'
  /** did the capturing fetch observe the request leave? `undefined` is read as "it may have" */
  requestSent?: boolean
  sdkRejected?: boolean
  /** a 2xx arrived and its body is not a readable Message (e.g. no `id`) */
  responseUnreadable?: boolean
}

export interface ProviderError {
  kind: ProviderErrorKind
  retryable: boolean
  /** parsed from `retry-after` (seconds → ms), only when present and parseable */
  retryAfterMs?: number
  /**
   * `none-reported`: an HTTP error response was read and stated no usage — NOT a claim the call was
   * free (O-16), or the request provably never left. `unknown`: no response was read, so the
   * provider may have completed and billed it.
   */
  usageOutcome: 'none-reported' | 'unknown'
  /** a sentence CODE rendered by i18n; never provider or internal text */
  userCode: string
  httpStatus?: number
  /** the raw `error.type`, kept verbatim — including one this taxonomy does not know */
  errorType?: string
  requestId?: string
  /** which source supplied `requestId` */
  requestIdSource?: 'header' | 'body'
}

/**
 * The closed list of `ProviderErrorKind`, for exhaustiveness checks in tests and call sites that
 * must handle every kind (an i18n table, a retry-policy switch). Kept in the same order as the
 * union above.
 */
export const PROVIDER_ERROR_KINDS: readonly ProviderErrorKind[] = [
  'invalid-request',
  'authentication',
  'billing',
  'permission',
  'not-found',
  'conflict',
  'request-too-large',
  'rate-limited',
  'spend-cap',
  'api-error',
  'provider-timeout',
  'overloaded',
  'http-other',
  'network',
  'client-timeout',
  'aborted',
  'sdk-rejected',
  'response-unreadable',
]

/**
 * The status → kind table, §4.3. Every entry is a status this taxonomy RECOGNISES by its
 * `error.type`; an unrecognised type under a known status, or a status not in this table at all,
 * becomes `http-other` (below) rather than silently adopting the table's kind for a body that
 * never said so.
 */
interface StatusEntry {
  kind: ProviderErrorKind
  /** the `error.type` this status is expected to carry, per R12 §1.7 */
  errorType: string
  retryable: boolean
  userCode: string
}

const STATUS_MAP: Readonly<Record<number, StatusEntry>> = {
  400: { kind: 'invalid-request', errorType: 'invalid_request_error', retryable: false, userCode: 'provider.request_invalid' },
  401: { kind: 'authentication', errorType: 'authentication_error', retryable: false, userCode: 'provider.key_rejected' },
  402: { kind: 'billing', errorType: 'billing_error', retryable: false, userCode: 'provider.billing' },
  403: { kind: 'permission', errorType: 'permission_error', retryable: false, userCode: 'provider.forbidden' },
  404: { kind: 'not-found', errorType: 'not_found_error', retryable: false, userCode: 'provider.not_found' },
  // Conflict is "yes, after resolving" per R12 — resolving is not something a blind retry does,
  // so B1 marks it NOT retryable (spec §4.3 table, explicit deviation from R12's wording).
  409: { kind: 'conflict', errorType: 'conflict_error', retryable: false, userCode: 'provider.conflict' },
  413: { kind: 'request-too-large', errorType: 'request_too_large', retryable: false, userCode: 'provider.too_large' },
  // ASSUMPTION: the spec table only documents 429 WITH a `retry-after` header as retryable
  // ("rate-limited | 429 rate_limit_error WITH retry-after | yes, honouring retry-after"). A 429
  // without one is still classified `rate-limited` and still retryable — via backoff, since there
  // is no `retry-after` to honour — because refusing to retry a rate limit merely for lacking a
  // header would treat the header's absence as a stronger signal than the status itself.
  429: { kind: 'rate-limited', errorType: 'rate_limit_error', retryable: true, userCode: 'provider.rate_limited' },
  500: { kind: 'api-error', errorType: 'api_error', retryable: true, userCode: 'provider.unavailable' },
  504: { kind: 'provider-timeout', errorType: 'timeout_error', retryable: true, userCode: 'provider.timeout' },
  529: { kind: 'overloaded', errorType: 'overloaded_error', retryable: true, userCode: 'provider.overloaded' },
}

/**
 * Parses `retry-after` as SECONDS (integer or decimal, finite, >= 0) into milliseconds. The
 * Anthropic API documents this header as seconds (R12 §1.6); the HTTP-date form (`retry-after:
 * Wed, 21 Oct 2026 07:28:00 GMT`) is a valid alternative per RFC 9110 but was not covered by the
 * research this spec is built on (O-1 family — nothing here claims it never occurs), so it is left
 * unparsed: `Number(dateString)` is reliably `NaN`, so it falls out as "absent" rather than being
 * misread as a huge second count.
 */
function parseRetryAfterMs(header: string | undefined): number | undefined {
  if (header === undefined) return undefined
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return seconds * 1000
}

/**
 * The ALLOWLIST made executable (spec §6.3.3): copies only the typed `ClassifierInput` fields out
 * of an arbitrary object, each checked against its declared primitive type. Everything else —
 * headers, the request/response body, the SDK's key option, `message`, stack traces — is silently dropped.
 * `classifyProviderError` runs every input through this first, even though its parameter is
 * already typed as `ClassifierInput`: a caller can hand it a wider object at runtime (an SDK error
 * cast to the interface), and this is the defense that makes what else it carries irrelevant.
 */
export function pickClassifierInput(source: unknown): ClassifierInput {
  const out: ClassifierInput = {}
  if (source === null || typeof source !== 'object') return out
  const s = source as Record<string, unknown>

  if (typeof s.httpStatus === 'number') out.httpStatus = s.httpStatus
  if (typeof s.errorType === 'string') out.errorType = s.errorType
  if (typeof s.errorCode === 'string') out.errorCode = s.errorCode
  if (typeof s.retryAfterHeader === 'string') out.retryAfterHeader = s.retryAfterHeader
  if (typeof s.requestIdHeader === 'string') out.requestIdHeader = s.requestIdHeader
  if (typeof s.requestIdBody === 'string') out.requestIdBody = s.requestIdBody
  if (s.transport === 'network' || s.transport === 'client-timeout' || s.transport === 'aborted') {
    out.transport = s.transport
  }
  if (typeof s.requestSent === 'boolean') out.requestSent = s.requestSent
  if (typeof s.sdkRejected === 'boolean') out.sdkRejected = s.sdkRejected
  if (typeof s.responseUnreadable === 'boolean') out.responseUnreadable = s.responseUnreadable

  return out
}

/**
 * TOTAL: every input, however malformed, resolves to a `ProviderError` — never a throw. Precedence
 * (spec §4.3, and the task brief that made the bare table executable):
 *
 * 1. `transport` — aborted / client-timeout / network. These describe what happened on OUR side of
 *    the wire and outrank any stale HTTP facts a caller might also have passed.
 * 2. `responseUnreadable` — a 2xx arrived but its body is not a readable Message.
 * 3. `sdkRejected` with no `httpStatus` — the SDK threw with zero observed HTTP facts.
 * 4. `errorCode === 'enforced_spend_limit_reached'` — spend-cap, decided by the CODE and never by
 *    status (R12 §7 trap 8): it wins over `rate-limited` on 429 and over `invalid-request` on 400,
 *    and over whatever any other status would otherwise suggest, because retrying against a cap
 *    spins uselessly until the next billing period.
 * 5. The HTTP status table.
 * 6. No facts observed at all (no transport, no status, not even `sdkRejected`) — `sdk-rejected` is
 *    the honest residue: something failed and nothing about the wire was ever seen.
 */
export function classifyProviderError(input: ClassifierInput): ProviderError {
  const safe = pickClassifierInput(input)
  const retryAfterMs = parseRetryAfterMs(safe.retryAfterHeader)
  const requestId = safe.requestIdHeader ?? safe.requestIdBody
  const requestIdSource: ProviderError['requestIdSource'] =
    safe.requestIdHeader !== undefined ? 'header' : safe.requestIdBody !== undefined ? 'body' : undefined

  const finish = (
    base: Pick<ProviderError, 'kind' | 'retryable' | 'usageOutcome' | 'userCode'> & { errorType?: string },
  ): ProviderError => ({
    kind: base.kind,
    retryable: base.retryable,
    usageOutcome: base.usageOutcome,
    userCode: base.userCode,
    ...(base.errorType !== undefined ? { errorType: base.errorType } : {}),
    ...(safe.httpStatus !== undefined ? { httpStatus: safe.httpStatus } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(requestId !== undefined ? { requestId, requestIdSource } : {}),
  })

  // 1. transport
  if (safe.transport === 'aborted') {
    return finish({ kind: 'aborted', retryable: false, usageOutcome: 'unknown', userCode: 'provider.cancelled' })
  }
  if (safe.transport === 'client-timeout') {
    return finish({ kind: 'client-timeout', retryable: false, usageOutcome: 'unknown', userCode: 'provider.no_response' })
  }
  if (safe.transport === 'network') {
    // The request provably never left → the attempt is known clean, so it is safe to retry and its
    // usage is `none-reported` rather than `unknown` (per the ProviderError doc comment above: that
    // outcome covers BOTH "an error response said no usage" and "the request never left").
    // Anything else — sent, or we cannot tell — is an ambiguous attempt: never retried in B1 (§4.5,
    // O-1 — no idempotency key), and usage is `unknown` because the provider may have billed it.
    const neverLeft = safe.requestSent === false
    return finish({
      kind: 'network',
      retryable: neverLeft,
      usageOutcome: neverLeft ? 'none-reported' : 'unknown',
      userCode: 'provider.network',
    })
  }

  // 2. a 2xx whose body is not a readable Message
  if (safe.responseUnreadable) {
    return finish({ kind: 'response-unreadable', retryable: false, usageOutcome: 'unknown', userCode: 'provider.error' })
  }

  // 3. the SDK threw with zero observed HTTP facts
  if (safe.sdkRejected && safe.httpStatus === undefined) {
    return finish({ kind: 'sdk-rejected', retryable: false, usageOutcome: 'unknown', userCode: 'provider.error' })
  }

  // 4. spend-cap — decided by the CODE, never by status; checked before the status table so it
  //    overrides whatever a 429 or a 400 (or any other status) would otherwise resolve to.
  if (safe.errorCode === 'enforced_spend_limit_reached') {
    return finish({ kind: 'spend-cap', retryable: false, usageOutcome: 'none-reported', userCode: 'provider.spend_cap' })
  }

  // 5. HTTP status mapping
  if (safe.httpStatus !== undefined) {
    const entry = STATUS_MAP[safe.httpStatus]

    if (entry && safe.errorType === undefined) {
      // ASSUMPTION: a known status with NO error.type at all (e.g. an HTML body from a fronting
      // proxy, not Anthropic's own JSON) is classified by status alone — there is nothing to keep
      // as a raw `errorType`, so none is set.
      return finish({ kind: entry.kind, retryable: entry.retryable, usageOutcome: 'none-reported', userCode: entry.userCode })
    }
    if (entry && safe.errorType === entry.errorType) {
      return finish({
        kind: entry.kind,
        retryable: entry.retryable,
        usageOutcome: 'none-reported',
        userCode: entry.userCode,
        errorType: safe.errorType,
      })
    }
    // Either the status is not in the table at all, or it is but the body's error.type is one this
    // taxonomy does not recognise — the union stays closed either way: `http-other`, 5xx retryable
    // / 4xx not, and the raw errorType (if any) kept verbatim rather than discarded.
    return finish({
      kind: 'http-other',
      retryable: safe.httpStatus >= 500,
      usageOutcome: 'none-reported',
      userCode: 'provider.error',
      ...(safe.errorType !== undefined ? { errorType: safe.errorType } : {}),
    })
  }

  // 6. no facts observed at all
  return finish({ kind: 'sdk-rejected', retryable: false, usageOutcome: 'unknown', userCode: 'provider.error' })
}

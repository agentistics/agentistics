/**
 * rate-limit.ts — PURE: the rate-limit headers a provider client ALREADY captures, read into one
 * provider-neutral value (B9.3). Nothing here performs I/O, reads a clock or throws; `now` is the
 * caller's.
 *
 * WHAT IS READ, and from whose documentation (each format taken from the vendor's own page, never
 * guessed — checked 2026-09-28):
 *
 * - ANTHROPIC — https://platform.claude.com/docs/en/api/rate-limits § "Response headers".
 *   `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`.
 *   `limit`/`remaining` are integers; `reset` is "the time when the … rate limit will be fully
 *   replenished, provided in RFC 3339 format" — an INSTANT, read as one. Token `remaining` values
 *   are "rounded to the nearest thousand" by Anthropic itself; they are carried as stated.
 *   The `anthropic-priority-*` (Priority Tier) and `anthropic-fast-*` (fast mode) families are NOT
 *   read: the capture allowlist (`anthropic/raw.ts` CAPTURED_HEADER_PREFIX) keeps only
 *   `anthropic-ratelimit-*`, so those headers never reach this module.
 * - OPENAI (and the OpenAI-compatible wire) — https://developers.openai.com/api/docs/guides/rate-limits
 *   § "Rate limits in headers". `x-ratelimit-{limit,remaining,reset}-{requests,tokens,project-tokens}`.
 *   `reset` is "the time UNTIL the rate limit … resets", a DURATION relative to the response
 *   (documented samples `1s`, `6m0s`, `3s`); read with the Go duration grammar those samples are
 *   written in (`1h2m3.5s`, `20ms`, …) and anchored on `now`. A router that names the SAME headers
 *   in another format (an epoch, an RFC 3339 instant) does not parse and is dropped and counted —
 *   it is never re-interpreted under a guess.
 * - `retry-after` — both pages document it as SECONDS. Read with the same rule
 *   `@agentistics/core`'s `parseRetryAfterMs` applies (a non-negative decimal); the RFC 9110
 *   HTTP-date form is not documented by either vendor and is dropped and counted, not guessed at.
 * - GOOGLE — the Gemini API documents no rate-limit response header, so its reading is ABSENT with
 *   that reason. A value is never invented for it.
 *
 * THE RULE (D21): an absent counter is absent. A header that is missing leaves its field
 * undefined; a header that is present and does not parse is DROPPED and COUNTED in `dropped` —
 * never read as 0, which would announce "nothing left" for a limit nobody stated.
 */
import type { ProviderId } from '@agentistics/core'

export type RateLimitResourceKind =
  | 'requests'
  | 'tokens'
  | 'input-tokens'
  | 'output-tokens'
  | 'project-tokens'

export interface RateLimitResource {
  kind: RateLimitResourceKind
  /** absent = not stated (or stated in a shape that did not parse) — never 0 */
  limit?: number
  remaining?: number
  /** ISO instant (UTC) the resource is fully replenished; absent = not stated */
  resetsAt?: string
}

export type RateLimitAbsentReason =
  /** the provider documents no rate-limit response header (Google) */
  | 'not-documented'
  /** a provider this module has no documented header format for */
  | 'unknown-format'
  /** the response carried none of the documented headers */
  | 'no-headers'
  /** headers were present and NONE of them parsed (see `dropped`) */
  | 'unparseable'

export type RateLimitReading =
  | {
      source: 'headers'
      /** in a fixed order (`RESOURCE_ORDER`); only resources with at least one stated field */
      resources: RateLimitResource[]
      retryAfterMs?: number
      /** headers present but unparseable — dropped, never read as 0 */
      dropped: number
    }
  | { absent: RateLimitAbsentReason; dropped: number }

const RESOURCE_ORDER: readonly RateLimitResourceKind[] = [
  'requests',
  'tokens',
  'input-tokens',
  'output-tokens',
  'project-tokens',
]

type Field = 'limit' | 'remaining' | 'reset'

/** A header this module knows how to read, mapped to (resource, field). */
interface HeaderSlot {
  kind: RateLimitResourceKind
  field: Field
}

const ANTHROPIC_PREFIX = 'anthropic-ratelimit-'
const ANTHROPIC_KINDS: readonly RateLimitResourceKind[] = ['requests', 'tokens', 'input-tokens', 'output-tokens']
const OPENAI_PREFIX = 'x-ratelimit-'
const OPENAI_KINDS: readonly RateLimitResourceKind[] = ['requests', 'tokens', 'project-tokens']
const FIELDS: readonly Field[] = ['limit', 'remaining', 'reset']

/** `anthropic-ratelimit-<kind>-<field>` */
function anthropicSlot(name: string): HeaderSlot | null {
  if (!name.startsWith(ANTHROPIC_PREFIX)) return null
  const rest = name.slice(ANTHROPIC_PREFIX.length)
  for (const field of FIELDS) {
    const suffix = `-${field}`
    if (!rest.endsWith(suffix)) continue
    const kind = rest.slice(0, -suffix.length) as RateLimitResourceKind
    if (ANTHROPIC_KINDS.includes(kind)) return { kind, field }
  }
  return null
}

/** `x-ratelimit-<field>-<kind>` — OpenAI puts the field FIRST */
function openAISlot(name: string): HeaderSlot | null {
  if (!name.startsWith(OPENAI_PREFIX)) return null
  const rest = name.slice(OPENAI_PREFIX.length)
  for (const field of FIELDS) {
    const prefix = `${field}-`
    if (!rest.startsWith(prefix)) continue
    const kind = rest.slice(prefix.length) as RateLimitResourceKind
    if (OPENAI_KINDS.includes(kind)) return { kind, field }
  }
  return null
}

const INTEGER = /^\d+$/

function parseCount(value: string): number | undefined {
  const v = value.trim()
  if (!INTEGER.test(v)) return undefined
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : undefined
}

/** RFC 3339 date-time (§5.6): full-date "T" full-time with a REQUIRED offset (`Z` or ±hh:mm). */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

function parseRfc3339(value: string): string | undefined {
  const v = value.trim()
  if (!RFC3339.test(v)) return undefined
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

const DURATION_UNITS_MS: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1000,
  ms: 1,
  us: 0.001,
  'µs': 0.001,
  'μs': 0.001,
  ns: 0.000001,
}
/** one `<number><unit>` term of a Go duration; `ms`/`us`/`ns` listed before `m`/`s` so they win */
const DURATION_TERM = /(\d+(?:\.\d+)?|\.\d+)(ms|us|µs|μs|ns|h|m|s)/y

/**
 * The Go `time.Duration` string grammar OpenAI's documented samples are written in: one or more
 * `<decimal><unit>` terms, concatenated, nothing else (`6m0s`, `1h2m3.5s`, `20ms`, `0.5s`). A bare
 * number (`"56"`), an empty string, a sign, whitespace between terms or an unknown unit is REFUSED
 * — `"56"` is seconds for `retry-after` and nobody documents it here, so reading it would be a guess.
 */
export function parseGoDurationMs(value: string): number | undefined {
  const v = value.trim()
  if (v === '') return undefined
  let total = 0
  let pos = 0
  while (pos < v.length) {
    DURATION_TERM.lastIndex = pos
    const m = DURATION_TERM.exec(v)
    if (m === null || m.index !== pos) return undefined
    total += Number(m[1]) * DURATION_UNITS_MS[m[2]!]!
    pos = DURATION_TERM.lastIndex
  }
  return Number.isFinite(total) ? total : undefined
}

const SECONDS = /^(\d+(?:\.\d+)?)$/

function parseRetryAfterSeconds(value: string): number | undefined {
  const m = SECONDS.exec(value.trim())
  return m === null ? undefined : Number(m[1]) * 1000
}

type Format = 'anthropic' | 'openai'

function formatOf(provider: ProviderId): Format | RateLimitAbsentReason {
  switch (provider) {
    case 'anthropic':
      return 'anthropic'
    case 'openai':
    case 'openai-compatible':
      return 'openai'
    case 'google':
      return 'not-documented'
    default:
      return 'unknown-format'
  }
}

/**
 * Reads the captured headers of ONE response into a `RateLimitReading`. `headers` is the capture's
 * allowlisted record (names already lower-cased by `allowlistHeaders` /
 * `allowlistOpenAICompatibleHeaders`); names are lower-cased again here so a hand-built record
 * cannot miss. `now` anchors OpenAI's relative reset durations.
 */
export function readRateLimit(
  provider: ProviderId,
  headers: Record<string, string>,
  now: Date,
): RateLimitReading {
  const format = formatOf(provider)
  if (format !== 'anthropic' && format !== 'openai') return { absent: format, dropped: 0 }

  const slotOf = format === 'anthropic' ? anthropicSlot : openAISlot
  const byKind = new Map<RateLimitResourceKind, RateLimitResource>()
  let seen = 0
  let dropped = 0
  let retryAfterMs: number | undefined

  // Sorted so which of two same-named (differently cased) headers wins never depends on insertion order.
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  for (const [name, value] of entries) {
    if (name === 'retry-after') {
      seen += 1
      const ms = parseRetryAfterSeconds(value)
      if (ms === undefined) dropped += 1
      else retryAfterMs = ms
      continue
    }
    const slot = slotOf(name)
    if (slot === null) continue
    seen += 1

    const resource = byKind.get(slot.kind) ?? { kind: slot.kind }
    if (slot.field === 'reset') {
      let resetsAt: string | undefined
      if (format === 'anthropic') {
        resetsAt = parseRfc3339(value)
      } else {
        const ms = parseGoDurationMs(value)
        resetsAt = ms === undefined ? undefined : new Date(now.getTime() + ms).toISOString()
      }
      if (resetsAt === undefined) { dropped += 1; continue }
      resource.resetsAt = resetsAt
    } else {
      const n = parseCount(value)
      if (n === undefined) { dropped += 1; continue }
      resource[slot.field] = n
    }
    byKind.set(slot.kind, resource)
  }

  if (seen === 0) return { absent: 'no-headers', dropped: 0 }
  const resources = RESOURCE_ORDER.flatMap((k) => {
    const r = byKind.get(k)
    return r === undefined ? [] : [r]
  })
  if (resources.length === 0 && retryAfterMs === undefined) return { absent: 'unparseable', dropped }
  return {
    source: 'headers',
    resources,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    dropped,
  }
}

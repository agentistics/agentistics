/**
 * usage.ts — PURE. The normalised, per-provider-agnostic usage shape (B1 spec §4.2), plus the
 * Anthropic reader that fills it (spec §5.1).
 *
 * ## Why a `ProviderUsage` exists at all, separate from `ModelUsage`
 *
 * `ModelUsage` (`../types.ts`) is the STORED shape — a session's per-model rollup, priced and
 * summed. `ProviderUsage` is the shape ONE model response states, before anything sums it: it
 * carries the counters `ModelUsage` also carries, plus everything a provider's raw body says that
 * `ModelUsage` has no field for yet (reasoning, iterations, server-tool counts, a context gauge, and
 * which counters the provider simply did not report). Collapsing the two would either lose those
 * facts or force `ModelUsage` to grow fields no session-level rollup needs.
 *
 * ## The four counters, and why `input` never includes cache (spec §4.2, §5.1 normalisation rule)
 *
 * Anthropic's own documented formula is `total_input_tokens = cache_read_input_tokens +
 * cache_creation_input_tokens + input_tokens` — `input_tokens` is ALREADY cache-exclusive on the
 * wire, unlike every other provider research 12 surveys (§5.1's normalisation-rule note). So for
 * Anthropic this reader performs NO subtraction; a later provider (B5) will have to, and that is
 * exactly why the subtraction is a per-provider READER decision and never a shared helper here —
 * "add cache to input" would be right for one provider and wrong for the rest.
 *
 * There is no `total` field, on purpose: a total is computed only through `../tokens.ts`
 * (`providerUsageTokens` below feeds it a `TokenBreakdown`), never by hand — the same rule
 * `tokens.lint.test.ts` enforces over the whole product, now over this directory too.
 *
 * ## `missing`, and why a counter's absence is never silently read as zero (spec §4.2, O-7)
 *
 * Whether `cache_read_input_tokens` / `cache_creation_input_tokens` are always present, or only
 * once cache activity has occurred at all, is NOT established by the research this spec cites
 * (O-7). So every one of the four counters is read through the SAME rule: present as a finite,
 * non-negative number → that value; anything else (absent, not a number, negative, `NaN`,
 * `Infinity`) → `0` as a PLACEHOLDER, and the counter's name goes into `missing`. A reader must
 * check `missing` BEFORE trusting a zero here, the same discipline `unmeasured: true` demands
 * before trusting an agent row's figures.
 *
 * ## `cacheWriteByTtl` — both-or-neither, and must sum to the flat figure (spec §4.2, §5.1)
 *
 * Anthropic's nested `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` is
 * documented as present only conditionally (§5.1's field-map row), mirroring
 * `ModelUsage.cacheCreation1hInputTokens` / `cacheCreation5mInputTokens` (`../types.ts`), which
 * `calcCost` prices at 2x / 1.25x. The breakdown is adopted ONLY when both buckets are present AND
 * their sum equals the flat `cache_creation_input_tokens` — a split that does not sum, or names
 * only one bucket, is a half-true statement about the volume, and is DROPPED (the flat `cacheWrite`
 * figure always stands on its own) with an anomaly recorded, never guessed at.
 *
 * ## `reasoning` — absent is not `unknown` (spec §4.2, O-2)
 *
 * Anthropic's public Messages API `usage` object documents no `thinking_tokens` field; thinking is
 * folded into `output_tokens` with nothing to separate it. So `reasoning` is ABSENT by default —
 * never `{tokens: 0, billing: 'unknown'}`, which would be a confident zero for thinking the model
 * may well have done. The AI SDK's own zod schema declares `output_tokens_details.thinking_tokens`
 * (research 13), which research 12 does not corroborate (O-2 — unresolved without a fixture from a
 * thinking-enabled call). So: if that field is present and numeric, it is carried as
 * `{tokens, billing: 'unknown'}` — a figure WAS reported and its relation to `output` is not
 * established — and it is NEVER added into `output` or any total (`providerUsageTokens` below never
 * reads it).
 *
 * ## `iterations` — carried verbatim, never folded, never dropped (spec §4.2, §5.1, O-3)
 *
 * Whether Anthropic's raw top-level `usage` already includes advisor/compaction iteration tokens is
 * unresolved (O-3): research 13 establishes only that the AI SDK's OWN `convertAnthropicUsage`
 * excludes them from its typed totals, not what the raw API body does. So each element of a raw
 * `usage.iterations[]` array is kept AS GIVEN — its own `kind`, its own `model` when it names one,
 * and the whole element as `raw` — and `iterationsRelation` is set to `'unmeasured'`, the only
 * value this reader can state. Nothing here adds an iteration's tokens into the four counters
 * (double-counts if the top level already includes them) or drops it (under-reports if it does
 * not); `usagePricing` below reads the presence of `iterations` as a reason pricing is PARTIAL.
 * The key that names an iteration's kind is not pinned by any fixture either (`type` is read here
 * as the best-available guess, falling back to `'unknown'` — see O-3's own note on this).
 *
 * ## `contextTokens` — a GAUGE, never a sum (spec §4.2, §5.1 "What context tokens is for Anthropic")
 *
 * Computed as `input + cacheRead + cacheWrite` of THIS response only — arithmetically identical to
 * Anthropic's own documented `total_input_tokens` formula (confirmed against research 12 §1.1), and
 * exactly the JSONL-adapter convention this product already uses for the context gauge elsewhere
 * (see CLAUDE.md, "The context gauge"). It is ABSENT whenever any of those three input-side
 * counters is itself `missing` — a gauge built from a placeholder zero is a wrong percentage, and a
 * wrong percentage is worse than an absent bar.
 *
 * ## What this module explicitly does NOT do
 *
 * It never computes a total (`../tokens.ts` owns that), never prices anything (no `costUSD`
 * anywhere — Anthropic returns no money on the wire, spec §5.1), and never infers a subset from a
 * total. `toModelUsage` maps this response's counters onto the STORED shape's fields for a caller
 * that wants to hand them to `calcCost`; it omits `costUSD` because pricing is not this module's
 * job — the caller prices, this module counts.
 */

import type { ModelUsage } from '../types'
import type { TokenBreakdown } from '../tokens'

/** The TTL split of a cache write — mirrors `ModelUsage.cacheCreation1hInputTokens`/`5mInputTokens`. */
export interface CacheWriteByTtl {
  ephemeral5m: number
  ephemeral1h: number
}

/**
 * A separately-stated reasoning/thinking figure.
 *
 * `billing` says how it relates to `output` — `'included-in-output'` (the tokens are already
 * counted there too, so summing both double-counts), `'additive'` (a provider that bills them on
 * top, e.g. Google's `thoughtsTokenCount`), or `'unknown'` (reported, relation not established —
 * Anthropic's only possible reading today, per O-2). Never assume `'included-in-output'` without a
 * provider that documents it that way.
 */
export interface ReasoningUsage {
  tokens: number
  billing: 'included-in-output' | 'additive' | 'unknown'
}

/**
 * One Anthropic advisor/compaction/fallback sub-call, carried exactly as the raw body stated it.
 *
 * `kind` and `model` are read for convenience; `raw` is the element verbatim, because typed counters
 * are extracted only once a fixture pins the key names inside an iteration (O-3).
 */
export interface UsageIteration {
  kind: string
  model?: string
  raw: Readonly<Record<string, unknown>>
}

/** The four counters a provider stated for ONE response, plus what it stated beyond them. */
export interface ProviderUsage {
  /** EXCLUDES cache read and cache write — always, every provider (see module doc). */
  input: number
  /** Includes whatever the provider folds into it (see `reasoning`). */
  output: number
  cacheRead: number
  /** Flat total; `=== ephemeral5m + ephemeral1h` whenever `cacheWriteByTtl` is present. */
  cacheWrite: number
  cacheWriteByTtl?: CacheWriteByTtl
  /** ABSENT for Anthropic unless a thinking-details field is present — see module doc. */
  reasoning?: ReasoningUsage
  /** Anthropic advisor/compaction/fallback sub-calls — carried, never folded into the four counters. */
  iterations?: UsageIteration[]
  /** The only value this reader can state about how `iterations` relate to the top-level totals. */
  iterationsRelation?: 'unmeasured'
  /** A COUNT, not tokens (spec §4.2). */
  serverToolUse?: { webSearchRequests?: number }
  /** GAUGE = input + cacheRead + cacheWrite of THIS response — never summed across responses. */
  contextTokens?: number
  /** Counters the source did not state (a finite, non-negative number was not found for them). */
  missing?: Array<'input' | 'output' | 'cacheRead' | 'cacheWrite'>
}

/**
 * Why a stated fact was NOT adopted as-is. Each value is a divergence the caller can count, never a
 * silent correction.
 */
export type UsageAnomaly =
  /** the raw `usage` body itself was not a readable object — every counter is `missing` */
  | 'usage-not-an-object'
  /** exactly one of `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` was present */
  | 'cache-ttl-split-partial'
  /** both TTL buckets were present but did not sum to the flat `cache_creation_input_tokens` (or that flat figure itself was missing) */
  | 'cache-ttl-split-mismatch'

const MISSING_ALL: Array<'input' | 'output' | 'cacheRead' | 'cacheWrite'> =
  ['input', 'output', 'cacheRead', 'cacheWrite']

/** A counter is trusted only when it is a finite, non-negative number — never inferred otherwise. */
function readCounter(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

function readObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/**
 * One raw `usage.iterations[]` element → `UsageIteration`, carried verbatim.
 *
 * The key naming an iteration's kind is not pinned by any fixture (O-3); `type` is read as the
 * best-available candidate and a non-string or missing value falls back to `'unknown'` rather than
 * being invented. An element that is not itself an object still yields a row — dropping it would
 * silently shrink the iteration count the caller is meant to see — with `raw: { value: el }` so
 * nothing about it is lost.
 */
function toUsageIteration(el: unknown): UsageIteration {
  const obj = readObject(el)
  if (!obj) return { kind: 'unknown', raw: { value: el } }
  const kind = typeof obj.type === 'string' ? obj.type : 'unknown'
  const model = typeof obj.model === 'string' ? obj.model : undefined
  const iteration: UsageIteration = { kind, raw: { ...obj } }
  if (model !== undefined) iteration.model = model
  return iteration
}

/**
 * Anthropic's raw `usage` object → `ProviderUsage`, per spec §5.1's field map and normalisation
 * rule. See the module doc for the reasoning behind every rule applied here.
 */
export function fromAnthropicUsage(raw: unknown): { usage: ProviderUsage; anomalies: UsageAnomaly[] } {
  const anomalies: UsageAnomaly[] = []
  const body = readObject(raw)
  if (!body) {
    anomalies.push('usage-not-an-object')
    return { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, missing: MISSING_ALL }, anomalies }
  }

  const inputRaw = readCounter(body, 'input_tokens')
  const outputRaw = readCounter(body, 'output_tokens')
  const cacheReadRaw = readCounter(body, 'cache_read_input_tokens')
  const cacheWriteRaw = readCounter(body, 'cache_creation_input_tokens')

  const missing: Array<'input' | 'output' | 'cacheRead' | 'cacheWrite'> = []
  if (inputRaw === undefined) missing.push('input')
  if (outputRaw === undefined) missing.push('output')
  if (cacheReadRaw === undefined) missing.push('cacheRead')
  if (cacheWriteRaw === undefined) missing.push('cacheWrite')

  const usage: ProviderUsage = {
    // Anthropic's `input_tokens` is already cache-exclusive — no subtraction (module doc).
    input: inputRaw ?? 0,
    output: outputRaw ?? 0,
    cacheRead: cacheReadRaw ?? 0,
    cacheWrite: cacheWriteRaw ?? 0,
  }
  if (missing.length > 0) usage.missing = missing

  // cacheWriteByTtl — both-or-neither, and must sum to the flat figure.
  const cacheCreation = readObject(body.cache_creation)
  if (cacheCreation) {
    const ephemeral5m = readCounter(cacheCreation, 'ephemeral_5m_input_tokens')
    const ephemeral1h = readCounter(cacheCreation, 'ephemeral_1h_input_tokens')
    if (ephemeral5m !== undefined && ephemeral1h !== undefined) {
      if (cacheWriteRaw !== undefined && ephemeral5m + ephemeral1h === cacheWriteRaw) {
        usage.cacheWriteByTtl = { ephemeral5m, ephemeral1h }
      } else {
        anomalies.push('cache-ttl-split-mismatch')
      }
    } else if (ephemeral5m !== undefined || ephemeral1h !== undefined) {
      anomalies.push('cache-ttl-split-partial')
    }
  }

  // reasoning — absent unless the SDK-only `output_tokens_details.thinking_tokens` field shows up.
  const outputDetails = readObject(body.output_tokens_details)
  if (outputDetails) {
    const thinking = readCounter(outputDetails, 'thinking_tokens')
    if (thinking !== undefined) usage.reasoning = { tokens: thinking, billing: 'unknown' }
  }

  // iterations — carried verbatim, never folded into the four counters.
  const iterationsRaw = body.iterations
  if (Array.isArray(iterationsRaw) && iterationsRaw.length > 0) {
    usage.iterations = iterationsRaw.map(toUsageIteration)
    usage.iterationsRelation = 'unmeasured'
  }

  // serverToolUse — a count, not tokens.
  const serverToolUse = readObject(body.server_tool_use)
  if (serverToolUse) {
    const webSearchRequests = readCounter(serverToolUse, 'web_search_requests')
    if (webSearchRequests !== undefined) usage.serverToolUse = { webSearchRequests }
  }

  // contextTokens — a gauge of THIS response, absent if any input-side counter is missing.
  if (inputRaw !== undefined && cacheReadRaw !== undefined && cacheWriteRaw !== undefined) {
    usage.contextTokens = usage.input + usage.cacheRead + usage.cacheWrite
  }

  return { usage, anomalies }
}

/**
 * The four counters only, as a `TokenBreakdown` — the shape `../tokens.ts`'s `totalTokens()` etc.
 * take. `reasoning` and `iterations` are NEVER folded in here (module doc); a total that wants to
 * account for them has to say so explicitly, the same way `totalTokensExplained` names the cache.
 */
export function providerUsageTokens(u: ProviderUsage): TokenBreakdown {
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
  }
}

/**
 * `ProviderUsage` → the fields `calcCost()` needs, minus `costUSD` (this module counts, it never
 * prices — see module doc). `cacheWriteByTtl`, when present, maps onto the same TTL split
 * `ModelUsage` already carries so `calcCost` prices the 1h/5m buckets at their own rates instead of
 * the conservative flat-rate fallback.
 */
export function toModelUsage(u: ProviderUsage): Omit<ModelUsage, 'costUSD'> {
  const result: Omit<ModelUsage, 'costUSD'> = {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadInputTokens: u.cacheRead,
    cacheCreationInputTokens: u.cacheWrite,
    webSearchRequests: u.serverToolUse?.webSearchRequests ?? 0,
  }
  if (u.cacheWriteByTtl) {
    result.cacheCreation1hInputTokens = u.cacheWriteByTtl.ephemeral1h
    result.cacheCreation5mInputTokens = u.cacheWriteByTtl.ephemeral5m
  }
  return result
}

/**
 * Whether this usage can be priced COMPLETELY from the four counters alone.
 *
 * `'partial'` when any counter is `missing` (a placeholder zero is standing in for an unknown
 * figure) OR when `iterations` are present (spec §4.2: an invocation carrying iterations is priced
 * partially and SAYS so, because whether those tokens are already inside the four counters is
 * unresolved — O-3). `'complete'` otherwise.
 */
export function usagePricing(u: ProviderUsage): 'complete' | 'partial' {
  if (u.missing && u.missing.length > 0) return 'partial'
  if (u.iterations && u.iterations.length > 0) return 'partial'
  return 'complete'
}

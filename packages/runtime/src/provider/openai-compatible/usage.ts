/**
 * usage.ts — PURE. B5a.2 of the shared contract (`/tmp/.../scratchpad/contract.md` D4): the usage
 * reader + certainty grade for OpenAI-compatible Chat Completions responses (openai / openrouter /
 * deepseek / litellm / 9router / ollama — D1/D2). `openai-compatible/raw.ts` (a sibling item) hands
 * this module the WHOLE parsed response body and reads `usage`/`anomalies`/`notes`/`certainty`/`cost`
 * straight off the result — this is the ONE place the per-endpoint arithmetic lives.
 *
 * Sources: docs/superpowers/research/12-provider-apis.md §2.1 (OpenAI usage, the input/cache
 * inclusion trap), §4.1 (OpenRouter usage + `cost`), §5.1 (Ollama — no cache/reasoning concept), §6
 * (comparison table), §7 traps 1–2 (reasoning inclusion, input/cache inclusion); DeepSeek's own API
 * reference (`https://api-docs.deepseek.com/api/create-chat-completion`, fetched 2026-09-27 — see
 * "DeepSeek's cache split" below for exactly how much of that fetch is load-bearing); OpenRouter's
 * FAQ (`https://openrouter.ai/docs/faq`, fetched 2026-09-27, "OpenRouter uses a credit system where
 * the base currency is US dollars. All of the pricing on our site and API is denoted in dollars.")
 * and its generation-stats page (`https://openrouter.ai/docs/use-cases/usage-accounting`, fetched
 * 2026-09-27 for the chat-completion-body `usage.cost` example; the standalone
 * `GET /api/v1/generation` shape below is corroborated by a web search of third-party mirrors of
 * OpenRouter's docs rather than a direct fetch of that specific page, which 404'd this session — see
 * `readOpenRouterGeneration`'s own doc for exactly what is and is not independently verified there).
 * `@agentistics/core`'s own `ReasoningBilling` doc (`canonical/entities.ts`) is cited directly for the
 * OpenAI/OpenRouter reasoning-inclusion rule (see "Reasoning" below).
 *
 * ## Shape detection, not endpoint dispatch
 *
 * `OpenAICompatibleEndpointKind` (D2) is `'direct' | 'router' | 'local'` — courser than the six
 * endpoint ids D1 names, and `openai` and `deepseek` BOTH map to `'direct'`. So `kind` alone can
 * never tell this reader "this body came from DeepSeek" — only the WIRE SHAPE can. DeepSeek's usage
 * object states two fields no other surveyed provider's Chat Completions body carries at all —
 * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, top-level siblings of `prompt_tokens`, per
 * the fetched DeepSeek API reference. Their presence (both, each a finite non-negative number) is
 * therefore the ONLY thing this reader trusts to say "this is DeepSeek's cache split", regardless of
 * the `kind` it was called with — a `'direct'` body that does NOT carry them is read as the generic
 * OpenAI cache shape instead. This is deliberately shape-based rather than a `kind === 'direct'`
 * branch, because the alternative — assuming every `'direct'` body follows OpenAI's shape — would
 * silently misread every real DeepSeek response, and assuming every `'direct'` body follows
 * DeepSeek's shape would do the same to OpenAI.
 *
 * ## `input` excludes cache — and what "exclude" means when the wire doesn't say
 *
 * OpenAI's own `prompt_tokens` (and OpenRouter's identical field, §4.1) is documented as ALREADY
 * INCLUDING its cached sub-count (research 12 §2.1, §7 trap 2 — the opposite of Anthropic, whose
 * `input_tokens` already excludes it). So getting a cache-EXCLUSIVE `input` here needs a subtraction
 * Anthropic's reader never performs: `input = prompt_tokens − prompt_tokens_details.cached_tokens`,
 * done only when BOTH sides are stated. Three cases the wire can hand back, each read differently:
 *
 * - **Both stated, `cached_tokens <= prompt_tokens`**: the subtraction is exact. `input` is a real
 *   number, `cacheRead = cached_tokens`, no note.
 * - **`prompt_tokens` stated, `cached_tokens` NOT stated at all**: this is the ambiguous case the
 *   contract calls out. `input = prompt_tokens` is only correct if this call had NO cache activity —
 *   which the body itself does not say either way (an endpoint that reports no cache breakdown could
 *   still have served a cached prefix and just not surfaced it). Silently reporting `input =
 *   prompt_tokens` here would be a confident number standing in for an unverified assumption, so it
 *   is kept — `prompt_tokens` really is the only number the body offers for the input side, and
 *   reporting NOTHING would understate a metric the body plainly states — but flagged with the note
 *   `'input-may-include-cache'`, and `cacheRead` goes to `missing` rather than a placeholder 0 (a
 *   stated absence of a cache breakdown is not the same fact as a stated cache-read of zero).
 * - **`cached_tokens > prompt_tokens` (whether or not both DeepSeek fields are also present)**: the
 *   subtraction would go negative. Per the contract, a negative result is never reported — `input`
 *   goes to `missing` (not `cacheRead`, which is a directly-stated counter and stays exactly what the
 *   body said; the two counters disagreeing is what makes `input` unknowable, not `cacheRead`
 *   untrustworthy) and the note `'cached-exceeds-prompt'` is recorded.
 * - **Neither `prompt_tokens` nor `cached_tokens` stated**: both `input` and `cacheRead` are
 *   `missing`, no note (there is nothing here to flag as suspicious — just nothing stated).
 *
 * ## DeepSeek's cache split (a different pair of fields, no subtraction needed)
 *
 * DeepSeek's own reference names `prompt_cache_hit_tokens` (→ `cacheRead`) and
 * `prompt_cache_miss_tokens` (→ `input`) as top-level `usage` siblings — this task's own brief names
 * these exact two fields, and the fetched DeepSeek API-reference page reproduces them verbatim (the
 * fetch tool paraphrased rather than quoting the page byte-for-byte, so this is recorded as
 * `research-derived, tool-summarized` rather than a literal quote — but it corroborates the brief's
 * own field names exactly, so it is treated as confirmed for those two names specifically). Unlike
 * the OpenAI shape, no subtraction is needed: `miss` already IS the cache-exclusive count. The one
 * check this reader performs is the brief's own: `hit + miss === prompt_tokens` when `prompt_tokens`
 * is ALSO stated; a mismatch is recorded as the note `'deepseek-hit-miss-mismatch'` but neither
 * counter is altered — the two fields the caller actually wants (`hit`, `miss`) are internally
 * consistent on their own; it is `prompt_tokens` that disagrees with their sum, and DeepSeek's own
 * doc names `miss` as the one to use for `input`, not `prompt_tokens` itself.
 *
 * ## `cacheWrite` — read generically, present only where a body actually states it
 *
 * `prompt_tokens_details.cache_write_tokens` is read off WHATEVER body is handed in, regardless of
 * `kind` — research 12 documents it for OpenRouter (§4.1) and, separately, for OpenAI's Responses API
 * under a different nesting (§2.1) that this Chat-Completions-only reader (D3) never sees. OpenAI's
 * own Chat Completions shape (§2.1) and DeepSeek's (this task's brief) name no such field at all —
 * cache writes are documented as free/automatic there, so the field is simply absent on the wire and
 * `cacheWrite` goes to `missing`, never a guessed 0-with-no-flag and never a fabricated field.
 *
 * ## Reasoning — `completion_tokens_details.reasoning_tokens`, and who says it's already counted
 *
 * `@agentistics/core`'s own `ReasoningBilling` doc (`canonical/entities.ts`) states the rule this
 * reader inherits verbatim: *"`included-in-output` — OpenAI / OpenRouter (`reasoning_tokens` is
 * inside output) … `unknown` — the source did not say."* That names OpenAI and OpenRouter
 * SPECIFICALLY, not "every `'direct'`/`'router'` body" — so, combined with the shape-detection rule
 * above: a DeepSeek-shaped body (detected the same way as the cache split, never by `kind`) gets
 * `'unknown'`, because nothing fetched from DeepSeek's own docs states the inclusion relation for
 * `deepseek-reasoner`, even though the field name and nesting are identical to OpenAI's. Every other
 * `'direct'` body (i.e. openai, or a `'direct'`-configured endpoint that is not DeepSeek-shaped) gets
 * `'included-in-output'`. Every `'router'` body (openrouter, litellm, 9router) gets
 * `'included-in-output'` too — openrouter is the one explicitly named above and litellm/9router are
 * presumed to inherit the same OpenAI-derived wire shape without redefining it (an inference, not an
 * independent citation, and recorded as such here rather than silently). `'local'` (ollama) gets
 * `'unknown'`: research 12 §5.1 finds no reasoning-token concept documented for Ollama's own API at
 * all, so a reasoning figure reaching this reader via an OpenAI-compat passthrough carries no
 * documented relation to `output` either way. The counter itself is a sub-count and is NEVER folded
 * into `output` regardless of `billing` — same discipline as `@agentistics/core`'s Anthropic reader.
 * `reasoning_tokens > completion_tokens` is recorded as the note `'reasoning-exceeds-completion'`
 * (the reasoning figure is kept as stated; it is the two figures' relationship that is flagged).
 *
 * ## `contextTokens` — the gauge, and why a missing `cacheWrite` does not block it here
 *
 * `@agentistics/core`'s Anthropic reader requires ALL THREE of `input`/`cacheRead`/`cacheWrite` to be
 * stated before drawing the gauge, because Anthropic's cache-write bucket is a real, commonly-nonzero,
 * separately-billed segment that is essentially always reported when a write happened — a missing
 * value there is a genuine unknown, not a documented absence. On THIS wire the opposite is closer to
 * true: OpenAI's own Chat Completions shape has NO cache-write concept at all (§2.1; free/automatic,
 * no counter), so a missing `cache_write_tokens` on a `'direct'` OpenAI-shaped body is not "unknown,
 * might be large" but "this shape has nothing to say here, and by the vendor's own pricing model that
 * number is architecturally zero." Requiring it before ever drawing a gauge would mean this reader
 * NEVER draws one for OpenAI or DeepSeek — the two providers this reader is most likely to see in
 * practice — while gauges for OpenRouter (which DOES usually state it) would come and go depending on
 * whether a given call happened to write cache that turn. The choice made here: `contextTokens = input
 * + cacheRead + (cacheWrite ?? 0)`, computed whenever `input` AND `cacheRead` are BOTH stated,
 * regardless of whether `cacheWrite` is. When `cacheWrite` is the one missing, the note
 * `'context-gauge-cache-write-unstated'` is added so a caller can tell "this gauge may understate by
 * an unknown write amount" from "this gauge is exact" — the same honesty `missing` gives the four
 * counters, applied to a derived figure instead. `contextTokens` is never drawn at all when `input` or
 * `cacheRead` themselves are missing (including the negative-subtraction case above): a gauge built on
 * a placeholder 0 for either of those is a wrong number, not merely an approximate one.
 *
 * ## Certainty (D2 → D4) and cost — the wire never prices anything table-driven here
 *
 * `certainty` is `kind`'s direct image: `'direct' → 'provider-stated'`, `'router' → 'router-stated'`,
 * `'local' → 'local-unbilled'` — EXCEPT when `usage` itself could not be read as an object at all, in
 * which case it is `'absent'` regardless of `kind` (a body that says nothing is not a "provider
 * statement" of anything, however trusted the endpoint). `cost` NEVER consults `MODEL_PRICING` or
 * `calcCost` — this module counts and (where the wire itself states a price) relays, it never prices.
 * Priority order, each case falling through to the next only when the prior one does not apply:
 * `'router'` with a finite, non-negative `usage.cost` → `{kind:'router-reported', usd, field:
 * 'usage.cost'}` (research 12 §4.1: OpenRouter's own `usage.cost` field, confirmed denominated in US
 * dollars by OpenRouter's FAQ, fetched 2026-09-27 — "the base currency is US dollars … denoted in
 * dollars" — never assumed); `'local'` → `{kind:'unavailable', reason:'local-unbilled'}` UNCONDITIONALLY
 * (a local server is never billed, whatever its counters say); all four counters `missing` →
 * `{kind:'unavailable', reason:'counters-missing'}` (there is nothing here to price at all); otherwise
 * → `{kind:'unavailable', reason:'no-verified-price'}` (the Sonnet fallback, or any table lookup, is
 * NEVER used here — that is a decision for a later, table-driven layer this module deliberately leaves
 * to the caller, per the shared contract D4).
 *
 * ## What this module does NOT do
 *
 * It never computes a total (`@agentistics/core`'s `tokens.ts` owns that), never prices anything
 * against `MODEL_PRICING`, never infers a counter from a total, never reads request headers (the
 * whole parsed BODY is its only input — `openai-compatible/raw.ts` owns header handling), and never
 * branches on the six endpoint ids of D1 — only on `kind` (D2) and on the wire shape actually present,
 * per the "Shape detection, not endpoint dispatch" note above.
 */

import type { ProviderUsage, ReasoningBilling, UsageAnomaly } from '@agentistics/core'

/** D2 — the certainty grade an endpoint's KIND drives; never inferred from a URL by this module. */
export type OpenAICompatibleEndpointKind = 'direct' | 'router' | 'local'

/** Who is making the statement the counters come from. */
export type UsageCertainty =
  | 'provider-stated' // the billing vendor's own API said it (direct)
  | 'router-stated' // a router relayed/normalised it; it is what the router returns, not the upstream bill
  | 'local-unbilled' // a local server (Ollama): counts, but nothing is billed
  | 'absent' // no readable usage object at all

export type CostStatement =
  | { kind: 'router-reported'; usd: number; field: string } // e.g. OpenRouter body usage.cost; field = the JSON path read
  | { kind: 'unavailable'; reason: 'no-verified-price' | 'local-unbilled' | 'counters-missing' }

export interface OpenAICompatibleUsageRead {
  usage: ProviderUsage // D21: a counter not stated is in `missing`, placeholder 0 — never inferred
  anomalies: UsageAnomaly[] // only the existing core values ('usage-not-an-object', …); core is NOT edited
  notes: string[] // runtime-local divergence codes, e.g. 'cached-exceeds-prompt', 'reasoning-exceeds-completion'
  certainty: UsageCertainty
  cost: CostStatement
}

type MissingCounter = 'input' | 'output' | 'cacheRead' | 'cacheWrite'

const MISSING_ALL: MissingCounter[] = ['input', 'output', 'cacheRead', 'cacheWrite']

function readObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** A counter is trusted only when it is a finite, non-negative number — never inferred otherwise. */
function readCounter(body: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!body) return undefined
  const v = body[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

function certaintyFor(kind: OpenAICompatibleEndpointKind): UsageCertainty {
  if (kind === 'direct') return 'provider-stated'
  if (kind === 'router') return 'router-stated'
  return 'local-unbilled'
}

/** See module doc, "Certainty (D2 → D4) and cost". */
function costFor(
  kind: OpenAICompatibleEndpointKind,
  rawUsage: Record<string, unknown> | undefined,
  missing: MissingCounter[] | undefined,
): CostStatement {
  if (kind === 'router') {
    const c = rawUsage?.cost
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
      return { kind: 'router-reported', usd: c, field: 'usage.cost' }
    }
  }
  if (kind === 'local') return { kind: 'unavailable', reason: 'local-unbilled' }
  if (missing !== undefined && missing.length === 4) return { kind: 'unavailable', reason: 'counters-missing' }
  return { kind: 'unavailable', reason: 'no-verified-price' }
}

/** See module doc, "Reasoning". */
function reasoningBillingFor(kind: OpenAICompatibleEndpointKind, isDeepSeekShape: boolean): ReasoningBilling {
  if (kind === 'local') return 'unknown'
  if (kind === 'direct') return isDeepSeekShape ? 'unknown' : 'included-in-output'
  return 'included-in-output' // router: openrouter confirmed; litellm/9router presumed by shape parity
}

/**
 * `body` is the WHOLE parsed Chat Completions response body (D4) — this reader looks at `body.usage`
 * and nothing else on the body. See the module doc for every rule applied below and its citation.
 */
export function readOpenAICompatibleUsage(body: unknown, kind: OpenAICompatibleEndpointKind): OpenAICompatibleUsageRead {
  const anomalies: UsageAnomaly[] = []
  const notes: string[] = []
  const root = readObject(body)
  const rawUsage = root ? readObject(root.usage) : undefined

  if (!rawUsage) {
    anomalies.push('usage-not-an-object')
    const usage: ProviderUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, missing: [...MISSING_ALL] }
    return { usage, anomalies, notes, certainty: 'absent', cost: costFor(kind, undefined, usage.missing as MissingCounter[]) }
  }

  const promptTokens = readCounter(rawUsage, 'prompt_tokens')
  const completionTokens = readCounter(rawUsage, 'completion_tokens')
  const promptDetails = readObject(rawUsage.prompt_tokens_details)
  const completionDetails = readObject(rawUsage.completion_tokens_details)
  const cachedTokens = readCounter(promptDetails, 'cached_tokens')
  const cacheWriteTokens = readCounter(promptDetails, 'cache_write_tokens')
  const reasoningTokens = readCounter(completionDetails, 'reasoning_tokens')

  // DeepSeek shape detection — by field presence, never by `kind` (see module doc).
  const deepseekHit = readCounter(rawUsage, 'prompt_cache_hit_tokens')
  const deepseekMiss = readCounter(rawUsage, 'prompt_cache_miss_tokens')
  const isDeepSeekShape = deepseekHit !== undefined && deepseekMiss !== undefined

  let input: number | undefined
  let cacheRead: number | undefined

  if (isDeepSeekShape) {
    cacheRead = deepseekHit
    input = deepseekMiss
    if (promptTokens !== undefined && deepseekHit + deepseekMiss !== promptTokens) {
      notes.push('deepseek-hit-miss-mismatch')
    }
  } else if (cachedTokens !== undefined) {
    cacheRead = cachedTokens
    if (promptTokens !== undefined) {
      if (cachedTokens > promptTokens) {
        notes.push('cached-exceeds-prompt') // input stays undefined — a negative result is never reported
      } else {
        input = promptTokens - cachedTokens
      }
    }
    // promptTokens undefined here: input stays undefined too — there is nothing to subtract FROM.
  } else if (promptTokens !== undefined) {
    // cached_tokens not stated at all: input = prompt_tokens is only exact if this call had no cache
    // activity, which the body does not confirm either way — see module doc.
    input = promptTokens
    notes.push('input-may-include-cache')
  }

  const missing: MissingCounter[] = []
  if (input === undefined) missing.push('input')
  if (completionTokens === undefined) missing.push('output')
  if (cacheRead === undefined) missing.push('cacheRead')
  if (cacheWriteTokens === undefined) missing.push('cacheWrite')

  const usage: ProviderUsage = {
    input: input ?? 0,
    output: completionTokens ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWriteTokens ?? 0,
  }
  if (missing.length > 0) usage.missing = missing

  if (reasoningTokens !== undefined) {
    if (completionTokens !== undefined && reasoningTokens > completionTokens) {
      notes.push('reasoning-exceeds-completion')
    }
    usage.reasoning = { tokens: reasoningTokens, billing: reasoningBillingFor(kind, isDeepSeekShape) }
  }

  if (input !== undefined && cacheRead !== undefined) {
    usage.contextTokens = input + cacheRead + (cacheWriteTokens ?? 0)
    if (cacheWriteTokens === undefined) notes.push('context-gauge-cache-write-unstated')
  }

  return { usage, anomalies, notes, certainty: certaintyFor(kind), cost: costFor(kind, rawUsage, missing) }
}

/**
 * `GET /api/v1/generation?id=…` — OpenRouter's separate "ask about a past generation" endpoint
 * (research 12 §4.1 names it only as "Alternative: Getting Usage via Generation ID", pointing at a
 * dedicated reference page that returned HTTP 404 on this session's own fetch of the exact URL
 * research 12 would imply). The shape below is corroborated instead by a web search surfacing two
 * independent third-party mirrors of OpenRouter's own docs, both quoting an identical example body:
 * `{"data": {"id", "model", "provider_name", "tokens_prompt", "tokens_completion",
 * "native_tokens_prompt", "native_tokens_completion", "total_cost", "latency", "finish_reason", …}}`.
 * `total_cost` is the field this function reads (`data.total_cost`) — described by that same mirrored
 * text as "the exact credit cost of this generation" and, separately, as "what OpenRouter actually
 * billed for the request"; OpenRouter's FAQ states its credits are denominated in US dollars (see
 * module doc), so `total_cost` is read as USD here. This is WEAKER sourcing than everything else in
 * this module (no direct fetch of OpenRouter's own reference page succeeded) and is recorded as such
 * rather than silently — treat it as corroborated-but-not-directly-verified until someone can fetch
 * that exact page or capture a live response.
 *
 * PURE, and NOT wired to any fetch: the integrator decides whether/when to call OpenRouter's
 * generation endpoint at all (D4/D5 own no HTTP call beyond the one Chat Completions POST, D3).
 */
export function readOpenRouterGeneration(body: unknown): { usd: number; field: string } | null {
  const root = readObject(body)
  const data = root ? readObject(root.data) : undefined
  const cost = data?.total_cost
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
    return { usd: cost, field: 'data.total_cost' }
  }
  return null
}

/**
 * google/usage.ts — PURE. B5b.1: the usage reader for Google's Gemini API (`generateContent` /
 * `streamGenerateContent`, camelCase REST — NOT the newer snake_case "Interactions API"). The ONE
 * place the Google counter arithmetic lives; `raw.ts` and `raw-stream.ts` hand it a `usageMetadata`
 * object and read everything else off the result.
 *
 * Master spec §22.1 (table + "the recurring trap, which cuts BOTH ways"), B1 spec §5.2 / U-2.
 *
 * ## Sources, each read on 2026-09-28 (the doc text is quoted, never paraphrased into a rule)
 *
 * All from https://ai.google.dev/api/generate-content (`UsageMetadata`):
 * - `promptTokenCount` — "Number of tokens in the prompt. When `cachedContent` is set, this is still
 *   the total effective prompt size meaning this includes the number of tokens in the cached content."
 *   So the prompt count INCLUDES the cache — U-2 is settled by that sentence, and `input` needs the
 *   subtraction Anthropic's reader never performs.
 * - `cachedContentTokenCount` — "Number of tokens in the cached part of the prompt (the cached content)".
 * - `candidatesTokenCount` — "Total number of tokens across all the generated response candidates."
 * - `thoughtsTokenCount` — "Output only. Number of tokens of thoughts for thinking models."
 * - `toolUsePromptTokenCount` — "Output only. Number of tokens present in tool-use prompt(s)."
 * - `totalTokenCount` — "Total token count for the generation request (prompt + thoughts + response
 *   candidates)." Note what that sentence does NOT list: the tool-use prompt.
 * And https://ai.google.dev/gemini-api/docs/pricing: every model's Output price is stated as
 * "Output price (including thinking tokens)" — i.e. thoughts are billed, at the OUTPUT rate, in
 * addition to the candidates count.
 *
 * ## The mapping (each row is a test in `usage.test.ts`)
 *
 * | canonical | Google field | rule |
 * |---|---|---|
 * | `input` | `promptTokenCount` − `cachedContentTokenCount` | subtraction, only when both are stated |
 * | `output` | `candidatesTokenCount` | thoughts are NEVER folded in |
 * | `cacheRead` | `cachedContentTokenCount` | |
 * | `cacheWrite` | — | ABSENT (D21). Gemini's API states no cache-write counter; it goes to `missing`, never a 0 |
 * | `reasoning` | `thoughtsTokenCount` | `billing: 'additive'` — separately billed, never inside `output` |
 * | `toolUsePrompt` | `toolUsePromptTokenCount` | `billing: 'unknown'` — see below |
 * | `contextTokens` | `promptTokenCount` | the gauge: the "total effective prompt size" the docs name |
 *
 * ## What `missing` means here, and why absent-cached is NOT read as zero
 *
 * A counter Google did not state goes to `missing` with a placeholder 0 — the openai-compatible
 * reader's exact rule (D21). `promptTokenCount` includes the cache, so an ABSENT
 * `cachedContentTokenCount` leaves two readings: "no cache hit" and "a hit that was not reported".
 * Assuming the first would price a cached call's whole prompt at the full input rate (up to ~10×
 * over on the cached part); so `input` stays `promptTokenCount`, `cacheRead` is `missing`, and the
 * note `input-may-include-cache` says so. Whether Google's JSON simply omits a zero (proto3 style)
 * is a fact only a live response can settle — B5b.2's reconciliation against a bill.
 *
 * ## toolUsePromptTokenCount — carried, never summed, billing `unknown`
 *
 * The docs give the field a definition and no billing relationship: it is not stated to be part of
 * `promptTokenCount`, and the `totalTokenCount` formula does not list it either. So it is carried on
 * its own (`toolUsePrompt`) with `billing: 'unknown'` — never added to `input` (would double-count
 * if the prompt already holds it) and never dropped (would under-report if it is billed on top).
 * Two OBSERVATIONS are recorded as notes when `totalTokenCount` is stated, because they are evidence
 * for whoever settles it (B5b.2) rather than a decision: `total-includes-tool-use-prompt` when the
 * total equals prompt+thoughts+candidates+toolUse, `total-excludes-tool-use-prompt` when it equals
 * prompt+thoughts+candidates. `total-mismatch` when it equals neither — the check that would have
 * caught the 4,8× agy mapping error (CLAUDE.md, "Antigravity") from inside the data.
 *
 * ## What this module does NOT do
 *
 * It never computes a total, never prices (`cost` says why not), and never reads anything but the
 * `usageMetadata` object it is handed. `googleBillableOutputTokens` is the one derived figure, named
 * for what it is: the count the PRICE applies to — kept out of `usage.output` on purpose.
 */

import type { ProviderUsage, ReasoningBilling, UsageAnomaly } from '@agentistics/core'
import type { CostStatement, UsageCertainty } from '../openai-compatible/usage.ts'

/**
 * `toolUsePromptTokenCount`, carried beside — never inside — the four counters. `billing` is the
 * relationship to `input` / `output`: only `unknown` is produced today (module doc); the wider union
 * is what lets a later, verified reading flip it without a type change. Only `additive` may ever be
 * summed by a consumer.
 */
export interface ToolUsePromptUsage {
  tokens: number
  billing: 'unknown' | 'additive' | 'included-in-input'
}

export interface GoogleUsageRead {
  usage: ProviderUsage
  anomalies: UsageAnomaly[]
  /** runtime-local divergence / observation codes; see module doc */
  notes: string[]
  /** absent when Google stated no `toolUsePromptTokenCount` */
  toolUsePrompt?: ToolUsePromptUsage
  certainty: UsageCertainty
  cost: CostStatement
}

type MissingCounter = 'input' | 'output' | 'cacheRead' | 'cacheWrite'

const MISSING_ALL: MissingCounter[] = ['input', 'output', 'cacheRead', 'cacheWrite']

function readObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** A counter is trusted only when it is a finite, non-negative number — never inferred otherwise. */
function readCounter(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/** Google states no cost in-band, and this module never prices (the table is a later layer's job). */
function costFor(missing: MissingCounter[]): CostStatement {
  if (missing.length === MISSING_ALL.length) return { kind: 'unavailable', reason: 'counters-missing' }
  return { kind: 'unavailable', reason: 'no-verified-price' }
}

/**
 * `usageMetadata` (the raw object, from a non-streamed body or from the LAST chunk of a stream — see
 * `raw-stream.ts`) → the normalised usage. Total: never throws, on any input.
 */
export function readGoogleUsage(raw: unknown): GoogleUsageRead {
  const anomalies: UsageAnomaly[] = []
  const notes: string[] = []
  const body = readObject(raw)

  if (!body) {
    anomalies.push('usage-not-an-object')
    const usage: ProviderUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, missing: [...MISSING_ALL] }
    return { usage, anomalies, notes, certainty: 'absent', cost: costFor(MISSING_ALL) }
  }

  const prompt = readCounter(body, 'promptTokenCount')
  const cached = readCounter(body, 'cachedContentTokenCount')
  const candidates = readCounter(body, 'candidatesTokenCount')
  const thoughts = readCounter(body, 'thoughtsTokenCount')
  const toolUse = readCounter(body, 'toolUsePromptTokenCount')
  const total = readCounter(body, 'totalTokenCount')

  let input: number | undefined
  let cacheRead: number | undefined

  if (cached !== undefined) {
    cacheRead = cached
    if (prompt !== undefined) {
      if (cached > prompt) {
        notes.push('cached-exceeds-prompt') // input stays undefined — a negative result is never reported
      } else {
        input = prompt - cached
      }
    }
  } else if (prompt !== undefined) {
    // No cache figure stated: `prompt` is only the cache-exclusive input if this call had no cache
    // hit, which the body does not confirm either way (module doc).
    input = prompt
    notes.push('input-may-include-cache')
  }

  const missing: MissingCounter[] = []
  if (input === undefined) missing.push('input')
  if (candidates === undefined) missing.push('output')
  if (cacheRead === undefined) missing.push('cacheRead')
  missing.push('cacheWrite') // Gemini states no cache-write counter at all (D21: absent, never 0)

  const usage: ProviderUsage = {
    input: input ?? 0,
    output: candidates ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: 0,
    missing,
  }

  // Additive: billed on top of `candidates`, so it is carried with its discriminator and never
  // folded into `output` — and never dropped either.
  if (thoughts !== undefined) usage.reasoning = { tokens: thoughts, billing: 'additive' satisfies ReasoningBilling }

  // The gauge is the prompt count itself: the docs call it "the total effective prompt size", which
  // is exactly input + cacheRead here (there is no cache write). Not `input + …`: when the cache
  // figure is unstated `input` is only a ceiling, while this figure is stated as it is.
  if (prompt !== undefined) usage.contextTokens = prompt

  let toolUsePrompt: ToolUsePromptUsage | undefined
  if (toolUse !== undefined) toolUsePrompt = { tokens: toolUse, billing: 'unknown' }

  // Cross-check against the documented total (module doc): observations, not corrections.
  if (total !== undefined && prompt !== undefined && candidates !== undefined) {
    // @tokens-intentional: reconciling Google's own `totalTokenCount` formula (prompt + thoughts +
    // candidates), not producing a token total for any surface.
    const base = prompt + (thoughts ?? 0) + candidates
    if (toolUse !== undefined && toolUse > 0 && total === base + toolUse) notes.push('total-includes-tool-use-prompt')
    else if (total === base) {
      if (toolUse !== undefined && toolUse > 0) notes.push('total-excludes-tool-use-prompt')
    } else notes.push('total-mismatch')
  }

  const read: GoogleUsageRead = { usage, anomalies, notes, certainty: 'provider-stated', cost: costFor(missing) }
  if (toolUsePrompt) read.toolUsePrompt = toolUsePrompt
  return read
}

/**
 * The output-side token count Google's PRICE applies to: candidates plus the additive thoughts,
 * because the pricing page states the output rate as "including thinking tokens". A pricing layer
 * that feeds `usage.output` alone to `calcCost` under-prices every thinking call (the 4,8× error in
 * the other direction). `output` itself stays candidates-only so the journal states what the wire said.
 */
export function googleBillableOutputTokens(usage: ProviderUsage): number {
  // @tokens-intentional: the documented billable-output reading (pricing page: output price
  // "including thinking tokens"), not a two-term display total.
  return usage.output + (usage.reasoning?.billing === 'additive' ? usage.reasoning.tokens : 0)
}

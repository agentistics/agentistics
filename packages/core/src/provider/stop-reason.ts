/**
 * The provider-neutral stop-reason vocabulary — B1 spec §3, §4.6 (via §9), §5.1
 * (docs/superpowers/specs/2026-09-25-runtime-b1-provider.md), R12 §1.8.
 *
 * PURE. `ModelCompletedData` (P1 §3, `@agentistics/core/canonical/event.ts`) must carry the stop
 * reason and core cannot import from `packages/server`, so the VOCABULARY lives here even though
 * every provider's wire shape differs (R12 §5 line 818: Anthropic is a flat 7-value enum, OpenAI
 * Responses is two fields, Gemini is 13-value and safety-heavy, Ollama mixes generation outcomes
 * with server lifecycle events). Each provider's own mapping function — from ITS wire value to this
 * vocabulary — belongs at that provider's boundary (`anthropic/raw.ts` for B1); only the neutral
 * names and the Anthropic mapping (pure and tiny enough to cost nothing here) live in core.
 */

/**
 * The neutral kebab-case names a `StopReason.kind` may take. The mapping from each provider's own
 * wire value (Anthropic's `stop_reason`, OpenAI's `status`/`incomplete_details.reason` pair,
 * Gemini's `finishReason`, …) into this vocabulary happens at that provider's own boundary module,
 * never here.
 */
export type StopReasonKind =
  | 'end-turn'
  | 'max-tokens'
  | 'stop-sequence'
  | 'tool-use'
  | 'pause-turn'
  | 'refusal'
  | 'context-window-exceeded'

export const STOP_REASON_KINDS: readonly StopReasonKind[] = [
  'end-turn',
  'max-tokens',
  'stop-sequence',
  'tool-use',
  'pause-turn',
  'refusal',
  'context-window-exceeded',
]

/**
 * A closed union over the known kinds, plus an 'other' escape hatch carrying the raw wire value
 * verbatim — never a throw, and never silently coerced into `end-turn` (an unrecognised reason is
 * NOT "the model finished normally"; that is the one misreading a caller might act on).
 */
export type StopReason =
  | { kind: Exclude<StopReasonKind, 'refusal'> }
  | {
      kind: 'refusal'
      /**
       * `stop_details.category` (R12 §1.8): an open enum incl. `cyber` / `bio` /
       * `reasoning_extraction` / `frontier_llm`. Absent when the provider did not state one.
       */
      category?: string
    }
  | {
      kind: 'other'
      /** the raw wire value, kept verbatim; `null` when it was absent or not a string */
      raw: string | null
    }

/**
 * Anthropic's `stop_reason` (+ sibling `stop_details`) → the neutral vocabulary. R12 §1.8: the
 * seven values map one-to-one onto `STOP_REASON_KINDS`.
 *
 * `pause_turn` is deliberately NOT mapped to `tool-use` — it means the server-tool loop hit its
 * default iteration cap and the call is resumable by re-sending the assistant's content as-is
 * (R12 §1.8), which is a different continuation story from an ordinary `tool_use` stop.
 *
 * `stopDetails` is read only for `stop_reason === 'refusal'` (R12 §1.8: `stop_details.category`
 * is populated only then, `null` otherwise) — never inspected on any other value.
 *
 * An unrecognised `stopReason`, or one that is not a string at all (`null`/`undefined`/non-string),
 * becomes `{ kind: 'other', raw }` — never a throw, and never `end-turn`.
 */
export function fromAnthropicStopReason(stopReason: unknown, stopDetails?: unknown): StopReason {
  if (typeof stopReason !== 'string') return { kind: 'other', raw: null }

  switch (stopReason) {
    case 'end_turn':
      return { kind: 'end-turn' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'stop_sequence':
      return { kind: 'stop-sequence' }
    case 'tool_use':
      return { kind: 'tool-use' }
    case 'pause_turn':
      return { kind: 'pause-turn' }
    case 'model_context_window_exceeded':
      return { kind: 'context-window-exceeded' }
    case 'refusal': {
      const category =
        typeof stopDetails === 'object' &&
        stopDetails !== null &&
        'category' in stopDetails &&
        typeof (stopDetails as { category?: unknown }).category === 'string'
          ? (stopDetails as { category: string }).category
          : undefined
      return category === undefined ? { kind: 'refusal' } : { kind: 'refusal', category }
    }
    default:
      return { kind: 'other', raw: stopReason }
  }
}

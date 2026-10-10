/**
 * replyCost.ts — PURE: what one reply of a session costs in TOKENS RESENT, and when to say so.
 *
 * Every reply re-sends the whole conversation (cache read or not), so the context size of the LAST
 * turn is the honest "cost per reply" in tokens: `context_tokens` is already input + cache read +
 * cache write of that turn. The average is the session's lifetime resent volume (input + cache
 * read + cache write) over its assistant messages — a mean over the whole session, because the
 * store keeps no per-turn history to take "the last N" from.
 *
 * Same rule as `sessionStats.ts`: a harness that cannot produce the measurement gives `null`,
 * never 0 (`HARNESS_CAPABILITIES.contextWindow` gates the last turn, `.tokens` the average).
 */
import { HARNESS_CAPABILITIES, type SurfaceHarnessId, type SessionMeta } from '@agentistics/core'

export const DEFAULT_REPLY_COST_THRESHOLD = 300_000

export interface ReplyCost {
  /** Context resent on the last turn. */
  lastTurn: number | null
  /** Mean resent per assistant message across the session. */
  average: number | null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function replyCost(harness: SurfaceHarnessId, meta: SessionMeta | undefined): ReplyCost {
  if (!meta) return { lastTurn: null, average: null }
  const caps = HARNESS_CAPABILITIES[harness]
  const last = num((meta as { context_tokens?: number }).context_tokens)
  const replies = num(meta.assistant_message_count)
  const resent = num(meta.input_tokens) + num(meta.cache_read_input_tokens) + num(meta.cache_creation_input_tokens)
  return {
    lastTurn: caps?.contextWindow && last > 0 ? last : null,
    average: caps?.tokens && replies > 0 && resent > 0 ? Math.round(resent / replies) : null,
  }
}

/** True when the last reply resent more than the threshold. A non-positive threshold disables it. */
export function replyCostExceeds(lastTurn: number | null, threshold: number): boolean {
  return lastTurn !== null && threshold > 0 && lastTurn > threshold
}

/**
 * nativeStats.ts — PURE: a NATIVE session's metrics card, from the engine's own usage (H6 runs), in
 * the very shape the composer's metrics card reads for every harness (`SessionStats`). A native
 * session has no store record (`SessionMeta`), so the card was absent; its numbers exist — the
 * engine measures them per run — and are read here instead of being re-derived.
 *
 * NEVER A CONFIDENT ZERO: a figure some run could not measure is `null` for the whole session (a
 * partial sum would understate it while looking complete), and the context gauge is the LATEST run's
 * last call, or nothing when its window is unknown (`contextGauge`).
 */
import type { HarnessId } from '@agentistics/core'
import type { SessionStats } from './sessionStats'
import { contextGauge, type RunLineView } from './nativeRuns'
import { NATIVE_HARNESS_ID } from './nativeSession'

export function nativeSessionStats(o: {
  sessionId: string
  runs: readonly RunLineView[]
  /** Who said what, from the chat — the card's message counts. */
  turns: readonly { role: 'user' | 'assistant'; text: string }[] | null
  /** The session's configured model, when no run has named one yet. */
  model?: string
}): SessionStats {
  const billed = o.runs.filter(r => r.responses > 0)
  const allTokens = billed.length > 0 && billed.every(r => r.tokens !== null)
  const tokens = allTokens
    ? billed.reduce((t, r) => ({
      input: t.input + r.tokens!.input,
      output: t.output + r.tokens!.output,
      cacheRead: t.cacheRead + r.tokens!.cacheRead,
      cacheWrite: t.cacheWrite + r.tokens!.cacheWrite,
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    : null
  const allPriced = billed.length > 0 && billed.every(r => r.costUSD !== null)
  const gauge = contextGauge(billed)
  const model = [...billed].reverse().find(r => r.model)?.model ?? o.model ?? null
  const said = (o.turns ?? []).filter(t => t.text.trim() !== '')
  return {
    sessionId: o.sessionId,
    harness: NATIVE_HARNESS_ID as HarnessId,
    tokens,
    conversation: tokens ? { input: tokens.input, output: tokens.output } : null,
    costUSD: allPriced ? billed.reduce((n, r) => n + r.costUSD!, 0) : null,
    context: gauge ? { fraction: gauge.fraction, used: gauge.tokens, window: gauge.window } : null,
    messages: o.turns === null ? null : {
      user: said.filter(t => t.role === 'user').length,
      assistant: said.filter(t => t.role === 'assistant').length,
    },
    subagents: null,
    git: null,
    activeMinutes: null,
    model,
  }
}

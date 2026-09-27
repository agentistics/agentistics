/**
 * integrations/kimi/replay-model.ts — PURE. One `model.completed` per `usage.record` line.
 *
 * ## THE TRAP (P2 §2, and kimi-parse.ts's own header)
 * The SAME usage appears twice in kimi's wire — once as a top-level `usage.record`, once again
 * inside the nested `context.append_loop_event -> event.type === 'step.end'`, byte-for-byte
 * identical (verified pairwise on real data by `kimi-parse.ts`'s `accumulateKimiWire`). Reading both
 * would double every counter. This module reads ONLY `usage.record`; `replay-tools.ts` reads
 * `context.append_loop_event` for `tool.call`/`tool.result` alone and never inspects `step.end`, so
 * the two folds cannot collide on this.
 *
 * Records are per-turn INCREMENTS here (unlike Codex, where the last cumulative wins), matching
 * `accumulateKimiWire`'s own arithmetic (`acc.inputTokens += ...` on every record) — so each line
 * becomes its own `model.completed` immediately. No held response, no cross-line state.
 *
 * `model.invoked` is deliberately NOT emitted: no projection reads it (`session-meta.ts` has no
 * `model.invoked` case, the same finding Claude's adapter recorded at 1.2.0), and kimi's
 * `usage.record` carries no provider request id worth stating twice.
 *
 * ## The provider prefix (kimi-parse.ts's second trap)
 * Kimi routes to other providers and stamps the routed model verbatim (`google/gemini-3.5-flash-
 * lite`), so the bare id the pricing table keys on is `stripProvider()` — imported, never
 * reimplemented, from `adapters/kimi-parse.ts` (a LOCAL model's prefix is KEPT; see that function's
 * own header).
 *
 * ## The context gauge (kimi-parse.ts's third trap) — reproduced by AGENT KIND, not a flag
 * Legacy tracks the gauge from the MAIN agent's usage only, latest by TIME. This replay emits
 * `contextTokens` on every agent's own `model.completed` — main's AND every subagent's — honestly:
 * each agent's own context size at that call. `projections/session-meta.ts`'s shared rollup already
 * restricts the SESSION-LEVEL gauge to `kind: 'main'` agents (`AgentAcc.gauge`, picked by the latest
 * ORDER KEY, which for one append-only file is the same order as time) — so tagging the main agent
 * `kind: 'main'` and every other agent `kind: 'subagent'` (`replay-agents.ts`) reproduces legacy's
 * "main only, latest by time" rule for free, with no per-harness flag needed.
 */
import { resolveProvider } from '@agentistics/core'
import { stripProvider } from '../../adapters/kimi-parse'
import type { ModelCompletedData } from '@agentistics/core'
import { lineRef, makeEvent, numOrUndef, str, timeOf, type EmitEvent, type KimiReplayContext } from './replay-core'

/** `entry.usage`, when `entry.type === 'usage.record'` — the ONE shape this module reads. */
function usageOf(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  if (entry.type !== 'usage.record') return undefined
  const u = entry.usage
  return u && typeof u === 'object' ? (u as Record<string, unknown>) : undefined
}

export function foldModelEntry(
  ctx: KimiReplayContext, entry: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  const u = usageOf(entry)
  if (!u) return

  // Legacy's own guard: `if (typeof d.model === 'string' && d.model) acc.model = stripProvider(...)`.
  // A `usage.record` with no model string is skipped entirely (same as legacy, which then leaves
  // `acc.model` untouched but still folds the tokens) — but a `model.completed` MUST name a model
  // (`ModelCompletedData.model` is required), so this replay skips the whole record rather than
  // inventing one. Measured: every real `usage.record` on this machine carries a model string.
  const rawModel = str(entry.model)
  if (!rawModel) return
  const model = stripProvider(rawModel)
  const provider = resolveProvider(model).id

  const usage: ModelCompletedData['usage'] = {}
  const input = numOrUndef(u.inputOther)
  const output = numOrUndef(u.output)
  const cacheRead = numOrUndef(u.inputCacheRead)
  const cacheWrite = numOrUndef(u.inputCacheCreation)
  if (input !== undefined) usage.input = input
  if (output !== undefined) usage.output = output
  if (cacheRead !== undefined) usage.cacheRead = cacheRead
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite

  const data: ModelCompletedData = { provider, model, usage, status: 'completed' }

  // The gauge: the INPUT SIDE of this one turn record — `usageScope: 'turn'` is what makes it a
  // gauge rather than a running total (kimi-parse.ts's own comment). Whole only when all three
  // input-side counters were reported (D17/D21: a value built over a missing term is a confident
  // undercount, never trusted) — matches legacy's `sent = num(inputOther)+num(inputCacheRead)+
  // num(inputCacheCreation)` exactly when all three are present, which is every real record measured.
  if (input !== undefined && cacheRead !== undefined && cacheWrite !== undefined) {
    const contextTokens = input + cacheRead + cacheWrite
    if (contextTokens > 0) data.contextTokens = contextTokens
  }

  const at = timeOf(entry)
  emit(makeEvent(ctx, 'model.completed', data, {
    sourceRef: lineRef(ctx, lineNo),
    occurredAt: at ?? ctx.recordedAt,
    confidence: at ? 'exact' : 'estimated',
  }))
}

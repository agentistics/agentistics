/**
 * integrations/kimi/replay.ts — PURE. One kimi agent's `wire.jsonl`, read as canonical
 * `model.completed`/`tool.*` events.
 *
 * No held state: `usage.record` lines are per-turn increments (never a running total, unlike
 * Codex's cumulative counter — `replay-model.ts`'s header) and a `tool.result` names its own
 * `toolCallId`, so nothing has to be remembered across lines (`replay-tools.ts`'s header). Folding
 * a wire file in one call or in N uneven chunks therefore emits the SAME events trivially — there is
 * no accumulator to diverge — which is the "chunk independence" property P1 §8 asks every replay
 * fold to have.
 *
 * Session/Run/Agent lifecycle facts (`replay-agents.ts`) come from `state.json`, not from these
 * lines, and are emitted separately by `index.ts` (the IO half) — this module folds ONE wire file's
 * own content and nothing else.
 *
 * ## Turn events — not yet, and why
 * Kimi's wire DOES carry harness-stated turn markers: `turn.prompt` (with `origin.kind === 'user'`,
 * or no `origin` at all — legacy's `accumulateKimiWire` counts both) opens a turn, and `turn.ended`
 * closes it with the harness's OWN `durationMs`. In principle D22/D25 would let this adapter emit
 * `turn.started`/`turn.ended` from them.
 *
 * It does not, in 1.0.0, because legacy's OWN active-time reconstruction for kimi
 * (`accumulateKimiWire`'s `turnEvents`, fed to `activeMinutesOf`) pushes a clock TICK for every
 * timestamped line of ANY kind — not only at a turn's open and close — which is a fundamentally
 * DENSER signal than the sparse start/end pair `projections/session-meta.ts`'s shared `turnTime()`
 * was built and measured against (Claude's own, already-sparse turn semantics). Wiring kimi's
 * markers into that shared function without first checking BOTH reconstructions agree numerically
 * on real data risks a SILENT wrong `active_minutes` — worse than the stated absence this version
 * ships instead. `user_message_count`/`rounds`/`user_interruptions`/`user_message_timestamps` are a
 * SEPARATE, safer case (they read only `turn.started`, never `turn.ended`) and are requested as a
 * shared change in this integration's handback rather than stubbed here, per the coordinator's
 * "do not stub" instruction.
 */
import { foldModelEntry } from './replay-model'
import { foldToolEntry } from './replay-tools'
import type { EmitEvent, KimiReplayContext } from './replay-core'

export function foldKimiWireEntry(
  ctx: KimiReplayContext, entry: Record<string, unknown>, lineNo: number, emit: EmitEvent,
): void {
  foldModelEntry(ctx, entry, lineNo, emit)
  foldToolEntry(ctx, entry, lineNo, emit)
}

/**
 * Advance over raw lines, counting from `startLineNo` (0 for a fresh file; the previously-consumed
 * line count when resuming an append — see `index.ts`). Blank lines and unparseable ones still
 * consume a line number, matching `foldClaudeReplay`'s own convention, so a line numbered off a
 * byte-range read agrees with the SAME line numbered off a whole-file read. Returns the new total.
 */
export function foldKimiWire(
  ctx: KimiReplayContext, text: string, emit: EmitEvent, startLineNo = 0,
): number {
  let lineNo = startLineNo
  for (const raw of text.split('\n')) {
    lineNo++
    const line = raw.trim()
    if (!line) continue
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    foldKimiWireEntry(ctx, entry as Record<string, unknown>, lineNo, emit)
  }
  return lineNo
}

/** The min/max `entry.time` (epoch ms) found in `text`, over EVERY line regardless of type — the
 *  fallback session bounds when `state.json` states neither `createdAt` nor `updatedAt`. Mirrors
 *  legacy's own `firstTimeMs`/`lastTimeMs` tracking in `accumulateKimiWire`. */
export function wireTimeRange(text: string): { minMs?: number; maxMs?: number } {
  let minMs: number | undefined
  let maxMs: number | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const t = (entry as Record<string, unknown>).time
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) continue
    if (minMs === undefined || t < minMs) minMs = t
    if (maxMs === undefined || t > maxMs) maxMs = t
  }
  return { minMs, maxMs }
}

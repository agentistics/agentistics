/**
 * sessions/session-source.ts — LIVE.2's merge rule (spec `2026-10-02-live-sessions-from-journal` §4, with
 * the owner's Q3 of 2026-10-02). PURE: the ONE place that decides, per conversation, where a session
 * surface's payload comes from. `chat-web.ts` (and the tail and the reopen list) call it and never
 * re-derive it.
 *
 * - **`legacy`** — today's path, byte for byte. Whenever the engine is absent, the `sessions` surface is
 *   not turned on, or the projection is not ready (store failed to open, or still rebuilding): the
 *   journal is not even asked. Also whenever the journal adds nothing.
 * - **`legacy+overlay`** — a PRESENT transcript is read exactly as before and may only gain the
 *   attention markers no transcript carries. The journal can lag the file (the tail ticks every 5 s), so
 *   a merge that let it override text would show a conversation older than the one on disk.
 * - **`metrics`** — the text is GONE (`expired` or `deleted`) and the journal knows the conversation:
 *   the surface adds NUMBERS (turns, tool counts, models, tokens, attention marks) and nothing else. No
 *   skeleton of turns, no tool summaries, no archive read (Q3: permanence of conversation content is a
 *   Cloud feature). `unreadable` is NOT gone — a failed read keeps its own sentence on the legacy path.
 *
 * Every row ends with a sentence or a conversation: no combination yields a blank pane (C3).
 */
import type { TranscriptAvailability } from '@agentistics/core'

export type SessionSource =
  | { from: 'legacy' }
  | { from: 'legacy+overlay'; overlay: 'attention' }
  | { from: 'metrics'; transcript: TranscriptAvailability }

export interface SessionSourceInput {
  /** `engineStatus().present`. */
  enginePresent: boolean
  /** `AGENTISTICS_PROJECTIONS` on AND `sessions` named in `AGENTISTICS_PROJECTIONS_SURFACES`. */
  surfaceFlag: boolean
  /** The store opened and is not rebuilding. */
  projectionReady: boolean
  /** The projection holds a row for THIS conversation. */
  projected: boolean
  /** Attention marks that row carries. */
  projectedAttention: number
  transcript: TranscriptAvailability
  /** The legacy reader returned the conversation (not a failed read). */
  legacyReadOk: boolean
}

export function planSessionSource(o: SessionSourceInput): SessionSource {
  if (!o.enginePresent || !o.surfaceFlag || !o.projectionReady) return { from: 'legacy' }
  switch (o.transcript.state) {
    case 'present':
      return o.legacyReadOk && o.projectedAttention > 0 ? { from: 'legacy+overlay', overlay: 'attention' } : { from: 'legacy' }
    case 'expired':
    case 'deleted':
      return o.projected ? { from: 'metrics', transcript: o.transcript } : { from: 'legacy' }
    case 'not-yet-written':
    case 'unreadable':
      return { from: 'legacy' }
  }
}

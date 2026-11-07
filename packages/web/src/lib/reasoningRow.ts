/**
 * reasoningRow.ts — PURE. The model's reasoning as ONE activity line, like the tool runs' ("Leu um arquivo · 1 passo · 15 s ⌄"):
 * `Raciocinando… · 12 s` while it streams, `Raciocinou · 12 s ⌄` once the answer (or anything else) came after it.
 *
 * It was a static, closed "Raciocínio" box INSIDE the answer bubble (owner prints 61a64dcb / 9aa79163, 2026-11-06): a turn that
 * reasoned for a minute looked like nothing was happening, and a finished one looked like a different kind of thing from the
 * activity lines around it. The line is the same shape, animated while it is live, and its time is MEASURED — a span nobody
 * observed is absent, never a confident "0 s".
 */
import { fmtSpan } from './toolActivity'

export interface ReasoningClock {
  /** Epoch ms the first reasoning text was seen for the turn in flight; null before any. */
  startedAt: number | null
  /** Epoch ms the reasoning stopped being the newest thing (the answer started, or the turn ended); null while it is. */
  endedAt: number | null
}

export const EMPTY_REASONING_CLOCK: ReasoningClock = { startedAt: null, endedAt: null }

/**
 * PURE. The clock after one more look at the live turn. Reasoning appearing starts it; the answer starting (or the turn no
 * longer working) stops it for good; no reasoning at all is a new turn and clears it.
 */
export function stepReasoningClock(prev: ReasoningClock, seen: { hasReasoning: boolean; answerStarted: boolean; working: boolean; now: number }): ReasoningClock {
  if (!seen.hasReasoning) return prev.startedAt === null && prev.endedAt === null ? prev : EMPTY_REASONING_CLOCK
  const startedAt = prev.startedAt ?? seen.now
  const over = seen.answerStarted || !seen.working
  const endedAt = prev.endedAt ?? (over ? seen.now : null)
  return startedAt === prev.startedAt && endedAt === prev.endedAt ? prev : { startedAt, endedAt }
}

/** PURE. Elapsed ms of the reasoning, or null when its start was never observed. While running it follows `now`. */
export function reasoningSpanMs(clock: ReasoningClock, now: number): number | null {
  if (clock.startedAt === null) return null
  return Math.max(0, (clock.endedAt ?? now) - clock.startedAt)
}

/** PURE. The line's words. */
export function reasoningLabel(running: boolean, spanMs: number | null, pt: boolean): string {
  const word = running ? (pt ? 'Raciocinando…' : 'Reasoning…') : (pt ? 'Raciocinou' : 'Reasoned')
  const span = fmtSpan(spanMs)
  return span ? `${word} · ${span}` : word
}

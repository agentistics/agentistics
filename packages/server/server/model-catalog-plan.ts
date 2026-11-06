/**
 * model-catalog-plan.ts — PURE: WHEN a harness's model list is read again.
 *
 * A list read from a COMMAND (`agy models`, `opencode models`) used to be kept for six hours
 * whatever the answer was — including "the command failed". On a macOS service the first read of
 * `opencode models` fails for reasons that have nothing to do with the CLI's models (a launchd PATH
 * without `/opt/homebrew/bin`, a server whose event loop was stalled past the 15 s timeout at boot),
 * so one bad minute at startup left the new-session picker with NO models until the next restart:
 * "Padrão (upx/fable-5.1)" and a text box. A failure is a fact about the MOMENT, not about the CLI,
 * so it expires fast (`RETRY_BACKOFF_MS`, growing) while a success keeps the full TTL.
 */

export const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000] as const

export interface PlanEntry {
  /** When the last read FINISHED. */
  at: number
  /** The last read produced a list. */
  ok: boolean
  /** Consecutive failed reads, 0 after a success. */
  failures: number
}

/** The wait before a failed source is asked again. Grows with each consecutive failure, then holds. */
export function retryDelayMs(failures: number): number {
  const i = Math.max(0, Math.min(failures - 1, RETRY_BACKOFF_MS.length - 1))
  return RETRY_BACKOFF_MS[i]!
}

/** Is the entry due for a new read? A cold harness is always due; a failure is due after its backoff, never after the TTL. */
export function catalogStale(entry: PlanEntry | undefined, ttlMs: number, now: number): boolean {
  if (!entry) return true
  const age = now - entry.at
  return age > (entry.ok ? ttlMs : Math.min(ttlMs, retryDelayMs(entry.failures)))
}

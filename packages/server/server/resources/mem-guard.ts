/**
 * resources/mem-guard.ts — PURE. The product's memory guard (MEM.GUARD, spec: leader/specs/mem-guard.md).
 *
 * Three decisions, none of which touch the machine: may a heavy job start now, is this process already
 * inside the machine-wide heavy lock, and when does the "memory is critical" notice fire. The IO lives
 * in the callers (`cli-run.ts`, `governor-daemon.ts`); an unmeasured machine (`null`) is never blocked.
 */

const GiB = 1024 * 1024 * 1024

/** Below this a spawn is refused outright (`force` only overrides loudly) and the bell rings once. */
export const HARD_FLOOR_BYTES = 2 * GiB

/** `agentop run --rm` waits for MemAvailable to reach this before it starts its command. */
export const RUN_MIN_AVAILABLE_BYTES = 3 * GiB

/** The alarm re-arms only after MemAvailable recovers to this — hysteresis, so a hover at 2 GB is one notice. */
export const ALARM_REARM_BYTES = 3 * GiB

/** The wait threshold, with the env override (`AGENTISTICS_RUN_MIN_AVAILABLE_MB`); nonsense is ignored. */
export function runMinAvailableBytes(env: Record<string, string | undefined> = process.env): number {
  const mb = Number(env.AGENTISTICS_RUN_MIN_AVAILABLE_MB)
  return Number.isFinite(mb) && mb >= 256 ? Math.round(mb * 1024 * 1024) : RUN_MIN_AVAILABLE_BYTES
}

/** How long `run --rm` waits for memory before giving up: 10 min, `AGENTISTICS_RUN_WAIT_MAX_SEC` overrides (0/nonsense = default). */
export function runWaitMaxMs(env: Record<string, string | undefined> = process.env): number {
  const sec = Number(env.AGENTISTICS_RUN_WAIT_MAX_SEC)
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 10 * 60 * 1000
}

export const WAIT_ANNOUNCE_EVERY_MS = 30_000

/** Print the "waiting for memory" line only when the rounded GB changed AND 30 s passed since the last one. */
export function shouldAnnounceWait(prev: { gb: string; at: number } | null, availableBytes: number, nowMs: number): boolean {
  if (!prev) return true
  return (availableBytes / GiB).toFixed(1) !== prev.gb && nowMs - prev.at >= WAIT_ANNOUNCE_EVERY_MS
}

/** Should a heavy job keep waiting? `null` = unmeasured (not Linux): never wait on what cannot be read. */
export function shouldWaitForMemory(availableBytes: number | null, minBytes = RUN_MIN_AVAILABLE_BYTES): boolean {
  return availableBytes !== null && availableBytes < minBytes
}

/**
 * Is this process already under the heavy lock? True with `AGENTISTICS_HEAVY_JOB` (set by `agentop
 * heavy`) or when an ancestor is a `flock … agentistics-heavy*.lock` (the manual form the briefs use).
 * Wrapping again would block on a lock this very tree holds — a deadlock, not a queue.
 */
export function insideHeavyLock(env: Record<string, string | undefined>, ancestorCmdlines: readonly string[]): boolean {
  if (env.AGENTISTICS_HEAVY_JOB) return true
  return ancestorCmdlines.some(c => /\bflock\b/.test(c) && /agentistics-heavy[^ ]*\.lock/.test(c))
}

/** Whether `agentop run --rm` puts its command through the heavy slot. */
export function shouldWrapHeavy(o: { hasCommand: boolean; linux: boolean; hasFlock: boolean; inside: boolean }): boolean {
  return o.hasCommand && o.linux && o.hasFlock && !o.inside
}

export interface MemAlarmState { raised: boolean }

/**
 * One governor tick of the critical-memory alarm. Raises when MemAvailable is under the hard floor
 * and it is not already raised; clears only at `ALARM_REARM_BYTES`. Between the two nothing changes.
 */
export function memoryAlarmStep(state: MemAlarmState, availableBytes: number | null): { state: MemAlarmState; raise: boolean } {
  if (availableBytes === null) return { state, raise: false }
  if (!state.raised && availableBytes < HARD_FLOOR_BYTES) return { state: { raised: true }, raise: true }
  if (state.raised && availableBytes >= ALARM_REARM_BYTES) return { state: { raised: false }, raise: false }
  return { state, raise: false }
}

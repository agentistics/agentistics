/** Cleanup policy only. IO, clocks and sleeping are supplied by the caller. */
import { S10, type Level } from '../resources/machine-health'

export const CLEAN_BATCH_ENTRIES = 2_000
export const CLEAN_BATCH_PAUSE_MS = 250
export const CLEAN_POLL_MS = 1_000
export const CLEAN_INTERVAL_MS = 120_000
export const CLEAN_HOUR_MS = 3_600_000
export const CLEAN_HOURLY_LIMIT = 6
export const CLEAN_LOCK = '/tmp/agentistics-cleanup.lock'

export interface CleanHealth { level: Level; dirtyWriteback: number | null }
export interface PaceDecision { waitMs: number; draining: boolean; reason?: string }

/** Tight or worse pauses before any more writes; recovery needs no manual resume. */
export function batchPace(health: CleanHealth, draining = false): PaceDecision {
  const backlog = health.dirtyWriteback
  const drain = backlog !== null && (draining ? backlog >= S10.exit : backlog > S10.tight)
  if (health.level !== 'ok') return { waitMs: CLEAN_POLL_MS, draining: drain, reason: `machine is ${health.level}` }
  if (drain) return { waitMs: CLEAN_POLL_MS, draining: true, reason: 'waiting for dirty/writeback to drain below 512 MiB' }
  return { waitMs: 0, draining: false }
}

/** Reservation times are shared under the machine-wide lock, including across CLI invocations. */
export function removalWait(now: number, starts: readonly number[]): number {
  const recent = starts.filter(t => t > now - CLEAN_HOUR_MS).sort((a, b) => a - b)
  const interval = starts.length ? Math.max(...starts) + CLEAN_INTERVAL_MS - now : 0
  const hourly = recent.length >= CLEAN_HOURLY_LIMIT ? recent[recent.length - CLEAN_HOURLY_LIMIT]! + CLEAN_HOUR_MS - now : 0
  return Math.max(0, interval, hourly)
}

export interface PaceIo {
  health: () => Promise<CleanHealth>
  sleep: (ms: number) => Promise<void>
  onPause?: (reason: string) => void
}

export async function waitForCleanHealth(io: PaceIo): Promise<void> {
  let draining = false
  for (;;) {
    const next = batchPace(await io.health(), draining)
    draining = next.draining
    if (!next.waitMs) return
    io.onPause?.(next.reason!)
    await io.sleep(next.waitMs)
  }
}

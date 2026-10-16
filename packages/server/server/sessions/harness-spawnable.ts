import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { SPAWN_SPECS } from './spawn-spec'
import type { SpawnOutcome } from './spawn-outcome'
import { userSearchPath } from './user-path'

export interface HarnessSpawnability {
  spawnable: boolean
  unavailableReason?: string
}

export const STARTUP_FAILURE_TTL_MS = 30 * 60_000
const outcomes = new Map<HarnessId, { startedAt: number; checkedAt: number; failed: boolean }>()

/** Fresh starts only: a refused resume says nothing about whether a new worker can start. */
export function noteFreshSpawn(harness: HarnessId, outcome: SpawnOutcome | undefined, startedAt: number, now = Date.now()): void {
  const last = outcomes.get(harness)
  if (last && now - last.checkedAt < STARTUP_FAILURE_TTL_MS && last.startedAt > startedAt) return
  outcomes.set(harness, { startedAt, checkedAt: now, failed: outcome?.died === true && outcome.status !== 0 })
}

export function harnessSpawnability(
  harness: HarnessId,
  now = Date.now(),
  which: (bin: string) => string | null = bin => Bun.which(bin, { PATH: userSearchPath() }),
): HarnessSpawnability {
  const spec = SPAWN_SPECS[harness]
  if (!spec) return { spawnable: false, unavailableReason: `${harness} has no session launcher` }
  if (!which(spec.bin)) return { spawnable: false, unavailableReason: `${spec.bin} is not on PATH: install ${harness}` }
  const last = outcomes.get(harness)
  if (last?.failed && now - last.checkedAt < STARTUP_FAILURE_TTL_MS) {
    return { spawnable: false, unavailableReason: `${harness} failed to start: check startup arguments or update ${harness}` }
  }
  return { spawnable: true }
}

export function harnessSpawnabilities(now = Date.now()): Partial<Record<HarnessId, HarnessSpawnability>> {
  return Object.fromEntries(HARNESS_ORDER.map(h => [h, harnessSpawnability(h, now)]))
}

/** Tests only; startup health is deliberately held in server memory. */
export function resetHarnessSpawnability(): void { outcomes.clear() }

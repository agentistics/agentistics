import type { HarnessId } from '@agentistics/core'
import { askVault, type AskOptions } from '../vault/socket'
import type { SpawnOutcome } from './spawn-outcome'

/** Report through the existing OS-account-authenticated service socket; startup needs no vault key. */
export async function reportFreshSpawn(
  harness: HarnessId,
  outcome: SpawnOutcome | undefined,
  startedAt: number,
  options: AskOptions = {},
): Promise<void> {
  try {
    await askVault({
      op: 'fresh-spawn', harness, startedAt,
      died: outcome?.died === true,
      ...(outcome?.status !== undefined ? { status: outcome.status } : {}),
    }, { timeoutMs: 1500, ...options })
  } catch { /* An unavailable service must not fail the CLI command. */ }
}

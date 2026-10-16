import { spawnDeath } from '../spawn-check'
import { reportFreshSpawn } from '../spawn-report'
import type { HarnessId } from '@agentistics/core'
import type { SpawnOutcome } from '../spawn-outcome'

const [path, result] = process.argv.slice(2)
await spawnDeath({ capture: async () => {
  if (result === 'unknown') throw new Error('capture unavailable')
  return result === 'failure' ? ['Pane is dead (status 2)'] : []
} }, 'cli-fresh', 1, 'codex', (harness: HarnessId, outcome: SpawnOutcome | undefined, startedAt: number) => reportFreshSpawn(harness, outcome, startedAt, { path }))

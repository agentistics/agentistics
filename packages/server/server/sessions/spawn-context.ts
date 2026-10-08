/**
 * spawn-context.ts — the IO half of the agentistics context (`agentistics-context.ts` is the pure
 * one): builds the `SpawnRequest.context` for a session id and writes the instructions file an
 * `env-dir` harness reads. Best effort by design: a context that cannot be written costs the
 * session its orientation, never its start.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { contextBlock, contextText, type ContextInput } from './agentistics-context'
import type { SpawnPlan, SpawnRequest } from './types'

export function buildSpawnContext(i: ContextInput): NonNullable<SpawnRequest['context']> {
  return { text: contextText(i), block: contextBlock(i), dir: join(AGENTISTICS_DATA_DIR, 'session-context', i.sessionId) }
}

/** Write the file `planSpawn` asked for. Resolves to false (and the session still starts) on failure. */
export async function writeContextFile(plan: SpawnPlan): Promise<boolean> {
  if (!plan.contextFile) return true
  try {
    await mkdir(plan.contextFile.dir, { recursive: true, mode: 0o700 })
    await writeFile(join(plan.contextFile.dir, plan.contextFile.name), plan.contextFile.text + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

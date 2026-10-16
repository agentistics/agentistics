import { spawnDeath } from '../spawn-check'
import { reportFreshSpawn } from '../spawn-report'
import type { HarnessId } from '@agentistics/core'
import type { SpawnOutcome } from '../spawn-outcome'

const [path, result] = process.argv.slice(2)
if (result === 'production-failure' || result === 'production-success') {
  const { start } = await import('../cli-session')
  const { parseSessionArgs } = await import('../cli-parse')
  const cmd = parseSessionArgs(['codex', '--bg', '--force', '--cwd', process.cwd(), '-p', 'test'])
  if (cmd.kind !== 'start') throw new Error('expected start command')
  const failed = result === 'production-failure'
  console.log = () => {}
  console.error = () => {}
  const code = await start(cmd, {
    id: 'tmux', unavailable: async () => undefined, spawn: async () => {}, list: async () => [],
    capture: async () => failed ? ['Pane is dead (status 2)'] : [], kill: async () => {},
  } as unknown as import('../types').SessionBackend)
  if (code !== (failed ? 1 : 0)) throw new Error(`unexpected CLI exit: ${code}`)
} else await spawnDeath({ capture: async () => {
  if (result === 'unknown') throw new Error('capture unavailable')
  return result === 'failure' ? ['Pane is dead (status 2)'] : []
} }, 'cli-fresh', 1, 'codex', (harness: HarnessId, outcome: SpawnOutcome | undefined, startedAt: number) => reportFreshSpawn(harness, outcome, startedAt, { path }))

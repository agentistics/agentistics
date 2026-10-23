/** Apply spawn filing/preferences once per door, retrying only incomplete, idempotent steps. */
import type { ManagedSession } from './types'

export interface SpawnConfiguration {
  ready: boolean
  applied: string[]
  pending: Array<{ item: string; reason: string }>
}

export async function applySpawnConfiguration(
  steps: Array<{ item: string; apply: () => Promise<boolean | void> }>,
): Promise<SpawnConfiguration> {
  const applied: string[] = []
  let pending: SpawnConfiguration['pending'] = []
  let remaining = steps
  for (let attempt = 0; attempt < 2 && remaining.length; attempt++) {
    pending = []
    const retry: typeof steps = []
    for (const step of remaining) {
      try {
        if (await step.apply() === false) throw new Error('The operation was refused')
        applied.push(step.item)
      } catch (error) {
        pending.push({ item: step.item, reason: error instanceof Error ? error.message : String(error) })
        retry.push(step)
      }
    }
    remaining = retry
  }
  return { ready: pending.length === 0, applied, pending }
}

export async function configureSpawn(
  plan: { taskId?: string | undefined; subtaskId?: string | undefined; folderId?: string | undefined },
  child: { id: string; conversationId?: string | undefined },
  predecessor?: ManagedSession,
): Promise<SpawnConfiguration> {
  const { readRegistry } = await import('./registry')
  const current = (await readRegistry()).find(r => r.id === child.id) ?? child
  const steps: Parameters<typeof applySpawnConfiguration>[0] = []
  if (plan.taskId) steps.push({ item: 'filing', apply: async () => {
    const { attachAfterSpawn } = await import('./spawn-filing-io')
    const result = await attachAfterSpawn(plan, child.id)
    if (!result.ok) throw new Error(result.reason)
  } })
  if (plan.folderId) steps.push({ item: 'folder', apply: async () => {
    const { fileInFolder } = await import('./cli-folder')
    return fileInFolder(plan.folderId!, current)
  } })
  if (predecessor) steps.push({ item: 'handoff-preferences', apply: async () => {
    const { inheritHandoffPrefs } = await import('./handoff-inherit')
    const { updatePreferences } = await import('../preferences')
    // No change is a successful idempotent application; write failures throw.
    await inheritHandoffPrefs(predecessor, current, updatePreferences, plan.folderId)
    if (predecessor.note && !('note' in current && current.note)) {
      const { patchSession } = await import('./registry')
      if (!await patchSession(child.id, { note: predecessor.note })) throw new Error('Session disappeared while inheriting its note')
    }
  } })
  const result = await applySpawnConfiguration(steps)
  const { patchSession } = await import('./registry')
  await patchSession(child.id, { spawnConfiguration: result })
  return result
}

export const configurationPendingMessage = (id: string, result: SpawnConfiguration): string =>
  `Session ${id} is running with configuration pending: ${result.pending.map(p => `${p.item}: ${p.reason}`).join('; ')}. Do not spawn a duplicate; repair this session.`

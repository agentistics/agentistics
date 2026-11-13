/** Evidence-protected deletes. Caller holds tasks; keep deliveries and guards through index AND byte removal. */
import { createDeliveryStore, defaultDeliveriesPath } from './store'
import { createGuardsStore, defaultGuardsPath } from './guards-store'
import { defaultGuardLockPaths, withGuardLocks } from './guard-locks'
import { GuardBusy } from './guard-locks'

export class EvidenceInUse extends Error {
  readonly code = 'evidence_in_use'
  readonly status = 409
  constructor() { super('this file backs a checkpoint or pending authorization, or the evidence index cannot be read; it cannot be deleted') }
}

/** Shared HTTP result for aggregate and individual deletes (MCP uses these same REST doors). */
export async function evidenceDeleteRequest(remove: () => Promise<boolean>) {
  try { return { status: 200, body: { ok: await remove() } } }
  catch (error) {
    if (error instanceof EvidenceInUse || error instanceof GuardBusy) return {
      status: error.status, body: { ok: false, error: error.code, sentence: error.message },
    }
    throw error
  }
}

export async function withEvidenceDeletion<T>(
  selection: { taskId?: string; fileId?: string }, remove: () => Promise<T>,
  paths = { ...defaultGuardLockPaths(), deliveries: defaultDeliveriesPath(), guards: defaultGuardsPath() },
): Promise<T> {
  return withGuardLocks(['deliveries', 'guards'], async () => {
    try {
      const book = await createDeliveryStore(paths.deliveries).readStrict()
      // A downgraded/unknown record may carry references this binary cannot interpret.
      if (Object.keys(book.preserved ?? {}).length) throw new EvidenceInUse()
      const items = Object.values(book.deliveries).flatMap(r =>
        (!selection.taskId || r.taskId === selection.taskId) ? (r.evidence ?? []).filter(i =>
          !!i.fileId && (!selection.fileId || i.fileId === selection.fileId)) : [])
      if (items.length) {
        const guards = await createGuardsStore(paths.guards).read()
        const ids = new Set(items.map(i => i.id))
        for (const cp of [...Object.values(guards.checkpoints), ...Object.values(guards.intents).map(i => i.target)]) {
          if (cp.auth.some(a => a.kind === 'evidence' && a.ids.some(id => ids.has(id)))) throw new EvidenceInUse()
        }
      }
    } catch (error) {
      if (error instanceof EvidenceInUse) throw error
      throw new EvidenceInUse()
    }
    return remove()
  }, { paths, alreadyHeld: ['tasks'] })
}

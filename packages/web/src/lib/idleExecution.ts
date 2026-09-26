/**
 * Executing a confirmed idle review. Each session runs its own sequence and stops at ITS first
 * failure; the others continue. The effects are injected so the order and the stop rule are tested
 * without a server. A session is re-checked first: the user may have messaged it since the modal
 * opened, and ending it then would end live work.
 */
import type { GroupSuggestion } from '@agentistics/core'

export type IdleAction = 'file-end' | 'end' | 'keep'

export interface IdlePlanItem { id: string; key: string; title: string; action: IdleAction; group: GroupSuggestion }

export type IdleOutcome = { id: string; title: string; result: 'ended' | 'kept' | 'skipped' | 'failed'; message?: string }

export interface IdleEffects {
  stillIdle(id: string): Promise<boolean>
  /** Returns the group id to file into (creating it when `kind: 'new'` or when it vanished), or null. */
  ensureGroup(g: GroupSuggestion): string | null
  fileInto(groupId: string, key: string): void
  end(id: string): Promise<{ ok: boolean; message: string }>
  keep(keys: string[]): void
}

export async function runIdlePlan(items: IdlePlanItem[], fx: IdleEffects): Promise<IdleOutcome[]> {
  const out: IdleOutcome[] = []
  const keep = items.filter(i => i.action === 'keep')
  for (const it of items) {
    if (it.action === 'keep') continue
    if (!(await fx.stillIdle(it.id))) { out.push({ id: it.id, title: it.title, result: 'skipped' }); continue }
    if (it.action === 'file-end') {
      const gid = fx.ensureGroup(it.group)
      if (!gid) { out.push({ id: it.id, title: it.title, result: 'failed', message: 'group' }); continue }
      fx.fileInto(gid, it.key)
    }
    const r = await fx.end(it.id)
    out.push(r.ok
      ? { id: it.id, title: it.title, result: 'ended' }
      : { id: it.id, title: it.title, result: 'failed', message: r.message })
  }
  if (keep.length > 0) {
    fx.keep(keep.map(k => k.key))
    for (const k of keep) out.push({ id: k.id, title: k.title, result: 'kept' })
  }
  // Report in the order the user saw.
  const order = new Map(items.map((it, i) => [it.id, i]))
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

export function bannerVisible(a: { candidates: number; modalOpen: boolean; snoozedUntil: number | null; now: number }): boolean {
  if (a.candidates === 0 || a.modalOpen) return false
  return a.snoozedUntil === null || a.now >= a.snoozedUntil
}

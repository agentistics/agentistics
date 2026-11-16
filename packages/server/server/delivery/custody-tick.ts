/**
 * delivery/custody-tick.ts — the minute tick's custody step (ENTREGA.GARANTIDA §5, S7a). The decision is `custody.ts` (pure);
 * this module reads the facts, persists the patches ONCE and tells each custodian.
 *
 *   rule C `off`     nothing at all: no read, no write, no message, no stamp (a machine that never turned it on is byte-identical).
 *   rule C `shadow`  the plan is computed and REPORTED (`custody would-…`); nothing is written and nobody is messaged.
 *   rule C `on`      one write to deliveries.json for the whole tick, then ONE message per custodian (an assignment that did not
 *                    reach its custodian is retried on the next tick, never marked delivered).
 *
 * A fleet that could not be read changes NOTHING: no absence clock advances or clears (§5.4.11).
 *
 * Everything with a side effect is injected by the service, which already holds the stores; this module imports no store, lock
 * or file module of its own except the read-only rule reader below.
 */
import { applyCustodyPatch, assignmentText, orphanMsOf, planCustody, type CustodyPatch, type CustodyPiece, type CustodySession } from './custody'
import type { DeliveryRecord } from './machine'

export type CustodyRule = 'off' | 'shadow' | 'on'

export interface CustodyDeps {
  rule(): Promise<CustodyRule>
  store: {
    read(): Promise<{ deliveries: Record<string, DeliveryRecord> }>
    update(fn: (doc: { deliveries: Record<string, DeliveryRecord> }) => void, opts: { guard: unknown }): Promise<unknown>
  }
  /** `null` = the fleet could not be read (never "nobody"). */
  sessions(): Promise<readonly CustodySession[] | null>
  /** The project of each piece (`taskId` + `subtaskId`), `''` when it cannot be established. */
  projectsOf(pieces: ReadonlyArray<{ taskId: string; subtaskId: string }>): Promise<ReadonlyMap<string, string>>
  /** `preferences.delivery.orphanAfterHours` as stored (validated by `orphanMsOf`). */
  orphanAfterHours(): Promise<unknown>
  notify(sessionId: string, text: string): Promise<boolean>
  titles?(keys: readonly string[]): Promise<ReadonlyMap<string, string>>
  /** The flow engine's context (every delivery write says who is asking). */
  guard: unknown
  now(): number
  log?(line: string): void
}

/** PURE. When the piece entered its current stage: the last history entry INTO it, else the record's creation. */
export function stageSinceOf(r: Pick<DeliveryRecord, 'phase' | 'history' | 'createdAt'>): string {
  for (let i = r.history.length - 1; i >= 0; i--) if (r.history[i]!.to === r.phase) return r.history[i]!.at
  return r.createdAt
}

export async function custodyTick(d: CustodyDeps, actions: string[]): Promise<void> {
  const rule = await d.rule()
  if (rule === 'off') return
  const fleet = await d.sessions()
  if (!fleet) { actions.push('custody-skipped: the fleet could not be read'); return }
  const records = Object.values((await d.store.read()).deliveries)
  const projects = await d.projectsOf(records.map(r => ({ taskId: r.taskId, subtaskId: r.subtaskId })))
  const pieces: CustodyPiece[] = records.map(r => ({
    key: r.subtaskId, taskId: r.taskId, phase: r.phase, project: projects.get(r.subtaskId) ?? '', stageSince: stageSinceOf(r),
    ...(r.leaderSessionId ? { leaderSessionId: r.leaderSessionId } : {}),
    ...(r.leaderActivityAt ? { leaderActivityAt: r.leaderActivityAt } : {}), ...(r.leaderActivityBy ? { leaderActivityBy: r.leaderActivityBy } : {}),
    ...(r.leaderAbsentSince !== undefined ? { leaderAbsentSince: r.leaderAbsentSince } : {}),
    ...(r.custody ? { custody: r.custody } : {}), ...(r.custodyLog ? { custodyLog: r.custodyLog } : {}),
  }))
  const now = d.now()
  const plan = planCustody({ now, orphanMs: orphanMsOf(await d.orphanAfterHours()), pieces, sessions: fleet })
  if (rule === 'shadow') {
    for (const a of plan.actions) actions.push(`custody would-${a.replace(/^custody-/, '')}`)
    return
  }
  if (plan.patches.length > 0) {
    const at = new Date(now).toISOString()
    await d.store.update(doc => {
      for (const p of plan.patches) {
        const cur = doc.deliveries[p.key]
        if (cur) doc.deliveries[p.key] = applyCustodyPatch(cur, p, at)
      }
    }, { guard: d.guard })
    for (const a of plan.actions) actions.push(a)
  }
  // ONE message per custodian per tick, however many pieces; a message that did not arrive is retried by the next tick.
  const delivered: Array<CustodyPatch & { to: string }> = []
  for (const a of plan.assignments) {
    const titles = (await d.titles?.(a.keys).catch(() => undefined)) ?? new Map<string, string>()
    const sent = await d.notify(a.sessionId, assignmentText(a, titles)).catch(() => false)
    actions.push(`${sent ? 'custody-message' : 'custody-message-failed'} ${a.sessionId}: ${a.keys.join(',')}`)
    if (sent) for (const key of a.keys) delivered.push({ key, notified: true, to: a.sessionId })
  }
  if (delivered.length > 0) {
    const at = new Date(d.now()).toISOString()
    await d.store.update(doc => {
      for (const p of delivered) {
        const cur = doc.deliveries[p.key]
        // Only the custody the message was about: a custody that moved on meanwhile is not marked.
        if (cur?.custody?.sessionId === p.to) doc.deliveries[p.key] = applyCustodyPatch(cur, p, at)
      }
    }, { guard: d.guard })
  }
}

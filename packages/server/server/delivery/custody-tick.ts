/**
 * delivery/custody-tick.ts — the minute tick's custody step (ENTREGA.GARANTIDA §5, S7a). The decision is `custody.ts` (pure);
 * this module reads the facts, decides and persists the patches INSIDE the shared envelope and tells each custodian.
 *
 *   rule C `off`     nothing at all: no read, no write, no message, no stamp (a machine that never turned it on is byte-identical).
 *   rule C `shadow`  the plan is computed and REPORTED (`custody would-…`); nothing is written and nobody is messaged.
 *   rule C `on`      under the fail-closed envelope (tasks → deliveries → guards, rule A or not): read, decide, recompute inside the
 *                    write itself, apply ONCE; then ONE message per custodian for the assignments that were actually committed (one
 *                    that did not reach its custodian is retried on the next tick, never marked delivered). A busy envelope SKIPS
 *                    the tick — it never writes after a timeout while the lock is held (§2.6.1).
 *
 * A fleet that could not be read changes NOTHING: no absence clock advances or clears (§5.4.11).
 *
 * Everything with a side effect is injected by the service, which already holds the stores; this module imports no store, lock
 * or file module of its own.
 */
import { applyCustodyPatch, assignmentText, boardActivityOf, orphanMsOf, planCustody, type BoardActivityFacts, type CustodyPiece, type CustodyPlan, type CustodySession } from './custody'
import type { DeliveryRecord } from './machine'

export type CustodyRule = 'off' | 'shadow' | 'on'

export interface CustodyDeps {
  rule(): Promise<CustodyRule>
  store: {
    read(): Promise<{ deliveries: Record<string, DeliveryRecord> }>
    update(fn: (doc: { deliveries: Record<string, DeliveryRecord> }) => void, opts: { guard: unknown }): Promise<unknown>
  }
  /** Runs `fn` under the full envelope (tasks → deliveries → guards, fail closed — a busy file throws `guard_busy`, it never proceeds). */
  envelope<T>(fn: () => Promise<T>): Promise<T>
  /** The board's activity facts (verified decision/block comments); read under the envelope. Absent = no board source. */
  board?(): Promise<BoardActivityFacts>
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

/**
 * PURE. The plan of ONE set of facts: the records exactly as they are NOW, the projects resolved for them, the board's activity
 * and the fleet. Pieces whose project was never resolved (born after the projects were asked) are left for the next tick.
 */
export function planOf(o: { now: number; orphanMs: number; records: readonly DeliveryRecord[]; projects: ReadonlyMap<string, string>; board: BoardActivityFacts | null; fleet: readonly CustodySession[] }): CustodyPlan {
  const pieces: CustodyPiece[] = []
  for (const r of o.records) {
    if (!o.projects.has(r.subtaskId)) continue
    // The board's own activity (a verified decision/block thread comment) competes with the record's stamp: the LATEST wins — but only
    // among ELIGIBLE actors (N2): the filed leader, the current custodian or a live leader of the task. A worker's block, or a
    // stamp left by a custodian that lost the piece, never masks (or anchors) the absence of the piece's own leader.
    const eligible = (by: string): boolean => by === r.leaderSessionId || by === r.custody?.sessionId || o.fleet.some(s => s.id === by && s.alive && s.role === 'leader' && s.taskId === r.taskId)
    const b = o.board ? boardActivityOf({ key: r.subtaskId, taskId: r.taskId }, o.board, eligible) : null
    const own = r.leaderActivityAt && r.leaderActivityBy && eligible(r.leaderActivityBy) ? r : null
    const useBoard = !!b && (!own || Date.parse(b.at) > Date.parse(own.leaderActivityAt!))
    const at = useBoard ? b!.at : own?.leaderActivityAt
    const by = useBoard ? b!.by : own?.leaderActivityBy
    pieces.push({
      key: r.subtaskId, taskId: r.taskId, phase: r.phase, project: o.projects.get(r.subtaskId) ?? '', stageSince: stageSinceOf(r),
      ...(r.leaderSessionId ? { leaderSessionId: r.leaderSessionId } : {}),
      ...(at ? { leaderActivityAt: at } : {}), ...(by ? { leaderActivityBy: by } : {}),
      ...(r.leaderAbsentSince !== undefined ? { leaderAbsentSince: r.leaderAbsentSince } : {}),
      ...(r.custody ? { custody: r.custody } : {}), ...(r.custodyLog ? { custodyLog: r.custodyLog } : {}),
    })
  }
  return planCustody({ now: o.now, orphanMs: o.orphanMs, pieces, sessions: o.fleet })
}

/** A busy envelope SKIPS the tick (§2.6.1): nothing is decided or written without the locks. */
const isBusy = (e: unknown): boolean => (e as { code?: string } | null)?.code === 'guard_busy'

export async function custodyTick(d: CustodyDeps, actions: string[]): Promise<void> {
  const rule = await d.rule()
  if (rule === 'off') return
  const fleet = await d.sessions()
  if (!fleet) { actions.push('custody-skipped: the fleet could not be read'); return }
  const orphanMs = orphanMsOf(await d.orphanAfterHours())

  if (rule === 'shadow') {
    const records = Object.values((await d.store.read()).deliveries)
    const projects = await d.projectsOf(records.map(r => ({ taskId: r.taskId, subtaskId: r.subtaskId })))
    const plan = planOf({ now: d.now(), orphanMs, records, projects, board: (await d.board?.().catch(() => null)) ?? null, fleet })
    for (const a of plan.actions) actions.push(`custody would-${a.replace(/^custody-/, '')}`)
    return
  }

  // Rule C `on` (F1/F2): the facts are read, the decision is made and the patches are applied INSIDE the shared envelope. The
  // decision is made over the documents as they are under the locks, and recomputed once more inside the write itself, so a
  // leader's action that landed in between always wins.
  let committed: CustodyPlan
  try {
    committed = await d.envelope(async () => {
      const records = Object.values((await d.store.read()).deliveries)
      const projects = await d.projectsOf(records.map(r => ({ taskId: r.taskId, subtaskId: r.subtaskId })))
      const board = (await d.board?.().catch(() => null)) ?? null
      const at = new Date(d.now()).toISOString()
      // The facts above took time (the project and board reads): judge the documents as they are NOW, not as they were first read.
      const fresh = Object.values((await d.store.read()).deliveries)
      const first = planOf({ now: d.now(), orphanMs, records: fresh, projects, board, fleet })
      if (first.patches.length === 0) return first
      let final: CustodyPlan = first
      await d.store.update(doc => {
        final = planOf({ now: d.now(), orphanMs, records: Object.values(doc.deliveries), projects, board, fleet })
        for (const p of final.patches) {
          const cur = doc.deliveries[p.key]
          if (cur) doc.deliveries[p.key] = applyCustodyPatch(cur, p, at)
        }
      }, { guard: d.guard })
      return final
    })
  } catch (e) {
    if (isBusy(e)) { actions.push('custody-skipped: another agentop process holds the board (guard_busy)'); return }
    throw e
  }
  for (const a of committed.actions) actions.push(a)

  // Only assignments that were actually COMMITTED are announced (an assignment the recompute dropped never reaches anybody).
  const delivered: Array<{ key: string; to: string }> = []
  for (const a of committed.assignments) {
    const titles = (await d.titles?.(a.keys).catch(() => undefined)) ?? new Map<string, string>()
    const sent = await d.notify(a.sessionId, assignmentText(a, titles)).catch(() => false)
    actions.push(`${sent ? 'custody-message' : 'custody-message-failed'} ${a.sessionId}: ${a.keys.join(',')}`)
    if (sent) for (const key of a.keys) delivered.push({ key, to: a.sessionId })
  }
  if (delivered.length > 0) {
    try {
      await d.envelope(async () => {
        const at = new Date(d.now()).toISOString()
        await d.store.update(doc => {
          for (const p of delivered) {
            const cur = doc.deliveries[p.key]
            if (cur?.custody?.sessionId === p.to) doc.deliveries[p.key] = applyCustodyPatch(cur, { key: p.key, notified: true }, at)
          }
        }, { guard: d.guard })
      })
    } catch (e) {
      // Busy: the delivery mark is retried by the next tick (at-least-once; a duplicate message is the price, never a lost one).
      if (isBusy(e)) actions.push('custody-skipped: the delivery mark waits for the next tick (guard_busy)')
      else throw e
    }
  }
}

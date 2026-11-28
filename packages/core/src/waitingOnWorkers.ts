/**
 * waitingOnWorkers.ts — PURE: is a finished turn the OWNER's to answer, or is the session waiting on
 * the workers it started?
 *
 * A leader that puts workers to work and ends its turn reads as `waiting`, and `waiting` meant "needs
 * you" everywhere — but there is nothing to answer: it is waiting for its workers. The state stays
 * `waiting`; the row additionally says HOW MANY of its direct children are busy
 * (`waitingOnWorkers`), computed once by the server from the same team link the aside draws
 * (`parentSessionId` / `parentConversationId`), and every counter, bell and notice asks `needsOwner`
 * / `ownerState` below instead of testing the state itself. A dialog (`waiting-approval`) always
 * wins: the workers cannot answer it.
 */

export interface TeamStateRow {
  id: string
  conversationId?: string | undefined
  parentSessionId?: string | undefined
  parentConversationId?: string | undefined
  /** Alive and doing something now: working, or running / queued for a command or background task. */
  busy: boolean
  /**
   * Alive with its own turn over (`waiting`, no dialog): such a row is itself waiting on ITS workers
   * when one of them is busy, and then counts as busy for its own parent — a sub-leader waiting on
   * its workers is work in flight for the leader above it.
   */
  canWait?: boolean | undefined
}

/**
 * Row id -> number of busy DIRECT children. A row with none has no entry.
 *
 * "Busy" is TRANSITIVE: a child that is itself waiting on busy workers (`canWait` + a busy child of
 * its own) counts as busy for its parent, however deep the chain. The figure is still the number of
 * DIRECT children, which is what "waiting on N workers" names. Computed as the least fixed point
 * (start from `busy`, add a `canWait` row once one of its children is busy, repeat until nothing
 * changes), so a cycle in the team links can never make a row busy on its own: nothing in a cycle of
 * idle rows is ever added.
 */
export function busyChildCounts(rows: readonly TeamStateRow[]): Map<string, number> {
  const byKey = new Map<string, string[]>()
  for (const r of rows) {
    for (const key of r.conversationId && r.conversationId !== r.id ? [r.id, r.conversationId] : [r.id]) {
      byKey.set(key, [...(byKey.get(key) ?? []), r.id])
    }
  }
  const parentsOf = new Map<string, Set<string>>()
  for (const child of rows) {
    const parents = new Set([child.parentConversationId, child.parentSessionId].flatMap(k => k ? byKey.get(k) ?? [] : []))
    parents.delete(child.id)
    parentsOf.set(child.id, parents)
  }
  const canWait = new Set(rows.filter(r => r.canWait).map(r => r.id))
  const busy = new Set(rows.filter(r => r.busy).map(r => r.id))
  // Each pass adds at least one row or stops, so it ends after at most rows.length passes.
  for (let grew = true; grew;) {
    grew = false
    for (const id of busy) {
      for (const p of parentsOf.get(id) ?? []) {
        if (!busy.has(p) && canWait.has(p)) { busy.add(p); grew = true }
      }
    }
  }
  const counts = new Map<string, number>()
  for (const child of rows) {
    if (!busy.has(child.id)) continue
    for (const p of parentsOf.get(child.id) ?? []) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return counts
}

export interface OwnerWaitRow<S extends string = string> {
  state: S
  /** Busy workers this finished turn is waiting on. Absent = none. */
  waitingOnWorkers?: number | undefined
  /**
   * The turn that just ended was set off by a `notice` from another session (`agentistics_session_message`
   * kind=notice — a leader handover, an id change). A notice asks nothing, so the reaction to it is not a
   * question for the owner (owner, 27/11: "esses avisos aparecem como pergunta, não deveria").
   */
  afterNotice?: boolean | undefined
}

/** True while the finished turn only reacted to an informational notice: nothing to answer. */
export function isAfterNotice(row: OwnerWaitRow): boolean {
  return row.state === 'waiting' && row.afterNotice === true
}

/** True while the session's turn ended and it is its workers, not a person, it waits for. */
export function isWaitingOnWorkers(row: OwnerWaitRow): boolean {
  return row.state === 'waiting' && (row.waitingOnWorkers ?? 0) > 0
}

/** Does this row want a person? The ONE predicate every "needs you" counter reads. */
export function needsOwner(row: OwnerWaitRow): boolean {
  return row.state === 'waiting-approval' || (row.state === 'waiting' && !isWaitingOnWorkers(row) && !isAfterNotice(row))
}

/**
 * The state as a NOTIFICATION sees it: waiting on workers is `idle` — alive, nothing to answer — so
 * no notice fires, and the later `idle -> waiting` (the last worker stopped) is a transition.
 */
export function ownerState<S extends string>(row: OwnerWaitRow<S>): S | 'idle' {
  return isWaitingOnWorkers(row) || isAfterNotice(row) ? 'idle' : row.state
}

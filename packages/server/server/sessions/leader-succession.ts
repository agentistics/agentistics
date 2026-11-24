/**
 * leader-succession.ts — PURE. Which tasks a LIVE leader leads beyond the one it is filed on (LIVE.COLUNAS-PRESAS C3).
 *
 * The Live's "Sem líder" column asked one question: is a live leader FILED on this task (or did it declare `leads`)? Two facts
 * the registry already holds were never asked, so pieces conducted by a live leader read as orphaned:
 *  - SUCCESSION. A leader hands off (`handoffTo`) and the successor is a new session, usually filed on the same task — but the
 *    predecessor may have been filed elsewhere, and everything the predecessor led is the successor's now. The chain is
 *    followed to its end (cycle-safe); only a chain that ENDS in a live leader gives anything to anybody.
 *  - PARENTHOOD. A worker records the session that started it (`parentSessionId`). A leader (or a predecessor in its chain)
 *    that started a worker filed on task X conducts X, whatever task the leader itself is filed on.
 * Nothing is written: this is read on every Live build from the rows the registry has. A task led by nobody alive stays absent.
 */

export interface SuccessionRow {
  id: string
  taskId?: string | undefined
  handoffTo?: string | null | undefined
  parentSessionId?: string | null | undefined
}

/** PURE: the live leader a row's handoff chain ends in, or null (the chain ends in a session that is not a live leader). */
export function successorOf(id: string, byId: ReadonlyMap<string, SuccessionRow>, liveLeaders: ReadonlySet<string>): string | null {
  const seen = new Set<string>()
  let cur: string | undefined = id
  while (cur !== undefined && !seen.has(cur)) {
    if (liveLeaders.has(cur)) return cur
    seen.add(cur)
    cur = byId.get(cur)?.handoffTo ?? undefined
  }
  return null
}

/**
 * PURE: live leader id -> the task ids it leads by succession or parenthood (never its own filing, which the caller already
 * counts). `rows` is every registry row available, ended ones included — the predecessors are ended by definition.
 */
export function inheritedLeads(rows: readonly SuccessionRow[], liveLeaders: ReadonlySet<string>): Map<string, string[]> {
  const byId = new Map(rows.map(r => [r.id, r]))
  const out = new Map<string, Set<string>>()
  const add = (leader: string, task: string | undefined) => {
    if (!task) return
    ;(out.get(leader) ?? out.set(leader, new Set()).get(leader)!).add(task)
  }
  for (const r of rows) {
    // A predecessor's own filing passes to the leader its chain ends in.
    if (r.handoffTo && !liveLeaders.has(r.id)) {
      const heir = successorOf(r.id, byId, liveLeaders)
      if (heir) add(heir, r.taskId)
    }
    // A worker's task is led by whoever its parent's chain ends in (the parent itself when it is the live leader).
    if (r.parentSessionId) {
      const heir = successorOf(r.parentSessionId, byId, liveLeaders)
      if (heir && heir !== r.id) add(heir, r.taskId)
    }
  }
  return new Map([...out].map(([k, v]) => [k, [...v]]))
}

/** PURE: the declared `leads` plus the inherited ones, per leader, without duplicates. */
export function mergeLeads(declared: ReadonlyMap<string, readonly string[]>, inherited: ReadonlyMap<string, readonly string[]>): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>(declared)
  for (const [id, tasks] of inherited) out.set(id, [...new Set([...(out.get(id) ?? []), ...tasks])])
  return out
}

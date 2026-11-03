/**
 * session-reaper.ts — PURE: which processes still running belong to a session that is CLOSED, and so
 * may be stopped.
 *
 * Ownership is the `AGENTOP_MANAGED_ID` every process a session starts inherits (the tmux pane sets it,
 * the structured relay sets it on its child, and every MCP server / tool / `agentop run` underneath
 * inherits it in turn). Measured 03/11: 37 closed sessions still held ~2.3 GB — a structured child
 * (`claude -p --input-format stream-json`) and its MCP servers outlive a relay that died, because the
 * child runs in its own session (`setsid`) and nothing links it back to the row once the relay is gone.
 *
 * The rules, every one of which errs toward NOT stopping:
 *  - the process's OWN environment names the session (an ancestor's marker is not ownership);
 *  - the registry says the session ENDED (`endedAt`), at least `graceMs` ago;
 *  - the backend does NOT list the session as alive — a row marked ended while its relay or pane still
 *    runs is a bookkeeping error, never a reason to end live work (leaders' live sessions included);
 *  - the process STARTED before the session ended — anything younger is somebody else's doing;
 *  - it is not this process, nor one of its ancestors (the server can itself have been started from a
 *    pane, and then carries that pane's marker), nor a process whose marker equals this process's own;
 *  - it is not a tmux server/client (`comm` starting with `tmux`): one started from inside a pane
 *    carries that pane's marker and hosts every other session;
 *  - nothing BENEATH it carries a different marker, or this process: it hosts something else.
 */

export interface ReapProc {
  pid: number
  ppid: number
  comm: string
  /** Wall-clock start (ms since the epoch), derived from the kernel start time. */
  startMs: number
  /** `AGENTOP_MANAGED_ID` from the process's OWN environment, if any. */
  managedId?: string
  rssBytes?: number | null
}

export interface ReapInput {
  procs: readonly ReapProc[]
  /** Session id → when it ended (ms). Only ended sessions appear. */
  ended: ReadonlyMap<string, number>
  /** Ids the backend lists as alive right now. */
  liveIds: ReadonlySet<string>
  nowMs: number
  /** How long a session must have been closed. 0 at kill time. */
  graceMs: number
  selfPid: number
  /** This process's own `AGENTOP_MANAGED_ID`, if any: inheritance from us is not ownership. */
  selfManagedId?: string
  /** Restrict to these ids (the kill of one session). Absent: every ended session. */
  onlyIds?: ReadonlySet<string>
}

export type ReapSkip = 'live' | 'too-recent' | 'younger' | 'self' | 'tmux' | 'hosts-other'

export interface ReapPlan {
  stop: ReapProc[]
  skipped: Array<{ pid: number; managedId: string; why: ReapSkip }>
}

/** Default: how long a session must have been closed before the periodic reaper touches its processes. */
export const REAP_GRACE_MS = 2 * 60_000

export function planSessionReap(i: ReapInput): ReapPlan {
  const byPid = new Map(i.procs.map(p => [p.pid, p]))
  const children = new Map<number, number[]>()
  for (const p of i.procs) {
    const list = children.get(p.ppid)
    if (list) list.push(p.pid); else children.set(p.ppid, [p.pid])
  }
  // This process and every ancestor of it.
  const selfLine = new Set<number>()
  for (let pid = i.selfPid, n = 0; pid > 1 && n < 64 && !selfLine.has(pid); n++) {
    selfLine.add(pid)
    const p = byPid.get(pid)
    if (!p) break
    pid = p.ppid
  }
  /** Does the subtree under `pid` (excluding itself) hold this process or another session's marker? */
  const hostsOther = (pid: number, id: string): boolean => {
    const stack = [...(children.get(pid) ?? [])]
    const seen = new Set<number>()
    while (stack.length) {
      const c = stack.pop()!
      if (seen.has(c)) continue
      seen.add(c)
      if (c === i.selfPid) return true
      const p = byPid.get(c)
      if (p?.managedId && p.managedId !== id) return true
      for (const g of children.get(c) ?? []) stack.push(g)
    }
    return false
  }

  const plan: ReapPlan = { stop: [], skipped: [] }
  for (const p of i.procs) {
    const id = p.managedId
    if (!id) continue
    if (i.onlyIds && !i.onlyIds.has(id)) continue
    const endedMs = i.ended.get(id)
    if (endedMs === undefined) continue
    const skip = (why: ReapSkip): void => { plan.skipped.push({ pid: p.pid, managedId: id, why }) }
    if (i.liveIds.has(id)) { skip('live'); continue }
    if (i.nowMs - endedMs < i.graceMs) { skip('too-recent'); continue }
    if (!(p.startMs <= endedMs)) { skip('younger'); continue }
    if (selfLine.has(p.pid) || (i.selfManagedId !== undefined && i.selfManagedId === id)) { skip('self'); continue }
    if (p.comm.startsWith('tmux')) { skip('tmux'); continue }
    if (hostsOther(p.pid, id)) { skip('hosts-other'); continue }
    plan.stop.push(p)
  }
  return plan
}

/** "freed X MB from N leftover processes of closed sessions" — the one sentence every surface prints. */
export function reapSentence(r: { freedBytes: number; processes: number; dryRun?: boolean }): string {
  const mb = Math.round(r.freedBytes / (1024 * 1024))
  const verb = r.dryRun ? 'would free' : 'freed'
  return `${verb} ${mb} MB from ${r.processes} leftover process${r.processes === 1 ? '' : 'es'} of closed sessions`
}

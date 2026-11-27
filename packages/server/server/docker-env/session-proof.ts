/**
 * DOCKER.AMBIENTES S2 — does this launcher really descend from the session it claims? (SPEC-r3 §3.1, P10)
 *
 * `AGENTOP_MANAGED_ID` (own env, or an ancestor's — the `session-proof.ts` technique) and the cwd only PROPOSE.
 * The proof is ANCESTRY: the session has a live ROOT pid the runtime recorded — the tmux pane (`list-panes` on the
 * agentop socket) or the structured driver's child (`<dataDir>/structured/<id>/relay.pid`) — and walking `ppid`
 * up from the launcher through `/proc/<pid>/stat` reaches it within 16 links, each parent's start time not later
 * than its child's (a recycled pid cannot be a parent of something older than itself).
 *
 * No proof (another OS, reparented to init by `setsid` + fork, no root pid, an ended session) ⇒ `per-run`: the run
 * gets throwaway volumes of its own and never another session's. The same for all seven harnesses — they all run
 * the agent's shell beneath the root the runtime registered. Limit, stated: a process of the SAME uid can rewrite
 * agentop's own files (relay.pid), exactly like `session-identity.key`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PROOF_MAX_DEPTH = 16

export interface ProcLink { ppid: number; start: number }
export type ProcReader = (pid: number) => ProcLink | null

/** `/proc/<pid>/stat` -> ppid and start time (field 22). The comm field may hold spaces and parens. */
export function parseStat(stat: string): ProcLink | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const f = stat.slice(close + 2).split(' ')
  const ppid = Number(f[1])
  const start = Number(f[19])
  return Number.isFinite(ppid) && Number.isFinite(start) ? { ppid, start } : null
}

export type ProofResult =
  | { proven: true; sessionId: string; rootPid: number; depth: number }
  | { proven: false; reason: string }

/** PURE (given the reader): walk from `self` up to one of `roots`. */
export function proveAncestry(claimed: string | undefined, roots: readonly number[], self: number, read: ProcReader): ProofResult {
  if (!claimed || !claimed.trim()) return { proven: false, reason: 'no session id' }
  if (!roots.length) return { proven: false, reason: `session ${claimed} has no live root process` }
  let pid = self
  let link = read(pid)
  if (!link) return { proven: false, reason: 'cannot read the own process' }
  for (let depth = 0; depth <= PROOF_MAX_DEPTH; depth++) {
    if (roots.includes(pid)) return { proven: true, sessionId: claimed, rootPid: pid, depth }
    const parent = link.ppid
    if (parent <= 1) return { proven: false, reason: 'the process chain ends at init (reparented): not inside the session' }
    const p = read(parent)
    if (!p) return { proven: false, reason: `ancestor ${parent} is not readable` }
    if (p.start > link.start) return { proven: false, reason: `ancestor ${parent} started after its child (recycled pid)` }
    pid = parent
    link = p
  }
  return { proven: false, reason: `session root not found within ${PROOF_MAX_DEPTH} ancestors` }
}

export const procReader = (procRoot = '/proc'): ProcReader => pid => {
  try { return parseStat(readFileSync(`${procRoot}/${pid}/stat`, 'utf8')) } catch { return null }
}

/** The PROPOSED id: own env first, then the nearest ancestor's environ (codex filters an MCP's env, a shell may too). */
export function proposedSessionId(env: Record<string, string | undefined>, self: number, read: ProcReader, readEnviron: (pid: number) => string | null): string | undefined {
  const own = env.AGENTOP_MANAGED_ID?.trim()
  if (own) return own
  let pid = read(self)?.ppid ?? 0
  for (let i = 0; i < PROOF_MAX_DEPTH && pid > 1; i++) {
    const environ = readEnviron(pid)
    const hit = environ?.split('\0').find(e => e.startsWith('AGENTOP_MANAGED_ID='))?.slice('AGENTOP_MANAGED_ID='.length).trim()
    if (hit) return hit
    pid = read(pid)?.ppid ?? 0
  }
  return undefined
}

/** The structured driver's root: `relay.pid` names the relay and its child. */
export function structuredRoots(dataDir: string, sessionId: string): number[] {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) return []
  try {
    const j = JSON.parse(readFileSync(join(dataDir, 'structured', sessionId, 'relay.pid'), 'utf8')) as { relay?: unknown; child?: unknown }
    return [j.child, j.relay].filter((p): p is number => typeof p === 'number' && p > 1)
  } catch { return [] }
}

/** `tmux -L agentop list-panes -a -F '#{session_name}\t#{pane_pid}'` output -> the pane pids of `agentop-<id>`. */
export function tmuxRoots(listPanesOut: string, sessionId: string): number[] {
  const out: number[] = []
  for (const line of listPanesOut.split('\n')) {
    const [name, pid] = line.trim().split('\t')
    if (name === `agentop-${sessionId}` && Number(pid) > 1) out.push(Number(pid))
  }
  return out
}

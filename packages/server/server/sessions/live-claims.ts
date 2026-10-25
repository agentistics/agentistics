/**
 * live-claims.ts — the I/O behind `conversation-claim.ts`: which conversations this machine is
 * driving RIGHT NOW.
 *
 * It lives in its own module, and is used by both `cli-start.ts` (the cockpit) and `cli-session.ts`
 * (the command line), for the reason `task-reopen.ts` was extracted: those two are the SAME gesture
 * written twice, and every time a rule has been added to one of them it has been missing from the
 * other. A lock with a second unlocked entrance is not a lock.
 *
 * The DECISION — what counts as driving a conversation — is the pure `conversationsInUse`. This only
 * gathers the evidence, and only the EXACT kinds of it. See that module's header for why a
 * harness-and-directory guess may never be admitted here.
 */

import { scanProcesses } from '../live-sessions'
import { conversationsInUse, type ClaimingSession, type ConversationHolder } from './conversation-claim'
import { emptyHarnessSessionIndex, loadHarnessSessions } from './harness-sessions'
import { readRegistry } from './registry'
import { externalId } from './session-view'
import { readHarnessAgents } from './harness-agents-io'
import type { ManagedSession, SessionBackend } from './types'

/**
 * Conversation id → the live session driving it.
 *
 * Three reads, each contributing something the others cannot:
 *
 *  - the BACKEND says which managed rows are alive. Nothing else does: a harness record OUTLIVES its
 *    process (53 files on this machine against about a dozen live ones), so "there is a record" is
 *    not "it is running" — locking on the records alone would refuse to reopen anything that had
 *    ever run, which is every row this verb exists for.
 *  - the HARNESS's own files say which conversation a live session drives, matched by tmux session
 *    name for one we host and by pid for one we merely see. It is the only source that is a fact
 *    rather than a recollection, and the only one that can see an assistant started OUTSIDE agentop
 *    sitting in the very conversation someone is about to reopen.
 *  - the REGISTRY's `conversationId` covers a live row whose harness record cannot be read.
 *
 * Auxiliary reads are best-effort. A failed backend list must propagate: unreadable liveness is
 * never evidence that nobody holds a conversation, and must not admit a second process.
 */
export async function liveConversationHolders(
  backend: SessionBackend,
): Promise<Map<string, ConversationHolder>> {
  const [registry, backendSessions, harnessSessions, procs] = await Promise.all([
    readRegistry().catch(() => [] as ManagedSession[]),
    backend.list(),
    loadHarnessSessions().catch(() => emptyHarnessSessionIndex()),
    scanProcesses().then(r => r.procs).catch(() => []),
  ])
  const alive = new Set(backendSessions.filter(b => b.alive).map(b => b.id))

  const claims: ClaimingSession[] = []
  for (const m of registry) {
    // Backend liveness wins over a stale endedAt stamp, including a CLI-owned relay.
    const exact = harnessSessions.byManagedId.get(m.id)?.sessionId
    const conversationId = exact ?? m.conversationId
    if (!conversationId) continue
    claims.push({
      id: m.id,
      kind: 'managed',
      alive: alive.has(m.id),
      conversationId,
      ...(m.label ? { label: m.label } : {}),
    })
  }
  // An assistant running BESIDE agentop holds its conversation just as hard as one we started, and
  // it is the case the registry is blind to by construction. `/proc` only reports processes that
  // exist, so these are alive by definition.
  for (const p of procs) {
    const conversationId = p.pid !== undefined
      ? harnessSessions.byPid.get(p.pid)?.sessionId
      : undefined
    if (!conversationId) continue
    claims.push({
      id: externalId(p),
      kind: 'process',
      ...(p.pid !== undefined ? { pid: p.pid } : {}),
      alive: true,
      conversationId,
      label: p.cwd,
    })
  }
  // The harness's OWN list of live sessions — the only source that sees a BACKGROUND agent, which
  // has no tty, no tmux and nothing in the registry.
  //
  // A record is a claim only when it names a pid AND that pid exists. Measured on this machine:
  // `claude agents --json` returned 8 records and only 2 carried one; the other six were
  // `background`/`blocked` with no process at all — conversations the daemon still knows and
  // nothing is running. Counting those as held is what made the cockpit refuse to reopen a
  // conversation nothing was holding, and answer "open it where it already is" about a place that
  // did not exist. Those six are precisely what reopen is FOR.
  for (const a of await readHarnessAgents()) {
    if (a.pid === undefined || !pidAlive(a.pid)) continue
    claims.push({
      id: `agent:${a.sessionId}`,
      kind: 'process',
      pid: a.pid,
      alive: true,
      conversationId: a.sessionId,
      ...(a.name ? { label: a.name } : {}),
    })
  }
  return conversationsInUse(claims)
}

/** Signal 0 asks the kernel whether the pid exists without touching the process. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

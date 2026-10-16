/**
 * `agentop session retire <ref> [--cancel]` — and `kill <own id>` from inside a session, which becomes
 * a retire (ATOMIC SPAWN §2.2).
 *
 * The verb only WRITES the request (`ManagedSession.retire`) and returns: the session being retired is
 * usually the caller, mid-tool-call, so waiting for it to go quiet would wait on itself and killing it
 * would cut its own tool call. The server's hub carries it out (`retire-runner.ts`); with no server
 * running the request waits on the row, and the verb says so.
 *
 * Its own module so `cli-session.ts` only dispatches to it.
 */
import { PORT } from '../config'
import { planRetireRequest, retireReasonsText } from './retire-plan'
import { patchSession, readRegistry } from './registry'
import { resolveSessionRef } from './session-ref'
import type { ManagedSession } from './types'

export interface RetireCliInput {
  ref: string
  cancel?: boolean
  /** A resolved folder id to file the session into once retired. */
  folderId?: string
  folderPath?: string
  quietForMs?: number
  deadlineMs?: number
  json?: boolean
  /** The managed id this command runs inside (`AGENTOP_MANAGED_ID`), if any. */
  caller?: string
}

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(800) })
    return res.ok
  } catch {
    return false
  }
}

export async function retireCommand(o: RetireCliInput): Promise<number> {
  const registry = await readRegistry()
  const found = resolveSessionRef(registry, o.ref)
  if (!found.ok) {
    console.error(found.reason === 'not-found'
      ? `No registered session matches "${o.ref}". Run \`agentop session list\` to see them.`
      : `"${o.ref}" matches more than one session: ${found.matches.join(', ')}. Use a full id.`)
    return 1
  }
  const row = found.session as ManagedSession
  if (o.cancel) {
    if (!row.retire) {
      console.log(`${row.id} has no retire request.`)
      return 0
    }
    await patchSession(row.id, { retire: null })
    if (o.json) console.log(JSON.stringify({ id: row.id, cancelled: true }))
    else console.log(`Cancelled the retire request on ${row.id}.`)
    return 0
  }
  if (row.endedAt) {
    console.error(`${row.id} has already ended — there is nothing to retire.`)
    return 1
  }
  const plan = planRetireRequest(row.retire, {
    by: o.caller ?? 'person',
    ...(o.folderId ? { folderId: o.folderId } : {}),
    ...(o.quietForMs !== undefined ? { quietForMs: o.quietForMs } : {}),
    ...(o.deadlineMs !== undefined ? { deadlineMs: o.deadlineMs } : {}),
  }, Date.now())
  if (!plan.ok) {
    console.error(`${row.id} already has a pending hand-off to ${plan.successorId}. Cancel it first: agentop session retire ${row.id} --cancel`)
    return 1
  }
  if (!(await patchSession(row.id, { retire: plan.request }))) {
    console.error(`${row.id} vanished from the registry before the request could be written.`)
    return 1
  }
  const up = await serverUp()
  if (o.json) {
    console.log(JSON.stringify({ id: row.id, retire: plan.request, serverRunning: up }, null, 2))
    return 0
  }
  const quiet = Math.round(plan.request.quietForMs / 1000)
  const replaced = row.retire?.expiredAt ? ` (replacing an expired one: ${row.retire.expiredReason ?? retireReasonsText([])})` : ''
  console.log(`Retire requested for ${row.id}${replaced}: it ends once it has been idle for ${quiet}s with no background task or child command, and never after ${plan.request.deadlineAt}.${o.folderPath ? ` Then it is moved to ${o.folderPath}.` : ''}`)
  if (!up) console.log(`No agentop server is answering on port ${PORT}: the request waits until one runs (it carries retirements out). Cancel with: agentop session retire ${row.id} --cancel`)
  return 0
}

/** `kill <id>` aimed at the session the command runs inside: a retire, said on stderr. */
export function killIsSelf(id: string, caller: string | undefined): boolean {
  return caller !== undefined && caller === id
}

export const KILL_SELF_SENTENCE =
  'This is the session the command runs in: killing it would cut this very tool call. It will be RETIRED instead — ended by the server once its turn is over.'

/**
 * flows/waits.ts — DSL.ACORDAR host door: `agentistics_wait` (register / cancel / ack / list / handoff).
 *
 * The engine owns the waits (`flows/wait.ts` in the engine: durable outbox, conditions, delivery). This door only
 * proves WHO asks — the session identity the MCP sends (`session-identity.ts`), the same proof
 * `agentistics_session_message` uses — and forwards a `wait.*` event whose owner / `by` is that verified session,
 * never a value from the request. The wake itself is typed by the engine through the host's `cutucar-sessao` op:
 * the composer send path, with its envelope and prompt guards. A wait is never `working` nor an approval.
 */

export const WAIT_ACTIONS = ['register', 'cancel', 'ack', 'list', 'handoff'] as const
export type WaitAction = (typeof WAIT_ACTIONS)[number]

export interface WaitEvent { type: string; id: string; payload: Record<string, unknown> }

export interface WaitDoorDeps {
  emit: (event: WaitEvent) => Promise<unknown>
  read: (kind: string, q: Record<string, unknown>) => Promise<unknown>
  /** The task/subtask a session is filed on, from the registry. */
  filed: (sessionId: string) => Promise<{ taskId?: string; subtaskId?: string }>
  newId: () => string
}

export interface WaitDoorReply { status: number; body: Record<string, unknown> }

const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined
const fail = (status: number, error: string, sentence: string): WaitDoorReply => ({ status, body: { ok: false, error, sentence } })
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,80}$/

/** Engine refusal codes → HTTP status. */
function statusOf(out: Record<string, unknown>): number {
  if (out.ok !== false) return 200
  const code = String(out.code ?? '')
  if (code === 'not_owner') return 403
  if (code === 'no_such_wait') return 404
  if (code === 'revoked' || code === 'stale_generation' || code === 'too_late' || code === 'not_delivered') return 409
  return 400
}

export async function waitRequest(sender: string | null, body: Record<string, unknown>, deps: WaitDoorDeps): Promise<WaitDoorReply> {
  if (!sender) return fail(403, 'unverified_sender', 'Only a session started by agentistics can use waits (its identity could not be verified).')
  const action = str(body.action)
  if (!action || !(WAIT_ACTIONS as readonly string[]).includes(action)) return fail(400, 'bad_action', `action must be one of ${WAIT_ACTIONS.join(', ')}`)

  if (action === 'list') {
    const waits = await deps.read('waits', { sessionId: sender, ...(body.all === true ? { all: true } : {}) }).catch(() => null)
    return { status: 200, body: { ok: true, waits: Array.isArray(waits) ? waits : [] } }
  }

  let event: WaitEvent
  if (action === 'register') {
    const requestId = str(body.requestId)
    if (requestId && !REQUEST_ID.test(requestId)) return fail(400, 'bad_request_id', 'requestId: letters, digits and . _ : - only')
    const filed = await deps.filed(sender).catch(() => ({} as { taskId?: string; subtaskId?: string }))
    event = {
      type: 'wait.register',
      // A retried request with the same requestId is the SAME wait (the engine dedupes on the event id).
      id: `wait.register:${sender}:${requestId ?? deps.newId()}`,
      payload: {
        ownerSessionId: sender,
        condition: body.condition,
        deadlineAt: body.deadlineAt ?? body.deadlineUTC,
        ...(str(body.label) ? { label: str(body.label) } : {}),
        ...(filed.taskId ? { taskId: filed.taskId } : {}),
        ...(filed.subtaskId ? { subtaskId: filed.subtaskId } : {}),
        ...(body.reopen === true ? { reopen: true } : {}),
      },
    }
  } else if (action === 'handoff') {
    // The successor takes the predecessor's waits: `to` is always the caller; both must be filed on the same task.
    const from = str(body.from)
    if (!from) return fail(400, 'missing_argument', 'from (the previous leader) is required')
    const [a, b] = await Promise.all([deps.filed(from).catch(() => ({} as { taskId?: string })), deps.filed(sender).catch(() => ({} as { taskId?: string }))])
    if (!a.taskId || a.taskId !== b.taskId) return fail(403, 'not_successor', 'a hand-off moves waits only between sessions filed on the same task')
    event = { type: 'wait.handoff', id: `wait.handoff:${from}:${sender}:${deps.newId()}`, payload: { from, to: sender } }
  } else {
    const waitId = str(body.waitId)
    if (!waitId) return fail(400, 'missing_argument', 'waitId is required')
    event = {
      type: `wait.${action}`,
      id: `wait.${action}:${waitId}:${deps.newId()}`,
      payload: { waitId, by: sender, ...(body.generation !== undefined ? { generation: Number(body.generation) } : {}) },
    }
  }
  let out: unknown
  try { out = await deps.emit(event) } catch (error) { return fail(502, 'engine_error', String(error)) }
  const r = out && typeof out === 'object' && !Array.isArray(out) ? out as Record<string, unknown> : null
  // An engine without DSL.ACORDAR answers the bus's run list (an array) for an unknown event type.
  if (!r) return fail(501, 'unsupported', 'this engine does not support waits yet')
  return { status: statusOf(r), body: r.ok === false ? { ok: false, error: r.code, sentence: r.message } : r }
}

/** PURE. What the session row shows: one line per owner, the open wait closest to its deadline. */
export function waitLines(waits: unknown): Array<{ sessionId: string; waitId: string; describe: string; deadlineAt: string; status: string }> {
  const list = Array.isArray(waits) ? waits as Array<Record<string, unknown>> : []
  const best = new Map<string, { sessionId: string; waitId: string; describe: string; deadlineAt: string; status: string }>()
  for (const w of list) {
    const owner = w.owner && typeof w.owner === 'object' ? str((w.owner as Record<string, unknown>).sessionId) : undefined
    const waitId = str(w.waitId)
    const deadlineAt = str(w.deadlineAt)
    if (!owner || !waitId || !deadlineAt) continue
    // Only a wait still WAITING is "aguardando": a fired/queued one is being delivered.
    if (w.status !== 'registered') continue
    const line = { sessionId: owner, waitId, describe: str(w.describe) ?? waitId, deadlineAt, status: String(w.status) }
    const prev = best.get(owner)
    if (!prev || Date.parse(deadlineAt) < Date.parse(prev.deadlineAt)) best.set(owner, line)
  }
  return [...best.values()]
}

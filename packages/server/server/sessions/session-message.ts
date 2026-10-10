/**
 * session-message.ts — `/api/session-message`, the door `agentistics_session_message` uses so one
 * session can report to (or instruct) another.
 *
 * It holds no delivery of its own: the text goes into the target through the SAME send path the
 * composer uses (`runFleetAction({action:'prompt'})` — composer fingerprint, read receipts, the
 * refusal on an open dialog), prefixed with a one-line header naming the sender and the kind.
 * When the sender is filed on a task/subtask, the body is ALSO recorded there as a comment of that
 * kind, so the record survives the conversation.
 *
 * The sender is whoever PROVED to be a session (`session-identity.ts`); an unverified caller is
 * refused, because the header would otherwise let any process speak as any session. Dependencies are
 * injected so the rules are testable with a fake host.
 */

import { resolveSessionForGroup } from '@agentistics/core'
import type { FleetRowForGroups } from './session-groups-web'

export const MESSAGE_KINDS = ['handback', 'block', 'question'] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]
export const isMessageKind = (v: unknown): v is MessageKind => (MESSAGE_KINDS as readonly string[]).includes(v as string)

/** One message per (sender → target) pair per window. */
export const MESSAGE_MIN_GAP_MS = 2000

export interface MessageRequest {
  /** The target: managed id, conversation id, exact title or unique id prefix. */
  to: string
  kind: string
  body: string
}

export interface SenderTask {
  taskId?: string
  subtaskId?: string
}

export interface MessageDeps {
  rows: () => Promise<readonly FleetRowForGroups[]>
  /** Type the text into one row through the composer's send path. */
  prompt: (rowId: string, text: string) => Promise<{ ok: boolean; message?: string; failure?: 'prompt' | 'ended' | 'unconfirmed' }>
  /** The task/subtask the sender is filed on, from the registry. */
  senderTask: (senderId: string) => Promise<SenderTask>
  /** Record the mirror comment on the board. */
  comment: (taskId: string, c: { author: string; body: string; subtaskId?: string; kind?: 'handback' | 'block'; session: string }) => Promise<{ ok: boolean }>
  /** `handback` from a session filed on a subtask: move that subtask in_progress → in_review. */
  handbackSubtask?: (subtaskId: string) => Promise<void>
  now: () => number
}

export type MessageReply =
  | { ok: true; to: string; kind: MessageKind; delivered: true; message: string; mirrored: boolean }
  | { ok: false; code: string; message: string; matches?: string[] }

const MESSAGES: Record<string, string> = {
  unverified_sender: 'Only a session started by agentistics can send messages (its identity could not be verified).',
  missing_argument: '`to`, `kind` and a non-empty `body` are required.',
  bad_kind: 'kind must be handback, block or question.',
  no_such_session: 'No session on this machine matches that reference.',
  ambiguous_session: 'More than one session matches that reference; use its id.',
  self: 'A session cannot message itself.',
  rate_limited: 'Too many messages to this session; wait a couple of seconds.',
  not_delivered: 'The message could not be delivered.',
  target_blocked: 'The target is waiting on an approval prompt on its screen, so the message was NOT delivered — send it again once the prompt is answered.',
  not_confirmed: 'The target is running but did not confirm it took the message; it may or may not have arrived — check before sending it again.',
}

const fail = (code: string, message?: string, matches?: string[]): MessageReply => ({
  ok: false, code, message: message ?? MESSAGES[code] ?? code, ...(matches && matches.length > 0 ? { matches } : {}),
})

/** The one-line header every delivered message starts with. */
export function messageHeader(senderId: string, kind: MessageKind): string {
  return `[from session ${senderId} · ${kind}]`
}

/** Pair → last accepted send, epoch ms. */
const lastSent = new Map<string, number>()
export function resetMessageRateLimit(): void { lastSent.clear() }

export async function sendSessionMessage(
  senderId: string | null,
  req: MessageRequest,
  deps: MessageDeps,
): Promise<MessageReply> {
  if (!senderId) return fail('unverified_sender')
  const to = req.to?.trim() ?? ''
  const body = req.body?.trim() ?? ''
  if (!to || !body) return fail('missing_argument')
  if (!isMessageKind(req.kind)) return fail('bad_kind')
  const kind = req.kind

  const rows = await deps.rows().catch(() => [] as FleetRowForGroups[])
  const r = resolveSessionForGroup(rows, to)
  if (!r.ok) return fail(r.code, undefined, r.matches)
  const target = r.session
  if (target.id === senderId || (target.conversationId && target.conversationId === senderId)) return fail('self')

  const pair = `${senderId}→${target.id}`
  const t = deps.now()
  const prev = lastSent.get(pair)
  if (prev !== undefined && t - prev < MESSAGE_MIN_GAP_MS) return fail('rate_limited')

  const sent = await deps.prompt(target.id, `${messageHeader(senderId, kind)}\n${body}`)
  if (!sent.ok) {
    // Three different facts, three different answers: a dialog is open (nothing was typed — retry
    // after it is answered), the pane is gone (a real end), or the keys went in and the submit could
    // not be confirmed (the message may have arrived; the sender must look before it resends).
    // `ended` is never said of a live session.
    if (sent.failure === 'prompt') return fail('target_blocked')
    if (sent.failure === 'unconfirmed') return fail('not_confirmed', sent.message)
    return fail('not_delivered', sent.message)
  }
  lastSent.set(pair, t)

  let mirrored = false
  const filed = await deps.senderTask(senderId).catch((): SenderTask => ({}))
  if (filed.taskId) {
    const res = await deps.comment(filed.taskId, {
      author: `session:${senderId.slice(0, 8)}`,
      body,
      ...(filed.subtaskId ? { subtaskId: filed.subtaskId } : {}),
      ...(kind !== 'question' ? { kind } : {}),
      session: senderId,
    }).catch(() => ({ ok: false }))
    mirrored = res.ok
    if (kind === 'handback' && filed.subtaskId && deps.handbackSubtask) await deps.handbackSubtask(filed.subtaskId).catch(() => {})
  }
  return { ok: true, to: target.id, kind, delivered: true, message: sent.message ?? 'Delivered.', mirrored }
}

export function messageStatus(out: MessageReply): number {
  if (out.ok) return 200
  if (out.code === 'unverified_sender') return 403
  if (out.code === 'no_such_session') return 404
  if (out.code === 'ambiguous_session') return 409
  if (out.code === 'rate_limited') return 429
  if (out.code === 'not_delivered') return 502
  if (out.code === 'not_confirmed') return 502
  if (out.code === 'target_blocked') return 409
  return 400
}

/** The real dependencies: the fleet, the composer's prompt action, the registry and the board. */
export async function defaultMessageDeps(): Promise<MessageDeps> {
  return {
    rows: async () => (await (await import('./fleet-web')).readFleet('en')).rows,
    prompt: async (rowId, text) => {
      const { runFleetAction } = await import('./fleet-web')
      const out = await runFleetAction('en', { action: 'prompt', id: rowId, text })
      return { ok: out.ok, ...(out.message ? { message: out.message } : {}), ...(out.failure ? { failure: out.failure } : {}) }
    },
    senderTask: async id => {
      const { readRegistry } = await import('./registry')
      const row = (await readRegistry()).find(m => m.id === id)
      return { ...(row?.taskId ? { taskId: row.taskId } : {}), ...(row?.subtaskId ? { subtaskId: row.subtaskId } : {}) }
    },
    comment: async (taskId, c) => {
      const { addComment } = await import('./task-web')
      const res = await addComment(taskId, c)
      return { ok: res.ok }
    },
    handbackSubtask: async subtaskId => {
      const tw = await import('./task-web')
      const { statusAfterHandback } = await import('./task-model')
      const w = await (await import('./task-source')).loadTaskWorld()
      const sub = w.book.subtasks.find(s => s.id === subtaskId)
      const next = sub ? statusAfterHandback(sub.status) : null
      if (next) await tw.patchSubtask(subtaskId, { status: next })
    },
    now: () => Date.now(),
  }
}

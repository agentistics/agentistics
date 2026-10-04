/**
 * task-threads.ts — Agentask THREADS, the IO half: open, post into, SEND to the sessions, resolve,
 * mute, and the queued sends. The rules are `@agentistics/core`'s `taskThreads.ts` (pure, tested);
 * this file only reads the book and the fleet, and writes what happened.
 *
 * The owner's rules (2026-10-04, as approved), restated where they bind code:
 *  - a thread is a RECORD — posting a comment reaches no session (`addComment` writes and stops);
 *  - delivering is a separate, explicit act (`sendFromThread`), and the text lands in each session's
 *    OWN chat through the same fleet `prompt` path its composer uses — so a dialog is never typed
 *    into and a send is recorded only when confirmed; the thread records that it was sent, to whom;
 *  - a session's answer stays in its chat: nothing here reads a chat back into a thread;
 *  - there is no bell and no "waiting on you".
 *
 * Security: a send is TEXT typed into a session, never a grant. Recipients are only ever sessions that
 * PROVED their identity (`session-identity.ts`), and a request carrying a session identity can never
 * send — only the person delivers to N.
 */

import {
  canSessionOpenThread, planQueuedFlush, planThreadFanout, threadDeliveryText, withParticipant,
  type CommentKind, type FleetRowLike, type ThreadDelivery, type ThreadKind, type ThreadParticipant,
} from '@agentistics/core'
import { loadTaskBoard } from './task-source'
import { findTask } from './task-report'
import { newCommentId, type TaskComment, type TaskThread } from './task-model'
import { planCommentTarget } from './task-comment'
import { readRegistry } from './registry'
import type { CliLang } from '../cli-lang'

const MAX_TITLE = 140

export function newThreadId(): string {
  return `th-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
}

/** A participant record for a VERIFIED session id, filled from the registry where it can be. */
export async function participantFor(sessionId: string): Promise<ThreadParticipant> {
  const rows = await readRegistry().catch(() => [])
  const row = rows.find(r => r.id === sessionId)
  return {
    sessionId,
    joinedAt: new Date().toISOString(),
    ...(row?.conversationId ? { conversationId: row.conversationId } : {}),
    ...(row?.label ? { label: row.label } : {}),
    ...(row?.harness ? { harness: row.harness } : {}),
  }
}

export type ThreadRefusal = 'no_such_task' | 'no_such_thread' | 'bad_title' | 'session_kind' | 'session_fanout' | 'empty'

export interface OpenThreadInput {
  title: string
  kind?: ThreadKind
  subtaskId?: string
  openedBy: string
  /** A VERIFIED session id — the route verifies, never this function. */
  session?: string
}

/** Open a thread. A session may open one only for a `handback` or a `block`. */
export async function openThread(ref: string, o: OpenThreadInput): Promise<
  { ok: true; thread: TaskThread } | { ok: false; reason: ThreadRefusal | 'no_such_subtask' | 'wrong_delivery'; message: string }
> {
  const title = o.title.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE)
  if (!title) return { ok: false, reason: 'bad_title', message: 'A thread needs a title.' }
  const kind: ThreadKind = o.kind ?? 'topic'
  if (o.session && !canSessionOpenThread(kind)) {
    return { ok: false, reason: 'session_kind', message: 'A session may open a thread only for a handback or a block.' }
  }
  const w = await loadTaskBoard()
  const task = findTask(ref, w.book.tasks)
  if (!task) return { ok: false, reason: 'no_such_task', message: `No task "${ref}" exists.` }
  const target = planCommentTarget(task.id, o.subtaskId, w.book.subtasks)
  if (!target.ok) return target
  const thread: TaskThread = {
    id: newThreadId(),
    taskId: task.id,
    title,
    kind,
    openedBy: o.openedBy.trim() || 'unknown',
    createdAt: new Date().toISOString(),
    participants: o.session ? [await participantFor(o.session)] : [],
    ...(target.subtaskId ? { subtaskId: target.subtaskId } : {}),
    ...(o.session ? { openedBySession: o.session } : {}),
  }
  await w.store.upsertThread(thread)
  return { ok: true, thread }
}

/**
 * The thread bookkeeping a new comment causes: a verified session joins as a participant, and any
 * comment re-opens a resolved thread. Called by `addComment` AFTER the comment is written.
 */
export async function noteThreadComment(threadId: string, session: string | undefined): Promise<void> {
  const w = await loadTaskBoard()
  const p = session ? await participantFor(session) : null
  await w.store.updateThread(threadId, t => {
    const { resolvedAt: _open, ...rest } = t
    return { ...rest, participants: p ? withParticipant(t.participants, p) : t.participants }
  })
}

/** Does `threadId` exist on `taskId`? The comment route refuses a thread of another task. */
export async function threadOfTask(taskId: string, threadId: string): Promise<TaskThread | null> {
  const w = await loadTaskBoard()
  return w.book.threads.find(t => t.id === threadId && t.taskId === taskId) ?? null
}

/** The fleet as the planner reads it. Lazy import: the fleet module is heavy and pulls the host. */
async function fleetRows(lang: CliLang): Promise<FleetRowLike[]> {
  const { hostForFleet } = await import('./fleet-web')
  const host = await hostForFleet(lang)
  const snap = await host.sessions?.()
  return (snap?.sessions ?? []).map(r => ({
    id: r.id, state: r.state, actionable: r.actionable,
    ...(r.conversationId ? { conversationId: r.conversationId } : {}),
  }))
}

async function promptRow(lang: CliLang, rowId: string, text: string): Promise<{ ok: boolean; message?: string }> {
  const { runFleetAction } = await import('./fleet-web')
  const out = await runFleetAction(lang, { action: 'prompt', id: rowId, text })
  return { ok: out.ok, ...(out.message ? { message: out.message } : {}) }
}

export interface SendInput {
  body: string
  author: string
  kind?: CommentKind
  attachments?: TaskComment['attachments']
  /** Set by the route when the request carried a (verified) session identity — refused. */
  fromSession?: boolean
}

/**
 * The person's EXPLICIT send: one comment in the record, and the same text delivered into every
 * participant's own chat, each delivery recorded with what actually happened.
 */
export async function sendFromThread(ref: string, threadId: string, o: SendInput, lang: CliLang): Promise<
  { ok: true; id: string; deliveries: ThreadDelivery[] } | { ok: false; reason: ThreadRefusal; message: string }
> {
  if (o.fromSession) {
    return { ok: false, reason: 'session_fanout', message: 'Only the person sends from a thread; a session comments in it.' }
  }
  const body = o.body.trim()
  if (!body) return { ok: false, reason: 'empty', message: 'There is nothing to send.' }
  const w = await loadTaskBoard()
  const task = findTask(ref, w.book.tasks)
  if (!task) return { ok: false, reason: 'no_such_task', message: `No task "${ref}" exists.` }
  const thread = w.book.threads.find(t => t.id === threadId && t.taskId === task.id)
  if (!thread) return { ok: false, reason: 'no_such_thread', message: `No thread "${threadId}" on this task.` }

  const rows = thread.participants.length > 0 ? await fleetRows(lang).catch(() => []) : []
  const plan = planThreadFanout(thread.participants, rows, thread.mutedSessions ?? [])
  const text = threadDeliveryText({ taskTitle: task.title, threadTitle: thread.title, body })
  const now = () => new Date().toISOString()
  const deliveries: ThreadDelivery[] = []
  for (const step of plan) {
    const base = { sessionId: step.sessionId, ...(step.conversationId ? { conversationId: step.conversationId } : {}) }
    if (step.action === 'send' && step.rowId) {
      const sent = await promptRow(lang, step.rowId, text).catch(e => ({ ok: false, message: String(e) }))
      deliveries.push(sent.ok
        ? { ...base, state: 'delivered', at: now() }
        : { ...base, state: 'failed', reason: 'refused', at: now(), ...(sent.message ? { detail: sent.message } : {}) })
    } else {
      deliveries.push({ ...base, state: step.state ?? 'undeliverable', at: now(), ...(step.reason ? { reason: step.reason } : {}) })
    }
  }
  const id = newCommentId()
  await w.store.addComment({
    id, taskId: task.id, author: o.author.trim() || 'owner', body, createdAt: now(),
    threadId, role: 'owner', deliveries,
    ...(o.kind && o.kind !== 'note' ? { kind: o.kind } : {}),
    ...(thread.subtaskId ? { subtaskId: thread.subtaskId } : {}),
    ...(o.attachments?.length ? { attachments: o.attachments } : {}),
  })
  await w.store.updateThread(threadId, t => { const { resolvedAt: _r, ...rest } = t; return rest })
  return { ok: true, id, deliveries }
}

export type ThreadVerb = 'resolve' | 'reopen' | 'mute' | 'unmute' | 'rename'

/** Resolve / reopen / mute a participant / rename. False when the thread is not on that task. */
export async function threadAction(
  ref: string, threadId: string, verb: ThreadVerb, o: { sessionId?: string; title?: string } = {},
): Promise<boolean> {
  const w = await loadTaskBoard()
  const task = findTask(ref, w.book.tasks)
  if (!task || !w.book.threads.some(t => t.id === threadId && t.taskId === task.id)) return false
  if ((verb === 'mute' || verb === 'unmute') && !o.sessionId) return false
  const title = (o.title ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE)
  if (verb === 'rename' && !title) return false
  return await w.store.updateThread(threadId, t => {
    switch (verb) {
      case 'resolve': return { ...t, resolvedAt: new Date().toISOString() }
      case 'reopen': { const { resolvedAt: _r, ...rest } = t; return rest }
      case 'rename': return { ...t, title }
      case 'mute': return { ...t, mutedSessions: [...new Set([...(t.mutedSessions ?? []), o.sessionId!])] }
      case 'unmute': {
        const left = (t.mutedSessions ?? []).filter(s => s !== o.sessionId)
        const { mutedSessions: _m, ...rest } = t
        return left.length ? { ...rest, mutedSessions: left } : rest
      }
    }
  })
}

/**
 * Deliver what is QUEUED now that it can go — a session reopened, a dialog closed. Reads the fleet
 * only when something is actually queued, so a board with nothing waiting costs one book read.
 * Returns how many went.
 */
export async function flushQueuedDeliveries(lang: CliLang): Promise<number> {
  const w = await loadTaskBoard()
  const pending = w.book.comments.filter(c => c.deliveries?.some(d => d.state === 'queued'))
  if (pending.length === 0) return 0
  const rows = await fleetRows(lang).catch(() => [])
  let sent = 0
  for (const c of pending) {
    const queued = c.deliveries!.filter(d => d.state === 'queued')
    const go = planQueuedFlush(queued, rows)
    if (go.length === 0) continue
    const task = w.book.tasks.find(t => t.id === c.taskId)
    const thread = w.book.threads.find(t => t.id === c.threadId)
    if (!task || !thread) continue
    const text = threadDeliveryText({ taskTitle: task.title, threadTitle: thread.title, body: c.body })
    const outcome = new Map<string, ThreadDelivery>()
    for (const g of go) {
      // Muted since it was queued: it does not go.
      if (thread.mutedSessions?.includes(g.sessionId)) {
        outcome.set(g.sessionId, { sessionId: g.sessionId, state: 'muted', reason: 'muted', at: new Date().toISOString() })
        continue
      }
      const r = await promptRow(lang, g.rowId, text).catch(e => ({ ok: false, message: String(e) }))
      if (r.ok) { sent++; outcome.set(g.sessionId, { sessionId: g.sessionId, state: 'delivered', at: new Date().toISOString() }) }
      // A refused flush STAYS queued: the next pass tries again, and the reason is kept for the page.
      else outcome.set(g.sessionId, { sessionId: g.sessionId, state: 'queued', reason: 'refused', at: new Date().toISOString(), ...(r.message ? { detail: r.message } : {}) })
    }
    await w.store.updateComment(c.id, cur => ({
      ...cur,
      deliveries: (cur.deliveries ?? []).map(d => {
        const o = outcome.get(d.sessionId)
        return o && d.state === 'queued' ? { ...d, ...o, ...(d.conversationId ? { conversationId: d.conversationId } : {}) } : d
      }),
    }))
  }
  return sent
}

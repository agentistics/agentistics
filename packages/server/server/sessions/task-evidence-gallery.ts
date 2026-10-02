/**
 * task-evidence-gallery.ts — PURE. The flat list behind the Evidence card and the task gallery.
 *
 * Two origins, one shape:
 *  - `sessions` — attachments a session left with a COMMENT (`agentistics_task_attach` sets the
 *    comment's `sessionId`), flattened to one entry per file with the task/subtask they were left on.
 *  - `mine`     — images the PERSON sent into a session through the chat (the attachment message log,
 *    keyed by conversation), minus any path a session's comment already claims. A conversation maps
 *    to a task through the sessions filed under it, so a chat image with no filed session has no task.
 *
 * Nothing here reads a file; the caller passes the book's comments and the log's messages.
 */
import type { AttachmentMessage, ChatAttachmentRef } from '@agentistics/core'

export type EvidenceOrigin = 'sessions' | 'mine'

export interface EvidenceItem {
  name: string
  path: string
  origin: EvidenceOrigin
  taskId: string | null
  subtaskId: string | null
  /** The session that produced it: a managed id for `sessions`, a conversation id for `mine`. */
  sessionId: string | null
  author: string
  createdAt: string
}

export interface EvidenceComment {
  taskId: string
  subtaskId?: string
  sessionId?: string
  author: string
  createdAt: string
  attachments?: ChatAttachmentRef[]
}

export interface EvidenceInput {
  comments: readonly EvidenceComment[]
  messages: readonly AttachmentMessage[]
  /** conversationId -> the task its session is filed under. */
  taskOfConversation: ReadonlyMap<string, string>
  origin?: EvidenceOrigin | 'all'
  taskId?: string
}

export function buildEvidence(i: EvidenceInput): EvidenceItem[] {
  const origin = i.origin ?? 'all'
  const out: EvidenceItem[] = []
  const claimed = new Set<string>()
  for (const c of i.comments) {
    if (!c.sessionId) continue
    for (const a of c.attachments ?? []) {
      claimed.add(a.path)
      if (origin === 'mine') continue
      out.push({
        name: a.name, path: a.path, origin: 'sessions', taskId: c.taskId, subtaskId: c.subtaskId ?? null,
        sessionId: c.sessionId, author: c.author, createdAt: c.createdAt,
      })
    }
  }
  if (origin !== 'sessions') {
    const seen = new Set<string>()
    for (const m of i.messages) {
      for (const p of m.paths) {
        if (claimed.has(p) || seen.has(p)) continue
        seen.add(p)
        out.push({
          name: p.split(/[\\/]/).pop() ?? p, path: p, origin: 'mine',
          taskId: i.taskOfConversation.get(m.conversationId) ?? null, subtaskId: null,
          sessionId: m.conversationId, author: 'you', createdAt: new Date(m.atMs).toISOString(),
        })
      }
    }
  }
  const scoped = i.taskId ? out.filter(e => e.taskId === i.taskId) : out
  return scoped.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.path.localeCompare(b.path))
}

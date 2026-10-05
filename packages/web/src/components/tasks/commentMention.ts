/**
 * commentMention.ts — mentioning things of THIS TASK from the comment composer (PURE).
 *
 *   `#`  lists the task's sessions and writes the session chip the session composer already uses
 *        (`sessionMention.ts`: `#«Title · 3f5f21a8»`) — one chip format, one reader.
 *   `^`  lists the task's comments and writes a LINK to the one picked: `[↪ Author: snippet](#comment-ID)`.
 *        The caret is the trigger because `#` is the sessions' and `@` belongs to MCP servers in the session
 *        composer; a comment reference is a pointer back up the page, which is what `^` looks like.
 *
 * Both triggers follow the word-boundary rule `hashQuery` states (the character must open the text or follow
 * whitespace, so `x^2` and `issue#12` never open a picker), and `# ` (a markdown heading) is not a search.
 */
import { applySessionMention, filterMentionCandidates, hashQuery, type MentionCandidate, type MentionInsertion } from '../../lib/sessionMention'
import type { TaskComment, TaskSessionRow } from '../../lib/tasks'

export type Trigger = { kind: 'session' | 'comment'; query: string }

export const COMMENT_QUERY_MAX = 48
export const COMMENT_LIMIT = 8

/** The `^query` at the end of `before`, or null. */
export function caretQuery(before: string): string | null {
  const m = /(?:^|\s)\^((?:[^\s^\n][^\n^]*)?)$/.exec(before)
  if (!m) return null
  return m[1]!.length > COMMENT_QUERY_MAX ? null : m[1]!
}

/** Which picker the text before the caret opens, if any. The later trigger wins when both are present. */
export function triggerAt(before: string): Trigger | null {
  const h = hashQuery(before)
  const c = caretQuery(before)
  if (h !== null && c !== null) return before.lastIndexOf('#') > before.lastIndexOf('^') ? { kind: 'session', query: h } : { kind: 'comment', query: c }
  if (h !== null) return { kind: 'session', query: h }
  if (c !== null) return { kind: 'comment', query: c }
  return null
}

/** The task's sessions as picker rows. A conversation with no session behind it cannot be pointed at. */
export function sessionCandidates(sessions: readonly TaskSessionRow[]): MentionCandidate[] {
  return sessions
    .filter(s => !s.historical)
    .map(s => ({ id: s.id, title: s.label || `${s.harness} ${s.id.slice(0, 6)}`, harness: s.harness, ...(s.conversationId ? { conversationId: s.conversationId } : {}), ...(s.cwd ? { cwd: s.cwd } : {}) }))
}

export interface CommentCandidate { id: string; author: string; snippet: string }

export function commentSnippet(body: string, max = 60): string {
  const one = body.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[\r\n#*_`>\[\]]+/g, ' ').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one
}

export function commentCandidates(comments: readonly TaskComment[]): CommentCandidate[] {
  return [...comments].reverse().map(c => ({ id: c.id, author: c.author, snippet: commentSnippet(c.body) || (c.attachments?.length ? '📎' : '…') }))
}

export function filterComments(rows: readonly CommentCandidate[], query: string, limit = COMMENT_LIMIT): CommentCandidate[] {
  const q = query.trim().toLowerCase()
  return rows.filter(r => q === '' || `${r.author} ${r.snippet}`.toLowerCase().includes(q)).slice(0, limit)
}

/** Write the link where `^query` is, followed by a space; the caret goes after it. */
export function applyCommentMention(draft: string, caret: number, row: CommentCandidate): MentionInsertion {
  const at = Math.max(0, Math.min(caret, draft.length))
  const before = draft.slice(0, at)
  const after = draft.slice(at)
  const q = caretQuery(before)
  const label = `↪ ${row.author}: ${row.snippet}`.replace(/[\[\]()]/g, ' ').replace(/\s+/g, ' ').trim()
  const link = `[${label}](#comment-${row.id})`
  const inserted = after.startsWith(' ') ? link : `${link} `
  if (q === null) {
    const head = draft.replace(/\s+$/, '')
    const text = head === '' ? `${link} ` : `${head} ${link} `
    return { text, caret: text.length }
  }
  const start = before.length - q.length - 1
  return { text: draft.slice(0, start) + inserted + after, caret: start + inserted.length }
}

/** The anchor id a comment's card carries, so a `#comment-ID` link has somewhere to land. */
export const commentAnchor = (id: string) => `comment-${id}`

/** Is this href a link to a comment of the page? Returns the comment's id. */
export function commentIdFromHref(href: string | null | undefined): string | null {
  const m = /^#comment-([A-Za-z0-9_-]+)$/.exec(href ?? '')
  return m ? m[1]! : null
}

export { applySessionMention, filterMentionCandidates }

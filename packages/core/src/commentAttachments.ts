/**
 * commentAttachments.ts — files attached to a task comment. Pure.
 *
 * A comment's attachment is a REFERENCE to a file the chat's own upload door already wrote
 * (`POST /api/fleet/attach` -> `~/.agentistics/attachments/`) — `{name, path}`, exactly what a
 * session message carries. There is no second store: the bytes are never copied or embedded in the
 * task book, so an attachment is shown and served by the same `GET /api/fleet/attachment` the chat
 * thumbnails use, under the same containment check.
 *
 * `sanitizeCommentAttachments` is the one reader of the wire/file shape. It takes `accept`, the
 * caller's containment rule (the server passes `resolveAttachmentRead`), so a path outside the
 * attachments directory is DROPPED rather than stored — a comment is not a way to make the server
 * point at `~/.ssh`. The same limit as a chat message (`MAX_ATTACHMENTS`) applies.
 */

export const MAX_COMMENT_ATTACHMENTS = 10

export interface ChatAttachmentRef {
  name: string
  /** Absolute path inside agentop's attachments directory, as the upload door returned it. */
  path: string
}

export function sanitizeCommentAttachments(
  raw: unknown,
  accept: (path: string) => string | null = p => p,
): ChatAttachmentRef[] {
  if (!Array.isArray(raw)) return []
  const out: ChatAttachmentRef[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= MAX_COMMENT_ATTACHMENTS) break
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.path !== 'string' || r.path === '') continue
    const path = accept(r.path)
    if (path === null || seen.has(path)) continue
    seen.add(path)
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : path.split(/[\\/]/).pop() ?? path
    out.push({ name, path })
  }
  return out
}

/**
 * The session id a comment may name as the producer of its attachments. Only the SHAPE is checked
 * (a managed id / conversation uuid / handle): the book is a local file and a session that has since
 * ended must still be nameable, so existence is not a condition. Anything else reads as absent.
 */
export function sanitizeCommentSessionId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const s = raw.trim()
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(s) ? s : undefined
}

/** What an assistant is handed for one attachment: the reference plus where to fetch it. */
export function chatAttachmentRef(a: ChatAttachmentRef): ChatAttachmentRef & { url: string } {
  return { ...a, url: `/api/fleet/attachment?path=${encodeURIComponent(a.path)}` }
}

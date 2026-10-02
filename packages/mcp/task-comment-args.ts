/**
 * task-comment-args.ts — what `agentistics_task_comment` sends to the one door, `/api/tasks`.
 *
 * Pure, and its own module because `agentistics-mcp.ts` starts a server on import: the mapping is
 * the part worth pinning. `subtaskId` is the comment's TARGET — a subtask or a subtask GROUP of the
 * same task; absent (or blank) means the task itself. The server validates it and refuses an unknown
 * or deleted one in words, so nothing is decided here beyond forwarding it exactly when present.
 */
export function taskCommentRequest(args: unknown): { path: string; payload: Record<string, unknown> } {
  const a = (args ?? {}) as Record<string, unknown>
  const subtaskId = typeof a.subtaskId === "string" && a.subtaskId.trim() ? a.subtaskId.trim() : undefined
  return {
    path: `/api/tasks/${encodeURIComponent(String(a.ref))}/comments`,
    payload: {
      body: typeof a.body === "string" ? a.body : "",
      author: typeof a.author === "string" && a.author ? a.author : "assistant",
      ...(subtaskId ? { subtaskId } : {}),
      // References from the chat's upload door (`{name, path}`); the server keeps only paths inside
      // its attachments directory. Forwarded as given — nothing is decided here.
      ...(Array.isArray(a.attachments) && a.attachments.length > 0 ? { attachments: a.attachments } : {}),
    },
  }
}

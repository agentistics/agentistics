/**
 * born-link.ts — PURE: which conversation a just-spawned row drives, known at the moment it is born.
 *
 * Two cases are exact at spawn: a FRESH session the CLI was handed an id for (`--session-id`), and a
 * REOPEN, where we asked the CLI to resume a named conversation. Only the first was ever recorded
 * on the row as it was written; the reopen's id was patched in by the caller AFTER `addSession`
 * returned. That left a window in which the row existed unlinked — and the fleet snapshot the chat
 * view reads could land inside it. Measured on a probe session: after pressing Reabrir the web
 * landed on the new session and showed "this session has no linked conversation yet, so there is
 * no transcript to read" for 3.5 s before the next read found the patch; on a busier machine the
 * polls line up worse and it reads as permanent. A row written with its link has no such window.
 */
export function bornConversationLink(
  assignedId: string | undefined,
  resumeId: string | undefined,
): { conversationId: string; conversationLink: 'assigned' } | undefined {
  const id = assignedId ?? resumeId
  return id ? { conversationId: id, conversationLink: 'assigned' } : undefined
}

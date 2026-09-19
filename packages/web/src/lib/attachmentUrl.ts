import { ATTACHMENT_DIR_MARK } from './messageAttachments'

/**
 * The real attachments directory THIS SERVER configured, once a chat read has said so — see
 * `ChatPayload.attachmentsDir` and `chatFeed.ts`, the one place that calls the setter.
 *
 * `ATTACHMENT_DIR_MARK` is a GUESS at the default layout (`~/.agentistics/attachments/`), right for
 * almost every install — it stops being right the moment `AGENTISTICS_DIR` relocates the data
 * directory, because the real path then carries no `.agentistics` segment at all and the substring
 * guess never matches. A `viewed` file inside the (relocated) attachments directory then read as
 * one the SESSION wrote instead of one the attachments route can serve — routed through the
 * artifacts allowlist, which refuses it — and the gallery reported a file that was right there as
 * "não está mais no disco". `null` until the server has said otherwise, which is when the guess is
 * used; a server always agrees with its own client, so this is set at most once per page load.
 */
let knownAttachmentsDir: string | null = null

/** Record the server's own configured attachments directory, or `null` to go back to guessing —
 *  the second is for tests only, since a real server never un-publishes it. */
export function setAttachmentsDir(dir: string | null): void {
  knownAttachmentsDir = dir && dir !== '' ? dir : null
}

/** Is `path` inside the attachments directory — the REAL one once known, the default guess
 *  otherwise. Exact prefix match on the real one, never a substring: a relocated directory can sit
 *  anywhere, including under a path that would otherwise collide with an unrelated folder. */
function isAttachmentPath(path: string): boolean {
  if (knownAttachmentsDir !== null) return path === knownAttachmentsDir || path.startsWith(`${knownAttachmentsDir}/`)
  return path.includes(ATTACHMENT_DIR_MARK)
}

/** The URL that reads an attachment back — see `GET /api/fleet/attachment` and its
 *  `resolveAttachmentRead` guard on the server. One place, so a caller never hand-builds it. */
export function attachmentUrl(path: string): string {
  return `/api/fleet/attachment?path=${encodeURIComponent(path)}`
}

/**
 * The URL that reads one stored attachment back BY ITS NAME — see `GET /api/fleet/attachment/
 * by-name` and its pure `attachmentPathByName` / `attachmentImageType` guards on the server.
 *
 * The narrower of the two, and the one the GALLERY uses. The chat shows an attachment back from
 * the message that carried it, so it necessarily has a path; the gallery is a view OF the
 * attachments directory and needs nothing more than a name — which is a shape that cannot express
 * a traversal at all. That route also serves images ONLY, so it can never become a general reader
 * of agentop's own directory.
 *
 * A `HEAD` on this same URL answers the SIZE without the bytes, which is what the list column
 * under each name is for.
 */
export function attachmentNameUrl(name: string): string {
  return `/api/fleet/attachment/by-name?name=${encodeURIComponent(name)}`
}


/**
 * The URL that reads back a file the SESSION produced — see `GET /api/fleet/media` and its
 * `planArtifactRead` + `artifact-media.ts` guards on the server.
 *
 * The third of these, and the widest, which is why it is the one bound to a SESSION: an attachment
 * is addressed inside agentop's own directory, while this addresses a file wherever the session put
 * it — so the id is not decoration, it is what the allowlist is resolved against. A caller without
 * one has nothing to ask.
 */
export function sessionMediaUrl(sessionId: string, path: string): string {
  return `/api/fleet/media?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
}

/**
 * The URL that reads back one image, video or PDF in the session's REPOSITORY — see
 * `GET /api/fleet/tree/media`.
 *
 * The fourth of these, and it is not `sessionMediaUrl` with a different path. That one is resolved
 * against the artifacts allowlist (files this session WROTE) and refuses everything else; the Studio
 * browses the session's whole directory, so a checked-in asset the session never opened — the exact
 * file that prompted this — is the case that allowlist exists to refuse. Same closed content table
 * and same anti-sniffing headers, different allowlist, therefore a different route.
 */
export function repoMediaUrl(sessionId: string, path: string): string {
  return `/api/fleet/tree/media?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
}

/** The URL for one gallery row, whichever side it came from. ONE place, so no caller guesses. */
export function galleryFileUrl(
  file: { path: string; name: string; origin?: 'sent' | 'produced' | 'viewed' },
  sessionId: string,
): string {
  if (file.origin === 'produced') return sessionMediaUrl(sessionId, file.path)
  if (file.origin === 'viewed') {
    // A VIEWED file was never sent and never (necessarily) written, so neither existing route's
    // rule can be assumed — each is simply TRIED under its own, unwidened rule, and whichever
    // actually applies is what serves it: a re-read attachment resolves by the same containment
    // check a sent one does, one the session also wrote resolves through the write-allowlist a
    // produced one does, and anything else 404s into the gallery's ordinary broken-image fallback.
    // See `viewedGroups`'s own header for why this may never be widened to "anything the session
    // read".
    return isAttachmentPath(file.path)
      ? attachmentUrl(file.path)
      : sessionMediaUrl(sessionId, file.path)
  }
  return attachmentNameUrl(file.name)
}

/**
 * repoDrag.ts — PURE: the ONE MIME a tree row's drag carries, what the WRITER puts on it, and a
 * READER hostile payloads cannot fool.
 *
 * This is the contract §6 (references into the conversation, a later package) consumes too: a row
 * dragged onto the composer reads through this exact module rather than a second copy of the shape
 * — defined once, here, so the writer and every reader agree on what a drag actually carries.
 *
 * `readRepoDrag` is the one function worth distrusting input into: a `DataTransfer` can carry
 * anything a page ever wrote to it (another origin's drag, a stale payload replayed by a test, a
 * handcrafted one), so every field is checked rather than cast. **A payload naming a DIFFERENT
 * session is refused exactly like a malformed one** — the caller's own `sessionId` is required and
 * compared here, never trusted from the payload, because a forged or simply stale cross-session
 * payload would otherwise ask the server to move a file in session A using session B's tree.
 *
 * **`path` IS REFUSED, NOT MERELY UNVALIDATED (a review minor, `session-w1c-tree-ops-review.md`).**
 * The server is the actual containment boundary (`editor-fs.ts`'s own `escaped` refusal) and stays
 * the authority here — this reader refuses only the shapes that are never a legitimate relative path
 * FROM THIS TREE (`..`/absolute/empty-segment traversal, and a length no real path in a repository
 * would reach) so a hostile or stale payload is turned away at the one place every consumer of this
 * MIME shares, rather than trusted through to whichever route happens to be less careful.
 */

export const REPO_DRAG_MIME = 'application/x-agentistics-repo-entry'

export interface RepoDragPayload {
  sessionId: string
  path: string
  kind: 'file' | 'dir'
}

/**
 * `dragstart` sets TWO representations of one drag: the structured payload under this feature's
 * own MIME, and the plain relative path under `text/plain` — so dropping a tree row into ANY other
 * text field (a terminal, another application, an address bar) gets the path rather than nothing.
 */
export function writeRepoDrag(dataTransfer: DataTransfer, payload: RepoDragPayload): void {
  dataTransfer.setData(REPO_DRAG_MIME, JSON.stringify(payload))
  dataTransfer.setData('text/plain', payload.path)
}

/**
 * The longest `path` this reader accepts. No real path inside a repository this feature browses
 * needs anything close to it; a payload past it is refused rather than passed through unbounded.
 */
export const MAX_DRAG_PATH_LENGTH = 4096

/**
 * Is `path` a plausible relative path FROM THIS TREE'S ROOT — never absolute, never carrying a `.`
 * or `..` segment (a traversal attempt, or simply not what this tree's own paths look like — they
 * are always joined fresh from listed names, never normalised from user input), and within the
 * length ceiling. Exported and pure so the refusal is directly testable against hostile strings.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.length > MAX_DRAG_PATH_LENGTH) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * `null` for anything this feature did not itself write: absent, unreadable, malformed JSON, a
 * shape missing a field, an unrecognised `kind`, a `path` that is not a safe relative path (see
 * `isSafeRelativePath`), or a payload naming a session other than the caller's own. A failed read is
 * indistinguishable from "nothing of ours was dropped here" on purpose — the caller's only correct
 * response to either is to ignore the drop.
 */
export function readRepoDrag(dataTransfer: DataTransfer, sessionId: string): RepoDragPayload | null {
  let raw: string
  try {
    raw = dataTransfer.getData(REPO_DRAG_MIME)
  } catch {
    return null
  }
  if (typeof raw !== 'string' || raw === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const { sessionId: sid, path, kind } = parsed as Record<string, unknown>
  if (typeof sid !== 'string' || sid === '') return null
  if (typeof path !== 'string' || !isSafeRelativePath(path)) return null
  if (kind !== 'file' && kind !== 'dir') return null
  if (sid !== sessionId) return null

  return { sessionId: sid, path, kind }
}

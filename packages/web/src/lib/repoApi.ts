/**
 * repoApi.ts — the ONE module in the repository explorer that talks HTTP.
 *
 * It wraps the seven `/api/fleet/tree*` routes (`server/sessions/editor-web.ts`) and nothing else:
 * the tree view model (`repoTreeModel.ts`) is pure, the editor is lazy-loaded, and every component
 * reaches the network through here. Same posture as `packages/vscode/src/api.ts`, which this
 * mirrors deliberately — "the ONE process that talks HTTP; every method total".
 *
 * EVERY WRAPPER IS TOTAL, and answers with exactly one of THREE outcomes, never two:
 *  - a success, carrying the server's own fields;
 *  - a REFUSAL the server decided (`failure: 'refused'`), carrying its language-free `reason` code
 *    and its already-localized `message` VERBATIM;
 *  - `failure: 'unreachable'` — the request never got a usable answer (no network, a timeout, or a
 *    body that does not honour the contract).
 *
 * Nothing here throws at a caller, and NOTHING HERE COMPOSES A SENTENCE. The server already worded
 * every refusal in the user's own language (which is why `lang` travels on every request); mapping
 * a code to wording is a UI decision and is made where the wording is shown. A refusal whose body
 * carried no sentence at all — the closed gate's `{error: 'editor_disabled'}` — arrives here with
 * NO `message` field rather than an invented one, the same N/A-versus-a-confident-value rule this
 * codebase applies to harness capabilities.
 *
 * A failed call may never come back looking like an empty successful one. That is why the shape of
 * every `ok: true` body is checked before it is returned: a 200 that does not carry what it claims
 * would otherwise render as an empty directory, an empty search or an empty file — three confident
 * lies, each indistinguishable from a real result.
 */

/**
 * `TreeChild` mirrors the server's `editor-list.ts` (`{ name, kind: 'file' | 'dir' }`) — that shape
 * is never imported from `packages/server/server/*` (`packages/web/src/*` may never bundle it) — but
 * it is imported from `repoTreeModel.ts` rather than redeclared a second time IN THIS SAME PACKAGE:
 * the two used to carry byte-identical local copies, so a later `kind: 'symlink'` would have needed
 * remembering in two places one file apart for no reason a package boundary requires.
 */
import type { TreeChild } from './repoTreeModel'
export type { TreeChild }

/** Mirrors the server's `NameHit` / `ContentHit` / `SearchResult` (`editor-search.ts`). */
export interface NameHit { kind: 'name'; path: string }
export interface ContentHit { kind: 'content'; path: string; line: number; text: string }
export type SearchHit = NameHit | ContentHit

/** The language the server words its refusals in — the dashboard's own, passed on every request. */
export type RepoLang = 'en' | 'pt'

/**
 * A refusal the SERVER decided. `reason` is its language-free code (`not-found`, `escaped`,
 * `already-exists`, `not-empty`, `conflict`, `bad_request`, `editor_disabled`, a session-directory
 * code…) and `message` is its own sentence, already localized. Both are carried through untouched;
 * a refusal that carried no sentence has no `message` at all.
 *
 * `status` is the HTTP status as sent. It is kept because the server decides it once, from the
 * reason code (409 for a genuine state conflict, 404 for a path that resolves to nothing, 403 for
 * the closed gate) — a caller that wants the coarse shape of a refusal need not re-derive it.
 */
export interface RepoRefusal {
  ok: false
  failure: 'refused'
  status: number
  reason: string
  message?: string
}

/**
 * The request never got a usable answer. Three causes, kept apart because they send a reader
 * somewhere different: `network` (nothing answered — is the server running?), `timeout` (it is
 * answering, just not in time) and `malformed` (something answered and it was not this contract —
 * a proxy's error page, a version skew).
 */
export interface RepoUnreachable {
  ok: false
  failure: 'unreachable'
  cause: 'network' | 'timeout' | 'malformed'
}

export type RepoFailure = RepoRefusal | RepoUnreachable

export type TreeListResult = { ok: true; children: TreeChild[] } | RepoFailure

export type SearchResult = { ok: true; hits: SearchHit[]; truncated: boolean } | RepoFailure

/**
 * WHAT the Studio will show instead of refusing a binary file. Mirrors the server's own `MediaKind`
 * (`artifact-media.ts`), redeclared here for the reason `TreeChild` above is.
 */
export type RepoMediaKind = 'image' | 'video' | 'pdf'

export type ReadFileResult =
  | { ok: true; binary?: false; content: string; mtimeMs: number }
  /**
   * A BINARY file, and the server's verdict on whether it can be SHOWN.
   *
   * `media` is set when it will render, and is the kind. `mediaOverLimit` is set when it is one of
   * those kinds and is over that kind's ceiling, and carries the ceiling — which is what lets the
   * pane say WHICH limit refused it rather than falling back to the generic binary sentence. Both
   * absent is an ordinary binary (a `.zip`, a compiled binary), where that sentence is the right one.
   *
   * The ceiling is the SERVER's, reported rather than re-derived: a limit the browser applied would
   * be a second copy of a number `editor-media.ts` owns, and the two would drift.
   */
  | {
    ok: true; binary: true; name: string; size: number
    media?: RepoMediaKind
    mediaOverLimit?: { media: RepoMediaKind; limit: number }
  }
  | RepoFailure

/**
 * The write conflict, and the reason this whole module carries refusal bodies through whole: a
 * stale `mtimeMs` comes back 409 with the CURRENT on-disk content and mtime, and NOTHING WAS
 * WRITTEN. The UI's conflict prompt hangs off exactly this — use `isWriteConflict`, never a bare
 * `reason === 'conflict'` test, so a body that names the conflict without carrying the content it
 * needs can never be offered as one.
 */
export interface WriteConflict extends RepoRefusal {
  status: 409
  reason: 'conflict'
  content: string
  mtimeMs: number
}

export type WriteFileResult = { ok: true; mtimeMs: number } | WriteConflict | RepoFailure

export type EntryResult = { ok: true } | RepoFailure

export function isWriteConflict(result: WriteFileResult): result is WriteConflict {
  return result.ok === false
    && result.failure === 'refused'
    && result.status === 409
    && result.reason === 'conflict'
    && typeof (result as WriteConflict).content === 'string'
    && typeof (result as WriteConflict).mtimeMs === 'number'
}

/** How long any one call may take. A read, a write and a listing all answer in milliseconds. */
const TIMEOUT_MS = 15_000
/**
 * Search gets its own, longer ceiling: it may run `git grep` over a whole checkout (or, with no
 * git index to lean on, a bounded plain walk of up to 5000 files) before it answers.
 */
const SEARCH_TIMEOUT_MS = 30_000

/** `DOMException`'s own name for an `AbortSignal.timeout()` firing — the same test `api.ts` uses. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError'
}

type Body = Record<string, unknown>

/**
 * One request, one of the three outcomes.
 *
 * `shape` is what keeps a success honest: it is handed the parsed `ok: true` body and returns the
 * typed result, or `null` when the body does not carry what this route promised — which becomes
 * `malformed` rather than a success with holes in it.
 */
async function request<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  shape: (body: Body) => T | null,
): Promise<T | RepoFailure> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    return { ok: false, failure: 'unreachable', cause: isTimeout(err) ? 'timeout' : 'network' }
  }

  const parsed = await res.json().catch(() => null) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, failure: 'unreachable', cause: 'malformed' }
  }
  const body = parsed as Body

  if (body.ok === true) {
    const shaped = shape(body)
    return shaped ?? { ok: false, failure: 'unreachable', cause: 'malformed' }
  }
  return refusalOf(body, res.status)
}

/**
 * The server's refusal, carried through whole.
 *
 * The body is spread FIRST so a refusal's extra fields — the conflict's `content` and `mtimeMs` —
 * reach the caller without this module having to know about them; only the fields this contract
 * names are then fixed. `reason` comes from the body's own `reason`, falling back to `error`: the
 * closed gate in `index.ts` answers `{error: 'editor_disabled'}` and never reaches `editor-web.ts`,
 * so it is the one refusal on these routes shaped differently from every other. A body with
 * neither is not a refusal this module can report — there is nothing to tell the caller — so it is
 * `malformed`, which at least says that honestly.
 */
function refusalOf(body: Body, status: number): RepoFailure {
  const reason = typeof body.reason === 'string' ? body.reason
    : typeof body.error === 'string' ? body.error
      : null
  if (reason === null) return { ok: false, failure: 'unreachable', cause: 'malformed' }

  const refusal = { ...body, ok: false as const, failure: 'refused' as const, status, reason }
  // A `message` the server did not send (or did not send as a sentence) is not invented here.
  if (typeof body.message !== 'string') delete (refusal as { message?: unknown }).message
  // `error` has just been normalized INTO `reason`; leaving it would say the same thing twice,
  // under two names, and a caller reading the wrong one would be reading a shape only one route
  // ever produces.
  if (typeof body.reason !== 'string') delete (refusal as { error?: unknown }).error
  return refusal as RepoRefusal
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/**
 * The query string. `encodeURIComponent` rather than `URLSearchParams` so a path keeps its `%20`
 * instead of becoming `+` — both decode identically server-side, and the first stays readable in a
 * log and in a test. An `undefined` value is a parameter that is not sent at all.
 */
function qs(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
}

/** `GET /api/fleet/tree` — ONE directory's immediate children. The tree is lazy; this is a level. */
export async function fetchTree(sessionId: string, path: string, lang: RepoLang): Promise<TreeListResult> {
  return await request(
    `/api/fleet/tree?${qs({ id: sessionId, path, lang })}`,
    {},
    TIMEOUT_MS,
    body => (isChildList(body.children) ? { ok: true as const, children: body.children } : null),
  )
}

function isChildList(value: unknown): value is TreeChild[] {
  return Array.isArray(value) && value.every(c => (
    typeof c === 'object' && c !== null
    && typeof (c as TreeChild).name === 'string'
    && ((c as TreeChild).kind === 'file' || (c as TreeChild).kind === 'dir')
  ))
}

/**
 * `GET /api/fleet/tree/search` — names and content, capped.
 *
 * `truncated` is carried through because it is the difference between "that is everything" and
 * "this is the first 200 of more", and only a caller that receives it can say so.
 */
export async function searchRepo(sessionId: string, q: string, lang: RepoLang): Promise<SearchResult> {
  return await request(
    `/api/fleet/tree/search?${qs({ id: sessionId, q, lang })}`,
    {},
    SEARCH_TIMEOUT_MS,
    body => (isHitList(body.hits) && typeof body.truncated === 'boolean'
      ? { ok: true as const, hits: body.hits, truncated: body.truncated }
      : null),
  )
}

/** Same posture as `isChildList` above: a 200 whose `hits` are not shaped as promised is `malformed`. */
function isHitList(value: unknown): value is SearchHit[] {
  return Array.isArray(value) && value.every(h => (
    typeof h === 'object' && h !== null
    && typeof (h as SearchHit).path === 'string'
    && (
      ((h as NameHit).kind === 'name')
      || ((h as ContentHit).kind === 'content'
        && typeof (h as ContentHit).line === 'number'
        && typeof (h as ContentHit).text === 'string')
    )
  ))
}

/**
 * `GET /api/fleet/tree/file` — a file's text and the mtime to write back with.
 *
 * A BINARY file answers `{binary: true, name, size}` and no content, and that variant is carried
 * through as its own success: a binary file is not an empty one, and the editor must be able to
 * say which it is looking at. It may also carry the server's MEDIA verdict — whether this is an
 * image, a video or a PDF the panel will render, or one it refuses on size — see `ReadFileResult`.
 */
export async function readRepoFile(sessionId: string, path: string, lang: RepoLang): Promise<ReadFileResult> {
  return await request(
    `/api/fleet/tree/file?${qs({ id: sessionId, path, lang })}`,
    {},
    TIMEOUT_MS,
    body => {
      if (body.binary === true) {
        if (typeof body.name !== 'string' || typeof body.size !== 'number') return null
        const base = { ok: true as const, binary: true as const, name: body.name, size: body.size }
        // A media verdict is carried through only when it is WELL FORMED. A `media` field that is
        // not one of the three kinds, or an over-limit report with no number in it, is dropped — the
        // file then reads as an ordinary binary, which is the safe direction: the pane says it cannot
        // be opened rather than pointing an `<img>` at a route that will refuse it.
        if (isMediaKind(body.media)) return { ...base, media: body.media }
        const over = body.mediaOverLimit
        if (typeof over === 'object' && over !== null) {
          const { media, limit } = over as { media?: unknown; limit?: unknown }
          if (isMediaKind(media) && typeof limit === 'number') {
            return { ...base, mediaOverLimit: { media, limit } }
          }
        }
        return base
      }
      return typeof body.content === 'string' && typeof body.mtimeMs === 'number'
        ? { ok: true as const, content: body.content, mtimeMs: body.mtimeMs }
        : null
    },
  )
}

function isMediaKind(value: unknown): value is RepoMediaKind {
  return value === 'image' || value === 'video' || value === 'pdf'
}

/**
 * `PUT /api/fleet/tree/file` — the CONFLICT route.
 *
 * `mtimeMs` is the mtime the file had when it was READ, not a new one: the server compares it with
 * what is on disk and refuses the write outright if they disagree, answering 409 with the current
 * content. On success the answer is the mtime the file now has, which is what the next write must
 * be handed.
 */
export async function writeRepoFile(
  sessionId: string, path: string, content: string, mtimeMs: number, lang: RepoLang,
): Promise<WriteFileResult> {
  return await request(
    `/api/fleet/tree/file?${qs({ id: sessionId, path, lang })}`,
    { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ content, mtimeMs }) },
    TIMEOUT_MS,
    body => (typeof body.mtimeMs === 'number' ? { ok: true as const, mtimeMs: body.mtimeMs } : null),
  )
}

/**
 * `POST /api/fleet/tree/entry` — create a file or a directory.
 *
 * The session id travels in the BODY here (and for the rename), not the query string — that is how
 * the route reads it. `lang` stays on the URL for every method, because the server reads it off
 * `url.searchParams` regardless of verb.
 */
export async function createRepoEntry(
  sessionId: string, path: string, kind: 'file' | 'dir', lang: RepoLang,
): Promise<EntryResult> {
  return await request(
    `/api/fleet/tree/entry?${qs({ lang })}`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ id: sessionId, path, kind }) },
    TIMEOUT_MS,
    () => ({ ok: true as const }),
  )
}

/** `PATCH /api/fleet/tree/entry` — rename or move, within the session's own folder. */
export async function renameRepoEntry(
  sessionId: string, from: string, to: string, lang: RepoLang,
): Promise<EntryResult> {
  return await request(
    `/api/fleet/tree/entry?${qs({ lang })}`,
    { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ id: sessionId, from, to }) },
    TIMEOUT_MS,
    () => ({ ok: true as const }),
  )
}

/**
 * `DELETE /api/fleet/tree/entry` — and `recursive` is a DELIBERATE second ask.
 *
 * Without it a non-empty directory is refused (`not-empty`), which is the server telling the user
 * what they are about to do rather than doing it. The flag is sent only when it is true, so a
 * plain delete cannot be read as one that opted in.
 */
export async function deleteRepoEntry(
  sessionId: string, path: string, recursive: boolean, lang: RepoLang,
): Promise<EntryResult> {
  const query = qs({ id: sessionId, path, lang, recursive: recursive ? '1' : undefined })
  return await request(
    `/api/fleet/tree/entry?${query}`,
    { method: 'DELETE' },
    TIMEOUT_MS,
    () => ({ ok: true as const }),
  )
}

/**
 * delivery/antigas.ts — PURE. CICLO.RECONCILE-2: which pieces of the "Revisão do líder" column are NOT review work.
 *
 * A legacy piece (board status `in_review`, no delivery record) that has no live session, has not been touched for over
 * `ANTIGA_AFTER_MS` and that the reconcile could not prove shipped leaves the column for the collapsed group
 * "Antigas sem registro" on the Live, with one-click actions ("Marcar publicado", "Arquivar"). Nothing is ever deleted.
 * A recent piece, a piece with a live session and a piece with a delivery record stay in review.
 */

/** A record-less in-review piece with no live session older than this is "antiga" (owner 08/11: 24 h). */
export const ANTIGA_AFTER_MS = 24 * 3600_000
/** The backfill adopts a record-less piece only when the board touched it within this window (or a release PR names it). */
export const RECONCILE_SCOPE_MS = 30 * 24 * 3600_000

export interface ReviewPieceFacts {
  /** A delivery record exists for the piece (the flow has its own evidence). */
  hasRecord: boolean
  /** A session of the piece is alive right now. */
  live: boolean
  /** When the board last touched the piece (ms); null = unknown. */
  updatedMs: number | null
  nowMs: number
}

/** PURE. Is this record-less piece in review "antiga" (no record, nobody alive on it, untouched for over 24 h)? */
export function isAntiga(f: ReviewPieceFacts): boolean {
  if (f.hasRecord || f.live) return false
  // An unknown age is NOT old: a piece whose date cannot be read stays where it is (never moved on a guess).
  if (f.updatedMs === null) return false
  return f.nowMs - f.updatedMs > ANTIGA_AFTER_MS
}

/**
 * PURE. May the backfill adopt (look up the PR of) this piece? A piece with a record, one the board touched in the last
 * 30 days, or one a release PR mentions. Everything older goes straight to "antigas" with no gh call spent on it.
 */
export function inReconcileScope(f: ReviewPieceFacts & { mentioned: boolean }): boolean {
  if (f.hasRecord || f.mentioned) return true
  if (f.updatedMs === null) return true
  return f.nowMs - f.updatedMs <= RECONCILE_SCOPE_MS
}

export type AntigaAction = 'publish' | 'archive'

/** PURE. The comment a one-click action leaves on the piece (the reason is the owner's/leader's, never invented). */
export function antigaComment(action: AntigaAction, o: { version?: string; reason?: string }): string {
  return action === 'publish'
    ? `[fluxo entrega] marcada como publicada${o.version ? ` na v${o.version}` : ''} (antiga sem registro, ação manual).`
    : `[fluxo entrega] arquivada (abandonada): antiga sem registro${o.reason ? ` — ${o.reason}` : ''}.`
}

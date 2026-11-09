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
/** A delivery that reported to its leader this recently is waiting for a decision, whatever its age otherwise. */
export const DELIVERY_WAITS_MS = 7 * 24 * 3600_000
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
  /** When its delivery last reported to its leader (a handback), if ever: real work waiting on a person is not old by age alone. */
  handbackMs?: number | null
  /** The last reconcile suspects it shipped (weak evidence): then it is a decision to make, not work still waiting. */
  suggested?: boolean
  /** The last lookup was incomplete; no-repos is normal and remains eligible for a manual decision. */
  unchecked?: boolean
  uncheckedWhy?: 'no-repos' | 'gh' | 'budget'
  proven?: boolean
  status?: string
  hasOpenChildren?: boolean
}

/**
 * PURE. Is this record-less piece in review "antiga"? No record, nobody alive on it, untouched for over 24 h AND no delivery
 * statement waiting on its leader (M1, leader 08/11: age alone must not take real pending work out of the column). A handback older
 * than `DELIVERY_WAITS_MS` went unanswered and joins the group, where it is a 1-click decision, never a silent one.
 */
export function isAntiga(f: ReviewPieceFacts): boolean {
  if (f.hasRecord || f.live || f.proven || f.hasOpenChildren || (f.status !== undefined && f.status !== 'in_review')) return false
  // No repository is normal for non-code work. It prevents publication proof, not a manual decision.
  if (f.unchecked && f.uncheckedWhy !== 'no-repos') return false
  // An unknown age is NOT old: a piece whose date cannot be read stays where it is (never moved on a guess).
  if (f.updatedMs === null) return false
  if (!f.suggested && f.handbackMs != null && f.nowMs - f.handbackMs <= DELIVERY_WAITS_MS) return false
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

export type AntigaAction = 'publish' | 'archive' | 'conclude'

/** PURE. The comment a one-click action leaves on the piece (the reason is the owner's/leader's, never invented). */
export function antigaComment(action: AntigaAction, o: { version?: string; reason?: string }): string {
  return action === 'publish'
    ? `[fluxo entrega] marcada como concluída sem prova de release${o.version ? ` (versão informada: v${o.version})` : ''} (antiga sem registro, ação manual).`
    : `[fluxo entrega] arquivada (abandonada): antiga sem registro${o.reason ? ` — ${o.reason}` : ''}.`
}

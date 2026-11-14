/**
 * delivery/classify-guard.ts — classification AT the guarded move (spec §3.2: "at every guarded move, not only in the
 * salvo gate — r1's flaw").
 *
 * `guardedReviewEntry` is the composition the S2a store guard will call for a rank-1 (review) entry: gather the piece's
 * facts NOW, classify, check the evidence requirement against THAT head, and only then run the §2.6 sequence
 * (`applyGuardedWrite`: intent → documents → checkpoint). Any refusal returns before a single byte of either document is
 * touched and before guards.json exists. The checkpoint it writes carries `auth: evidence` with the ids and hashes, and the
 * classification (with the leader's declaration when one was needed).
 */
import { classifyPiece, evaluateEvidence, type Classification } from './classify'
import { gatherFacts, type ClassifyDeps } from './classify-host'
import { declareClassification } from './classify-declare'
import type { EvidenceItem } from './evidence'
import { applyGuardedWrite, type PieceCheckpoint } from './guards-store'
import type { GuardLockName, GuardLockPaths } from './guard-locks'

export interface ClassificationDeclaration { by: string; repo: string; head: string; category: string; at: string }

export interface ReviewEntry {
  deps: ClassifyDeps
  piece: { taskId: string; subtaskId?: string }
  /** The checkpoint / delivery key (the subtask id, or the task id for a task-level piece). */
  key: string
  revision: number
  items: readonly EvidenceItem[]
  now: string
  paths: GuardLockPaths
  /** The lock set the CALLER holds / takes (S2a passes tasks→deliveries→guards with `alreadyHeld` for what the store hook already owns). No default: a wrong default here is a deadlock or a lost order. */
  locks: readonly GuardLockName[]
  alreadyHeld?: readonly GuardLockName[]
  /** A leader's accepted declaration: used ONLY when the live checkout cannot be resolved. */
  declared?: ClassificationDeclaration
  checkpoint: Pick<PieceCheckpoint, 'boardStatus' | 'boardStage' | 'phase' | 'by' | 'transitionId'>
  /** The document write(s); runs after the intent is durable. */
  writeDocuments: () => Promise<void>
  /** Test seam (a crash point), forwarded to `applyGuardedWrite`. */
  afterDocuments?: () => void | Promise<void>
}

export type ReviewRefusal = { ok: false; code: string; message: string; messagePt: string; missing?: string[]; paths?: string[]; rule?: string; nonCodeOnly?: boolean }
export type ReviewResult = { ok: true; classification: Extract<Classification, { ok: true }>; checkpoint: PieceCheckpoint } | ReviewRefusal

export async function guardedReviewEntry(o: ReviewEntry): Promise<ReviewResult> {
  let c = classifyPiece(await gatherFacts(o.deps, o.piece))
  let declared: ClassificationDeclaration | undefined
  // A declaration names where to look; it only stands in when the live checkout is unresolvable (a removed worktree, a
  // session filed late). It never overrides a checkout the server CAN read, and never supplies the category itself.
  if (!c.ok && c.code === 'classification_required' && o.declared) {
    // The persisted declaration is only a POINTER (repo + head). The classification is RE-DERIVED from that repository and
    // commit now — it must exist and be reachable from a remote branch — and the whole derived result is used (including the
    // structural-probe allowance). `declared.category` is audit data and is never read here.
    const again = await declareClassification(o.deps, { piece: o.piece, repo: o.declared.repo, head: o.declared.head })
    if (!again.ok) {
      return { ok: false, code: 'classification_required', message: `The leader's classification declaration no longer holds (${again.code}): ${again.message}`, messagePt: `A declaração de classificação do líder não vale mais (${again.code}): ${again.message}` }
    }
    declared = { ...o.declared, head: again.declaration.head, category: again.declaration.category }
    c = again.classification
  }
  if (!c.ok) return c
  const ev = evaluateEvidence(c, o.items)
  if (!ev.ok) return ev
  const target: PieceCheckpoint = {
    key: o.key, rank: 1, boardStatus: o.checkpoint.boardStatus, boardStage: o.checkpoint.boardStage, phase: o.checkpoint.phase,
    revision: o.revision, headSha: c.headSha,
    auth: [{ kind: 'evidence', ids: ev.ids, sha256: o.items.filter(i => ev.ids.includes(i.id)).map(i => i.sha256) }],
    by: o.checkpoint.by, at: o.now, transitionId: o.checkpoint.transitionId,
    classification: { category: c.category, headSha: c.headSha, ...(declared ? { declared: { by: declared.by, repo: declared.repo, head: declared.head, at: declared.at } } : {}) },
  }
  await applyGuardedWrite({
    locks: o.locks, ...(o.alreadyHeld ? { alreadyHeld: o.alreadyHeld } : {}), paths: o.paths, piece: o.key, target, now: o.now,
    writeDocuments: o.writeDocuments, ...(o.afterDocuments ? { afterDocuments: o.afterDocuments } : {}),
  })
  return { ok: true, classification: c, checkpoint: target }
}

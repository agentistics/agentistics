/**
 * delivery/sweep.ts — the logic of the guard sweep (ENTREGA.GARANTIDA §2.6 / §2.6.1, S2b), run by the minute tick.
 *
 * One pass, under the full envelope (tasks → deliveries → guards, 5 s each, fail closed — a busy file SKIPS the tick, it never
 * proceeds unguarded):
 *
 *   1. INTENT RECOVERY  an intent left by a crash is COMMITTED when the documents already show its target and DROPPED when they
 *                       do not — before anything is judged, so a legitimate move that crashed before its commit is never
 *                       reverted as if it were forged.
 *   2. PLAN             `planSweep` (pure) over EVERY piece: no "changed since" filter, no event needed.
 *   3. BATCH REVERT     every revert of the tick lands in ONE write per document (tasks.json, deliveries.json); there is no cap.
 *                       A revert only LOWERS a rank, so it needs no guard context and cannot be refused by the guard.
 *   4. BOARD CATCH-UP   a board below the checkpoint while the phase is at it is brought up (a failed board effect, not a violation).
 *   5. LOOP GUARD       a piece reverted twice in 24 h is moved to `blocked` (`externo: an unknown writer keeps moving this piece`).
 *
 * Rule `off`: this module does NOTHING (no read, no lock). Rule `shadow`: report-only (`would-revert`), nothing is written but
 * the recovery of intents a crash left. Every revert names the escape — `agentop flow guarantee off a` — in both languages.
 *
 * Everything with side effects is INJECTED by the service (which already holds the stores): this module imports no store, lock
 * or file module, so the writer inventories (`doors.lint`) see it as the pure logic it is.
 */
import { boardPieces, phaseRank, type BoardSlice } from './guard'
import { planBlock, type DeliveryRecord } from './machine'
import { LOOP_BLOCK_TEXT, SWEEP_ESCAPE, SWEEP_ESCAPE_PT, emptyMemory, planSweep, type PieceCheckpointLike, type PieceView, type SweepMemory, type SweepRevert } from './sweep-plan'

interface BoardBook { tasks: BoardSlice['tasks']; subtasks: BoardSlice['subtasks']; statuses: Array<BoardSlice['statuses'][number]> }
export interface SweepGuardsDoc { checkpoints: Record<string, PieceCheckpointLike>; intents: Record<string, { transitionId: string; target: PieceCheckpointLike }>; sweep?: SweepMemory; [k: string]: unknown }
export interface SweepDeps {
  /** The rule A state (authenticated). `off`: the sweep does nothing at all. */
  rule: () => Promise<'off' | 'shadow' | 'on'>
  /** Runs `fn` under the full envelope (tasks → deliveries → guards, 5 s each); a busy file throws GuardBusy. */
  envelope: <T>(fn: () => Promise<T>) => Promise<T>
  guards: { read(): Promise<SweepGuardsDoc>; write(doc: SweepGuardsDoc): Promise<void> }
  /** The mirror of each status's stored stage (a downgrade can strip them from tasks.json). */
  statusStages: () => Promise<Record<string, string> | undefined>
  tasks: {
    read(): Promise<BoardBook>
    applyBoardReverts(batch: { at: string; reverts: Array<{ key: string; subtaskId?: string; to: string; clearCi: boolean }>; comments: never[]; events: never[] }): Promise<void>
  }
  store: { read(): Promise<{ deliveries: Record<string, DeliveryRecord> }>; update(fn: (doc: { deliveries: Record<string, DeliveryRecord> }) => void, opts: { guard: unknown }): Promise<unknown> }
  /** The flow engine's context: a revert only lowers a rank, but every delivery write says who is asking. */
  guard: unknown
  /** Ids for the comment and event a revert leaves on the board. */
  ids: { comment: () => string; event: () => string }
  /** `effectiveSubtasks`: the derived group status the guard itself judges. */
  effective: (subtasks: BoardBook['subtasks']) => BoardBook['subtasks']
  now: () => number
  /** Finishes the board effect a failed transition left behind (`setPhaseStatus`); absent = no catch-up. */
  catchUp?: (key: string, phase: string) => Promise<{ ok: boolean }>
  log?: (line: string) => void
}

const ACTOR = 'flow:sweep'
const REASON_EN: Record<SweepRevert['reason'], string> = {
  above_checkpoint: 'it moved above what its checkpoint authorized',
  no_checkpoint: 'it moved forward with no authorization on record',
  evidence_stale: 'the evidence that authorized it no longer holds (gone, other bytes, an earlier round or a moved HEAD)',
}
const REASON_PT: Record<SweepRevert['reason'], string> = {
  above_checkpoint: 'avançou acima do que o checkpoint autorizou',
  no_checkpoint: 'avançou sem nenhuma autorização registrada',
  evidence_stale: 'a evidência que o autorizou não vale mais (sumiu, outros bytes, rodada anterior ou HEAD mudou)',
}

const textOf = (r: SweepRevert) =>
  `[fluxo entrega] guard sweep reverted ${r.key}: ${REASON_EN[r.reason]}${r.loop ? `; it was reverted ${r.count} times in 24 h, so it is now blocked (externo: an unknown writer keeps moving this piece)` : ''}. ${SWEEP_ESCAPE}`
  + ` | varredura do guarda reverteu ${r.key}: ${REASON_PT[r.reason]}${r.loop ? `; foi revertida ${r.count} vezes em 24 h, então agora está bloqueada (externo: um escritor desconhecido continua movendo esta peça)` : ''}. ${SWEEP_ESCAPE_PT}`

/** Pure over the two documents: every piece either of them (or a checkpoint) mentions, as the sweep reads it. */
export function viewsOf(slice: BoardSlice, records: Readonly<Record<string, DeliveryRecord>>, keys: Iterable<string>): PieceView[] {
  const board = new Map(boardPieces(slice).map(p => [p.key, p] as const))
  const wanted = new Set<string>([...keys, ...board.keys(), ...Object.keys(records)])
  const out: PieceView[] = []
  for (const key of wanted) {
    const b = board.get(key)
    const r = records[key] ?? null
    if (!b && !r) continue
    out.push({
      key, taskId: b?.taskId ?? r!.taskId, ...(b?.subtaskId ? { subtaskId: b.subtaskId } : {}),
      boardStatus: b?.status ?? null, boardRank: b?.statusRank ?? 0, ciRank: b?.ciRank ?? 0,
      record: r && { phase: r.phase, revision: r.revision, ...(r.headSha ? { headSha: r.headSha } : {}), evidence: r.evidence ?? [], history: r.history ?? [] },
    })
  }
  return out
}

/** Do the documents already show what an intent was about to write? Only then does a crash's intent become a checkpoint. */
export function documentsShow(target: PieceCheckpointLike, views: ReadonlyMap<string, PieceView>): boolean {
  const v = views.get(target.key)
  if (!v) return false
  if (!target.boardStatus && !target.phase) return false
  if (target.boardStatus && v.boardStatus !== target.boardStatus) return false
  if (target.phase && v.record?.phase !== target.phase) return false
  return true
}

export async function guardSweep(d: SweepDeps, actions: string[]): Promise<void> {
  const rule = await d.rule()
  if (rule === 'off') return
  await d.envelope(async () => {
    let doc = await d.guards.read()
    const book = await d.tasks.read()
    const ddoc = await d.store.read()
    const stages = await d.statusStages()
    const statuses = book.statuses.map(s => ({ ...s, stage: s.stage ?? stages?.[s.id] }))
    const slice: BoardSlice = { tasks: book.tasks, subtasks: d.effective(book.subtasks), statuses }
    const views = viewsOf(slice, ddoc.deliveries, Object.keys(doc.checkpoints))
    const byKey = new Map(views.map(v => [v.key, v] as const))

    // 1. a crash between the documents and the checkpoint commit: commit what the documents show, drop what they do not.
    let recovered = false
    for (const [key, intent] of Object.entries(doc.intents)) {
      const { [key]: _gone, ...rest } = doc.intents
      if (documentsShow(intent.target, byKey)) { doc = { ...doc, checkpoints: { ...doc.checkpoints, [key]: intent.target }, intents: rest }; actions.push(`sweep-intent-committed ${key}`) }
      else { doc = { ...doc, intents: rest }; actions.push(`sweep-intent-dropped ${key}`) }
      recovered = true
    }
    if (recovered) await d.guards.write(doc)

    // 2. judge every piece against its checkpoint.
    const at = new Date(d.now()).toISOString()
    const plan = planSweep({ pieces: views, checkpoints: doc.checkpoints, statuses, memory: doc.sweep ?? emptyMemory(), now: d.now() })
    if (rule === 'shadow') {
      for (const r of plan.reverts) actions.push(`sweep would-revert ${r.key}: ${r.reason}`)
      return
    }

    // 3. one write per document.
    const loops: string[] = []
    if (plan.reverts.some(r => r.delivery)) {
      await d.store.update(x => {
        for (const r of plan.reverts) {
          const rec = x.deliveries[r.key]
          if (!r.delivery || !rec) continue
          x.deliveries[r.key] = retreat(rec, r, at)
        }
      }, { guard: d.guard })
    }
    if (plan.reverts.length > 0) {
      const comments: unknown[] = [], events: unknown[] = []
      for (const r of plan.reverts) {
        comments.push({ id: d.ids.comment(), taskId: r.taskId, ...(r.subtaskId ? { subtaskId: r.subtaskId } : {}), author: 'flow:entrega', body: textOf(r), createdAt: at })
        events.push({ id: d.ids.event(), taskId: r.taskId, ...(r.subtaskId ? { subtaskId: r.subtaskId } : {}), at, actor: ACTOR, kind: 'status', detail: `sweep revert: ${r.reason}`, ...(r.board ? { to: r.loop ? 'blocked' : r.board.to } : {}) })
        actions.push(`sweep-revert ${r.key}: ${r.reason}${r.loop ? ' (loop: blocked)' : ''}`)
        if (r.loop) loops.push(r.key)
      }
      await d.tasks.applyBoardReverts({
        at,
        reverts: plan.reverts.filter(r => r.board).map(r => ({ key: r.key, ...(r.subtaskId ? { subtaskId: r.subtaskId } : {}), to: r.loop ? 'blocked' : r.board!.to, clearCi: r.board!.clearCi })),
        comments: comments as never[], events: events as never[],
      })
    }
    // The memory is written AFTER the documents: a crash in between loses one count, never invents one.
    if (plan.reverts.length > 0 || JSON.stringify(plan.memory) !== JSON.stringify(doc.sweep ?? emptyMemory())) await d.guards.write({ ...(await d.guards.read()), sweep: plan.memory })
    for (const key of loops) d.log?.(`[guard] sweep-loop: ${key} keeps being moved by an unknown writer and was blocked — ${SWEEP_ESCAPE}`)

    // 4. the board effect that failed: finish it (never a violation).
    for (const c of plan.catchUps) {
      try { const out = await d.catchUp?.(c.key, c.phase); if (out?.ok) actions.push(`sweep-catch-up ${c.key} → ${c.phase}`) } catch { /* the next tick tries again */ }
    }
  })
}

/**
 * The delivery record after a revert: the phase goes back and the history keeps the fact (append-only). A retreat to a RANK-0 phase
 * bumps the revision (an `ajuste` starts a new capture round). A retreat to a RANKED phase keeps it: the guard reads a changed
 * revision on a ranked phase as a new binding that needs fresh evidence, and a revert restores what was already authorized.
 */
function retreat(r: DeliveryRecord, rv: SweepRevert, at: string): DeliveryRecord {
  const next = structuredClone(r)
  const to = rv.delivery!.to as DeliveryRecord['phase']
  const revision = phaseRank(to) === 0 ? r.revision + 1 : r.revision
  next.history = [...r.history, { from: r.phase, to, at, actor: ACTOR, detail: `sweep revert: ${rv.reason}`, revision }]
  next.phase = to
  next.revision = revision
  next.updatedAt = at
  if (phaseRank(to) < 3) delete next.ci
  if (phaseRank(to) < 2) delete next.mergeSha
  if (rv.loop) {
    const blocked = planBlock(next, 'externo', LOOP_BLOCK_TEXT, { at, actor: ACTOR, autonomous: true })
    if (blocked.ok) return blocked.next
  }
  return next
}

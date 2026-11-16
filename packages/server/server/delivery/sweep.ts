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
import { LOOP_BLOCK_TEXT, SWEEP_ESCAPE, SWEEP_ESCAPE_PT, SWEEP_LOOP_WINDOW_MS, emptyMemory, planSweep, type PieceCheckpointLike, type PieceView, type SweepMemory, type SweepRevert } from './sweep-plan'

interface BoardBook { tasks: BoardSlice['tasks']; subtasks: BoardSlice['subtasks']; statuses: Array<BoardSlice['statuses'][number]> }
export interface SweepGuardsDoc { checkpoints: Record<string, PieceCheckpointLike>; intents: Record<string, { transitionId: string; target: PieceCheckpointLike }>; migrations?: { a?: { version: 1; at: string } }; sweep?: SweepMemory; [k: string]: unknown }
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
  catchUp?: (key: string, phase: string) => Promise<{ ok: boolean; code?: string; message?: string }>
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
export function viewsOf(slice: BoardSlice, records: Readonly<Record<string, DeliveryRecord>>, keys: Iterable<string>, effective: BoardSlice = slice): PieceView[] {
  // A group's status is derived. Judge the stored member statuses against the group's checkpoint.
  const groups = new Set(slice.subtasks.flatMap(s => s.parentGroupId ? [s.parentGroupId] : []))
  const parentOf = new Map(slice.subtasks.map(s => [s.id, s.parentGroupId]))
  const raw = { ...slice, subtasks: slice.subtasks.filter(s => !groups.has(s.id)).map(s => ({ ...s, parentGroupId: undefined })) }
  const board = new Map([...boardPieces(raw), ...boardPieces(effective).filter(p => groups.has(p.key))].map(p => [p.key, p] as const))
  const wanted = new Set<string>([...keys, ...board.keys(), ...Object.keys(records)])
  const out: PieceView[] = []
  for (const key of wanted) {
    const b = board.get(key)
    const r = records[key] ?? null
    if (!b && !r) continue
    out.push({
      key, taskId: b?.taskId ?? r!.taskId, ...(b?.subtaskId ? { subtaskId: b.subtaskId } : {}),
      ...(parentOf.get(key) ? { checkpointKey: parentOf.get(key), authorizationRecord: records[parentOf.get(key)!] ?? null } : {}),
      ...(groups.has(key) ? { derived: true } : {}),
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
    const slice: BoardSlice = { tasks: book.tasks, subtasks: book.subtasks, statuses }
    const views = viewsOf(slice, ddoc.deliveries, Object.keys(doc.checkpoints), { ...slice, subtasks: d.effective(book.subtasks) })
    const byKey = new Map(views.map(v => [v.key, v] as const))
    const recoveryViews = new Map(viewsOf({ ...slice, subtasks: d.effective(book.subtasks).filter(s => !s.parentGroupId) }, ddoc.deliveries, Object.keys(doc.intents)).map(v => [v.key, v] as const))

    // 1. a crash between the documents and the checkpoint commit: commit what the documents show, drop what they do not.
    let recovered = false
    const recoveryActions: string[] = []
    for (const [key, intent] of Object.entries(doc.intents)) {
      const { [key]: _gone, ...rest } = doc.intents
      if (documentsShow(intent.target, recoveryViews)) { doc = { ...doc, checkpoints: { ...doc.checkpoints, [key]: intent.target }, intents: rest }; recoveryActions.push(`sweep-intent-committed ${key}`) }
      else { doc = { ...doc, intents: rest }; recoveryActions.push(`sweep-intent-dropped ${key}`) }
      recovered = true
    }

    // 2. judge every piece against its checkpoint.
    const at = new Date(d.now()).toISOString()
    const plan = planSweep({ pieces: views, checkpoints: doc.checkpoints, statuses, memory: doc.sweep ?? emptyMemory(), now: d.now() })
    if (rule === 'shadow') {
      actions.push(...recoveryActions.map(a => a.replace('sweep-intent-', 'sweep would-recover-intent-')))
      for (const r of plan.reverts) actions.push(`sweep would-revert ${r.key}: ${r.reason}`)
      return
    }
    const noCheckpoint = plan.reverts.filter(r => r.reason === 'no_checkpoint').length
    const skipped = !doc.migrations?.a ? 'migration_missing' : noCheckpoint > 20 || noCheckpoint > views.length * 0.05 ? 'no_checkpoint_breaker' : null
    if (skipped) {
      actions.push(`sweep-skipped: ${skipped}`)
      d.log?.(`[guard] WARN sweep-skipped: ${skipped} (${noCheckpoint}/${views.length}); ${SWEEP_ESCAPE}`)
      // No document, checkpoint, memory or comment write in report-only mode.
      return
    }
    if (recovered) await d.guards.write(doc)
    actions.push(...recoveryActions)

    // A no-op plan must never keep appending notes on a derived status. Remember its actual before/target.
    const signatures = Object.fromEntries(plan.reverts.map(r => {
      const v = byKey.get(r.key)!
      return [r.key, JSON.stringify([v.boardStatus, v.boardRank, v.ciRank, v.record?.phase, v.record?.revision, r.board, r.delivery])]
    }))
    const proposed = new Map(plan.reverts.filter(r => r.board).map(r => [r.key, r]))
    const projectedSubs = book.subtasks.map(s => {
      const r = proposed.get(s.id)
      return r ? { ...s, status: r.loop ? 'blocked' : r.board!.to, ...(r.board!.clearCi ? { ci: null } : {}) } : s
    })
    const derivedRanks = (subs: BoardBook['subtasks']) => new Map(boardPieces({ ...slice, subtasks: d.effective(subs) }).map(p => [p.key, Math.max(p.statusRank, p.ciRank)]))
    const beforeRanks = derivedRanks(book.subtasks), afterRanks = derivedRanks(projectedSubs)
    plan.reverts = plan.reverts.filter(r => {
      if (doc.sweep?.plans?.[r.key] !== signatures[r.key]) return true
      const view = byKey.get(r.key)!
      const parent = view.checkpointKey
      if (!parent || r.delivery || beforeRanks.get(parent) !== afterRanks.get(parent)) return true
      // Nothing about the group's derived rank would change; do not repeat last tick's ineffective plan.
      const retained = (doc.sweep?.reverts[r.key] ?? []).filter(s => d.now() - Date.parse(s) < SWEEP_LOOP_WINDOW_MS)
      if (retained.length) plan.memory.reverts[r.key] = retained
      else delete plan.memory.reverts[r.key]
      return false
    })
    if (Object.keys(signatures).length) plan.memory.plans = signatures

    // 3. one write per document.
    const loops: string[] = []
    const recordReverts = new Map<string, SweepRevert>()
    for (const r of plan.reverts) {
      const key = r.deliveryKey ?? r.key
      if ((!r.delivery && !r.loop) || !ddoc.deliveries[key]) continue
      const prior = recordReverts.get(key)
      recordReverts.set(key, { ...(r.delivery ? r : prior ?? r), ...((prior?.loop || r.loop) ? { loop: true } : {}) })
    }
    if (recordReverts.size) {
      await d.store.update(x => {
        for (const [key, r] of recordReverts) {
          const rec = x.deliveries[key]
          if (!rec) continue
          x.deliveries[key] = retreat(rec, r, at)
        }
      }, { guard: d.guard })
    }
    if (plan.reverts.length > 0) {
      const comments: unknown[] = [], events: unknown[] = []
      for (const r of plan.reverts) {
        comments.push({ id: d.ids.comment(), taskId: r.taskId, ...(r.subtaskId ? { subtaskId: r.subtaskId } : {}), author: 'flow:entrega', body: textOf(r), createdAt: at })
        const oldDeliveredAt = book.subtasks.find(s => s.id === r.key) as { deliveredAt?: string } | undefined
        events.push({ id: d.ids.event(), taskId: r.taskId, ...(r.subtaskId ? { subtaskId: r.subtaskId } : {}), at, actor: ACTOR, kind: 'status', detail: `sweep revert: ${r.reason}${oldDeliveredAt?.deliveredAt ? `; previous deliveredAt: ${oldDeliveredAt.deliveredAt}` : ''}`, ...(r.board ? { to: r.loop ? 'blocked' : r.board.to } : {}) })
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
    if (loops.length) d.log?.(`[guard] WARN sweep-loop: ${loops.join(', ')} keep being moved by an unknown writer and were blocked; um escritor desconhecido continua movendo estas peças — ${SWEEP_ESCAPE}`)

    // 4. the board effect that failed: finish it (never a violation).
    const failures: Record<string, string> = {}
    for (const c of plan.catchUps) {
      let code: string | undefined
      try { const out = await d.catchUp?.(c.key, c.phase); if (out?.ok) actions.push(`sweep-catch-up ${c.key} → ${c.phase}`); else code = out?.code ?? out?.message?.split(':')[0] ?? 'catch_up_unavailable' }
      catch (e) { code = (e as { code?: string }).code ?? 'internal_error' }
      if (code) {
        failures[c.key] = code
        if (doc.sweep?.catchUpFailures?.[c.key] !== code) { const line = `sweep-catch-up-failed ${c.key}: ${code}`; actions.push(line); d.log?.(line) }
      }
    }
    if (Object.keys(failures).length) plan.memory.catchUpFailures = failures
    if (plan.reverts.length > 0 || JSON.stringify(plan.memory) !== JSON.stringify(doc.sweep ?? emptyMemory())) await d.guards.write({ ...(await d.guards.read()), sweep: plan.memory })
  })
}

/**
 * The delivery record after a revert: the phase goes back and the history keeps the fact (append-only). A retreat to a RANK-0 phase
 * bumps the revision (an `ajuste` starts a new capture round). A retreat to a RANKED phase keeps it: the guard reads a changed
 * revision on a ranked phase as a new binding that needs fresh evidence, and a revert restores what was already authorized.
 */
function retreat(r: DeliveryRecord, rv: SweepRevert, at: string): DeliveryRecord {
  const next = structuredClone(r)
  const to = (rv.delivery?.to ?? r.phase) as DeliveryRecord['phase']
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

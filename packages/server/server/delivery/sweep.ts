/**
 * delivery/sweep.ts — the logic of the guard sweep (ENTREGA.GARANTIDA §2.6 / §2.6.1, S2b), run by the minute tick.
 *
 * Plan outside the locks, then revalidate and apply bounded chunks under tasks → deliveries → guards (5 s acquisition
 * timeout, fail closed). The service tick never wraps this work and session wakes in one long envelope.
 *
 *   1. INTENT RECOVERY  an intent left by a crash is COMMITTED when the documents already show its target and DROPPED when they
 *                       do not — before anything is judged, so a legitimate move that crashed before its commit is never
 *                       reverted as if it were forged.
 *   2. PLAN             `planSweep` (pure) over EVERY piece: no "changed since" filter, no event needed.
 *   3. BATCH REVERT     each chunk lands in ONE write per document; every revert kind counts toward the tick's breaker.
 *                       A revert only LOWERS a rank, so it needs no guard context and cannot be refused by the guard.
 *   4. BOARD CATCH-UP   a board below the checkpoint while the phase is at it is brought up (a failed board effect, not a violation).
 *   5. LOOP GUARD       a piece reverted twice in 24 h is moved to `blocked` (`externo: an unknown writer keeps moving this piece`).
 *
 * Rule `off`: this module does NOTHING (no read, no lock). Rule `shadow`: report-only (`would-revert`, `would-recover-intent`),
 * nothing is written. Every revert names the escape — `agentop flow guarantee off a` — in both languages.
 *
 * Everything with side effects is INJECTED by the service (which already holds the stores): this module imports no store, lock
 * or file module, so the writer inventories (`doors.lint`) see it as the pure logic it is.
 */
import { boardPieces, phaseRank, type BoardSlice } from './guard'
import { planBlock, type DeliveryRecord } from './machine'
import { LOOP_BLOCK_TEXT, SWEEP_ESCAPE, SWEEP_ESCAPE_PT, emptyMemory, planSweep, type PieceCheckpointLike, type PieceView, type SweepMemory, type SweepRevert } from './sweep-plan'

export const SWEEP_CHUNK_SIZE = 4

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
  catchUp?: (key: string, phase: string, unchanged: () => Promise<boolean>) => Promise<{ ok: boolean; code?: string; message?: string }>
  log?: (line: string) => void
  /** A breaker episode notifies task leaders once, after releasing every file lock. */
  notifyLeaders?: (taskIds: string[], text: string) => Promise<void>
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
      ...(parentOf.get(key) ? { checkpointKey: parentOf.get(key), groupRank: Math.max(board.get(parentOf.get(key)!)?.statusRank ?? 0, board.get(parentOf.get(key)!)?.ciRank ?? 0), authorizationRecord: records[parentOf.get(key)!] ?? null } : {}),
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
  // Planning is optimistic and read-only. Every apply re-reads its inputs under the full envelope.
  const snapshot = async () => {
    const book = await d.tasks.read()
    const ddoc = await d.store.read()
    const doc = await d.guards.read()
    const stages = await d.statusStages()
    const statuses = book.statuses.map(s => ({ ...s, stage: s.stage ?? stages?.[s.id] }))
    const slice: BoardSlice = { tasks: book.tasks, subtasks: book.subtasks, statuses }
    const effective = { ...slice, subtasks: d.effective(book.subtasks) }
    const views = viewsOf(slice, ddoc.deliveries, Object.keys(doc.checkpoints), effective)
    return { book, ddoc, doc, statuses, slice, effective, views, byKey: new Map(views.map(v => [v.key, v] as const)) }
  }
  const initial = await snapshot()
  let doc = initial.doc
  const { views, statuses } = initial
  const recoveryViews = new Map(viewsOf({ ...initial.effective, subtasks: initial.effective.subtasks.filter(s => !s.parentGroupId) }, initial.ddoc.deliveries, Object.keys(doc.intents)).map(v => [v.key, v] as const))
  const recoveryActions: string[] = []
  for (const [key, intent] of Object.entries(doc.intents)) {
    const { [key]: _gone, ...rest } = doc.intents
    if (documentsShow(intent.target, recoveryViews)) { doc = { ...doc, checkpoints: { ...doc.checkpoints, [key]: intent.target }, intents: rest }; recoveryActions.push(`sweep-intent-committed ${key}`) }
    else { doc = { ...doc, intents: rest }; recoveryActions.push(`sweep-intent-dropped ${key}`) }
  }
  const at = new Date(d.now()).toISOString()
  const plan = planSweep({ pieces: views, checkpoints: doc.checkpoints, statuses, memory: doc.sweep ?? emptyMemory(), now: d.now() })
  if (rule === 'shadow') {
    actions.push(...recoveryActions.map(a => a.replace('sweep-intent-', 'sweep would-recover-intent-')))
    for (const r of plan.reverts) actions.push(`sweep would-revert ${r.key}: ${r.reason}`)
    return
  }
  const revertCount = plan.reverts.length
  const skipped = !doc.migrations?.a ? 'migration_missing' : revertCount > 20 || revertCount > views.length * 0.05 ? 'no_checkpoint_breaker' : null
  if (skipped) {
    actions.push(`sweep-skipped: ${skipped}`)
    if (skipped === 'migration_missing') {
      d.log?.(`[guard] WARN sweep-skipped: migration_missing; ${SWEEP_ESCAPE}`)
      return
    }
    const warning = `sweep-breaker: ${revertCount}/${views.length} pieces need a revert; the sweep is report-only for this tick. A varredura está apenas relatando neste tick: ${revertCount}/${views.length} peças precisam de reversão. agentop flow guarantee off a`
    let notify = false
    await d.envelope(async () => {
      if (await d.rule() !== 'on') return
      const current = await d.guards.read()
      if (!current.migrations?.a) return
      notify = !current.sweep?.warning?.startsWith('sweep-breaker:')
      if (current.sweep?.warning !== warning) await d.guards.write({ ...current, sweep: { ...(current.sweep ?? emptyMemory()), warning } })
    })
    if (notify) {
      d.log?.(`[guard] WARN ${warning}`)
      await d.notifyLeaders?.([...new Set(plan.reverts.map(r => r.taskId))], warning)
    }
    return
  }

  // Recovery is itself bounded and compares the intent identity under lock. A replaced intent is never consumed.
  const recoveryEntries = Object.entries(initial.doc.intents)
  for (let offset = 0; offset < recoveryEntries.length; offset += SWEEP_CHUNK_SIZE) {
    const entries = recoveryEntries.slice(offset, offset + SWEEP_CHUNK_SIZE)
    await d.envelope(async () => {
      if (await d.rule() !== 'on') return
      const fresh = await snapshot()
      let current = fresh.doc, changed = false
      const shown = new Map(viewsOf({ ...fresh.effective, subtasks: fresh.effective.subtasks.filter(s => !s.parentGroupId) }, fresh.ddoc.deliveries, entries.map(([key]) => key)).map(v => [v.key, v] as const))
      for (const [key, intent] of entries) {
        if (JSON.stringify(current.intents[key]) !== JSON.stringify(intent)) continue
        const { [key]: _gone, ...rest } = current.intents
        if (documentsShow(intent.target, shown)) { current = { ...current, checkpoints: { ...current.checkpoints, [key]: intent.target }, intents: rest }; actions.push(`sweep-intent-committed ${key}`) }
        else { current = { ...current, intents: rest }; actions.push(`sweep-intent-dropped ${key}`) }
        changed = true
      }
      if (changed) await d.guards.write(current)
    })
  }

  const signature = (v: PieceView | undefined, checkpoints: SweepGuardsDoc['checkpoints'], memory: SweepMemory | undefined) =>
    JSON.stringify([v, v ? checkpoints[v.checkpointKey ?? v.key] : null, v ? memory?.reverts[v.key] ?? [] : [], statuses])
  const expected = new Map(views.map(v => [v.key, signature(v, doc.checkpoints, doc.sweep)]))
  const loops: string[] = []
  // No network, adoption or leader wake lives in these chunks. Each chunk writes each document at most once.
  for (let offset = 0; offset < plan.reverts.length; offset += SWEEP_CHUNK_SIZE) {
    const proposed = plan.reverts.slice(offset, offset + SWEEP_CHUNK_SIZE)
    await d.envelope(async () => {
      if (await d.rule() !== 'on') return
      const fresh = await snapshot()
      if (!fresh.doc.migrations?.a || JSON.stringify(fresh.statuses) !== JSON.stringify(statuses)) return
      const reverts = proposed.filter(r => signature(fresh.byKey.get(r.key), fresh.doc.checkpoints, fresh.doc.sweep) === expected.get(r.key))
      if (!reverts.length) return
      const recordReverts = new Map<string, SweepRevert>()
      for (const r of reverts) {
        const key = r.deliveryKey ?? r.key
        if ((!r.delivery && !r.loop) || !fresh.ddoc.deliveries[key]) continue
        const prior = recordReverts.get(key)
        recordReverts.set(key, { ...(r.delivery ? r : prior ?? r), ...((prior?.loop || r.loop) ? { loop: true } : {}) })
      }
      if (recordReverts.size) await d.store.update(x => {
        for (const [key, r] of recordReverts) {
          const rec = x.deliveries[key]
          if (rec) x.deliveries[key] = retreat(rec, r, at)
        }
      }, { guard: d.guard })
      const comments: unknown[] = [], events: unknown[] = []
      for (const r of reverts) {
        comments.push({ id: d.ids.comment(), taskId: r.taskId, ...(r.subtaskId ? { subtaskId: r.subtaskId } : {}), author: 'flow:entrega', body: textOf(r), createdAt: at })
        const oldDeliveredAt = fresh.book.subtasks.find(s => s.id === r.key) as { deliveredAt?: string } | undefined
        events.push({ id: d.ids.event(), taskId: r.taskId, ...(r.subtaskId ? { subtaskId: r.subtaskId } : {}), at, actor: ACTOR, kind: 'status', detail: `sweep revert: ${r.reason}${oldDeliveredAt?.deliveredAt ? `; previous deliveredAt: ${oldDeliveredAt.deliveredAt}` : ''}`, ...(r.board ? { to: r.loop ? 'blocked' : r.board.to } : {}) })
      }
      await d.tasks.applyBoardReverts({
        at, reverts: reverts.filter(r => r.board).map(r => ({ key: r.key, ...(r.subtaskId ? { subtaskId: r.subtaskId } : {}), to: r.loop ? 'blocked' : r.board!.to, clearCi: r.board!.clearCi })),
        comments: comments as never[], events: events as never[],
      })
      // After both documents: a crash loses at most this chunk's count and never invents a loop.
      const current = await d.guards.read()
      const memory = { ...(current.sweep ?? emptyMemory()), reverts: { ...(current.sweep?.reverts ?? {}) } }
      for (const r of reverts) {
        memory.reverts[r.key] = plan.memory.reverts[r.key]!
        actions.push(`sweep-revert ${r.key}: ${r.reason}${r.loop ? ' (loop: blocked)' : ''}`)
        if (r.loop) loops.push(r.key)
      }
      await d.guards.write({ ...current, sweep: memory })
    })
  }
  if (loops.length) d.log?.(`[guard] WARN sweep-loop: ${loops.join(', ')} keep being moved by an unknown writer and were blocked; um escritor desconhecido continua movendo estas peças — ${SWEEP_ESCAPE}`)

  // A catch-up uses its own short guarded door. It never inherits the sweep's lock lease or a tick-wide lease.
  const failures: Record<string, string> = {}
  for (const c of plan.catchUps) {
    const fresh = await snapshot()
    if (signature(fresh.byKey.get(c.key), fresh.doc.checkpoints, fresh.doc.sweep) !== expected.get(c.key)) continue
    let code: string | undefined
    try {
      const out = await d.catchUp?.(c.key, c.phase, async () => {
        const current = await snapshot()
        return await d.rule() === 'on' && !!current.doc.migrations?.a && JSON.stringify(current.statuses) === JSON.stringify(statuses)
          && signature(current.byKey.get(c.key), current.doc.checkpoints, current.doc.sweep) === expected.get(c.key)
      })
      if (out?.code === 'sweep_changed') continue
      if (out?.ok) actions.push(`sweep-catch-up ${c.key} → ${c.phase}`); else code = out?.code ?? out?.message?.split(':')[0] ?? 'catch_up_unavailable'
    }
    catch (e) { code = (e as { code?: string }).code ?? 'internal_error' }
    if (code) {
      failures[c.key] = code
      if (doc.sweep?.catchUpFailures?.[c.key] !== code) { const line = `sweep-catch-up-failed ${c.key}: ${code}`; actions.push(line); d.log?.(line) }
    }
  }
  // Merge into the latest memory, so another process's accepted chunk/count is never replaced by our snapshot.
  await d.envelope(async () => {
    if (await d.rule() !== 'on') return
    const current = await d.guards.read()
    const memory = planSweep({ pieces: [], checkpoints: {}, statuses, memory: current.sweep ?? emptyMemory(), now: d.now() }).memory
    if (Object.keys(failures).length) memory.catchUpFailures = failures
    if (JSON.stringify(memory) !== JSON.stringify(current.sweep ?? emptyMemory())) await d.guards.write({ ...current, sweep: memory })
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

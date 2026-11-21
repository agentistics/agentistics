/**
 * delivery/guard-host.ts — the IO half of the store guard (ENTREGA.GARANTIDA §2.5, §2.6, §2.6.1). Used by the two hooks:
 * `sessions/task-store.ts` `write()` and `delivery/store.ts` `update()`.
 *
 *   ruleAState   resolves authenticated activation, including the witness and generation latch; only a fresh machine is OFF.
 *   guardedWrite the §2.6 sequence for one write: take the locks (global order, 5 s, fail closed), gather each raised piece's
 *                facts (checkout, evidence), DECIDE (`decideGuard`), and only then intent → documents → checkpoint. A refusal
 *                throws `GuardRefused` before a byte of either document is written and before guards.json exists.
 *
 * The sweep (S2b) is not here: a checkpoint is committed, never revisited by this module.
 */
import { dirname, join } from 'node:path'
import { createGuaranteesStore, ruleState } from './activation'
import { classifyPiece, evaluateEvidence } from './classify'
import { declareClassification } from './classify-declare'
import { execGit, gatherFacts, type ClassifyDeps } from './classify-host'
import type { DeliveryRecord } from './machine'
import { defaultGuardLockPaths, withGuardLocks, type GuardLockName, type GuardLockPaths } from './guard-locks'
import { beginIntent, commitIntent, createGuardsStore, GuardsUnreadable, type GuardAuth, type PieceCheckpoint } from './guards-store'
import { decideGuard, GuardRefused, phaseRank, type GuardContext, type Raised, type ReviewOutcome, type RuleState } from './guard'
import { checkpointRank, type AcceptedMembers } from './sweep-plan'

/** How a store reaches the guard. Everything optional: production defaults come from the data directory and the registry. */
export interface GuardWiring {
  deps?: ClassifyDeps
  now?: () => number
}

/** The three lock paths (and the data dir) a store anchored at `file` uses. */
export function guardPathsOf(anchor: { tasksFile?: string; deliveriesFile?: string }): { dir: string; paths: GuardLockPaths } {
  const dir = dirname((anchor.tasksFile ?? anchor.deliveriesFile) as string)
  const base = defaultGuardLockPaths(dir)
  return {
    dir,
    paths: {
      tasks: anchor.tasksFile ?? (process.env.AGENTISTICS_TASKS_FILE ? base.tasks : join(dir, 'tasks.json')),
      deliveries: anchor.deliveriesFile ?? (process.env.AGENTISTICS_DELIVERIES_FILE ? base.deliveries : join(dir, 'deliveries.json')),
      guards: join(dir, 'guards.json'),
    },
  }
}

/** Authenticated rule A state. Missing documents alone never establish a fresh machine. */
export async function ruleAState(dir: string): Promise<RuleState> {
  const { doc } = await createGuaranteesStore(join(dir, 'guarantees.json')).read()
  return ruleState(doc, 'a')
}

/** The registry's rows as the classification host reads them (the same shape `delivery/host.ts` hands the service). */
export async function registryClassifyDeps(): Promise<ClassifyDeps> {
  return {
    git: execGit,
    sessions: async () => {
      const { readRegistry } = await import('../sessions/registry')
      return (await readRegistry()).map(m => ({
        id: m.id, cwd: m.cwd ?? '', ...(m.taskId ? { taskId: m.taskId } : {}), ...(m.subtaskId ? { subtaskId: m.subtaskId } : {}),
        ...(m.createdAt ? { createdAt: m.createdAt } : {}), ...(m.repo?.rootPath ? { rootPath: m.repo.rootPath } : {}),
      }))
    },
  }
}

/** Guard A for ONE raised piece, at this instant: the piece's checkout, its evidence, the checkpoint it already has. */
export async function reviewOutcome(o: {
  deps: ClassifyDeps; raised: Raised; record: Pick<DeliveryRecord, 'evidence'> & Partial<Pick<DeliveryRecord, 'revision' | 'history'>> | null; checkpoint: PieceCheckpoint | undefined
}): Promise<ReviewOutcome> {
  const { raised, checkpoint } = o
  const piece = { taskId: raised.taskId, ...(raised.subtaskId ? { subtaskId: raised.subtaskId } : {}) }
  let c = classifyPiece(await gatherFacts(o.deps, piece))
  let declared: { by: string; repo: string; head: string; at: string } | undefined
  const prior = checkpoint?.classification?.declared
  if (!c.ok && c.code === 'classification_required' && prior) {
    const again = await declareClassification(o.deps, { piece, repo: prior.repo, head: prior.head })
    if (again.ok) { c = again.classification; declared = prior }
  }
  if (!c.ok) return { ok: false, code: c.code, message: c.message, messagePt: c.messagePt, ...(c.paths ? { paths: c.paths } : {}), missing: [] }
  // Never select captures from an ambiguous id multiset, including books written by an older binary.
  const ids = (o.record?.evidence ?? []).map(i => i.id)
  if (new Set(ids).size !== ids.length) return { ok: false, code: 'evidence_binding_protected', message: 'Evidence ids must be unique within a piece.', messagePt: 'Os identificadores de evidência devem ser únicos na peça.', missing: [] }
  // A revision increments at every normal phase move. Only an adjustment starts a new capture round.
  // Its durable history entry is the lower revision bound; normal advances keep using that round's captures.
  const round = Math.max(0, ...(o.record?.history ?? []).filter(h => h.to === 'ajuste').map(h => h.revision))
  const items = (o.record?.evidence ?? []).filter(i => i.revision >= round && i.revision <= (o.record?.revision ?? Infinity))
  const ev = evaluateEvidence(c, items)
  if (!ev.ok) return { ok: false, code: ev.code, message: ev.message, messagePt: ev.messagePt, missing: ev.missing, ...(ev.code === 'evidence_invalid' ? { rule: ev.rule } : {}) }
  return { ok: true, ids: ev.ids, sha256: items.filter(i => ev.ids.includes(i.id)).map(i => i.sha256), headSha: c.headSha, category: c.category, ...(declared ? { declared } : {}) }
}

export interface GuardedWriteOptions {
  /** Deprecated input: the policy is always resolved again under the held guards lock. */
  rule?: RuleState
  raised: readonly Raised[]
  /** Member changes this write made (R4-1/R5-4): a status it set, a member it moved in (`moved`), a member that left (`removed`). */
  memberChanges?: readonly { key: string; id: string; status?: string; removed?: true; moved?: { fromGroup?: string; rank: number } }[]
  retreats?: readonly { key: string; rank: number; fromPhase?: string; fromBoardStatus?: string; boardStatus?: string; boardStage?: string; /** The members of a group whose own rank is within the retreat's. */ members?: Record<string, string> }[]
  ctx: GuardContext | undefined
  /** r8 C: keys of pieces the VAULT-PROVEN owner is retreating/moving out of an accepted state: not re-classified (the caller proved the principal). */
  exemptClassification?: ReadonlySet<string>
  paths: GuardLockPaths
  /** Locks still needed by the caller; empty when its store/transaction already holds the complete set. */
  locks: readonly GuardLockName[]
  /** Locks the caller already holds (the store's own file lock). */
  alreadyHeld: readonly GuardLockName[]
  wiring?: GuardWiring
  /** The delivery record of a raised piece, read while the locks are held. */
  recordOf: (key: string) => Promise<Pick<DeliveryRecord, 'evidence' | 'revision' | 'phase'> & Partial<Pick<DeliveryRecord, 'history'>> | null>
  /** What the checkpoint says about the board/phase at the target. */
  stateOf: (r: Raised) => { boardStatus: string; boardStage: string; phase: string | null; /** A group's member statuses at this write (R3-1). */ members?: Record<string, string> }
  /** The document write — runs after the intent is durable. */
  writeDocuments: () => Promise<void>
  /** Test seam: a crash point between the documents and the checkpoint commit. */
  afterDocuments?: () => void | Promise<void>
}

const acceptedAt = (members: Record<string, string>, at: string): AcceptedMembers => Object.fromEntries(Object.entries(members).map(([id, status]) => [id, { status, at }]))

/** Where a `would_refuse` goes in `shadow`: the log (a persistent report is S9/S10's). */
function reportWouldRefuse(rule: RuleState, would: readonly { code: string; piece: string }[]): void {
  if (rule === 'shadow') for (const w of would) console.warn(`[guard] would_refuse ${w.code} ${w.piece}`)
}

export async function guardedWrite(o: GuardedWriteOptions): Promise<void> {
  const now = (o.wiring?.now ?? Date.now)()
  const at = new Date(now).toISOString()
  const run = async () => {
    const rule = await ruleAState(dirname(o.paths.guards))
    if (rule === 'off') { await o.writeDocuments(); return }
    const store = createGuardsStore(o.paths.guards)
    let doc
    try { doc = await store.read() } catch (e) {
      if (!(e instanceof GuardsUnreadable)) throw e
      if (rule === 'on') throw new GuardRefused({ code: 'guards_unreadable', piece: o.raised[0]?.key ?? o.memberChanges?.[0]?.key ?? o.retreats?.[0]?.key ?? 'unknown', missing: [], message: `${e.message} — guarded moves are refused until it is repaired`, messagePt: 'guards.json está ilegível ou adulterado — movimentos guardados ficam recusados até ser reparado' })
      await o.writeDocuments(); return
    }
    const deps = o.wiring?.deps ?? await registryClassifyDeps()
    const outcomes: Record<string, ReviewOutcome> = {}
    if (o.ctx) for (const r of o.raised) {
      const checkpoint = doc.checkpoints[r.key]
      const rec = await o.recordOf(r.key)
      // Only the engine completing the board effect of THIS authorized phase may reuse its checkpoint.
      // A new phase/binding still classifies and validates normally.
      const st = o.stateOf(r)
      const covered = o.ctx.principal.kind === 'flow' && checkpoint && !st.phase && rec?.phase === checkpoint.phase
        && r.rank <= checkpointRank(checkpoint, [{ id: checkpoint.boardStatus, stage: checkpoint.boardStage }])
        && (rec?.revision ?? 0) === checkpoint.revision
      const exempt = o.ctx.principal.kind === 'owner' && o.ctx.principal.via === 'vault-credential' && !!o.exemptClassification?.has(r.key)
      outcomes[r.key] = covered || exempt
        ? { ok: true, ids: [], sha256: [], headSha: checkpoint?.headSha ?? '', category: checkpoint?.classification?.category ?? 'non-code', grandfathered: true }
        : await reviewOutcome({ deps, raised: r, record: rec, checkpoint })
    }
    const decision = decideGuard({ rule, raised: o.raised, ctx: o.ctx, outcomes })
    if (decision.verdict === 'refuse') throw new GuardRefused(decision.refusal)
    reportWouldRefuse(rule, decision.wouldRefuse ?? [])
    const passed = decision.passed ?? []
    const targets: PieceCheckpoint[] = []
    for (const p of passed) {
      const r = o.raised.find(x => x.key === p.key)!
      const rec = await o.recordOf(p.key)
      const st = o.stateOf(r)
      const auth: GuardAuth[] = p.outcome.grandfathered
        ? [...(doc.checkpoints[p.key]?.auth ?? [])]
        : [{ kind: 'evidence', ids: p.outcome.ids, sha256: p.outcome.sha256 }]
      if (o.ctx!.principal.kind === 'owner') auth.push({ kind: 'owner', via: o.ctx!.principal.via })
      targets.push({
        key: p.key, rank: p.rank, boardStatus: st.boardStatus, boardStage: st.boardStage, phase: st.phase ?? (p.outcome.grandfathered ? doc.checkpoints[p.key]?.phase ?? null : null),
        revision: rec?.revision ?? 0, headSha: p.outcome.headSha, auth, by: o.ctx!.principal as unknown as PieceCheckpoint['by'], at,
        transitionId: `tr-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        classification: { category: p.outcome.category, headSha: p.outcome.headSha ?? '', ...(p.outcome.declared ? { declared: p.outcome.declared } : {}) },
        // R3-1: accepting a group accepts the statuses its members hold now, so the sweep can tell them from a later forgery.
        ...(st.members ? { members: acceptedAt(st.members, at) } : {}),
      })
    }
    // A guarded retreat of the checkpoint's actual phase lowers its authority without demanding fresh evidence.
    // A forged before image cannot lower an unrelated checkpoint. Sweep corrections therefore do not grant anything.
    if (o.ctx) for (const r of o.retreats ?? []) {
      const prior = doc.checkpoints[r.key]
      if (!prior || (r.fromPhase !== undefined ? prior.phase !== r.fromPhase : prior.boardStatus !== r.fromBoardStatus) || targets.some(t => t.key === r.key)) continue
      const rec = await o.recordOf(r.key)
      const phase = r.fromPhase !== undefined ? rec?.phase ?? null : prior.phase
      const auth = [...prior.auth]
      if (o.ctx.principal.kind === 'owner') auth.push({ kind: 'owner', via: o.ctx.principal.via })
      // A retreat accepts only the members at or below its rank; a forged one above it is not blessed.
      const members = r.members ? { ...(prior.members ?? {}), ...acceptedAt(r.members, at) } : prior.members
      targets.push({ ...prior, ...(members ? { members } : {}), rank: Math.max(r.rank, phaseRank(phase)), phase, auth, by: o.ctx.principal as unknown as PieceCheckpoint['by'], boardStatus: r.boardStatus ?? '', boardStage: r.boardStage ?? '', revision: rec?.revision ?? prior.revision, at, transitionId: `retreat-${now}-${r.key}` })
    }
    // R5-4: a member only MOVED into a group carries a status this write did not set; it is accepted only as far as an authority
    // already covers it — its old group's accepted record, else its old group's or its own checkpoint (rank 0 needs none).
    const cpRank = (c: PieceCheckpoint) => checkpointRank(c, [{ id: c.boardStatus, stage: c.boardStage }])
    const movedAccepted = (m: NonNullable<GuardedWriteOptions['memberChanges']>[number]): boolean => {
      if (!m.moved) return true
      const from = m.moved.fromGroup ? doc.checkpoints[m.moved.fromGroup] : undefined
      if (from?.members?.[m.id]) return from.members[m.id]!.status === m.status
      const own = from && !from.members ? from : doc.checkpoints[m.id]
      return own ? m.moved.rank <= cpRank(own) : m.moved.rank === 0
    }
    if (rule === 'on') for (const m of o.memberChanges ?? []) {
      let target = targets.find(t => t.key === m.key)
      const prior = target ?? doc.checkpoints[m.key]
      // R5-3: a group with no accepted record yet (the migration window) gets its first one, whole, from the sweep's quiet baseline or
      // from a guarded raise; a partial record written here would turn every member it does not name into an unaccepted one.
      if (!prior?.members || !movedAccepted(m) || (m.removed && !prior.members[m.id])) continue
      if (!target) {
        target = { ...prior, members: { ...prior.members }, at, transitionId: `member-${now}-${m.key}` }
        targets.push(target)
      }
      if (m.removed) { const { [m.id]: _gone, ...rest } = target.members ?? {}; target.members = rest }
      else target.members = { ...target.members, [m.id]: { status: m.status!, at } }
    }
    if (targets.length === 0) { await o.writeDocuments(); return }
    let withIntents = doc
    for (const t of targets) withIntents = beginIntent(withIntents, t, at)
    await store.write(withIntents)
    await o.writeDocuments()
    await o.afterDocuments?.()
    let after = await store.read()
    for (const t of targets) after = commitIntent(after, t.key, t.transitionId)
    await store.write(after)
  }
  await withGuardLocks(o.locks, run, { paths: o.paths, alreadyHeld: o.alreadyHeld })
}

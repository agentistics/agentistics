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
import { decideGuard, GuardRefused, type GuardContext, type Raised, type ReviewOutcome, type RuleState } from './guard'

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
  ctx: GuardContext | undefined
  paths: GuardLockPaths
  /** Locks still needed by the caller; empty when its store/transaction already holds the complete set. */
  locks: readonly GuardLockName[]
  /** Locks the caller already holds (the store's own file lock). */
  alreadyHeld: readonly GuardLockName[]
  wiring?: GuardWiring
  /** The delivery record of a raised piece, read while the locks are held. */
  recordOf: (key: string) => Promise<Pick<DeliveryRecord, 'evidence' | 'revision' | 'phase'> & Partial<Pick<DeliveryRecord, 'history'>> | null>
  /** What the checkpoint says about the board/phase at the target. */
  stateOf: (r: Raised) => { boardStatus: string; boardStage: string; phase: string | null }
  /** The document write — runs after the intent is durable. */
  writeDocuments: () => Promise<void>
  /** Test seam: a crash point between the documents and the checkpoint commit. */
  afterDocuments?: () => void | Promise<void>
}

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
      if (rule === 'on') throw new GuardRefused({ code: 'guards_unreadable', piece: o.raised[0]!.key, missing: [], message: `${e.message} — guarded moves are refused until it is repaired`, messagePt: 'guards.json está ilegível ou adulterado — movimentos guardados ficam recusados até ser reparado' })
      await o.writeDocuments(); return
    }
    const deps = o.wiring?.deps ?? await registryClassifyDeps()
    const outcomes: Record<string, ReviewOutcome> = {}
    if (o.ctx) for (const r of o.raised) outcomes[r.key] = await reviewOutcome({ deps, raised: r, record: await o.recordOf(r.key), checkpoint: doc.checkpoints[r.key] })
    const decision = decideGuard({ rule, raised: o.raised, ctx: o.ctx, outcomes })
    if (decision.verdict === 'refuse') throw new GuardRefused(decision.refusal)
    reportWouldRefuse(rule, decision.wouldRefuse ?? [])
    const passed = decision.passed ?? []
    if (passed.length === 0) { await o.writeDocuments(); return }
    const targets: PieceCheckpoint[] = []
    for (const p of passed) {
      const r = o.raised.find(x => x.key === p.key)!
      const rec = await o.recordOf(p.key)
      const st = o.stateOf(r)
      const auth: GuardAuth[] = p.outcome.grandfathered
        ? (doc.checkpoints[p.key]?.auth ?? [])
        : [{ kind: 'evidence', ids: p.outcome.ids, sha256: p.outcome.sha256 }]
      targets.push({
        key: p.key, rank: Math.max(p.rank, doc.checkpoints[p.key]?.rank ?? 0), boardStatus: st.boardStatus, boardStage: st.boardStage, phase: st.phase,
        revision: rec?.revision ?? 0, headSha: p.outcome.headSha, auth, by: o.ctx!.principal as unknown as PieceCheckpoint['by'], at,
        transitionId: `tr-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        classification: { category: p.outcome.category, headSha: p.outcome.headSha ?? '', ...(p.outcome.declared ? { declared: p.outcome.declared } : {}) },
      })
    }
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

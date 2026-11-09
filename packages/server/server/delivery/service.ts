/**
 * delivery/service.ts — FLUXO.ENTREGA-DSL's one door. Every surface (HTTP route, MCP, `agentop flow …`,
 * the engine's host ops, the minute tick) goes through these functions, so a phase cannot be skipped from
 * any of them.
 *
 * The order of one transition is fixed: run the edge's gates OUTSIDE the lock (they read git/gh and take
 * seconds), then UNDER the lock re-read the record, refuse if it moved meanwhile, store the gate evidence
 * and the planned transition, and only then perform the effects (board status, the CI signal, the `step`
 * event, a comment, the `entrega.etapa` event, the wake-ups). Effects are best effort and reported as
 * warnings: the record is the source of truth and the Live is a projection of it.
 *
 * NON-BLOCKING by construction: nothing here waits. Each transition wakes whoever owns the next step
 * (QA approved → the leader; failed → the author with the findings; merge/release failed → the leader with
 * the reason), and the minute tick (`tick`) advances what only evidence can advance (CI → publicado) and
 * keeps blocked pieces moving (wake every 30 min, defer after 2 h, dependencies unblock themselves).
 *
 * AUTONOMOUS MODE never calls or waits for the owner: a human gate is skipped and recorded, reason 6 is
 * deferred by the leader, and the only owner-facing output is the INFORMATIONAL "publicado" notice.
 */
import {
  EDGES, GATES, adoptPhase, isGate, isPhase, isPureAdoption, newDelivery, planBlock, planTransition, planUnblock, planWatch,
  refusalStatus, unlockerOf, type DeliveryCi, type DeliveryRecord, type GateName, type Phase, type TransitionInput, type TransitionRefusal,
} from './machine'
import { DEFAULT_RELEASE_REPO, findMergedPr, judgePredispatch, releaseFailed, releaseUnknown, runGate, type BlockedSubtaskFact, type GateFacts, type GateVerdict, type SessionFact } from './gates'
import { MERGE_PHASES, MERGE_SCAN_PER_TICK, currentNote, mergeScanDue, mergeScanOrder, planReviewNudges, type ReconcileEntry } from './ciclo'
import { AUTO_RUN_GH_BUDGET, ENGINE_REPO, MANUAL_RUN_GH_BUDGET, PROOF_REFRESH_MS, findEnginePinTag, findPublicTag, hydrateProofCache, loadBatchPrs, matchBatchPr, meterFacts, serializeProofCache, type AutoRunReport, type BatchMatch, type BatchPr, type DeclaredHead, type ProofCache } from './batch-proof'
import { antigaComment, inReconcileScope, isAntiga, type AntigaAction } from './antigas'
import { DeliveryStoreUnreadable, type DeliveryStore } from './store'
import { sharedQueueArea } from './queue-fit'
import { ownerIntent } from '../flows/owner-intent'
import { requestReminderText } from './request-reminder'
import {
  ASK_TIMEOUT_MS, holdState, orderQueue, parseQueueAnswer, planQueue, QUEUE_HEADER, questionText, reminderDue, startClaimLive, whyNext,
  type QueueAnswer, type QueueItem,
} from './fila-proximo'

export interface DeliveryBoard {
  /** Move the subtask's board status to the one this phase is shown under (created when missing). */
  setPhaseStatus(subtaskId: string, phase: Phase): Promise<{ ok: boolean; message?: string }>
  /** Write (or clear) the CI · publicando signal on the subtask — `task-live.ts` reads `sub.ci`. */
  setCi(subtaskId: string, ci: DeliveryCi | null): Promise<void>
  /** A `step` activity event (`to` = the step number) — `task-live.ts`'s `stepOf`. */
  logStep(taskId: string, subtaskId: string, step: number, actor: string): Promise<void>
  comment(taskId: string, subtaskId: string, body: string): Promise<void>
  /** Is this sibling subtask finished (done on the board, or its delivery published)? */
  subtaskFinished(subtaskId: string): Promise<boolean>
  /** Write the staged session draft on the subtask (the board's own validation applies). */
  stage(subtaskId: string, draft: Record<string, unknown>): Promise<{ ok: boolean; message?: string }>
}

export interface DeliveryNotify {
  /** Type into a session's composer (the leader, the author, the QA). Never the owner. */
  session(sessionId: string, text: string, header?: string): Promise<boolean>
  /** The owner's bell — INFORMATIONAL (`aviso`) always; `decisao` only ever with autonomous mode OFF. */
  owner(text: string, kind: 'aviso' | 'decisao'): Promise<void>
}

export interface DeliveryDeps {
  store: DeliveryStore
  facts: GateFacts
  board: DeliveryBoard
  notify: DeliveryNotify
  /** The owner's autonomous mode now (global away, or the delivery leader's own `away`). */
  autonomous(leaderSessionId?: string): Promise<boolean>
  /** Into the engine's flows bus and the SSE channel. Best effort. */
  emit(type: string, payload: Record<string, unknown>): Promise<void>
  /** Starts the staged session (`agentop flow stage run`). Returns the managed id. */
  spawn?(r: DeliveryRecord, staged: Record<string, unknown>): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>
  /** Squash-merges the delivery's PR (`agentop flow merge`). */
  merge?(r: DeliveryRecord): Promise<{ ok: true; mergeSha: string; pr: number } | { ok: false; message: string }>
  now(): number
  /** Canonical ORQ.H1/H4 pedidos, read from the engine; null = temporarily unreadable. */
  requests?(): Promise<OwnerRequestFact[] | null>
  /** The name a person gave an account ("Vini"); null = none known (the question then leaves the account out, never an id). */
  accountName?(harness: string, account: string): Promise<string | null>
  /** Board pieces shown In review / PR · merge / CI with NO delivery record yet (the backfill adopts them). Optional. */
  reviewPieces?(): Promise<ReviewPiece[]>
  /** What the piece's OWN delivery declared in its handbacks: branch @ commit, full commits, PR numbers (read-only; matched against gh's facts). */
  pieceHints?(subtaskId: string): Promise<{ branches: string[]; shas: string[]; heads?: DeclaredHead[]; prs?: number[]; latest?: string[] }>
  /** Archives / completes a record-less old piece on the board (`antigas`), without implying release proof. Optional. */
  hasSession?(subtaskId: string): Promise<boolean>
  /** Same question for many pieces with ONE read of the board (the preview asks for hundreds; one world load per id took 11 s). */
  hasSessions?(ids: readonly string[]): Promise<Set<string>>
  /** The pieces the Live screen lists as "antigas": THE one predicate (the screen, the dialog, the CLI, the MCP and the action all read it). null = unreadable. */
  oldPieces?(): Promise<Array<{ id: string; taskId: string }> | null>
  closeLegacy?(subtaskId: string, to: 'done' | 'abandoned'): Promise<{ ok: true } | { ok: false; message: string }>
  /** The automatic reconcile (first tick, then on its cadence) is ON only where the host asks for it; a function is asked on every tick. */
  autoReconcile?: boolean | (() => boolean)
  /** Tests: the automatic reconcile runs inside the tick (awaited) instead of in the background. */
  autoReconcileAwait?: boolean
  /** The automatic reconcile's shortest cadence (default 30 min; it also waits 3x what the last run took). */
  autoReconcileEveryMs?: number
  /** Where what gh answered survives a restart (absent: this process only). A cache: a failed read or write costs one run, never a wrong answer. */
  proofStore?: { load(): Promise<unknown>; save(doc: unknown): Promise<void>; /** A cheap fingerprint of the stored document (mtime+size): another process wrote it when it changed. */ stamp?(): Promise<string | null> }
  /** One line per automatic run (L2: its result used to be invisible). */
  log?(line: string): void
}

export interface ReviewPiece {
  hasOpenChildren?: boolean
  id: string; taskId: string; title: string; status: string
  /** When the board last touched it (ISO). */
  updatedAt?: string
  /** When the card was created (ISO): a PR merged before it cannot have shipped it. */
  createdAt?: string
  /** When its delivery last handed back (ISO): real work waiting on a person is not old by age alone. */
  handbackAt?: string
  /** The repositories (`owner/name`) of the sessions that worked on it. `[]` = none known: nothing can be proven. Absent = the host cannot say. */
  repos?: string[]
  /** What its delivery declared, read in the same pass over the board (a piece-by-piece read of a real board took minutes). Absent: `pieceHints` is asked. */
  hints?: { branches: string[]; shas: string[]; heads?: DeclaredHead[]; prs?: number[]; latest?: string[] }
}

export interface ReconcileSummary { published: number; toCi: number; ciRed: number; /** The release could not be READ: the piece did not move. */ unknown: number; antigas: number; /** Pieces the run could NOT look up (no repository known, gh unreadable, quota): not "no proof", and retried. */ unchecked: number; stay: number }
export type ReconcileReply =
  | { ok: true; status: 200; apply: boolean; entries: ReconcileEntry[]; moved: number; unproven: number; summary: ReconcileSummary; gh: number; /** Set when the run stopped early (quota): what it did not reach is untouched, the next run continues. */ stopped?: 'budget' | 'rate-limit' }
  | Extract<DeliveryReply, { ok: false }>

export type AntigasReply =
  | { ok: true; status: 200; action: 'publish' | 'archive' | 'conclude'; /** conclude + preview: what the click would do. */ preview?: { conclude: number; archive: number }; done: Array<{ subtaskId: string; ok: boolean; how?: 'concluded' | 'archived'; reason?: string; /** The board asks for a session before `done`. */ code?: 'no_session' }>; /** The caller gave up: the pieces not listed were not touched. */ stopped?: boolean }
  | Extract<DeliveryReply, { ok: false }>

/** FILA.PRIORIDADE — one queued piece as the Fila tab, the Live card and the MCP read it (ONE source). */
export interface QueueViewItem {
  subtaskId: string; taskId: string; title: string; taskTitle: string
  /** urgent | high | medium | low — the task's. */
  priority: string
  /** 1-based place among THIS task's queued pieces, and among all of them (the leaving order). */
  position: number; globalPosition: number
  since: string
  group: { members: Array<{ id: string; title: string; status: string }> } | null
  predispatch: { ok: boolean; missing?: string[]; harness: string | null; model: string | null; effort: string | null; account: string | null; accountName: string | null; cwd: string | null; prompt: string }
  /** The slot gate's last verdict (raw sentence; the screen says it in plain words). */
  slot: { ok: boolean; reason: string | null; at: string } | null
  hold: { kind: 'nao' | 'agendar'; reason: string; at: string; actor: string; until?: string; active: boolean } | null
  ask: { at: string; delivered: boolean; approved: boolean; expiresAt: string; leaderSessionId?: string; onTimeout: 'sim' | 'esperar' } | null
  leaderSessionId: string | null; leaderAlive: boolean
  notes: { total: number; last: Array<{ author: string; at: string; body: string }> }
}
export interface QueueViewRecent { subtaskId: string; taskId: string; title: string; phase: string; at: string; actor: string; auto: boolean; sessionId: string | null }
export interface QueueView { generatedAt: string; autonomous: boolean; total: number; items: QueueViewItem[]; recent: QueueViewRecent[] }

export interface OwnerRequestFact { id: string; taskId?: string; sessionId: string; text: string; at: string; state: string; linkedSubtaskIds: string[] }
export interface ReleasePiece { subtaskId: string; phase: Phase; /** false = it was already declared for this very release and nothing was touched. */ changed: boolean }
export type ReleaseReply =
  | { ok: true; status: 200; version: string; tag: string; mergeSha: string; pieces: ReleasePiece[]; publishedAt?: string; warnings: string[] }
  | Extract<DeliveryReply, { ok: false }>

export type DeliveryReply =
  | { ok: true; status: 200; record: DeliveryRecord; warnings: string[]; skipped?: unknown; gate?: GateVerdict }
  | { ok: false; status: number; code: string; sentence: string; missing: string[]; record?: DeliveryRecord; gate?: GateVerdict }

/** The answer of a step report on a piece with no delivery record: the event is all that was written. */
export type StepEventReply = { ok: true; status: 200; step: number; recorded: 'event' } | Extract<DeliveryReply, { ok: false }>

const fail = (status: number, code: string, sentence: string, missing: string[] = [], record?: DeliveryRecord): Extract<DeliveryReply, { ok: false }> => ({ ok: false, status, code, sentence, missing, ...(record ? { record } : {}) })
const refused = (p: TransitionRefusal, record?: DeliveryRecord): DeliveryReply => fail(refusalStatus(p), p.code, p.sentence, p.missing, record)
const iso = (d: DeliveryDeps) => new Date(d.now()).toISOString()
const SUB_ID = /^[A-Za-z0-9_.:-]{1,120}$/
const GATE_REFUSED = 'portao'

/** Steps the Live's per-phase % reads, emitted on what the flow itself observes. */
const STEP_ON_ENTER: Partial<Record<Phase, number>> = { executando: 1, qa: 1, ajuste: 1, revisao_lider: 1, pr_merge: 1 }
const STEP_ON_GATE: Partial<Record<`${Phase}:${GateName}`, number>> = {
  'executando:salvo': 4, 'ajuste:salvo': 3, 'qa:qa-modelo': 2, 'revisao_lider:delecoes': 2, 'pr_merge:delecoes': 2,
}

/** A tick adopts at most this many board-blocked pieces; the rest come on the next ticks (oldest block first). */
const ADOPT_PER_TICK = 20
/** Ticks a deferral's board move is retried before it is given up on (one notice, no loop). */
const BOARD_MOVE_MAX_TRIES = 10
/** How many pieces one leader message lists; the rest is a count. */
const WAKE_LIST_MAX = 5

/** The repository a release belongs to when `flow release` is not given `--repo` (defined beside the gates that read it). */
export { DEFAULT_RELEASE_REPO }

/** The actor the backfill writes as: transitions it makes are recorded, never announced piece by piece. */
export const RECONCILE_ACTOR = 'flow:reconcile'

const RELEASE_POLL_MIN_MS = 60_000
const RELEASE_POLL_MAX_MS = 10 * 60_000
const QUEUE_SLOT_REFRESH_MS = 5 * 60_000

const safe = <A extends unknown[]>(fn: (...a: A) => Promise<DeliveryReply>) => async (...a: A): Promise<DeliveryReply> => {
  try { return await fn(...a) } catch (e) { if (e instanceof DeliveryStoreUnreadable) return fail(503, 'store_ilegivel', e.message); throw e }
}

/** The repositories this product ships from: a card whose host cannot say its repository is read against these. */
const PRODUCT_REPOS: readonly string[] = [DEFAULT_RELEASE_REPO, ENGINE_REPO]
/** A person's board can span many repositories; each costs reads. The rest is simply not proven. */
const MAX_PROOF_REPOS = 12
const PROOF_SAVE_EVERY_CALLS = 25
const AUTO_EVERY_MS = 30 * 60_000
const AUTO_BACKOFF_MAX_MS = 6 * 3600_000
/** Below this share of the core quota the automatic run waits: the person's own work comes first. */
const AUTO_MIN_QUOTA_ROOM = 1 / 3
const msOf = (iso: string | undefined): number | null => (iso ? Date.parse(iso) || null : null)

export function createDeliveryService(d: DeliveryDeps) {
  let proofCache: ProofCache | null = null
  /** The store's fingerprint when this process last read or wrote it: a different one means ANOTHER process (the CLI's reconcile) wrote it. */
  let proofStamp: string | null = null
  /** Reconcile runs in progress in THIS process: while one holds the cache, nothing swaps it from underneath. */
  let proofRuns = 0
  const loadProof = async (): Promise<ProofCache> => {
    const stamp = await d.proofStore?.stamp?.().catch(() => null) ?? null
    if (!proofCache) {
      proofCache = hydrateProofCache(await d.proofStore?.load().catch(() => null) ?? null, d.now())
      proofStamp = stamp
    } else if (proofRuns === 0 && stamp !== null && stamp !== proofStamp) {
      // The Live (this process) answers from these outcomes, and `agentop flow reconcile` runs in another process and saves
      // its own: a copy loaded once keeps judging the pieces by a run nobody remembers (LIMPEZA.ANTIGAS-FALTANTES). Same object, new content.
      const disk = hydrateProofCache(await d.proofStore?.load().catch(() => null) ?? null, d.now())
      const keepAuto = proofCache.auto
      Object.assign(proofCache, disk, { unreadable: proofCache.unreadable, unreadableWhy: proofCache.unreadableWhy, auto: keepAuto.nextAt >= disk.auto.nextAt ? keepAuto : disk.auto })
      proofStamp = stamp
    }
    proofCache.nowMs = d.now()
    return proofCache
  }
  const saveProof = async (): Promise<void> => {
    if (!proofCache) return
    await d.proofStore?.save(serializeProofCache(proofCache)).catch(() => undefined)
    proofStamp = await d.proofStore?.stamp?.().catch(() => null) ?? null
  }
  /** The record, created at `fila` on first use (a subtask that exists on the board). */
  const ensure = async (subtaskId: string, o: { versionTarget?: string; humanGates?: Phase[]; leaderSessionId?: string } = {}): Promise<DeliveryRecord | DeliveryReply> => {
    if (!SUB_ID.test(subtaskId)) return fail(400, 'bad_subtask', 'invalid subtask id')
    const have = await d.store.get(subtaskId)
    if (have) return have
    const sub = await d.facts.subtask(subtaskId)
    if (!sub) return fail(404, 'no_such_subtask', `subtask ${subtaskId} does not exist on the board`)
    // A piece already past the queue on the board (every 2.200.8 piece started before this flow) is ADOPTED at its phase.
    const phase = adoptPhase(sub.status)
    return d.store.update(doc => {
      doc.deliveries[subtaskId] ??= newDelivery({ subtaskId, taskId: sub.taskId, at: iso(d), phase, ...o })
      return doc.deliveries[subtaskId]!
    })
  }

  /** Autonomous mode now. An unreadable preference reads as ON (asking someone who is away is the error) — and SAYS so. */
  const autonomousNow = async (leader: string | undefined, warnings: string[]): Promise<boolean> => {
    try { return await d.autonomous(leader) } catch (e) {
      warnings.push(`autonomous mode could not be read (${e instanceof Error ? e.message.split('\n')[0] : String(e)}) — treated as ON`)
      return true
    }
  }

  /** The owner (no session proof), the flow engine itself, the recorded leader, or a leader session of this delivery's task. */
  const leads = async (r: DeliveryRecord, actor: string): Promise<boolean> => {
    if (actor === 'owner' || actor.startsWith('flow:')) return true
    if (r.leaderSessionId && actor === r.leaderSessionId) return true
    const sessions = await d.facts.sessions().catch(() => [])
    return sessions.some(x => x.id === actor && x.role === 'leader' && x.taskId === r.taskId)
  }
  const isReply = (v: DeliveryRecord | DeliveryReply): v is DeliveryReply => 'status' in v && 'ok' in v

  /** Gate evidence onto a record (revision-stamped), plus the facts the gate established. */
  const absorb = (r: DeliveryRecord, name: GateName, v: GateVerdict) => {
    r.gates[name] = { ok: v.ok, at: iso(d), revision: r.revision, ...(v.evidence ? { evidence: v.evidence } : {}), ...(v.reason ? { reason: v.reason } : {}), ...(v.missing?.length ? { missing: v.missing } : {}) }
    if (v.patch) Object.assign(r, v.patch)
    r.updatedAt = iso(d)
  }

  /** Types into the leader's composer. true = delivered; a failed wake is a warning AND false, so a cadence is never stamped for it. */
  const wake = async (r: DeliveryRecord, text: string, warnings: string[]): Promise<boolean> => {
    if (!r.leaderSessionId) { warnings.push('no leader recorded on this delivery — nobody was woken'); return false }
    if (!(await d.notify.session(r.leaderSessionId, `[entrega ${r.subtaskId}] ${text}`).catch(() => false))) { warnings.push(`the leader ${r.leaderSessionId} could not be woken`); return false }
    return true
  }

  /** The effects of a stored transition. Never throws; failures become warnings. */
  const effects = async (before: DeliveryRecord, after: DeliveryRecord, actor: string, warnings: string[]) => {
    const guard = async (what: string, fn: () => Promise<unknown>) => { try { await fn() } catch (e) { warnings.push(`${what}: ${e instanceof Error ? e.message : String(e)}`) } }
    await guard('board status', async () => { const out = await d.board.setPhaseStatus(after.subtaskId, after.phase); if (!out.ok) warnings.push(`board status refused: ${out.message ?? '?'}`) })
    if (before.ci !== after.ci) await guard('ci signal', () => d.board.setCi(after.subtaskId, after.ci ?? null))
    const step = STEP_ON_ENTER[after.phase]
    if (step) await guard('step', () => d.board.logStep(after.taskId, after.subtaskId, step, actor))
    const last = after.history.at(-1)
    const skipNote = after.skips.length > before.skips.length ? ` Portão humano para ${after.skips.at(-1)!.phase}: pulado: modo autônomo (o líder decide).` : ''
    await guard('comment', () => d.board.comment(after.taskId, after.subtaskId, `[fluxo entrega] ${before.phase} → ${after.phase} (rev ${after.revision}) por ${actor}.${last?.detail ? ` ${last.detail}` : ''}${skipNote}`))
    await guard('emit', () => d.emit('entrega.etapa', { subtarefa: after.subtaskId, taskId: after.taskId, fase: after.phase, de: before.phase, revisao: after.revision, ...(after.origin ? { volta_para: after.origin } : {}), ...(after.block ? { motivo: after.block.reason } : {}) }))
    // The one-shot backfill (`flow reconcile --release`) only records the past: it wakes nobody and rings no bell per piece —
    // the report it returns is the one account of what moved.
    if (actor === RECONCILE_ACTOR) return
    // Each transition fires the next step by itself.
    const t = `${before.phase}>${after.phase}`
    // Only the tick's own detection is announced: a leader's `flow release` declaration already knows what it did.
    if (t === 'revisao_lider>ci' && actor === 'flow:entrega') await wake(after,`o PR #${after.pr ?? '?'} já foi mergeado (${after.mergeSha?.slice(0, 9) ?? '?'}): o fluxo moveu a peça para ci sozinho; ela publica quando a primeira tag que contém o merge tiver a release.yml verde.`, warnings)
    const author = after.authorSessionId
    if (t === 'executando>qa' || t === 'ajuste>qa') await wake(after, `pronta para QA no sha ${after.headSha?.slice(0, 9) ?? '?'}. Abra o QA em OUTRO modelo (agentop flow qa open --subtask ${after.subtaskId}); o veredito vai por agentistics_task_phase to=revisao_lider|ajuste.`, warnings)
    if (t === 'qa>revisao_lider') await wake(after, `QA APROVADO no sha ${after.qaSha?.slice(0, 9) ?? '?'} (${after.qaModel ?? '?'} sobre ${after.authorModel ?? '?'}). Revise esse sha e mova para pr_merge (reviewedSha) ou ajuste.`, warnings)
    if (t === 'qa>ajuste' || t === 'revisao_lider>ajuste') {
      const body = t === 'qa>ajuste' ? `QA REPROVADO. Achados:\n${after.qa?.findings ?? ''}` : `A revisão do líder pede mudança:\n${after.review?.detail ?? ''}`
      const sent = author ? await d.notify.session(author, `[entrega ${after.subtaskId} · ajuste] ${body}\nCorrija, rode os testes, commit + push e mova para qa (agentistics_task_phase to=qa). Ajuste nunca vai direto à revisão.`).catch(() => false) : false
      if (!sent) await wake(after, `${body}\nO autor não foi alcançado: reabra-o ou abra um novo worker em ajuste.`, warnings)
    }
    if (t === 'pr_merge>revisao_lider' || t === 'ci>revisao_lider') await wake(after, `${t === 'ci>revisao_lider' ? 'a publicação falhou' : 'o merge falhou'}: ${last?.detail ?? ''}. Revise e mande para ajuste → QA → revisão → PR/merge.`, warnings)
    if (after.phase === 'publicado') {
      await wake(after, `publicado (${after.tag ?? after.ci?.tag ?? 'tag ?'}).`, warnings)
      // Informational only — the owner is never asked anything by this flow in autonomous mode.
      await guard('owner notice', () => d.notify.owner(`Publicado: ${after.subtaskId} (${after.tag ?? after.ci?.tag ?? after.versionTarget ?? ''}).`, 'aviso'))
    }
  }

  const transition = async (subtaskId: string, to: unknown, input: TransitionInput, actor: string, known?: ReadonlyMap<GateName, GateVerdict>): Promise<DeliveryReply> => {
    const got = await ensure(subtaskId)
    if (isReply(got)) return got
    if (got.dequeued) return fail(422, 'fora_da_fila', 'this piece was dequeued; stage it explicitly before starting it again', [], got)
    if (!isPhase(to)) return fail(400, 'fase_desconhecida', `unknown phase ${String(to)}`)
    if (got.phase === 'fila' && to === 'executando') {
      const sub = await d.facts.subtask(subtaskId)
      if (sub && ['in_review', 'done', 'abandoned'].includes(sub.status)) return fail(422, 'fora_da_fila', `board status is ${sub.status}; this piece is no longer queued`, [], got)
    }
    const edge = EDGES[`${got.phase}>${to}`]
    // Gates are run fresh by the transition itself (outside the lock), so a caller never brings proof. `known` is the tick's
    // own verdict from the same instant (the `release` gate it already ran), never anything a caller states.
    const verdicts = new Map<GateName, GateVerdict>()
    if (edge) for (const g of edge.gates) verdicts.set(g, known?.get(g) ?? await runGate(g, got, d.facts))
    const warnings: string[] = []
    const autonomous = await autonomousNow(got.leaderSessionId, warnings)
    const out = await d.store.update(doc => {
      const cur = doc.deliveries[subtaskId]
      if (!cur) return { kind: 'gone' as const }
      if (cur.revision !== got.revision) return { kind: 'moved' as const, cur }
      for (const [g, v] of verdicts) absorb(cur, g, v)
      const plan = planTransition(cur, to, input, { at: iso(d), actor, autonomous })
      if (!plan.ok) return { kind: 'refused' as const, plan, cur: structuredClone(cur) }
      doc.deliveries[subtaskId] = plan.next
      return { kind: 'moved-ok' as const, before: got, after: plan.next, skipped: plan.skipped }
    })
    if (out.kind === 'gone') return fail(404, 'no_delivery', 'the delivery record vanished')
    if (out.kind === 'moved') return fail(409, 'revisao_obsoleta', `the delivery moved meanwhile (now ${out.cur.phase}, rev ${out.cur.revision}); read it again`, [], out.cur)
    if (out.kind === 'refused') {
      if (out.plan.code === 'aguardando_dono' && !autonomous) {
        // ONE bell per (subtask, phase, revision): a retried transition is the same question, not a new one.
        const first = await d.store.update(doc => {
          const c = doc.deliveries[subtaskId]
          if (!c) return false
          const asked = (c.asked ??= {})
          if (asked[to] === c.revision) return false
          asked[to] = c.revision
          return true
        })
        if (first) await d.notify.owner(`Aprovação pedida: ${subtaskId} quer entrar em ${String(to)} (portão humano). Aprove ou reprove no cartão da Live (botão), ou com: agentop flow approve --subtask ${subtaskId} --phase ${String(to)} --decision approve|reject.`, 'decisao').catch(() => undefined)
        const fresh = await d.store.get(subtaskId)
        return refused(out.plan, fresh ?? out.cur)
      }
      return refused(out.plan, out.cur)
    }
    await effects(out.before, out.after, actor, warnings)
    return { ok: true, status: 200, record: out.after, warnings, ...(out.skipped ? { skipped: out.skipped } : {}) }
  }

  const gate = async (subtaskId: string, name: unknown, actor: string): Promise<DeliveryReply> => {
    if (!isGate(name)) return fail(400, 'portao_desconhecido', `unknown gate ${String(name)}; gates: ${GATES.join(', ')}`)
    const got = await ensure(subtaskId)
    if (isReply(got)) return got
    const v = await runGate(name, got, d.facts)
    const after = await d.store.update(doc => {
      const cur = doc.deliveries[subtaskId]
      if (!cur) return null
      absorb(cur, name, v)
      if (!actor.startsWith('flow:')) cur.leaderTouchedAt = iso(d)
      return structuredClone(cur)
    })
    if (!after) return fail(404, 'no_delivery', 'the delivery record vanished')
    const warnings: string[] = []
    const step = STEP_ON_GATE[`${after.phase}:${name}`]
    if (v.ok && step) await d.board.logStep(after.taskId, after.subtaskId, step, actor).catch(e => warnings.push(String(e)))
    if (name === 'release' && v.patch?.ci) await d.board.setCi(after.subtaskId, v.patch.ci).catch(e => warnings.push(String(e)))
    return v.ok ? { ok: true, status: 200, record: after, warnings, gate: v } : { ok: false, status: 422, code: GATE_REFUSED, sentence: v.reason ?? `${name} refused`, missing: v.missing ?? [], record: after, gate: v }
  }

  const block = async (subtaskId: string, reason: unknown, text: string, actor: string): Promise<DeliveryReply> => {
    const got = await ensure(subtaskId)
    if (isReply(got)) return got
    const blockWarnings: string[] = []
    const autonomous = await autonomousNow(got.leaderSessionId, blockWarnings)
    const out = await d.store.update(doc => {
      const cur = doc.deliveries[subtaskId]!
      const plan = planBlock(cur, reason, text, { at: iso(d), actor, autonomous })
      if (plan.ok) doc.deliveries[subtaskId] = plan.next
      return { plan, before: structuredClone(cur) }
    })
    if (!out.plan.ok) return refused(out.plan, out.before)
    const after = out.plan.next
    const warnings: string[] = [...blockWarnings]
    await effects(out.before, after, actor, warnings)
    const b = after.block!
    let woke = false
    if (b.reason === 'decisao_do_dono') await d.notify.owner(`Precisa da sua decisão: ${subtaskId} — ${b.text}`, 'decisao').catch(() => undefined)
    else if (b.reason === 'fora_das_autorizacoes') {
      // Autonomous mode: the safe path is decided NOW — the piece LEAVES Bloqueado for the next batch's queue (never parked there).
      const moved = await deferOut(after, `[fluxo entrega] bloqueio fora das autorizações: peça adiada para o próximo lote (bloqueio de 0 h: ${b.text}); voltou para a fila e o bloqueio fica no histórico. Registro do líder; o dono não foi chamado.`).catch(() => false)
      if (!moved) warnings.push('the piece could not be moved out of Bloqueado')
      woke = await wake(after, `bloqueio fora das autorizações (${b.text}). Modo autônomo: NÃO faça a ação; a peça foi adiada para o próximo lote e voltou para a fila — escolha o caminho seguro e registre.`, warnings)
      return { ok: true, status: 200, record: (await d.store.get(subtaskId)) ?? after, warnings }
    } else if (b.reason !== 'dependencia') woke = await wake(after, `bloqueada (${b.reason}): ${b.text}. Quem destrava: o líder. Destrave com agentistics_task_phase action=unblock.`, warnings)
    // The cadence is stamped only for a wake that REACHED the leader: a dead leader is not "woken" (the next tick tries again).
    if (woke) await d.store.update(doc => { const c = doc.deliveries[subtaskId]; if (c?.block && b.reason !== 'dependencia') { c.block.lastWakeAt = iso(d); c.block.wakes = (c.block.wakes ?? 0) + 1 } })
    return { ok: true, status: 200, record: after, warnings }
  }

  const unblock = async (subtaskId: string, actor: string, detail?: string, to?: unknown): Promise<DeliveryReply> => {
    const got = await d.store.get(subtaskId)
    if (!got) return fail(404, 'no_delivery', `no delivery record for ${subtaskId}`)
    if (got.block) {
      // Who lifts a block is part of the block (spec §Bloqueio): the leader, the owner for a decision only the owner can take
      // (autonomous OFF — with it ON that decision is the leader's safe path), and the flow itself for a finished dependency.
      const autonomous = await d.autonomous(got.leaderSessionId).catch(() => true)
      const who = unlockerOf(got.block.reason)
      if (who === 'owner' && !autonomous) {
        if (actor !== 'owner') return fail(403, 'so_o_dono', 'only the owner lifts a block waiting on an owner decision (a session cannot)', [], got)
      } else if (!(await leads(got, actor))) return fail(403, 'so_o_lider', 'only the leader of the task (or the owner) lifts a block', [], got)
    }
    const out = await d.store.update(doc => {
      const cur = doc.deliveries[subtaskId]!
      const plan = planUnblock(cur, { at: iso(d), actor, ...(detail ? { detail } : {}), ...(to !== undefined ? { to } : {}) })
      if (plan.ok) doc.deliveries[subtaskId] = plan.next
      return { plan, before: structuredClone(cur) }
    })
    if (!out.plan.ok) return refused(out.plan, out.before)
    const warnings: string[] = []
    await effects(out.before, out.plan.next, actor, warnings)
    await d.emit('entrega.destravada', { subtarefa: subtaskId, fase: out.plan.next.phase }).catch(() => undefined)
    return { ok: true, status: 200, record: out.plan.next, warnings }
  }

  /** The owner's approve/reject of a human gate. Only ever meaningful with autonomous mode OFF. */
  const approve = async (subtaskId: string, phase: unknown, decision: unknown, note: string | undefined, owner: boolean): Promise<DeliveryReply> => {
    if (!owner) return fail(403, 'so_o_dono', 'only the owner approves a human gate (a session cannot)')
    if (!isPhase(phase)) return fail(400, 'fase_desconhecida', `unknown phase ${String(phase)}`)
    if (decision !== 'approve' && decision !== 'reject') return fail(400, 'bad_decision', 'decision must be approve or reject')
    const got = await d.store.get(subtaskId)
    if (!got) return fail(404, 'no_delivery', `no delivery record for ${subtaskId}`)
    if (!got.humanGates.includes(phase)) return fail(422, 'sem_portao_humano', `${phase} has no human gate on this delivery`)
    // Only a question that was ASKED is answered: the transition raised it (autonomous OFF) at this revision.
    if (got.asked?.[phase] !== got.revision) return fail(409, 'nao_perguntado', `the owner was not asked to approve entering ${phase} at this revision — the leader's transition to ${phase} asks first`, [], got)
    const after = await d.store.update(doc => {
      const cur = doc.deliveries[subtaskId]!
      cur.approvals[phase] = { decision, at: iso(d), revision: cur.revision, ...(note ? { note } : {}) }
      cur.updatedAt = iso(d)
      return structuredClone(cur)
    })
    await d.board.comment(after.taskId, subtaskId, `[fluxo entrega] o dono ${decision === 'approve' ? 'aprovou' : 'reprovou'} a entrada em ${phase}${note ? `: ${note}` : ''}.`).catch(() => undefined)
    const warnings: string[] = []
    await wake(after, `o dono ${decision === 'approve' ? 'aprovou' : 'reprovou'} ${phase}${note ? `: ${note}` : ''}.`, warnings)
    return { ok: true, status: 200, record: after, warnings }
  }

  /** Delivery settings the leader owns: version target, human gates, allowed deletions, leader, PR, tag. */
  const configure = async (subtaskId: string, patch: Record<string, unknown>, actor: string): Promise<DeliveryReply> => {
    const got = await ensure(subtaskId)
    if (isReply(got)) return got
    // The leader (or the owner) owns these settings: version target, human gates, deletions, leader, PR, tag.
    // `qaSessionId` / `authorSessionId` are NOT settings: the host records them from the sessions it opened / the registry.
    if (!(await leads(got, actor))) return fail(403, 'so_o_lider', 'only the leader of the task (or the owner) configures a delivery', [], got)
    const after = await d.store.update(doc => {
      const cur = doc.deliveries[subtaskId]!
      if (typeof patch.versionTarget === 'string' && patch.versionTarget.trim()) cur.versionTarget = patch.versionTarget.trim()
      if (Array.isArray(patch.humanGates)) cur.humanGates = [...new Set(patch.humanGates.filter(isPhase).filter(p => p !== 'fila' && p !== 'bloqueado'))]
      if (typeof patch.leaderSessionId === 'string' && SUB_ID.test(patch.leaderSessionId)) cur.leaderSessionId = patch.leaderSessionId
      if (typeof patch.pr === 'number' && Number.isInteger(patch.pr) && patch.pr > 0) cur.pr = patch.pr
      if (typeof patch.tag === 'string' && /^v?\d[\w.-]*$/.test(patch.tag)) cur.tag = patch.tag
      const del = patch.allowDeletions as { paths?: unknown; reason?: unknown } | undefined
      if (del && Array.isArray(del.paths) && typeof del.reason === 'string' && del.reason.trim()) cur.allowDeletions = { paths: del.paths.filter((p): p is string => typeof p === 'string'), reason: del.reason.trim() }
      cur.updatedAt = iso(d)
      if (!actor.startsWith('flow:')) cur.leaderTouchedAt = iso(d) // a leader acting on the piece restarts its reminder clock
      return structuredClone(cur)
    })
    await d.board.comment(after.taskId, subtaskId, `[fluxo entrega] configuração por ${actor}: ${Object.keys(patch).join(', ')}.`).catch(() => undefined)
    return { ok: true, status: 200, record: after, warnings: [] }
  }

  /** A worker reports which step of its current phase it is on (the Live's per-phase %). */
  const step = async (subtaskId: string, n: unknown, actor: string): Promise<DeliveryReply> => {
    const got = await d.store.get(subtaskId)
    if (!got) return fail(404, 'no_delivery', `no delivery record for ${subtaskId}`)
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 9) return fail(400, 'bad_step', 'step must be an integer 1..9')
    const after = await d.store.update(doc => { const c = doc.deliveries[subtaskId]!; c.step = n; c.updatedAt = iso(d); return structuredClone(c) })
    await d.board.logStep(after.taskId, subtaskId, n, actor)
    return { ok: true, status: 200, record: after, warnings: [] }
  }

  /**
   * The same report for a piece with NO delivery record (a legacy piece the flow never adopted): only the board's
   * `step` event is written — no record is created, so reporting a step never moves a piece into the flow.
   * The Live reads that event through `stepOf`, exactly as it does for a recorded delivery.
   */
  const stepEvent = async (subtaskId: string, n: unknown, actor: string): Promise<StepEventReply> => {
    if (!SUB_ID.test(subtaskId)) return fail(400, 'bad_subtask', 'invalid subtask id')
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 9) return fail(400, 'bad_step', 'step must be an integer 1..9')
    const sub = await d.facts.subtask(subtaskId)
    if (!sub) return fail(404, 'no_such_subtask', `subtask ${subtaskId} does not exist on the board`)
    await d.board.logStep(sub.taskId, subtaskId, n, actor)
    return { ok: true, status: 200, step: n, recorded: 'event' }
  }

  /** P4 — write the pre-dispatch (staged session) on the subtask and open its delivery at `fila`. */
  const stage = async (subtaskId: string, draft: Record<string, unknown>, actor: string, opts: { leaderSessionId?: string; versionTarget?: string; pedidoId?: string; pedidoIds?: readonly string[] } = {}): Promise<DeliveryReply> => {
    const sub = await d.facts.subtask(subtaskId)
    if (!sub) return fail(404, 'no_such_subtask', `subtask ${subtaskId} does not exist on the board`)
    if (sub.groupMember) return fail(422, 'subtask_in_group', 'stage the group, not its member')
    const merged = { ...(sub.staged ?? {}), ...draft }
    const written = await d.board.stage(subtaskId, merged)
    if (!written.ok) return fail(422, 'stage_refused', written.message ?? 'the board refused the staged session')
    const got = await ensure(subtaskId, { ...(opts.leaderSessionId ? { leaderSessionId: opts.leaderSessionId } : {}), ...(opts.versionTarget ? { versionTarget: opts.versionTarget } : {}) })
    if (isReply(got)) return got
    if (opts.leaderSessionId && !got.leaderSessionId) await d.store.update(doc => { doc.deliveries[subtaskId]!.leaderSessionId = opts.leaderSessionId })
    const v = await runGate('predispatch', got, d.facts)
    // A complete pre-dispatch also gets its EXPECTED SLOT read now, so "Na fila" shows a verdict instead of "not checked yet".
    const vaga = v.ok && got.phase === 'fila' ? await runGate('vaga', got, d.facts) : null
    const after = await d.store.update(doc => {
      const c = doc.deliveries[subtaskId]!
      if (c.dequeued) {
        c.revision++
        c.history.push({ from: 'fila', to: 'fila', at: iso(d), actor, detail: 'restaged explicitly after dequeue', revision: c.revision })
        delete c.dequeued
      }
      if (opts.pedidoId || opts.pedidoIds?.length) c.pedidoIds = [...new Set([...(c.pedidoIds ?? []), ...(opts.pedidoId ? [opts.pedidoId] : []), ...(opts.pedidoIds ?? [])])]
      absorb(c, 'predispatch', v); if (vaga) absorb(c, 'vaga', vaga)
      return structuredClone(c)
    })
    await d.board.setPhaseStatus(subtaskId, after.phase).catch(() => undefined)
    const warnings = v.ok ? [] : [`pre-dispatch still incomplete: ${v.reason}`]
    const fits: Array<{ subtaskId: string; signals: string[] }> = []
    if (v.ok && after.phase === 'fila') for (const r of Object.values((await d.store.read()).deliveries).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.subtaskId.localeCompare(b.subtaskId))) {
      if (r.subtaskId === subtaskId || r.taskId !== after.taskId || r.phase !== 'fila' || r.dequeued) continue
      const other = await d.facts.subtask(r.subtaskId).catch(() => null)
      if (!other || other.groupMember || ['in_review', 'done', 'abandoned'].includes(other.status)) continue
      const signals = sharedQueueArea(String(merged.prompt ?? ''), other.staged?.prompt ?? '')
      if (signals.length) fits.push({ subtaskId: r.subtaskId, signals })
    }
    for (const fit of fits) warnings.push(`encaixe: ${fit.subtaskId} already queues the same area (${fit.signals.join(', ')}); extend its brief or join the pieces into a group with agentistics_task_subtask`)
    if (v.ok) await d.emit('subtarefa.preparada', { subtarefa: subtaskId, taskId: after.taskId, ...(opts.pedidoId ? { pedido: opts.pedidoId } : {}), encaixe: fits }).catch(() => undefined)
    return { ok: true, status: 200, record: after, warnings, gate: v }
  }

  /** `agentop flow stage run`: gates (predispatch + vaga) → spawn the staged session → executando. */
  const stageRun = async (subtaskId: string, actor: string): Promise<DeliveryReply> => {
    const got = await ensure(subtaskId)
    if (isReply(got)) return got
    if (got.dequeued) return fail(422, 'fora_da_fila', 'this piece was dequeued; stage it explicitly before starting it again', [], got)
    if (got.phase !== 'fila') return fail(422, 'fase_pulada', `stage run starts a delivery from fila; this one is in ${got.phase}`)
    const sub = await d.facts.subtask(subtaskId)
    if (sub && ['in_review', 'done', 'abandoned'].includes(sub.status)) return fail(422, 'fora_da_fila', `board status is ${sub.status}; this piece is no longer queued`, [], got)
    if (!d.spawn) return fail(501, 'sem_spawn', 'this host cannot start sessions')
    for (const g of ['predispatch', 'vaga'] as const) {
      const v = await runGate(g, got, d.facts)
      if (!v.ok) { await d.store.update(doc => absorb(doc.deliveries[subtaskId]!, g, v)); return fail(422, 'portao', `${g}: ${v.reason}`, v.missing ?? []) }
    }
    // ONE session per piece: the claim is taken UNDER the store lock before anything is spawned, so two ticks, a tick and a
    // leader's `sim`, or two CLI calls can never open two sessions for the same queued piece (FILA.PRIORIDADE idempotency).
    const claim = await d.store.update(doc => {
      const c = doc.deliveries[subtaskId]
      if (!c || c.phase !== 'fila' || c.dequeued) return 'gone' as const
      if (startClaimLive(c.queueAsk, d.now())) return 'busy' as const
      const created = !c.queueAsk
      c.queueAsk = { ...(c.queueAsk ?? { at: iso(d), delivered: true }), startingAt: iso(d) }
      return created ? 'claimed-new' as const : 'claimed' as const
    })
    if (claim === 'busy') return fail(409, 'ja_iniciando', 'another call is already opening this piece\'s session', [], got)
    if (claim === 'gone') return fail(409, 'revisao_obsoleta', 'the piece left the queue meanwhile', [], (await d.store.get(subtaskId)) ?? got)
    const release = () => d.store.update(doc => {
      const c = doc.deliveries[subtaskId]
      if (!c?.queueAsk) return
      delete c.queueAsk.startingAt
      if (claim === 'claimed-new') delete c.queueAsk
    }).catch(() => undefined)
    let spawned: Awaited<ReturnType<NonNullable<DeliveryDeps['spawn']>>>
    try { spawned = await d.spawn(got, { ...(sub?.staged ?? {}) }) } catch (e) { await release(); throw e }
    if (!spawned.ok) { await release(); return fail(422, 'spawn_failed', spawned.message) }
    await d.store.update(doc => { doc.deliveries[subtaskId]!.authorSessionId = spawned.sessionId })
    const moved = await transition(subtaskId, 'executando', { detail: `sessão ${spawned.sessionId} aberta pelo pré-dispatch` }, actor)
    if (!moved.ok) await release()
    return moved
  }

  /** `agentop flow qa open`: start the QA session in ANOTHER model (refused up front when it is the author's or Sonnet over Sonnet). */
  const qaOpen = async (subtaskId: string, staged: Record<string, unknown>, actor: string): Promise<DeliveryReply> => {
    const got = await d.store.get(subtaskId)
    if (!got) return fail(404, 'no_delivery', `no delivery record for ${subtaskId}`)
    if (got.phase !== 'qa') return fail(422, 'fase_pulada', `QA opens in the qa phase; this delivery is in ${got.phase}`)
    if (!d.spawn) return fail(501, 'sem_spawn', 'this host cannot start sessions')
    const model = typeof staged.model === 'string' ? staged.model : ''
    if (!model || !staged.harness || !staged.prompt) return fail(422, 'faltando', 'QA needs harness, model and prompt', ['harness', 'model', 'prompt'])
    const { modelFamily } = await import('./gates')
    if (got.authorModel && (model === got.authorModel || (modelFamily(model) === 'sonnet' && modelFamily(got.authorModel) === 'sonnet'))) return fail(422, 'portao', `QA must run another model than the author (${got.authorModel}); never Sonnet over Sonnet`, ['outro modelo'])
    const sub = await d.facts.subtask(subtaskId)
    const spawned = await d.spawn(got, { cwd: sub?.staged?.cwd, ...staged, label: `QA ${sub?.title ?? subtaskId}` })
    if (!spawned.ok) return fail(422, 'spawn_failed', spawned.message)
    await d.store.update(doc => { const c = doc.deliveries[subtaskId]!; c.qaSessionId = spawned.sessionId; c.qaModel = model })
    await d.board.logStep(got.taskId, subtaskId, 1, actor).catch(() => undefined)
    const v = await gate(subtaskId, 'qa-modelo', actor)
    return v.ok ? v : { ...v, status: 422 }
  }

  /** `agentop flow ajustes open`: hand the findings back to the author (or tell the leader nobody can take them). */
  const ajustesOpen = async (subtaskId: string, actor: string): Promise<DeliveryReply> => {
    const got = await d.store.get(subtaskId)
    if (!got) return fail(404, 'no_delivery', `no delivery record for ${subtaskId}`)
    if (got.phase !== 'ajuste') return fail(422, 'fase_pulada', `ajustes open in the ajuste phase; this delivery is in ${got.phase}`)
    const findings = got.history.at(-1)?.from === 'qa' ? got.qa?.findings ?? '' : got.review?.detail ?? got.history.at(-1)?.detail ?? ''
    const warnings: string[] = []
    const sent = got.authorSessionId ? await d.notify.session(got.authorSessionId, `[entrega ${subtaskId} · ajuste] ${findings}\nCorrija, teste, commit + push e mova para qa. Ajuste nunca vai direto à revisão.`).catch(() => false) : false
    if (!sent) await wake(got, `ajuste sem autor alcançável — abra um novo worker com os achados: ${findings}`, warnings)
    void actor
    return { ok: true, status: 200, record: got, warnings }
  }

  /** `agentop flow merge`: delecoes → squash merge → ci; a failure goes back to the leader review. */
  const merge = async (subtaskId: string, actor: string): Promise<DeliveryReply> => {
    const got = await d.store.get(subtaskId)
    if (!got) return fail(404, 'no_delivery', `no delivery record for ${subtaskId}`)
    if (got.phase !== 'pr_merge') return fail(422, 'fase_pulada', `merge runs in pr_merge; this delivery is in ${got.phase}`)
    if (!d.merge) return fail(501, 'sem_merge', 'this host cannot merge')
    const del = await gate(subtaskId, 'delecoes', actor)
    if (!del.ok) return transition(subtaskId, 'revisao_lider', { detail: `deleção pura detectada: ${del.sentence}` }, actor)
    const fresh = (await d.store.get(subtaskId))!
    const m = await d.merge(fresh)
    if (!m.ok) return transition(subtaskId, 'revisao_lider', { detail: `merge falhou: ${m.message}` }, actor)
    await d.store.update(doc => { doc.deliveries[subtaskId]!.pr = m.pr })
    return transition(subtaskId, 'ci', { mergeSha: m.mergeSha, detail: `PR #${m.pr} mergeado (${m.mergeSha.slice(0, 9)})` }, actor)
  }

  /**
   * `agentop flow release`: a leader DECLARES what a release contains. The Live used to guess it from git (worker shas,
   * patch-ids) and a release assembled from ~15 merged branches with conflict fixes, squashed into one commit, almost
   * never matched. Each named subtask gets its delivery record (a legacy piece is ADOPTED, like `ensure` does), the
   * version and the main merge sha, and is put in `ci`; when the tag is already published and green the same call moves
   * it to `publicado` (otherwise the minute tick does), with `publishedAt` = the release's own publish time.
   *
   * ALL-OR-NOTHING on validation and persistence: final records land in one atomic write before effects. Idempotent: a
   * piece already published for this very version + merge sha + repository is left as it is. The release EVIDENCE is still read from
   * the host (gh): the caller states which pieces, never that it is green.
   */
  const release = async (o: { version: unknown; mergeSha: unknown; subtaskIds: unknown; repo?: unknown }, actor: string): Promise<ReleaseReply> => {
    const version = typeof o.version === 'string' ? o.version.trim().replace(/^v/, '') : ''
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) return fail(400, 'bad_version', 'version must look like 2.201.0')
    const rawSha = typeof o.mergeSha === 'string' ? o.mergeSha.trim().toLowerCase() : ''
    if (!/^[0-9a-f]{7,40}$/.test(rawSha)) return fail(400, 'bad_merge_sha', 'merge-sha must be the commit on main that carries the release (7–40 hex characters)')
    // ONE repository per release: recorded on every piece, read by the release gate (the author sessions' checkouts are irrelevant).
    const repoIn = typeof o.repo === 'string' ? o.repo.trim() : ''
    if (repoIn && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoIn)) return fail(400, 'bad_repo', 'repo must look like owner/name')
    const repo = repoIn || DEFAULT_RELEASE_REPO
    const ids = Array.isArray(o.subtaskIds) ? [...new Set(o.subtaskIds.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean))] : []
    if (!ids.length) return fail(400, 'no_subtasks', 'name at least one subtask of the release (--subtask S, repeated)', ['subtarefas'])
    const bad = ids.find(id => !SUB_ID.test(id))
    if (bad) return fail(400, 'bad_subtask', `invalid subtask id ${bad}`)
    const tag = `v${version}`

    // The FULL sha is stored (a short one never matches a gh headSha). A short one is resolved by git, then by gh, and is
    // REFUSED when neither resolves it to 40 characters — never stored as the unmatchable string it was typed as.
    let mergeSha = rawSha
    if (rawSha.length < 40) {
      const cwd = (await d.facts.repoCwd?.().catch(() => null)) ?? '.'
      const viaGit = (await d.facts.git(cwd, ['rev-parse', '--verify', `${rawSha}^{commit}`]).catch(() => '')).trim().toLowerCase()
      let full = /^[0-9a-f]{40}$/.test(viaGit) && viaGit.startsWith(rawSha) ? viaGit : ''
      if (!full) {
        const viaGh = (await d.facts.gh(cwd, ['api', `repos/${repo}/commits/${rawSha}`, '--jq', '.sha']).catch(() => '')).trim().toLowerCase()
        full = /^[0-9a-f]{40}$/.test(viaGh) && viaGh.startsWith(rawSha) ? viaGh : ''
      }
      if (!full) return fail(422, 'sha_nao_resolve', `merge-sha ${rawSha} does not resolve to a 40-character commit in ${repo}: pass the full sha`, ['sha completo'])
      mergeSha = full
    }

    // ---- validate everything first
    const sessions = await d.facts.sessions().catch(() => [])
    const leaderTask = sessions.find(x => x.id === actor && x.role === 'leader')?.taskId
    let expectedTask = leaderTask
    const plan: Array<{ id: string; have: DeliveryRecord | null; taskId: string; subStatus?: string }> = []
    for (const id of ids) {
      const have = await d.store.get(id)
      const sub = await d.facts.subtask(id)
      if (!sub && !have) return fail(404, 'no_such_subtask', `subtask ${id} does not exist on the board`)
      const taskId = have?.taskId ?? sub!.taskId
      expectedTask ??= taskId
      if (taskId !== expectedTask) return fail(422, 'outra_tarefa', `subtask ${id} belongs to task ${taskId}, not ${expectedTask}: one release declaration names the pieces of one task`, [`subtarefa de ${expectedTask}`], have ?? undefined)
      // A blocked piece is refused whether the flow knows it (a record in `bloqueado`) or only the board does (a legacy piece, no record yet).
      if (have?.phase === 'bloqueado' || sub?.status === 'blocked') return fail(422, 'bloqueada', `${id} is blocked (${have?.block?.reason ?? 'blocked on the board'}): unblock it before declaring it in a release`, ['desbloqueio'], have ?? undefined)
      const samePublished = have?.phase === 'publicado' && have.versionTarget === version && have.mergeSha?.toLowerCase() === mergeSha && have.releaseRepo === repo
      // Publishing itself sets the board to done. That status must allow a retry of THIS release.
      if (sub?.status === 'abandoned' || (sub?.status === 'done' && !samePublished)) return fail(422, 'peca_encerrada', `${id} is ${sub.status} on the board: a finished or given-up piece is not part of a release`, [], have ?? undefined)
      if (have?.phase === 'publicado' && (have.versionTarget !== version || have.mergeSha?.toLowerCase() !== mergeSha || have.releaseRepo !== repo)) {
        return fail(422, 'ja_publicada', `${id} is already published (${have.tag ?? have.versionTarget ?? '?'} in ${have.releaseRepo ?? 'unknown repository'}); version, commit and repository must match`, [], have)
      }
      plan.push({ id, have, taskId, subStatus: sub?.status })
    }
    const isLeaderSession = sessions.some(x => x.id === actor && x.role === 'leader')
    for (const p of plan) {
      const may = p.have ? await leads(p.have, actor) : actor === 'owner' || actor.startsWith('flow:') || (isLeaderSession && leaderTask === p.taskId)
      if (!may) return fail(403, 'so_o_lider', 'only the leader of the task (or the owner) declares a release', [], p.have ?? undefined)
    }

    // ---- write: the WHOLE batch in ONE store update (one file write), so it lands entirely or not at all. A refusal that
    // can only be seen under the lock (a record that moved meanwhile) also refuses the whole batch, before any write.
    const warnings: string[] = []
    const at = iso(d)
    const declared = { version, mergeSha, repo, at, by: actor }
    // Prepare records and read the shared evidence BEFORE committing anything. Declaration, gate evidence and
    // publication all land in the same atomic file replacement; no effects escape an unsuccessful write.
    const drafts: Array<{ id: string; before: DeliveryRecord; after: DeliveryRecord; changed: boolean; transitions: Array<{ before: DeliveryRecord; after: DeliveryRecord }>; askOwner?: boolean }> = []
    for (const p of plan) {
      const cur = p.have ?? newDelivery({ subtaskId: p.id, taskId: p.taskId, at, phase: adoptPhase(p.subStatus), versionTarget: version, ...(isLeaderSession ? { leaderSessionId: actor } : {}) })
      if (cur.phase === 'publicado' || (cur.phase === 'ci' && cur.mergeSha?.toLowerCase() === mergeSha && cur.versionTarget === version && cur.tag === tag && cur.releaseRepo === repo)) {
        drafts.push({ id: p.id, before: cur, after: structuredClone(cur), changed: false, transitions: [] })
        continue
      }
      const next = structuredClone(cur)
      next.history = [...cur.history, { from: cur.phase, to: 'ci', at, actor, detail: `release v${version} declarada por ${actor} (merge ${mergeSha.slice(0, 9)}, ${repo})`, revision: cur.revision + 1 }]
      next.phase = 'ci'; next.revision = cur.revision + 1; next.updatedAt = at
      next.versionTarget = version; next.mergeSha = mergeSha; next.tag = tag; next.releaseRepo = repo; next.declaredRelease = declared
      next.ci = { mergedMain: true, releaseGreen: false, tagPublished: false, tag, pr: cur.pr ?? null }
      delete next.origin; delete next.block; delete next.step; delete next.publishedAt; delete next.releaseFailNotice
      drafts.push({ id: p.id, before: cur, after: next, changed: true, transitions: [{ before: cur, after: next }] })
    }
    const waiting = drafts.filter(x => x.after.phase === 'ci')
    const v = waiting.length ? await runGate('release', waiting[0]!.after, d.facts) : undefined
    if (v?.ok) {
      const autonomous = await autonomousNow(isLeaderSession ? actor : waiting[0]!.after.leaderSessionId, warnings)
      for (const x of waiting) {
        absorb(x.after, 'release', v)
        const published = planTransition(x.after, 'publicado', { detail: `release v${version} verde e tag ${tag} publicada` }, { at, actor, autonomous })
        if (!published.ok) {
          // Refusing publication never discards a valid declaration: it remains in ci for approval/the tick.
          warnings.push(`${x.id} not published: ${published.code}: ${published.sentence}`)
          if (published.code === 'aguardando_dono' && !autonomous && x.after.asked?.publicado !== x.after.revision) {
            (x.after.asked ??= {}).publicado = x.after.revision
            x.askOwner = true
          }
          continue
        }
        x.transitions.push({ before: x.after, after: published.next })
        x.after = published.next
        x.changed = true
      }
    } else if (v) {
      for (const x of waiting) absorb(x.after, 'release', v)
      if (releaseFailed(v)) {
        warnings.push(`not published: ${v.reason ?? 'the tag run failed'} — the pieces stay in ci; fix the release and re-run, the minute tick publishes them when it is green`)
        for (const x of waiting) x.after.releaseFailNotice = { at, reason: v.reason ?? 'release.yml failed' }
      } else warnings.push(`not published yet: ${v.reason ?? 'release evidence missing'} — the minute tick moves ci → publicado when it is`)
    }
    const batch = await d.store.update(doc => {
      for (const p of plan) {
        const cur = doc.deliveries[p.id]
        if (p.have ? cur?.revision !== p.have.revision : Boolean(cur)) return { kind: 'moved' as const, id: p.id, cur: cur ?? null }
      }
      for (const x of drafts) {
        // A concurrent retry may have asked at this same ci revision while we read gh.
        if (x.askOwner && doc.deliveries[x.id]?.asked?.publicado === x.after.revision) x.askOwner = false
        doc.deliveries[x.id] = x.after
      }
      return { kind: 'ok' as const }
    })
    if (batch.kind === 'moved') return fail(409, 'revisao_obsoleta', `${batch.id} moved meanwhile; nothing was written — run the release again`, [], batch.cur ?? undefined)
    const pieces: ReleasePiece[] = []
    for (const x of drafts) {
      pieces.push({ subtaskId: x.id, phase: x.after.phase, changed: x.changed })
      if (x.askOwner) await d.notify.owner(`Aprovação pedida: ${x.id} quer entrar em publicado (portão humano). Aprove ou reprove no cartão da Live (botão), ou com: agentop flow approve --subtask ${x.id} --phase publicado --decision approve|reject.`, 'decisao').catch(e => warnings.push(`owner notice: ${String(e)}`))
      if (!x.transitions.length && JSON.stringify(x.before.ci) !== JSON.stringify(x.after.ci)) await d.board.setCi(x.id, x.after.ci ?? null).catch(e => warnings.push(`ci signal: ${String(e)}`))
      if (!x.changed) continue
      // The leader is trusted to name the pieces; say so when one never left the queue or was already waiting on another release.
      if (x.before.phase === 'fila') warnings.push(`${x.id} never left the queue (it was never worked through the flow) — declared anyway`)
      if (x.before.phase === 'ci' && x.before.versionTarget && x.before.versionTarget !== version) warnings.push(`${x.id} was waiting in ci for ${x.before.versionTarget} — now declared in ${version}`)
      for (const t of x.transitions) await effects(t.before, t.after, actor, warnings)
    }
    const publishedAt = drafts.find(x => x.after.phase === 'publicado')?.after.publishedAt
    return { ok: true, status: 200, version, tag, mergeSha, pieces, ...(publishedAt ? { publishedAt } : {}), warnings }
  }

  /**
   * The minute tick: blocked pieces, and CI → publicado on evidence. Idempotent, and SERIALISED in the process: the
   * server's own interval and the engine's `entrega-vigiar` timer both call it, and a second tick must read the
   * `lastWakeAt` the first one wrote rather than wake the leader twice.
   */
  let tickChain: Promise<unknown> = Promise.resolve()
  const tick = (): Promise<{ actions: string[] }> => {
    const guarded = async () => { try { return await tickOnce() } catch (e) { if (e instanceof DeliveryStoreUnreadable) return { actions: [`store-unreadable: ${e.message}`] }; throw e } }
    const run = tickChain.then(guarded, guarded)
    tickChain = run.catch(() => undefined)
    return run
  }

  // ------------------------------------------------------------------------------------------------ FILA.PRIORIDADE

  const ASK_AUTHOR = 'flow:fila'
  /** The flow's own message to a leader: header + body, never the standard nudge wrapper. */
  const tellLeader = async (leader: string | undefined, body: string): Promise<boolean> => {
    if (!leader) return false
    return d.notify.session(leader, body, QUEUE_HEADER).catch(() => false)
  }
  const note = (r: Pick<DeliveryRecord, 'taskId' | 'subtaskId'>, text: string) => d.board.comment(r.taskId, r.subtaskId, `[fluxo fila] ${text}`).catch(() => undefined)
  const accountLabel = async (harness?: string, account?: string): Promise<string | undefined> => {
    if (!harness || !account) return undefined
    const n = await d.accountName?.(harness, account).catch(() => null)
    return n && !/^acc_/i.test(n) ? n : undefined
  }

  /** Queued, startable pieces with the board facts the order and the question need. */
  const queueItems = async (): Promise<Array<QueueItem & { rec: DeliveryRecord; sub: NonNullable<Awaited<ReturnType<GateFacts['subtask']>>> }>> => {
    const out: Array<QueueItem & { rec: DeliveryRecord; sub: NonNullable<Awaited<ReturnType<GateFacts['subtask']>>> }> = []
    for (const rec of Object.values((await d.store.read()).deliveries)) {
      if (rec.phase !== 'fila' || rec.dequeued) continue
      const sub = await d.facts.subtask(rec.subtaskId).catch(() => null)
      if (!sub || sub.groupMember || ['in_review', 'done', 'abandoned', 'blocked'].includes(sub.status)) continue
      out.push({ subtaskId: rec.subtaskId, taskId: rec.taskId, title: sub.title, priority: sub.priority ?? 'low', since: rec.createdAt, ...(rec.queueHold ? { hold: rec.queueHold } : {}), ...(rec.queueAsk ? { ask: rec.queueAsk } : {}), rec, sub })
    }
    return orderQueue(out)
  }

  /** The recorded leader when alive, else the task's newest live leader; null = nobody reachable. */
  const liveLeader = (it: { rec: DeliveryRecord; taskId: string; subtaskId: string }, sessions: readonly SessionFact[] | null): string | null =>
    it.rec.leaderSessionId && sessions?.some(s => s.id === it.rec.leaderSessionId && s.alive) ? it.rec.leaderSessionId : (sessions ? leaderFor(sessions, it.taskId, it.subtaskId) : null)

  /** Slots already promised: a question still open or an approved piece not yet started counts as a running worker. */
  const phantomsOf = (items: ReadonlyArray<QueueItem & { sub: { staged?: { harness?: string; model?: string; account?: string } } }>, except?: string): SessionFact[] =>
    items.filter(i => i.ask && i.subtaskId !== except).map(i => ({
      id: `ask:${i.subtaskId}`, harness: i.sub.staged?.harness ?? '', ...(i.sub.staged?.model ? { model: i.sub.staged.model } : {}), ...(i.sub.staged?.account ? { account: i.sub.staged.account } : {}),
      role: 'worker', alive: true, cwd: '', worktree: false,
    }))

  const slotWith = async (rec: DeliveryRecord, phantoms: SessionFact[]): Promise<GateVerdict> => {
    const real = phantoms.length ? { ...d.facts, sessions: async () => [...await d.facts.sessions(), ...phantoms] } : d.facts
    return runGate('vaga', rec, real)
  }

  const storeSlot = (subtaskId: string, v: GateVerdict) => d.store.update(x => {
    const c = x.deliveries[subtaskId]
    if (c && c.phase === 'fila') c.gates.vaga = { ok: v.ok, at: iso(d), revision: c.revision, ...(v.evidence ? { evidence: v.evidence } : {}), ...(v.reason ? { reason: v.reason } : {}), ...(v.missing?.length ? { missing: v.missing } : {}) }
  }).catch(() => undefined)

  /** Open the session of an APPROVED piece. Idempotent: the claim inside `stageRun` lets exactly one caller through. */
  const startApproved = async (subtaskId: string, actor: string, auto: boolean): Promise<DeliveryReply> => {
    const before = await d.store.get(subtaskId)
    if (!before) return fail(404, 'no_delivery', 'this piece has no delivery record')
    const out = await stageRun(subtaskId, actor)
    if (!out.ok) return out
    const r = out.record
    await d.store.update(x => { const c = x.deliveries[subtaskId]; if (c) c.queueStarted = { at: iso(d), actor, auto, sessionId: c.authorSessionId ?? '' } }).catch(() => undefined)
    const title = (await d.facts.subtask(subtaskId).catch(() => null))?.title ?? subtaskId
    await note(r, `entrou em andamento: sessão ${r.authorSessionId ?? '?'} aberta (${auto ? 'sem resposta em 10 min, modo autônomo ligado: seguiu como sim' : `sim de ${actor}`}).`)
    await tellLeader(r.leaderSessionId, `[from flow fila · aviso]\n"${title}" (${subtaskId}) entrou em andamento: sessão ${r.authorSessionId ?? '?'}${auto ? ' — aberta sozinha, sem resposta sua em 10 min com o modo autônomo ligado' : ''}.`)
    await d.emit('fila.iniciada', { subtarefa: subtaskId, taskId: r.taskId, auto }).catch(() => undefined)
    return { ...out, record: (await d.store.get(subtaskId)) ?? r }
  }

  /** The leader's (or owner's) answer. `sim` starts the piece; `nao` / `agendar` keep it queued with the reason on the card. */
  const answerQueue = async (subtaskId: string, input: unknown, actor: string, opts: { auto?: boolean } = {}): Promise<DeliveryReply> => {
    const got = await d.store.get(subtaskId)
    if (!got) return fail(404, 'no_delivery', 'this piece has no delivery record')
    if (!(await leads(got, actor))) return fail(403, 'leader_only', 'only the task leader or owner may answer for a queued piece')
    const parsed = parseQueueAnswer(input, d.now())
    if (!parsed.ok) return fail(400, 'resposta_invalida', parsed.sentence)
    const a: QueueAnswer = parsed.answer
    if (got.phase !== 'fila') {
      // The second answer to a question that already opened the session is the same answer, not an error.
      if (a.kind === 'sim' && got.queueStarted) return { ok: true, status: 200, record: got, warnings: ['already started: nothing was opened twice'] }
      return fail(422, 'fase_pulada', `only a queued piece is answered; this one is in ${got.phase}`, [], got)
    }
    if (got.dequeued) return fail(422, 'fora_da_fila', 'this piece was dequeued; stage it explicitly before answering', [], got)
    const at = iso(d)
    const who = opts.auto ? 'o fluxo (sem resposta em 10 min, modo autônomo ligado)' : actor
    if (a.kind === 'sim') {
      const applied = await d.store.update(x => {
        const c = x.deliveries[subtaskId]
        if (!c || c.phase !== 'fila' || c.dequeued) return null
        const had = c.queueAsk?.approved
        c.queueAsk = { ...(c.queueAsk ?? { at, delivered: true }), approved: had ?? { at, actor, auto: opts.auto === true } }
        delete c.queueHold
        c.updatedAt = at
        return { already: Boolean(had) }
      })
      if (!applied) return fail(409, 'revisao_obsoleta', 'the piece left the queue meanwhile', [], (await d.store.get(subtaskId)) ?? got)
      if (!applied.already) await note(got, `decisão: sim — ${who}, ${at}. A sessão abre quando o portão de vaga passar.`)
      const started = await startApproved(subtaskId, actor, opts.auto === true)
      if (started.ok) return started
      // No slot (or a gate) right now: the approval stays, the next tick starts it — the answer itself was accepted.
      if (started.code === 'portao' || started.code === 'ja_iniciando') return { ok: true, status: 200, record: (await d.store.get(subtaskId)) ?? got, warnings: [`approved; ${started.sentence}`] }
      return started
    }
    const hold = a.kind === 'nao'
      ? { kind: 'nao' as const, reason: a.reason, at, actor }
      : { kind: 'agendar' as const, reason: a.reason, at, actor, until: a.until }
    const applied = await d.store.update(x => {
      const c = x.deliveries[subtaskId]
      if (!c || c.phase !== 'fila' || c.dequeued) return null
      const same = c.queueHold && c.queueHold.kind === hold.kind && c.queueHold.reason === hold.reason && c.queueHold.until === hold.until && !c.queueAsk
      if (same) return { already: true }
      c.queueHold = hold
      delete c.queueAsk
      c.updatedAt = at
      return { already: false }
    })
    if (!applied) return fail(409, 'revisao_obsoleta', 'the piece left the queue meanwhile', [], (await d.store.get(subtaskId)) ?? got)
    if (!applied.already) {
      await note(got, a.kind === 'nao'
        ? `decisão: não — ${who}, ${at}. Motivo: ${a.reason}. Continua na fila; o fluxo passa ao próximo.`
        : `decisão: agendar — ${who}, ${at}. Começa em ${a.until}. Motivo: ${a.reason}.`)
      await d.emit('fila.respondida', { subtarefa: subtaskId, taskId: got.taskId, decisao: a.kind }).catch(() => undefined)
    }
    // A slot this piece was holding is free again for the next one.
    if (!applied.already) void queueNext().catch(() => undefined)
    return { ok: true, status: 200, record: (await d.store.get(subtaskId)) ?? got, warnings: applied.already ? ['already recorded: nothing changed'] : [] }
  }

  /**
   * `fila-proximo`: run when a worker ends, on the minute tick and after an answer. Deterministic, no model. In order:
   * the 10-minute timeouts (autonomous → `sim`; otherwise a reminder), questions that never reached the leader, approved pieces
   * waiting for a slot, and then ONE new question per task for the best piece whose slot gate passes.
   */
  const queueNextOnce = async (actions: string[] = []): Promise<{ actions: string[] }> => {
    // A host that cannot start sessions has nothing to ask about.
    if (!d.spawn) return { actions }
    const now = d.now()
    let items = await queueItems()
    if (items.length === 0) return { actions }
    const plan = planQueue(items, now)
    const sessions = await d.facts.sessions().catch(() => null)
    // 1) unanswered for 10 min
    for (const it of plan.expired) {
      const autonomous = await d.autonomous(it.rec.leaderSessionId).catch(() => true)
      if (autonomous) {
        const out = await answerQueue(it.subtaskId, 'sim', ASK_AUTHOR, { auto: true })
        actions.push(`fila-timeout-sim ${it.subtaskId}:${out.ok}`)
      } else if (it.ask && reminderDue(it.ask, now)) {
        const sent = await tellLeader(liveLeader(it, sessions) ?? it.rec.leaderSessionId, `[from flow fila · lembrete]\nAinda espero sua resposta sobre "${it.title}" (${it.subtaskId}): sim | nao <motivo> | agendar <ISO> <motivo>. O modo autônomo está desligado, então eu continuo esperando.`)
        await d.store.update(x => { const c = x.deliveries[it.subtaskId]; if (c?.queueAsk && !c.queueAsk.approved) c.queueAsk.remindedAt = iso(d) })
        actions.push(`fila-lembrete ${it.subtaskId}:${sent}`)
      }
    }
    // 2) a question that never reached the leader is typed again (until it does or the timeout decides)
    for (const it of plan.undelivered) {
      if (plan.expired.includes(it)) continue
      const leader = liveLeader(it, sessions)
      if (!leader) continue
      const text = await composeQuestion(it, items)
      if (await tellLeader(leader, text)) {
        await d.store.update(x => { const c = x.deliveries[it.subtaskId]; if (c?.queueAsk) { c.queueAsk.delivered = true; c.queueAsk.leaderSessionId = leader } })
        actions.push(`fila-pergunta-reenviada ${it.subtaskId}`)
      }
    }
    // 3) approved, waiting for a slot
    items = await queueItems()
    for (const it of items.filter(i => i.ask?.approved && !startClaimLive(i.ask, now))) {
      const out = await startApproved(it.subtaskId, it.ask!.approved!.actor, it.ask!.approved!.auto)
      actions.push(`fila-inicia ${it.subtaskId}:${out.ok ? 'ok' : out.code}`)
    }
    // 4) new questions
    items = await queueItems()
    const fresh = planQueue(items, now)
    if (fresh.candidates.length === 0) return { actions }
    const phantoms = phantomsOf(items)
    const asked = new Set<string>()
    for (const it of fresh.candidates) {
      if (asked.has(it.taskId)) continue
      if (!judgePredispatch(it.sub).ok) continue
      const verdict = await slotWith(it.rec, phantoms)
      await storeSlot(it.subtaskId, verdict)
      if (!verdict.ok) { actions.push(`fila-sem-vaga ${it.subtaskId}`); continue }
      const leader = liveLeader(it, sessions)
      const claimed = await d.store.update(x => {
        const c = x.deliveries[it.subtaskId]
        if (!c || c.phase !== 'fila' || c.dequeued || c.queueAsk || holdState(c.queueHold, now) !== null) return false
        c.queueAsk = { at: iso(d), delivered: false, ...(leader ? { leaderSessionId: leader } : {}) }
        if (leader && !c.leaderSessionId) c.leaderSessionId = leader
        c.updatedAt = iso(d)
        return true
      })
      if (!claimed) continue
      asked.add(it.taskId)
      const next = { ...it, ask: { at: iso(d), delivered: false } }
      phantoms.push(...phantomsOf([next]))
      const text = await composeQuestion(next, items.map(i => (i.subtaskId === it.subtaskId ? next : i)))
      const sent = leader ? await tellLeader(leader, text) : false
      if (sent) await d.store.update(x => { const c = x.deliveries[it.subtaskId]; if (c?.queueAsk) c.queueAsk.delivered = true })
      await note(it.rec, `pergunta ao líder: posso abrir "${it.title}" agora? (${sent ? 'entregue' : 'o líder não foi alcançado; tento de novo a cada minuto'}). Sem resposta em 10 min: ${await d.autonomous(it.rec.leaderSessionId).catch(() => true) ? 'o modo autônomo está ligado, então segue como sim' : 'o modo autônomo está desligado, então eu espero e lembro'}.`)
      await d.emit('fila.pergunta', { subtarefa: it.subtaskId, taskId: it.taskId, entregue: sent }).catch(() => undefined)
      actions.push(`fila-pergunta ${it.subtaskId}:${sent}`)
    }
    return { actions }
  }

  const composeQuestion = async (it: QueueItem & { sub: { staged?: { harness?: string; model?: string; effort?: string; account?: string } } }, items: readonly QueueItem[]): Promise<string> => {
    const ordered = orderQueue(items)
    const position = ordered.findIndex(x => x.subtaskId === it.subtaskId) + 1
    const s = it.sub.staged
    const accountName = await accountLabel(s?.harness, s?.account)
    return questionText({
      subtaskId: it.subtaskId, title: it.title, priority: it.priority, position: position || 1, total: ordered.length,
      ...(s?.harness ? { harness: s.harness } : {}), ...(s?.model ? { model: s.model } : {}), ...(s?.effort ? { effort: s.effort } : {}), ...(accountName ? { accountName } : {}),
      why: whyNext({ priority: it.priority, position: position || 1, total: ordered.length, slot: 'o portão de vaga passou (teto da máquina, limites da conta e memória)' }),
    })
  }

  /** Serialised with the tick: a worker ending and the minute tick never run the flow at the same time. */
  const queueNext = (): Promise<{ actions: string[] }> => {
    const guarded = async () => { try { return await queueNextOnce([]) } catch (e) { if (e instanceof DeliveryStoreUnreadable) return { actions: [`store-unreadable: ${e.message}`] }; throw e } }
    const run = tickChain.then(guarded, guarded)
    tickChain = run.catch(() => undefined)
    return run
  }

  /** What the Fila tab, the Live card and the MCP read: the queue in leaving order, with every fact the screen shows. */
  const queueView = async (taskId?: string): Promise<QueueView> => {
    const now = d.now()
    const items = await queueItems()
    const autonomous = await d.autonomous().catch(() => true)
    const sessions = await d.facts.sessions().catch(() => [] as SessionFact[])
    const rows: QueueViewItem[] = []
    let globalPos = 0
    const perTask = new Map<string, number>()
    for (const it of items) {
      globalPos++
      const taskPos = (perTask.get(it.taskId) ?? 0) + 1
      perTask.set(it.taskId, taskPos)
      if (taskId && it.taskId !== taskId) continue
      const extras = await d.facts.queueExtras?.(it.subtaskId).catch(() => null)
      const rec = it.rec
      const staged = it.sub.staged
      const hold = holdState(rec.queueHold, now)
      const pre = judgePredispatch(it.sub)
      rows.push({
        subtaskId: it.subtaskId, taskId: it.taskId, title: it.title, taskTitle: extras?.taskTitle ?? it.taskId, priority: it.priority,
        position: taskPos, globalPosition: globalPos, since: rec.createdAt,
        group: extras && extras.members.length ? { members: extras.members } : null,
        predispatch: { ok: pre.ok, ...(pre.missing?.length ? { missing: pre.missing } : {}),
          harness: staged?.harness ?? null, model: staged?.model ?? null, effort: staged?.effort ?? null, account: staged?.account ?? null,
          accountName: (await accountLabel(staged?.harness, staged?.account)) ?? null, cwd: staged?.cwd ?? null, prompt: staged?.prompt ?? '' },
        slot: rec.gates.vaga ? { ok: rec.gates.vaga.ok, reason: rec.gates.vaga.reason ?? null, at: rec.gates.vaga.at } : null,
        hold: rec.queueHold ? { ...rec.queueHold, active: hold !== null } : null,
        ask: rec.queueAsk ? {
          at: rec.queueAsk.at, delivered: rec.queueAsk.delivered, approved: Boolean(rec.queueAsk.approved),
          expiresAt: new Date(Date.parse(rec.queueAsk.at) + ASK_TIMEOUT_MS).toISOString(), ...(rec.queueAsk.leaderSessionId ? { leaderSessionId: rec.queueAsk.leaderSessionId } : {}),
          onTimeout: autonomous ? 'sim' : 'esperar',
        } : null,
        leaderSessionId: rec.leaderSessionId ?? null,
        leaderAlive: Boolean(rec.leaderSessionId && sessions.some(s => s.id === rec.leaderSessionId && s.alive)),
        notes: extras?.notes ?? { total: 0, last: [] },
      })
    }
    const recent: QueueViewRecent[] = []
    for (const r of Object.values((await d.store.read()).deliveries)) {
      if (!r.queueStarted || (taskId && r.taskId !== taskId) || now - Date.parse(r.queueStarted.at) > 24 * 3600_000) continue
      recent.push({ subtaskId: r.subtaskId, taskId: r.taskId, title: (await d.facts.subtask(r.subtaskId).catch(() => null))?.title ?? r.subtaskId, phase: r.phase, at: r.queueStarted.at, actor: r.queueStarted.actor, auto: r.queueStarted.auto, sessionId: r.queueStarted.sessionId || r.authorSessionId || null })
    }
    recent.sort((a, b) => b.at.localeCompare(a.at))
    return { generatedAt: iso(d), autonomous, total: items.length, items: rows, recent }
  }

  /** A withdrawal keeps its evidence, without pretending that work ran or a release was published. */
  const auditDequeue = async (r: DeliveryRecord): Promise<boolean> => {
    if (!r.dequeued || r.dequeued.commentedAt) return true
    try {
      await d.board.comment(r.taskId, r.subtaskId, `[fluxo entrega] fora da fila (${r.dequeued.actor}): ${r.dequeued.reason}`)
      await d.store.update(doc => { const c = doc.deliveries[r.subtaskId]; if (c?.dequeued?.at === r.dequeued!.at) c.dequeued.commentedAt = iso(d) })
      return true
    } catch { return false } // the next tick retries the missing audit comment
  }

  const dequeue = async (subtaskId: string, reason: unknown, actor: string): Promise<DeliveryReply> => {
    if (typeof reason !== 'string' || !reason.trim()) return fail(400, 'faltando', 'dequeue requires a reason', ['reason'])
    const got = await d.store.get(subtaskId)
    if (!got) return fail(404, 'no_delivery', 'this piece has no delivery record')
    if (!(await leads(got, actor))) return fail(403, 'leader_only', 'only the task leader or owner may dequeue a piece')
    if (got.phase !== 'fila') return fail(422, 'fase_pulada', 'only a queued piece can be dequeued', [], got)
    const after = await d.store.update(doc => {
      const c = doc.deliveries[subtaskId]!
      if (c.phase !== 'fila' || c.dequeued) return structuredClone(c)
      c.dequeued = { at: iso(d), actor, reason: reason.trim() }
      c.updatedAt = iso(d); c.revision++
      c.history.push({ from: 'fila', to: 'fila', at: iso(d), actor, detail: `dequeue: ${reason.trim()}`, revision: c.revision })
      return structuredClone(c)
    })
    if (after.phase !== 'fila') return fail(409, 'revisao_obsoleta', 'the delivery started meanwhile', [], after)
    const audited = await auditDequeue(after)
    await d.emit('entrega.retirada', { subtarefa: subtaskId, taskId: after.taskId, reason: after.dequeued?.reason }).catch(() => undefined)
    return { ok: true, status: 200, record: (await d.store.get(subtaskId))!, warnings: audited ? [] : ['audit comment pending; the next tick will retry'] }
  }

  const cleanQueue = async (actions: string[]) => {
    for (const r of Object.values((await d.store.read()).deliveries)) {
      if (r.dequeued) { await auditDequeue(r); continue }
      if (r.phase !== 'fila') continue
      const folded = await foldGroupMember(r.subtaskId)
      if (folded) { actions.push(`fold ${r.subtaskId}:${folded}`); continue }
      const status = await (d.facts.pieceStatus ? d.facts.pieceStatus(r.subtaskId) : d.facts.subtask(r.subtaskId).then(s => s?.status ?? null)).catch(() => undefined)
      if (status && ['in_review', 'done', 'abandoned'].includes(status)) {
        const out = await dequeue(r.subtaskId, `board status is ${status}; this piece is no longer queued`, 'flow:entrega')
        if (out.ok) actions.push(`dequeue ${r.subtaskId}`)
      }
    }
  }

  /** A staged member's work is carried by its group; its old queue record remains only as audited history. */
  const foldGroupMember = async (subtaskId: string): Promise<string | null> => {
    const r = await d.store.get(subtaskId)
    if (!r || r.phase !== 'fila' || r.dequeued) return null
    const member = await d.facts.subtask(subtaskId)
    if (!member?.parentGroupId) return null
    if (['in_review', 'done', 'abandoned'].includes(member.status)) return null
    const group = await d.facts.subtask(member.parentGroupId)
    if (!group || group.taskId !== member.taskId || group.groupMember) return null
    if (member.staged) {
      const marker = `[group member ${subtaskId}]`
      const brief = group.staged?.prompt ?? ''
      const merged = { ...member.staged, ...group.staged, prompt: brief.includes(marker) ? brief : `${brief}\n\n${marker}\n${member.staged.prompt ?? ''}`.trim() }
      const result = await stage(group.id, merged, 'flow:entrega', { ...(r.leaderSessionId ? { leaderSessionId: r.leaderSessionId } : {}), ...(r.pedidoIds?.length ? { pedidoIds: r.pedidoIds } : {}) })
      if (!result.ok) return null
    }
    const out = await dequeue(subtaskId, `folded into group ${group.id}; the group owns its pre-dispatch`, 'flow:entrega')
    return out.ok ? group.id : null
  }

  /** Ten minutes since the request itself, including a busy or replaced leader. Only cadence lives here. */
  const watchRequests = async (sessions: SessionFact[] | null, actions: string[]) => {
    if (!d.requests || !sessions) return
    const requests = await d.requests().catch(() => null)
    if (!requests) { actions.push('requests-unavailable'); return }
    // FLUXO.AVISOS: only WORK is chased. A question ("e o deploy?") is answered by the leader's reply — it never gets a
    // subtask, so "pre-dispatch incomplete" is meaningless for it (it was nagged 8 times in an hour). The engine receives
    // the same host classification as `intent` on `owner.message`; a request the host rule calls a question is skipped here too.
    const isPending = (p: OwnerRequestFact) => /^p-[\w-]{1,100}$/.test(p.id) && ['open', 'linked'].includes(p.state) && ownerIntent(p.text) === 'work'
    const pending = requests.filter(isPending)
    const liveIds = new Set(pending.map(p => p.id))
    const doc = await d.store.read()
    const obsolete = Object.keys(doc.requestReminders ?? {}).filter(id => !liveIds.has(id))
    if (obsolete.length) await d.store.update(x => { for (const id of obsolete) delete x.requestReminders![id] })
    /** Is this request still waiting for a COMPLETE pre-dispatch? Facts are read fresh every time it is asked. */
    // FLUXO.ALARMES: 'ok' = nothing to chase; 'missing' = no complete pre-dispatch (chased on the usual cadence); 'orphan' = the
    // only thing wrong is a piece the leader DEQUEUED (opened by hand) that has no live session and no draft — said ONCE, after 10 min.
    type Completeness = 'ok' | 'missing' | 'orphan'
    const requestCompleteness = async (p: OwnerRequestFact, book: Awaited<ReturnType<typeof d.store.read>>, sessions: readonly SessionFact[]): Promise<Completeness> => {
      const ids = [...new Set([...p.linkedSubtaskIds, ...Object.values(book.deliveries).filter(r => r.pedidoIds?.includes(p.id) && !r.dequeued).map(r => r.subtaskId)])]
      const liveOn = (subtaskId: string) => sessions.some(s => s.alive && s.role !== 'leader' && s.subtaskId === subtaskId)
      let result: Completeness = ids.length === 0 ? 'missing' : 'ok'
      for (const id of ids) {
        let sub = await d.facts.subtask(id).catch(() => null)
        if (sub && ['in_review', 'done', 'abandoned'].includes(sub.status)) continue
        // A piece (or the group carrying it) with a LIVE session is running: it is neither "unstaged" nor "dequeued and forgotten".
        if (liveOn(id) || (sub?.parentGroupId && liveOn(sub.parentGroupId))) continue
        if (sub?.parentGroupId) sub = await d.facts.subtask(sub.parentGroupId).catch(() => null)
        if (sub && ['in_review', 'done', 'abandoned'].includes(sub.status)) continue
        if (!sub || sub.taskId !== p.taskId) { result = 'missing'; continue }
        const dequeued = book.deliveries[sub.id]?.dequeued
        if (dequeued) {
          // Dequeued = the leader took it out of the queue on purpose (the dequeue carries a reason). It only becomes a problem
          // when nothing carries the work 10 minutes later: no session, no staged draft.
          const age = d.now() - Date.parse(dequeued.at)
          if (!sub.staged && Number.isFinite(age) && age >= 10 * 60_000 && result !== 'missing') result = 'orphan'
          continue
        }
        if (!judgePredispatch(sub).ok) result = 'missing'
      }
      return result
    }
    const requestIncomplete = async (p: OwnerRequestFact, book: Awaited<ReturnType<typeof d.store.read>>, sessions: readonly SessionFact[]) => (await requestCompleteness(p, book, sessions)) !== 'ok'
    const batches = new Map<string, OwnerRequestFact[]>()
    for (const p of pending) {
      if (!p.taskId || !Number.isFinite(Date.parse(p.at)) || d.now() - Date.parse(p.at) < 10 * 60_000) continue
      const completeness = await requestCompleteness(p, doc, sessions)
      if (completeness === 'ok') continue
      const leader = leaderFor(sessions, p.taskId, '')
      if (!leader) continue
      const reserved = await d.store.update(x => {
        const clocks = x.requestReminders ??= {}
        const last = clocks[p.id]
        // A dequeued piece nobody carries is said ONCE: the leader decided to take it out, so repeating it is the nag of row 23.
        if (completeness === 'orphan' && last?.at) return false
        // ONE reminder cadence per PEDIDO, not per leader: a leader change used to reset the clock and re-send at once.
        // A normal hand-off closes the predecessor minutes later, so the record survives it: the successor is not nudged again.
        if (last?.at && d.now() - Date.parse(last.at) < 30 * 60_000) return false
        if (last?.pendingAt && d.now() - Date.parse(last.pendingAt) < 60_000) return false
        clocks[p.id] = { ...(last?.leaderSessionId === leader ? last : {}), pendingAt: iso(d), leaderSessionId: leader }
        return true
      })
      if (reserved) { const list = batches.get(leader) ?? []; list.push(p); batches.set(leader, list) }
    }
    for (const [leader, reserved] of batches) {
      // FLUXO.AVISOS: completeness was judged in the loop above, possibly minutes before this send (a leader staged the
      // piece in between and still got "incomplete" — twice). Re-read the requests and the facts RIGHT before typing into
      // the leader, and drop whatever is no longer open, no longer work or no longer incomplete; the leader must still be alive.
      const freshRequests = await d.requests!().catch(() => null)
      const freshBook = await d.store.read()
      const freshSessions = await d.facts.sessions().catch(() => null)
      const freshLeaderAlive = freshSessions?.some(s => s.alive && s.id === leader)
      const pedidos: OwnerRequestFact[] = []
      if (freshRequests && freshSessions && freshLeaderAlive) {
        for (const p of reserved) {
          const now = freshRequests.find(r => r.id === p.id)
          if (now && isPending(now) && await requestIncomplete(now, freshBook, freshSessions)) pedidos.push(now)
        }
      }
      const release = (sent: boolean) => d.store.update(x => {
        for (const p of reserved) {
          const clock = x.requestReminders?.[p.id]
          if (!clock || clock.leaderSessionId !== leader) continue
          if (sent && pedidos.some(q => q.id === p.id)) clock.at = iso(d)
          delete clock.pendingAt
        }
      })
      if (pedidos.length === 0) { await release(false); actions.push(`request-wake-skipped ${leader}:${reserved.map(p => p.id).join(',')}`); continue }
      const sent = await d.notify.session(leader, requestReminderText(pedidos)).catch(() => false)
      await release(sent)
      actions.push(`${sent ? 'request-wake' : 'request-wake-failed'} ${leader}:${pedidos.map(p => p.id).join(',')}`)
    }
  }
  /** The live leader to chase for a task: the one filed on the piece itself, else the task's newest. Null = nobody to wake. */
  const leaderFor = (sessions: readonly SessionFact[], taskId: string, subtaskId: string): string | null => {
    const mine =sessions.filter(s => s.alive && s.role === 'leader' && s.taskId === taskId)
    const byNewest = (a: SessionFact, b: SessionFact) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0)
    return [...mine.filter(s => s.subtaskId === subtaskId).sort(byNewest), ...mine.sort(byNewest)][0]?.id ?? null
  }

  /**
   * BLOQUEIO.ORFAO — a subtask the BOARD holds in `blocked` with no delivery record (set before the flow existed, or by hand)
   * was invisible to the vigia, so nobody ever chased it. It is ADOPTED here at `bloqueado`, once, and from then on `planWatch`
   * treats it like any flow piece: the leader is woken every 30 min and the piece is deferred after 2 h (the block's `since` is
   * the board's own timestamp, so an old one is deferred on the very tick that adopts it). A piece with no live leader is said
   * ONCE (a comment on the subtask and one informational bell) instead of waking into the void. Nothing is asked of the owner.
   */
  const adoptOrphans = async (blocked: readonly BlockedSubtaskFact[], sessions: readonly SessionFact[] | null, actions: string[]): Promise<void> => {
    if (blocked.length === 0) return
    const have = (await d.store.read()).deliveries
    // A group MEMBER is never a delivery of its own (the Live shows no card for it, predispatch refuses it): a host that lets
    // one through is ignored here, and its block reaches the group through the host's `blockedSubtasks` (gates.ts).
    // A deferred adopted piece that the board blocked AGAIN since is chased afresh; anything else with a record is left alone.
    const stale = (b: BlockedSubtaskFact) => {
      const r = have[b.id]
      const deferredAt = Date.parse(r?.block?.deferredAt ?? '')
      return r?.adopted === 'board' && r.phase === 'fila' && Number.isFinite(deferredAt) && Date.parse(b.since) > deferredAt
    }
    const todo = blocked.filter(b => !b.groupMember && (!have[b.id] || stale(b)) && SUB_ID.test(b.id) && Number.isFinite(Date.parse(b.since)))
      .sort((a, b) => Date.parse(a.since) - Date.parse(b.since)).slice(0, ADOPT_PER_TICK)
    if (todo.length === 0) return
    const plans: Array<{ b: BlockedSubtaskFact; reason: 'dependencia' | 'pedido_de_bloqueio'; text: string; leader: string | null }> = []
    for (const b of todo) {
      const open: string[] = []
      for (const dep of b.blockedBy) if (!(have[dep]?.phase === 'publicado' || await d.board.subtaskFinished(dep).catch(() => false))) open.push(dep)
      const reason = open.length > 0 ? 'dependencia' as const : 'pedido_de_bloqueio' as const
      const text = b.reason?.trim() || (open.length > 0 ? `aguardando ${open.join(', ')}` : 'bloqueada no quadro antes do fluxo de entrega, sem motivo registrado')
      plans.push({ b, reason, text, leader: sessions ? leaderFor(sessions, b.taskId, b.id) : null })
    }
    const at = iso(d)
    // ONE write for the whole batch (the document is rewritten once, not once per piece).
    const adopted = new Set(await d.store.update(doc => {
      const done: string[] = []
      for (const { b, reason, text, leader } of plans) {
        if (doc.deliveries[b.id] && !(doc.deliveries[b.id]!.adopted === 'board' && doc.deliveries[b.id]!.phase === 'fila')) continue
        const r = newDelivery({ subtaskId: b.id, taskId: b.taskId, at, ...(leader ? { leaderSessionId: leader } : {}) })
        r.phase = 'bloqueado'
        r.origin = 'fila'
        r.revision = (doc.deliveries[b.id]?.revision ?? 1) + 1
        r.adopted = 'board'
        r.block = { reason, text, since: b.since, unlocker: unlockerOf(reason), wakes: 0 }
        r.history = [...(doc.deliveries[b.id]?.history ?? []), { from: 'fila', to: 'bloqueado', at, actor: 'flow:entrega', detail: `adotada: a peça já estava bloqueada no quadro (${reason}): ${text}`, revision: r.revision }]
        doc.deliveries[b.id] = r
        done.push(b.id)
      }
      return done
    }))
    const noLeader: string[] = []
    for (const { b, reason, leader } of plans) {
      if (!adopted.has(b.id)) continue
      actions.push(`adopt ${b.id}`)
      if (leader) { await d.board.comment(b.taskId, b.id, `[fluxo entrega] peça bloqueada no quadro adotada pelo fluxo (${reason}): o líder será lembrado a cada 30 min e a peça é adiada depois de 2 h.`).catch(() => undefined); continue }
      if (reason === 'dependencia') continue
      await d.board.comment(b.taskId, b.id, '[fluxo entrega] peça bloqueada no quadro adotada pelo fluxo, mas a tarefa não tem líder vivo para cobrar: reabra ou nomeie um líder. A peça será adiada para o próximo lote depois de 2 h.').catch(() => undefined)
      noLeader.push(`${b.id} (${b.title})`)
      actions.push(`no-leader ${b.id}`)
    }
    // ONE informational bell for the whole batch, never one per piece.
    if (noLeader.length > 0) await d.notify.owner(`Bloqueio sem líder: ${noLeader.length === 1 ? `${noLeader[0]} está bloqueada` : `${noLeader.length} peças estão bloqueadas (${noLeader.slice(0, 3).join('; ')}${noLeader.length > 3 ? '; …' : ''})`} no quadro e a tarefa não tem líder vivo para cobrar.`, 'aviso').catch(() => undefined)
  }

  /**
   * A piece the vigia ADOPTED stops being chased the moment the board stops blocking it: done/abandoned (or gone) leaves the flow
   * quietly — the record was never a delivery, it is dropped — and any other status releases the block back to its origin phase,
   * exactly as an unblock does, without touching the status the person chose on the board.
   */
  const reconcileAdopted = async (blocked: readonly BlockedSubtaskFact[] | null, actions: string[]): Promise<void> => {
    if (blocked === null) return // the board could not be read: keep chasing, never drop on a failed read
    const stillBlocked = new Set(blocked.map(b => b.id))
    const doc = await d.store.read()
    for (const r of Object.values(doc.deliveries)) {
      if (r.adopted !== 'board' || r.phase !== 'bloqueado' || stillBlocked.has(r.subtaskId)) continue
      // A record that has since entered the real flow (history in a real phase, a head sha, gates…) is a delivery, not an adoption:
      // clear the marker and leave it to the normal flow rules — never delete real history because the board moved on.
      if (!isPureAdoption(r)) { await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c && !isPureAdoption(c)) delete c.adopted }); continue }
      const status = await (d.facts.pieceStatus ? d.facts.pieceStatus(r.subtaskId) : d.facts.subtask(r.subtaskId).then(s => s?.status ?? null)).catch(() => undefined)
      if (status === undefined) continue // the status could not be read either: next tick
      if (status === null || status === 'done' || status === 'abandoned') { await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c && isPureAdoption(c)) delete x.deliveries[r.subtaskId] }); continue }
      // The board released it: a PURE adoption was never a delivery, so the record is DELETED (not parked in `fila`). A leftover
      // record would hide a later board block from `adoptOrphans` and override the board's real status on the Live.
      const dropped = await d.store.update(x => {
        const cur = x.deliveries[r.subtaskId]
        if (!cur || cur.phase !== 'bloqueado' || !isPureAdoption(cur)) return false
        delete x.deliveries[r.subtaskId]
        return true
      })
      if (!dropped) continue
      await d.board.comment(r.taskId, r.subtaskId, '[fluxo entrega] a peça saiu de Bloqueado no quadro: o fluxo parou de cobrar.').catch(() => undefined)
      await d.emit('entrega.destravada', { subtarefa: r.subtaskId, fase: 'fila' }).catch(() => undefined)
      actions.push(`released ${r.subtaskId}`)
    }
  }

  /**
   * Past the 2 h (or when an owner decision becomes the leader's) a blocked piece LEAVES Bloqueado for the queue of the next batch:
   * back to `fila` with `versionTarget='next'`, the block kept as history (`deferredAt`). Parking it in Bloqueado with a flag
   * left the card on the board for ever with nobody chasing it.
   */
  const deferOut = async (r: DeliveryRecord, comment: string): Promise<boolean> => {
    // The record FOLLOWS the board: a piece the person already closed there is never moved back to To do, never chased and never
    // announced. A pure adoption is dropped (it was never a delivery); a record with real history leaves Bloqueado quietly, so the
    // watch stops, and keeps its history. A status that cannot be read means "not now": the next tick tries again.
    const status = await (d.facts.pieceStatus ? d.facts.pieceStatus(r.subtaskId) : d.facts.subtask(r.subtaskId).then(s => s?.status ?? null)).catch(() => undefined)
    if (status === undefined) return false
    const closedOnBoard = status === 'done' || status === 'abandoned'
    const moved = await d.store.update(x => {
      const c = x.deliveries[r.subtaskId]
      if (!c?.block || c.phase !== 'bloqueado') return false
      if (closedOnBoard && isPureAdoption(c)) { delete x.deliveries[r.subtaskId]; return false }
      const at = iso(d)
      c.block.deferredAt = at
      c.versionTarget = 'next'
      c.history = [...c.history, { from: 'bloqueado', to: 'fila', at, actor: 'flow:entrega', detail: `adiada para o próximo lote (estava em ${c.origin ?? 'fila'}): ${c.block.text}`, revision: c.revision + 1 }]
      c.phase = 'fila'
      c.revision += 1
      c.updatedAt = at
      delete c.origin
      delete c.step
      delete c.queueAsk
      delete c.queueHold
      return true
    })
    if (!moved || closedOnBoard) return false
    // The board move is best-effort, but a miss is REMEMBERED: the record is out of Bloqueado and so no longer watched, and a Live
    // card that kept reading the blocked board status would be the orphan this whole feature exists to end. `retryDeferredBoard`
    // re-applies it on the next tick.
    const wrote = await d.board.setPhaseStatus(r.subtaskId, 'fila').then(o => o.ok, () => false)
    if (!wrote) await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c?.block) c.block.boardMovePending = true }).catch(() => undefined)
    await d.board.comment(r.taskId, r.subtaskId, comment).catch(() => undefined)
    return true
  }

  /**
   * A deferral whose BOARD write failed leaves a record in `fila` (unwatched) over a piece the board still shows `blocked`. Re-apply
   * the move once per tick — no comment, no wake, no new message — until it lands, or until the board stops blocking the piece.
   */
  const retryDeferredBoard = async (blocked: readonly BlockedSubtaskFact[] | null, actions: string[]): Promise<void> => {
    if (blocked === null) return
    const stillBlocked = new Set(blocked.map(b => b.id))
    const doc = await d.store.read()
    for (const r of Object.values(doc.deliveries)) {
      if (r.phase !== 'fila' || !r.block?.boardMovePending) continue
      const done = !stillBlocked.has(r.subtaskId) || await d.board.setPhaseStatus(r.subtaskId, 'fila').then(o => o.ok, () => false)
      if (!done) {
        // A refusal that never changes must not become a write per minute for ever: after the cap the flag is dropped and ONE
        // informational notice goes to the leader (the owner's bell when there is none). Nothing else is sent, nothing loops.
        const tries = (r.block.boardMoveTries ?? 0) + 1
        if (tries < BOARD_MOVE_MAX_TRIES) { await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c?.block) c.block.boardMoveTries = tries }); continue }
        await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c?.block) { delete c.block.boardMovePending; delete c.block.boardMoveTries } })
        const text = `[entrega ${r.subtaskId}] a peça foi adiada, mas o quadro recusou mover o cartão para a fila (${tries} tentativas): ele continua em Bloqueado no quadro e o fluxo parou de tentar. Mova-o à mão.`
        const reached = r.leaderSessionId ? await d.notify.session(r.leaderSessionId, text).catch(() => false) : false
        if (!reached) await d.notify.owner(`Peça ${r.subtaskId} adiada, mas o quadro recusou mover o cartão: continua em Bloqueado.`, 'aviso').catch(() => undefined)
        actions.push(`requeue-gave-up ${r.subtaskId}`)
        continue
      }
      await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c?.block) { delete c.block.boardMovePending; delete c.block.boardMoveTries } })
      if (stillBlocked.has(r.subtaskId)) actions.push(`requeue ${r.subtaskId}`)
    }
  }

  // ------------------------------------------------------------------------------------ FLUXO.CICLO-COMPLETO

  /** The tick's reason for a piece, recorded only while it is still at the phase/revision it was concluded for. */
  const writeNote = (r: DeliveryRecord, reason: string, failed: boolean) => d.store.update(x => {
    const c = x.deliveries[r.subtaskId]
    if (!c || c.phase !== r.phase || c.revision !== r.revision) return false
    c.tickNote = { at: iso(d), phase: c.phase, revision: c.revision, reason, ...(failed ? { failed: true } : {}) }
    return true
  })

  /**
   * revisao_lider / pr_merge → ci on evidence: the piece's merged PR, found by `findMergedPr` from what the piece records. The
   * edge's own gates (`delecoes`, `mergeado`) run inside the transition, so a merge from another sha, a merge not on main or a
   * PR that deleted files is REFUSED with its sentence (recorded as the tick note) and the piece stays — no loop: the next
   * look-up waits its back-off and the leader is reminded on the review cadence.
   */
  const detectMerges = async (records: readonly DeliveryRecord[], actions: string[]) => {
    const due = records.filter(r => mergeScanDue(r, d.now())).sort(mergeScanOrder).slice(0, MERGE_SCAN_PER_TICK)
    for (const r of due) {
      const found = await findMergedPr(r, d.facts)
      if (!found.ok) { await writeNote(r, found.reason, false); actions.push(`merge-none ${r.subtaskId}`); continue }
      const patched = await d.store.update(x => {
        const c = x.deliveries[r.subtaskId]
        if (!c || c.phase !== r.phase || c.revision !== r.revision) return false
        c.pr = found.pr
        if (found.branch && !c.branch) c.branch = found.branch
        c.mergeDetected = { at: iso(d), pr: found.pr, via: found.via }
        return true
      })
      if (!patched) continue
      const out = await transition(r.subtaskId, 'ci', { detail: `PR #${found.pr} mergeado (${found.mergeSha.slice(0, 9)}) — detectado pelo fluxo (${found.via})` }, 'flow:entrega')
      if (out.ok) { actions.push(`merge-detected ${r.subtaskId}:#${found.pr}`); continue }
      // Refused: the PR is not proof for THIS piece yet. Keep the PR number (information), drop the detection mark, say why.
      const cur = await d.store.get(r.subtaskId)
      if (cur && cur.phase === r.phase) {
        await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c && c.phase === r.phase) delete c.mergeDetected })
        await writeNote(cur, `PR #${found.pr} mergeado, mas o fluxo não pôde movê-la: ${out.sentence}`, true)
      }
      actions.push(`merge-refused ${r.subtaskId}:${out.code}`)
    }
  }

  /** The timed reminder to the LIVE leader of each waiting piece (`planReviewNudges`): one message per leader per tick, never the owner. */
  const nudgeLeaders = async (sessions: readonly SessionFact[] | null, actions: string[]) => {
    const doc = await d.store.read()
    const due = planReviewNudges(Object.values(doc.deliveries), d.now())
    if (due.length === 0) return
    const batches = new Map<string, typeof due>()
    const nobody: string[] = []
    for (const n of due) {
      const r = doc.deliveries[n.subtaskId]!
      const recordedAlive = r.leaderSessionId && sessions?.some(s => s.id === r.leaderSessionId && s.alive) ? r.leaderSessionId : null
      const leader = (sessions ? leaderFor(sessions, r.taskId, r.subtaskId) : null) ?? recordedAlive
      if (!leader) { nobody.push(n.subtaskId); continue }
      const list = batches.get(leader) ?? []
      list.push(n)
      batches.set(leader, list)
    }
    const stamp = (ids: string[], sent: boolean) => ids.length === 0 ? Promise.resolve() : d.store.update(x => {
      for (const id of ids) {
        const c = x.deliveries[id]
        if (!c) continue
        const cur = c.reviewNudge && c.reviewNudge.phase === c.phase && c.reviewNudge.revision === c.revision ? c.reviewNudge
          : { phase: c.phase, revision: c.revision, sent: c.phase === 'ci' && c.releaseFailNotice ? 1 : 0 }
        c.reviewNudge = sent ? { ...cur, sent: cur.sent + 1, lastAt: iso(d) } : { ...cur, lastAttemptAt: iso(d) }
      }
    })
    await stamp(nobody, false)
    for (const id of nobody) actions.push(`review-nudge-no-leader ${id}`)
    const PHASE_WORD: Partial<Record<Phase, string>> = { revisao_lider: 'em revisão do líder', pr_merge: 'em PR · merge com portão recusado', ci: 'em CI com a release recusada' }
    for (const [leader, items] of batches) {
      const lines: string[] = []
      for (const n of items.slice(0, WAKE_LIST_MAX)) {
        const title = (await d.facts.subtask(n.subtaskId).catch(() => null))?.title
        lines.push(`- ${[n.subtaskId, title].filter(Boolean).join(' ')} — ${PHASE_WORD[n.phase] ?? n.phase} há ${Math.round(n.ageMs / 60_000)} min (lembrete ${n.sent + 1}/3)${n.reason ? `: ${n.reason}` : ''}`)
      }
      const text = `[entrega revisão] ${items.length === 1 ? 'Uma peça espera' : `${items.length} peças esperam`} uma ação sua:\n${lines.join('\n')}${items.length > WAKE_LIST_MAX ? `\n… e mais ${items.length - WAKE_LIST_MAX}.` : ''}\nSe o PR já foi mergeado o fluxo move a peça sozinho para ci e depois para publicado pela tag; senão revise e mova (agentistics_task_phase to=pr_merge reviewedSha=<sha do QA> | to=ajuste detail=…). Peças antigas já publicadas: agentop flow reconcile --release (agentistics_task_phase action=reconcile).`
      const reached = await d.notify.session(leader, text).catch(() => false)
      await stamp(items.map(i => i.subtaskId), reached)
      for (const i of items) actions.push(`${reached ? 'review-nudge' : 'review-nudge-failed'} ${i.subtaskId}`)
    }
  }

  /**
   * `agentop flow reconcile --release` (MCP `agentistics_task_phase action=reconcile`): the one-shot BACKFILL. Every piece in
   * revisao_lider / pr_merge / ci (and every board piece shown there with no record yet) is matched to its merged PR and the
   * FIRST release tag containing the merge. Dry-run by default: the report says what would move and what cannot be proven, with
   * the reason. `apply` writes through the ordinary transitions (their gates run; `flow:reconcile` announces nothing per piece).
   */
  const reconcile = async (o: { apply?: unknown }, actor: string, opts: { budget?: number } = {}): Promise<ReconcileReply> => {
    proofRuns++
    try { return await reconcileRun(o, actor, opts) } finally { proofRuns-- }
  }
  const reconcileRun = async (o: { apply?: unknown }, actor: string, opts: { budget?: number } = {}): Promise<ReconcileReply> => {
    const apply = o.apply === true || o.apply === 'true'
    const sessions = await d.facts.sessions().catch(() => [] as SessionFact[])
    const isLeader = sessions.some(s => s.id === actor && s.role === 'leader')
    if (apply && !(actor === 'owner' || actor.startsWith('flow:') || isLeader)) return fail(403, 'so_o_lider', 'only a leader (or the owner) applies the reconciliation; a dry run is open to anyone')
    const doc = await d.store.read()
    const at = iso(d)
    const nowMs = d.now()
    // A piece is "alive" when a session of it runs now (a task-level piece is keyed by its task id).
    const alive = new Set(sessions.filter(s => s.alive).map(s => s.subtaskId ?? s.taskId).filter((x): x is string => !!x))
    interface Piece { r: DeliveryRecord; hasRecord: boolean; updatedMs: number | null; title?: string; createdMs: number | null; handbackMs: number | null; repos?: string[]; hints?: ReviewPiece['hints']; status?: string; hasOpenChildren?: boolean }
    const pieces: Piece[] = Object.values(doc.deliveries).filter(r => !r.dequeued && (MERGE_PHASES.includes(r.phase) || r.phase === 'ci'))
      .map(r => ({ r, hasRecord: true, updatedMs: Date.parse(r.updatedAt) || null, createdMs: null, handbackMs: null }))
    for (const p of (await d.reviewPieces?.().catch(() => []) ?? [])) {
      if (doc.deliveries[p.id] || !SUB_ID.test(p.id)) continue
      pieces.push({ r: newDelivery({ subtaskId: p.id, taskId: p.taskId, at, phase: adoptPhase(p.status) }), hasRecord: false, updatedMs: msOf(p.updatedAt), title: p.title, createdMs: msOf(p.createdAt), handbackMs: msOf(p.handbackAt), status: p.status, hasOpenChildren: p.hasOpenChildren, ...(p.repos ? { repos: p.repos } : {}), ...(p.hints ? { hints: p.hints } : {}) })
    }
    // What gh already answered survives the run and a restart, so a run only asks for what is new. The meter is what keeps one
    // run inside its share of the quota: past it (or on "rate limit") every further read fails at once and the rest waits.
    const proofs = await loadProof()
    const meter = meterFacts(d.facts, opts.budget ?? MANUAL_RUN_GH_BUDGET)
    const facts = meter.facts
    const repoCwd = (await d.facts.repoCwd?.().catch(() => null)) ?? '.'
    // ONE read of each repository the cards belong to (H4: never ours for somebody else's card).
    const reposOf = (p: Piece): readonly string[] => p.repos ?? PRODUCT_REPOS
    const wanted = [...new Set(pieces.filter(p => !p.hasRecord && !alive.has(p.r.subtaskId)).flatMap(reposOf))].slice(0, MAX_PROOF_REPOS)
    const prsByRepo = new Map<string, BatchPr[]>()
    for (const repo of wanted) prsByRepo.set(repo, await loadBatchPrs(facts, repoCwd, repo, proofs))
    const tagOf = (c: BatchPr) => (c.repo === ENGINE_REPO ? findEnginePinTag(facts, repoCwd, c.mergeSha, proofs) : findPublicTag(facts, repoCwd, c.mergeSha, proofs, c.repo))
    const verdicts = new Map<string, GateVerdict>()
    const releaseVerdict = async (key: string, probe: DeliveryRecord): Promise<GateVerdict> => {
      const inRun = verdicts.get(key)
      if (inRun) return inRun
      const kept = proofs.verdicts.get(key)
      if (kept && (kept.ok || nowMs - kept.at < PROOF_REFRESH_MS)) { const v = kept.verdict as GateVerdict; verdicts.set(key, v); return v }
      const v = await runGate('release', probe, facts)
      verdicts.set(key, v)
      if (!releaseUnknown(v) && !meter.stopped()) proofs.verdicts.set(key, { ok: v.ok, at: nowMs, verdict: v })
      return v
    }
    const entries: ReconcileEntry[] = []
    let savedAtCalls = 0
    for (const { r, hasRecord, updatedMs, title: boardTitle, createdMs, handbackMs, repos, hints, status, hasOpenChildren } of pieces.sort((a, b) => a.r.subtaskId.localeCompare(b.r.subtaskId))) {
      const title = boardTitle ?? (await d.facts.subtask(r.subtaskId).catch(() => null))?.title
      const e: ReconcileEntry = { subtaskId: r.subtaskId, taskId: r.taskId, ...(title ? { title } : {}), from: r.phase }
      entries.push(e)
      // A restart in the middle resumes from here: what this run already paid for is on disk.
      if (meter.calls() - savedAtCalls >= PROOF_SAVE_EVERY_CALLS) { savedAtCalls = meter.calls(); await saveProof() }
      const live = alive.has(r.subtaskId)
      // H3: somebody is on it. A PR, however well it names the piece, says nothing about what that session is doing now.
      if (live && r.phase !== 'ci') { e.reason = 'sessão viva: fica'; continue }
      // A piece this run PROVED shipped is on its way to Published, never "old": the screen and "All" already leave it out, so the count must too.
      const antiga = () => { const outcome = proofs.outcomes.get(r.subtaskId); if (!isAntiga({ hasRecord, status, hasOpenChildren, proven: outcome?.proven, live, updatedMs, nowMs, handbackMs, suggested: !!e.suggestion, unchecked: !!e.unchecked, uncheckedWhy: e.unchecked })) return false; e.bucket = 'antiga'; return true }
      // The quota ran out: what was not reached is not judged. It stays exactly where it is and the next run continues from here.
      // "No proof" is said only of a piece that was LOOKED UP. One that could not be (nothing known about where it worked, gh unreadable, the quota
      // spent) is "could not check": it is not offered as antiga as if it had been, and the next run tries it again.
      const unchecked = (why: 'no-repos' | 'gh' | 'budget', reason: string) => {
        e.unchecked = why
        e.reason = `could not be checked: ${reason}. Not a lack of proof — it will be tried again on a later run`
        proofs.outcomes.set(r.subtaskId, { unchecked: why })
      }
      if (!hasRecord && repos && repos.length === 0) { unchecked('no-repos', 'no repository is known for this piece (no session of it recorded where it worked)'); antiga(); continue }
      if (meter.stopped()) { if (hasRecord) e.reason = `não verificada nesta rodada (${meter.stopped()})`; else unchecked('budget', `this run reached its ${meter.stopped() === 'rate-limit' ? 'GitHub rate limit' : 'GitHub call budget'} before this piece`); continue }
      // A RECORDED piece has its own evidence (qaSha, its PR): `findMergedPr` checks the sha QA approved. A batch PR must never go
      // over that check (H3: an older PR of the same branch published work whose real review was still open).
      const extra = hasRecord ? null : hints ?? await d.pieceHints?.(r.subtaskId).catch(() => null) ?? { branches: [], shas: [] }
      let batch: BatchMatch = extra
        ? matchBatchPr((repos ?? PRODUCT_REPOS).flatMap(x => prsByRepo.get(x) ?? []), { subtaskId: r.subtaskId, ...(title ? { title } : {}), ...extra, createdMs, repos: repos ?? PRODUCT_REPOS })
        : { ok: false, reason: 'a recorded piece is proven by its own PR' }
      // A piece worked across both repositories is proven by several PRs: TOGETHER only when every one of them shipped in the
      // SAME release (otherwise it stays ambiguous — a wrong tag would publish half-shipped work).
      if (!batch.ok && batch.candidates && batch.candidates.length > 1 && batch.candidates.length <= 6) {
        const tags = await Promise.all(batch.candidates.map(tagOf))
        if (tags.every(t => t !== null && t === tags[0])) {
          const lead = batch.candidates.find(c => c.repo !== ENGINE_REPO) ?? batch.candidates[0]!
          batch = { ok: true, pr: lead, via: `${batch.candidates.length} release PRs (${batch.candidates.map(c => `#${c.number}`).join(', ')}) agree on ${tags[0]}` }
        }
      }
      // Nothing proved it, but part of what could have is unread: that is not "no proof".
      if (!batch.ok && !hasRecord && (repos ?? PRODUCT_REPOS).some(x => proofs.unreadable.has(x) || !prsByRepo.has(x))) {
        unchecked((repos ?? PRODUCT_REPOS).some(x => proofs.unreadable.has(x)) ? 'gh' : 'budget', `GitHub's list of merged PRs could not be read (is gh installed and signed in?${(repos ?? PRODUCT_REPOS).map(x => proofs.unreadableWhy.get(x)).find(Boolean) ? ` — ${(repos ?? PRODUCT_REPOS).map(x => proofs.unreadableWhy.get(x)).find(Boolean)}` : ''})`)
        continue
      }
      // Weak evidence (the card's name, a branch in a PR's text, a tie across releases) moves nothing: it is what the person sees beside the card.
      if (!batch.ok) {
        const weak = batch.suggestion ?? (batch.candidates?.length ? { pr: batch.candidates[0]!, via: batch.reason } : null)
        if (weak) {
          const tag = await tagOf(weak.pr).catch(() => null)
          e.suggestion = { repo: weak.pr.repo, pr: weak.pr.number, ...(tag ? { tag } : {}), via: weak.via }
        }
      }
      proofs.outcomes.set(r.subtaskId, { ...(batch.ok ? { proven: true } : {}), ...(e.suggestion ? { suggestion: e.suggestion } : {}) })
      // SCOPE: only a piece with a record, a recent board touch or a release PR that proves it is looked up at all.
      if (!inReconcileScope({ hasRecord, live, updatedMs, nowMs, mentioned: batch.ok || batch.ambiguous === true })) {
        e.reason = antiga() ? 'antiga sem registro: sem prova de entrega, sem sessão viva, parada há mais de 30 dias' : 'fora do escopo do backfill (sem registro, parada há mais de 30 dias)'
        continue
      }
      let probe: DeliveryRecord = structuredClone(r)
      let tagWanted: string | null = null
      let batchProof: { repo: string; pr: number; mergeSha: string; via: string; releaseRepo: string } | null = null
      if (batch.ok) {
        // The merge commit is gh's (the PR's), never the caller's. An ENGINE PR ships in the first public tag whose engine.pin
        // contains it; any other PR is released by ITS OWN repository (H4).
        const releaseRepo = batch.pr.repo === ENGINE_REPO ? DEFAULT_RELEASE_REPO : batch.pr.repo
        batchProof = { repo: batch.pr.repo, pr: batch.pr.number, mergeSha: batch.pr.mergeSha, via: `${batch.via} (${batch.pr.repo}#${batch.pr.number})`, releaseRepo }
        Object.assign(e, { pr: batch.pr.number, mergeSha: batch.pr.mergeSha, via: batchProof.via, repo: batch.pr.repo })
        tagWanted = await tagOf(batch.pr) // null = not released yet (the gate says so)
        if (meter.stopped()) { delete e.pr; delete e.mergeSha; delete e.via; delete e.repo; unchecked('budget', `this run reached its GitHub limit while reading the release of its PR`); continue }
        if (batch.pr.repo === ENGINE_REPO && !tagWanted) { e.reason = `engine PR #${batch.pr.number} merged (${batch.pr.mergeSha.slice(0, 9)}), but no public release pins it yet`; if (!antiga()) e.reason += ' — fica'; continue }
        probe = { ...probe, phase: 'ci', releaseRepo, mergeSha: batch.pr.mergeSha, ...(tagWanted ? { tag: tagWanted } : {}), ...(batch.pr.repo === ENGINE_REPO ? {} : { pr: batch.pr.number }), mergeDetected: { at, pr: batch.pr.number, via: batchProof.via } }
        if (probe.versionTarget === 'next') delete probe.versionTarget
      } else if (!hasRecord) {
        // A record-less piece has nothing of its own to look up (no PR, branch or sha): what it declared was matched above, for free.
        e.reason = batch.reason
        if (antiga()) e.reason = `antiga sem registro: ${e.reason}`
        continue
      } else if (r.phase !== 'ci' || !r.mergeSha) {
        const found = await findMergedPr(r, facts, { search: true })
        if (!found.ok) { e.reason = found.reason; continue }
        Object.assign(e, { pr: found.pr, mergeSha: found.mergeSha, via: found.via })
        probe = { ...probe, phase: 'ci', pr: found.pr, mergeSha: found.mergeSha, mergeDetected: { at, pr: found.pr, via: found.via }, ...(found.branch && !probe.branch ? { branch: found.branch } : {}) }
        if (probe.versionTarget === 'next') delete probe.versionTarget
      } else Object.assign(e, { ...(r.pr ? { pr: r.pr } : {}), mergeSha: r.mergeSha })
      // One release verdict per merge commit (or per tag), kept across runs: siblings of one batch PR share it.
      const v = await releaseVerdict(tagWanted ? `tag:${probe.releaseRepo ?? ''}:${tagWanted}` : `sha:${probe.releaseRepo ?? ''}:${probe.mergeSha}`, probe)
      if (v.ok) { e.to = 'publicado'; if (v.patch?.tag) e.tag = v.patch.tag }
      else {
        // A repository with no release flow of ours has no `ci` to wait in and no run to read: merged is said, nothing moves (H4), and
        // the person decides, with the PR in front of them.
        if (batchProof && !meter.stopped() && !PRODUCT_REPOS.includes(batchProof.repo)) {
          e.reason = `PR #${batchProof.pr} merged in ${batchProof.repo}, which has no release to read`
          e.suggestion = { repo: batchProof.repo, pr: batchProof.pr, ...(tagWanted ? { tag: tagWanted } : {}), via: batchProof.via }
          proofs.outcomes.set(r.subtaskId, { suggestion: e.suggestion })
          antiga()
          continue
        }
        // L1: "could not read it" is not "it failed": the piece does not move on a read that did not happen.
        if (releaseUnknown(v) || meter.stopped()) { e.releaseGate = 'unknown'; e.reason = `release: ${v.reason ?? 'sem evidência'}`; antiga(); continue }
        e.to = r.phase === 'ci' ? undefined : 'ci'
        e.reason = `release: ${v.reason ?? 'sem evidência'}`
        if (e.to) e.releaseGate = releaseFailed(v) ? 'red' : 'pending'
        if (!e.to) { antiga(); continue }
      }
      if (!apply) continue
      // ---- a batch-proven piece with a green tag: declared exactly as a leader's `flow release` would (one atomic write).
      if (batchProof && v.ok && e.tag) {
        const rel = await release({ version: e.tag.replace(/^v/, ''), mergeSha: batchProof.mergeSha, subtaskIds: [r.subtaskId], repo: batchProof.releaseRepo }, RECONCILE_ACTOR)
        const piece = rel.ok ? rel.pieces[0] : undefined
        e.applied = rel.ok && piece?.phase === 'publicado'
        if (!e.applied) { e.reason = rel.ok ? `release declared but the piece is in ${piece?.phase ?? '?'}: ${rel.warnings.join('; ')}` : rel.sentence; e.to = rel.ok ? 'ci' : undefined }
        else await d.board.comment(r.taskId, r.subtaskId, `[fluxo entrega] publicado na ${e.tag} — prova: PR #${batchProof.pr}${batchProof.repo === ENGINE_REPO ? ' (engine)' : ''}, ${batchProof.via}.`).catch(() => undefined)
        continue
      }
      // ---- write: through the ordinary transitions, each running its own gates.
      if (!(await leads(r, actor))) { e.applied = false; e.reason = 'only the leader of this task (or the owner) applies it'; continue }
      const got = await ensure(r.subtaskId)
      if (isReply(got)) { e.applied = false; e.reason = got.ok ? 'record could not be created' : got.sentence; continue }
      if (got.phase !== 'ci') {
        await d.store.update(x => {
          const c = x.deliveries[r.subtaskId]
          if (!c) return
          c.pr = probe.pr; if (probe.branch && !c.branch) c.branch = probe.branch
          c.mergeDetected = probe.mergeDetected
          if (c.versionTarget === 'next') delete c.versionTarget
        })
        // The merge edge's own gates run; a refusal is reported, never forced.
        const moved = await transition(r.subtaskId, 'ci', { detail: `reconciliação: PR #${probe.pr} mergeado (${probe.mergeSha!.slice(0, 9)}, ${e.via})` }, RECONCILE_ACTOR)
        if (!moved.ok) {
          await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c && c.phase !== 'ci') delete c.mergeDetected })
          e.applied = false; e.reason = moved.sentence; e.to = undefined; continue
        }
      }
      if (e.to === 'publicado') {
        const pub = await transition(r.subtaskId, 'publicado', { detail: `reconciliação: ${e.tag ?? 'tag'} verde contém o merge` }, RECONCILE_ACTOR, new Map([['release', v]]))
        e.applied = pub.ok
        if (!pub.ok) { e.reason = pub.sentence; e.to = 'ci' }
        else await d.board.comment(r.taskId, r.subtaskId, `[fluxo entrega] publicado na ${e.tag ?? 'tag'} — prova: PR #${e.pr ?? '?'}, ${e.via ?? 'merge'}.`).catch(() => undefined)
      } else e.applied = true
    }
    const moved = entries.filter(e => e.to && e.applied !== false).length
    const planned = entries.filter(e => e.to && e.applied !== false)
    const summary: ReconcileSummary = {
      published: planned.filter(e => e.to === 'publicado').length,
      toCi: planned.filter(e => e.to === 'ci' && e.releaseGate !== 'red').length,
      ciRed: planned.filter(e => e.to === 'ci' && e.releaseGate === 'red').length,
      unknown: entries.filter(e => e.releaseGate === 'unknown').length,
      antigas: entries.filter(e => e.bucket === 'antiga').length,
      unchecked: entries.filter(e => e.unchecked).length,
      stay: entries.filter(e => !(e.to && e.applied !== false) && e.bucket !== 'antiga').length,
    }
    await saveProof()
    const stopped = meter.stopped()
    return { ok: true, status: 200, apply, entries, moved, unproven: entries.length - moved, summary, gh: meter.calls(), ...(stopped ? { stopped } : {}) }
  }

  /**
   * "Antigas sem registro": one-click actions on the legacy pieces that left "Revisão do líder" (no proof, nobody alive, > 24 h,
   * no delivery statement still waiting). `publish` marks the piece done on the board, `archive` abandons it with a comment. NEVER
   * deletes. A piece with a delivery record, or one that is not an old record-less in-review piece, is refused (it is not "antiga").
   * H6: it answers from what the board says right now, never from a reconcile inside the click: `ids` (what the screen shows and
   * counted) or `all` = every antiga except those the last run proved. `expect` = the number the person saw; a different number
   * refuses. `signal`: the caller gave up, so the pieces not reached yet are left alone.
   */
  const antigas = async (o: { action: unknown; preview?: unknown; ids?: unknown; all?: unknown; version?: unknown; reason?: unknown; expect?: unknown }, actor: string, signal?: AbortSignal): Promise<AntigasReply> => {
    if (o.action !== 'publish' && o.action !== 'archive' && o.action !== 'conclude') return fail(400, 'bad_action', 'action must be publish, archive or conclude')
    const action: AntigaAction = o.action
    const sessions = await d.facts.sessions().catch(() => [] as SessionFact[])
    if (!(actor === 'owner' || actor.startsWith('flow:') || sessions.some(s => s.id === actor && s.role === 'leader'))) return fail(403, 'so_o_lider', 'only a leader (or the owner) acts on the old pieces')
    if (!d.closeLegacy) return fail(501, 'sem_quadro', 'this host cannot close board pieces')
    const version = typeof o.version === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(o.version.trim()) ? o.version.trim().replace(/^v/, '') : undefined
    if (typeof o.version === 'string' && o.version.trim() && !version) return fail(400, 'bad_version', 'version must look like 2.203.0 (or be left empty)')
    const reason = typeof o.reason === 'string' && o.reason.trim() ? o.reason.trim().slice(0, 500) : undefined
    const nowMs = d.now()
    const alive = new Set(sessions.filter(s => s.alive).map(s => s.subtaskId ?? s.taskId).filter((x): x is string => !!x))
    const pieces = await d.reviewPieces?.().catch(() => []) ?? []
    const piecesById = new Map(pieces.map(p => [p.id, p]))
    const proofs = await loadProof()
    const facts = (p: ReviewPiece) => ({ hasRecord: false, status: p.status, hasOpenChildren: p.hasOpenChildren, proven: proofs.outcomes.get(p.id)?.proven, live: alive.has(p.id), updatedMs: msOf(p.updatedAt), handbackMs: msOf(p.handbackAt), suggested: !!proofs.outcomes.get(p.id)?.suggestion, unchecked: !!proofs.outcomes.get(p.id)?.unchecked, uncheckedWhy: proofs.outcomes.get(p.id)?.unchecked, nowMs })
    const doc = await d.store.read()
    // ONE predicate: when the host can say which pieces the Live lists as antigas, that list decides membership everywhere below.
    // Every chunk of a running batch writes the board (which drops the Live's cache), so a chunk reuses the set read when the batch began
    // (30 s); a preview or an `all` always reads afresh. The write boundary (`closeLegacy`) still re-checks open children.
    const fresh = o.all === true || o.all === 'true' || o.preview === true || o.preview === 'true' || !oldCache || d.now() - oldCache.at > 30_000
    if (fresh) oldCache = { at: d.now(), v: await d.oldPieces?.().catch(() => null) ?? null }
    const liveOld = oldCache!.v
    const liveById = liveOld ? new Map(liveOld.map(p => [p.id, p])) : null
    const isOld = (id: string): boolean => liveById ? liveById.has(id) && !proofs.outcomes.get(id)?.proven : (() => { const p = piecesById.get(id); return !!p && isAntiga(facts(p)) })()
    const taskOf = (id: string): string | undefined => piecesById.get(id)?.taskId ?? liveById?.get(id)?.taskId
    let ids: string[] = []
    if (o.all === true || o.all === 'true') {
      ids = liveById
        ? [...liveById.keys()].filter(id => !doc.deliveries[id] && isOld(id))
        : pieces.filter(p => !doc.deliveries[p.id] && isAntiga(facts(p)) && !proofs.outcomes.get(p.id)?.proven).map(p => p.id)
    } else {
      const raw = Array.isArray(o.ids) ? o.ids : typeof o.ids === 'string' ? o.ids.split(',') : []
      ids = [...new Set(raw.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean))]
    }
    if (o.expect !== undefined && o.expect !== null && Number(o.expect) !== ids.length) return fail(409, 'count_changed', `the group now has ${ids.length} pieces, not ${String(o.expect)}: nothing was changed, look again`)
    if (!ids.length) return { ok: true, status: 200, action, done: [] }
    const bad = ids.find(id => !SUB_ID.test(id))
    if (bad) return fail(400, 'bad_subtask', `invalid subtask id ${bad}`)
    if (action === 'conclude' && (o.preview === true || o.preview === 'true')) {
      let conclude = 0
      let archive = 0
      const eligible = ids.filter(id => !doc.deliveries[id] && isOld(id))
      const withSession = d.hasSessions ? await d.hasSessions(eligible).catch(() => null) : null
      for (const id of eligible) {
        const has = withSession ? withSession.has(id) : (!d.hasSession || await d.hasSession(id).catch(() => true))
        if (has) conclude++
        else archive++
      }
      return { ok: true, status: 200, action, preview: { conclude, archive }, done: [] }
    }
    const done: Array<{ subtaskId: string; ok: boolean; how?: 'concluded' | 'archived'; reason?: string; code?: 'no_session' }> = []
    for (const id of ids) {
      if (signal?.aborted) return { ok: true, status: 200, action, done, stopped: true }
      const taskId = taskOf(id)
      if (doc.deliveries[id]) { done.push({ subtaskId: id, ok: false, reason: 'the piece has a delivery record: it is not "antiga" (use the flow verbs)' }); continue }
      if (!taskId) { done.push({ subtaskId: id, ok: false, reason: 'the piece is not in review on the board' }); continue }
      if (!isOld(id)) { done.push({ subtaskId: id, ok: false, reason: 'the piece is recent, has a live session or a delivery still waiting: it is still review work' }); continue }
      // Proven shipped, waiting for its reconcile to move it: archiving it as abandoned would write down the opposite of what is known.
      if (action === 'archive' && proofs.outcomes.get(id)?.proven) { done.push({ subtaskId: id, ok: false, reason: 'the last reconcile proved this piece shipped: it goes to Published, it is not abandoned' }); continue }
      const close = (to: 'done' | 'abandoned') => d.closeLegacy!(id, to).catch(e => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }))
      let how: 'concluded' | 'archived' | undefined
      let out = await close(action === 'archive' ? 'abandoned' : 'done')
      if (action === 'conclude') {
        how = 'concluded'
        // The session gate stays: a piece with no session is not marked done, it is archived (never deleted).
        if (!out.ok && /done_needs_session/.test(out.message) && !proofs.outcomes.get(id)?.proven) { out = await close('abandoned'); how = 'archived' }
      }
      if (!out.ok) {
        // M2: the board's own code means nothing to a person; say what is missing and leave the way out to the screen (archive, or open the task).
        if (/done_needs_session/.test(out.message)) done.push({ subtaskId: id, ok: false, code: 'no_session', reason: 'no session is filed on this piece, so the board cannot mark it done: archive it, or open the task and file the conversation that delivered it' })
        else done.push({ subtaskId: id, ok: false, reason: out.message })
        continue
      }
      const applied = how === 'archived' ? 'archive' : action === 'conclude' ? 'publish' : action
      await d.board.comment(taskId, id, antigaComment(applied, { version, reason })).catch(() => undefined)
      await d.emit('entrega.antiga', { subtarefa: id, acao: applied }).catch(() => undefined)
      done.push({ subtaskId: id, ok: true, ...(how ? { how } : {}) })
    }
    return { ok: true, status: 200, action, done }
  }

  /**
   * AUTOMATIC reconcile (every user, no leader needed): after the store loads and then on its cadence, in APPLY mode for what is
   * proven. Single flight, off the minute's hot path (a background promise) unless a test awaits it. No gh token or no network =
   * nothing proven and nothing moved. Idempotent: a moved piece leaves the scope, so a second run writes nothing.
   * H5: the next run is at least `every` away AND at least 3x what this one took; a run that hit GitHub's limit (or found the quota
   * below a third) waits longer each time, up to AUTO_BACKOFF_MAX_MS. All of it is kept in the proof cache, so a restart resumes
   * instead of starting over.
   */
  let antigasRunning: number | null = null // when the running call took the lock
  let oldCache: { at: number; v: Array<{ id: string; taskId: string }> | null } | null = null
  const ANTIGAS_LOCK_MS = 10 * 60_000
  let autoRun: Promise<void> | null = null
  const autoReconcile = async (actions: string[]): Promise<void> => {
    if (!(typeof d.autoReconcile === 'function' ? d.autoReconcile() : d.autoReconcile)) return
    if (autoRun) return
    const proofs = await loadProof()
    const now = d.now()
    if (now < proofs.auto.nextAt) return
    const every = d.autoReconcileEveryMs ?? AUTO_EVERY_MS
    proofs.auto.nextAt = now + every // a crash mid-run must not start another at once
    const log = (line: string) => { actions.push(line); d.log?.(`[delivery] ${line}`) }
    const run = (async () => {
      const finish = (report: AutoRunReport, wait: number) => { proofs.auto.last = report; proofs.auto.nextAt = d.now() + wait }
      try {
        const room = await quotaRoom()
        if (room !== null && room < AUTO_MIN_QUOTA_ROOM) {
          proofs.auto.failures += 1
          const wait = Math.min(AUTO_BACKOFF_MAX_MS, every * 2 ** proofs.auto.failures)
          finish({ at: iso(d), ms: 0, gh: 1, stopped: 'quota-low' }, wait)
          log(`auto-reconcile adiada: cota do GitHub em ${Math.round(room * 100)}%; próxima em ${Math.round(wait / 60_000)} min`)
          return
        }
        const startedMs = d.now()
        const r = await reconcile({ apply: true }, RECONCILE_ACTOR, { budget: AUTO_RUN_GH_BUDGET })
        if (!r.ok) { finish({ at: iso(d), ms: d.now() - startedMs, gh: 0, stopped: r.code }, every); log(`auto-reconcile-recusado ${r.code}`); return }
        const ms = d.now() - startedMs
        proofs.auto.failures = r.stopped === 'rate-limit' ? proofs.auto.failures + 1 : 0
        const wait = r.stopped === 'rate-limit' ? Math.min(AUTO_BACKOFF_MAX_MS, every * 2 ** proofs.auto.failures) : Math.max(every, ms * 3)
        finish({ at: iso(d), ms, gh: r.gh, summary: r.summary, ...(r.stopped ? { stopped: r.stopped } : {}) }, wait)
        log(`auto-reconcile ${r.summary.published}+${r.summary.toCi + r.summary.ciRed}/${r.entries.length} antigas ${r.summary.antigas} gh ${r.gh}${r.stopped ? ` parou: ${r.stopped}` : ''}`)
      } catch (e) {
        finish({ at: iso(d), ms: 0, gh: 0, stopped: 'error' }, every)
        if (e instanceof DeliveryStoreUnreadable) { log('auto-reconcile-store-ilegivel'); return }
        log(`auto-reconcile-erro: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
      } finally { autoRun = null; await saveProof() }
    })()
    autoRun = run
    if (d.autoReconcileAwait) await run
  }
  /** The share of the core quota still free (0..1); null = could not tell (no token, a fake): the run itself will find out. `rate_limit` itself costs nothing. */
  const quotaRoom = async (): Promise<number | null> => {
    const cwd = (await d.facts.repoCwd?.().catch(() => null)) ?? '.'
    const raw = await d.facts.gh(cwd, ['api', 'rate_limit', '--jq', '.resources.core']).catch(() => '')
    try { const c = JSON.parse(raw) as { remaining?: unknown; limit?: unknown }; return typeof c.remaining === 'number' && typeof c.limit === 'number' && c.limit > 0 ? c.remaining / c.limit : null } catch { return null }
  }

  const tickOnce = async (): Promise<{ actions: string[] }> => {
    const actions: string[] = []
    await cleanQueue(actions)
    // ONE read of the fleet and ONE read of the board's blocked pieces per tick; null = could not be read (never "none").
    const sessions = await d.facts.sessions().catch(() => null)
    await watchRequests(sessions, actions)
    const blocked = d.facts.blockedSubtasks ? await d.facts.blockedSubtasks().catch(() => null) : null
    await reconcileAdopted(blocked, actions)
    await retryDeferredBoard(blocked, actions)
    await adoptOrphans(blocked ?? [], sessions, actions)
    let doc = await d.store.read()
    // A blocked piece with no leader picks one up as soon as one exists, and one whose leader DIED is handed to the live one
    // (the same rule as adoption). With no live candidate the recorded leader stays: the wake is tried and its failure stamped.
    if (sessions) {
      for (const r of Object.values(doc.deliveries)) {
        if (r.phase !== 'bloqueado' || r.block?.unlocker !== 'leader') continue
        if (r.leaderSessionId && sessions.some(s => s.id === r.leaderSessionId && s.alive)) continue
        const leader = leaderFor(sessions, r.taskId, r.subtaskId)
        if (leader && leader !== r.leaderSessionId) await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c) c.leaderSessionId = leader })
      }
    }
    doc = await d.store.read()
    const records = Object.values(doc.deliveries).filter(r => !r.dequeued)
    const autonomous = await d.autonomous().catch(() => true)
    const finished = new Map<string, boolean>()
    for (const r of records) {
      if (r.phase !== 'bloqueado' || r.block?.reason !== 'dependencia') continue
      const sub = await d.facts.subtask(r.subtaskId).catch(() => null)
      // A TASK-level piece is no subtask: its dependencies come from the board's blocked-piece fact (BLOQUEIO.ORFAO r3).
      const blockers = sub?.blockedBy ?? (blocked ?? []).find(b => b.id === r.subtaskId)?.blockedBy ?? []
      const all = await Promise.all(blockers.map(async id => doc.deliveries[id]?.phase === 'publicado' || await d.board.subtaskFinished(id).catch(() => false)))
      finished.set(r.subtaskId, blockers.length > 0 && all.every(Boolean))
    }
    // ONE message per leader per tick, however many pieces they have blocked (a backlog of 60 is one nudge, not 60).
    const titles = new Map((blocked ?? []).map(b => [b.id, b.title] as const))
    const batches = new Map<string, Array<{ r: DeliveryRecord; kind: 'wake' | 'defer' | 'convert'; text: string }>>()
    const orphans: Array<{ r: DeliveryRecord; kind: 'wake' | 'defer' | 'convert' }> = []
    const enqueue = (r: DeliveryRecord, kind: 'wake' | 'defer' | 'convert', text: string) => {
      if (!r.leaderSessionId) { orphans.push({ r, kind }); return }
      const list = batches.get(r.leaderSessionId) ?? []
      list.push({ r, kind, text })
      batches.set(r.leaderSessionId, list)
    }
    for (const a of planWatch(records, { nowMs: d.now(), autonomous, dependencyDone: r => finished.get(r.subtaskId) === true })) {
      const r = doc.deliveries[a.subtaskId]!
      if (a.kind === 'unblock-dependency') { await unblock(a.subtaskId, 'flow:entrega', 'dependência concluída'); actions.push(`unblock ${a.subtaskId}`); continue }
      if (a.kind === 'convert-owner-block') {
        await d.store.update(x => { const c = x.deliveries[a.subtaskId]; if (c?.block) { c.block.reason = 'fora_das_autorizacoes'; c.block.unlocker = 'leader' } })
        const hours = Math.max(0, Math.round((d.now() - Date.parse(r.block?.since ?? '')) / 3600_000)) || 0
        if (await deferOut(r, `[fluxo entrega] modo autônomo ligado: a decisão pendente do dono passou ao líder — peça adiada para o próximo lote (bloqueio de ${hours} h: ${r.block?.text ?? ''}); voltou para a fila e o bloqueio fica no histórico.`)) {
          enqueue(r, 'convert', 'modo autônomo: a decisão que esperava o dono agora é sua — a peça foi adiada para o próximo lote; escolha o caminho seguro e registre.')
        }
        actions.push(`convert ${a.subtaskId}`); continue
      }
      if (a.kind === 'defer') {
        const hours = Math.round(a.ageMs / 3600_000)
        if (await deferOut(r, `[fluxo entrega] bloqueio (${a.reason}) há mais de 2 h: peça ADIADA — adiada para o próximo lote (bloqueio de ${hours} h: ${r.block?.text ?? ''}). Voltou para a fila (Na fila) e o bloqueio fica no histórico. Registro do líder; o dono não foi chamado.`)) {
          await d.emit('entrega.adiada', { subtarefa: a.subtaskId, motivo: a.reason }).catch(() => undefined)
          enqueue(r, 'defer', `bloqueio (${a.reason}) passou de 2 h: a peça foi adiada para o próximo lote e voltou para a fila. Registre a decisão e siga com a fila.`)
          actions.push(`defer ${a.subtaskId}`)
        }
        continue
      }
      enqueue(r, 'wake', `continua bloqueada (${a.reason}, há ${Math.round(a.ageMs / 60_000)} min): ${a.text}. Destrave ou registre o caminho; > 2 h a peça é adiada.`)
    }
    const attempted = async (ids: string[]) => { if (ids.length > 0) await d.store.update(x => { for (const id of ids) { const c = x.deliveries[id]; if (c?.block) c.block.lastWakeAttemptAt = iso(d) } }) }
    // Nobody to wake: say so (the failure is stamped, so the next try waits its 30 minutes instead of repeating every minute).
    for (const o of orphans.filter(x => x.kind === 'wake')) actions.push(`wake-failed ${o.r.subtaskId}`)
    await attempted(orphans.filter(x => x.kind === 'wake').map(x => x.r.subtaskId))
    for (const [leader, items] of batches) {
      const text = items.length === 1
        ? `[entrega ${items[0]!.r.subtaskId}] ${items[0]!.text}`
        : `[entrega bloqueios] ${items.length} peças bloqueadas precisam de você (destrave com agentistics_task_phase action=unblock, ou registre o caminho; > 2 h a peça é adiada para o próximo lote e volta para a fila):\n${items.slice(0, WAKE_LIST_MAX).map(i => `- ${[i.r.subtaskId, titles.get(i.r.subtaskId)].filter(Boolean).join(' ')} (${i.kind === 'wake' ? i.r.block?.reason ?? '' : 'adiada'}): ${i.r.block?.text ?? ''}`).join('\n')}${items.length > WAKE_LIST_MAX ? `\n… e mais ${items.length - WAKE_LIST_MAX}.` : ''}`
      const reached = await d.notify.session(leader, text).catch(() => false)
      const wakes = items.filter(i => i.kind === 'wake')
      if (!reached) {
        for (const i of wakes) actions.push(`wake-failed ${i.r.subtaskId}`)
        await attempted(wakes.map(i => i.r.subtaskId))
        continue
      }
      if (wakes.length > 0) await d.store.update(x => { for (const i of wakes) { const c = x.deliveries[i.r.subtaskId]; if (c?.block) { c.block.lastWakeAt = iso(d); c.block.wakes = (c.block.wakes ?? 0) + 1 } } })
      for (const i of wakes) actions.push(`wake ${i.r.subtaskId}`)
    }
    // The queue's expected slot, kept fresh: a queued piece with a complete pre-dispatch re-reads `vaga` every few minutes
    // (information for the card — never a transition).
    for (const r of records.filter(x => x.phase === 'fila' && x.gates.predispatch?.ok)) {
      const last = r.gates.vaga ? Date.parse(r.gates.vaga.at) : NaN
      if (Number.isFinite(last) && d.now() - last < QUEUE_SLOT_REFRESH_MS) continue
      const v = await runGate('vaga', r, d.facts)
      await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c && c.phase === 'fila') { c.gates.vaga = { ok: v.ok, at: iso(d), revision: c.revision, ...(v.evidence ? { evidence: v.evidence } : {}), ...(v.reason ? { reason: v.reason } : {}), ...(v.missing?.length ? { missing: v.missing } : {}) } } })
    }
    // FILA.PRIORIDADE — `fila-proximo`: the next queued piece, when a slot is free. It never breaks the rest of the tick.
    await queueNextOnce(actions).catch(e => { if (e instanceof DeliveryStoreUnreadable) throw e; actions.push(`fila-erro: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`) })
    // FLUXO.CICLO-COMPLETO — a merged PR moves its piece to ci by itself (the next tick publishes it from the tag).
    await detectMerges(records, actions).catch(e => { if (e instanceof DeliveryStoreUnreadable) throw e; actions.push(`merge-erro: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`) })
    const releaseVerdicts = new Map<string, GateVerdict>()
    for (const r of records.filter(x => x.phase === 'ci')) {
      // Back off the gh polling: a piece that has sat in `ci` a while is polled less often (a tenth of its age, 1..10 min).
      const warnings: string[] = []
      const lastRun = r.gates.release && r.gates.release.revision === r.revision ? Date.parse(r.gates.release.at) : NaN
      const enteredCi = Date.parse(r.history.at(-1)?.at ?? r.updatedAt)
      const backoff = Math.min(RELEASE_POLL_MAX_MS, Math.max(RELEASE_POLL_MIN_MS, Number.isFinite(enteredCi) ? (d.now() - enteredCi) / 10 : 0))
      if (Number.isFinite(lastRun) && d.now() - lastRun < backoff) continue
      // Siblings declared in the same repository/release share one bounded search per tick.
      const releaseKey = JSON.stringify([r.releaseRepo ?? r.subtaskId, r.tag, r.versionTarget, r.mergeSha, r.pr, Boolean(r.declaredRelease)])
      let v = releaseVerdicts.get(releaseKey)
      if (!v) { v = await runGate('release', r, d.facts); releaseVerdicts.set(releaseKey, v) }
      if (v.ok) {
        // The verdict just obtained is handed to the transition (one gh poll per piece per tick, not two).
        const out = await transition(r.subtaskId, 'publicado', { detail: 'release.yml verde e tag publicada' }, 'flow:entrega', new Map([['release', v]]))
        actions.push(`publish ${r.subtaskId}:${out.ok}`)
        if (!out.ok) await writeNote(r, `release verde, mas a publicação foi recusada: ${out.sentence}`, true)
      } else if (releaseFailed(v) && (r.declaredRelease || r.mergeDetected)) {
        await writeNote(r, v.reason ?? 'release.yml falhou', true)
        // A piece the leader DECLARED is never sent back to the review by the tick: its release is not a PR merge the flow
        // made, and the leader already knows what is in it. The tag's own run is red, so it stays in `ci` with the reason,
        // and the leader is woken ONCE (`releaseFailNotice`); a later green run publishes it.
        await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c && c.phase === 'ci' && c.revision === r.revision) absorb(c, 'release', v) })
        if (v.patch?.ci && JSON.stringify(v.patch.ci) !== JSON.stringify(r.ci)) await d.board.setCi(r.subtaskId, v.patch.ci).catch(() => undefined)
        if (r.releaseFailNotice) { actions.push(`release-failed-stays ${r.subtaskId}`); continue }
        const woke = await wake(r, `a release.yml da tag declarada falhou (${v.reason ?? 'execução vermelha'}); a peça fica em ci até a execução ficar verde. Corrija a release e rode agentop flow release de novo, ou mova a peça.`, warnings)
        if (woke) await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c && c.phase === 'ci') c.releaseFailNotice = { at: iso(d), reason: v.reason ?? 'release.yml failed' } })
        actions.push(`release-failed-notified ${r.subtaskId}:${woke}`)
      } else if (releaseFailed(v)) { const out = await transition(r.subtaskId, 'revisao_lider', { detail: v.reason ?? 'release falhou' }, 'flow:entrega'); actions.push(`release-failed ${r.subtaskId}:${out.ok}`) }
      else {
        const changed = v.patch?.ci && JSON.stringify(v.patch.ci) !== JSON.stringify(r.ci)
        await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c && c.phase === 'ci' && c.revision === r.revision) absorb(c, 'release', v) })
        await writeNote(r, v.reason ?? 'a release ainda não tem evidência', false)
        if (changed) await d.board.setCi(r.subtaskId, v.patch!.ci!).catch(() => undefined)
      }
    }
    // FLUXO.CICLO-COMPLETO — whatever still waits on a person is reminded to the task's LIVE leader on a timer.
    await nudgeLeaders(sessions, actions).catch(e => { if (e instanceof DeliveryStoreUnreadable) throw e; actions.push(`nudge-erro: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`) })
    // CICLO.RECONCILE-2 — the review column cleans itself: proven pieces move without anyone running a verb.
    await autoReconcile(actions)
    return { actions }
  }

  return {
    get: (id: string) => d.store.get(id),
    list: async () => Object.values((await d.store.read()).deliveries),
    ensure,
    // An unreadable store REFUSES the write (and keeps a copy of the file) instead of letting any verb replace it with an empty book.
    transition: safe((id: string, to: unknown, input: TransitionInput, actor: string) => transition(id, to, input, actor)),
    gate: safe(gate), block: safe(block), unblock: safe(unblock), approve: safe(approve), configure: safe(configure), step: safe(step),
    stepEvent: async (id: string, n: unknown, actor: string): Promise<StepEventReply> => { try { return await stepEvent(id, n, actor) } catch (e) { return fail(500, 'step_erro', `the step could not be recorded (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`) } },
    // An I/O error on the batch write is a clean, structured refusal (the single store write landed entirely or not at all), never an uncaught throw.
    release: async (o: { version: unknown; mergeSha: unknown; subtaskIds: unknown; repo?: unknown }, actor: string): Promise<ReleaseReply> => {
      try { return await release(o, actor) } catch (e) {
        if (e instanceof DeliveryStoreUnreadable) return fail(503, 'store_ilegivel', e.message) as Extract<DeliveryReply, { ok: false }>
        return fail(500, 'store_erro', `the release could not be written (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); the batch write is all-or-nothing and the verb is idempotent — run it again`) as Extract<DeliveryReply, { ok: false }>
      }
    },
    reconcile: async (o: { apply?: unknown }, actor: string, opts?: { budget?: number }): Promise<ReconcileReply> => {
      try { return await reconcile(o, actor, opts) } catch (e) {
        if (e instanceof DeliveryStoreUnreadable) return fail(503, 'store_ilegivel', e.message) as Extract<DeliveryReply, { ok: false }>
        throw e
      }
    },
    /** What the last automatic run did and the last run concluded per piece (the Live's suggestion beside an old card). */
    proofOutcomes: async () => { const c = await loadProof(); return { outcomes: c.outcomes, auto: c.auto } },
    antigas: async (o: { action: unknown; preview?: unknown; ids?: unknown; all?: unknown; version?: unknown; reason?: unknown; expect?: unknown }, actor: string, signal?: AbortSignal): Promise<AntigasReply> => {
      // ONE run at a time: two writers over the same pieces would count the same piece twice and make the screen's "N of M" a lie.
      // The lock is this closure's own flag, in memory: a restart starts free, and `finally` frees it on finish, abort and throw alike.
      // A call that never returns (a hung board write) would hold it for good, so the hold is a lease: past ANTIGAS_LOCK_MS it is stale.
      // A PREVIEW only reads: it takes no lock, or a click made while it loads is refused for a run that does not exist.
      // A simulation request must never write: only `conclude` can be simulated, so any other action asked with a preview (or a
      // preview value that is not a clear yes/no) is refused before the lock and before anything is read.
      const wantsPreview = o.preview === true || o.preview === 'true'
      const noPreview = o.preview === undefined || o.preview === null || o.preview === false || o.preview === 'false'
      if (!wantsPreview && !noPreview) return fail(400, 'bad_preview', 'preview must be true or false')
      if (wantsPreview && o.action !== 'conclude') return fail(400, 'preview_only_conclude', 'preview only simulates "conclude"; publish and archive cannot be simulated, so nothing was changed: ask without preview to act, or preview "conclude"')
      if (wantsPreview) {
        try { return await antigas(o, actor, signal) } catch (e) {
          if (e instanceof DeliveryStoreUnreadable) return fail(503, 'store_ilegivel', e.message) as Extract<DeliveryReply, { ok: false }>
          throw e
        }
      }
      if (antigasRunning !== null && d.now() - antigasRunning < ANTIGAS_LOCK_MS) return fail(409, 'antigas_running', 'another run on the old pieces is already going: wait for it to finish, then look again')
      const mine = d.now()
      antigasRunning = mine
      try { return await antigas(o, actor, signal) } catch (e) {
        if (e instanceof DeliveryStoreUnreadable) return fail(503, 'store_ilegivel', e.message) as Extract<DeliveryReply, { ok: false }>
        throw e
      } finally { if (antigasRunning === mine) antigasRunning = null }
    },
    queueNext, answerQueue: safe(answerQueue), queueView,
    stage: safe(stage), stageRun: safe(stageRun), dequeue: safe(dequeue), foldGroupMember, qaOpen: safe(qaOpen), ajustesOpen: safe(ajustesOpen), merge: safe(merge), tick,
  }
}

export type DeliveryService = ReturnType<typeof createDeliveryService>

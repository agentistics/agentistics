/**
 * delivery/guard.ts — the PURE half of the store-level guard (ENTREGA.GARANTIDA §2.2, §2.5, rule A). No IO, no clock.
 *
 * The guard binds the SEMANTIC stage of a piece, not a list of doors: the persistence choke points
 * (`task-store.ts` `write()`, `delivery/store.ts` `update()`) diff the rank of every piece before and after a write, and a
 * write that RAISES one must carry a `GuardContext` and a passing guard-A outcome. A write with no context fails closed.
 *
 * Rank (spec §2.2): queue/running/qa/adjust/blocked = 0 · leader = 1 · merge = 2 · ci = 3 · published = 4 · completed = 5, read
 * from the STORED stage of a status (never its label), and from the subtask's `ci` signal (the Live shows a card as CI / Publicado
 * on it). A delivery phase: fila..ajuste/bloqueado = 0 · revisao_lider 1 · pr_merge 2 · ci 3 · publicado 4.
 *
 * S2a scope: ranks 1–3 need guard A (evidence); ranks 4–5 need A as well until guard B (S5) arrives — B itself is not
 * enforced here. Override and the owner-only moves belong to later slices; guard A binds every principal alike
 * ("the owner is not exempt from guard A", §3.5.15 v).
 *
 * The writer inventory prevents accidental raw writers in our own code; deliberately obfuscated committed code is
 * covered by code review. Production forbids eval/Function, process.binding and nonliteral globalThis/Bun access.
 */
import type { RequestPrincipal } from './principal'

/** What a write carries to say who is asking. Optional in S2a (fail-closed at runtime); S2c makes it required. */
export interface GuardContext {
  principal: RequestPrincipal
}

/** The engine itself, IN-PROCESS (spec §2.3: never built from a request body). Guard A binds it like everyone else. */
export const flowContext = (engine: 'entrega' | 'verificacao' | 'custody' = 'entrega'): GuardContext => ({ principal: { kind: 'flow', engine } })
/** A door that cannot prove who is asking still PASSES a context (guard A is principal-blind in S2a); it just says `unattributed`. */
export const unattributedContext = (): GuardContext => ({ principal: { kind: 'unattributed' } })

/**
 * The context a delivery-service write carries, from the ACTOR string the service already resolved from a principal (S0a):
 * `flow:*` is the engine, `owner` the legacy-browser owner (the vault-credential kind needs a grant the service never sees),
 * a session id a proven session, anything else — `unattributed` included — unattributed.
 */
export function contextOfActor(actor: string): GuardContext {
  if (actor.startsWith('flow:')) return flowContext()
  if (actor === 'owner') return { principal: { kind: 'owner', via: 'legacy-browser' } }
  if (!actor || actor === 'unattributed') return unattributedContext()
  return { principal: { kind: 'session', id: actor, via: 'token' } }
}

export type RuleState = 'off' | 'shadow' | 'on'

export const STAGE_RANKS: Readonly<Record<string, number>> = { leader: 1, merge: 2, ci: 3, published: 4, completed: 5 }
export const stageRank = (stage: string | null | undefined): number => (stage ? STAGE_RANKS[stage] ?? 0 : 0)

const PHASE_RANKS: Readonly<Record<string, number>> = { revisao_lider: 1, pr_merge: 2, ci: 3, publicado: 4 }
export const phaseRank = (phase: string | null | undefined): number => (phase ? PHASE_RANKS[phase] ?? 0 : 0)

// ── board ────────────────────────────────────────────────────────────────────

export interface BoardSlice {
  tasks: ReadonlyArray<{ id: string; status: string }>
  subtasks: ReadonlyArray<{ id: string; taskId: string; status: string; parentGroupId?: string; ci?: { tagPublished?: boolean } | null }>
  statuses: ReadonlyArray<{ id: string; stage?: string }>
}

/** What `decideGuard` and the host address a raised piece by. */
export interface Raised { key: string; taskId: string; subtaskId?: string; rank: number }

/** The STORED stage of a status; a status the vocabulary does not carry reads as rank 0 (it names no stage — never a label guess). */
function statusRank(statuses: BoardSlice['statuses'], id: string): number {
  const def = statuses.find(s => s.id === id)
  if (def?.stage !== undefined) return stageRank(def.stage)
  // A book read without `planStatusStages` (a raw store read): the id alone classifies, exactly as `stageOfPieceStatus` does.
  switch (id) { case 'in_review': return 1; case 'done': return 4; default: return 0 }
}

const subRank = (b: BoardSlice, s: BoardSlice['subtasks'][number]): number => {
  const byStatus = statusRank(b.statuses, s.status)
  // The Live shows a card on CI the moment the CI signal exists and on Publicado once its tag is published.
  const bySignal = s.ci ? (s.ci.tagPublished ? 4 : 3) : 0
  return Math.max(byStatus, bySignal)
}

/**
 * PURE (S2b). Every piece the board holds, as the guard counts them (group members and tasks that have subtasks are not pieces),
 * with the rank its STATUS gives and the rank its `ci` SIGNAL alone gives. The sweep reads this so it can never disagree with
 * `boardRaises` about what a piece is.
 */
export function boardPieces(b: BoardSlice): Array<{ key: string; taskId: string; subtaskId?: string; status: string; statusRank: number; ciRank: number }> {
  const out: Array<{ key: string; taskId: string; subtaskId?: string; status: string; statusRank: number; ciRank: number }> = []
  const taskWithSubs = new Set(b.subtasks.map(s => s.taskId))
  for (const s of b.subtasks) {
    if (s.parentGroupId) continue
    out.push({ key: s.id, taskId: s.taskId, subtaskId: s.id, status: s.status, statusRank: statusRank(b.statuses, s.status), ciRank: s.ci ? (s.ci.tagPublished ? 4 : 3) : 0 })
  }
  for (const t of b.tasks) if (!taskWithSubs.has(t.id)) out.push({ key: t.id, taskId: t.id, status: t.status, statusRank: statusRank(b.statuses, t.status), ciRank: 0 })
  return out
}

/** PURE. Rank increases, newly exposed pieces, and changes to an already protected piece's binding. */
export function boardRaises(before: BoardSlice, after: BoardSlice): Raised[] {
  const out: Raised[] = []
  // Maps, not `find`: this runs on every write of a book that can hold thousands of subtasks.
  const subsBefore = new Map(before.subtasks.map(s => [s.id, s] as const))
  const tasksBefore = new Map(before.tasks.map(t => [t.id, t] as const))
  const taskWithSubs = new Set(after.subtasks.map(s => s.taskId))
  const taskWithSubsBefore = new Set(before.subtasks.map(s => s.taskId))
  for (const s of after.subtasks) {
    if (s.parentGroupId) continue // a group member inherits its group's rules
    const was = subsBefore.get(s.id)
    const from = was && !was.parentGroupId ? subRank(before, was) : 0
    const to = subRank(after, s)
    if (to > from || (to >= 1 && was && (was.taskId !== s.taskId || was.parentGroupId !== s.parentGroupId || JSON.stringify(was.ci) !== JSON.stringify(s.ci)))) out.push({ key: s.id, taskId: s.taskId, subtaskId: s.id, rank: to })
  }
  for (const t of after.tasks) {
    if (taskWithSubs.has(t.id)) continue // a task with subtasks is not a piece
    const was = tasksBefore.get(t.id)
    const from = was && !taskWithSubsBefore.has(t.id) ? statusRank(before.statuses, was.status) : 0
    const to = statusRank(after.statuses, t.status)
    if (to > from) out.push({ key: t.id, taskId: t.id, rank: to })
  }
  return out
}

// ── deliveries ───────────────────────────────────────────────────────────────

/** The protected identity of a delivery. Advanced adoption is checked just like another protected write. */
type DeliveryBinding = { phase: string; taskId?: string; subtaskId?: string; revision?: number; headSha?: string; qaSha?: string; evidence?: readonly { id: string; sha256: string; revision?: number }[] }
const binding = (r: DeliveryBinding) => JSON.stringify([r.taskId, r.subtaskId, r.revision, r.headSha, r.qaSha, r.evidence?.map(i => [i.id, i.sha256, i.revision]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])
export function deliveryRaises(before: Readonly<Record<string, DeliveryBinding>>, after: Readonly<Record<string, DeliveryBinding>>): Raised[] {
  const out: Raised[] = []
  for (const [id, r] of Object.entries(after)) {
    const was = before[id]
    const to = phaseRank(r.phase)
    const retreat = was && to < phaseRank(was.phase) && binding({ ...was, revision: r.revision }) === binding(r)
    if (to > phaseRank(was?.phase) || (to >= 1 && was && !retreat && binding(was) !== binding(r))) out.push({ key: id, taskId: r.taskId ?? '', subtaskId: id, rank: to })
  }
  return out
}

/**
 * PURE (QA r2 N1). The capture ROUND a piece's evidence is judged in comes from its durable history (the last `ajuste`) and
 * from each item's own revision. Those are facts about the past, so they are APPEND-ONLY at every rank and for every writer:
 * a history entry, an `evidenceHistory` entry or an existing evidence item is never rewritten or dropped, and a revision
 * never goes back. Adding or removing evidence (and removing a record that carries any) needs a guard context — the doors
 * that do it (`evidenceAdd`, `evidenceRemove`, adoption) always carry one. Anything else would let a contextless rank-0
 * write erase the round floor (GAP-1) or relabel old captures into the current round (GAP-2).
 */
export type TamperView = { taskId?: string; phase?: string; revision?: number; history?: readonly unknown[]; evidence?: readonly { id: string; sha256?: string; revision?: number }[]; evidenceHistory?: readonly unknown[] }
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const keepsPrefix = (was: readonly unknown[] | undefined, now: readonly unknown[] | undefined) =>
  (was ?? []).every((e, i) => (now ?? []).length > i && sameJson(e, now![i]))
const tamper = (piece: string, what: string, whatPt: string, needsContext: boolean): GuardRefusal => ({
  code: 'evidence_binding_protected', piece, missing: [needsContext ? 'a guard context' : 'an append-only history'],
  message: `This write ${what} on ${piece}. The capture round and the evidence it holds are append-only${needsContext ? ' and change only through a door that says who is asking' : ''}, so the store refuses it.`,
  messagePt: `Esta escrita ${whatPt} em ${piece}. A rodada de captura e as evidências dela só crescem${needsContext ? ' e só mudam por uma porta que diz quem está pedindo' : ''}, então o armazém recusa.`,
})
export function deliveryTamper(before: Readonly<Record<string, TamperView>>, after: Readonly<Record<string, TamperView>>, hasContext: boolean): GuardRefusal[] {
  const out: GuardRefusal[] = []
  for (const [id, was] of Object.entries(before)) {
    const now = after[id]
    if (!now) {
      if (!hasContext && ((was.evidence?.length ?? 0) > 0 || (was.history?.length ?? 0) > 0)) out.push(tamper(id, 'removes a delivery record that carries history or evidence', 'remove um registro de entrega com histórico ou evidência', true))
      continue
    }
    if (!keepsPrefix(was.history, now.history)) out.push(tamper(id, 'rewrites or drops a history entry', 'reescreve ou apaga uma entrada do histórico', false))
    else if (!keepsPrefix(was.evidenceHistory, now.evidenceHistory)) out.push(tamper(id, 'rewrites or drops an evidence history entry', 'reescreve ou apaga uma entrada do histórico de evidências', false))
    else if ((now.revision ?? 0) < (was.revision ?? 0)) out.push(tamper(id, 'moves the revision back', 'volta a revisão', false))
    else {
      const nowItems = new Map((now.evidence ?? []).map(i => [i.id, i] as const))
      const wasIds = new Set((was.evidence ?? []).map(i => i.id))
      if ((was.evidence ?? []).some(i => nowItems.has(i.id) && !sameJson(i, nowItems.get(i.id)))) out.push(tamper(id, 'rewrites an existing evidence item', 'reescreve uma evidência existente', false))
      else if ((now.evidence ?? []).some(i => !wasIds.has(i.id) && i.sha256 && (was.evidence ?? []).some(old => old.sha256 === i.sha256 && old.revision !== i.revision))) out.push(tamper(id, 'reuses a capture at another revision', 'reutiliza uma captura em outra revisão', false))
      else if (!hasContext && ((was.evidence ?? []).some(i => !nowItems.has(i.id)) || (now.evidence ?? []).some(i => !wasIds.has(i.id)))) out.push(tamper(id, 'adds or removes evidence', 'adiciona ou remove evidência', true))
    }
  }
  for (const [id, now] of Object.entries(after)) {
    const ids = (now.evidence ?? []).map(i => i.id)
    if (new Set(ids).size !== ids.length) out.push(tamper(id, 'duplicates an evidence id', 'duplica um identificador de evidência', false))
    if (!before[id] && !hasContext && (now.evidence?.length ?? 0) > 0) out.push(tamper(id, 'creates a delivery record that already carries evidence', 'cria um registro de entrega já com evidência', true))
  }
  return out
}

// ── refusal & decision ───────────────────────────────────────────────────────

export interface GuardRefusal {
  code: string
  message: string
  messagePt: string
  missing: string[]
  piece: string
  rule?: string
  paths?: string[]
}

/** Thrown by a store hook BEFORE any byte of either document is written. */
export class GuardRefused extends Error {
  readonly status = 422
  readonly code: string
  readonly messagePt: string
  readonly missing: string[]
  readonly piece: string
  readonly rule?: string
  readonly paths?: string[]
  constructor(r: GuardRefusal) {
    super(r.message)
    this.name = 'GuardRefused'
    this.code = r.code; this.messagePt = r.messagePt; this.missing = r.missing; this.piece = r.piece
    if (r.rule) this.rule = r.rule
    if (r.paths) this.paths = r.paths
  }
}

/** What the host learned about ONE raised piece: evidence good at this HEAD, or the refusal. */
export type ReviewOutcome =
  | { ok: true; ids: string[]; sha256: string[]; headSha: string | null; category: string; declared?: { by: string; repo: string; head: string; at: string }; grandfathered?: boolean }
  | { ok: false; code: string; message: string; messagePt: string; missing?: string[]; rule?: string; paths?: string[] }

export const refusalOfOutcome = (piece: string, o: Extract<ReviewOutcome, { ok: false }>): GuardRefusal => ({
  code: o.code, message: o.message, messagePt: o.messagePt, missing: o.missing ?? [], piece,
  ...(o.rule ? { rule: o.rule } : {}), ...(o.paths ? { paths: o.paths } : {}),
})

const noContext = (piece: string): GuardRefusal => ({
  code: 'guard_context_required', piece, missing: ['a guard context'],
  message: `This write moves ${piece} forward but carries no guard context (who is asking), so the store refuses it — a door that forgot to say who it is fails closed.`,
  messagePt: `Esta escrita avança ${piece} mas não traz contexto de guarda (quem está pedindo), então o armazém recusa — uma porta que esqueceu de dizer quem é falha fechada.`,
})

export type GuardDecision =
  | { verdict: 'pass'; passed?: Array<{ key: string; rank: number; outcome: Extract<ReviewOutcome, { ok: true }> }>; wouldRefuse?: GuardRefusal[] }
  | { verdict: 'refuse'; refusal: GuardRefusal }

/**
 * PURE. The one decision. `off` decides nothing; `shadow` reports what `on` would have refused and never refuses; `on`
 * refuses the first piece that has no context or whose outcome is a refusal.
 */
export function decideGuard(o: { rule: RuleState; raised: readonly Raised[]; ctx: GuardContext | undefined; outcomes: Readonly<Record<string, ReviewOutcome>> }): GuardDecision {
  if (o.rule === 'off' || o.raised.length === 0) return { verdict: 'pass' }
  const passed: Array<{ key: string; rank: number; outcome: Extract<ReviewOutcome, { ok: true }> }> = []
  const would: GuardRefusal[] = []
  for (const r of o.raised) {
    const outcome = o.outcomes[r.key]
    const refusal = !o.ctx ? noContext(r.key) : !outcome ? { ...noContext(r.key), code: 'guard_unverified', missing: ['a verdict'] } : outcome.ok ? null : refusalOfOutcome(r.key, outcome)
    if (refusal) {
      if (o.rule === 'on') return { verdict: 'refuse', refusal }
      would.push(refusal)
    } else if (outcome && outcome.ok) passed.push({ key: r.key, rank: r.rank, outcome })
  }
  return { verdict: 'pass', passed, ...(would.length ? { wouldRefuse: would } : {}) }
}

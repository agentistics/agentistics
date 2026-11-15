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

/** PURE. The pieces whose rank went UP between two books, entity by entity (a task that merely lost its subtasks did not move). */
export function boardRaises(before: BoardSlice, after: BoardSlice): Raised[] {
  const out: Raised[] = []
  // Maps, not `find`: this runs on every write of a book that can hold thousands of subtasks.
  const subsBefore = new Map(before.subtasks.map(s => [s.id, s] as const))
  const tasksBefore = new Map(before.tasks.map(t => [t.id, t] as const))
  const taskWithSubs = new Set(after.subtasks.map(s => s.taskId))
  for (const s of after.subtasks) {
    if (s.parentGroupId) continue // a group member inherits its group's rules
    const was = subsBefore.get(s.id)
    const from = was ? subRank(before, was) : 0
    const to = subRank(after, s)
    if (to > from) out.push({ key: s.id, taskId: s.taskId, subtaskId: s.id, rank: to })
  }
  for (const t of after.tasks) {
    if (taskWithSubs.has(t.id)) continue // a task with subtasks is not a piece
    const was = tasksBefore.get(t.id)
    const from = was ? statusRank(before.statuses, was.status) : 0
    const to = statusRank(after.statuses, t.status)
    if (to > from) out.push({ key: t.id, taskId: t.id, rank: to })
  }
  return out
}

// ── deliveries ───────────────────────────────────────────────────────────────

/** PURE. Records whose phase rank rose. A record that did not exist before is an ADOPTION (it mirrors the board) and is not a raise. */
export function deliveryRaises(before: Readonly<Record<string, { phase: string }>>, after: Readonly<Record<string, { phase: string; taskId?: string }>>): Raised[] {
  const out: Raised[] = []
  for (const [id, r] of Object.entries(after)) {
    const was = before[id]
    if (!was) continue
    const to = phaseRank(r.phase)
    if (to > phaseRank(was.phase)) out.push({ key: id, taskId: r.taskId ?? '', subtaskId: id, rank: to })
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

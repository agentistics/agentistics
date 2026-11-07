/**
 * delivery/machine.ts — PURE. FLUXO.ENTREGA-DSL: the ONE state machine every delivery (a subtask) walks.
 *
 *   fila → executando → qa → { aprovado: revisao_lider | reprovado: ajuste }
 *   ajuste → qa                                   (ajuste NEVER goes straight to revisao_lider)
 *   revisao_lider → { ok: pr_merge | pede mudança: ajuste }
 *   pr_merge → { merge ok: ci | falhou: revisao_lider }
 *   ci → { release.yml verde + tag: publicado | falhou: revisao_lider }
 *   bloqueado ← any phase but publicado, and back to the STORED origin phase only.
 *
 * Spec: leader/specs/fluxo-entrega-dsl.md (owner orders 06/11 21:55Z, 22:20Z, 23:35Z, 23:40Z, 23:55Z).
 *
 * This module decides; it performs nothing. A transition outside `EDGES` is refused with code
 * `fase_pulada` and a SENTENCE naming what is missing — the owner's print case (executando →
 * revisao_lider) included. Gate RESULTS are computed by the host (`gates.ts`, which checks evidence
 * itself: a caller-supplied boolean is never proof) and handed in; this module only reads them.
 *
 * Human gates (owner 06/11 ~23:55Z): a delivery may name phases that need the owner's approval before
 * it may ENTER them (`humanGates`, off by default). With autonomous mode ON the gate is SKIPPED and
 * recorded as `pulado: modo autônomo` — the leader decides; with it OFF the transition waits for an
 * explicit owner approval. Autonomous mode never yields an owner decision anywhere in this module.
 */

export const PHASES = ['fila', 'executando', 'qa', 'ajuste', 'revisao_lider', 'pr_merge', 'ci', 'publicado', 'bloqueado'] as const
export type Phase = (typeof PHASES)[number]
export const isPhase = (v: unknown): v is Phase => (PHASES as readonly unknown[]).includes(v)

/**
 * The host-checked gates. `agentop flow gate <name>` runs exactly one. `cabeca` (the pushed branch still sits at the
 * sha QA tested) and `mergeado` (the PR is MERGED on the host and the merge commit is on origin/main) read the machine
 * themselves — a sha the caller states is never proof.
 */
export const GATES = ['predispatch', 'vaga', 'salvo', 'qa-modelo', 'cabeca', 'delecoes', 'mergeado', 'release'] as const
export type GateName = (typeof GATES)[number]
export const isGate = (v: unknown): v is GateName => (GATES as readonly unknown[]).includes(v)

/** One gate's verdict as the host recorded it on the delivery. */
export interface GateResult {
  ok: boolean
  at: string
  /** The delivery revision it was checked at — a result from an older revision is stale. */
  revision: number
  /** What was checked (sha, model ids, run id, …). Never a secret. */
  evidence?: Record<string, unknown>
  reason?: string
  missing?: string[]
}

/** The closed block reasons (spec §Bloqueio). `decisao_do_dono` exists ONLY with autonomous mode OFF. */
export const BLOCK_REASONS = ['dependencia', 'pedido_de_bloqueio', 'limite', 'maquina', 'externo', 'fora_das_autorizacoes', 'decisao_do_dono'] as const
export type BlockReason = (typeof BLOCK_REASONS)[number]
export const isBlockReason = (v: unknown): v is BlockReason => (BLOCK_REASONS as readonly unknown[]).includes(v)

/** Who lifts a block. Everything but a dependency (lifts itself) and an owner decision (autonomous OFF) is the leader's. */
export function unlockerOf(reason: BlockReason): 'self' | 'leader' | 'owner' {
  return reason === 'dependencia' ? 'self' : reason === 'decisao_do_dono' ? 'owner' : 'leader'
}

/**
 * PURE. The reason a block is RECORDED under. Reason 6 has two faces: out of the authorisations with the
 * owner away is the LEADER's (safe path: defer the piece), and only with autonomous mode OFF does it become
 * a decision the owner is asked for. Asking for `decisao_do_dono` while autonomous is ON is never honoured.
 */
export function resolveBlockReason(reason: BlockReason, autonomous: boolean): BlockReason {
  if (reason === 'fora_das_autorizacoes' || reason === 'decisao_do_dono') return autonomous ? 'fora_das_autorizacoes' : 'decisao_do_dono'
  return reason
}

export interface DeliveryBlock {
  reason: BlockReason
  text: string
  since: string
  unlocker: 'self' | 'leader' | 'owner'
  /** Last time the leader (or, autonomous OFF + decisao_do_dono, the owner) was woken for it. */
  lastWakeAt?: string
  /** The last time a wake was TRIED and did not reach anybody — a failed wake is not retried every minute, it waits its cadence too. */
  lastWakeAttemptAt?: string
  wakes?: number
  /** Set once the piece was deferred to the next batch (reason 6 under autonomous, or > 2 h). */
  deferredAt?: string
  /** The deferral could not move the BOARD piece to the queue: the next tick re-applies it (once per tick, silently) until it lands. */
  boardMovePending?: boolean
  /** How many ticks already retried that board move; the retry is capped, then dropped with one notice. */
  boardMoveTries?: number
}

export interface QaVerdict { verdict: 'APROVADO' | 'REPROVADO'; findings: string; sha: string; qaSessionId?: string; at: string }
export interface LeaderReview { sha: string; decision: 'ok' | 'ajustar'; detail: string; at: string; by: string }
export interface OwnerApproval { decision: 'approve' | 'reject'; note?: string; at: string; revision: number }
export interface HumanGateSkip { phase: Phase; at: string; outcome: 'pulado: modo autônomo' }

/** The CI · publicando signal, exactly the shape the Live renders (`task-live.ts` `LiveCiSignal`). */
export interface DeliveryCi { mergedMain: boolean; releaseGreen: boolean; tagPublished: boolean; tag: string | null; pr: number | null }

export interface DeliveryHistoryEntry { from: Phase; to: Phase; at: string; actor: string; detail: string; revision: number }

/** The delivery record: one per subtask, the single source of truth the Live is a projection of. */
/** The leader's open question: is this queued piece allowed to start now? */
export interface QueueAsk {
  at: string
  leaderSessionId?: string
  /** The question reached the leader's composer; false = retried each tick until it does (or the timeout decides). */
  delivered: boolean
  /** Last reminder (autonomous OFF only): the flow keeps waiting and reminds every 10 min. */
  remindedAt?: string
  /** `sim` given (by the leader, or by the 10 min timeout in autonomous mode): start when the slot gate passes. */
  approved?: { at: string; actor: string; auto: boolean }
  /** Claimed under the store lock right before the session is spawned — two ticks never open two sessions. */
  startingAt?: string
}
export interface QueueHold {
  kind: 'nao' | 'agendar'
  reason: string
  at: string
  actor: string
  /** `agendar`: ISO instant the piece becomes a candidate again. */
  until?: string
}

export interface DeliveryRecord {
  subtaskId: string
  taskId: string
  phase: Phase
  /** Withdrawn from the queue; history and the draft remain, and only an explicit restage reopens it. */
  dequeued?: { at: string; actor: string; reason: string; commentedAt?: string }
  /** FILA.PRIORIDADE — the question put to the leader before this queued piece leaves the queue (see `fila-proximo.ts`). */
  queueAsk?: QueueAsk
  /** FILA.PRIORIDADE — the leader's `nao` / `agendar`: the piece stays queued and is not a candidate while this holds. */
  queueHold?: QueueHold
  /** FILA.PRIORIDADE — how the piece left the queue (the link to the session it opened), kept so the Fila tab can still point at it. */
  queueStarted?: { at: string; actor: string; auto: boolean; sessionId: string }
  /** Explicit link to the canonical engine pedido, retained even when its event bus is temporarily unavailable. */
  pedidoIds?: string[]
  /** Where a block returns to. Present only while `phase === 'bloqueado'`. */
  origin?: Phase
  block?: DeliveryBlock
  revision: number
  /** Release batch this piece ships in (`2.200.8`, …); `next` after a deferral. */
  versionTarget?: string
  leaderSessionId?: string
  /**
   * `board` = this record was created by the vigia's ADOPTION of a piece the board already held in `blocked` (BLOQUEIO.ORFAO),
   * not by a flow transition. Only such a record is reconciled against the board's own status each tick: the board is the
   * only witness of a block the flow never made.
   */
  adopted?: 'board'
  authorSessionId?: string
  authorModel?: string
  qaSessionId?: string
  qaModel?: string
  /** The pushed HEAD the last `salvo` gate verified. */
  headSha?: string
  branch?: string
  /** The sha QA tested (the verdict's own sha). */
  qaSha?: string
  qa?: QaVerdict
  review?: LeaderReview
  pr?: number
  mergeSha?: string
  tag?: string
  ci?: DeliveryCi
  /**
   * When the release that shipped this piece was published (ISO) — the green `release.yml` run's completion, read by the
   * `release` gate. The Live's 24 h Publicado window starts HERE, not at the moment the flow noticed, so a release
   * declared hours late still shows the piece for the rest of its window.
   */
  publishedAt?: string
  /**
   * `owner/name` — the repository the release was declared in (`flow release --repo`). The `release` gate asks gh THERE and
   * ignores any session's checkout: one release is one repository, whatever worktree a piece's author happened to run in.
   */
  releaseRepo?: string
  /** Present only for a piece the leader DECLARED through `flow release`. The tick never sends such a piece back to the review. */
  declaredRelease?: { version: string; mergeSha: string; repo: string; at: string; by: string }
  /** The tag's own release run was red: the leader was told once (ISO + reason); the piece stays in `ci` until it is green. */
  releaseFailNotice?: { at: string; reason: string }
  gates: Partial<Record<GateName, GateResult>>
  /** Phases the owner must approve before the delivery enters them (autonomous OFF only). Default: none. */
  humanGates: Phase[]
  approvals: Partial<Record<Phase, OwnerApproval>>
  /** The delivery revision at which the owner was last ASKED to approve each human gate — one bell per (phase, revision). */
  asked?: Partial<Record<Phase, number>>
  skips: HumanGateSkip[]
  /** Paths the leader allowed the PR to delete outright, with the reason (the `delecoes` gate reads it). */
  allowDeletions?: { paths: string[]; reason: string }
  /** The step of the CURRENT phase last reported (Live per-phase %). */
  step?: number
  history: DeliveryHistoryEntry[]
  createdAt: string
  updatedAt: string
}

/**
 * PURE. The phase a subtask ALREADY on the board is adopted into when its delivery record is first created (a piece
 * started before this flow existed re-entering at `fila` would be walked through the start again). Only phases whose
 * board status is unambiguous are adopted; `done` is not adopted as `publicado` (nobody proved a release), it stays `fila`.
 */
export function adoptPhase(statusId: string | undefined): Phase {
  switch (statusId) {
    case 'in_progress': return 'executando'
    case 'qa': return 'qa'
    case 'ajuste': return 'ajuste'
    case 'in_review': return 'revisao_lider'
    case 'pr_merge': return 'pr_merge'
    case 'ci': return 'ci'
    default: return 'fila'
  }
}

export function newDelivery(o: { subtaskId: string; taskId: string; at: string; humanGates?: readonly Phase[]; versionTarget?: string; leaderSessionId?: string; phase?: Phase }): DeliveryRecord {
  const phase = o.phase && o.phase !== 'bloqueado' ? o.phase : 'fila'
  return {
    subtaskId: o.subtaskId, taskId: o.taskId, phase, revision: 1,
    ...(o.versionTarget ? { versionTarget: o.versionTarget } : {}),
    ...(o.leaderSessionId ? { leaderSessionId: o.leaderSessionId } : {}),
    gates: {}, humanGates: [...new Set(o.humanGates ?? [])].filter(p => p !== 'fila' && p !== 'bloqueado'),
    approvals: {}, skips: [],
    history: phase === 'fila' ? [] : [{ from: 'fila', to: phase, at: o.at, actor: 'flow:entrega', detail: `adotada: a subtarefa já estava em ${phase} no quadro quando o fluxo a conheceu`, revision: 1 }],
    createdAt: o.at, updatedAt: o.at,
  }
}

/** What the caller states with a transition. Each edge reads only what it names. */
export interface TransitionInput {
  detail?: string
  verdict?: 'APROVADO' | 'REPROVADO'
  findings?: string
  /** The sha the leader reviewed. */
  reviewedSha?: string
  /** IGNORED: the merge sha is read from the PR on the host (`mergeado` gate), never taken from the caller. Kept so older callers still parse. */
  mergeSha?: string
}

interface Edge {
  gates: readonly GateName[]
  /** Checks on the record + input; each returns the missing piece's sentence, or null. */
  needs: ReadonlyArray<(r: DeliveryRecord, i: TransitionInput) => string | null>
}

const detail = (what: string) => (_r: DeliveryRecord, i: TransitionInput) => (i.detail && i.detail.trim() ? null : what)

/** THE table. A pair absent here is a skipped phase, refused. */
export const EDGES: Readonly<Record<string, Edge>> = {
  'fila>executando': { gates: ['predispatch', 'vaga'], needs: [] },
  'executando>qa': { gates: ['salvo'], needs: [] },
  'qa>revisao_lider': {
    gates: ['qa-modelo'],
    needs: [
      (_r, i) => (i.verdict === 'APROVADO' ? null : 'um relatório de QA com veredito APROVADO'),
      (r, i) => (i.findings?.trim() || r.qa?.findings ? null : 'a evidência do QA (findings)'),
      (r) => (r.headSha ? null : 'um HEAD verificado pelo portão salvo (rode o portão salvo antes do veredito)'),
    ],
  },
  'qa>ajuste': {
    gates: [],
    needs: [
      (_r, i) => (i.verdict === 'REPROVADO' ? null : 'um relatório de QA com veredito REPROVADO'),
      (_r, i) => (i.findings?.trim() ? null : 'os achados do QA (findings) para o ajuste'),
    ],
  },
  'ajuste>qa': { gates: ['salvo'], needs: [] },
  'revisao_lider>pr_merge': {
    gates: ['cabeca'],
    needs: [
      (r, i) => (r.qaSha ? null : 'um sha aprovado pelo QA'),
      (r, i) => (i.reviewedSha && r.qaSha && i.reviewedSha === r.qaSha ? null : `a revisão do líder do mesmo sha do QA (${r.qaSha ?? '?'})`),
      (r) => (r.headSha && r.qaSha && r.headSha !== r.qaSha ? 'o HEAD mudou depois do QA — volte por ajuste → QA' : null),
    ],
  },
  'revisao_lider>ajuste': { gates: [], needs: [detail('o pedido de mudança do líder (detail)')] },
  'pr_merge>ci': { gates: ['delecoes', 'mergeado'], needs: [(r) => (r.mergeSha ? null : 'o sha do merge no main (lido do PR pelo portão mergeado)')] },
  'pr_merge>revisao_lider': { gates: [], needs: [detail('o motivo da falha do merge (checagem, conflito ou deleção)')] },
  'ci>publicado': { gates: ['release'], needs: [] },
  'ci>revisao_lider': { gates: [], needs: [detail('o motivo da falha da publicação')] },
}

/** PURE. Where a phase may go next (the sentence of a refusal names them). */
export function nextPhases(from: Phase): Phase[] {
  return Object.keys(EDGES).filter(k => k.startsWith(`${from}>`)).map(k => k.split('>')[1] as Phase)
}

/** Refusal codes of a transition (never notification codes — they answer the caller). */
export type RefusalCode = 'fase_pulada' | 'faltando' | 'portao' | 'aguardando_dono' | 'dono_reprovou' | 'fase_desconhecida' | 'bloqueio_invalido'
export type TransitionRefusal = {
  ok: false
  code: RefusalCode
  sentence: string
  missing: string[]
}
export type TransitionPlan = { ok: true; next: DeliveryRecord; skipped: HumanGateSkip | null } | TransitionRefusal

const refuse = (code: TransitionRefusal['code'], sentence: string, missing: string[] = []): TransitionRefusal => ({ ok: false, code, sentence, missing })

/** HTTP status of a refusal: a skipped phase / missing evidence is 422, waiting on the owner is 409. */
export function refusalStatus(r: TransitionRefusal): number {
  return r.code === 'aguardando_dono' ? 409 : r.code === 'fase_desconhecida' ? 400 : 422
}

/** PURE: a gate result usable for THIS revision. */
export function gateFresh(r: DeliveryRecord, g: GateName): GateResult | null {
  const res = r.gates[g]
  return res && res.ok && res.revision === r.revision ? res : null
}

/**
 * PURE. Plan one phase transition. `autonomous` is the owner's autonomous mode at this instant.
 * Never mutates `r`; the returned `next` carries the new phase, revision, history and recorded evidence.
 */
export function planTransition(r: DeliveryRecord, to: unknown, input: TransitionInput, ctx: { at: string; actor: string; autonomous: boolean }): TransitionPlan {
  if (!isPhase(to)) return refuse('fase_desconhecida', `fase desconhecida: ${String(to)}. Fases: ${PHASES.join(', ')}.`, ['fase válida'])
  if (to === 'bloqueado' || r.phase === 'bloqueado') {
    return refuse('bloqueio_invalido', r.phase === 'bloqueado'
      ? `a entrega está bloqueada (${r.block?.reason ?? '?'}); ela só volta para ${r.origin ?? '?'} pelo desbloqueio`
      : 'bloquear usa a ação de bloqueio, com um dos motivos fechados', ['bloqueio/desbloqueio'])
  }
  const edge = EDGES[`${r.phase}>${to}`]
  if (!edge) {
    const allowed = nextPhases(r.phase)
    const extra = r.phase === 'ajuste' && to === 'revisao_lider' ? ' Ajuste nunca vai direto à revisão: volta ao QA primeiro.'
      : r.phase === 'executando' && to === 'revisao_lider' ? ' Toda entrega passa pelo QA antes da revisão do líder.' : ''
    return refuse('fase_pulada', `transição ${r.phase} → ${to} pula fase: de ${r.phase} só se vai para ${allowed.join(' ou ') || '(nada — fase final)'}.${extra}`, allowed.map(p => `${r.phase} → ${p}`))
  }
  const missing: string[] = []
  for (const g of edge.gates) {
    const res = gateFresh(r, g)
    if (!res) missing.push(`portão ${g}${r.gates[g] && !r.gates[g]!.ok ? ` (recusado: ${r.gates[g]!.reason ?? 'sem evidência'})` : r.gates[g] ? ' (resultado antigo — rode de novo)' : ' (não rodado)'}`)
  }
  for (const need of edge.needs) { const m = need(r, input); if (m) missing.push(m) }
  if (missing.length) {
    const code = missing.every(m => m.startsWith('portão ')) ? 'portao' : 'faltando'
    return refuse(code, `para ir de ${r.phase} a ${to} falta: ${missing.join('; ')}.`, missing)
  }
  let skipped: HumanGateSkip | null = null
  if (r.humanGates.includes(to)) {
    if (ctx.autonomous) skipped = { phase: to, at: ctx.at, outcome: 'pulado: modo autônomo' }
    else {
      const a = r.approvals[to]
      if (!a || a.revision !== r.revision) return refuse('aguardando_dono', `entrar em ${to} precisa da aprovação do dono (portão humano; modo autônomo desligado).`, [`aprovação do dono para ${to}`])
      if (a.decision === 'reject') return refuse('dono_reprovou', `o dono reprovou a entrada em ${to}${a.note ? `: ${a.note}` : ''}. Volte por ajuste.`, ['ajuste'])
    }
  }
  const next: DeliveryRecord = structuredClone(r)
  next.phase = to
  next.revision = r.revision + 1
  next.updatedAt = ctx.at
  delete next.step
  delete next.queueAsk // the queue's question and hold belong to the piece's time in `fila`
  delete next.queueHold
  delete next.adopted // a real flow transition: this is a delivery now, never a mere adoption (BLOQUEIO.ORFAO r3)
  if (skipped) next.skips = [...next.skips, skipped]
  const d = input.detail?.trim() ?? ''
  if (r.phase === 'qa') {
    next.qa = { verdict: input.verdict!, findings: input.findings?.trim() || r.qa?.findings || '', sha: r.headSha ?? '', ...(r.qaSessionId ? { qaSessionId: r.qaSessionId } : {}), at: ctx.at }
    if (to === 'revisao_lider') next.qaSha = r.headSha
    else delete next.qaSha
  }
  if (r.phase === 'revisao_lider') next.review = { sha: input.reviewedSha ?? '', decision: to === 'pr_merge' ? 'ok' : 'ajustar', detail: d, at: ctx.at, by: ctx.actor }
  if (to === 'ajuste') { delete next.qaSha; delete next.mergeSha; delete next.ci; delete next.publishedAt }
  if (to === 'ci') {
    next.mergeSha = r.mergeSha
    next.ci = { mergedMain: true, releaseGreen: false, tagPublished: false, tag: r.tag ?? null, pr: r.pr ?? null }
  }
  if (r.phase === 'pr_merge' && to === 'revisao_lider') { delete next.mergeSha; delete next.ci }
  if (r.phase === 'ci' && to === 'revisao_lider') delete next.ci
  if (to === 'publicado') next.ci = { mergedMain: true, releaseGreen: true, tagPublished: true, tag: r.tag ?? r.ci?.tag ?? null, pr: r.pr ?? null }
  next.history = [...r.history, { from: r.phase, to, at: ctx.at, actor: ctx.actor, detail: d, revision: next.revision }]
  return { ok: true, next, skipped }
}

/** PURE. Enter `bloqueado` from any phase but publicado, storing the origin. */
export function planBlock(r: DeliveryRecord, reason: unknown, text: string, ctx: { at: string; actor: string; autonomous: boolean }): TransitionPlan {
  if (!isBlockReason(reason)) return refuse('bloqueio_invalido', `motivo de bloqueio fora da lista fechada: ${String(reason)}. Motivos: ${BLOCK_REASONS.filter(b => b !== 'decisao_do_dono').join(', ')}.`, ['motivo fechado'])
  if (r.phase === 'publicado') return refuse('bloqueio_invalido', 'uma entrega publicada não bloqueia', [])
  if (r.phase === 'bloqueado') return refuse('bloqueio_invalido', `já bloqueada (${r.block?.reason}); destrave antes`, [])
  if (!text.trim()) return refuse('faltando', 'um bloqueio precisa dizer o que está travando (texto)', ['texto do bloqueio'])
  const recorded = resolveBlockReason(reason, ctx.autonomous)
  const next: DeliveryRecord = structuredClone(r)
  next.origin = r.phase
  next.phase = 'bloqueado'
  next.revision = r.revision + 1
  next.updatedAt = ctx.at
  delete next.step
  delete next.adopted // a block the flow itself made is not the board's orphan any more
  next.block = {
    reason: recorded, text: text.trim(), since: ctx.at, unlocker: unlockerOf(recorded), wakes: 0,
    // Reason 6 with the owner away: the leader does NOT perform the action — the safe path is decided now.
    ...(recorded === 'fora_das_autorizacoes' ? { deferredAt: ctx.at } : {}),
  }
  if (recorded === 'fora_das_autorizacoes') next.versionTarget = 'next'
  next.history = [...r.history, { from: r.phase, to: 'bloqueado', at: ctx.at, actor: ctx.actor, detail: `${recorded}: ${text.trim()}`, revision: next.revision }]
  return { ok: true, next, skipped: null }
}

/**
 * PURE. Is this `adopted: 'board'` record still ONLY an adoption (BLOQUEIO.ORFAO)? It stops being one the moment it has history in a
 * real phase, evidence (head sha, gates, sessions, PR) or the machine's own marker was cleared: such a record is a delivery, and the
 * board going done/abandoned/missing must never delete it.
 */
export function isPureAdoption(r: DeliveryRecord): boolean {
  if (r.adopted !== 'board') return false
  if (r.headSha || r.branch || r.pr || r.mergeSha || r.authorSessionId || r.qaSessionId || r.qa || r.review || Object.keys(r.gates ?? {}).length > 0) return false
  const bookkeeping = (p: string) => p === 'fila' || p === 'bloqueado'
  return r.history.every(h => bookkeeping(h.from) && bookkeeping(h.to))
}

/** PURE. Leave `bloqueado` — ALWAYS to the stored origin, never anywhere else. */
export function planUnblock(r: DeliveryRecord, ctx: { at: string; actor: string; detail?: string; to?: unknown }): TransitionPlan {
  if (r.phase !== 'bloqueado' || !r.origin) return refuse('bloqueio_invalido', 'a entrega não está bloqueada', [])
  if (ctx.to !== undefined && ctx.to !== r.origin) return refuse('fase_pulada', `desbloquear volta para a fase de origem (${r.origin}), nunca para ${String(ctx.to)}`, [`${r.origin}`])
  const next: DeliveryRecord = structuredClone(r)
  next.phase = r.origin
  next.revision = r.revision + 1
  next.updatedAt = ctx.at
  delete next.origin
  delete next.block
  if (next.phase !== 'fila') delete next.adopted // unblocked into a real phase: no longer a pure adoption
  next.history = [...r.history, { from: 'bloqueado', to: r.origin, at: ctx.at, actor: ctx.actor, detail: ctx.detail?.trim() || 'desbloqueado', revision: next.revision }]
  return { ok: true, next, skipped: null }
}

/** The board status each phase is shown under. Live's `stageOfStatus` reads these ids/labels. */
export const PHASE_STATUS: Readonly<Record<Phase, { id: string; label: string; color: string }>> = {
  fila: { id: 'todo', label: 'To do', color: '#64748b' },
  executando: { id: 'in_progress', label: 'In progress', color: '#3b82f6' },
  qa: { id: 'qa', label: 'QA', color: '#a855f7' },
  ajuste: { id: 'ajuste', label: 'Ajuste', color: '#f59e0b' },
  revisao_lider: { id: 'in_review', label: 'In review', color: '#06b6d4' },
  pr_merge: { id: 'pr_merge', label: 'PR · merge', color: '#6366f1' },
  ci: { id: 'ci', label: 'CI · publicando', color: '#0ea5e9' },
  publicado: { id: 'done', label: 'Done', color: '#22c55e' },
  bloqueado: { id: 'blocked', label: 'Blocked', color: '#ef4444' },
}

// ------------------------------------------------------------------------------------------ watch

export const BLOCK_WAKE_EVERY_MS = 30 * 60_000
export const BLOCK_DEFER_AFTER_MS = 2 * 3600_000

export type WatchAction =
  | { kind: 'wake-leader'; subtaskId: string; reason: BlockReason; ageMs: number; text: string }
  | { kind: 'defer'; subtaskId: string; reason: BlockReason; ageMs: number }
  | { kind: 'unblock-dependency'; subtaskId: string }
  | { kind: 'convert-owner-block'; subtaskId: string }

/**
 * PURE. What the minute tick does for blocked deliveries. Wakes the LEADER every 30 min; past 2 h the
 * piece is DEFERRED to the next batch (recorded) and the 30-min wakes stop. A dependency whose blockers
 * all finished unblocks itself. With autonomous mode ON a `decisao_do_dono` block (made while it was OFF)
 * is converted to the leader's reason 6 — nothing ever waits on the owner while autonomous is ON.
 */
export function planWatch(records: readonly DeliveryRecord[], o: { nowMs: number; autonomous: boolean; dependencyDone: (r: DeliveryRecord) => boolean }): WatchAction[] {
  const out: WatchAction[] = []
  for (const r of records) {
    if (r.phase !== 'bloqueado' || !r.block) continue
    const b = r.block
    const age = o.nowMs - Date.parse(b.since)
    if (!Number.isFinite(age)) continue
    if (b.reason === 'dependencia' && o.dependencyDone(r)) { out.push({ kind: 'unblock-dependency', subtaskId: r.subtaskId }); continue }
    if (b.reason === 'decisao_do_dono' && o.autonomous) { out.push({ kind: 'convert-owner-block', subtaskId: r.subtaskId }); continue }
    if (b.deferredAt) continue
    if (age > BLOCK_DEFER_AFTER_MS && b.reason !== 'decisao_do_dono') { out.push({ kind: 'defer', subtaskId: r.subtaskId, reason: b.reason, ageMs: age }); continue }
    // A wake that was only ATTEMPTED counts for the cadence too: a dead leader is retried every 30 min, not every minute.
    const stamps = [b.lastWakeAt, b.lastWakeAttemptAt].map(s => Date.parse(s ?? '')).filter(Number.isFinite)
    const last = stamps.length > 0 ? Math.max(...stamps) : NaN
    if (b.reason !== 'dependencia' && (stamps.length === 0 || o.nowMs - last >= BLOCK_WAKE_EVERY_MS)) out.push({ kind: 'wake-leader', subtaskId: r.subtaskId, reason: b.reason, ageMs: age, text: b.text })
  }
  return out
}

/** PURE. The steps the Live's per-phase % reads (`liveCardModel.ts` STAGE_STEPS), by phase. */
export const PHASE_STEPS: Partial<Record<Phase, number>> = { executando: 5, qa: 4, ajuste: 4, revisao_lider: 3, pr_merge: 3 }

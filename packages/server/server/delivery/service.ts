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
import { releaseFailed, runGate, type BlockedSubtaskFact, type GateFacts, type GateVerdict, type SessionFact } from './gates'
import { DeliveryStoreUnreadable, type DeliveryStore } from './store'

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
  session(sessionId: string, text: string): Promise<boolean>
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
}

export type DeliveryReply =
  | { ok: true; status: 200; record: DeliveryRecord; warnings: string[]; skipped?: unknown; gate?: GateVerdict }
  | { ok: false; status: number; code: string; sentence: string; missing: string[]; record?: DeliveryRecord; gate?: GateVerdict }

const fail = (status: number, code: string, sentence: string, missing: string[] = [], record?: DeliveryRecord): DeliveryReply => ({ ok: false, status, code, sentence, missing, ...(record ? { record } : {}) })
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
const RELEASE_POLL_MIN_MS = 60_000
const RELEASE_POLL_MAX_MS = 10 * 60_000
const QUEUE_SLOT_REFRESH_MS = 5 * 60_000

const safe = <A extends unknown[]>(fn: (...a: A) => Promise<DeliveryReply>) => async (...a: A): Promise<DeliveryReply> => {
  try { return await fn(...a) } catch (e) { if (e instanceof DeliveryStoreUnreadable) return fail(503, 'store_ilegivel', e.message); throw e }
}

export function createDeliveryService(d: DeliveryDeps) {
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
    // Each transition fires the next step by itself.
    const t = `${before.phase}>${after.phase}`
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

  /** P4 — write the pre-dispatch (staged session) on the subtask and open its delivery at `fila`. */
  const stage = async (subtaskId: string, draft: Record<string, unknown>, actor: string, opts: { leaderSessionId?: string; versionTarget?: string; pedidoId?: string } = {}): Promise<DeliveryReply> => {
    const sub = await d.facts.subtask(subtaskId)
    if (!sub) return fail(404, 'no_such_subtask', `subtask ${subtaskId} does not exist on the board`)
    const merged = { ...(sub.staged ?? {}), ...draft }
    const written = await d.board.stage(subtaskId, merged)
    if (!written.ok) return fail(422, 'stage_refused', written.message ?? 'the board refused the staged session')
    const got = await ensure(subtaskId, { ...(opts.leaderSessionId ? { leaderSessionId: opts.leaderSessionId } : {}), ...(opts.versionTarget ? { versionTarget: opts.versionTarget } : {}) })
    if (isReply(got)) return got
    if (opts.leaderSessionId && !got.leaderSessionId) await d.store.update(doc => { doc.deliveries[subtaskId]!.leaderSessionId = opts.leaderSessionId })
    const v = await runGate('predispatch', got, d.facts)
    // A complete pre-dispatch also gets its EXPECTED SLOT read now, so "Na fila" shows a verdict instead of "not checked yet".
    const vaga = v.ok && got.phase === 'fila' ? await runGate('vaga', got, d.facts) : null
    const after = await d.store.update(doc => { const c = doc.deliveries[subtaskId]!; delete c.dequeued; absorb(c, 'predispatch', v); if (vaga) absorb(c, 'vaga', vaga); return structuredClone(c) })
    await d.board.setPhaseStatus(subtaskId, after.phase).catch(() => undefined)
    if (v.ok) await d.emit('subtarefa.preparada', { subtarefa: subtaskId, taskId: after.taskId, ...(opts.pedidoId ? { pedido: opts.pedidoId } : {}) }).catch(() => undefined)
    return { ok: true, status: 200, record: after, warnings: v.ok ? [] : [`pre-dispatch still incomplete: ${v.reason}`], gate: v }
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
    const spawned = await d.spawn(got, { ...(sub?.staged ?? {}) })
    if (!spawned.ok) return fail(422, 'spawn_failed', spawned.message)
    await d.store.update(doc => { doc.deliveries[subtaskId]!.authorSessionId = spawned.sessionId })
    return transition(subtaskId, 'executando', { detail: `sessão ${spawned.sessionId} aberta pelo pré-dispatch` }, actor)
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
      const status = await (d.facts.pieceStatus ? d.facts.pieceStatus(r.subtaskId) : d.facts.subtask(r.subtaskId).then(s => s?.status ?? null)).catch(() => undefined)
      if (status && ['in_review', 'done', 'abandoned'].includes(status)) {
        const out = await dequeue(r.subtaskId, `board status is ${status}; this piece is no longer queued`, 'flow:entrega')
        if (out.ok) actions.push(`dequeue ${r.subtaskId}`)
      }
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

  const tickOnce = async (): Promise<{ actions: string[] }> => {
    const actions: string[] = []
    await cleanQueue(actions)
    // ONE read of the fleet and ONE read of the board's blocked pieces per tick; null = could not be read (never "none").
    const sessions = await d.facts.sessions().catch(() => null)
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
    for (const r of records.filter(x => x.phase === 'ci')) {
      // Back off the gh polling: a piece that has sat in `ci` a while is polled less often (a tenth of its age, 1..10 min).
      const lastRun = r.gates.release && r.gates.release.revision === r.revision ? Date.parse(r.gates.release.at) : NaN
      const enteredCi = Date.parse(r.history.at(-1)?.at ?? r.updatedAt)
      const backoff = Math.min(RELEASE_POLL_MAX_MS, Math.max(RELEASE_POLL_MIN_MS, Number.isFinite(enteredCi) ? (d.now() - enteredCi) / 10 : 0))
      if (Number.isFinite(lastRun) && d.now() - lastRun < backoff) continue
      const v = await runGate('release', r, d.facts)
      if (v.ok) {
        // The verdict just obtained is handed to the transition (one gh poll per piece per tick, not two).
        const out = await transition(r.subtaskId, 'publicado', { detail: 'release.yml verde e tag publicada' }, 'flow:entrega', new Map([['release', v]]))
        actions.push(`publish ${r.subtaskId}:${out.ok}`)
      } else if (releaseFailed(v)) { const out = await transition(r.subtaskId, 'revisao_lider', { detail: v.reason ?? 'release falhou' }, 'flow:entrega'); actions.push(`release-failed ${r.subtaskId}:${out.ok}`) }
      else {
        const changed = v.patch?.ci && JSON.stringify(v.patch.ci) !== JSON.stringify(r.ci)
        await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c && c.phase === 'ci' && c.revision === r.revision) absorb(c, 'release', v) })
        if (changed) await d.board.setCi(r.subtaskId, v.patch!.ci!).catch(() => undefined)
      }
    }
    return { actions }
  }

  return {
    get: (id: string) => d.store.get(id),
    list: async () => Object.values((await d.store.read()).deliveries),
    ensure,
    // An unreadable store REFUSES the write (and keeps a copy of the file) instead of letting any verb replace it with an empty book.
    transition: safe((id: string, to: unknown, input: TransitionInput, actor: string) => transition(id, to, input, actor)),
    gate: safe(gate), block: safe(block), unblock: safe(unblock), approve: safe(approve), configure: safe(configure), step: safe(step),
    stage: safe(stage), stageRun: safe(stageRun), dequeue: safe(dequeue), qaOpen: safe(qaOpen), ajustesOpen: safe(ajustesOpen), merge: safe(merge), tick,
  }
}

export type DeliveryService = ReturnType<typeof createDeliveryService>

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
  EDGES, GATES, PHASE_STATUS, isGate, isPhase, newDelivery, planBlock, planTransition, planUnblock, planWatch,
  refusalStatus, type DeliveryCi, type DeliveryRecord, type GateName, type Phase, type TransitionInput, type TransitionRefusal,
} from './machine'
import { releaseFailed, runGate, type GateFacts, type GateVerdict } from './gates'
import type { DeliveryStore } from './store'

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

export function createDeliveryService(d: DeliveryDeps) {
  /** The record, created at `fila` on first use (a subtask that exists on the board). */
  const ensure = async (subtaskId: string, o: { versionTarget?: string; humanGates?: Phase[]; leaderSessionId?: string } = {}): Promise<DeliveryRecord | DeliveryReply> => {
    if (!SUB_ID.test(subtaskId)) return fail(400, 'bad_subtask', 'invalid subtask id')
    const have = await d.store.get(subtaskId)
    if (have) return have
    const sub = await d.facts.subtask(subtaskId)
    if (!sub) return fail(404, 'no_such_subtask', `subtask ${subtaskId} does not exist on the board`)
    return d.store.update(doc => {
      doc.deliveries[subtaskId] ??= newDelivery({ subtaskId, taskId: sub.taskId, at: iso(d), ...o })
      return doc.deliveries[subtaskId]!
    })
  }
  const isReply = (v: DeliveryRecord | DeliveryReply): v is DeliveryReply => 'status' in v && 'ok' in v

  /** Gate evidence onto a record (revision-stamped), plus the facts the gate established. */
  const absorb = (r: DeliveryRecord, name: GateName, v: GateVerdict) => {
    r.gates[name] = { ok: v.ok, at: iso(d), revision: r.revision, ...(v.evidence ? { evidence: v.evidence } : {}), ...(v.reason ? { reason: v.reason } : {}), ...(v.missing?.length ? { missing: v.missing } : {}) }
    if (v.patch) Object.assign(r, v.patch)
    r.updatedAt = iso(d)
  }

  const wake = async (r: DeliveryRecord, text: string, warnings: string[]) => {
    if (!r.leaderSessionId) { warnings.push('no leader recorded on this delivery — nobody was woken'); return }
    if (!(await d.notify.session(r.leaderSessionId, `[entrega ${r.subtaskId}] ${text}`).catch(() => false))) warnings.push(`the leader ${r.leaderSessionId} could not be woken`)
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

  const transition = async (subtaskId: string, to: unknown, input: TransitionInput, actor: string): Promise<DeliveryReply> => {
    const got = await ensure(subtaskId)
    if (isReply(got)) return got
    if (!isPhase(to)) return fail(400, 'fase_desconhecida', `unknown phase ${String(to)}`)
    const edge = EDGES[`${got.phase}>${to}`]
    // Gates are run fresh by the transition itself (outside the lock), so a caller never brings proof.
    const verdicts = new Map<GateName, GateVerdict>()
    if (edge) for (const g of edge.gates) verdicts.set(g, await runGate(g, got, d.facts))
    const autonomous = await d.autonomous(got.leaderSessionId).catch(() => true)
    const warnings: string[] = []
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
      if (out.plan.code === 'aguardando_dono' && !autonomous) await d.notify.owner(`Aprovação pedida: ${subtaskId} quer entrar em ${String(to)} (portão humano). Aprove ou reprove em Agentask.`, 'decisao').catch(() => undefined)
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
    const autonomous = await d.autonomous(got.leaderSessionId).catch(() => true)
    const out = await d.store.update(doc => {
      const cur = doc.deliveries[subtaskId]!
      const plan = planBlock(cur, reason, text, { at: iso(d), actor, autonomous })
      if (plan.ok) doc.deliveries[subtaskId] = plan.next
      return { plan, before: structuredClone(cur) }
    })
    if (!out.plan.ok) return refused(out.plan, out.before)
    const after = out.plan.next
    const warnings: string[] = []
    await effects(out.before, after, actor, warnings)
    const b = after.block!
    if (b.reason === 'decisao_do_dono') await d.notify.owner(`Precisa da sua decisão: ${subtaskId} — ${b.text}`, 'decisao').catch(() => undefined)
    else if (b.reason === 'fora_das_autorizacoes') await wake(after, `bloqueio fora das autorizações (${b.text}). Modo autônomo: NÃO faça a ação; a peça foi adiada para o próximo lote — escolha o caminho seguro e registre.`, warnings)
    else if (b.reason !== 'dependencia') await wake(after, `bloqueada (${b.reason}): ${b.text}. Quem destrava: o líder. Destrave com agentistics_task_phase action=unblock.`, warnings)
    await d.store.update(doc => { const c = doc.deliveries[subtaskId]; if (c?.block && b.reason !== 'dependencia') { c.block.lastWakeAt = iso(d); c.block.wakes = (c.block.wakes ?? 0) + 1 } })
    return { ok: true, status: 200, record: after, warnings }
  }

  const unblock = async (subtaskId: string, actor: string, detail?: string, to?: unknown): Promise<DeliveryReply> => {
    const got = await d.store.get(subtaskId)
    if (!got) return fail(404, 'no_delivery', `no delivery record for ${subtaskId}`)
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
    const after = await d.store.update(doc => {
      const cur = doc.deliveries[subtaskId]!
      if (typeof patch.versionTarget === 'string' && patch.versionTarget.trim()) cur.versionTarget = patch.versionTarget.trim()
      if (Array.isArray(patch.humanGates)) cur.humanGates = [...new Set(patch.humanGates.filter(isPhase).filter(p => p !== 'fila' && p !== 'bloqueado'))]
      if (typeof patch.leaderSessionId === 'string' && SUB_ID.test(patch.leaderSessionId)) cur.leaderSessionId = patch.leaderSessionId
      if (typeof patch.pr === 'number' && Number.isInteger(patch.pr) && patch.pr > 0) cur.pr = patch.pr
      if (typeof patch.tag === 'string' && /^v?\d[\w.-]*$/.test(patch.tag)) cur.tag = patch.tag
      if (typeof patch.qaSessionId === 'string' && SUB_ID.test(patch.qaSessionId)) cur.qaSessionId = patch.qaSessionId
      if (typeof patch.authorSessionId === 'string' && SUB_ID.test(patch.authorSessionId)) cur.authorSessionId = patch.authorSessionId
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
    const after = await d.store.update(doc => { const c = doc.deliveries[subtaskId]!; absorb(c, 'predispatch', v); return structuredClone(c) })
    await d.board.setPhaseStatus(subtaskId, after.phase).catch(() => undefined)
    if (v.ok) await d.emit('subtarefa.preparada', { subtarefa: subtaskId, taskId: after.taskId, ...(opts.pedidoId ? { pedido: opts.pedidoId } : {}) }).catch(() => undefined)
    return { ok: true, status: 200, record: after, warnings: v.ok ? [] : [`pre-dispatch still incomplete: ${v.reason}`], gate: v }
  }

  /** `agentop flow stage run`: gates (predispatch + vaga) → spawn the staged session → executando. */
  const stageRun = async (subtaskId: string, actor: string): Promise<DeliveryReply> => {
    const got = await ensure(subtaskId)
    if (isReply(got)) return got
    if (got.phase !== 'fila') return fail(422, 'fase_pulada', `stage run starts a delivery from fila; this one is in ${got.phase}`)
    if (!d.spawn) return fail(501, 'sem_spawn', 'this host cannot start sessions')
    for (const g of ['predispatch', 'vaga'] as const) {
      const v = await runGate(g, got, d.facts)
      if (!v.ok) { await d.store.update(doc => absorb(doc.deliveries[subtaskId]!, g, v)); return fail(422, 'portao', `${g}: ${v.reason}`, v.missing ?? []) }
    }
    const sub = await d.facts.subtask(subtaskId)
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

  /** The minute tick: blocked pieces, and CI → publicado on evidence. Idempotent. */
  const tick = async (): Promise<{ actions: string[] }> => {
    const doc = await d.store.read()
    const records = Object.values(doc.deliveries)
    const actions: string[] = []
    const autonomous = await d.autonomous().catch(() => true)
    const finished = new Map<string, boolean>()
    for (const r of records) {
      if (r.phase !== 'bloqueado' || r.block?.reason !== 'dependencia') continue
      const sub = await d.facts.subtask(r.subtaskId).catch(() => null)
      const blockers = sub?.blockedBy ?? []
      const all = await Promise.all(blockers.map(async id => doc.deliveries[id]?.phase === 'publicado' || await d.board.subtaskFinished(id).catch(() => false)))
      finished.set(r.subtaskId, blockers.length > 0 && all.every(Boolean))
    }
    for (const a of planWatch(records, { nowMs: d.now(), autonomous, dependencyDone: r => finished.get(r.subtaskId) === true })) {
      const r = doc.deliveries[a.subtaskId]!
      const warnings: string[] = []
      if (a.kind === 'unblock-dependency') { await unblock(a.subtaskId, 'flow:entrega', 'dependência concluída'); actions.push(`unblock ${a.subtaskId}`); continue }
      if (a.kind === 'convert-owner-block') {
        await d.store.update(x => { const c = x.deliveries[a.subtaskId]; if (c?.block) { c.block.reason = 'fora_das_autorizacoes'; c.block.unlocker = 'leader'; c.block.deferredAt = iso(d); c.versionTarget = 'next' } })
        await d.board.comment(r.taskId, r.subtaskId, '[fluxo entrega] modo autônomo ligado: a decisão pendente do dono passou ao líder — peça adiada para o próximo lote (caminho seguro).').catch(() => undefined)
        await wake(r, 'modo autônomo: a decisão que esperava o dono agora é sua — a peça foi adiada para o próximo lote; escolha o caminho seguro e registre.', warnings)
        actions.push(`convert ${a.subtaskId}`); continue
      }
      if (a.kind === 'defer') {
        await d.store.update(x => { const c = x.deliveries[a.subtaskId]; if (c?.block) { c.block.deferredAt = iso(d); c.versionTarget = 'next' } })
        await d.board.comment(r.taskId, r.subtaskId, `[fluxo entrega] bloqueio (${a.reason}) há mais de 2 h: peça ADIADA para o próximo lote. Registro do líder; o dono não foi chamado.`).catch(() => undefined)
        await d.emit('entrega.adiada', { subtarefa: a.subtaskId, motivo: a.reason }).catch(() => undefined)
        await wake(r, `bloqueio (${a.reason}) passou de 2 h: a peça foi adiada para o próximo lote. Registre a decisão e siga com a fila.`, warnings)
        actions.push(`defer ${a.subtaskId}`); continue
      }
      await wake(r, `continua bloqueada (${a.reason}, há ${Math.round(a.ageMs / 60_000)} min): ${a.text}. Destrave ou registre o caminho; > 2 h a peça é adiada.`, warnings)
      await d.store.update(x => { const c = x.deliveries[a.subtaskId]; if (c?.block) { c.block.lastWakeAt = iso(d); c.block.wakes = (c.block.wakes ?? 0) + 1 } })
      actions.push(`wake ${a.subtaskId}`)
    }
    for (const r of records.filter(x => x.phase === 'ci')) {
      const v = await runGate('release', r, d.facts)
      if (v.ok) { const out = await transition(r.subtaskId, 'publicado', { detail: 'release.yml verde e tag publicada' }, 'flow:entrega'); actions.push(`publish ${r.subtaskId}:${out.ok}`) }
      else if (releaseFailed(v)) { const out = await transition(r.subtaskId, 'revisao_lider', { detail: v.reason ?? 'release falhou' }, 'flow:entrega'); actions.push(`release-failed ${r.subtaskId}:${out.ok}`) }
      else if (v.patch?.ci && JSON.stringify(v.patch.ci) !== JSON.stringify(r.ci)) {
        await d.store.update(x => { const c = x.deliveries[r.subtaskId]; if (c && c.phase === 'ci') c.ci = v.patch!.ci })
        await d.board.setCi(r.subtaskId, v.patch.ci).catch(() => undefined)
      }
    }
    return { actions }
  }

  return {
    get: (id: string) => d.store.get(id),
    list: async () => Object.values((await d.store.read()).deliveries),
    ensure, transition, gate, block, unblock, approve, configure, step, stage, stageRun, qaOpen, ajustesOpen, merge, tick,
  }
}

export type DeliveryService = ReturnType<typeof createDeliveryService>

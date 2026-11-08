/**
 * delivery/web.ts — `/api/deliveries`: the HTTP door the MCP tools (`agentistics_task_phase`,
 * `agentistics_task_stage`), the CLI (`agentop flow gate|phase|…`) and the browser use. It only resolves
 * WHO asks — a verified managed session (the same proof `agentistics_session_message` sends) or, with no
 * session proof at all, the owner — and hands the typed request to the service. Every rule is the
 * service's/machine's: this file holds none.
 *
 *   GET  /api/deliveries                  every delivery record
 *   GET  /api/deliveries/<subtaskId>      one record (404 when the subtask has none yet)
 *   POST /api/deliveries/tick             the minute tick (also run by the engine's timer)
 *   POST /api/deliveries/<subtaskId>      { action: phase|gate|block|unblock|dequeue|queue-answer|approve|configure|step|stage|stage-run|merge, … }
 *   GET  /api/deliveries/queue[/<taskId>] the queue in leaving order (FILA.PRIORIDADE), every fact the Fila tab shows
 *   POST /api/deliveries/queue-next       run `fila-proximo` now (a worker ended)
 *   POST /api/deliveries/reconcile        { apply?: boolean } the one-shot backfill: pieces in revisao_lider/pr_merge/ci matched to
 *                                         their merged PR and first release tag (dry-run unless `apply`; applying: a leader or the owner)
 */
import type { DeliveryReply, DeliveryService } from './service'

export interface DeliveryWebDeps {
  service: DeliveryService
  /** Verifies a session proof; null = not a verified session. */
  verify(id: unknown, token: unknown): Promise<string | null>
}

export interface WebReply { status: number; body: unknown }

const out = (r: DeliveryReply): WebReply => (r.ok
  ? { status: 200, body: { ok: true, record: r.record, warnings: r.warnings, ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.gate ? { gate: r.gate } : {}) } }
  : { status: r.status, body: { ok: false, error: r.code, sentence: r.sentence, missing: r.missing, ...(r.record ? { record: r.record } : {}), ...(r.gate ? { gate: r.gate } : {}) } })

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export async function deliveryRequest(method: string, path: string, body: Record<string, unknown>, d: DeliveryWebDeps): Promise<WebReply> {
  const rest = path.replace(/^\/api\/deliveries\/?/, '')
  if (method === 'GET' && rest === '') return { status: 200, body: { deliveries: await d.service.list(), questions: await d.service.questions() } }
  // FILA.PRIORIDADE — the queue in leaving order (`/queue` = every task, `/queue/<taskId>` = one task's), the Fila tab's and the MCP's one source.
  if (method === 'GET' && (rest === 'queue' || rest.startsWith('queue/'))) {
    const task = rest === 'queue' ? '' : decodeURIComponent(rest.slice('queue/'.length))
    return { status: 200, body: await d.service.queueView(task || undefined) }
  }
  if (method === 'GET') {
    const rec = await d.service.get(decodeURIComponent(rest))
    // `tickReason`: why the minute tick has not moved the piece (merge not found, a gate refused, the tag not out yet).
    return rec ? { status: 200, body: { record: rec, ...(rec.tickNote && rec.tickNote.phase === rec.phase && rec.tickNote.revision === rec.revision ? { tickReason: rec.tickNote.reason, tickReasonAt: rec.tickNote.at } : {}) } } : { status: 404, body: { error: 'no_delivery', sentence: `no delivery record for ${rest} yet` } }
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method' } }
  // Who asks. A body naming a session must PROVE it; no session at all is the owner (the board's own rule).
  const proof = body.session as { id?: unknown; token?: unknown } | undefined
  const session = proof ? await d.verify(proof.id, proof.token) : null
  if (proof && !session) return { status: 403, body: { error: 'unverified_sender', sentence: 'the session identity could not be verified' } }
  const actor = session ?? 'owner'
  if (rest === 'tick') return { status: 200, body: await d.service.tick() }
  if (rest === 'queue-next') return { status: 200, body: await d.service.queueNext() }
  if (rest === 'reconcile') {
    const r = await d.service.reconcile({ apply: body.apply }, actor)
    return r.ok
      ? { status: 200, body: { ok: true, apply: r.apply, moved: r.moved, unproven: r.unproven, entries: r.entries } }
      : { status: r.status, body: { ok: false, error: r.code, sentence: r.sentence, missing: r.missing } }
  }
  if (rest === 'release') {
    const r = await d.service.release({ version: body.version, mergeSha: body.mergeSha, repo: body.repo, subtaskIds: body.subtaskIds }, actor)
    return r.ok
      ? { status: 200, body: { ok: true, version: r.version, tag: r.tag, mergeSha: r.mergeSha, ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}), pieces: r.pieces, warnings: r.warnings } }
      : { status: r.status, body: { ok: false, error: r.code, sentence: r.sentence, missing: r.missing, ...(r.record ? { record: r.record } : {}) } }
  }
  let subtaskId: string
  try { subtaskId = decodeURIComponent(rest) } catch { return { status: 400, body: { error: 'bad_subtask' } } }
  if (subtaskId.includes('/')) return { status: 404, body: { error: 'not_found' } }
  const input = {
    ...(str(body.detail) ? { detail: str(body.detail) } : {}),
    ...(body.verdict === 'APROVADO' || body.verdict === 'REPROVADO' ? { verdict: body.verdict as 'APROVADO' | 'REPROVADO' } : {}),
    ...(str(body.findings) ? { findings: str(body.findings) } : {}),
    ...(str(body.reviewedSha) ? { reviewedSha: str(body.reviewedSha) } : {}),
    ...(str(body.mergeSha) ? { mergeSha: str(body.mergeSha) } : {}),
  }
  switch (body.action) {
    case 'phase': return out(await d.service.transition(subtaskId, body.to, input, actor))
    case 'gate': return out(await d.service.gate(subtaskId, body.name, actor))
    case 'block': return out(await d.service.block(subtaskId, body.reason, String(body.text ?? body.detail ?? ''), actor))
    case 'unblock': return out(await d.service.unblock(subtaskId, actor, str(body.detail), body.to))
    case 'dequeue': return out(await d.service.dequeue(subtaskId, body.reason, actor))
    // The leader's (or owner's) answer to the queue's question, or the tab's "iniciar agora" (`sim`) / "agendar".
    case 'queue-answer': return out(await d.service.answerQueue(subtaskId, body.answer ?? { decision: body.decision, reason: body.reason, at: body.at }, actor))
    case 'approve': return out(await d.service.approve(subtaskId, body.phase, body.decision, str(body.note), session === null))
    case 'configure': return out(await d.service.configure(subtaskId, (body.patch ?? {}) as Record<string, unknown>, actor))
    case 'step': {
      // A piece the flow never adopted has no record to hold the step: only the board's `step` event is written.
      if (await d.service.get(subtaskId)) return out(await d.service.step(subtaskId, body.step, actor))
      const r = await d.service.stepEvent(subtaskId, body.step, actor)
      return r.ok
        ? { status: 200, body: { ok: true, step: r.step, recorded: r.recorded } }
        : { status: r.status, body: { ok: false, error: r.code, sentence: r.sentence, missing: r.missing } }
    }
    case 'stage': {
      const draft = (body.draft ?? {}) as Record<string, unknown>
      return out(await d.service.stage(subtaskId, draft, actor, {
        ...(session ? { leaderSessionId: str(body.leaderSessionId) ?? session } : str(body.leaderSessionId) ? { leaderSessionId: str(body.leaderSessionId)! } : {}),
        ...(str(body.versionTarget) ? { versionTarget: str(body.versionTarget)! } : {}),
        ...(str(body.pedidoId) ? { pedidoId: str(body.pedidoId)! } : {}),
      }))
    }
    case 'stage-run': return out(await d.service.stageRun(subtaskId, actor))
    case 'merge': return out(await d.service.merge(subtaskId, actor))
    default: return { status: 400, body: { error: 'bad_action', sentence: 'action must be one of phase, gate, block, unblock, dequeue, queue-answer, approve, configure, step, stage, stage-run, merge' } }
  }
}

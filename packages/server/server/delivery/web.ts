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
import { actorOf, ownerMove, ownerRefusal, resolveRestPrincipal, type OwnerProofMode, type OwnerScope, type RequestPrincipal } from './principal'

/** What the HTTP adapter (`index.ts`) observed about the browser. Absent = not a browser (a plain `curl`, a test). */
export interface BrowserFacts {
  /** Loopback socket peer and loopback Host (vault `loopbackRequest`). */
  loopbackPeer: boolean
  /** `Origin` is this server's own web origin. */
  originOwn: boolean
  /** `Sec-Fetch-Site: same-origin`. */
  sameOriginFetch: boolean
  /** The `X-Agentop-Owner-Grant` header, verbatim. Never logged. */
  grantHeader?: string | null
}

export type GrantUse = { ok: true; grantId: string } | { ok: false; code: string }

export interface DeliveryWebDeps {
  service: DeliveryService
  /** Verifies a session proof; null = not a verified session. */
  verify(id: unknown, token: unknown): Promise<string | null>
  /** `delivery.ownerProof`. Absent = `legacy`. */
  mode?: () => Promise<OwnerProofMode>
  browser?: BrowserFacts
  /** Spends a single-use `delivery` grant for exactly this scope (vault `consumeDeliveryGrant`). */
  consumeGrant?: (token: string, scope: OwnerScope) => GrantUse
}

export interface WebReply { status: number; body: unknown }

/** What `resolveRequestPrincipal` needs — the REST facts of `DeliveryWebDeps` without the service. */
export type PrincipalDeps = Pick<DeliveryWebDeps, 'verify' | 'mode' | 'browser' | 'consumeGrant'>

/**
 * §2.3 REST resolution, shared by `/api/deliveries` and (S0d.6) the owner-role comments: a body naming a session must
 * PROVE it; a single-use grant is spent only for a request with no session proof and only for exactly `scope`; then the
 * pure `resolveRestPrincipal`. A grant that does not spend is a 403 (`grant_invalid`, `grant_scope` …).
 */
export async function resolveRequestPrincipal(
  body: Record<string, unknown>, scope: OwnerScope, d: PrincipalDeps,
): Promise<{ ok: true; principal: RequestPrincipal; mode: OwnerProofMode } | { ok: false; reply: WebReply }> {
  const proof = body.session as { id?: unknown; token?: unknown } | undefined
  const session = proof ? await d.verify(proof.id, proof.token) : null
  const mode = d.mode ? await d.mode() : 'legacy'
  let grant: { id: string } | null = null
  const grantHeader = d.browser?.grantHeader
  if (grantHeader && !proof) {
    const used = d.consumeGrant ? d.consumeGrant(grantHeader, scope) : { ok: false as const, code: 'grant-invalid' }
    if (!used.ok) return { ok: false, reply: { status: 403, body: { ok: false, error: used.code.replace(/-/g, '_'), sentence: 'the owner proof was not accepted for this move — confirm it again' } } }
    grant = { id: used.grantId }
  }
  const resolved = resolveRestPrincipal({
    mode, grant, sessionClaimed: Boolean(proof), sessionVerified: session, actor: body.actor,
    loopbackPeer: d.browser?.loopbackPeer ?? false, originOwn: d.browser?.originOwn ?? false, sameOriginFetch: d.browser?.sameOriginFetch ?? false,
  })
  if (!resolved.ok) return { ok: false, reply: { status: resolved.status, body: { error: resolved.code, sentence: resolved.sentence } } }
  return { ok: true, principal: resolved.principal, mode }
}

/**
 * S0d.6 (QA F6) — a comment that SPEAKS AS THE OWNER (`role: owner`: created with `owner: true`, or an existing owner
 * comment being edited / removed) needs the owner principal, exactly like an owner-only delivery move. Leaders and
 * agents read the board and act on "Aprovado pelo dono"; a worker could write one with no proof. `null` = allowed.
 * Scope: `{ pieceKey: <task ref | comment id>, move: comment:create | comment:edit | comment:remove }`.
 */
export async function ownerCommentGate(
  body: Record<string, unknown>, scope: OwnerScope, d: PrincipalDeps,
): Promise<WebReply | null> {
  const who = await resolveRequestPrincipal(body, scope, d)
  if (!who.ok) return who.reply
  const denied = ownerRefusal(who.principal, who.mode)
  return denied ? { status: denied.status, body: { ok: false, error: denied.code, sentence: denied.sentence } } : null
}

const out = (r: DeliveryReply): WebReply => (r.ok
  ? { status: 200, body: { ok: true, record: r.record, warnings: r.warnings, ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.gate ? { gate: r.gate } : {}), ...(r.classification ? { classification: r.classification } : {}) } }
  : { status: r.status, body: { ok: false, error: r.code, sentence: r.sentence, missing: r.missing, ...(r.record ? { record: r.record } : {}), ...(r.gate ? { gate: r.gate } : {})} })

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export async function deliveryRequest(method: string, path: string, body: Record<string, unknown>, d: DeliveryWebDeps, signal?: AbortSignal): Promise<WebReply> {
  const rest = path.replace(/^\/api\/deliveries\/?/, '')
  if (method === 'GET' && rest === '') return { status: 200, body: { deliveries: await d.service.list() } }
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
  // ENTREGA.GARANTIDA §2.3 — WHO asks is what the caller PROVED. "No proof" is `unattributed`, never the owner.
  const piece = rest === '' ? '*' : rest
  const scope: OwnerScope = { pieceKey: piece, move: ownerMove(body.action ?? rest, body.phase ?? body.to) }
  const who = await resolveRequestPrincipal(body, scope, d)
  if (!who.ok) return who.reply
  const { principal, mode } = who
  /** The verified session id (a proven session is always the `session` principal, §2.3). */
  const session = principal.kind === 'session' ? principal.id : null
  const actor = actorOf(principal)
  if (rest === 'tick') return { status: 200, body: await d.service.tick() }
  if (rest === 'queue-next') return { status: 200, body: await d.service.queueNext() }
  if (rest === 'reconcile') {
    const r = await d.service.reconcile({ apply: body.apply }, actor)
    return r.ok
      ? { status: 200, body: { ok: true, apply: r.apply, moved: r.moved, unproven: r.unproven, summary: r.summary, gh: r.gh, ...(r.stopped ? { stopped: r.stopped } : {}), entries: r.entries } }
      : { status: r.status, body: { ok: false, error: r.code, sentence: r.sentence, missing: r.missing } }
  }
  if (rest === 'antigas') {
    // The "Antigas sem registro" group: { action: 'publish'|'archive', ids?: string[], all?: boolean, expect?: number, version?, reason? }.
    // `signal` is the request's: a client that gave up stops the work, it does not finish behind a screen that said it failed.
    const r = await d.service.antigas({ action: body.action, preview: body.preview, ids: body.ids, all: body.all, expect: body.expect, version: body.version, reason: body.reason }, actor, signal)
    return r.ok
      ? { status: 200, body: { ok: true, action: r.action, done: r.done, ...(r.preview ? { preview: r.preview } : {}), ...(r.stopped ? { stopped: true } : {}) } }
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
    case 'approve': {
      // Approving a human gate is an OWNER move (§2.3.2): a fresh vault proof, or — legacy only — the browser shape.
      const denied = ownerRefusal(principal, mode)
      if (denied) return { status: denied.status, body: { ok: false, error: denied.code, sentence: denied.sentence } }
      return out(await d.service.approve(subtaskId, body.phase, body.decision, str(body.note), true))
    }
    // S1b: the leader names WHERE to look (`repo`, `head`); the server derives the category. A body `category` is never read.
    case 'classify': return out(await d.service.classify(subtaskId, { repo: body.repo, head: body.head }, actor))
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

/**
 * delivery/evidence-web.ts — `POST/GET/DELETE /api/tasks/<ref>/evidence` (spec §3.4). A thin adapter over the delivery service:
 * who asks (a session that PROVES it, else the owner), which piece (`subtaskId`, default the task-level piece), and the status
 * code of each refusal. The MCP tool and the CLI reach the same service; no door has rules of its own.
 */
import type { DeliveryService } from './service'
import { actorOf, ownerMove } from './principal'
import { resolveRequestPrincipal, type PrincipalDeps } from './web'
import { DeliveryStoreUnreadable } from './store'
import { GuardBusy } from './guard-locks'

/**
 * Integration S0d+S1c (F5): WHO asks is resolved exactly like `/api/deliveries` (`resolveRequestPrincipal`: a proven session,
 * a single-use owner grant, the legacy browser shape) — "no proof at all" is `unattributed`, never the owner.
 */
export interface EvidenceWebDeps extends PrincipalDeps {
  service: DeliveryService
}
export interface EvidenceWebReply { status: number; body: Record<string, unknown> }

const STORE_UNREADABLE = 'the delivery book cannot be read; nothing was written and its bytes were kept'
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** R1: an unreadable book (or a busy guard) is a structured refusal — never an uncaught throw that leaks paths and source. */
export async function evidenceRequest(method: string, taskRef: string, query: Record<string, unknown>, body: Record<string, unknown>, d: EvidenceWebDeps): Promise<EvidenceWebReply> {
  try { return await evidenceRequestInner(method, taskRef, query, body, d) } catch (e) {
    if (e instanceof DeliveryStoreUnreadable) return { status: 503, body: { ok: false, error: 'store_ilegivel', sentence: STORE_UNREADABLE, missing: [] } }
    if (e instanceof GuardBusy) return { status: e.status, body: { ok: false, error: e.code, sentence: e.message, missing: [] } }
    throw e
  }
}

async function evidenceRequestInner(method: string, taskRef: string, query: Record<string, unknown>, body: Record<string, unknown>, d: EvidenceWebDeps): Promise<EvidenceWebReply> {
  if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') return { status: 405, body: { error: 'method' } }
  const piece = str(body.subtaskId) ?? str(query.subtaskId) ?? taskRef
  let actor = 'unattributed'
  if (method !== 'GET') {
    const who = await resolveRequestPrincipal(body, { pieceKey: piece, move: ownerMove('evidence', method === 'POST' ? 'add' : 'remove') }, d)
    if (!who.ok) return { status: who.reply.status, body: who.reply.body as Record<string, unknown> }
    actor = actorOf(who.principal)
  }
  // An unreadable book's sentence carries the file's path; the client gets the code and a plain sentence (R1).
  const fail = (r: { status: number; code: string; sentence: string; missing: string[] }): EvidenceWebReply => ({ status: r.status, body: { ok: false, error: r.code, sentence: r.code === 'store_ilegivel' ? STORE_UNREADABLE : r.sentence, missing: r.missing } })

  // The piece must belong to the task in the URL: the route names a task, the body a subtask of it. Checked BEFORE a write,
  // so evidence for another task's piece is never stored. (A POST creates the piece's record at its board phase, as every door does.)
  const wrongTask = (taskId: string): EvidenceWebReply => ({ status: 422, body: { ok: false, error: 'wrong_task', sentence: `piece ${piece} belongs to task ${taskId}, not ${taskRef}`, missing: [] } })
  const rec = method === 'POST' ? await d.service.ensure(piece) : await d.service.get(piece)
  if (rec && 'ok' in rec && !rec.ok) return fail(rec)
  if (rec && 'taskId' in rec && rec.taskId !== taskRef) return wrongTask(rec.taskId)

  if (method === 'GET') {
    const r = await d.service.evidenceList(piece)
    if (!r.ok) return fail(r)
    return { status: 200, body: { ok: true, evidence: r.evidence, binding: r.binding } }
  }
  if (method === 'DELETE') {
    const id = str(body.evidenceId) ?? str(query.evidenceId)
    if (!id) return { status: 400, body: { ok: false, error: 'evidence_id_required', sentence: 'evidenceId is required', missing: [] } }
    const r = await d.service.evidenceRemove(piece, id, actor)
    return r.ok ? { status: 200, body: { ok: true } } : fail(r)
  }
  const r = await d.service.evidenceAdd(piece, body, actor)
  if (!r.ok) return fail(r)
  return { status: 200, body: { ok: true, evidence: r.evidence, ...(r.warnings.length ? { warnings: r.warnings } : {}) } }
}

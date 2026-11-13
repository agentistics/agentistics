/**
 * delivery/evidence-web.ts — `POST/GET/DELETE /api/tasks/<ref>/evidence` (spec §3.4). A thin adapter over the delivery service:
 * who asks (a session that PROVES it, else the owner), which piece (`subtaskId`, default the task-level piece), and the status
 * code of each refusal. The MCP tool and the CLI reach the same service; no door has rules of its own.
 */
import type { DeliveryService } from './service'

export interface EvidenceWebDeps {
  service: DeliveryService
  /** A claimed session identity → its id when the proof checks out, else null. */
  verify(id: unknown, token: unknown): Promise<string | null>
}
export interface EvidenceWebReply { status: number; body: Record<string, unknown> }

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export async function evidenceRequest(method: string, taskRef: string, query: Record<string, unknown>, body: Record<string, unknown>, d: EvidenceWebDeps): Promise<EvidenceWebReply> {
  if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') return { status: 405, body: { error: 'method' } }
  const proof = body.session as { id?: unknown; token?: unknown } | undefined
  const session = proof ? await d.verify(proof.id, proof.token) : null
  if (proof && !session) return { status: 403, body: { error: 'unverified_sender', sentence: 'the session identity could not be verified' } }
  const actor = session ?? 'owner'
  const piece = str(body.subtaskId) ?? str(query.subtaskId) ?? taskRef
  const fail = (r: { status: number; code: string; sentence: string; missing: string[] }): EvidenceWebReply => ({ status: r.status, body: { ok: false, error: r.code, sentence: r.sentence, missing: r.missing } })

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

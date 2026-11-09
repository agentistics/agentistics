/**
 * delivery/host-ops.ts — the host operations the ENGINE's delivery flows call (`engine/src/flows/entrega.ts`).
 * Each one is a thin call into the same service every other door uses; a refusal comes back as
 * `{ refused, reason, missing }`, which the engine turns into the flow's own refusal.
 */
import type { DeliveryReply } from './service'
import { defaultGateFacts, judgePredispatch, type GateFacts } from './gates'

const refuse = (reason: string, missing: string[] = []) => ({ refused: true, reason, missing })
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '')
const answer = (r: DeliveryReply) => (r.ok ? { ok: true, phase: r.record.phase, revision: r.record.revision, ...(r.skipped ? { skipped: r.skipped } : {}) } : refuse(r.sentence, r.missing))

export function deliveryHostOps(svc: () => Promise<import('./service').DeliveryService> = async () => (await import('./host')).deliveryService(), gateFacts: () => GateFacts = defaultGateFacts) {
  return {
    /** The minute tick: blocked pieces (wake / defer / dependency) and CI → publicado on evidence. */
    'entrega-vigia': async () => ({ ok: true, ...(await (await svc()).tick()) }),
    'entrega-avancar': async (v: unknown) => {
      const i = rec(v), sub = str(i.subtarefa), to = str(i.para)
      if (!sub || !to) return refuse('subtarefa and para are required', ['subtarefa', 'para'])
      const input = {
        ...(str(i.detalhe) ? { detail: str(i.detalhe) } : {}),
        ...(i.veredito === 'APROVADO' || i.veredito === 'REPROVADO' ? { verdict: i.veredito as 'APROVADO' | 'REPROVADO' } : {}),
        ...(str(i.achados) ? { findings: str(i.achados) } : {}),
        ...(str(i.shaRevisado) ? { reviewedSha: str(i.shaRevisado) } : {}),
        ...(str(i.shaMerge) ? { mergeSha: str(i.shaMerge) } : {}),
      }
      return answer(await (await svc()).transition(sub, to, input, str(i.ator) || 'flow:entrega'))
    },
    'entrega-portao': async (v: unknown) => {
      const i = rec(v), sub = str(i.subtarefa)
      if (!sub) return refuse('subtarefa is required', ['subtarefa'])
      return answer(await (await svc()).gate(sub, str(i.portao), str(i.ator) || 'flow:entrega'))
    },
    'entrega-bloquear': async (v: unknown) => {
      const i = rec(v), sub = str(i.subtarefa)
      if (!sub) return refuse('subtarefa is required', ['subtarefa'])
      return answer(await (await svc()).block(sub, str(i.motivo), str(i.texto), str(i.ator) || 'flow:entrega'))
    },
    'entrega-desbloquear': async (v: unknown) => {
      const i = rec(v), sub = str(i.subtarefa)
      if (!sub) return refuse('subtarefa is required', ['subtarefa'])
      return answer(await (await svc()).unblock(sub, str(i.ator) || 'flow:entrega', str(i.detalhe) || undefined))
    },
    /** Autonomous mode now — what every human step of every flow consults before it asks the owner anything. */
    'modo-autonomo': async () => ({ ok: true, autonomous: await (await import('./host')).deliveryAutonomous().catch(() => true) }),
    /** P4: which of these subtasks have a COMPLETE pre-dispatch (the demand flow reminds the leader about the rest). */
    'predispatch-completo': async (v: unknown) => {
      const ids = Array.isArray(rec(v).subtaskIds) ? (rec(v).subtaskIds as unknown[]).filter((x): x is string => typeof x === 'string') : []
      const facts = gateFacts()
      const verdicts = await Promise.all(ids.map(async id => {
        let sub = await facts.subtask(id).catch(() => null)
        if (sub && ['in_review', 'done', 'abandoned'].includes(sub.status)) return { id, ok: true }
        if (sub?.parentGroupId) {
          const group = await facts.subtask(sub.parentGroupId).catch(() => null)
          sub = group?.taskId === sub.taskId ? group : null
        }
        return { id, ok: !!sub && (['in_review', 'done', 'abandoned'].includes(sub.status) || judgePredispatch(sub).ok) }
      }))
      return { ok: true, complete: verdicts.filter(x => x.ok).map(x => x.id), incomplete: verdicts.filter(x => !x.ok).map(x => x.id) }
    },
  }
}

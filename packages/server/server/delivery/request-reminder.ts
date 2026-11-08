/**
 * request-reminder.ts — FLUXO.AVISOS: the text of the "owner requests without a complete pre-dispatch" reminder.
 *
 * PURE. It used to quote the WHOLE owner message («…» with attachment paths, pasted logs and all), so one nudge could
 * fill a leader's screen (owner print 5166c2de). It now carries the pedido id and the first ~80 characters; the leader
 * already holds the full text in the PEDIDOS ABERTOS DO DONO section of its briefing and in the engine's pedido.
 */
import { nudgeExcerpt } from '../flows/owner-intent'

export const REQUEST_EXCERPT_CHARS = 80

export function requestReminderText(pedidos: ReadonlyArray<{ id: string; text: string }>): string {
  const list = pedidos.map(p => `- ${p.id}: «${nudgeExcerpt(p.text, REQUEST_EXCERPT_CHARS)}»`).join('\n')
  return `[entrega pedidos] Pedidos do dono sem pré-dispatch completo há pelo menos 10 min:\n${list}\n` +
    'PRIMEIRO responda ao dono na conversa; só depois registre, encaixe ou encerre. Pergunta ou reclamação: só responda. ' +
    'Trabalho: encaixe a subtarefa e prepare com agentistics_task_stage (prompt, harness, model, pedidoId; effort/account só se o harness usa). ' +
    'Texto completo em PEDIDOS ABERTOS DO DONO.'
}

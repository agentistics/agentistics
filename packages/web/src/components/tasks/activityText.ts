import { priorityLabel } from './board'
import { statusLabel, type Lang } from './copy'

/** The event shape this sentence reads — a subset of `TaskEvent`, kept local so the helper stays pure. */
export interface ActivityEventLike { kind: string; detail?: string; from?: string; to?: string }

/**
 * The sentence an Activity row says after the actor's name. Data (a harness id, a priority id, a
 * status id the board does not know) is printed as it is; only the words around it are translated.
 * en keeps the exact historical wording.
 */
export function activitySentence(e: ActivityEventLike, lang: Lang): string {
  const pt = lang === 'pt'
  const st = (id?: string) => (id === undefined ? '?' : pt ? statusLabel(id, 'pt') : id)
  const pr = (id?: string) => (id === undefined ? '?' : pt ? priorityLabel(id, 'pt') : id)
  switch (e.kind) {
    case 'status': return pt ? `moveu ${st(e.from)} → ${st(e.to)}` : `moved ${e.from ?? '?'} → ${e.to ?? '?'}`
    case 'claim': return e.detail === 'takeover' ? (pt ? 'assumiu a reserva' : 'took over') : (pt ? 'reservou' : 'claimed it')
    case 'release': return pt ? 'liberou a reserva' : 'released it'
    case 'priority': return pt ? `mudou a prioridade ${pr(e.from)} → ${pr(e.to)}` : `set priority ${e.from ?? '?'} → ${e.to ?? '?'}`
    case 'assign': return pt ? `definiu o responsável como ${e.to || 'ninguém'}` : `set the owner to ${e.to || 'nobody'}`
    case 'session': return pt ? `vinculou uma sessão ${e.detail ?? ''}`.trim() : `filed a ${e.detail ?? ''} session`.trim()
    case 'move': return pt ? 'reordenou' : 'reordered it'
    case 'comment': return pt ? 'comentou' : 'comment'
    case 'step': return pt ? `avançou para o passo ${e.to ?? '?'}` : `moved to step ${e.to ?? '?'}`
    case 'type': return pt ? 'mudou o tipo' : 'changed the type'
    case 'repo': return pt ? `mudou o repositório ${e.from || '—'} → ${e.to || '—'}` : `set repository ${e.from || '—'} → ${e.to || '—'}`
    case 'create': return pt ? 'criou a tarefa' : 'created the task'
    // Never a raw kind in pt: a kind this board has no words for still gets a sentence.
    default: return pt ? 'atualizou a tarefa' : e.kind
  }
}

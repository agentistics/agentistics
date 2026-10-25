import type { TaskEvent } from '../lib/tasks'
import { HARNESS_LABELS } from '../lib/harness'

type Lang = 'pt' | 'en'
type Status = { id: string; label: string }
const builtinStatuses: Record<string, [string, string]> = {
  backlog: ['Fila', 'Backlog'], todo: ['A fazer', 'To do'],
  in_progress: ['Em andamento', 'In progress'], in_review: ['Em revisão', 'In review'],
  blocked: ['Bloqueada', 'Blocked'], done: ['Concluída', 'Done'], abandoned: ['Abandonada', 'Abandoned'],
}
const internalId = /\b(?:[tsec]-[a-z0-9]{6,}|[a-f0-9]{8,}(?:-[a-f0-9-]+)?)\b/i

/** Actors are free text in old logs: retain names, never expose machine identifiers. */
export function activityActor(actor: string, lang: Lang): string {
  const pt = lang === 'pt'
  const value = actor.trim()
  if (['you', 'owner', 'person'].includes(value)) return pt ? 'Você' : 'You'
  if (value === 'assistant') return pt ? 'Assistente' : 'Assistant'
  const harness = Object.keys(HARNESS_LABELS).find(h => value === h || value.startsWith(`${h}:`))
  if (harness) return HARNESS_LABELS[harness as keyof typeof HARNESS_LABELS]
  if (!value || value.startsWith('session:') || internalId.test(value) || /^[{\[]/.test(value)) return pt ? 'Sessão' : 'Session'
  return value
}

/** Interpret known event shapes. Unknown events get a sentence, never a raw payload fallback. */
export function activitySentence(event: TaskEvent, lang: Lang, statuses: readonly Status[] = []): string {
  const pt = lang === 'pt'
  if (event.kind === 'comment') {
    try {
      const message = JSON.parse(event.detail ?? '').message
      if (message?.kind === 'handback') return pt ? 'Enviou trabalho para revisão.' : 'Sent work for review.'
      if (message?.kind === 'block') return pt ? 'Comunicou um bloqueio.' : 'Reported a blocker.'
      if (message?.kind === 'question') return pt ? 'Enviou uma pergunta.' : 'Sent a question.'
    } catch { /* Older comments store a target phrase instead of message metadata. */ }
    const target = event.detail?.match(/^on (subtask|group) "(.+)"$/)
    if (target && !internalId.test(target[2]!)) return pt
      ? `Comentou ${target[1] === 'group' ? 'no grupo' : 'na subtarefa'} “${target[2]}”.`
      : `Commented on ${target[1]} “${target[2]}”.`
    return pt ? 'Adicionou um comentário.' : 'Added a comment.'
  }
  if (event.kind === 'status') {
    const built = builtinStatuses[event.to ?? '']
    const label = built?.[pt ? 0 : 1] ?? statuses.find(s => s.id === event.to)?.label
    return label && !internalId.test(label)
      ? (pt ? `Moveu a tarefa para “${label}”.` : `Moved the task to “${label}”.`)
      : (pt ? 'Alterou o status da tarefa.' : 'Changed the task status.')
  }
  if (event.kind === 'session') return event.to
    ? (pt ? 'Vinculou uma sessão à tarefa.' : 'Linked a session to the task.')
    : (pt ? 'Desvinculou uma sessão da tarefa.' : 'Unlinked a session from the task.')
  const sentences: Record<string, [string, string]> = {
    create: ['Criou a tarefa.', 'Created the task.'],
    claim: ['Assumiu a tarefa.', 'Claimed the task.'], release: ['Devolveu a tarefa à fila.', 'Released the task.'],
    assign: ['Alterou o responsável pela tarefa.', 'Changed the task assignee.'],
    priority: ['Alterou a prioridade da tarefa.', 'Changed the task priority.'],
    type: ['Alterou o tipo da tarefa.', 'Changed the task type.'],
    shared: ['Alterou o compartilhamento da tarefa.', 'Changed task sharing.'],
    move: ['Reordenou a tarefa no quadro.', 'Reordered the task on the board.'],
    checkin: ['Registrou uma rodada de acompanhamento.', 'Recorded a check-in round.'],
    subtask: ['Atualizou uma subtarefa.', 'Updated a subtask.'],
    edit: ['Atualizou a tarefa.', 'Updated the task.'],
    file: ['Atualizou os anexos da tarefa.', 'Updated task attachments.'],
    link: ['Atualizou os links da tarefa.', 'Updated task links.'],
  }
  return sentences[event.kind]?.[pt ? 0 : 1] ?? (pt ? 'Atualizou a tarefa.' : 'Updated the task.')
}

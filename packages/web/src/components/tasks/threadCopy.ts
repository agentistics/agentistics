/**
 * threadCopy.ts — the words of the task page's cockpit hero and its THREADS (PT/EN).
 *
 * Its own file rather than `copy.ts` so the board's vocabulary and the conversation's can change
 * without touching each other. Delivery reasons are localized HERE, at render time, from the codes
 * the server records (`DeliveryReason`) — the server stores no sentence.
 */
import type { DeliveryReason, DeliveryState } from '@agentistics/core'

export type Lang = 'pt' | 'en'

export function threadCopy(lang: Lang) {
  const pt = lang === 'pt'
  return {
    // hero
    back: pt ? 'Voltar ao Agentask' : 'Back to Agentask',
    subtasksOf: (done: number, total: number) => pt ? `${done}/${total} subtarefas` : `${done}/${total} subtasks`,
    liveNow: (n: number) => pt ? `${n} ${n === 1 ? 'sessão ao vivo' : 'sessões ao vivo'}` : `${n} live ${n === 1 ? 'session' : 'sessions'}`,
    since: (date: string, days: number) => pt ? `desde ${date} · ${days} ${days === 1 ? 'dia' : 'dias'}` : `since ${date} · ${days} ${days === 1 ? 'day' : 'days'}`,
    kpiCost: pt ? 'Custo' : 'Cost',
    kpiSessions: pt ? 'Sessões' : 'Sessions',
    kpiActive: pt ? 'Tempo ativo' : 'Active time',
    kpiRounds: pt ? 'Rodadas' : 'Rounds',
    kpiTokens: 'Tokens',
    kpiMix: pt ? 'Harness · modelo' : 'Harness · model',
    noMix: pt ? 'nenhuma sessão medida ainda' : 'no session measured yet',
    about: pt ? 'Sobre' : 'About',
    // tabs
    tabThreads: pt ? 'Tópicos' : 'Threads',
    tabAbout: pt ? 'Sobre' : 'About',
    tabMetrics: pt ? 'Métricas' : 'Metrics',
    // inbox
    open: pt ? 'Abertos' : 'Open',
    resolved: pt ? 'Resolvidos' : 'Resolved',
    loose: pt ? 'Comentários avulsos' : 'Loose comments',
    looseHint: pt ? 'Comentários de antes dos tópicos, ou deixados fora de um' : 'Comments from before threads, or left outside one',
    newThread: pt ? 'Novo tópico' : 'New thread',
    newThreadTitle: pt ? 'Título do tópico' : 'Thread title',
    create: pt ? 'Criar' : 'Create',
    cancel: pt ? 'Cancelar' : 'Cancel',
    noThreads: pt
      ? 'Nenhum tópico ainda. Um tópico é o registro de um assunto da tarefa — entregas, bloqueios, decisões. As sessões abrem as suas ao entregar ou ao travar.'
      : 'No threads yet. A thread is the record of one subject of the task — handbacks, blocks, decisions. Sessions open their own when they hand back or get blocked.',
    sessionsCount: (n: number) => pt ? `${n} ${n === 1 ? 'sessão' : 'sessões'}` : `${n} ${n === 1 ? 'session' : 'sessions'}`,
    onTask: pt ? 'na tarefa' : 'on the task',
    onTarget: (title: string) => pt ? `em ${title}` : `on ${title}`,
    threadKind: { topic: '', handback: pt ? 'ENTREGA' : 'HANDBACK', block: pt ? 'BLOQUEIO' : 'BLOCK' } as Record<string, string>,
    commentKind: {
      note: pt ? 'Nota' : 'Note',
      handback: pt ? 'Entrega' : 'Handback',
      block: pt ? 'Bloqueio' : 'Block',
      decision: pt ? 'Decisão' : 'Decision',
    } as Record<string, string>,
    // thread view
    sessionsInThread: pt ? 'Sessões neste tópico' : 'Sessions in this thread',
    noParticipants: pt ? 'Nenhuma sessão neste tópico ainda — uma sessão entra quando comenta aqui.' : 'No session in this thread yet — a session joins when it comments here.',
    openedBy: (who: string, when: string) => pt ? `aberto por ${who} · ${when}` : `opened by ${who} · ${when}`,
    resolve: pt ? 'Resolver' : 'Resolve',
    reopen: pt ? 'Reabrir' : 'Reopen',
    mute: pt ? 'Não enviar a esta sessão' : 'Do not send to this session',
    unmute: pt ? 'Voltar a enviar a esta sessão' : 'Send to this session again',
    muted: pt ? 'não recebe envios' : 'excluded from sends',
    you: pt ? 'Você' : 'You',
    openChat: pt ? 'Abrir o chat da sessão' : "Open the session's chat",
    placeholder: pt ? 'Comentar neste tópico (fica no registro)…' : 'Comment in this thread (kept in the record)…',
    comment: pt ? 'Comentar' : 'Comment',
    asDecision: pt ? 'Marcar como decisão' : 'Mark as a decision',
    sendTo: (n: number) => pt ? `Enviar para ${n === 1 ? 'a sessão' : `as ${n} sessões`}` : `Send to the ${n === 1 ? 'session' : `${n} sessions`}`,
    sendHint: (queued: number) => {
      const base = pt
        ? 'Comentar fica só no registro. Enviar entrega o texto no chat de cada sessão — as respostas ficam lá.'
        : 'Comment stays in the record. Send delivers the text into each session\'s chat — answers stay there.'
      if (queued === 0) return base
      return pt ? `${base} ${queued} recebe${queued === 1 ? '' : 'm'} ao reabrir.` : `${base} ${queued} on reopen.`
    },
    noRecipients: pt ? 'Nenhuma sessão para receber um envio.' : 'No session to send to.',
    // deliveries
    sentTo: (n: number, of: number) => n === of
      ? (pt ? `enviado para ${n} ${n === 1 ? 'sessão' : 'sessões'}` : `sent to ${n} ${n === 1 ? 'session' : 'sessions'}`)
      : (pt ? `enviado para ${n} de ${of} sessões` : `sent to ${n} of ${of} sessions`),
    state: {
      delivered: pt ? 'entregue' : 'delivered',
      queued: pt ? 'na fila' : 'queued',
      undeliverable: pt ? 'não entregável' : 'undeliverable',
      muted: pt ? 'excluída' : 'excluded',
      failed: pt ? 'recusada' : 'refused',
    } satisfies Record<DeliveryState, string>,
    reason: {
      'not-running': pt ? 'recebe ao reabrir' : 'on reopen',
      'dialog-open': pt ? 'depois do diálogo' : 'after the dialog',
      external: pt ? 'sessão externa' : 'external session',
      'unknown-session': pt ? 'sessão desconhecida' : 'unknown session',
      muted: pt ? 'excluída do envio' : 'excluded from the send',
      refused: pt ? 'a sessão recusou' : 'the session refused it',
    } satisfies Record<DeliveryReason, string>,
    loading: pt ? 'Carregando…' : 'Loading…',
    failed: pt ? 'Não foi possível salvar.' : 'Could not save.',
  }
}

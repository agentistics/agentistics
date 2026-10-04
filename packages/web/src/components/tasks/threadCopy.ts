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
    tabThreads: pt ? 'Conversas' : 'Conversations',
    tabAbout: pt ? 'Sobre' : 'About',
    tabMetrics: pt ? 'Métricas' : 'Metrics',
    // inbox
    awaiting: pt ? 'Esperam você' : 'Waiting on you',
    open: pt ? 'Abertas' : 'Open',
    resolved: pt ? 'Resolvidas' : 'Resolved',
    loose: pt ? 'Comentários avulsos' : 'Loose comments',
    looseHint: pt ? 'Comentários de antes das threads, ou deixados fora de uma' : 'Comments from before threads, or left outside one',
    newThread: pt ? 'Nova thread' : 'New thread',
    newThreadTitle: pt ? 'Título da thread' : 'Thread title',
    create: pt ? 'Criar' : 'Create',
    cancel: pt ? 'Cancelar' : 'Cancel',
    noThreads: pt
      ? 'Nenhuma thread ainda. Abra uma para falar com várias sessões de uma vez; as sessões abrem as suas ao entregar ou ao travar.'
      : 'No threads yet. Open one to talk to several sessions at once; sessions open their own when they hand back or get blocked.',
    sessionsCount: (n: number) => pt ? `${n} ${n === 1 ? 'sessão' : 'sessões'}` : `${n} ${n === 1 ? 'session' : 'sessions'}`,
    onTask: pt ? 'na tarefa' : 'on the task',
    onTarget: (title: string) => pt ? `em ${title}` : `on ${title}`,
    kind: { topic: '', handback: 'HANDBACK', block: pt ? 'BLOQUEIO' : 'BLOCK' } as Record<string, string>,
    // thread view
    participants: pt ? 'Participam' : 'Participants',
    noParticipants: pt ? 'Nenhuma sessão participa ainda — uma sessão entra quando comenta aqui.' : 'No session takes part yet — a session joins when it comments here.',
    openedBy: (who: string, when: string) => pt ? `aberta por ${who} · ${when}` : `opened by ${who} · ${when}`,
    resolve: pt ? 'Resolver' : 'Resolve',
    reopen: pt ? 'Reabrir' : 'Reopen',
    mute: pt ? 'Silenciar esta sessão aqui' : 'Mute this session here',
    unmute: pt ? 'Voltar a entregar a esta sessão' : 'Deliver to this session again',
    muted: pt ? 'silenciada' : 'muted',
    you: pt ? 'Você' : 'You',
    viaSessionChat: pt ? 'respondido no chat da sessão' : 'answered in the session chat',
    replyAll: (n: number) => n === 0
      ? (pt ? 'Escrever na thread…' : 'Write in the thread…')
      : (pt ? `Responder às ${n} sessões desta thread…` : `Reply to the ${n} sessions in this thread…`),
    replyOne: pt ? 'Responder a todos' : 'Reply to all',
    goesTo: (n: number, queued: number) => {
      if (n === 0) return pt ? 'fica registrado na thread — nenhuma sessão participa ainda' : 'kept in the thread — no session takes part yet'
      const base = pt ? `→ ${n} ${n === 1 ? 'sessão' : 'sessões'}` : `→ ${n} ${n === 1 ? 'session' : 'sessions'}`
      return queued > 0 ? (pt ? `${base} (${queued} recebe${queued === 1 ? '' : 'm'} ao reabrir)` : `${base} (${queued} on reopen)`) : base
    },
    send: pt ? 'Enviar' : 'Send',
    notGate: pt
      ? 'A resposta chega às sessões como contexto extra. Nenhuma sessão espera por esta thread.'
      : 'The reply reaches the sessions as extra context. No session waits on this thread.',
    // mirror — the session asks in its own chat; the thread mirrors it
    mirrorTitle: (who: string) => pt ? `${who} perguntou no próprio chat` : `${who} asked in its own chat`,
    mirrorApproval: pt
      ? 'Está num diálogo de aprovação — responda na sessão, onde as opções estão.'
      : 'It is on an approval dialog — answer in the session, where the options are.',
    mirrorAnswer: pt ? 'Responder só a esta sessão' : 'Answer this session only',
    mirrorOpen: pt ? 'Abrir a sessão' : 'Open the session',
    mirrorHint: pt
      ? 'Responder aqui ou no chat da sessão é a mesma resposta — entregue uma vez, mostrada nos dois lugares.'
      : 'Answering here or in the session chat is the same answer — delivered once, shown in both places.',
    // deliveries
    deliveredTo: (n: number, of: number) => n === of
      ? (pt ? `entregue a ${n} ${n === 1 ? 'sessão' : 'sessões'}` : `delivered to ${n} ${n === 1 ? 'session' : 'sessions'}`)
      : (pt ? `entregue a ${n} de ${of} sessões` : `delivered to ${n} of ${of} sessions`),
    state: {
      delivered: pt ? 'entregue' : 'delivered',
      queued: pt ? 'na fila' : 'queued',
      undeliverable: pt ? 'não entregável' : 'undeliverable',
      muted: pt ? 'silenciada' : 'muted',
      failed: pt ? 'recusada' : 'refused',
    } satisfies Record<DeliveryState, string>,
    reason: {
      'not-running': pt ? 'recebe ao reabrir' : 'on reopen',
      'dialog-open': pt ? 'depois do diálogo' : 'after the dialog',
      external: pt ? 'sessão externa' : 'external session',
      'unknown-session': pt ? 'sessão desconhecida' : 'unknown session',
      muted: pt ? 'silenciada' : 'muted',
      refused: pt ? 'a sessão recusou' : 'the session refused it',
    } satisfies Record<DeliveryReason, string>,
    loading: pt ? 'Carregando…' : 'Loading…',
    failed: pt ? 'Não foi possível enviar.' : 'Could not send.',
  }
}

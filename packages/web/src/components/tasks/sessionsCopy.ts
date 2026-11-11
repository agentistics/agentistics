import type { Lang } from './copy'

/** The words of the sessions views (leader cards, subtask summaries, the Sessions tab). */
export interface SessionsCopy {
  leaders: string
  leader: string
  noSubtask: string
  alive: string
  ended: string
  all: string
  search: string
  aliveShort: (n: number) => string
  endedShort: (n: number) => string
  seeEnded: (n: number, cost: string | null) => string
  hideEnded: string
  showMore: (n: number) => string
  noneFiled: string
  noneMatch: string
  state: Record<string, string>
  notInFleet: string
  historical: string
  finished: string
  noSession: string
  open: string
  legacyHint: string
  leaderOnly: string
}

const EN: SessionsCopy = {
  leaders: 'Leaders', leader: 'LEADER', noSubtask: 'No subtask',
  alive: 'Alive', ended: 'Ended', all: 'All', search: 'Search sessions…',
  aliveShort: n => `${n} alive`, endedShort: n => `${n} ended`,
  seeEnded: (n, cost) => `see ${n} ended${cost ? ` · ${cost}` : ''}`, hideEnded: 'hide ended', showMore: n => `show ${n} more`,
  noneFiled: 'No session is filed under this task yet.', noneMatch: 'No session matches this filter.',
  state: { working: 'working', waiting: 'waiting', 'waiting-approval': 'needs you', idle: 'idle', exited: 'finished', closed: 'closed', lost: 'lost', unknown: 'unknown' },
  notInFleet: 'not in fleet', historical: 'historical', finished: 'finished', noSession: 'no session', open: 'Open',
  legacyHint: 'Workers filed on the task before leaders-only filing; file them on a subtask to tidy up.',
  leaderOnly: 'only leaders are filed on the task itself',
}

const PT: SessionsCopy = {
  leaders: 'Líderes', leader: 'LÍDER', noSubtask: 'Sem subtarefa',
  alive: 'Vivas', ended: 'Encerradas', all: 'Todas', search: 'Buscar sessões…',
  aliveShort: n => `${n} ${n === 1 ? 'viva' : 'vivas'}`, endedShort: n => `${n} enc.`,
  seeEnded: (n, cost) => `ver ${n} ${n === 1 ? 'encerrada' : 'encerradas'}${cost ? ` · ${cost}` : ''}`, hideEnded: 'ocultar encerradas', showMore: n => `mostrar mais ${n}`,
  noneFiled: 'Nenhuma sessão arquivada nesta tarefa ainda.', noneMatch: 'Nenhuma sessão corresponde a este filtro.',
  state: { working: 'trabalhando', waiting: 'aguardando', 'waiting-approval': 'precisa de você', idle: 'ociosa', exited: 'encerrada', closed: 'fechada', lost: 'perdida', unknown: 'desconhecido' },
  notInFleet: 'fora da frota', historical: 'histórica', finished: 'encerrada', noSession: 'sem sessão', open: 'Abrir',
  legacyHint: 'Workers arquivados na tarefa antes da regra só-líderes; arquive-os numa subtarefa para organizar.',
  leaderOnly: 'só líderes são arquivados na própria tarefa',
}

export const sessionsCopy = (lang: Lang): SessionsCopy => (lang === 'pt' ? PT : EN)

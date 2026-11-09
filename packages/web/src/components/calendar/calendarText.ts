/** The Delivery calendar's own words, pt/en. One table so a screen and its test read the same sentences. */
import type { CalConfidence, CalPriority } from '@agentistics/core'
import type { CalView } from '../../lib/calendarModel'

type L = { pt: string; en: string }
const t = (pt: string, en: string): L => ({ pt, en })

export const TEXT = {
  title: t('Calendário de entregas', 'Delivery calendar'),
  /** The heading on the desktop bar, where every px goes to the date range; the full name stays on its tooltip and the views' label. */
  titleShort: t('Calendário', 'Calendar'),
  today: t('Hoje', 'Today'),
  filters: t('Filtros', 'Filters'),
  threeDays: t('3 dias', '3 days'),
  collapse: t('Recolher', 'Collapse'),
  prev: t('Anterior', 'Previous'),
  next: t('Próximo', 'Next'),
  exportIcs: t('Exportar .ics', 'Export .ics'),
  tasks: t('Tarefas', 'Tasks'),
  stage: t('Etapa', 'Stage'),
  version: t('Versão', 'Version'),
  harness: t('Harness', 'Harness'),
  priority: t('Prioridade', 'Priority'),
  active: t('Em andamento', 'In progress'),
  allTasks: t('Todas as tarefas', 'All tasks'),
  onlyConfirmed: t('Só confirmadas', 'Confirmed only'),
  published: t('publicada', 'published'),
  expected: t('prevista', 'expected'),
  noEstimate: t('sem estimativa', 'no estimate'),
  noTime: t('sem horário', 'no time'),
  pieces: (n: number) => t(`${n} peça${n === 1 ? '' : 's'}`, `${n} piece${n === 1 ? '' : 's'}`),
  versions: (n: number) => t(`${n} ${n === 1 ? 'versão' : 'versões'}`, `${n} version${n === 1 ? '' : 's'}`),
  accountsRenew: t('Janelas das contas renovam', 'Account windows renew'),
  due: t('Prazo', 'Due'),
  now: t('agora', 'now'),
  allDay: t('dia todo', 'all day'),
  piece: t('Peça', 'Piece'),
  marks: t('Marcos', 'Milestones'),
  piecesByPriority: t('Peças por prioridade', 'Pieces by priority'),
  urgentToLow: t('urgente → baixa', 'urgent → low'),
  emptyTitle: t('Nada para mostrar neste período', 'Nothing to show in this period'),
  emptyHint: t('Ajuste os filtros ou volte para hoje.', 'Adjust the filters or go back to today.'),
  emptyDay: t('Nada neste dia', 'Nothing on this day'),
  emptyAll: t('Nenhuma entrega no calendário ainda.', 'No deliveries on the calendar yet.'),
  loadError: t('Não foi possível ler o calendário.', 'The calendar could not be read.'),
  retry: t('Tentar de novo', 'Try again'),
  open: t('Abrir tarefa', 'Open task'),
  openLive: t('Ver na Live', 'See in Live'),
  dateTime: t('Data / hora', 'Date / time'),
  stageWord: t('Etapa', 'Stage'),
  model: t('Modelo', 'Model'),
  eta: t('ETA', 'ETA'),
  started: t('Começou', 'Started'),
  taskWord: t('Tarefa', 'Task'),
  versionWord: t('Versão', 'Version'),
  dueWord: t('Prazo da tarefa', 'Task due'),
  late: t('atrasada', 'late'),
  legendPublished: t('publicada', 'published'),
  legendExpected: t('tracejado = previsto', 'dashed = expected'),
  close: t('Fechar', 'Close'),
  agenda: t('Agenda', 'Agenda'),
  beta: t('o Calendário de entregas', 'the Delivery calendar'),
  bundled: (n: number) => t(`tudo que entra: ${n} peça${n === 1 ? '' : 's'}`, `everything that ships: ${n} piece${n === 1 ? '' : 's'}`),
  noTasks: t('Nenhuma tarefa', 'No tasks'),
  searchTask: t('Buscar tarefa…', 'Search tasks…'),
  confirmAdd: (n: number) => t(`Adicionar ${n}`, `Add ${n}`),
  selectAll: t('Selecionar todas', 'Select all'),
  removeFilter: t('Tirar filtro', 'Remove filter'),
  more: t('mais', 'more'),
} as const

export const pick = (l: L, pt: boolean): string => (pt ? l.pt : l.en)

export const VIEW_LABEL: Record<CalView, L> = {
  month: t('Mês', 'Month'), week: t('Semana', 'Week'), day: t('Dia', 'Day'), schedule: t('Cronograma', 'Schedule'), agenda: t('Agenda', 'Agenda'),
}

export const PRIORITY_LABEL: Record<CalPriority, L> = {
  urgent: t('urgente', 'urgent'), high: t('alta', 'high'), medium: t('média', 'medium'), low: t('baixa', 'low'),
}

export const CONFIDENCE_LABEL: Record<CalConfidence, L> = {
  high: t('confiança alta', 'high confidence'), medium: t('confiança média', 'medium confidence'), low: t('confiança baixa', 'low confidence'),
}

export const NO_ESTIMATE_REASON: Record<string, L> = {
  'no-history': t('sem histórico parecido para estimar', 'no similar history to estimate from'),
  'not-started': t('ainda não começou', 'not started yet'),
  'beyond-range': t('já passou do tempo típico', 'already past the typical time'),
  final: t('já publicada', 'already published'),
}

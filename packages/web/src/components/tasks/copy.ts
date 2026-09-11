/**
 * copy.ts — the board's words, in one place, in both languages.
 *
 * Two problems this exists to end.
 *
 * **The board was the only page in the product that ignored the language toggle**: `TasksPage`
 * passed a hardcoded `lang="en"` to its children, so a dashboard read in Portuguese answered
 * "Deliveries", "Mark delivered" and "Working on it" in English. Every other page threads the
 * language it gets from `AppContext`; this one now does too.
 *
 * **And the same thing had three names.** The nav said *Entregas*, the components said *task*, the
 * pickers said *Vincular a uma tarefa* on one surface and *File under a task* on another. A reader
 * has to work out that all three are one concept before they can act, which is most of what "está
 * bem confuso" was. The interface word is now **Entrega / Delivery**, everywhere and only.
 * `task` survives in the code, the routes and the CLI, where it confuses nobody.
 *
 * Shaped after `components/team/copy.ts`, which established the pattern here. A component may hold
 * no sentence of its own: a string written inline is a string the other language never gets.
 */

export type Lang = 'pt' | 'en'

export interface BoardCopy {
  /** The board itself. */
  deliveries: string
  delivery: string
  /** The filing gesture — the SAME words on every surface that offers it. */
  fileUnder: string
  noDelivery: string
  changeDelivery: string
  filed: string
  unfiled: string
  couldNotFile: string
  couldNotUnfile: string
  /** The reverse direction, offered only from a delivery's own screen. */
  addSession: string
  /** The spawn form's field. */
  deliveryOptional: string
  pickOrCreate: string
  dropSuggestion: string
  /** The statuses, which are a vocabulary and not free text. */
  status: Record<string, string>
  /** Verbs that used to be standalone buttons and are now rows of the status menu. */
  markDelivered: string
  markAbandoned: string
  /** Rail sections that still carry verbs of their own (linking, deleting). */
  actions: string
  /** The picker's own two lines. */
  searchOrCreate: string
  newWithDetails: string
  /**
   * The subtask table — the one grid a session is actually filed in, so its columns are read
   * closely and were the last English left on a Portuguese board.
   */
  subtasks: string
  owner: string
  start: string
  due: string
  sessions: string
  addSubtask: string
  nothingBrokenOut: string
  remove: string
  /**
   * Stopping a session, which is the moment somebody actually knows whether the work is done.
   *
   * It replaces two standing verbs on the session row — "open the whole task" and "finish task" —
   * that asked about a delivery at a moment nobody was thinking about one. This asks at the only
   * moment the answer is in the reader's head.
   */
  endSession: string
  endSessionWhat: string
  deliveredQuestion: string
  /** The PART this session did — what a stop actually offers to close. */
  partQuestion: string
  lastPart: string
  endOnly: string
  endAndFinishPart: string
  endAndDeliver: string
  markedDelivered: string
  couldNotMarkDelivered: string
  /** The delivery's own tabs — drawn on the page AND in the session aside, so one set of words. */
  tabs: Record<'overview' | 'sessions' | 'comments' | 'subtasks' | 'files' | 'activity', string>
  wholeDelivery: string
  deleteDelivery: string
  /**
   * `PlanCard`'s own fields — status/priority/owner/dates/claim — and the `Rollup` stat row beside
   * it. These were the last English left on an otherwise-translated delivery page: the tab bar
   * above them and the rail sections around them already read Portuguese, so a plain "Cost" /
   * "Working on it" sitting between two Portuguese headings read as broken rather than untranslated.
   */
  priority: string
  dates: string
  clearDates: string
  waitingOn: string
  workingOnIt: string
  free: string
  takeIt: string
  takeItTitle: string
  release: string
  releaseTitleExpired: string
  releaseTitle: string
  cost: string
  yourPrompts: string
  yourPromptsTitle: string
  tokens: string
  active: string
  /** The attempts rail — one card per (harness, model, effort) configuration. */
  attemptsHeader: string
  /** The server's own sentinel for a session nobody filed under a named attempt — never a real
   *  attempt name, so it is the one attempt label this file may translate. */
  noAttemptNamed: string
  unattributed: string
  models: string
  noModelReported: string
  /** The "Delivery" rail section's own git/agent figures. */
  deliveryTime: string
  stillOpen: string
  agentRuns: string
  commits: string
  files: string
  errors: string
  lines: string
  tokenInput: string
  tokenOutput: string
  tokenCacheRead: string
  tokenCacheWrite: string
  links: string
  blockedBy: string
  /** The description's own collapse/expand, when it has no markdown headings to fold by. */
  showAllDescription: string
  showLessDescription: string
}

const EN: BoardCopy = {
  deliveries: 'Deliveries',
  delivery: 'Delivery',
  fileUnder: 'File under a delivery',
  noDelivery: 'no delivery',
  changeDelivery: 'Delivery',
  filed: 'Session filed under the delivery.',
  unfiled: 'No longer filed under a delivery.',
  couldNotFile: 'Could not file that session.',
  couldNotUnfile: 'Could not unfile that session.',
  addSession: 'Add a session',
  deliveryOptional: 'Delivery (optional)',
  pickOrCreate: 'None — pick or create…',
  dropSuggestion: 'Do not use the suggestion',
  status: {
    backlog: 'Backlog',
    todo: 'To do',
    in_progress: 'In progress',
    blocked: 'Blocked',
    in_review: 'In review',
    done: 'Delivered',
    abandoned: 'Abandoned',
  },
  markDelivered: 'Mark delivered',
  markAbandoned: 'Mark abandoned',
  actions: 'Actions',
  searchOrCreate: 'Search deliveries, or type a new name',
  newWithDetails: 'New delivery with all the details…',
  subtasks: 'Subtasks',
  owner: 'Owner',
  start: 'Start',
  due: 'Due',
  sessions: 'Sessions',
  addSubtask: 'Add a subtask, then Enter',
  nothingBrokenOut:
    'Nothing broken out yet. A session is filed under a SUBTASK, never under the delivery itself — '
    + 'so break the work into parts here, and the delivery’s cost becomes the cost of its parts.',
  remove: 'Remove',
  endSession: 'End this session?',
  endSessionWhat: 'Whatever it is doing stops now.',
  deliveredQuestion: 'Is this delivery finished?',
  partQuestion: 'Is this part finished?',
  lastPart: 'the last open part, so the delivery is marked delivered too',
  endOnly: 'End the session only',
  endAndFinishPart: 'Finish this part and end',
  endAndDeliver: 'Finish it and mark the delivery delivered',
  markedDelivered: 'Marked delivered.',
  couldNotMarkDelivered: 'Could not mark it delivered — the session was left running.',
  tabs: {
    overview: 'Overview',
    sessions: 'Sessions',
    comments: 'Comments',
    subtasks: 'Subtasks',
    files: 'Files',
    activity: 'Activity',
  },
  wholeDelivery: 'The whole delivery',
  deleteDelivery: 'Delete this delivery',
  priority: 'Priority',
  dates: 'Dates',
  clearDates: 'Clear both dates',
  waitingOn: 'Waiting on',
  workingOnIt: 'Working on it',
  free: 'Free — nobody has taken it.',
  takeIt: 'Take it',
  takeItTitle: 'Take it, so an agent asking what to work on is told somebody has this',
  release: 'Release',
  releaseTitleExpired: 'The lease has run out — clear the holder',
  releaseTitle: 'Give the task back to the board',
  cost: 'Cost',
  yourPrompts: 'Your prompts',
  yourPromptsTitle: 'How many times you prompted, across every session filed here',
  tokens: 'Tokens',
  active: 'Active',
  attemptsHeader: 'Attempts — one card per configuration',
  noAttemptNamed: 'no attempt named',
  unattributed: 'unattributed',
  models: 'Models',
  noModelReported: 'No session reported a model.',
  deliveryTime: 'Delivery time',
  stillOpen: 'still open',
  agentRuns: 'Agent runs',
  commits: 'Commits',
  files: 'Files',
  errors: 'Errors',
  lines: 'Lines',
  tokenInput: 'Input',
  tokenOutput: 'Output',
  tokenCacheRead: 'Cache read',
  tokenCacheWrite: 'Cache write',
  links: 'Links',
  blockedBy: 'Blocked by',
  showAllDescription: 'Show all',
  showLessDescription: 'Show less',
}

const PT: BoardCopy = {
  deliveries: 'Entregas',
  delivery: 'Entrega',
  fileUnder: 'Filiar a uma entrega',
  noDelivery: 'sem entrega',
  changeDelivery: 'Entrega',
  filed: 'Sessão filiada à entrega.',
  unfiled: 'Sessão desfiliada.',
  couldNotFile: 'Não foi possível filiar a sessão.',
  couldNotUnfile: 'Não foi possível desfiliar a sessão.',
  addSession: 'Adicionar sessão',
  deliveryOptional: 'Entrega (opcional)',
  pickOrCreate: 'Nenhuma — escolher ou criar…',
  dropSuggestion: 'Não usar a sugestão',
  status: {
    backlog: 'Backlog',
    todo: 'A fazer',
    in_progress: 'Em andamento',
    blocked: 'Bloqueada',
    in_review: 'Em revisão',
    // "Entregue", not "Concluída": the whole board measures DELIVERY, and the status has to be the
    // same word as the thing being counted.
    done: 'Entregue',
    abandoned: 'Abandonada',
  },
  markDelivered: 'Marcar entregue',
  markAbandoned: 'Marcar abandonada',
  actions: 'Ações',
  searchOrCreate: 'Buscar entregas, ou digitar um nome novo',
  newWithDetails: 'Nova entrega, com todos os detalhes…',
  subtasks: 'Subtarefas',
  owner: 'Responsável',
  start: 'Início',
  due: 'Prazo',
  sessions: 'Sessões',
  addSubtask: 'Adicionar subtarefa e apertar Enter',
  nothingBrokenOut:
    'Nada dividido ainda. Uma sessão se filia a uma SUBTAREFA, nunca à entrega em si — divida o '
    + 'trabalho em partes aqui, e o custo da entrega passa a ser o custo das partes dela.',
  remove: 'Remover',
  endSession: 'Encerrar esta sessão?',
  endSessionWhat: 'O que ela estiver fazendo para agora.',
  deliveredQuestion: 'Esta entrega está finalizada?',
  partQuestion: 'Esta parte está finalizada?',
  lastPart: 'a última parte aberta, então a entrega também é marcada como entregue',
  endOnly: 'Só encerrar a sessão',
  endAndFinishPart: 'Finalizar esta parte e encerrar',
  endAndDeliver: 'Finalizar e marcar a entrega como entregue',
  markedDelivered: 'Entrega marcada como entregue.',
  couldNotMarkDelivered: 'Não foi possível marcar a entrega — a sessão continua rodando.',
  tabs: {
    overview: 'Visão geral',
    sessions: 'Sessões',
    comments: 'Comentários',
    subtasks: 'Subtarefas',
    files: 'Arquivos',
    activity: 'Atividade',
  },
  wholeDelivery: 'A entrega inteira',
  deleteDelivery: 'Excluir esta entrega',
  priority: 'Prioridade',
  dates: 'Datas',
  clearDates: 'Limpar as duas datas',
  waitingOn: 'Aguardando',
  workingOnIt: 'Em andamento',
  free: 'Livre — ninguém pegou ainda.',
  takeIt: 'Pegar',
  takeItTitle: 'Pegar, para dizer a um agente perguntando o que fazer que alguém já está nisso',
  release: 'Liberar',
  releaseTitleExpired: 'O prazo da posse expirou — limpar o responsável',
  releaseTitle: 'Devolver a tarefa para o quadro',
  cost: 'Custo',
  yourPrompts: 'Seus prompts',
  yourPromptsTitle: 'Quantas vezes você fez um prompt, em todas as sessões filiadas aqui',
  tokens: 'Tokens',
  active: 'Ativo',
  attemptsHeader: 'Tentativas — um cartão por configuração',
  noAttemptNamed: 'sem tentativa nomeada',
  unattributed: 'não atribuída',
  models: 'Modelos',
  noModelReported: 'Nenhuma sessão informou um modelo.',
  deliveryTime: 'Tempo de entrega',
  stillOpen: 'ainda aberta',
  agentRuns: 'Execuções de agente',
  commits: 'Commits',
  files: 'Arquivos',
  errors: 'Erros',
  lines: 'Linhas',
  tokenInput: 'Entrada',
  tokenOutput: 'Saída',
  tokenCacheRead: 'Leitura de cache',
  tokenCacheWrite: 'Escrita de cache',
  links: 'Links',
  blockedBy: 'Bloqueada por',
  showAllDescription: 'Mostrar tudo',
  showLessDescription: 'Mostrar menos',
}

export function boardCopy(lang: Lang): BoardCopy {
  return lang === 'pt' ? PT : EN
}

/** The status word alone, which is what most cells need. Unknown ids render as themselves. */
export function statusLabel(status: string, lang: Lang): string {
  return boardCopy(lang).status[status] ?? status
}

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

import type { ColumnId } from './board'

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
  /** System-stamped, read-only facts — see `Subtask.startedAt`/`deliveredAt`'s own note. */
  started: string
  completed: string
  /** `deliveredAt − startedAt`, shown only when both are stamped — see `fmtElapsed`. */
  duration: string
  sessions: string
  /** The main table's Sessions cell qualifier — "N · M priced" when fewer sessions could be priced
   *  than were used. A short WORD, never a phrase: the cell must stay one line. */
  sessionsPriced: string
  addSubtask: string
  nothingBrokenOut: string
  remove: string
  /**
   * The footer row under the subtask grid, drawn only when the delivery has sessions filed
   * directly on it (no subtask) — the server's `id: null` bucket in `subtaskViews()`. Not a
   * subtask's name; it labels a bucket, so it stays a phrase rather than a title.
   */
  directSessions: string
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
   * `PlanCard`'s own fields — status/priority/dates — and the `Rollup` stat row beside it. These
   * were the last English left on an otherwise-translated delivery page: the tab bar above them and
   * the rail sections around them already read Portuguese, so a plain "Cost" sitting between two
   * Portuguese headings read as broken rather than untranslated.
   */
  priority: string
  dates: string
  waitingOn: string
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
  /**
   * The staged-session draft, composed ahead of time on a loose subtask or a group and fired later
   * (t-918cc82233) — see `@agentistics/core`'s `stagedSession.ts`. Never offered on a group MEMBER.
   */
  staged: {
    compose: string
    edit: string
    fire: string
    ready: string
    prompt: string
    promptPlaceholder: string
    harness: string
    harnessAsk: string
    model: string
    effort: string
    cwd: string
    cwdAsk: string
    attachments: string
    attach: string
    existing: string
    noFiles: string
    save: string
    cancel: string
    discard: string
    discardTitle: string
    discardMessage: string
    promptRequired: string
    cwdInvalid: string
    launchTitle: string
    launchIntro: string
    launch: string
    launching: string
    /** The deliberate second button offered only after a memory-budget refusal — see
     *  `spawnAdmission.ts`'s `isAdmissionRefusal`. Re-sends the same request with `force: true`. */
    startAnyway: string
    preparing: string
    networkError: string
    /** The read-only summary — the gear menu's own row label, and that dialog's own title prefix. */
    view: string
    /** The gear menu's destructive row — distinct wording from `discard` (which lives INSIDE the
     *  compose dialog, closing it as a side effect); this one is reachable without opening the
     *  dialog at all, and its `ConfirmModal` reuses `discardTitle`/`discardMessage`/`discard`. */
    deleteRow: string
    pasteTooLarge: string
    attachFailed: string
    attachNetworkError: string
  }
  /**
   * The MAIN table's column headers (`TaskTable.tsx`'s `COLUMNS`) — and the SAME record feeds the
   * "Columns" picker's option labels, so the picker and the headers can never name a column two
   * different ways. Reuses the exact words used elsewhere for the same concept (`cost`, `tokens`,
   * `sessions`, `subtasks`, `files`, `links`, `blockedBy`, `priority` above; `list.keys` for the
   * sort note) rather than inventing a second translation of the same idea.
   */
  columns: Record<ColumnId, string>
  /**
   * The lists' own controls: Select mode, the open-the-task button, and sorting by a column title.
   * `{column}` / `{key}` are replaced by the caller — a sentence built by concatenating a translated
   * word onto an English frame is the bug this file exists to end.
   */
  list: {
    select: string
    selectTitle: string
    selectAllInGroup: string
    selectRow: string
    openTask: string
    /** The main table's leading, always-present column — the task's own name. Kept as its own key
     *  (never `columns` above, which only covers the `+`-menu columns) because this one column
     *  can never be hidden. */
    taskColumn: string
    showSubtasks: string
    hideSubtasks: string
    sortBy: string
    sortByColumn: string
    sortDefault: string
    sortAsc: string
    sortDesc: string
    handOrder: string
    /** The kanban column title's sort menu. */
    columnSortTitle: string
    columnReorderOff: string
    columnUseHand: string
    /** The "sorted by {key} · reset" note drawn above the table when a non-default sort is
     *  active — `{key}` is one of `keys` below. Used to be two English literals hardcoded around
     *  it regardless of `lang`, so a Portuguese board read "sorted by custo ↓ · reset". */
    sortedByPrefix: string
    resetSort: string
    /** Every key a list can be ordered by, in words. */
    keys: Record<string, string>
  }
  /**
   * The "Columns"/"Groups" pickers' own chrome (`PickerMenu.tsx`) — the popover title, the note
   * under the list, the trigger's own label, and the ▲▼ reorder buttons. This was the one piece of
   * chrome around an otherwise-translated table/kanban that never read `lang` at all: the table's
   * "Show groups" and "Columns" pickers (`TaskTable.tsx`) and the kanban's own "Columns on the
   * board" one (`BoardArrange.tsx`) all wrote English straight into their JSX regardless of the
   * toggle. Everything else a `PickerMenu` draws (the item labels, the hint counts) is supplied by
   * the caller from elsewhere in this file, never from here.
   */
  pickers: {
    moveUp: string
    moveDown: string
    groupsTitle: string
    groupsTrigger: string
    groupsNote: string
    columnsTitle: string
    columnsTrigger: string
    columnsNote: string
    boardColumnsTitle: string
    boardColumnsTrigger: string
    boardColumnsNote: string
  }
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
  started: 'Started',
  completed: 'Completed',
  duration: 'Duration',
  sessions: 'Sessions',
  sessionsPriced: 'priced',
  addSubtask: 'Add a subtask, then Enter',
  nothingBrokenOut:
    'Nothing broken out yet. A session is filed under a SUBTASK, never under the delivery itself — '
    + 'so break the work into parts here, and the delivery’s cost becomes the cost of its parts.',
  remove: 'Remove',
  directSessions: 'Sessions filed directly on the delivery',
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
  waitingOn: 'Waiting on',
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
  columns: {
    status: 'Status',
    priority: 'Priority',
    due: 'Due',
    claim: 'Working on it',
    progress: 'Progress',
    attempts: 'Attempts',
    sessions: 'Sessions',
    rounds: 'Your prompts',
    tokens: 'Tokens',
    cost: 'Cost',
    harnesses: 'Harnesses',
    subtasks: 'Subtasks',
    comments: 'Comments',
    files: 'Files',
    links: 'Links',
    blockedBy: 'Blocked by',
    created: 'Created',
    updated: 'Updated',
  },
  staged: {
    compose: 'Stage a session',
    edit: 'Edit staged session',
    fire: 'Fire',
    ready: 'Ready to fire',
    prompt: 'First message',
    promptPlaceholder: 'What the session should do…',
    harness: 'Assistant (optional)',
    harnessAsk: 'Asked when fired',
    model: 'Model (optional)',
    effort: 'Effort (optional)',
    cwd: 'Folder (optional)',
    cwdAsk: 'Left blank, asked when fired — an absolute path',
    attachments: 'Attachments',
    attach: 'Attach',
    existing: 'Add an existing file',
    noFiles: 'No files on this delivery yet.',
    save: 'Save draft',
    cancel: 'Cancel',
    discard: 'Discard draft',
    discardTitle: 'Discard this staged session?',
    discardMessage: 'The prompt and its attachments are removed. Nothing already running is affected.',
    promptRequired: 'Write the first message.',
    cwdInvalid: 'The folder must be an absolute path (starting with /).',
    launchTitle: 'Fire staged session',
    launchIntro: 'This starts a real assistant now, billed like any other session, and files it under this exact subtask automatically.',
    launch: 'Fire',
    launching: 'Starting…',
    startAnyway: 'Start anyway',
    preparing: 'Preparing attachments…',
    networkError: 'Network error talking to this machine.',
    view: 'View staged session',
    deleteRow: 'Delete staged session',
    pasteTooLarge: 'The pasted text was too large to type into the session, so it was attached as a file.',
    attachFailed: 'The attachment failed.',
    attachNetworkError: 'Network error uploading the attachment.',
  },
  list: {
    select: 'Select',
    selectTitle: 'Show checkboxes to pick several tasks at once',
    selectAllInGroup: 'Select every task in this group',
    selectRow: 'Select this task',
    openTask: 'Open task',
    taskColumn: 'Task',
    showSubtasks: 'Show the subtasks',
    hideSubtasks: 'Hide the subtasks',
    sortBy: 'Sort by',
    sortByColumn: 'Sort by {column}',
    sortDefault: 'Default order',
    sortAsc: 'Ascending',
    sortDesc: 'Descending',
    handOrder: 'Hand order',
    columnSortTitle: 'Order the cards in this column',
    columnReorderOff: 'Ordered by {key}. Dragging to reorder is off in this column.',
    columnUseHand: 'Use hand order',
    sortedByPrefix: 'sorted by',
    resetSort: 'reset',
    keys: {
      manual: 'Hand order', priority: 'Priority', title: 'Title', status: 'Status',
      created: 'Newest', updated: 'Last touched', due: 'Due date',
      cost: 'Cost', tokens: 'Tokens', rounds: 'Your prompts', sessions: 'Sessions',
      attempts: 'Attempts', comments: 'Comments', subtasks: 'Subtasks', progress: 'Progress', harnesses: 'Harnesses',
      delivered: 'Delivered', started: 'Started',
    },
  },
  pickers: {
    moveUp: 'Move up',
    moveDown: 'Move down',
    groupsTitle: 'Show groups',
    groupsTrigger: 'Groups',
    groupsNote: 'Drag a ticked group, or use ▲▼, to reorder the bands. A hidden group’s tasks are still there.',
    columnsTitle: 'Columns',
    columnsTrigger: 'Columns',
    columnsNote: 'Drag a ticked column, or use ▲▼, to reorder it — the table follows this order.',
    boardColumnsTitle: 'Columns on the board',
    boardColumnsTrigger: 'Columns',
    boardColumnsNote:
      'Drag a ticked column, or use ▲▼, to reorder the pipeline. A hidden column’s tasks are still there.',
  },
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
  started: 'Início',
  completed: 'Concluído em',
  duration: 'Duração',
  sessions: 'Sessões',
  sessionsPriced: 'com custo',
  addSubtask: 'Adicionar subtarefa e apertar Enter',
  nothingBrokenOut:
    'Nada dividido ainda. Uma sessão se filia a uma SUBTAREFA, nunca à entrega em si — divida o '
    + 'trabalho em partes aqui, e o custo da entrega passa a ser o custo das partes dela.',
  remove: 'Remover',
  directSessions: 'Sessões diretas na entrega',
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
  waitingOn: 'Aguardando',
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
  columns: {
    status: 'Status',
    priority: 'Prioridade',
    due: 'Prazo',
    claim: 'Trabalhando',
    progress: 'Progresso',
    attempts: 'Tentativas',
    sessions: 'Sessões',
    rounds: 'Seus prompts',
    tokens: 'Tokens',
    cost: 'Custo',
    harnesses: 'Harnesses',
    subtasks: 'Subtarefas',
    comments: 'Comentários',
    files: 'Arquivos',
    links: 'Links',
    blockedBy: 'Bloqueada por',
    created: 'Criada em',
    updated: 'Atualizada em',
  },
  staged: {
    compose: 'Preparar sessão',
    edit: 'Editar sessão em espera',
    fire: 'Disparar',
    ready: 'Pronta pra disparar',
    prompt: 'Primeira mensagem',
    promptPlaceholder: 'O que a sessão deve fazer…',
    harness: 'Assistente (opcional)',
    harnessAsk: 'Perguntado ao disparar',
    model: 'Modelo (opcional)',
    effort: 'Esforço (opcional)',
    cwd: 'Pasta (opcional)',
    cwdAsk: 'Em branco, é perguntada ao disparar — caminho absoluto',
    attachments: 'Anexos',
    attach: 'Anexar',
    existing: 'Adicionar um arquivo existente',
    noFiles: 'Nenhum arquivo nesta entrega ainda.',
    save: 'Salvar rascunho',
    cancel: 'Cancelar',
    discard: 'Descartar rascunho',
    discardTitle: 'Descartar esta sessão em espera?',
    discardMessage: 'A mensagem e os anexos são removidos. Nada que já está rodando é afetado.',
    promptRequired: 'Escreva a primeira mensagem.',
    cwdInvalid: 'A pasta precisa ser um caminho absoluto (começando com /).',
    launchTitle: 'Disparar sessão em espera',
    launchIntro: 'Isso inicia um assistente de verdade agora, cobrado como qualquer outra sessão, e a filia automaticamente a esta subtarefa.',
    launch: 'Disparar',
    launching: 'Iniciando…',
    startAnyway: 'Iniciar mesmo assim',
    preparing: 'Preparando anexos…',
    networkError: 'Erro de rede ao falar com esta máquina.',
    view: 'Ver sessão em espera',
    deleteRow: 'Excluir sessão em espera',
    pasteTooLarge: 'O texto colado era grande demais para digitar na sessão, então foi anexado como arquivo.',
    attachFailed: 'O anexo falhou.',
    attachNetworkError: 'Erro de rede ao enviar o anexo.',
  },
  list: {
    select: 'Selecionar',
    selectTitle: 'Mostrar as caixas de seleção para escolher várias tarefas de uma vez',
    selectAllInGroup: 'Selecionar todas as tarefas deste grupo',
    selectRow: 'Selecionar esta tarefa',
    openTask: 'Abrir tarefa',
    taskColumn: 'Tarefa',
    showSubtasks: 'Mostrar as subtarefas',
    hideSubtasks: 'Esconder as subtarefas',
    sortBy: 'Ordenar por',
    sortByColumn: 'Ordenar por {column}',
    sortDefault: 'Ordem padrão',
    sortAsc: 'Crescente',
    sortDesc: 'Decrescente',
    handOrder: 'Ordem manual',
    columnSortTitle: 'Ordenar os cards desta coluna',
    columnReorderOff: 'Ordenada por {key}. Arrastar para reordenar está desligado nesta coluna.',
    columnUseHand: 'Usar ordem manual',
    sortedByPrefix: 'ordenada por',
    resetSort: 'redefinir',
    keys: {
      manual: 'Ordem manual', priority: 'Prioridade', title: 'Título', status: 'Status',
      created: 'Mais recentes', updated: 'Última alteração', due: 'Prazo',
      cost: 'Custo', tokens: 'Tokens', rounds: 'Seus prompts', sessions: 'Sessões',
      attempts: 'Tentativas', comments: 'Comentários', subtasks: 'Subtarefas', progress: 'Progresso', harnesses: 'Harnesses',
      delivered: 'Entregue em', started: 'Início',
    },
  },
  pickers: {
    moveUp: 'Mover para cima',
    moveDown: 'Mover para baixo',
    groupsTitle: 'Mostrar grupos',
    groupsTrigger: 'Grupos',
    groupsNote: 'Arraste um grupo marcado, ou use ▲▼, para reordenar as faixas. As tarefas de um grupo oculto continuam lá.',
    columnsTitle: 'Colunas',
    columnsTrigger: 'Colunas',
    columnsNote: 'Arraste uma coluna marcada, ou use ▲▼, para reordená-la — a tabela segue essa ordem.',
    boardColumnsTitle: 'Colunas do quadro',
    boardColumnsTrigger: 'Colunas',
    boardColumnsNote:
      'Arraste uma coluna marcada, ou use ▲▼, para reordenar o fluxo. As tarefas de uma coluna oculta continuam lá.',
  },
}

export function boardCopy(lang: Lang): BoardCopy {
  return lang === 'pt' ? PT : EN
}

/**
 * The status word alone, which is what most cells need.
 *
 * `statuses` is the board's LIVE list (`lib/tasks.ts`'s `useTaskStatuses`) — when it is passed and
 * carries the id, its own `label` wins, because that is the one place a status's real name lives
 * now: a person can rename `done` to "Finalizado" via `ManageStatusesModal`, and this table's fixed
 * PT/EN words must not keep overriding that choice back to "Entregue" forever. The fixed table below
 * is only the fallback for the brief window before that list has loaded (`statuses` omitted or
 * `null`) and for a caller that has no list to pass at all — unknown ids still render as themselves.
 */
export function statusLabel(
  status: string, lang: Lang, statuses?: readonly { id: string; label: string }[] | null,
): string {
  const live = statuses?.find(s => s.id === status)
  if (live) return live.label
  return boardCopy(lang).status[status] ?? status
}

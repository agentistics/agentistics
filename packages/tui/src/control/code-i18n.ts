/**
 * code-i18n.ts — the words the `code` tab owns (EN/PT).
 *
 * Its own table rather than more keys on `ControlStrings`, because nothing else reads these and
 * `i18n.ts` is already two thousand lines of two languages that must stay in step: a screen whose
 * strings live beside it is a screen whose PT half cannot be forgotten in a file nobody opened.
 * The ONE thing that does belong to `i18n.ts` is the tab's name (`tabs.code` / `tabsShort.code`),
 * because the tab bar reads every name from there.
 *
 * Division of labour, same as everywhere in this package: anything the HOST says — a refusal, a
 * started-session sentence, the policy's options and reasons, the no-model sentence — arrives
 * already localized and is printed as it came. What lives here is the chrome around it.
 */

import type { CliLang } from './lang'

export interface CodeStrings {
  // ── empty states, in words (GL-06: nothing silently inert) ─────────────────────────────────
  unavailableBuild: string
  noSession: string
  loading: string

  // ── CD-01 header ─────────────────────────────────────────────────────────────────────────
  headerSession: string
  headerNoSession: string
  /** D-TUI-9: the one part of the header no width may drop. */
  noSandbox: string
  mode: string
  notFiled: string

  // ── the conversation ─────────────────────────────────────────────────────────────────────
  you: string
  assistant: string
  toolRunning: string
  toolNeedsYou: string
  toolDenied: string
  toolFailed: string
  moreChanged: (k: number) => string
  answered: (label: string) => string
  askTimeout: string
  askCancelled: string
  olderAbove: (n: number) => string

  // ── CD-07 / CD-09 permission card ────────────────────────────────────────────────────────
  permTitle: (tool: string) => string
  questionTitle: string
  fullDiffTitle: (tool: string) => string
  needsYou: string
  runsAsYou: string
  noSandboxWord: string
  cwd: string
  askedBecause: string
  checkpoint: string
  moreLines: (k: number) => string
  fullDiffKey: string
  hunks: (n: number) => string
  fileOp: Record<'add' | 'update' | 'delete' | 'overwrite', string>

  // ── CD-11 composer ───────────────────────────────────────────────────────────────────────
  /** The composer frame's title — a frame with an empty title draws a gap in its border. */
  composerTitle: string
  placeholder: string
  locked: (n: number) => string
  closed: (sentence: string) => string
  hintAt: string
  hintBang: string
  popupTitle: string
  commandDescriptions: Record<CodeCommandIdForStrings, string>

  // ── CD-12 session panel ──────────────────────────────────────────────────────────────────
  panelTitle: string
  panelEmpty: string
  context: string
  window: (tokens: string) => string
  contextNoReading: string
  contextNoWindow: string
  spend: string
  apiEquivalent: string
  thisTurn: string
  sessionSpend: string
  unpriced: (n: number) => string
  tokens: string
  tokIn: string
  tokOut: string
  cacheRead: string
  cacheWrite: string
  cacheHit: string
  files: string
  plan: string
  turn: (n: number) => string
  stateWorking: string
  stateIdle: string
  stateEnded: string
  na: string
  /** The narrow terminal's one-line stand-in for the panel (D-TUI-10). */
  statusCtx: string

  // ── NW-01 / NW-06 wizard ─────────────────────────────────────────────────────────────────
  wizardTitle: string
  stepTask: string
  stepReview: string
  whichTask: string
  whichTaskNote: string
  newTaskRow: string
  newTaskLabel: string
  newTaskHelp: string
  loadingTasks: string
  noOpenTasks: string
  review: string
  fieldTask: string
  fieldAssistant: string
  fieldModel: string
  fieldFolder: string
  fieldFirst: string
  none: string
  assistantNative: string
  fromFlag: string
  fromLastSession: string
  noSandboxReview: string

  // ── status sentences the TAB composes (the host composes the rest) ───────────────────────
  sayEmptyTitle: string
  sayNothingRunning: string
  sayNoDiff: string
  sayNoSuchCommand: (text: string) => string
  sayAnswerFirst: string
  sayStarting: string
  sayCreatingTask: string
  /** The task exists now — the review step no longer says it is being created. */
  sayTaskCreated: (ref: string, title: string) => string
  sayLoadingDefaults: string
  sayNoSessionForCommand: string

  // ── footer hints (GL-05) ─────────────────────────────────────────────────────────────────
  keySend: string
  keyStartWith: string
  keyTabs: string
  keyCommands: string
  keyHistory: string
  keyPanel: string
  keyPanelBack: string
  keyNew: string
  keyQuit: string
  keyCancelRun: string
  keyClear: string
  keyAnswer: (n: number) => string
  keyFullDiff: string
  keyDeny: string
  keyDismiss: string
  keyScroll: string
  keyBack: string
  keyChoose: string
  keyRun: string
  keyNext: string
  keyClose: string
  keyCreate: string
  keyStart: string
}

/** Mirrors `CodeCommandId` in `code.ts` — declared here too so this file stays import-free. */
export type CodeCommandIdForStrings = 'new' | 'diff' | 'cancel' | 'panel'

const EN: CodeStrings = {
  unavailableBuild: 'The native runtime is not available in this build.',
  noSession: 'No native session open — n starts one (the task comes first).',
  loading: 'loading…',

  headerSession: 'session',
  headerNoSession: 'no native session open',
  noSandbox: '▲ no sandbox',
  mode: 'mode',
  notFiled: 'not filed under a task',

  you: 'you',
  assistant: 'agentistics',
  toolRunning: 'running…',
  toolNeedsYou: 'needs you',
  toolDenied: 'denied',
  toolFailed: 'failed',
  moreChanged: k => `+ ${k} more changed line${k === 1 ? '' : 's'}`,
  answered: label => `answered: ${label}`,
  askTimeout: 'the question timed out — nothing ran, and that counts as a denial',
  askCancelled: 'the question was withdrawn before anyone answered',
  olderAbove: n => `· · · ${n} line${n === 1 ? '' : 's'} above · pgup scrolls · · ·`,

  permTitle: tool => `permission · ${tool}`,
  questionTitle: 'question',
  fullDiffTitle: tool => `permission · ${tool} · full diff`,
  needsYou: 'needs you',
  runsAsYou: 'runs as you',
  noSandboxWord: 'no sandbox',
  cwd: 'cwd',
  askedBecause: 'asked because:',
  checkpoint: 'a checkpoint is saved before this writes',
  moreLines: k => `+ ${k} more line${k === 1 ? '' : 's'}`,
  fullDiffKey: 'd full diff',
  hunks: n => `${n} hunk${n === 1 ? '' : 's'}`,
  fileOp: { add: 'new file', update: 'edit', delete: 'delete', overwrite: 'overwrite' },

  composerTitle: 'message',
  placeholder: 'ask anything · @ file · / command · ! shell',
  locked: n => `answer the permission above (1–${n}) · esc denies it`,
  closed: sentence => `${sentence} · n starts a new session`,
  hintAt: '@ paths are passed to the agent as text — nothing is attached',
  hintBang: '! is sent to the agent as a shell request — it asks through the same permission card',
  popupTitle: 'commands',
  commandDescriptions: {
    new: 'start a session (a task is required)',
    diff: 'the full diff of the open permission',
    cancel: 'cancel the run in progress',
    panel: 'show or hide the session panel',
  },

  panelTitle: 'session',
  panelEmpty: 'Nothing to measure yet — no session is open here.',
  context: 'CONTEXT',
  window: t => `${t} window`,
  contextNoReading: 'N/A — no reading yet in this session',
  contextNoWindow: 'N/A — no window stated for this model',
  spend: 'SPEND',
  apiEquivalent: 'api-equivalent',
  thisTurn: 'this turn',
  sessionSpend: 'session',
  unpriced: n => `${n} call${n === 1 ? '' : 's'} unpriced`,
  tokens: 'TOKENS',
  tokIn: 'in',
  tokOut: 'out',
  cacheRead: 'cache read',
  cacheWrite: 'write',
  cacheHit: 'cache hit',
  files: 'FILES',
  plan: 'PLAN',
  turn: n => `turn ${n}`,
  stateWorking: 'working',
  stateIdle: 'waiting for you',
  stateEnded: 'ended',
  na: 'N/A',
  statusCtx: 'ctx',

  wizardTitle: 'new session',
  stepTask: 'task',
  stepReview: 'review',
  whichTask: 'Which task is this session for?',
  whichTaskNote: '(required — every session is tracked)',
  newTaskRow: 'new task…',
  newTaskLabel: 'new task title:',
  newTaskHelp: 'enter creates it as "to do" · esc goes back to the list',
  loadingTasks: 'loading the open tasks…',
  noOpenTasks: 'No open tasks on this board — "new task…" creates one.',
  review: 'Review',
  fieldTask: 'task',
  fieldAssistant: 'assistant',
  fieldModel: 'model',
  fieldFolder: 'folder',
  fieldFirst: 'first message',
  none: 'none',
  assistantNative: 'agentistics (native)',
  fromFlag: 'from --model',
  fromLastSession: 'from your last session',
  noSandboxReview: '▲ no sandbox: tools run as you in that folder; everything not allowlisted asks first',

  sayEmptyTitle: 'A task needs a title.',
  sayNothingRunning: 'Nothing is running, so there is nothing to cancel.',
  sayNoDiff: 'No open permission carries a diff.',
  sayNoSuchCommand: t => `No such command: ${t}. Type / to see the ones that exist.`,
  sayAnswerFirst: 'Answer the permission first — 1 to n picks an option, esc denies it.',
  sayStarting: 'Starting the session…',
  sayCreatingTask: 'Creating the task…',
  sayTaskCreated: (ref, title) => `Created ${ref} "${title}" as to do.`,
  sayLoadingDefaults: 'Still reading the model and folder — press enter again in a moment.',
  sayNoSessionForCommand: 'No native session is open.',

  keySend: 'enter send',
  keyStartWith: 'enter start a session with this',
  keyTabs: '[ ] tabs',
  keyCommands: '/ commands',
  keyHistory: 'pgup history',
  keyPanel: 'ctrl+b panel',
  keyPanelBack: 'esc back',
  keyNew: 'n new session',
  keyQuit: 'ctrl+c quit',
  keyCancelRun: 'esc cancel run',
  keyClear: 'esc clear',
  keyAnswer: n => `1-${n} answer`,
  keyFullDiff: 'd full diff',
  keyDeny: 'esc deny',
  keyDismiss: 'esc dismiss',
  keyScroll: '↑↓/pg scroll',
  keyBack: 'esc back',
  keyChoose: '↑↓ choose',
  keyRun: 'enter run',
  keyNext: 'enter next',
  keyClose: 'esc close',
  keyCreate: 'enter create',
  keyStart: 'enter start',
}

const PT: CodeStrings = {
  unavailableBuild: 'O runtime nativo não está disponível nesta build.',
  noSession: 'Nenhuma sessão nativa aberta — n inicia uma (a task vem primeiro).',
  loading: 'carregando…',

  headerSession: 'sessão',
  headerNoSession: 'nenhuma sessão nativa aberta',
  noSandbox: '▲ sem sandbox',
  mode: 'modo',
  notFiled: 'sem task',

  you: 'você',
  assistant: 'agentistics',
  toolRunning: 'rodando…',
  toolNeedsYou: 'precisa de você',
  toolDenied: 'negada',
  toolFailed: 'falhou',
  moreChanged: k => `+ ${k} linha${k === 1 ? '' : 's'} alterada${k === 1 ? '' : 's'}`,
  answered: label => `respondida: ${label}`,
  askTimeout: 'a pergunta expirou — nada rodou, e isso conta como negação',
  askCancelled: 'a pergunta foi retirada antes de alguém responder',
  olderAbove: n => `· · · ${n} linha${n === 1 ? '' : 's'} acima · pgup rola · · ·`,

  permTitle: tool => `permissão · ${tool}`,
  questionTitle: 'pergunta',
  fullDiffTitle: tool => `permissão · ${tool} · diff completo`,
  needsYou: 'precisa de você',
  runsAsYou: 'roda como você',
  noSandboxWord: 'sem sandbox',
  cwd: 'cwd',
  askedBecause: 'perguntou porque:',
  checkpoint: 'um checkpoint é salvo antes desta escrita',
  moreLines: k => `+ ${k} linha${k === 1 ? '' : 's'}`,
  fullDiffKey: 'd diff completo',
  hunks: n => `${n} trecho${n === 1 ? '' : 's'}`,
  fileOp: { add: 'arquivo novo', update: 'edição', delete: 'remoção', overwrite: 'sobrescrita' },

  composerTitle: 'mensagem',
  placeholder: 'pergunte qualquer coisa · @ arquivo · / comando · ! shell',
  locked: n => `responda a permissão acima (1–${n}) · esc nega`,
  closed: sentence => `${sentence} · n inicia uma nova sessão`,
  hintAt: 'caminhos com @ vão para o agente como texto — nada é anexado',
  hintBang: '! vai para o agente como pedido de shell — passa pelo mesmo cartão de permissão',
  popupTitle: 'comandos',
  commandDescriptions: {
    new: 'iniciar uma sessão (a task é obrigatória)',
    diff: 'o diff completo da permissão aberta',
    cancel: 'cancelar a execução em andamento',
    panel: 'mostrar ou esconder o painel da sessão',
  },

  panelTitle: 'sessão',
  panelEmpty: 'Nada a medir ainda — nenhuma sessão aberta aqui.',
  context: 'CONTEXTO',
  window: t => `janela de ${t}`,
  contextNoReading: 'N/A — ainda sem leitura nesta sessão',
  contextNoWindow: 'N/A — janela não informada para este modelo',
  spend: 'GASTO',
  apiEquivalent: 'equivalente à API',
  thisTurn: 'este turno',
  sessionSpend: 'sessão',
  unpriced: n => `${n} chamada${n === 1 ? '' : 's'} sem preço`,
  tokens: 'TOKENS',
  tokIn: 'entrada',
  tokOut: 'saída',
  cacheRead: 'cache lido',
  cacheWrite: 'escrito',
  cacheHit: 'acerto de cache',
  files: 'ARQUIVOS',
  plan: 'PLANO',
  turn: n => `turno ${n}`,
  stateWorking: 'trabalhando',
  stateIdle: 'esperando você',
  stateEnded: 'encerrada',
  na: 'N/A',
  statusCtx: 'ctx',

  wizardTitle: 'nova sessão',
  stepTask: 'task',
  stepReview: 'revisão',
  whichTask: 'Esta sessão é para qual task?',
  whichTaskNote: '(obrigatório — toda sessão é rastreada)',
  newTaskRow: 'nova task…',
  newTaskLabel: 'título da nova task:',
  newTaskHelp: 'enter cria como "a fazer" · esc volta para a lista',
  loadingTasks: 'carregando as tasks abertas…',
  noOpenTasks: 'Nenhuma task aberta neste quadro — "nova task…" cria uma.',
  review: 'Revisão',
  fieldTask: 'task',
  fieldAssistant: 'assistente',
  fieldModel: 'modelo',
  fieldFolder: 'pasta',
  fieldFirst: 'primeira mensagem',
  none: 'nenhuma',
  assistantNative: 'agentistics (nativo)',
  fromFlag: 'do --model',
  fromLastSession: 'da sua última sessão',
  noSandboxReview: '▲ sem sandbox: as ferramentas rodam como você nessa pasta; tudo fora da allowlist pergunta antes',

  sayEmptyTitle: 'Uma task precisa de um título.',
  sayNothingRunning: 'Nada está rodando, então não há o que cancelar.',
  sayNoDiff: 'Nenhuma permissão aberta traz um diff.',
  sayNoSuchCommand: t => `Comando inexistente: ${t}. Digite / para ver os que existem.`,
  sayAnswerFirst: 'Responda a permissão primeiro — 1 a n escolhe uma opção, esc nega.',
  sayStarting: 'Iniciando a sessão…',
  sayCreatingTask: 'Criando a task…',
  sayTaskCreated: (ref, title) => `Criei ${ref} "${title}" como a fazer.`,
  sayLoadingDefaults: 'Ainda lendo o modelo e a pasta — aperte enter de novo em instantes.',
  sayNoSessionForCommand: 'Nenhuma sessão nativa está aberta.',

  keySend: 'enter enviar',
  keyStartWith: 'enter iniciar sessão com isto',
  keyTabs: '[ ] abas',
  keyCommands: '/ comandos',
  keyHistory: 'pgup histórico',
  keyPanel: 'ctrl+b painel',
  keyPanelBack: 'esc voltar',
  keyNew: 'n nova sessão',
  keyQuit: 'ctrl+c sair',
  keyCancelRun: 'esc cancelar',
  keyClear: 'esc limpar',
  keyAnswer: n => `1-${n} responder`,
  keyFullDiff: 'd diff completo',
  keyDeny: 'esc negar',
  keyDismiss: 'esc dispensar',
  keyScroll: '↑↓/pg rolar',
  keyBack: 'esc voltar',
  keyChoose: '↑↓ escolher',
  keyRun: 'enter executar',
  keyNext: 'enter avançar',
  keyClose: 'esc fechar',
  keyCreate: 'enter criar',
  keyStart: 'enter iniciar',
}

const TABLE: Record<CliLang, CodeStrings> = { en: EN, pt: PT }

export function codeStrings(lang: CliLang): CodeStrings {
  return TABLE[lang]
}

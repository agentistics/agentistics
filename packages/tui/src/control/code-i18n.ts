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
import type { CodeModeId } from './code-types'

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

  // ── CD-15 / CD-16: mode and session rules ───────────────────────────────────────────────
  /** The prototype's words for the runtime's profile ids. */
  modeWords: Record<CodeModeId, string>
  modeChangeHint: string
  sessionRules: string
  untilSessionEnds: string
  allowWord: string

  // ── CD-05 / CD-06 / CD-10: turns, receipts, long output ─────────────────────────────────
  toolsCount: (n: number) => string
  ttft: string
  tokWord: string
  cacheWord: string
  outputFolded: (total: number) => string
  outputExpands: string
  outputCollapses: string
  moreOutputLines: (n: number) => string

  // ── the swapping panel: CD-13 inspector, CD-14 timeline ─────────────────────────────────
  panelSides: Record<'session' | 'inspector' | 'timeline', string>
  inspectorEmpty: string
  inspectorPick: string
  inspTurn: (n: number) => string
  inspModel: string
  inspStop: string
  inspTtftRate: string
  inspLive: string
  inspHistoric: string
  tokPerSec: (n: number) => string
  request: string
  tokensCost: string
  reqInput: string
  reqCacheRead: string
  reqCacheWrite: string
  reqOutput: string
  total: string
  contextAfter: string
  toolsInTurn: string
  noTools: string
  outcomeOk: string
  outcomeWaiting: string
  policy: string
  polNone: string
  polAllowed: (rule: string) => string
  polAsked: (choice?: string) => string
  polWaiting: string
  polDenied: (by: string, code?: string) => string
  byYou: string
  byPolicy: string
  timelineEmpty: string
  timelineNoRun: string
  runN: (n: number) => string
  runEnded: string
  modelN: (n: number) => string
  youRow: string
  legendModel: string
  legendTool: string
  legendYou: string
  whereTime: string
  timeModel: string
  timeTools: string
  timeWaiting: string
  money: string
  thisRun: string
  modelCalls: string

  // ── CD-17 / CD-18 / CD-19 ───────────────────────────────────────────────────────────────
  editorOpen: string
  histTitle: string
  histLoading: string
  histNone: string
  histNoMatch: string
  histFoot: string

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
  // ── NW-02…NW-05 ──
  stepAssistant: string
  stepModel: string
  stepFolder: string
  stepPrompt: string
  whichAssistant: string
  whichAssistantNote: string
  whichModel: string
  whichFolder: string
  firstMessageTitle: string
  firstMessageHint: string
  loadingAssistants: string
  loadingModels: string
  loadingFolders: string
  noAssistants: string
  cliDefault: string
  cliDefaultNote: string
  newWorktreeOf: (repo: string) => string
  newWorktreeNote: string
  sayCreatingWorktree: string
  sayStartingHarness: (label: string) => string
  nativeAssistantNote: string
  harnessAssistantNote: string

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
  sayLocked: string
  sayNoSessionForMode: string
  /** The engine's code host offers no mode switch (an optional port member). */
  sayModeFixed: (mode: string) => string
  /** The host offers no `$EDITOR` door. */
  sayNoEditor: string
  /** The engine's code host keeps no prompt history (an optional port member). */
  sayNoHistory: string
  sayNoLongOutput: string
  sayHistoryUsed: string
  sayCopied: (chars: number, inTmux: boolean) => string
  sayNothingToCopy: string
  sayCopyTooLong: (chars: number, max: number) => string

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
  /** CD-08: the extra option after the policy's Deny, and the reason field it opens. */
  reasonOption: string
  reasonOptionHint: string
  reasonPrompt: string
  reasonPlaceholder: string
  keyReasonSend: string
  keyReasonBack: string
  sayReasonEmpty: string
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
  keyMode: string
  keyInspector: string
  keyTimeline: string
  keyInspectorBack: string
  keyTimelineBack: string
  keyTurn: string
  keyOutput: string
  keyPromptHistory: string
  keyEditor: string
  keyHelp: string
  keyFilter: string
  keyPanelScroll: string
  keyPanelPage: string
  panelAbove: (n: number) => string
  panelBelow: (n: number, full: boolean) => string
  keyUse: string
}

/** Mirrors `CodeCommandId` in `code.ts` — declared here too so this file stays import-free. */
export type CodeCommandIdForStrings = 'new' | 'diff' | 'cancel' | 'panel' | 'mode' | 'inspector' | 'timeline' | 'editor' | 'history' | 'copy'

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
    mode: 'permission mode: ask · edits · plan',
    inspector: 'the selected turn, in detail',
    timeline: 'where this run spent time and money',
    editor: 'compose the prompt in $EDITOR',
    history: 'search your earlier prompts',
    copy: 'copy the last answer (OSC 52)',
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

  modeWords: { default: 'ask', 'accept-edits': 'edits', plan: 'plan' },
  modeChangeHint: 'shift+tab changes it',
  sessionRules: 'SESSION RULES',
  untilSessionEnds: 'until the session ends',
  allowWord: 'allow',

  toolsCount: n => `${n} tool${n === 1 ? '' : 's'}`,
  ttft: 'ttft',
  tokWord: 'tok',
  cacheWord: 'cache',
  outputFolded: n => `${n} lines of output`,
  outputExpands: 'expands',
  outputCollapses: 'collapses',
  moreOutputLines: n => `${n} more line${n === 1 ? '' : 's'}`,

  panelSides: { session: 'session', inspector: 'inspector', timeline: 'timeline' },
  inspectorEmpty: 'Nothing to inspect yet — no turn has happened in this session.',
  inspectorPick: '↑↓ picks the turn',
  inspTurn: n => `TURN ${n}`,
  inspModel: 'model',
  inspStop: 'stop',
  inspTtftRate: 'ttft · rate',
  inspLive: 'live',
  inspHistoric: 'A turn read from the stored history: nothing about its time, tokens or cost was recorded here.',
  tokPerSec: n => `${n} tok/s`,
  request: 'REQUEST',
  tokensCost: 'tokens · cost',
  reqInput: 'input',
  reqCacheRead: 'cache read',
  reqCacheWrite: 'cache write',
  reqOutput: 'output',
  total: 'total',
  contextAfter: 'CONTEXT AFTER',
  toolsInTurn: 'TOOLS IN THIS TURN',
  noTools: 'no tool ran in this turn',
  outcomeOk: 'ok',
  outcomeWaiting: 'waiting',
  policy: 'POLICY',
  polNone: 'no decision recorded',
  polAllowed: rule => `allowed · ${rule}`,
  polAsked: choice => (choice ? `asked → you: ${choice}` : 'asked → you'),
  polWaiting: 'asked · waiting',
  polDenied: (by, code) => `denied by ${by}${code ? ` (${code})` : ''}`,
  byYou: 'you',
  byPolicy: 'policy',
  timelineEmpty: 'No run to draw yet — nothing has run in this session.',
  timelineNoRun: 'No run was recorded for this turn, so there is nothing to draw.',
  runN: n => `RUN ${n}`,
  runEnded: 'ended',
  modelN: n => `model ${n}`,
  youRow: 'you',
  legendModel: 'model',
  legendTool: 'tool',
  legendYou: 'you',
  whereTime: 'WHERE THE TIME WENT',
  timeModel: 'model',
  timeTools: 'tools',
  timeWaiting: 'waiting on you',
  money: 'MONEY',
  thisRun: 'this run',
  modelCalls: 'model calls',

  editorOpen: 'editing the draft in $EDITOR — save and quit to bring it back',
  histTitle: 'prompt history',
  histLoading: 'reading your earlier prompts…',
  histNone: 'No earlier prompts on this machine yet.',
  histNoMatch: 'No earlier prompt matches that.',
  histFoot: 'newest first · enter puts it in the composer · esc closes',

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
  stepAssistant: 'assistant',
  stepModel: 'model',
  stepFolder: 'folder',
  stepPrompt: 'prompt',
  whichAssistant: 'Which assistant?',
  whichAssistantNote: '(only the ones installed here)',
  whichModel: 'Which model?',
  whichFolder: 'Where does it work?',
  firstMessageTitle: 'First message',
  firstMessageHint: 'optional · enter continues',
  loadingAssistants: 'reading which assistants are installed…',
  loadingModels: 'reading the models…',
  loadingFolders: 'reading your repositories…',
  noAssistants: 'No assistant can start on this machine.',
  cliDefault: 'the CLI default',
  cliDefaultNote: 'no model flag passed',
  newWorktreeOf: repo => `${repo}  in a new worktree`,
  newWorktreeNote: 'a new branch + folder for this task',
  sayCreatingWorktree: 'Creating the worktree…',
  sayStartingHarness: label => `Starting ${label}…`,
  nativeAssistantNote: 'streams here · the policy asks · no sandbox',
  harnessAssistantNote: 'tmux · attach to drive',

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
  sayLocked: 'Answer the permission first: the composer is locked while it waits.',
  sayNoSessionForMode: 'No native session is open — the permission mode belongs to a session.',
  sayModeFixed: mode => `This engine cannot switch the permission mode here — the session stays in ${mode}.`,
  sayNoEditor: 'Opening the draft in $EDITOR is not available here.',
  sayNoHistory: 'This engine keeps no prompt history to search here.',
  sayNoLongOutput: 'No long output on screen — nothing to expand.',
  sayHistoryUsed: 'Put back in the composer: edit it, then enter sends.',
  sayCopied: (n, tmux) => `Copied ${n} character${n === 1 ? '' : 's'} (OSC 52). Some terminals ignore OSC 52 (e.g. GNOME Terminal/VTE)${tmux ? '; inside tmux it reaches your clipboard only with `set -g set-clipboard on`' : ''}.`,
  sayNothingToCopy: 'Nothing to copy yet — no answer has finished.',
  sayCopyTooLong: (n, max) => `The last answer is ${n} characters; terminals cap OSC 52 far below that, so nothing was copied (the limit here is ${max}).`,

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
  reasonOption: 'Deny with a reason…',
  reasonOptionHint: 'the agent reads why',
  reasonPrompt: 'reason: ',
  reasonPlaceholder: 'why not — the agent reads it with the denial',
  keyReasonSend: 'enter send the denial with your reason',
  keyReasonBack: 'esc back to the options',
  sayReasonEmpty: 'Type the reason first — or esc to go back to the options.',
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
  keyMode: 'shift+tab mode',
  keyInspector: 'ctrl+i/tab inspector',
  keyTimeline: 'ctrl+t timeline',
  keyInspectorBack: 'ctrl+i/tab session',
  keyTimelineBack: 'ctrl+t session',
  keyTurn: '↑↓ turn',
  keyOutput: 'ctrl+o output',
  keyPromptHistory: 'ctrl+r prompts',
  keyEditor: 'ctrl+g editor',
  keyHelp: '? help',
  keyFilter: 'type to filter',
  keyPanelScroll: 'shift+↑↓ panel',
  keyPanelPage: 'pgup/pgdn scroll',
  panelAbove: n => `▲ ${n} more above · shift+↑`,
  panelBelow: (n, full) => `▼ ${n} more below · ${full ? 'pgdn' : 'shift+↓'}`,
  keyUse: 'enter use it',
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
    mode: 'modo de permissão: perguntar · edições · plano',
    inspector: 'o turno selecionado, em detalhe',
    timeline: 'onde esta execução gastou tempo e dinheiro',
    editor: 'escrever o prompt no $EDITOR',
    history: 'buscar seus prompts anteriores',
    copy: 'copiar a última resposta (OSC 52)',
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

  modeWords: { default: 'perguntar', 'accept-edits': 'edições', plan: 'plano' },
  modeChangeHint: 'shift+tab troca',
  sessionRules: 'REGRAS DA SESSÃO',
  untilSessionEnds: 'até a sessão terminar',
  allowWord: 'permitir',

  toolsCount: n => `${n} ferramenta${n === 1 ? '' : 's'}`,
  ttft: 'ttft',
  tokWord: 'tok',
  cacheWord: 'cache',
  outputFolded: n => `${n} linhas de saída`,
  outputExpands: 'expande',
  outputCollapses: 'recolhe',
  moreOutputLines: n => `mais ${n} linha${n === 1 ? '' : 's'}`,

  panelSides: { session: 'sessão', inspector: 'inspetor', timeline: 'cronologia' },
  inspectorEmpty: 'Nada a inspecionar ainda — nenhum turno aconteceu nesta sessão.',
  inspectorPick: '↑↓ escolhe o turno',
  inspTurn: n => `TURNO ${n}`,
  inspModel: 'modelo',
  inspStop: 'parada',
  inspTtftRate: 'ttft · taxa',
  inspLive: 'ao vivo',
  inspHistoric: 'Turno lido do histórico salvo: nada sobre o tempo, os tokens ou o custo dele foi registrado aqui.',
  tokPerSec: n => `${n} tok/s`,
  request: 'REQUISIÇÃO',
  tokensCost: 'tokens · custo',
  reqInput: 'entrada',
  reqCacheRead: 'cache lido',
  reqCacheWrite: 'cache escrito',
  reqOutput: 'saída',
  total: 'total',
  contextAfter: 'CONTEXTO DEPOIS',
  toolsInTurn: 'FERRAMENTAS NESTE TURNO',
  noTools: 'nenhuma ferramenta rodou neste turno',
  outcomeOk: 'ok',
  outcomeWaiting: 'esperando',
  policy: 'POLÍTICA',
  polNone: 'nenhuma decisão registrada',
  polAllowed: rule => `permitida · ${rule}`,
  polAsked: choice => (choice ? `perguntou → você: ${choice}` : 'perguntou → você'),
  polWaiting: 'perguntou · esperando',
  polDenied: (by, code) => `negada por ${by}${code ? ` (${code})` : ''}`,
  byYou: 'você',
  byPolicy: 'política',
  timelineEmpty: 'Nenhuma execução para desenhar ainda — nada rodou nesta sessão.',
  timelineNoRun: 'Nenhuma execução foi registrada para este turno, então não há o que desenhar.',
  runN: n => `EXECUÇÃO ${n}`,
  runEnded: 'encerrada',
  modelN: n => `modelo ${n}`,
  youRow: 'você',
  legendModel: 'modelo',
  legendTool: 'ferramenta',
  legendYou: 'você',
  whereTime: 'ONDE O TEMPO FOI',
  timeModel: 'modelo',
  timeTools: 'ferramentas',
  timeWaiting: 'esperando você',
  money: 'DINHEIRO',
  thisRun: 'esta execução',
  modelCalls: 'chamadas ao modelo',

  editorOpen: 'editando o rascunho no $EDITOR — salve e saia para trazê-lo de volta',
  histTitle: 'histórico de prompts',
  histLoading: 'lendo seus prompts anteriores…',
  histNone: 'Nenhum prompt anterior nesta máquina ainda.',
  histNoMatch: 'Nenhum prompt anterior corresponde a isso.',
  histFoot: 'mais novos primeiro · enter coloca no compositor · esc fecha',

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
  stepAssistant: 'assistente',
  stepModel: 'modelo',
  stepFolder: 'pasta',
  stepPrompt: 'mensagem',
  whichAssistant: 'Qual assistente?',
  whichAssistantNote: '(só os instalados aqui)',
  whichModel: 'Qual modelo?',
  whichFolder: 'Onde ela trabalha?',
  firstMessageTitle: 'Primeira mensagem',
  firstMessageHint: 'opcional · enter continua',
  loadingAssistants: 'lendo quais assistentes estão instalados…',
  loadingModels: 'lendo os modelos…',
  loadingFolders: 'lendo seus repositórios…',
  noAssistants: 'Nenhum assistente pode iniciar nesta máquina.',
  cliDefault: 'o padrão da CLI',
  cliDefaultNote: 'nenhuma flag de modelo',
  newWorktreeOf: repo => `${repo}  numa worktree nova`,
  newWorktreeNote: 'um branch + pasta novos para esta tarefa',
  sayCreatingWorktree: 'Criando a worktree…',
  sayStartingHarness: label => `Iniciando ${label}…`,
  nativeAssistantNote: 'transmite aqui · a política pergunta · sem sandbox',
  harnessAssistantNote: 'tmux · anexe para conduzir',

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
  sayLocked: 'Responda a permissão primeiro: o compositor fica travado enquanto ela espera.',
  sayNoSessionForMode: 'Nenhuma sessão nativa aberta — o modo de permissão pertence a uma sessão.',
  sayModeFixed: mode => `Este engine não troca o modo de permissão aqui — a sessão segue em ${mode}.`,
  sayNoEditor: 'Abrir o rascunho no $EDITOR não está disponível aqui.',
  sayNoHistory: 'Este engine não guarda histórico de prompts para buscar aqui.',
  sayNoLongOutput: 'Nenhuma saída longa na tela — nada a expandir.',
  sayHistoryUsed: 'De volta no compositor: edite, depois enter envia.',
  sayCopied: (n, tmux) => `Copiei ${n} caractere${n === 1 ? '' : 's'} (OSC 52). Alguns terminais ignoram OSC 52 (ex.: GNOME Terminal/VTE)${tmux ? '; dentro do tmux só chega ao seu clipboard com `set -g set-clipboard on`' : ''}.`,
  sayNothingToCopy: 'Nada para copiar ainda — nenhuma resposta terminou.',
  sayCopyTooLong: (n, max) => `A última resposta tem ${n} caracteres; os terminais limitam o OSC 52 bem abaixo disso, então nada foi copiado (o limite aqui é ${max}).`,

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
  reasonOption: 'Negar com um motivo…',
  reasonOptionHint: 'o agente lê o porquê',
  reasonPrompt: 'motivo: ',
  reasonPlaceholder: 'por que não — o agente lê junto com a negação',
  keyReasonSend: 'enter envia a negação com o seu motivo',
  keyReasonBack: 'esc volta às opções',
  sayReasonEmpty: 'Escreva o motivo primeiro — ou esc para voltar às opções.',
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
  keyMode: 'shift+tab modo',
  keyInspector: 'ctrl+i/tab inspetor',
  keyTimeline: 'ctrl+t cronologia',
  keyInspectorBack: 'ctrl+i/tab sessão',
  keyTimelineBack: 'ctrl+t sessão',
  keyTurn: '↑↓ turno',
  keyOutput: 'ctrl+o saída',
  keyPromptHistory: 'ctrl+r prompts',
  keyEditor: 'ctrl+g editor',
  keyHelp: '? ajuda',
  keyFilter: 'digite para filtrar',
  keyPanelScroll: 'shift+↑↓ painel',
  keyPanelPage: 'pgup/pgdn rolar',
  panelAbove: n => `▲ mais ${n} acima · shift+↑`,
  panelBelow: (n, full) => `▼ mais ${n} abaixo · ${full ? 'pgdn' : 'shift+↓'}`,
  keyUse: 'enter usar',
}

const TABLE: Record<CliLang, CodeStrings> = { en: EN, pt: PT }

export function codeStrings(lang: CliLang): CodeStrings {
  return TABLE[lang]
}

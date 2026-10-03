/**
 * palette.ts — PURE: the command palette (GL-03, D-TUI-12). `ctrl+p` opens a filterable list of
 * EVERY command with its shortcut; enter runs one; a command that cannot run here stays in the list
 * and says WHY (never vanishes — a list that changes shape depending on state teaches nothing).
 *
 * ONE command list: the `code` tab's `/` popup is this list's `code` scope (`codeScoped`), so a
 * command has one name, one description and one shortcut wherever it is offered.
 */
import type { CodeIntent } from './code'
import type { TabId } from './types'

type W = { en: string; pt: string }
const w = (en: string, pt: string): W => ({ en, pt })

export type PaletteRun =
  | { kind: 'tab'; tab: TabId }
  | { kind: 'help' }
  | { kind: 'quit' }
  | { kind: 'lang' }
  /** A `code` tab intent: the palette switches to `code` and the tab performs it. */
  | { kind: 'code'; intent: CodeIntent; needs?: 'session' | 'ask-diff' | 'running' }
  /** A command whose screen is not built yet (settings, P5): listed, refused in words. */
  | { kind: 'later'; why: W }

export interface PaletteCommand {
  id: string
  label: string
  description: W
  /** The shortcut that does the same without the palette (`''` when there is none). */
  keys: string
  run: PaletteRun
  /** Offered by the `code` tab's `/` popup too. */
  code?: boolean
}

const SETTINGS_LATER = w(
  'the settings screen arrives with ST-01…ST-07 (P5) — not in this build yet',
  'a tela de configurações chega com ST-01…ST-07 (P5) — ainda não está nesta versão',
)

export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  { id: 'new', label: '/new', description: w('start a session (a task is required)', 'iniciar uma sessão (a tarefa é obrigatória)'), keys: 'n', run: { kind: 'code', intent: { kind: 'open-wizard' } }, code: true },
  { id: 'home', label: '/home', description: w('the front door: today, resume, your tasks', 'a porta de entrada: hoje, retomar, suas tarefas'), keys: '[ ]', run: { kind: 'tab', tab: 'home' } },
  { id: 'code', label: '/code', description: w('the native session workspace', 'o espaço da sessão nativa'), keys: '[ ]', run: { kind: 'tab', tab: 'code' } },
  { id: 'sessions', label: '/sessions', description: w('every session on this machine', 'todas as sessões desta máquina'), keys: 'ctrl+s', run: { kind: 'tab', tab: 'sessions' } },
  { id: 'tasks', label: '/tasks', description: w('your tasks from the board', 'suas tarefas do board'), keys: '[ ]', run: { kind: 'tab', tab: 'tasks' } },
  { id: 'resume', label: '/resume', description: w('reopen an earlier session', 'reabrir uma sessão anterior'), keys: '1-3 on home', run: { kind: 'tab', tab: 'home' } },
  { id: 'mode', label: '/mode', description: w('permission mode: ask · edits · plan', 'modo de permissão: ask · edits · plan'), keys: 'shift+tab', run: { kind: 'code', intent: { kind: 'cycle-mode' }, needs: 'session' }, code: true },
  { id: 'inspector', label: '/inspector', description: w('the selected turn, in detail', 'o turno selecionado, em detalhe'), keys: 'ctrl+i', run: { kind: 'code', intent: { kind: 'panel-side', side: 'inspector' } }, code: true },
  { id: 'timeline', label: '/timeline', description: w('where this run spent time and money', 'onde esta execução gastou tempo e dinheiro'), keys: 'ctrl+t', run: { kind: 'code', intent: { kind: 'panel-side', side: 'timeline' } }, code: true },
  { id: 'panel', label: '/panel', description: w('show or hide the session panel', 'mostrar ou esconder o painel da sessão'), keys: 'ctrl+b', run: { kind: 'code', intent: { kind: 'toggle-panel' } }, code: true },
  { id: 'diff', label: '/diff', description: w('the full diff of the change waiting on you', 'o diff completo da mudança que espera por você'), keys: 'd', run: { kind: 'code', intent: { kind: 'open-diff' }, needs: 'ask-diff' }, code: true },
  { id: 'cancel', label: '/cancel', description: w('stop the run in progress', 'parar a execução em andamento'), keys: 'esc', run: { kind: 'code', intent: { kind: 'cancel-run' }, needs: 'running' }, code: true },
  { id: 'editor', label: '/editor', description: w('compose the prompt in $EDITOR', 'escrever o prompt no $EDITOR'), keys: 'ctrl+g', run: { kind: 'code', intent: { kind: 'open-editor' }, needs: 'session' }, code: true },
  { id: 'history', label: '/history', description: w('search your earlier prompts', 'buscar seus prompts anteriores'), keys: 'ctrl+r', run: { kind: 'code', intent: { kind: 'open-history' }, needs: 'session' }, code: true },
  { id: 'copy', label: '/copy', description: w('copy the last answer (OSC 52, works over SSH)', 'copiar a última resposta (OSC 52, funciona via SSH)'), keys: '', run: { kind: 'code', intent: { kind: 'copy' }, needs: 'session' }, code: true },
  { id: 'providers', label: '/providers', description: w('keys, models and prices', 'chaves, modelos e preços'), keys: 'ctrl+,', run: { kind: 'later', why: SETTINGS_LATER } },
  { id: 'permissions', label: '/permissions', description: w('allow / ask / deny rules', 'regras allow / ask / deny'), keys: '', run: { kind: 'later', why: SETTINGS_LATER } },
  { id: 'lang', label: '/lang', description: w('english · português', 'english · português'), keys: '', run: { kind: 'lang' } },
  { id: 'dashboard', label: '/dashboard', description: w('metrics (existing screen)', 'métricas (tela existente)'), keys: '[ ]', run: { kind: 'tab', tab: 'dashboard' } },
  { id: 'services', label: '/services', description: w('server, central, logs (existing)', 'servidor, central, logs (existente)'), keys: '[ ]', run: { kind: 'tab', tab: 'services' } },
  { id: 'help', label: '/help', description: w('every key, by screen', 'todas as teclas, por tela'), keys: '?', run: { kind: 'help' } },
  { id: 'quit', label: '/quit', description: w('leave agentop', 'sair do agentop'), keys: 'ctrl+c', run: { kind: 'quit' } },
] as const

/** The `code` tab's `/` popup: this list's code-scoped commands, in the same order. */
export function codeScoped(): PaletteCommand[] {
  return PALETTE_COMMANDS.filter(c => c.code === true)
}

/** Substring match on the label or the description (in the person's language); empty = everything. */
export function filterCommands(query: string, lang: 'en' | 'pt', list: readonly PaletteCommand[] = PALETTE_COMMANDS): PaletteCommand[] {
  const q = query.trim().toLowerCase().replace(/^\//, '')
  if (!q) return [...list]
  // A name that STARTS with what was typed first, then a name that contains it, then a description —
  // so `/sess` lands on `/sessions` and the describing matches follow it, in the list's own order.
  const rank = (c: PaletteCommand): number => {
    const name = c.label.slice(1)
    if (name.startsWith(q)) return 0
    if (name.includes(q)) return 1
    return c.description[lang].toLowerCase().includes(q) || c.description.en.toLowerCase().includes(q) ? 2 : 3
  }
  return list.map((c, i) => ({ c, i, r: rank(c) })).filter(x => x.r < 3).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.c)
}

/** What the palette knows about the `code` tab right now (it reports this upward). */
export interface PaletteContext {
  hasCode: boolean
  sessionOpen: boolean
  running: boolean
  askWithDiff: boolean
  /** The native harness is experimental and off: its commands say this sentence instead. */
  gate?: string
}

const WHY = {
  noCode: w('this build has no native harness', 'esta versão não tem o harness nativo'),
  noSession: w('no native session is open — /new starts one', 'nenhuma sessão nativa aberta — /new inicia uma'),
  noAskDiff: w('nothing waits on you with a diff right now', 'nada espera por você com um diff agora'),
  notRunning: w('nothing is running', 'nada está rodando'),
}

/** Why `c` cannot run now, in words — or null when it can. */
export function whyNot(c: PaletteCommand, ctx: PaletteContext, lang: 'en' | 'pt'): string | null {
  const r = c.run
  if (r.kind === 'later') return r.why[lang]
  if (r.kind === 'tab' && r.tab === 'code' && !ctx.hasCode) return ctx.gate ?? WHY.noCode[lang]
  if (r.kind !== 'code') return null
  if (!ctx.hasCode) return ctx.gate ?? WHY.noCode[lang]
  if (r.needs === 'session' && !ctx.sessionOpen) return WHY.noSession[lang]
  if (r.needs === 'ask-diff' && !ctx.askWithDiff) return WHY.noAskDiff[lang]
  if (r.needs === 'running' && !ctx.running) return WHY.notRunning[lang]
  return null
}

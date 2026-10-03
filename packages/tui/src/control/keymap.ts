/**
 * keymap.ts — PURE: every key the control center answers, by screen (GL-04).
 *
 * This is what the `?` help overlay prints, and it is the ONE list: the footer names the handful of
 * keys that fit and work in the current focus (`cockpitHints` and each screen's own), while this is
 * the whole of it. It cannot drift from the bindings because `keymap.test.ts` holds each table to
 * the screen's own PURE resolver in both directions: every key listed here is answered by that
 * resolver in at least one state, and every key the resolver answers is listed here. The KEYS
 * column is therefore not free text — `keyProbes` parses it into the presses it stands for, and that
 * parse is what the test fires.
 *
 * Grammar of a `keys` cell: alternatives separated by ` / `, each alternative a run of tokens
 * separated by one space. A token is a named key (`enter`, `esc`, `tab`, `shift+tab`, `space`,
 * `pgup`, `pgdn`, `home`, `end`), an arrow (`↑` `↓` `←` `→`, or `↑↓` / `←→` for the pair), a chord
 * (`ctrl+x`), a digit range (`1-9`), or one literal character.
 *
 * The words are EN/PT here rather than in `i18n.ts` because each entry is a pair that must stay a
 * pair: a key and what it does, in both languages, side by side where one is edited with the other.
 */

import type { CliLang } from './lang'
import type { KeyPress } from './nav'
import type { TabId } from './types'
import { CODE_KEY_TABLE } from './code'
import { DASHBOARD_SCREENS } from '../dashboard/view'
import { wrapText } from './surface.ts'

export interface Words {
  en: string
  pt: string
}

export interface KeyEntry {
  keys: string
  action: Words
}

export type KeySectionId =
  | 'everywhere' | 'code' | 'services' | 'output' | 'sessions' | 'tasks' | 'backup' | 'dashboard' | 'logs'
  | 'reading' | 'narrow'

export interface KeySection {
  id: KeySectionId
  title: Words
  /** The screens this section is about — the one on screen is listed right after EVERYWHERE. */
  tabs: readonly TabId[]
  entries: readonly KeyEntry[]
  /** A sentence under the title, for the rule that is not one key. */
  note?: Words
}

const w = (en: string, pt: string): Words => ({ en, pt })

const ALL_TABS: readonly TabId[] = [
  'code', 'services', 'sessions', 'backup', 'dashboard', 'hardware', 'logs', 'cheatsheet', 'help', 'contribute',
]

export const EVERYWHERE: KeySection = {
  id: 'everywhere',
  title: w('EVERYWHERE', 'EM TODA PARTE'),
  tabs: ALL_TABS,
  entries: [
    { keys: '[ ]', action: w('previous / next screen — always, whatever has the keyboard', 'tela anterior / seguinte — sempre, esteja o teclado onde estiver') },
    { keys: '← →', action: w('previous / next screen, where the screen does not use the arrows', 'tela anterior / seguinte, onde a tela não usa as setas') },
    { keys: '?', action: w('this help — every key, by screen', 'esta ajuda — todas as teclas, por tela') },
    { keys: 'ctrl+p', action: w('the command palette — every command, with its shortcut', 'a paleta de comandos — todos os comandos, com o atalho') },
    { keys: 'q', action: w('quit', 'sair') },
    { keys: 'ctrl+c', action: w('quit, even from a question or the code composer', 'sair, mesmo de uma pergunta ou do compositor do code') },
    { keys: 'r', action: w('re-read what is on screen', 'reler o que está na tela') },
    { keys: 'm', action: w('mouse on / off (when the terminal reports one)', 'mouse ligado / desligado (quando o terminal informa um)') },
  ],
}

export const CODE: KeySection = {
  id: 'code',
  title: w('CODE — THE NATIVE SESSION', 'CODE — A SESSÃO NATIVA'),
  tabs: ['code'],
  // The code tab's own table, owned beside `codeKeyIntent` and tested against it there.
  entries: CODE_KEY_TABLE,
  note: w(
    'the composer holds the keyboard: q, r and m are typed here — ctrl+c quits, [ ] and ? work on an empty draft',
    'o compositor segura o teclado: q, r e m são digitados aqui — ctrl+c sai, [ ] e ? funcionam com o rascunho vazio',
  ),
}

export const SERVICES: KeySection = {
  id: 'services',
  title: w('SERVICES', 'SERVIÇOS'),
  tabs: ['services'],
  entries: [
    { keys: 'tab / shift+tab', action: w('next / previous pane — services · config · detail', 'painel seguinte / anterior — serviços · config · detalhe') },
    { keys: '↑ ↓ / j k / g G', action: w('move in the list; g G jump to the ends', 'mover na lista; g G vão às pontas') },
    { keys: 'enter', action: w('a service: open its verbs · config: run the row · verbs: run the verb', 'um serviço: abrir as ações · config: executar a linha · ações: executar a ação') },
    { keys: '← →', action: w('pick a verb on the verb row', 'escolher a ação na linha de ações') },
    { keys: 'esc', action: w('leave the verb row; on a narrow terminal, back to the first pane', 'sair da linha de ações; num terminal estreito, voltar ao primeiro painel') },
    { keys: 's', action: w('stop the selected service', 'parar o serviço selecionado') },
    { keys: 'R', action: w('restart it', 'reiniciá-lo') },
    { keys: 'o', action: w('open its dashboard in the browser', 'abrir o painel dele no navegador') },
  ],
}

export const OUTPUT: KeySection = {
  id: 'output',
  title: w('A RUNNING TASK (a build, a backup)', 'UMA TAREFA EM ANDAMENTO (build, backup)'),
  tabs: ['services', 'backup'],
  entries: [
    { keys: 'esc', action: w('put the facts back', 'voltar aos fatos') },
    { keys: '↑ ↓ / j k / pgup pgdn / home end / g G', action: w('read the output (any movement stops following)', 'ler a saída (qualquer movimento deixa de acompanhar)') },
    { keys: 'f', action: w('follow the newest line again', 'voltar a acompanhar a linha mais nova') },
  ],
}

export const SESSIONS: KeySection = {
  id: 'sessions',
  title: w('SESSIONS', 'SESSÕES'),
  tabs: ['sessions'],
  entries: [
    { keys: '↑ ↓ / j k / G', action: w('move in the list (in the menu: its rows)', 'mover na lista (no menu: as linhas dele)') },
    { keys: 'pgup pgdn / home end', action: w('page / ends of the card grid', 'página / pontas da grade de cartões') },
    { keys: 'enter', action: w('open it: native → the code tab · running → attach · closed → reopen (in the menu: run the row)', 'abrir: nativa → aba código · rodando → anexar · fechada → reabrir (no menu: executar a linha)') },
    { keys: 'g', action: w('group by task · harness · state (each press: the next)', 'agrupar por tarefa · harness · estado (cada toque: o próximo)') },
    { keys: 'tab / shift+tab', action: w('between the list and the menu (narrow: menu · sessions · detail)', 'entre a lista e o menu (estreito: menu · sessões · detalhe)') },
    { keys: '1-9', action: w('jump to a menu section', 'ir a uma seção do menu') },
    { keys: '← →', action: w('list: the detail tab (chat · terminal · metrics) · menu: previous / next section · cards: previous / next card', 'lista: a aba do detalhe (chat · terminal · métricas) · menu: seção anterior / seguinte · cartões: cartão anterior / seguinte') },
    { keys: 'esc', action: w('drop the search, then the project, then the task · leave the menu', 'tirar a busca, depois o projeto, depois a tarefa · sair do menu') },
    { keys: 'o', action: w('attach — hand the terminal to the session', 'anexar — entregar o terminal à sessão') },
    { keys: 'a / y', action: w('answer its question', 'responder à pergunta dela') },
    { keys: 'p', action: w('send it a prompt', 'mandar um prompt') },
    { keys: 'n', action: w('new session', 'nova sessão') },
    { keys: 'ctrl+f / /', action: w('search', 'buscar') },
    { keys: 'x', action: w('stop the session under the cursor (menu, on a task: delete the task)', 'parar a sessão sob o cursor (no menu, numa tarefa: apagar a tarefa)') },
    { keys: 'r', action: w('rename', 'renomear') },
    { keys: 'm', action: w('write a note', 'escrever uma nota') },
    { keys: 't', action: w('file it under a task', 'arquivar numa tarefa') },
    { keys: 'space', action: w('pin the row (in stop mode: pick it to be stopped)', 'fixar a linha (no modo de parada: marcá-la para parar)') },
    { keys: 'ctrl+x', action: w('stop mode — pick several, x stops them', 'modo de parada — marque várias, x para todas') },
    { keys: 'R', action: w('reopen what fell', 'reabrir o que caiu') },
    { keys: 'c / l / e', action: w('show / hide what is not running', 'mostrar / esconder o que não está rodando') },
    { keys: 'ctrl+a', action: w('only active sessions', 'só as sessões ativas') },
    { keys: 'C', action: w('the last conversations, flat and by recency', 'as últimas conversas, sem grupos, por recência') },
    { keys: 'v', action: w('change the grouping', 'mudar o agrupamento') },
    { keys: 'ctrl+g', action: w('list / cards', 'lista / cartões') },
    { keys: 'd', action: w('show / hide the detail pane', 'mostrar / esconder o painel de detalhe') },
    { keys: 'b / ctrl+b', action: w('fold / unfold the menu', 'recolher / abrir o menu') },
    { keys: 'ctrl+r', action: w('put the arrangement back to the defaults', 'voltar o arranjo ao padrão') },
    { keys: 'h / ctrl+h', action: w('this screen\'s own key reference', 'a referência de teclas desta tela') },
  ],
}

export const BACKUP: KeySection = {
  id: 'backup',
  title: w('BACKUP', 'BACKUP'),
  tabs: ['backup'],
  entries: [
    { keys: 'tab / shift+tab', action: w('next / previous pane — harnesses · config · detail', 'painel seguinte / anterior — harnesses · config · detalhe') },
    { keys: '↑ ↓ / j k / g G', action: w('move in the list', 'mover na lista') },
    { keys: 'space', action: w('include / leave out the harness in the next backup', 'incluir / deixar de fora o harness no próximo backup') },
    { keys: 'enter', action: w('run the config row (schedule, layers, history)', 'executar a linha de config (agenda, camadas, histórico)') },
    { keys: 'b', action: w('back up now', 'fazer backup agora') },
    { keys: 's', action: w('next schedule: off → daily → weekly', 'próxima agenda: desligado → diário → semanal') },
    { keys: 'esc', action: w('narrow terminal: back to the first pane', 'terminal estreito: voltar ao primeiro painel') },
    { keys: 'space', action: w('layers editor: toggle the layer', 'editor de camadas: ligar / desligar a camada') },
    { keys: 'enter', action: w('layers editor: save', 'editor de camadas: salvar') },
    { keys: 'esc', action: w('layers editor: cancel · history: close', 'editor de camadas: cancelar · histórico: fechar') },
    { keys: 'pgup pgdn / ← →', action: w('history: previous / next page', 'histórico: página anterior / seguinte') },
  ],
}

export const DASHBOARD: KeySection = {
  id: 'dashboard',
  title: w('DASHBOARD', 'DASHBOARD'),
  tabs: ['dashboard'],
  entries: [
    { keys: `1-${DASHBOARD_SCREENS.length}`, action: w('open that screen (numbered on the strip)', 'abrir essa tela (numerada na faixa)') },
    { keys: 'tab / shift+tab', action: w('next / previous screen', 'tela seguinte / anterior') },
    { keys: 'pgup pgdn / , .', action: w('previous / next page of the list', 'página anterior / seguinte da lista') },
    { keys: 'f', action: w('filter by harness', 'filtrar por harness') },
    { keys: '↑ ↓', action: w('filter: pick a harness', 'filtro: escolher um harness') },
    { keys: 'enter', action: w('filter: apply it', 'filtro: aplicar') },
    { keys: 'esc', action: w('filter: close it', 'filtro: fechar') },
  ],
}

export const TASKS: KeySection = {
  id: 'tasks',
  title: w('TASKS', 'TAREFAS'),
  tabs: ['tasks'],
  entries: [
    { keys: '↑ ↓', action: w('select a task (narrow, in the detail: scroll it)', 'selecionar uma tarefa (estreito, no detalhe: rolar)') },
    { keys: 'enter', action: w('open its live session (native → code, others → selected in sessions)', 'abrir a sessão viva (nativa → código, outras → selecionada em sessões)') },
    { keys: 'n', action: w('new session filed here (refused on a done task)', 'nova sessão arquivada aqui (recusada numa tarefa concluída)') },
    { keys: 'w', action: w('open the task on the web — editing happens there', 'abrir a tarefa na web — a edição é lá') },
    { keys: 'tab / esc', action: w('narrow: list ↔ detail', 'estreito: lista ↔ detalhe') },
  ],
}

export const LOGS: KeySection = {
  id: 'logs',
  title: w('LOGS', 'LOGS'),
  tabs: ['logs'],
  entries: [
    { keys: '1-9', action: w('pick a log source (numbered on the selector)', 'escolher a fonte do log (numerada no seletor)') },
    { keys: '↑ ↓ / j k', action: w('one line (stops following)', 'uma linha (deixa de acompanhar)') },
    { keys: 'pgup pgdn', action: w('one page', 'uma página') },
    { keys: 'home end / g G', action: w('the first / the newest line', 'a primeira / a linha mais nova') },
    { keys: 'f', action: w('follow the newest line again', 'voltar a acompanhar a linha mais nova') },
  ],
}

export const READING: KeySection = {
  id: 'reading',
  title: w('HELP · CHEAT SHEET · CONTRIBUTE', 'AJUDA · COLA · CONTRIBUIR'),
  tabs: ['help', 'cheatsheet', 'contribute'],
  entries: [
    { keys: '↑ ↓ / j k', action: w('one line', 'uma linha') },
    { keys: 'pgup pgdn', action: w('one page', 'uma página') },
    { keys: 'home end / g G', action: w('the top / the bottom', 'o topo / o fim') },
  ],
}

export const NARROW: KeySection = {
  id: 'narrow',
  title: w('NARROW TERMINALS', 'TERMINAIS ESTREITOS'),
  tabs: [],
  entries: [],
  note: w(
    'below 100 columns one pane is shown at a time: tab switches pane, esc goes back',
    'abaixo de 100 colunas um painel aparece por vez: tab troca de painel, esc volta',
  ),
}

/** Every section, in the order the overlay prints them when nothing else decides. */
export const KEYMAP: readonly KeySection[] = [
  EVERYWHERE, CODE, SERVICES, OUTPUT, SESSIONS, TASKS, BACKUP, DASHBOARD, LOGS, READING, NARROW,
]

/**
 * The sections in the order the overlay prints them for `current`: EVERYWHERE first (it is true on
 * this screen too), then the sections about the screen you are on, then the rest — so the keys you
 * came to look up are on the first page without scrolling, and nothing is left out.
 */
export function helpSections(current: TabId): KeySection[] {
  const here = KEYMAP.filter(sec => sec.id !== 'everywhere' && sec.tabs.includes(current))
  const rest = KEYMAP.filter(sec => sec.id !== 'everywhere' && !sec.tabs.includes(current))
  return [EVERYWHERE, ...here, ...rest]
}

// ---------------------------------------------------------------------------
// the keys column, parsed
// ---------------------------------------------------------------------------

const NAMED: Record<string, KeyPress> = {
  enter: { input: '', return: true },
  esc: { input: '', escape: true },
  tab: { input: '', tab: true },
  'shift+tab': { input: '', tab: true, shift: true },
  space: { input: ' ' },
  pgup: { input: '', pageUp: true },
  pgdn: { input: '', pageDown: true },
  home: { input: '', home: true },
  end: { input: '', end: true },
  '↑': { input: '', upArrow: true },
  '↓': { input: '', downArrow: true },
  '←': { input: '', leftArrow: true },
  '→': { input: '', rightArrow: true },
}

function tokenProbes(token: string): KeyPress[] {
  if (NAMED[token]) return [NAMED[token]!]
  if (token === '↑↓') return [NAMED['↑']!, NAMED['↓']!]
  if (token === '←→') return [NAMED['←']!, NAMED['→']!]
  const chord = /^ctrl\+(.)$/.exec(token)
  if (chord) return [{ input: chord[1]!, ctrl: true }]
  const range = /^(\d)-(\d)$/.exec(token)
  if (range) {
    const out: KeyPress[] = []
    for (let d = Number(range[1]); d <= Number(range[2]); d++) out.push({ input: String(d) })
    return out
  }
  if ([...token].length === 1) return [{ input: token }]
  throw new Error(`keymap: cannot read the key token "${token}"`)
}

/**
 * The presses a `keys` cell stands for — the half of this module the test fires at the resolvers.
 * Throws on a token it cannot read, so an entry nobody can probe fails the build instead of passing
 * for lack of anything to check.
 */
export function keyProbes(keys: string): KeyPress[] {
  return keys.split(' / ').flatMap(alt => alt.split(' ').filter(Boolean).flatMap(tokenProbes))
}

/** A press as the same short name the table uses — for a test's failure message. */
export function pressName(k: KeyPress): string {
  const mods = `${k.ctrl ? 'ctrl+' : ''}${k.shift && k.tab ? 'shift+' : ''}`
  const named = k.return ? 'enter' : k.escape ? 'esc' : k.tab ? 'tab' : k.pageUp ? 'pgup' : k.pageDown ? 'pgdn'
    : k.home ? 'home' : k.end ? 'end' : k.upArrow ? '↑' : k.downArrow ? '↓' : k.leftArrow ? '←'
    : k.rightArrow ? '→' : k.input === ' ' ? 'space' : k.input
  return mods + named
}

// ---------------------------------------------------------------------------
// the overlay's lines
// ---------------------------------------------------------------------------

export interface HelpLine {
  kind: 'title' | 'entry' | 'note' | 'blank'
  /** The keystroke column; empty on a continuation line and on every non-entry line. */
  keys: string
  text: string
}

/**
 * The keys column's width: the widest cell up to `KEY_COLUMN_MAX`. A longer cell (a list of scroll
 * alternatives) is written on a line of its own with its description under it, rather than widening
 * the column for every other row on the page.
 */
export const KEY_COLUMN_MAX = 16

export function helpKeyColumn(sections: readonly KeySection[]): number {
  return sections.reduce(
    (n, sec) => sec.entries.reduce((m, e) => (e.keys.length <= KEY_COLUMN_MAX ? Math.max(m, e.keys.length) : m), n),
    0,
  )
}

/**
 * The overlay as lines that fit `width` — PURE, and the thing the overlay scrolls.
 *
 * Each section is its title, an optional note, and its keys with what they do wrapped under the
 * description column (never under the keys, so the keystroke column is written once per key). A
 * keys cell wider than the column gets its own line.
 */
export function helpLines(lang: CliLang, current: TabId, width: number): HelpLine[] {
  const sections = helpSections(current)
  const keyCol = helpKeyWidth(current, width)
  const room = Math.max(1, width - keyCol - 2)
  const out: HelpLine[] = []
  sections.forEach((sec, i) => {
    if (i > 0) out.push({ kind: 'blank', keys: '', text: '' })
    out.push({ kind: 'title', keys: '', text: sec.title[lang] })
    if (sec.note) for (const line of wrapText(sec.note[lang], Math.max(1, width))) out.push({ kind: 'note', keys: '', text: line })
    for (const e of sec.entries) {
      const wrapped = wrapText(e.action[lang], room)
      const lines = wrapped.length > 0 ? wrapped : ['']
      if (e.keys.length > keyCol) {
        out.push({ kind: 'entry', keys: e.keys, text: '' })
        lines.forEach(text => out.push({ kind: 'entry', keys: '', text }))
        continue
      }
      lines.forEach((text, j) => out.push({ kind: 'entry', keys: j === 0 ? e.keys : '', text }))
    }
  })
  return out
}

/** The width the overlay draws the keys column at — the same one `helpLines` wrapped against. */
export function helpKeyWidth(current: TabId, width: number): number {
  return Math.min(helpKeyColumn(helpSections(current)), Math.max(4, Math.floor(width / 2)))
}

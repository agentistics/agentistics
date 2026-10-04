/**
 * settings.ts — PURE: the settings overlay (ST-01…ST-07). Its state, what each key does to it, and
 * the lines it draws. The overlay owns no data and no persistence: the shell reads every fact from
 * the host (`SettingsData`) and performs every effect this returns through the host, which writes
 * the same preferences and calls the same routes the web's Settings does.
 *
 * Seven sections, as the prototype draws them: a list on the left, the selected section on the right.
 * Below 100 columns one pane at a time (D-TUI-10): the list, then `enter` opens the section and
 * `esc` comes back.
 */

import { COLORS, THEME_IDS, type ThemeId } from '../theme'
import { cellWidth, fitLine, lr, seg, truncateCells, wrapText, type Line } from './code'
import { KEYMAP, keyProbes } from './keymap'
import { bindingOf, DEFAULT_SHELL_KEYS, pressMatches, SHELL_ACTIONS, type ShellAction, type ShellKeys } from './nav'
import type { CliLang } from './lang'

export type SettingsSectionId = 'providers' | 'models' | 'permissions' | 'appearance' | 'keys' | 'lang' | 'tracking'
export const SETTINGS_SECTIONS: readonly SettingsSectionId[] = ['providers', 'models', 'permissions', 'appearance', 'keys', 'lang', 'tracking']

type W = { en: string; pt: string }
const w = (en: string, pt: string): W => ({ en, pt })

const SECTION_LABEL: Record<SettingsSectionId, W> = {
  providers: w('Providers', 'Provedores'),
  models: w('Models & pricing', 'Modelos e preços'),
  permissions: w('Permissions', 'Permissões'),
  appearance: w('Appearance', 'Aparência'),
  keys: w('Keybindings', 'Teclas'),
  lang: w('Language', 'Idioma'),
  tracking: w('Tasks & tracking', 'Tarefas e rastreio'),
}

// ── the data the host hands over ────────────────────────────────────────────────────────────────

/** ST-01: one provider, as the service reports it to the host (the key itself never reaches the TUI). */
export interface SettingsProvider {
  id: string
  label: string
  kind: 'direct' | 'router' | 'local'
  state: 'absent' | 'present' | 'unreadable' | 'permissions-too-open'
  keyOptional: boolean
  keyless?: boolean
  /** The stored key's last 4 characters — the only part of it anyone is shown. */
  last4?: string
  baseUrl?: string
}

export type SettingsProviders =
  | { ok: true; providers: SettingsProvider[] }
  /** The host's refusal in its own words (the gate is off, the service is down…). */
  | { ok: false; sentence: string }

/** ST-01: the model a new native session uses when none is picked, and where that comes from. */
export interface SettingsDefaultModel {
  provider: string
  model: string
  source: 'flag' | 'last-session'
}

/** ST-02: one model's price per counter (USD per million tokens), window and provenance. */
export interface SettingsPriceRow {
  model: string
  /** `null`: no source can price it — every price cell reads N/A. */
  price: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  /** Where the price was read and when; `local` = it runs on this machine and costs nothing. */
  priceSource: { source: string; verifiedAt: string | null } | 'local' | null
  /** Context window in tokens, with its own source; `null` = nobody publishes one we verified. */
  window: { tokens: number; source: string; verifiedAt: string } | null
  /** Offered by a configured provider (not only a row of the table). */
  offered?: string
}

export interface SettingsData {
  providers: SettingsProviders | null
  defaultModel: SettingsDefaultModel | null
  /** Per provider: the last test's sentence (with its latency), as the host phrased it. */
  tests: Record<string, { ok: boolean; sentence: string; at: string }>
  prices: SettingsPriceRow[] | null
  /** ST-03: the machine's floor as globs (`protectedGlobs`), never liftable. `null` while reading. */
  floor: string[] | null
  /** ST-03: a native session is open in `code` (its mode and session rules live in its panel). */
  sessionOpen: boolean
  theme: ThemeId
  /** ST-04: the sessions list's arrangement — the screen where density shows. */
  density: 'comfortable' | 'compact'
  binds: ShellKeys
  lang: CliLang
}

// ── state ───────────────────────────────────────────────────────────────────────────────────────

export interface SettingsState {
  section: number
  /** Which pane has the keyboard: the section list, or the section itself. */
  pane: 'nav' | 'content'
  /** The selected row inside a section that has rows (providers, models, appearance, keys). */
  row: number
  /** ST-01: a key being typed for `provider` — shown masked, never echoed. */
  keyInput: { provider: string; value: string } | null
  /** ST-05: waiting for the next press, to bind it to `action`. */
  capture: ShellAction | null
}

export function openSettings(section: SettingsSectionId = 'providers'): SettingsState {
  return { section: Math.max(0, SETTINGS_SECTIONS.indexOf(section)), pane: 'content', row: 0, keyInput: null, capture: null }
}

export type SettingsEffect =
  | { kind: 'none' }
  | { kind: 'close' }
  | { kind: 'test'; provider: string }
  | { kind: 'set-key'; provider: string; key: string }
  | { kind: 'theme'; theme: ThemeId }
  | { kind: 'density'; density: 'comfortable' | 'compact' }
  | { kind: 'lang'; lang: CliLang }
  | { kind: 'bind'; binds: ShellKeys; sentence: string }
  /** A sentence for the status row: `ok` false is a refusal. */
  | { kind: 'say'; ok: boolean; sentence: string }

export interface SettingsKey {
  input: string
  return?: boolean
  escape?: boolean
  backspace?: boolean
  delete?: boolean
  ctrl?: boolean
  meta?: boolean
  tab?: boolean
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
}

const keep = (state: SettingsState, effect: SettingsEffect = { kind: 'none' }) => ({ state, effect })

export function sectionOf(st: SettingsState): SettingsSectionId {
  return SETTINGS_SECTIONS[st.section] ?? 'providers'
}

/** How many selectable rows the section has (0 = it only reads). */
export function sectionRows(id: SettingsSectionId, d: SettingsData): number {
  if (id === 'providers') return d.providers?.ok ? d.providers.providers.length : 0
  if (id === 'models') return d.prices?.length ?? 0
  if (id === 'appearance') return 2
  if (id === 'keys') return SHELL_ACTIONS.length + 1 // + "reset to the defaults"
  if (id === 'lang') return 1
  return 0
}

// ── ST-05: a binding that collides is refused in words ──────────────────────────────────────────

const ACTION_LABEL: Record<ShellAction, W> = {
  'prev-tab': w('previous screen', 'tela anterior'),
  'next-tab': w('next screen', 'tela seguinte'),
  palette: w('command palette', 'paleta de comandos'),
  settings: w('settings', 'configurações'),
  help: w('every key (help)', 'todas as teclas (ajuda)'),
  quit: w('quit', 'sair'),
  refresh: w('re-read the screen', 'reler a tela'),
  mouse: w('mouse on / off', 'mouse liga / desliga'),
}

/**
 * The presses a keymap cell names. `keyProbes` reads the strict grammar; a cell outside it (the code
 * tab's `ctrl+i/tab`) is read token by token instead, so a collision is still found rather than the
 * whole check failing.
 */
function cellPresses(cell: string): { input: string; ctrl?: boolean }[] {
  try {
    return keyProbes(cell)
  } catch {
    return cell.split(/[\s/]+/).filter(Boolean).flatMap(t => {
      if (/^ctrl\+[a-z]$/.test(t)) return [{ input: t.slice(5), ctrl: true }]
      return [...t].length === 1 ? [{ input: t }] : []
    })
  }
}

/** Keys nothing may take: the way out, and the keys every list and question answers. */
const RESERVED = new Set(['ctrl+c', 'ctrl+u', 'ctrl+m', 'ctrl+i', 'ctrl+j', 'ctrl+h'])

/**
 * Why `key` cannot be bound to `action` — another shell action holds it, or a screen answers it
 * (read off `KEYMAP`, the same table `?` prints, so the refusal names the screen and what the key
 * does there) — or `null` when it is free.
 */
export function bindingConflict(action: ShellAction, key: string, binds: ShellKeys, lang: CliLang): string | null {
  if (RESERVED.has(key)) return lang === 'pt' ? `${key} é reservada (sair, editar e as listas dependem dela)` : `${key} is reserved (quitting, editing and the lists depend on it)`
  for (const other of SHELL_ACTIONS) {
    if (other !== action && binds[other] === key) {
      return lang === 'pt' ? `${key} já é "${ACTION_LABEL[other].pt}" — troque aquela antes` : `${key} is already "${ACTION_LABEL[other].en}" — rebind that one first`
    }
  }
  const press = key.startsWith('ctrl+') ? { input: key.slice(5), ctrl: true } : { input: key }
  for (const sec of KEYMAP) {
    if (sec.id === 'everywhere') continue
    for (const e of sec.entries) {
      if (cellPresses(e.keys).some(p => pressMatches(key, p) && (Boolean(p.ctrl) === Boolean(press.ctrl)))) {
        return lang === 'pt'
          ? `${key} já é usada em ${sec.title.pt.toLowerCase()}: ${e.action.pt}`
          : `${key} is taken in ${sec.title.en.toLowerCase()}: ${e.action.en}`
      }
    }
  }
  return null
}

// ── keys ────────────────────────────────────────────────────────────────────────────────────────

/**
 * One key, folded. `narrow` is the one-pane layout. Effects the host performs come back as
 * `effect`; the overlay's own movement is the new `state`.
 */
export function settingsKey(st: SettingsState, k: SettingsKey, d: SettingsData, narrow: boolean): { state: SettingsState; effect: SettingsEffect } {
  const pt = d.lang === 'pt'
  const id = sectionOf(st)

  // ST-05: the next press becomes the binding (esc cancels; a key a binding cannot hold says so).
  if (st.capture) {
    if (k.escape) return keep({ ...st, capture: null }, { kind: 'say', ok: true, sentence: pt ? 'nada mudou' : 'nothing changed' })
    const key = k.return || k.tab || k.upArrow || k.downArrow || k.leftArrow || k.rightArrow || k.backspace || k.delete ? null : bindingOf(k)
    if (!key) return keep(st, { kind: 'say', ok: false, sentence: pt ? 'essa tecla não pode ser um atalho — use um caractere ou ctrl+letra (esc cancela)' : 'that key cannot be a shortcut — use one character or ctrl+letter (esc cancels)' })
    const action = st.capture
    const why = bindingConflict(action, key, d.binds, d.lang)
    if (why) return keep(st, { kind: 'say', ok: false, sentence: why })
    const binds = { ...d.binds, [action]: key }
    return keep({ ...st, capture: null }, { kind: 'bind', binds, sentence: pt ? `${ACTION_LABEL[action].pt}: ${key}` : `${ACTION_LABEL[action].en}: ${key}` })
  }

  // ST-01: a key being typed. Nothing but its length is ever drawn.
  if (st.keyInput) {
    const ki = st.keyInput
    if (k.escape) return keep({ ...st, keyInput: null }, { kind: 'say', ok: true, sentence: pt ? 'nada foi gravado' : 'nothing was stored' })
    if (k.return) {
      const key = ki.value.trim()
      if (!key) return keep(st, { kind: 'say', ok: false, sentence: pt ? 'cole a chave primeiro (esc cancela)' : 'paste the key first (esc cancels)' })
      return keep({ ...st, keyInput: null }, { kind: 'set-key', provider: ki.provider, key })
    }
    if (k.backspace || k.delete) return keep({ ...st, keyInput: { ...ki, value: ki.value.slice(0, -1) } })
    if ((k.ctrl && k.input === 'u') || k.input === '\x15') return keep({ ...st, keyInput: { ...ki, value: '' } })
    if (k.ctrl || k.meta || k.tab || k.upArrow || k.downArrow || k.leftArrow || k.rightArrow) return keep(st)
    const printable = [...k.input.replace(/[\r\n]/g, '')].filter(ch => ch > ' ' && ch !== '\x7f').join('')
    return printable ? keep({ ...st, keyInput: { ...ki, value: ki.value + printable } }) : keep(st)
  }

  if (st.pane === 'nav') {
    const n = SETTINGS_SECTIONS.length
    if (k.escape) return keep(st, { kind: 'close' })
    if (k.upArrow || k.input === 'k') return keep({ ...st, section: (st.section + n - 1) % n, row: 0 })
    if (k.downArrow || k.input === 'j') return keep({ ...st, section: (st.section + 1) % n, row: 0 })
    if (k.return || k.tab || k.rightArrow) return keep({ ...st, pane: 'content', row: 0 })
    return keep(st)
  }

  // content
  if (k.escape || k.leftArrow || (k.tab && !narrow)) return keep({ ...st, pane: 'nav' })
  if (k.tab) return keep({ ...st, pane: 'nav' })
  const rows = sectionRows(id, d)
  if (rows > 0 && (k.upArrow || k.input === 'k')) return keep({ ...st, row: (st.row + rows - 1) % rows })
  if (rows > 0 && (k.downArrow || k.input === 'j')) return keep({ ...st, row: (st.row + 1) % rows })

  if (id === 'providers') {
    if (!d.providers?.ok) return keep(st, k.return || k.input === 't' || k.input === 'K' ? { kind: 'say', ok: false, sentence: d.providers?.sentence ?? (pt ? 'lendo os provedores…' : 'reading the providers…') } : { kind: 'none' })
    const p = d.providers.providers[st.row]
    if (!p) return keep(st)
    if (k.input === 't') return keep(st, { kind: 'test', provider: p.id })
    if (k.input === 'K' || k.return) {
      if (p.kind === 'local' && p.keyOptional) return keep(st, { kind: 'say', ok: false, sentence: pt ? `${p.label} roda nesta máquina e não precisa de chave — o endereço se configura na web (Configurações → Provedores)` : `${p.label} runs on this machine and needs no key — its address is set on the web (Settings → Providers)` })
      return keep({ ...st, keyInput: { provider: p.id, value: '' } })
    }
    return keep(st)
  }
  if (id === 'appearance' && (k.return || k.input === ' ')) {
    if (st.row === 0) {
      const next = THEME_IDS[(THEME_IDS.indexOf(d.theme) + 1) % THEME_IDS.length]!
      return keep(st, { kind: 'theme', theme: next })
    }
    return keep(st, { kind: 'density', density: d.density === 'compact' ? 'comfortable' : 'compact' })
  }
  if (id === 'lang' && (k.return || k.input === ' ')) return keep(st, { kind: 'lang', lang: d.lang === 'pt' ? 'en' : 'pt' })
  if (id === 'keys' && k.return) {
    const action = SHELL_ACTIONS[st.row]
    if (!action) return keep(st, { kind: 'bind', binds: { ...DEFAULT_SHELL_KEYS }, sentence: pt ? 'teclas de volta ao padrão' : 'keys back to the defaults' })
    return keep({ ...st, capture: action }, { kind: 'say', ok: true, sentence: pt ? `aperte a nova tecla para "${ACTION_LABEL[action].pt}" (esc cancela)` : `press the new key for "${ACTION_LABEL[action].en}" (esc cancels)` })
  }
  return keep(st)
}

/** Footer keys, most important first, for the focus the overlay is in. */
export function settingsHints(st: SettingsState, d: SettingsData, narrow: boolean): string[] {
  const pt = d.lang === 'pt'
  if (st.capture) return [pt ? 'qualquer tecla vira o atalho' : 'any key becomes the shortcut', pt ? 'esc cancela' : 'esc cancels']
  if (st.keyInput) return [pt ? 'enter grava' : 'enter stores', pt ? 'esc cancela' : 'esc cancels', pt ? 'ctrl+u apaga' : 'ctrl+u clears']
  if (st.pane === 'nav') return [pt ? '↑↓ seção' : '↑↓ section', pt ? 'enter abre' : 'enter open', pt ? 'esc fecha' : 'esc close']
  const id = sectionOf(st)
  const back = narrow ? (pt ? 'esc volta' : 'esc back') : (pt ? 'esc/tab lista' : 'esc/tab list')
  if (id === 'providers') return [pt ? 'K chave' : 'K set key', pt ? 't testa' : 't test', pt ? '↑↓ provedor' : '↑↓ provider', back]
  if (id === 'models') return [pt ? '↑↓ rola' : '↑↓ scroll', back]
  if (id === 'appearance') return [pt ? 'enter troca' : 'enter change', '↑↓', back]
  if (id === 'keys') return [pt ? 'enter muda a tecla' : 'enter rebind', '↑↓', back]
  if (id === 'lang') return [pt ? 'enter troca' : 'enter switch', back]
  return [back]
}

// ── lines ───────────────────────────────────────────────────────────────────────────────────────

const NAV_W = 22

const money = (n: number) => (n === 0 ? '$0' : `$${Number.isInteger(n) ? n : n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`)
const ktok = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : `${Math.round(n / 1e3)}k`)

function statusSeg(p: SettingsProvider, pt: boolean) {
  if (p.state === 'present') return seg(pt ? '● pronto' : '● ready', { color: COLORS.running })
  if (p.state === 'unreadable') return seg(pt ? '● ilegível' : '● unreadable', { color: COLORS.danger })
  if (p.state === 'permissions-too-open') return seg(pt ? '● permissões abertas' : '● permissions too open', { color: COLORS.danger })
  return seg(pt ? '○ não configurado' : '○ not configured', { color: COLORS.muted })
}

function credentialText(p: SettingsProvider, pt: boolean): string {
  if (p.state !== 'present') return '—'
  if (p.keyless) return pt ? 'sem chave (local)' : 'no key (local)'
  return p.last4 ? (pt ? `guardada · …${p.last4}` : `stored · …${p.last4}`) : (pt ? 'guardada' : 'stored')
}

function providersLines(st: SettingsState, d: SettingsData, w: number, focus: boolean): Line[] {
  const pt = d.lang === 'pt'
  const out: Line[] = []
  if (!d.providers) return [[seg(pt ? 'lendo os provedores…' : 'reading the providers…', { color: COLORS.muted })]]
  if (!d.providers.ok) return wrapText(d.providers.sentence, w).map(l => [seg(l, { color: COLORS.danger })])
  out.push(lr([seg(pt ? 'provedor' : 'provider', { color: COLORS.label })], [seg(pt ? 'estado · credencial' : 'status · credential', { color: COLORS.label })], w))
  d.providers.providers.forEach((p, i) => {
    const on = focus && i === st.row
    out.push(lr(
      [seg(on ? '▸ ' : '  ', { color: COLORS.accent }), seg(p.label, { color: on ? COLORS.text : COLORS.label, bold: on })],
      [statusSeg(p, pt), seg(` · ${credentialText(p, pt)}`, { color: COLORS.muted })],
      w, 2,
    ))
  })
  out.push([])
  const sel = d.providers.providers[st.row]
  if (st.keyInput && sel) {
    const shown = '•'.repeat(Math.min(st.keyInput.value.length, Math.max(0, w - 24)))
    out.push(fitLine([seg(pt ? `chave de ${sel.label}: ` : `${sel.label} key: `, { color: COLORS.label }), seg(shown, { color: COLORS.text }), seg('▍', { color: COLORS.accent })], w))
    out.push(fitLine([seg(pt ? `${st.keyInput.value.length} caracteres · nunca mostrada · gravada no cofre do agentop` : `${st.keyInput.value.length} characters · never shown · stored in agentop's vault`, { color: COLORS.muted })], w))
  } else if (sel) {
    const test = d.tests[sel.id]
    out.push(lr([seg(pt ? 'último teste' : 'last test', { color: COLORS.label })], test
      ? [seg(`${test.at} · `, { color: COLORS.muted }), seg(test.sentence, { color: test.ok ? COLORS.running : COLORS.danger })]
      : [seg(pt ? 'nenhum nesta sessão — t testa' : 'none this session — t tests', { color: COLORS.muted })], w, 2))
    const dm = d.defaultModel
    // The model a new native session falls back to — stated as a fact about NEW sessions, not
    // pinned to a provider row: the code host names the model and where it came from.
    out.push(lr([seg(pt ? 'sessão nova usa' : 'new sessions use', { color: COLORS.label })], dm
      ? [seg(dm.model, { color: COLORS.text }), seg(dm.source === 'flag' ? (pt ? ' · da flag --model' : ' · from --model') : (pt ? ' · da sua última sessão' : ' · from your last session'), { color: COLORS.muted })]
      : [seg(pt ? 'o modelo escolhido no assistente de nova sessão' : 'the model picked in the new-session wizard', { color: COLORS.muted })], w, 2))
  }
  out.push([])
  for (const l of wrapText(pt
    ? 'K define a chave (mascarada; só o fim é mostrado) · t testa a conexão · uma chave de outro fornecedor é recusada em palavras · a web lê as mesmas configurações'
    : 'K sets a key (masked; only its end is ever shown) · t tests the connection · a key of the wrong vendor is refused in words · the web reads the same settings', w)) out.push([seg(l, { color: COLORS.muted })])
  return out
}

function modelsLines(st: SettingsState, d: SettingsData, w: number, rows: number, focus: boolean): Line[] {
  const pt = d.lang === 'pt'
  if (!d.prices) return [[seg(pt ? 'lendo a tabela de preços…' : 'reading the price table…', { color: COLORS.muted })]]
  const count = d.prices.length
  const head: Line[] = [lr([seg(pt ? 'modelo' : 'model', { color: COLORS.label }), seg(` · ${st.row + 1} / ${count}`, { color: COLORS.muted })], [seg(pt ? 'janela de contexto' : 'context window', { color: COLORS.label })], w),
    fitLine([seg(pt ? '    entrada · saída · cache lê · cache grava, por 1M tokens · fonte e data' : '    in · out · cache read · cache write, per 1M tokens · source and date', { color: COLORS.label })], w)]
  const foot: Line[] = [[], ...wrapText(pt
    ? 'sem fonte que precifique → N/A em todo lugar, nunca uma taxa chutada · janela que ninguém publica não desenha medidor'
    : 'no source can price it → N/A everywhere, never a guessed rate · a window nobody publishes draws no gauge', w).map(l => [seg(l, { color: COLORS.muted })])]
  // Two lines per model: its name never gives way to the numbers beside it.
  const room = Math.max(1, Math.floor((rows - head.length - foot.length) / 2))
  const top = Math.max(0, Math.min(st.row - Math.floor(room / 2), d.prices.length - room))
  const host = (src: string) => src.split('/')[0]!.split('.').slice(-2).join('.')
  const body = d.prices.slice(top, top + room).flatMap((r, j) => {
    const i = top + j
    const on = focus && i === st.row
    const win = r.window
      ? [seg(ktok(r.window.tokens), { color: COLORS.text }), seg(r.window.verifiedAt === 'live' ? (pt ? ` · do provedor` : ' · from the provider') : ` · ${r.window.verifiedAt}`, { color: COLORS.muted })]
      : [seg(pt ? 'N/A — não publicada' : 'N/A — not published', { color: COLORS.muted })]
    const name = lr([seg(on ? '▸ ' : '  ', { color: COLORS.accent }), seg(r.model, { color: on ? COLORS.text : COLORS.label, bold: on }), seg(r.offered ? ` ${r.offered}` : '', { color: COLORS.muted })], win, w, 2)
    const price: Line = r.priceSource === 'local'
      ? [seg(pt ? '$0 · roda nesta máquina, não custa nada' : '$0 · runs on this machine, costs nothing', { color: COLORS.text })]
      : r.price
        ? [seg(`${money(r.price.input)} · ${money(r.price.output)} · ${money(r.price.cacheRead)} · ${money(r.price.cacheWrite)}`, { color: COLORS.text })]
        : [seg('N/A · N/A · N/A · N/A', { color: COLORS.muted })]
    const src: Line = r.priceSource === 'local' ? []
      : r.priceSource
        ? [seg(`${host(r.priceSource.source)} · `, { color: COLORS.running }), seg(r.priceSource.verifiedAt ?? (pt ? 'data não registrada' : 'date not recorded'), { color: r.priceSource.verifiedAt ? COLORS.running : COLORS.accent })]
        : [seg(pt ? 'sem preço verificado' : 'no verified price', { color: COLORS.accent })]
    return [name, lr([seg('    '), ...price], src, w, 2)]
  })
  return [...head, ...body, ...foot]
}

function permissionsLines(d: SettingsData, w: number, rows: number): Line[] {
  const pt = d.lang === 'pt'
  const out: Line[] = []
  out.push(fitLine([seg(pt ? 'MODOS ' : 'MODES ', { color: COLORS.label, bold: true }), seg('ask · edits · plan', { color: COLORS.text }), seg(pt ? ' — shift+tab no code; sessão nova começa em ask' : ' — shift+tab in code; new sessions start in ask', { color: COLORS.muted })], w))
  out.push([])
  // One line per rule (verdict · what · in which modes), and its caveat, when it has one, under it.
  const row = (verdict: 'allow' | 'ask' | 'deny', what: string, modes: string, note?: string) => {
    const lines: Line[] = [lr(
      [seg(verdict.padEnd(7), { color: verdict === 'allow' ? COLORS.running : verdict === 'ask' ? COLORS.accent : COLORS.danger }), seg(what, { color: COLORS.text })],
      [seg(modes, { color: COLORS.label })], w, 2)]
    if (note) for (const l of wrapText(note, Math.max(1, w - 7))) lines.push([seg('       '), seg(l, { color: COLORS.muted })])
    return lines
  }
  // The built-in profiles as the runtime's policy defines them (policy.ts defaults + B4.7 profiles),
  // in the words the contract's `CodeModeId` maps: ask = default, edits = accept-edits, plan = plan.
  out.push(...row('allow', pt ? 'ler dentro da pasta da sessão' : 'reading inside the session folder', pt ? 'todo modo' : 'every mode'))
  out.push(...row('deny', pt ? 'qualquer caminho fora da pasta da sessão' : 'any path outside the session folder', pt ? 'todo modo' : 'every mode', pt ? 'só uma regra que nomeia o caminho libera' : 'only a rule that names the path lifts it'))
  out.push(...row('ask', pt ? 'escrever arquivos' : 'writing files', 'ask', pt ? 'em edits é permitido dentro da pasta; arquivos com cara de segredo ainda perguntam' : 'allowed inside the folder under edits; secret-shaped files still ask'))
  out.push(...row('ask', pt ? 'comandos de shell' : 'shell commands', 'ask · edits'))
  out.push(...row('deny', pt ? 'escritas e comandos que mudam algo' : 'writes and mutating commands', 'plan', 'rm, mv, git commit, npm install…'))
  out.push(fitLine([seg(pt ? '       "permitir nesta sessão": ' : '       "allow for this session": ', { color: COLORS.muted }), seg(d.sessionOpen
    ? (pt ? 'as da sessão aberta estão no painel dela (code · ctrl+b), até ela acabar' : 'the open session\'s are in its panel (code · ctrl+b), until it ends')
    : (pt ? 'nenhuma sessão nativa aberta' : 'no native session is open'), { color: COLORS.muted })], w))
  out.push([])
  if (!d.floor) {
    out.push(fitLine([seg(pt ? 'PISO — nunca liberado' : 'FLOOR — never lifted', { color: COLORS.danger, bold: true })], w))
    out.push([seg(pt ? 'lendo o piso…' : 'reading the floor…', { color: COLORS.muted })])
  } else {
    // Each protected place once: `x`, `x*` and `x*/**` are one place matched three ways.
    // `x/**` is x's contents, and `x*` is x matched with a suffix — both are x when x itself is listed.
    // A glob that only exists WITH its star (`*.key*`) keeps it: dropping it would change what it says.
    const stems = new Set(d.floor.map(g => g.replace(/\/\*\*$/, '')))
    const places = [...stems].filter(g => !(g.endsWith('*') && stems.has(g.slice(0, -1))))
    out.push(fitLine([seg(pt ? 'PISO — nunca liberado' : 'FLOOR — never lifted', { color: COLORS.danger, bold: true }), seg(pt ? ` · ${places.length} lugares negados` : ` · ${places.length} places denied`, { color: COLORS.muted })], w))
    if (places.length === 0) out.push([seg(pt ? 'o plano de backup não marca nenhum segredo nesta máquina' : 'the backup plan marks no secret on this machine', { color: COLORS.muted })])
    else {
      const foot = wrapText(pt
        ? 'o piso não pode ser alargado daqui nem de lugar nenhum — vem das linhas "segredo" do plano de backup; o resto vem do modo, que a política do runtime aplica'
        : 'the floor cannot be widened from here or anywhere else — it comes from the backup plan\'s secret rows; the rest follows the mode, which the runtime\'s policy enforces', w)
      // What does not fit is COUNTED, never silently cut: the rows the footer and its gap leave.
      const room = Math.max(1, rows - out.length - foot.length - 1)
      const wrapped = wrapText(places.join(' · '), w)
      const shown = wrapped.length > room ? wrapped.slice(0, room - 1) : wrapped
      for (const l of shown) out.push([seg(l, { color: COLORS.danger })])
      if (shown.length < wrapped.length) {
        const listed = shown.join(' ').split(' · ').length - 1
        out.push(fitLine([seg(pt ? `… e mais ${places.length - listed} — a aba backup lista o plano inteiro` : `… and ${places.length - listed} more — the backup tab lists the whole plan`, { color: COLORS.muted })], w))
      }
      out.push([])
      for (const l of foot) out.push([seg(l, { color: COLORS.muted })])
      return out
    }
  }
  return out
}

const THEME_WORD: Record<ThemeId, W> = { dark: w('agentistics dark', 'agentistics escuro'), light: w('agentistics light', 'agentistics claro'), contrast: w('high contrast', 'alto contraste') }

function appearanceLines(st: SettingsState, d: SettingsData, w: number, focus: boolean): Line[] {
  const pt = d.lang === 'pt'
  const row = (i: number, label: string, value: string, note: string) => lr(
    [seg(focus && st.row === i ? '▸ ' : '  ', { color: COLORS.accent }), seg(label, { color: focus && st.row === i ? COLORS.text : COLORS.label, bold: focus && st.row === i })],
    [seg(value, { color: COLORS.text }), seg(note ? `  ${note}` : '', { color: COLORS.muted })], w, 2)
  return [
    row(0, pt ? 'tema' : 'theme', THEME_WORD[d.theme][d.lang], ''),
    row(1, pt ? 'densidade' : 'density', d.density === 'compact' ? (pt ? 'compacta' : 'compact') : (pt ? 'confortável' : 'comfortable'), d.density === 'compact' ? (pt ? 'sessões em lista' : 'sessions as a list') : (pt ? 'sessões em cartões' : 'sessions as cards')),
    [],
    ...wrapText(pt
      ? 'enter troca · a paleta escura espelha o painel web; clara é para terminais de fundo claro; alto contraste levanta todo cinza · lembrado entre execuções'
      : 'enter changes it · dark mirrors the web dashboard; light is for a light terminal background; high contrast lifts every grey · remembered between runs', w).map(l => [seg(l, { color: COLORS.muted })]),
  ]
}

function keysLines(st: SettingsState, d: SettingsData, w: number, focus: boolean): Line[] {
  const pt = d.lang === 'pt'
  const out: Line[] = [fitLine([seg(pt ? 'as teclas do app, trocáveis; um conflito é recusado em palavras' : 'the app\'s own keys, rebindable; a conflict is refused in words', { color: COLORS.muted })], w), []]
  SHELL_ACTIONS.forEach((a, i) => {
    const on = focus && st.row === i
    const waiting = st.capture === a
    const changed = d.binds[a] !== DEFAULT_SHELL_KEYS[a]
    out.push(lr(
      [seg(on ? '▸ ' : '  ', { color: COLORS.accent }), seg(ACTION_LABEL[a][d.lang], { color: on ? COLORS.text : COLORS.label, bold: on })],
      waiting ? [seg(pt ? 'aperte a tecla…' : 'press the key…', { color: COLORS.accent, bold: true })]
        : [seg(d.binds[a], { color: COLORS.accent }), seg(changed ? (pt ? `  (padrão ${DEFAULT_SHELL_KEYS[a]})` : `  (default ${DEFAULT_SHELL_KEYS[a]})`) : '', { color: COLORS.muted })],
      w, 2))
  })
  const resetOn = focus && st.row === SHELL_ACTIONS.length
  out.push(fitLine([seg(resetOn ? '▸ ' : '  ', { color: COLORS.accent }), seg(pt ? 'voltar ao padrão' : 'back to the defaults', { color: resetOn ? COLORS.text : COLORS.label, bold: resetOn })], w))
  out.push([])
  const h = d.binds.help
  for (const l of wrapText(pt
    ? `ctrl+c sempre sai · as teclas de cada tela (n, x, t, a…) ficam como estão — ${h} lista todas, e uma tecla nova não pode tomar nenhuma delas`
    : `ctrl+c always quits · each screen's own keys (n, x, t, a…) stay as they are — ${h} lists them all, and a new binding may not take any of them`, w)) out.push([seg(l, { color: COLORS.muted })])
  return out
}

function langLines(st: SettingsState, d: SettingsData, w: number, focus: boolean): Line[] {
  const pt = d.lang === 'pt'
  return [
    lr([seg(focus ? '▸ ' : '  ', { color: COLORS.accent }), seg(pt ? 'idioma' : 'language', { color: focus ? COLORS.text : COLORS.label, bold: focus })], [seg(pt ? 'Português (Brasil)' : 'English', { color: COLORS.text })], w, 2),
    [],
    ...wrapText(pt ? 'enter troca · o app inteiro acompanha, inclusive depois de um detach · lembrado entre execuções' : 'enter switches · the whole app follows, including after a detach · remembered between runs', w).map(l => [seg(l, { color: COLORS.muted })]),
  ]
}

function trackingLines(d: SettingsData, w: number): Line[] {
  const pt = d.lang === 'pt'
  const row = (label: string, value: string, color: string) => lr([seg(label, { color: COLORS.label })], [seg(value, { color })], w, 2)
  return [
    row(pt ? 'uma tarefa para toda sessão nova' : 'a task for every new session', pt ? 'obrigatória' : 'required', COLORS.running),
    row(pt ? 'sessões que o agentop não iniciou' : 'sessions agentop did not start', pt ? 'listadas como "sem tarefa" · t arquiva' : 'listed as "not filed" · t files them', COLORS.text),
    row(pt ? 'parar a última sessão viva de uma tarefa' : 'stopping a task\'s last live session', pt ? 'pergunta se a tarefa acabou' : 'asks whether the task is done', COLORS.text),
    [],
    ...wrapText(pt
      ? 'obrigatória é a regra do dono, não uma opção: o assistente de nova sessão não termina sem tarefa (escolha uma ou crie na hora) · o resto do board se edita na web'
      : 'required is the owner\'s rule, not a toggle: the new-session wizard cannot finish without a task (pick one or create it inline) · the rest of the board is edited on the web', w).map(l => [seg(l, { color: COLORS.muted })]),
  ]
}

/** The selected section's lines at `w` columns and `rows` rows. */
export function sectionLines(st: SettingsState, d: SettingsData, w: number, rows: number): Line[] {
  const focus = st.pane === 'content'
  switch (sectionOf(st)) {
    case 'providers': return providersLines(st, d, w, focus)
    case 'models': return modelsLines(st, d, w, rows, focus)
    case 'permissions': return permissionsLines(d, w, rows)
    case 'appearance': return appearanceLines(st, d, w, focus)
    case 'keys': return keysLines(st, d, w, focus)
    case 'lang': return langLines(st, d, w, focus)
    case 'tracking': return trackingLines(d, w)
  }
}

function navLines(st: SettingsState, d: SettingsData, w: number): Line[] {
  const pt = d.lang === 'pt'
  const out: Line[] = SETTINGS_SECTIONS.map((id, i) => {
    const on = i === st.section
    const active = on && st.pane === 'nav'
    return fitLine([seg(on ? '▸ ' : '  ', { color: active ? COLORS.accent : COLORS.muted }), seg(SECTION_LABEL[id][d.lang], { color: on ? COLORS.text : COLORS.label, bold: on })], w)
  })
  out.push([], fitLine([seg(pt ? 'web e terminal editam' : 'web and terminal edit', { color: COLORS.muted })], w), fitLine([seg(pt ? 'as mesmas preferências' : 'the same preferences', { color: COLORS.muted })], w))
  return out
}

/**
 * The overlay body: `rows` lines of exactly `width` cells. Wide: the list and the section side by side
 * with a rule between them. Narrow (< 100): the pane that has the keyboard, headed by the section name.
 */
export function settingsLines(st: SettingsState, d: SettingsData, width: number, rows: number, narrow: boolean): Line[] {
  if (narrow) {
    if (st.pane === 'nav') return navLines(st, d, width).slice(0, rows)
    const head = fitLine([seg(`‹ ${SECTION_LABEL[sectionOf(st)][d.lang]}`, { color: COLORS.accent, bold: true })], width)
    return [head, [], ...sectionLines(st, d, width, rows - 2)].slice(0, rows)
  }
  const navW = Math.min(NAV_W, Math.floor(width / 3))
  const contentW = Math.max(1, width - navW - 3)
  const nav = navLines(st, d, navW)
  const content = sectionLines(st, d, contentW, rows)
  const out: Line[] = []
  for (let i = 0; i < rows; i++) {
    const l = nav[i] ?? []
    const pad = navW - cellWidth(l.map(s => s.text).join(''))
    out.push([...l, seg(' '.repeat(Math.max(0, pad))), seg(' │ ', { color: COLORS.border }), ...fitLine(content[i] ?? [], contentW)])
  }
  return out
}

/** A one-line title for the frame: the section in focus. */
export function settingsTitle(st: SettingsState, lang: CliLang): string {
  return `${lang === 'pt' ? 'configurações' : 'settings'} · ${SECTION_LABEL[sectionOf(st)][lang]}`
}

export { truncateCells }

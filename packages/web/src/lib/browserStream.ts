/**
 * browserStream.ts — the web half of the live BROWSER screen (`GET /api/browser/stream`, NAVEGADOR S4).
 *
 * PURE: parsing the `frame` / `state` / `gone` events, the reducer that keeps one screen's view-model,
 * and the honesty line — the phases are `terminalStream.ts`'s, said with the subject `'browser'`, plus
 * the one thing a browser card adds: a card scrolled out of view is NOT watching (no frames are sent for
 * it), so it shows the last picture FROZEN and says so ("paused — scroll here to watch live").
 * The EventSource is `openEventStream` (`streamMux.ts`), never `new EventSource` (house rule).
 */
import { INITIAL_TERMINAL_STATE, terminalStatus, type TerminalPhase, type TerminalStatus } from './terminalStream'

export interface BrowserFrame { tab: string; seq: number; /** the server's viewport epoch (absent from an older server) */ epoch?: number; w: number; h: number; jpeg: string; url: string; title: string; at: number }
export interface BrowserTabView { id: string; title: string; active: boolean }
export interface BrowserScreenStateEvent {
  tab: string
  activeTab: string | null
  lock: 'locked' | 'unlocked' | 'none'
  url: string
  title: string
  loading: boolean
  tabs: BrowserTabView[]
  lastAction: { kind: string; label: string; x?: number; y?: number; at: number } | null
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const json = (raw: string): unknown => { try { return JSON.parse(raw) } catch { return null } }

export function parseBrowserFrame(raw: string): BrowserFrame | null {
  const o = json(raw)
  if (!isRec(o)) return null
  const { tab, seq, w, h, jpeg, url, title, at } = o
  if (typeof tab !== 'string' || typeof seq !== 'number' || typeof w !== 'number' || typeof h !== 'number' || typeof jpeg !== 'string' || jpeg.length === 0) return null
  return { tab, seq, ...(typeof o.epoch === 'number' ? { epoch: o.epoch } : {}), w, h, jpeg, url: typeof url === 'string' ? url : '', title: typeof title === 'string' ? title : '', at: typeof at === 'number' ? at : 0 }
}

export function parseBrowserState(raw: string): BrowserScreenStateEvent | null {
  const o = json(raw)
  if (!isRec(o) || typeof o.tab !== 'string') return null
  const lock = o.lock === 'locked' || o.lock === 'unlocked' || o.lock === 'none' ? o.lock : null
  if (!lock) return null
  const tabs = Array.isArray(o.tabs) ? o.tabs.filter(isRec).filter(t => typeof t.id === 'string').map(t => ({ id: t.id as string, title: typeof t.title === 'string' ? t.title : '', active: t.active === true })) : []
  const la = isRec(o.lastAction) && typeof o.lastAction.kind === 'string' ? o.lastAction : null
  return {
    tab: o.tab, activeTab: typeof o.activeTab === 'string' ? o.activeTab : null, lock,
    url: typeof o.url === 'string' ? o.url : '', title: typeof o.title === 'string' ? o.title : '', loading: o.loading === true, tabs,
    lastAction: la ? {
      kind: la.kind as string, label: typeof la.label === 'string' ? la.label : '',
      ...(typeof la.x === 'number' ? { x: la.x } : {}), ...(typeof la.y === 'number' ? { y: la.y } : {}),
      at: typeof la.at === 'number' ? la.at : 0,
    } : null,
  }
}

export function parseBrowserGone(raw: string): string | null {
  const o = json(raw)
  return isRec(o) && typeof o.reason === 'string' ? o.reason : null
}

export interface BrowserScreenState {
  phase: TerminalPhase
  frame: BrowserFrame | null
  state: BrowserScreenStateEvent | null
  goneReason: string | null
  /** false = this surface is not watching (scrolled away, tab hidden, panel closed): no frames come. */
  watching: boolean
  /** A new connection was opened and has not delivered yet: its sequence restarts, so its first frame is always shown. */
  fresh?: boolean
}

export const INITIAL_BROWSER_SCREEN: BrowserScreenState = { phase: 'idle', frame: null, state: null, goneReason: null, watching: true }

export type BrowserScreenAction =
  | { type: 'connecting' }
  | { type: 'frame'; frame: BrowserFrame }
  | { type: 'state'; state: BrowserScreenStateEvent }
  | { type: 'gone'; reason: string }
  | { type: 'stall' }
  | { type: 'watching'; watching: boolean }

export function browserScreenReducer(s: BrowserScreenState, a: BrowserScreenAction): BrowserScreenState {
  switch (a.type) {
    // A new connection drops nothing it may still show honestly: the picture stays until a new one comes.
    case 'connecting': return { ...s, phase: s.frame ? s.phase : 'connecting', goneReason: null, fresh: true }
    case 'frame':
      // An older frame (a reconnect replaying) never replaces a newer one of the same tab.
      if (!s.fresh && s.frame && s.frame.tab === a.frame.tab && a.frame.seq <= s.frame.seq && s.phase === 'streaming') return s
      // A frame of an OLDER viewport epoch (a size the page has since left) never replaces one of a newer epoch on the same connection.
      if (!s.fresh && s.frame && s.frame.tab === a.frame.tab && s.phase === 'streaming' && a.frame.epoch !== undefined && s.frame.epoch !== undefined && a.frame.epoch < s.frame.epoch) return s
      return { ...s, frame: a.frame, phase: 'streaming', goneReason: null, fresh: false }
    case 'state': return { ...s, state: a.state }
    case 'gone': return { ...s, phase: 'ended', goneReason: a.reason }
    case 'stall': return s.frame ? s : { ...s, phase: 'stalled' }
    case 'watching': return s.watching === a.watching ? s : { ...s, watching: a.watching }
    default: return s
  }
}

/** Watching = the card is in the viewport, the page tab is visible, the panel is open (shellWatching's rule). */
export function browserWatching(input: { inViewport: boolean; documentVisible: boolean; panelOpen: boolean }): boolean {
  return input.inViewport && input.documentVisible && input.panelOpen
}

const GONE_PT: Record<string, string> = {
  idle: 'O navegador foi encerrado por ficar parado.',
  memory: 'O navegador foi encerrado para liberar memória.',
  'session-ended': 'A sessão terminou e o navegador dela foi encerrado.',
  evicted: 'O navegador foi encerrado para dar lugar a outro.',
  requested: 'O navegador foi fechado.',
  tab_closed: 'Esta aba foi fechada.',
  no_browser: 'Este navegador não está aberto.',
}
const GONE_EN: Record<string, string> = {
  idle: 'The browser was closed after sitting idle.',
  memory: 'The browser was closed to free memory.',
  'session-ended': 'The session ended and its browser was closed.',
  evicted: 'The browser was closed to make room for another.',
  requested: 'The browser was closed.',
  tab_closed: 'This tab was closed.',
  no_browser: 'This browser is not open.',
}

/** The honesty line for one browser screen. */
export function browserScreenStatus(s: BrowserScreenState, lang: 'pt' | 'en'): TerminalStatus {
  const pt = lang === 'pt'
  const base = terminalStatus({ ...INITIAL_TERMINAL_STATE, phase: s.phase, frame: s.frame ? ({} as never) : null, endReason: null }, lang, 'browser')
  if (s.phase === 'ended' && s.goneReason) {
    const why = (pt ? GONE_PT : GONE_EN)[s.goneReason]
    return why ? { ...base, detail: s.frame ? `${why} ${pt ? 'A imagem abaixo é a última.' : 'The picture below is the last one.'}` : why } : base
  }
  if (!s.watching && s.frame && s.phase === 'streaming') {
    return { ...base, tone: 'finished', label: pt ? 'Parado' : 'Paused', detail: pt ? 'Parado — role até aqui para ver ao vivo.' : 'Paused — scroll here to watch live.' }
  }
  return base
}

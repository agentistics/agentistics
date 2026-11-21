/**
 * BrowserWindows — the FLOATING browsers, mounted once at the app root beside `NayDock` (NAVEGADOR S11,
 * spec D6/§3.2, prototype `a1-floating` / `b1-floating`).
 *
 * A window is drawn with `NayWindowFrame` (the app-level window — not the Sessions workspace's
 * `FloatingPanelLayer`, which disappears with `/sessions`), so it follows the person to Tarefas, Uso or any
 * other page with frames still arriving. Header buttons, in the prototype's exact order:
 *  - A1 (a session's browser): padlock, full screen, "Voltar para a conversa", minimize;
 *  - B1 (the person's own browser): full screen, "Voltar para a barra", minimize, close.
 * On a phone the window is almost full width and "Voltar" is its icon alone (spec §3.3).
 *
 * One browser is in ONE place (`browserWindows.placeOf`): while a window holds it — open or minimized — its
 * card/panel draws a placeholder, so there is one stream per owner/tab. A minimized window is a chip at the
 * bottom-left; nothing is streamed while it is minimized (nobody is watching — spec §1.5). The padlock (A1)
 * and the vault grant (B1) are the very same ones the card and the panel use: the window adds no door.
 */
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowDownToLine, Lock, LockOpen, Maximize2, Minimize2, MousePointerClick, Pause, PictureInPicture2 } from 'lucide-react'
import { IconButton, NayWindowFrame } from '../nay/NayWindowFrame'
import { BrowserScreen } from './BrowserScreen'
import { BrowserAddressBar } from './BrowserAddressBar'
import { BrowserPanel } from './BrowserPanel'
import { TabDot, TabStripView, type TabStripItem } from '../sessions/SessionTabStrip'
import { useSessionBrowserCard, type SetLock } from '../../hooks/useSessionBrowserCard'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useEscapeOwner } from '../../lib/overlayStack'
import { setBrowserDrawerOpen } from '../../lib/browserDrawer'
import { showPanel } from '../../lib/panelSlots'
import { WINDOW_Z_BASE, type NayWindow } from '../../lib/nayDock'
import {
  dockBrowser, focusBrowser, getBrowserWindows, managedIdOf, minimizeBrowser, mobileWindowGeometry, placeBrowser, restoreBrowser, setBrowserFull,
  updateBrowserWindows, useBrowserWindows, type BrowserWindow, type BrowserWindowId,
} from '../../lib/browserWindows'
import type { OpenStream } from '../../hooks/useBrowserScreen'

type Lang = 'pt' | 'en'

export interface BrowserWindowsProps {
  lang: Lang
  /** Injected in tests: the stream mux otherwise. */
  openStream?: OpenStream
  setLock?: SetLock
  /** Injected in tests: the personal browser's status/grant doubles (`BrowserPanel`'s own). */
  personal?: Partial<Pick<Parameters<typeof BrowserPanel>[0], 'liveOverride' | 'tabsOverride' | 'askGrant' | 'post'>> & { openStream?: (url: string, grant?: string) => ReturnType<OpenStream> }
}

function useViewport(): { w: number; h: number } {
  const read = () => ({ w: typeof window === 'undefined' ? 1280 : window.innerWidth, h: typeof window === 'undefined' ? 800 : window.innerHeight })
  const [vp, setVp] = useState(read)
  useEffect(() => {
    const on = () => setVp(read())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return vp
}

/** "Voltar para a conversa": the window goes and the session opens, its card back in the conversation. */
export function useBrowserVoltar(): (id: BrowserWindowId) => void {
  const navigate = useNavigate()
  const location = useLocation()
  const mobile = useIsMobile()
  return (id: BrowserWindowId) => {
    const from = getBrowserWindows().windows.find(w => w.id === id)?.from
    updateBrowserWindows(s => dockBrowser(s, id))
    const managedId = managedIdOf(id)
    if (managedId) {
      if (location.pathname !== `/sessions/${managedId}`) navigate(`/sessions/${encodeURIComponent(managedId)}`)
      return
    }
    // "Voltar para a barra": the phone has no rail — its browser is the full-screen drawer.
    if (mobile) { setBrowserDrawerOpen(true); return }
    // The rail exists only with a session open: return to the session page it floated from.
    const target = from ?? '/sessions'
    const onSessionPage = /^\/sessions\/[^/]+/.test(location.pathname)
    if (!onSessionPage && location.pathname !== target) navigate(target)
    showPanel('browser', 'main')
  }
}

export function BrowserWindows({ lang, openStream, setLock, personal }: BrowserWindowsProps) {
  const state = useBrowserWindows()
  const voltar = useBrowserVoltar()
  const mobile = useIsMobile()
  const vp = useViewport()
  const open = state.windows.filter(w => !w.minimized)
  const minimized = state.windows.filter(w => w.minimized)
  const pt = lang === 'pt'
  return (
    <>
      {open.map(win => {
        const geometry: Pick<NayWindow, 'x' | 'y' | 'w' | 'h'> = win.full ? { x: 0, y: 0, w: vp.w, h: vp.h } : mobile ? mobileWindowGeometry(vp) : win
        const shown: BrowserWindow = { ...win, ...geometry }
        const common = {
          win: shown, lang, mobile,
          onFocus: () => updateBrowserWindows(s => focusBrowser(s, win.id)),
          onMove: (next: Partial<Pick<NayWindow, 'x' | 'y' | 'w' | 'h'>>) => { if (!win.full && !mobile) updateBrowserWindows((s, v) => placeBrowser(s, win.id, next, v)) },
          onMinimize: () => updateBrowserWindows(s => minimizeBrowser(s, win.id)),
          onToggleFull: () => updateBrowserWindows(s => setBrowserFull(s, win.id, !win.full)),
          onVoltar: () => voltar(win.id),
        }
        const managedId = managedIdOf(win.id)
        return managedId
          ? <SessionBrowserWindow key={win.id} {...common} managedId={managedId} title={win.title} openStream={openStream} setLock={setLock} />
          : <PersonalBrowserWindow key={win.id} {...common} onClose={() => updateBrowserWindows(s => dockBrowser(s, win.id))} personal={personal} />
      })}
      {minimized.length > 0 && (
        <div data-browser-minimized style={{
          position: 'fixed', left: mobile ? 8 : 16, bottom: mobile ? 'calc(84px + var(--safe-bottom, 0px))' : 16, zIndex: WINDOW_Z_BASE,
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, maxWidth: 'calc(100vw / var(--ui-zoom, 1) - 32px)',
        }}>
          {minimized.map(win => {
            const label = windowTitle(win, pt)
            return (
              <div key={win.id} data-browser-chip={win.id} style={{
                display: 'flex', alignItems: 'center', gap: 2, maxWidth: '100%', borderRadius: 999, padding: 2,
                border: '1px solid var(--anthropic-orange)', background: 'var(--bg-surface)', boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
              }}>
                <button type="button" onClick={() => updateBrowserWindows(s => restoreBrowser(s, win.id))} title={pt ? 'Restaurar a janela do navegador' : 'Restore the browser window'} style={{
                  display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, minHeight: mobile ? 44 : 30, padding: '0 10px', border: 'none', borderRadius: 999,
                  background: 'transparent', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}>
                  <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
                  <PictureInPicture2 size={13} aria-hidden style={{ flexShrink: 0, color: 'var(--anthropic-orange)' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                </button>
                <IconButton label={voltarTitle(win.id, pt)} onClick={() => voltar(win.id)} isMobile={mobile} largeTarget={mobile}><ArrowDownToLine size={14} /></IconButton>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function windowTitle(win: Pick<BrowserWindow, 'id' | 'title'>, pt: boolean): string {
  const base = pt ? 'Navegador' : 'Browser'
  return managedIdOf(win.id) && win.title ? `${base} · ${win.title}` : base
}

const voltarLabel = (id: BrowserWindowId, pt: boolean) => managedIdOf(id)
  ? (pt ? 'Voltar para a conversa' : 'Back to the conversation')
  : (pt ? 'Voltar para a barra' : 'Back to the sidebar')
const voltarTitle = (id: BrowserWindowId, pt: boolean) => managedIdOf(id)
  ? (pt ? 'Voltar o navegador para a conversa da sessão' : "Put the browser back in the session's conversation")
  : (pt ? 'Voltar o navegador para a barra da direita' : 'Put the browser back in the right sidebar')

interface WindowProps {
  win: BrowserWindow
  lang: Lang
  mobile: boolean
  onFocus: () => void
  onMove: (next: Partial<Pick<NayWindow, 'x' | 'y' | 'w' | 'h'>>) => void
  onMinimize: () => void
  onToggleFull: () => void
  onVoltar: () => void
}

function FullButton({ full, pt, mobile, onClick }: { full: boolean; pt: boolean; mobile: boolean; onClick: () => void }) {
  return (
    <IconButton label={full ? (pt ? 'Sair da tela cheia' : 'Exit full screen') : (pt ? 'Tela cheia' : 'Full screen')} onClick={onClick} isMobile={mobile}>
      {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </IconButton>
  )
}

function useFullEscape(full: boolean, onToggleFull: () => void): void {
  useEscapeOwner(full, onToggleFull)
}

/** A1 floating: the address row, the live screen, the caption — the card's own state (`useSessionBrowserCard`). */
function SessionBrowserWindow({ win, lang, mobile, onFocus, onMove, onMinimize, onToggleFull, onVoltar, managedId, title, openStream, setLock }: WindowProps & { managedId: string; title?: string; openStream?: OpenStream; setLock?: SetLock }) {
  const pt = lang === 'pt'
  const m = useSessionBrowserCard(managedId, lang, setLock, openStream)
  useFullEscape(win.full, onToggleFull)
  const tabs = m.screen.state?.tabs ?? []
  const watchedTab = m.tab ?? m.screen.state?.activeTab ?? tabs.find(t => t.active)?.id ?? ''
  const items: TabStripItem[] = tabs.map(t => {
    const modelHere = t.id === m.screen.state?.activeTab
    return {
      key: t.id, title: t.title || (pt ? 'Nova aba' : 'New tab'), tooltip: t.title, closable: false,
      leading: <TabDot color="#22c55e" hollow={!modelHere} label={modelHere ? (pt ? 'o modelo está nesta aba' : 'the model is on this tab') : (pt ? 'aba aberta' : 'open tab')} />,
    }
  })
  const history = (action: 'back' | 'forward' | 'reload') => m.input.send({ op: 'history', action })
  return (
    <NayWindowFrame
      win={win} lang={lang} title={windowTitle({ id: win.id, title }, pt)} responsive
      onFocus={onFocus} onMove={onMove} onMinimize={onMinimize} onClose={onMinimize} canClose={false}
      resizable={!win.full && !mobile}
      actions={<>
        <IconButton
          label={m.unlocked ? (pt ? 'Destravado — clique para devolver ao modelo' : 'Unlocked — click to hand it back to the model') : (pt ? 'Travado — clique para usar o navegador' : 'Locked — click to use the browser')}
          onClick={() => void m.toggleLock()} isMobile={mobile} tone={m.unlocked ? 'on' : undefined} pressed={m.unlocked} disabled={m.busy}
        >{m.unlocked ? <LockOpen size={14} /> : <Lock size={14} />}</IconButton>
        <FullButton full={win.full} pt={pt} mobile={mobile} onClick={onToggleFull} />
      </>}
      onDock={onVoltar} dockLabel={voltarLabel(win.id, pt)} dockTitle={voltarTitle(win.id, pt)} dockIconOnly={mobile}
    >
      <div ref={m.watchRef} data-browser-window={win.id} data-geometry={`${win.x},${win.y},${win.w},${win.h}`} data-lock={m.lock} data-full={win.full ? '' : undefined}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-card)', boxShadow: m.unlocked ? 'inset 0 0 0 2px var(--anthropic-orange)' : 'none' }}>
        <BrowserAddressBar
          url={m.url} pt={pt} hasPage={m.unlocked && m.url !== ''} busy={!m.input.ready} readOnly
          onGo={() => {}} onBack={() => history('back')} onForward={() => history('forward')} onReload={() => history('reload')}
        />
        {items.length > 1 && (
          <TabStripView items={items} activeKey={watchedTab} pt={pt} stripAttr="data-browser-tabs" tabAttr="data-browser-tab"
            tablistLabel={pt ? 'Abas do navegador' : 'Browser tabs'} onPick={k => m.setTab(k)} />
        )}
        <BrowserScreen screen={m.screen} lock={m.lock} lang={lang} onResize={m.setSize} {...(m.unlocked ? { onInput: m.input.send } : {})} />
        <div data-browser-caption style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0, minWidth: 0 }}>
          {m.caption.kind === 'yours'
            ? <><Pause size={13} aria-hidden style={{ flexShrink: 0 }} /><span>{pt ? 'Sua vez. Trave o cadeado para devolver ao modelo.' : 'Your turn. Lock the padlock to hand it back to the model.'}</span></>
            : m.caption.kind === 'acting'
              ? <><MousePointerClick size={13} aria-hidden style={{ flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.caption.verb}{m.caption.verb ? ' ' : ''}<b style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{m.caption.target}</b></span></>
              : <><MousePointerClick size={13} aria-hidden style={{ flexShrink: 0 }} /><span>{pt ? 'O modelo está usando este navegador.' : 'The model is using this browser.'}</span></>}
        </div>
        {m.refusal && (
          <div role="alert" data-browser-refusal style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)', background: 'var(--bg-elevated)', flexShrink: 0 }}>{m.refusal.sentence}</div>
        )}
      </div>
    </NayWindowFrame>
  )
}

/** B1 floating: the person's browser, the panel itself without its header (the frame is the header). */
function PersonalBrowserWindow({ win, lang, mobile, onFocus, onMove, onMinimize, onToggleFull, onVoltar, onClose, personal }: WindowProps & { onClose: () => void; personal?: BrowserWindowsProps['personal'] }) {
  const pt = lang === 'pt'
  useFullEscape(win.full, onToggleFull)
  return (
    <NayWindowFrame
      win={win} lang={lang} title={pt ? 'Navegador' : 'Browser'} responsive
      onFocus={onFocus} onMove={onMove} onMinimize={onMinimize} onClose={onClose}
      resizable={!win.full && !mobile}
      actions={<FullButton full={win.full} pt={pt} mobile={mobile} onClick={onToggleFull} />}
      onDock={onVoltar} dockLabel={voltarLabel(win.id, pt)} dockTitle={voltarTitle(win.id, pt)} dockIconOnly={mobile}
    >
      <div data-browser-window={win.id} data-geometry={`${win.x},${win.y},${win.w},${win.h}`} data-full={win.full ? '' : undefined} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <BrowserPanel lang={lang} onClose={onClose} headless {...personal} />
      </div>
    </NayWindowFrame>
  )
}


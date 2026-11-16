/**
 * BrowserPanel — the person's OWN browser, in the sessions workspace's right rail (NAVEGADOR S10, spec §3.2,
 * prototype B1 `b1-open`). Header (globe+search "Navegador", the panel's own controls, close), the session
 * tabs' own `TabStripView` (never a copy of its CSS), `BrowserAddressBar`, and `BrowserScreen` — the same
 * screen the session card draws, here with no padlock: the browser is the person's, so their pointer and keys
 * reach it from the first frame. It is not a session's browser and never shows one; those live in the chat.
 *
 * Nothing is open until the person opens a page: the empty state says so and the address bar is the way in
 * (`POST /api/browser/personal/navigate` starts the Chromium). A server that refuses (no Chromium, the switch
 * off, an exposed profile) says so in the server's own sentence — the control is never dead. "Flutuar" is
 * absent until S11 gives it somewhere to go (a control with nowhere to go is not drawn).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { TabDot, TabStripView, type TabStripItem } from '../sessions/SessionTabStrip'
import { GlobeSearchIcon } from '../../lib/panelIcons'
import { BrowserScreen } from './BrowserScreen'
import { BrowserAddressBar } from './BrowserAddressBar'
import { useBrowserInput, useBrowserScreen, type OpenStream } from '../../hooks/useBrowserScreen'
import { usePersonalActions, usePersonalBrowserLive } from '../../hooks/usePersonalBrowser'
import { useIsMobile } from '../../hooks/useIsMobile'
import { browserWatching } from '../../lib/browserStream'
import { normalizeAddress, type PostFn } from '../../lib/browserPersonal'

export interface BrowserPanelProps {
  lang: 'pt' | 'en'
  onClose: () => void
  /** The right slot's fixed controls (full screen, minimize, gear) already close it; a second × is the same control twice. */
  hideCloseButton?: boolean
  /** The panel's own full-screen / minimize / gear, folded into this header's row (`panelFixedControlsFor`). */
  controls?: ReactNode
  /** Injected in tests. */
  openStream?: OpenStream
  post?: PostFn
  /** Injected in tests: skip the status poll and say whether a personal browser is open. */
  liveOverride?: boolean
}

function useDocumentVisible(): boolean {
  const [v, setV] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const on = () => setV(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return v
}

export function BrowserPanel({ lang, onClose, hideCloseButton, controls, openStream, post, liveOverride }: BrowserPanelProps) {
  const pt = lang === 'pt'
  const mobile = useIsMobile()
  const visible = useDocumentVisible()
  const { live: polled, refresh } = usePersonalBrowserLive(liveOverride === undefined)
  const live = liveOverride ?? polled
  const { act, busy } = usePersonalActions(pt, post)
  const [tab, setTab] = useState<string | null>(null)
  const watching = browserWatching({ inViewport: true, documentVisible: visible, panelOpen: true })
  const screen = useBrowserScreen(live ? 'personal' : null, tab, watching, openStream)
  const input = useBrowserInput(live ? 'personal' : null, tab, live)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)

  const tabs = live ? (screen.state?.tabs ?? []) : []
  const activeId = tab ?? screen.state?.activeTab ?? tabs.find(t => t.active)?.id ?? ''
  const url = live ? (screen.state?.url || screen.frame?.url || '') : ''

  const run = async (a: Parameters<typeof act>[0], args: Record<string, unknown> = {}) => {
    setRefusal(null)
    const r = await act(a, args)
    if (!r.ok) setRefusal(r.sentence)
    else refresh()
    return r
  }
  const go = async (text: string) => {
    const n = normalizeAddress(text, pt)
    if (!n.ok) { setRefusal(n.sentence); return }
    await run('navigate', { url: n.url, ...(live && activeId ? { tab: activeId } : {}) })
  }
  const pick = async (key: string) => {
    setListOpen(false)
    setTab(null)
    await run('tab_select', { tab: key })
  }
  const closeTab = async (key: string) => {
    if (key === tab) setTab(null)
    await run('tab_close', { tab: key })
  }

  const items: TabStripItem[] = tabs.map(t => ({
    key: t.id, title: t.title || (pt ? 'Nova aba' : 'New tab'), tooltip: t.title, closable: true,
    leading: <TabDot color="#22c55e" hollow={t.id !== activeId} label={t.id === activeId ? (pt ? 'aba ativa' : 'active tab') : (pt ? 'aba aberta' : 'open tab')} />,
  }))

  return (
    <div data-browser-panel style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, background: 'var(--bg-card)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, minWidth: 0, padding: mobile ? '8px 12px' : '10px 12px', borderBottom: '1px solid var(--border)', minHeight: mobile ? 44 : undefined, boxSizing: 'border-box' }}>
        <span style={{ color: 'var(--anthropic-orange)', display: 'inline-flex', flexShrink: 0 }}><GlobeSearchIcon size={15} /></span>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.3, color: 'var(--text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {pt ? 'Navegador' : 'Browser'}
        </span>
        <span style={{ flex: 1 }} />
        {!hideCloseButton && (
          <button
            type="button" className="ag-tap-icon" onClick={onClose} title={pt ? 'Fechar' : 'Close'} aria-label={pt ? 'Fechar o navegador' : 'Close the browser'}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 22, flexShrink: 0, borderRadius: 6, padding: 0, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'pointer' }}
          ><X size={13} /></button>
        )}
        {controls}
      </header>
      {live && items.length > 0 ? (
        <TabStripView
          items={items} activeKey={activeId} pt={pt} stripAttr="data-browser-tabs" tabAttr="data-browser-tab"
          tablistLabel={pt ? 'Abas do navegador' : 'Browser tabs'}
          list={{ label: pt ? 'Abas do navegador' : 'Browser tabs', count: items.length, expanded: listOpen, onToggle: () => setListOpen(o => !o) }}
          mobileTabWidth="62%"
          plus={{ label: pt ? 'Nova aba' : 'New tab', onClick: () => void run('tab_new'), disabled: busy }}
          onPick={k => void pick(k)}
          onClose={k => void closeTab(k)}
        >
          {listOpen && (
            <div role="menu" data-browser-tab-list style={{
              position: 'absolute', top: '100%', left: 6, zIndex: 20, minWidth: 220, maxWidth: 'calc(100% - 12px)', padding: 4, borderRadius: 10,
              background: 'var(--bg-elevated)', border: '1px solid var(--border-strong, var(--border))', boxShadow: '0 8px 24px rgba(0,0,0,.35)',
            }}>
              {items.map(it => (
                <button key={it.key} type="button" role="menuitem" onClick={() => void pick(it.key)} style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: mobile ? 44 : 28, padding: '0 10px', border: 'none', borderRadius: 7, textAlign: 'left',
                  background: it.key === activeId ? 'var(--bg-card)' : 'transparent', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer',
                }}>{it.leading}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span></button>
              ))}
            </div>
          )}
        </TabStripView>
      ) : null}
      <BrowserAddressBar
        url={url} pt={pt} hasPage={live && url !== ''} busy={busy}
        onGo={t => void go(t)}
        onBack={() => void run('back', activeId ? { tab: activeId } : {})}
        onForward={() => void run('forward', activeId ? { tab: activeId } : {})}
        onReload={() => void run('reload', activeId ? { tab: activeId } : {})}
      />
      {refusal && (
        <div role="alert" data-browser-refusal style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)', background: 'var(--bg-elevated)', flexShrink: 0 }}>{refusal}</div>
      )}
      {live ? (
        <BrowserScreen screen={screen} lock="none" lang={lang} noPill onInput={input.send} />
      ) : (
        <div data-browser-empty style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--text-tertiary)' }}><GlobeSearchIcon size={28} /></span>
          <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>{pt ? 'Abrir uma página' : 'Open a page'}</div>
          <div style={{ fontSize: 12, lineHeight: 1.5, maxWidth: 280 }}>
            {pt ? 'Digite um endereço acima. As abas ficam aqui, ao lado da conversa.' : 'Type an address above. Your tabs stay here, next to the conversation.'}
          </div>
          <button
            type="button" disabled={busy} onClick={() => void run('tab_new')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: mobile ? 44 : 30, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border-strong, var(--border))', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          ><Plus size={13} aria-hidden />{pt ? 'Nova aba em branco' : 'New blank tab'}</button>
        </div>
      )}
    </div>
  )
}

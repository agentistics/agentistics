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
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Lock, Plus, X } from 'lucide-react'
import { TabDot, TabStripView, type TabStripItem } from '../sessions/SessionTabStrip'
import { GlobeSearchIcon } from '../../lib/panelIcons'
import { BrowserScreen } from './BrowserScreen'
import { BrowserAddressBar } from './BrowserAddressBar'
import { useBrowserScreen, type OpenStream } from '../../hooks/useBrowserScreen'
import { usePersonalActions, usePersonalBrowserLive, type PersonalTabFact } from '../../hooks/usePersonalBrowser'
import { usePersonalInput } from '../../hooks/usePersonalInput'
import { openEventStream } from '../../lib/streamMux'
import { requestPersonalGrant, unlockSentence, usePersonalGrant, type AskGrant } from '../../lib/personalGrant'
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
  /** Open the Vault (`owner_proof_unavailable`: this machine's vault cannot ask a person yet). */
  onOpenVault?: () => void
  /** Injected in tests. The grant is the owner's proof; a real stream carries it in the mux `sub` frame. */
  openStream?: (url: string, grant?: string) => ReturnType<OpenStream>
  post?: PostFn
  /** Injected in tests: skip the status poll and say whether a personal browser is open. */
  liveOverride?: boolean
  /** Injected in tests: the tabs the status poll would report, and when that poll STARTED. */
  tabsOverride?: { tabs: PersonalTabFact[]; asOf: number }
  /** Injected in tests: the vault's proof. */
  askGrant?: AskGrant
}

const ORANGE = 'var(--anthropic-orange)'

/** Client-side navigation to the Vault (a router is not required of whoever mounts the panel). */
function openVaultPage(): void {
  window.history.pushState({}, '', '/vault')
  window.dispatchEvent(new PopStateEvent('popstate'))
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

export function BrowserPanel({ lang, onClose, hideCloseButton, controls, onOpenVault, openStream, post, liveOverride, tabsOverride, askGrant }: BrowserPanelProps) {
  const pt = lang === 'pt'
  const mobile = useIsMobile()
  const visible = useDocumentVisible()
  // S10 r3: the person's own browser answers to the OWNER'S proof (the vault), held in memory by the page. Without
  // it nothing below is drawn that could not work: no address bar, no tabs, no screen — one clear way to prove it.
  const grant = usePersonalGrant()
  const unlocked = grant !== null
  const polled = usePersonalBrowserLive(liveOverride === undefined && unlocked)
  const live = unlocked && (liveOverride ?? polled.live)
  const polledTabs = tabsOverride ?? { tabs: polled.tabs, asOf: polled.asOf }
  const { act, busy } = usePersonalActions(pt, post)
  const refresh = polled.refresh
  const [tab, setTab] = useState<string | null>(null)
  // When the CURRENT subscription started: a status poll that began before it cannot speak about it.
  const subscribedAt = useRef(0)
  const [reopen, setReopen] = useState(0)
  const watching = browserWatching({ inViewport: true, documentVisible: visible, panelOpen: true })
  // The grant goes in the mux `sub` frame (never the URL); a new `open` identity re-subscribes (after a closed tab).
  const open = useMemo<OpenStream>(() => (url: string) => (openStream ?? openEventStream)(url, grant ?? undefined) as ReturnType<OpenStream>, [openStream, grant, reopen])
  const screen = useBrowserScreen(live ? 'personal' : null, tab, watching, open)
  const input = usePersonalInput(tab, grant, live)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [unlockRefusal, setUnlockRefusal] = useState<{ sentence: string; openVault: boolean } | null>(null)
  const [proving, setProving] = useState(false)
  const [listOpen, setListOpen] = useState(false)

  const prove = async () => {
    setProving(true); setUnlockRefusal(null)
    try {
      const r = await requestPersonalGrant(askGrant, pt)
      if (!r.ok) setUnlockRefusal({ sentence: r.sentence, openVault: r.openVault })
    } finally { setProving(false) }
  }

  const tabs = live ? (screen.state?.tabs ?? []) : []
  // The tab the stream is on: the pinned one, else the one the server resolved when it subscribed.
  const watched = live ? (tab ?? screen.state?.tab ?? null) : null
  const activeId = tab ?? screen.state?.activeTab ?? tabs.find(t => t.active)?.id ?? ''
  const url = live ? (screen.state?.url || screen.frame?.url || '') : ''

  const run = async (a: Parameters<typeof act>[0], args: Record<string, unknown> = {}) => {
    setRefusal(null)
    const r = await act(a, args)
    // `needsUnlock`: the server no longer knows our grant — it was cleared, so the panel is back at "unlock".
    if (!r.ok) setRefusal(r.needsUnlock ? null : r.sentence)
    else refresh()
    return r
  }
  const pin = (key: string | null) => setTab(key)
  const go = async (text: string) => {
    const n = normalizeAddress(text, pt)
    if (!n.ok) { setRefusal(n.sentence); return }
    await run('navigate', { url: n.url, ...(live && activeId ? { tab: activeId } : {}) })
  }
  // F1: a picked tab STAYS chosen — the stream (and the input socket) re-open on THAT tab, because the server
  // resolves a tab-less subscription once, at subscribe. Left at null the strip marked the new tab and the
  // screen and address stayed on the old one.
  const pick = async (key: string) => {
    setListOpen(false)
    pin(key)
    await run('tab_select', { tab: key })
  }
  // Closing the tab on screen: the close FIRST, then re-subscribe — resolved before it, the new stream would pick the
  // very tab being closed (still the active one) and sit on a dead target.
  const closeTab = async (key: string) => {
    await run('tab_close', { tab: key })
    if (key === watched) letGo()
  }
  // F1-r2a: a new tab is the one to SHOW — pin the id `tab_new` answered, so the stream (and the address) open on
  // it. Resolving it later, at subscribe, left the screen on the old tab (and a pinned old tab stayed pinned).
  const newTab = async () => {
    const r = await run('tab_new')
    if (r.ok && r.tab) pin(r.tab)
    else if (r.ok) pin(null)
  }
  // F1-r2b: a tab closed from somewhere else (the page, a popup, another window) leaves a stream on a dead target
  // that never speaks again. Two voices say so — the stream's own `gone: tab_closed` and the status poll — and
  // either way the panel lets go of the pin and RE-SUBSCRIBES, so the strip, the screen and the address land on
  // the tab the browser is on now.
  const letGo = () => { setTab(null); setReopen(n => n + 1) }
  useEffect(() => { subscribedAt.current = Date.now() }, [tab, open, live])
  useEffect(() => {
    if (live && screen.goneReason === 'tab_closed') letGo()
  }, [live, screen.goneReason])
  // The poll covers a stream that stays silent — pinned OR following the active tab (its resolved tab is in its state).
  useEffect(() => {
    if (!live || !watched || polledTabs.asOf <= subscribedAt.current || polledTabs.tabs.length === 0) return
    if (!polledTabs.tabs.some(t => t.id === watched)) letGo()
  }, [live, watched, polledTabs.tabs, polledTabs.asOf])

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
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: mobile ? 44 : 26, height: mobile ? 44 : 22, flexShrink: 0, borderRadius: 6, padding: 0, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'pointer' }}
          ><X size={13} /></button>
        )}
        {controls}
      </header>
      {!unlocked ? (
        <div data-browser-locked style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--text-tertiary)' }}><Lock size={28} aria-hidden /></span>
          <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>{pt ? 'Navegador pessoal travado' : 'Personal browser locked'}</div>
          <div style={{ fontSize: 12, lineHeight: 1.5, maxWidth: 300 }}>{unlockSentence(pt)}</div>
          <button
            type="button" data-browser-unlock disabled={proving} onClick={() => void prove()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: mobile ? 44 : 30, padding: '4px 12px', borderRadius: 7, border: `1px solid ${ORANGE}`, background: 'var(--anthropic-orange-dim)',
              color: ORANGE, fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, cursor: proving ? 'default' : 'pointer',
            }}
          ><Lock size={13} aria-hidden />{pt ? 'Desbloquear com o Cofre' : 'Unlock with the Vault'}</button>
          {unlockRefusal && (
            <div role="alert" data-browser-refusal style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'center', padding: '8px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)', background: 'var(--bg-elevated)', maxWidth: 340 }}>
              <span style={{ minWidth: 0 }}>{unlockRefusal.sentence}</span>
              {unlockRefusal.openVault && (
                <button type="button" data-browser-open-vault onClick={onOpenVault ?? openVaultPage} style={{
                  flexShrink: 0, padding: '4px 10px', borderRadius: 7, border: `1px solid ${ORANGE}`, background: 'var(--anthropic-orange-dim)',
                  color: ORANGE, fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', minHeight: mobile ? 44 : undefined,
                }}>{pt ? 'Abrir o Cofre' : 'Open the Vault'}</button>
              )}
            </div>
          )}
        </div>
      ) : (<>
      {live && items.length > 0 ? (
        <TabStripView
          items={items} activeKey={activeId} pt={pt} stripAttr="data-browser-tabs" tabAttr="data-browser-tab"
          tablistLabel={pt ? 'Abas do navegador' : 'Browser tabs'}
          list={{ label: pt ? 'Abas do navegador' : 'Browser tabs', count: items.length, expanded: listOpen, onToggle: () => setListOpen(o => !o) }}
          mobileTabWidth="62%"
          plus={{ label: pt ? 'Nova aba' : 'New tab', onClick: () => void newTab(), disabled: busy }}
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
            type="button" disabled={busy} onClick={() => void newTab()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: mobile ? 44 : 30, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border-strong, var(--border))', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          ><Plus size={13} aria-hidden />{pt ? 'Nova aba em branco' : 'New blank tab'}</button>
        </div>
      )}
      </>)}
    </div>
  )
}

/**
 * BrowserSessionCard — a session's browser inside its conversation (NAVEGADOR S5, spec §3.2, prototype A1:
 * `a1-locked`, `a1-unlocked`, `a1-max`).
 *
 * Head: the address (read-only), the padlock, full screen (and Flutuar once S11 hands `onFloat`); body: the
 * live `BrowserScreen`; foot: what the model is doing, or "your turn" while the person holds it. ONE card per
 * session — later calls update this card, it never moves. Full screen is the same card in a rectangle over
 * the session area (the conversation and the composer are covered); `Esc` leaves it.
 *
 * Unlocking is the person's: the padlock route with their single-use VAULT grant (S4b), never a second proof
 * path (`setBrowserLock` → `postWithOwnerProof`). A machine that cannot prove says so and offers the Vault.
 * Tabs: when the model opened more than one, the browser's tabs ride `TabStripView` — the session tabs' own
 * component, so they cannot look different — and picking one chooses which tab this card WATCHES (the
 * model's tabs are the model's to open and close).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Lock, LockOpen, Maximize2, Minimize2, MousePointerClick, Pause, PictureInPicture2 } from 'lucide-react'
import { IconButton } from '../nay/NayWindowFrame'
import { TabDot, TabStripView, type TabStripItem } from '../sessions/SessionTabStrip'
import { BrowserScreen } from './BrowserScreen'
import { useBrowserInput, useBrowserScreen, type OpenStream, type ViewerSize } from '../../hooks/useBrowserScreen'
import { useIsMobile } from '../../hooks/useIsMobile'
import { browserWatching } from '../../lib/browserStream'
import { browserCaption, displayUrl, setBrowserLock, type LockOutcome } from '../../lib/browserCard'

export const CARD_H_DESKTOP = 330
export const CARD_H_MOBILE = 290
const ORANGE = 'var(--anthropic-orange)'

export interface BrowserSessionCardProps {
  managedId: string
  lang: 'pt' | 'en'
  maximized: boolean
  onToggleMax: () => void
  /** S11 (floating window). Absent = no Flutuar button (a control with nowhere to go is not drawn). */
  onFloat?: () => void
  /** Open the Vault (owner_proof_unavailable). */
  onOpenVault: () => void
  /** Injected in tests; the vault grant for one browser. */
  setLock?: (managedId: string, lock: 'locked' | 'unlocked', pt: boolean) => Promise<LockOutcome>
  /** Injected in tests; the stream mux otherwise (a module mock would leak into every later test file). */
  openStream?: OpenStream
}

/** Is this element on screen while the page is visible? (the card's "watching" — spec §1.5). */
function useWatching(): [(el: HTMLDivElement | null) => void, boolean] {
  const [inView, setInView] = useState(true)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const obs = useRef<IntersectionObserver | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    obs.current?.disconnect()
    obs.current = null
    if (!el || typeof IntersectionObserver === 'undefined') return
    const o = new IntersectionObserver(entries => { for (const e of entries) setInView(e.isIntersecting) })
    o.observe(el)
    obs.current = o
  }, [])
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => { document.removeEventListener('visibilitychange', on); obs.current?.disconnect() }
  }, [])
  return [ref, browserWatching({ inViewport: inView, documentVisible: visible, panelOpen: true })]
}

export function BrowserSessionCard({ managedId, lang, maximized, onToggleMax, onFloat, onOpenVault, setLock = setBrowserLock, openStream }: BrowserSessionCardProps) {
  const pt = lang === 'pt'
  const mobile = useIsMobile()
  const cardFocus = useRef<HTMLDivElement | null>(null)
  useEffect(() => { if (maximized) cardFocus.current?.focus() }, [maximized])
  const [watchRef, watching] = useWatching()
  const [tab, setTab] = useState<string | null>(null)
  const [size, setSize] = useState<ViewerSize>()
  const screen = useBrowserScreen(managedId, tab, watching && (size !== undefined || typeof ResizeObserver === 'undefined'), openStream, size)
  const serverLock = screen.state?.lock === 'unlocked' ? 'unlocked' : 'locked'
  // The answer of the person's own click, until the server's next `state` says the same (≤ 500 ms).
  const [mine, setMine] = useState<'locked' | 'unlocked' | null>(null)
  useEffect(() => { if (mine !== null && serverLock === mine) setMine(null) }, [serverLock, mine])
  const lock = mine ?? serverLock
  const unlocked = lock === 'unlocked'
  const input = useBrowserInput(managedId, tab, unlocked)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<{ sentence: string; openVault: boolean } | null>(null)

  const toggleLock = async () => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    const want = unlocked ? 'locked' : 'unlocked'
    try {
      const r = await setLock(managedId, want, pt)
      if (r.ok) setMine(r.lock)
      else setRefusal({ sentence: r.sentence, openVault: r.openVault })
    } catch {
      setRefusal({ sentence: pt ? 'Não foi possível mudar o cadeado.' : 'Could not change the padlock.', openVault: false })
    } finally {
      setBusy(false)
    }
  }

  const url = screen.state?.url || screen.frame?.url || ''
  const caption = browserCaption(screen.state ? lock : null, screen.state?.lastAction ?? null, lang)
  const tabs = screen.state?.tabs ?? []
  const watchedTab = tab ?? screen.state?.activeTab ?? tabs.find(t => t.active)?.id ?? ''
  const items: TabStripItem[] = tabs.map(t => {
    const modelHere = t.id === screen.state?.activeTab
    const label = modelHere ? (pt ? 'o modelo está nesta aba' : 'the model is on this tab') : (pt ? 'aba aberta' : 'open tab')
    return {
      key: t.id, title: t.title || (pt ? 'Nova aba' : 'New tab'), tooltip: t.title, closable: false,
      leading: <TabDot color="#22c55e" hollow={!modelHere} label={label} />,
    }
  })
  const radius = maximized && mobile ? 0 : 16

  return (
    <div
      ref={cardFocus} tabIndex={maximized ? -1 : undefined}
      onKeyDownCapture={maximized ? e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onToggleMax() } } : undefined}
      onKeyUpCapture={maximized ? e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation() } } : undefined}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, ...(maximized ? { height: '100%' } : null) }}>
      <div
        ref={watchRef}
        data-browser-card={managedId}
        data-lock={lock}
        data-maximized={maximized ? '' : undefined}
        style={{
          display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden', boxSizing: 'border-box',
          height: maximized ? '100%' : (mobile ? CARD_H_MOBILE : CARD_H_DESKTOP),
          background: 'var(--bg-card)', borderRadius: radius,
          border: `1px solid ${unlocked ? ORANGE : 'var(--border-strong, var(--border))'}`,
          boxShadow: unlocked ? `0 0 0 1px ${ORANGE}` : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px 7px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0, fontSize: 12 }}>
          <span data-browser-url title={url} style={{
            flex: 1, minWidth: 0, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 999, padding: '3px 10px',
            color: 'var(--text-secondary)', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{displayUrl(url) || (pt ? 'abrindo…' : 'opening…')}</span>
          <IconButton
            label={unlocked ? (pt ? 'Destravado — clique para devolver ao modelo' : 'Unlocked — click to hand it back to the model') : (pt ? 'Travado — clique para usar o navegador' : 'Locked — click to use the browser')}
            onClick={() => void toggleLock()} isMobile={mobile} tone={unlocked ? 'on' : 'framed'} pressed={unlocked} disabled={busy}
          >{unlocked ? <LockOpen size={15} /> : <Lock size={15} />}</IconButton>
          <IconButton label={maximized ? (pt ? 'Sair da tela cheia' : 'Exit full screen') : (pt ? 'Tela cheia' : 'Full screen')} onClick={onToggleMax} isMobile={mobile}>
            {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </IconButton>
          {onFloat && (
            <button type="button" onClick={onFloat} title={pt ? 'Abrir numa janela flutuante, para acompanhar de qualquer página' : 'Open in a floating window, to follow it from any page'} style={{
              display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, height: 28, padding: '0 9px', borderRadius: 8,
              border: '1px solid var(--border-strong, var(--border))', background: 'var(--bg-elevated)', color: 'var(--text-primary)',
              fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer',
            }}><PictureInPicture2 size={13} aria-hidden />{pt ? 'Flutuar' : 'Float'}</button>
          )}
        </div>
        {items.length > 1 && (
          <TabStripView
            items={items} activeKey={watchedTab} pt={pt} stripAttr="data-browser-tabs" tabAttr="data-browser-tab"
            tablistLabel={pt ? 'Abas do navegador' : 'Browser tabs'}
            onPick={k => setTab(k)}
          />
        )}
        <BrowserScreen screen={screen} lock={lock} lang={lang} onResize={setSize} reserveEscape={maximized} {...(unlocked ? { onInput: input.send } : {})} />
        <div data-browser-caption style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0, minWidth: 0 }}>
          {caption.kind === 'yours'
            ? <><Pause size={13} aria-hidden style={{ flexShrink: 0 }} /><span>{pt ? 'Sua vez. Trave o cadeado para devolver ao modelo.' : 'Your turn. Lock the padlock to hand it back to the model.'}</span></>
            : caption.kind === 'acting'
              ? <><MousePointerClick size={13} aria-hidden style={{ flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{caption.verb}{caption.verb ? ' ' : ''}<b style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{caption.target}</b></span></>
              : <><MousePointerClick size={13} aria-hidden style={{ flexShrink: 0 }} /><span>{pt ? 'O modelo está usando este navegador.' : 'The model is using this browser.'}</span></>}
        </div>
        {refusal && (
          <div role="alert" data-browser-refusal style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)', background: 'var(--bg-elevated)', flexShrink: 0 }}>
            <span style={{ flex: 1, minWidth: 0 }}>{refusal.sentence}</span>
            {refusal.openVault && (
              <button type="button" onClick={onOpenVault} style={{
                flexShrink: 0, padding: '4px 10px', borderRadius: 7, border: `1px solid ${ORANGE}`, background: 'var(--anthropic-orange-dim)',
                color: ORANGE, fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', minHeight: mobile ? 44 : undefined,
              }}>{pt ? 'Abrir o Cofre' : 'Open the Vault'}</button>
            )}
          </div>
        )}
      </div>
      {!maximized && !unlocked && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          <Activity size={12} aria-hidden />{pt ? 'O modelo continua aqui embaixo enquanto navega.' : 'The model keeps going below while it browses.'}
        </div>
      )}
    </div>
  )
}

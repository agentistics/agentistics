/**
 * SessionBrowser — how the session browser card lives in a conversation (NAVEGADOR S5, spec §3.2):
 * `useSessionBrowser` decides IF and WHERE (one card per session, anchored at the first browser call, else
 * at the end while the host says a browser is live), `SessionBrowserBlock` is what sits in the message
 * column, and `SessionBrowserOverlay` is the same card at full screen over the session area (`a1-max`): the
 * conversation and the composer are covered, the session's top bar stays. The card is drawn in ONE place at
 * a time, never twice.
 */
import { useEffect, useMemo, useState } from 'react'
import { Globe } from 'lucide-react'
import { BrowserSessionCard } from './BrowserSessionCard'
import { browserAnchor } from '../../lib/browserCard'
import { useSessionBrowserLive, type OpenStream } from '../../hooks/useBrowserScreen'
import { useIsMobile } from '../../hooks/useIsMobile'
import { overlayPadding } from '../../lib/mobileOverlay'

export interface SessionBrowserModel {
  /** Index into the conversation's turns the card follows (`turns.length` = the end), or null = no card. */
  anchor: number | null
  live: boolean
  maximized: boolean
  setMaximized: (m: boolean) => void
}

export function useSessionBrowser(managedId: string | null, turns: ReadonlyArray<{ tools?: ReadonlyArray<{ name: string }> }>): SessionBrowserModel {
  const live = useSessionBrowserLive(managedId)
  const [maximized, setMaximized] = useState(false)
  useEffect(() => { if (!live) setMaximized(false) }, [live])
  useEffect(() => { setMaximized(false) }, [managedId])
  const anchor = useMemo(() => browserAnchor(turns, live), [turns, live])
  return { anchor, live, maximized, setMaximized }
}

interface Props { managedId: string; lang: 'pt' | 'en'; model: SessionBrowserModel; onOpenVault: () => void; openStream?: OpenStream }

/** In the message column: the card, or — once its browser is closed — one quiet line. Nothing while maximized. */
export function SessionBrowserBlock({ managedId, lang, model, onOpenVault, openStream }: Props) {
  const pt = lang === 'pt'
  if (model.anchor === null) return null
  if (!model.live) {
    return (
      <div data-browser-closed style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        <Globe size={12} aria-hidden />{pt ? 'O navegador desta sessão está fechado.' : "This session's browser is closed."}
      </div>
    )
  }
  if (model.maximized) return null
  return <BrowserSessionCard managedId={managedId} lang={lang} maximized={false} onToggleMax={() => model.setMaximized(true)} onOpenVault={onOpenVault} openStream={openStream} />
}

/** Full screen over the session area (its parent is the conversation panel, `position: relative`). */
export function SessionBrowserOverlay({ managedId, lang, model, onOpenVault, openStream }: Props) {
  const mobile = useIsMobile()
  if (!model.live || !model.maximized || model.anchor === null) return null
  return (
    <div data-browser-max style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'var(--bg-base)', display: 'flex', padding: overlayPadding(mobile, 10), boxSizing: 'border-box' }}>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <BrowserSessionCard managedId={managedId} lang={lang} maximized onToggleMax={() => model.setMaximized(false)} onOpenVault={onOpenVault} openStream={openStream} />
      </div>
    </div>
  )
}

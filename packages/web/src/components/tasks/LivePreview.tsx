/**
 * LivePreview — the Live Delivery preview opened FROM a session (LIVE.ATALHO, restored after TOPBAR.AGRUPAR).
 *
 * The top bar's grouped button used to navigate the main window to Agentask → Live, which leaves the session the
 * person is in. Inside a session the Live row opens THIS instead: the REAL Live view (same component, same book
 * SSE + fleet stream — no polling of its own) already filtered by that session's task, over the session, so
 * nothing is lost. Desktop: a large popover under the top bar, closed by Esc, the X or a click outside; clicking
 * the preview's own surface (not a card or a control) goes to the full Live. Phone: a bottom sheet with an
 * "Open Live Delivery" button. The board is mounted only while open.
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { pathOfView } from '../../lib/tasksViewRoute'
import { LiveDelivery } from './LiveDelivery'
import { popoverClickGoes } from './liveShortcutModel'

/** The session id when the page is a session (`/sessions/<id>`), else null. */
export function sessionIdOfPath(pathname: string): string | null {
  const m = /^\/sessions\/([^/?#]+)/.exec(pathname)
  if (!m) return null
  try { return decodeURIComponent(m[1]!) } catch { return m[1]! }
}

export function LivePreview({ lang, open, onClose, focusSessionId }: { lang: 'pt' | 'en'; open: boolean; onClose: () => void; focusSessionId: string | null }) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const box = useRef<HTMLDivElement>(null)
  const go = () => { onClose(); navigate(pathOfView('live')) }
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => { if (!isMobile && box.current && !box.current.contains(e.target as Node | null)) onClose() }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [open, isMobile, onClose])
  if (!open) return null
  const title = pt ? 'Esteira de entregas ao vivo' : 'Live Delivery'

  if (isMobile) {
    return createPortal(
      <div role="dialog" aria-modal="true" aria-label={title} data-live-sheet style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'flex-end' }}>
        <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)' }} />
        <div style={{
          position: 'relative', width: '100%', maxHeight: 'calc(86dvh / var(--ui-zoom, 1))', display: 'flex', flexDirection: 'column', background: 'var(--bg-surface)',
          borderTopLeftRadius: 16, borderTopRightRadius: 16, border: '1px solid var(--border)', paddingBottom: 'var(--safe-bottom, 0px)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '6px 8px 0' }}>
            <button type="button" className="ag-tap-icon" aria-label={pt ? 'Fechar' : 'Close'} onClick={onClose}
              style={{ width: 44, height: 44, border: 0, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer' }}><X size={18} /></button>
          </div>
          <div className="ag-scroll" style={{ overflowY: 'auto', padding: '0 12px 8px', minHeight: 0 }}><LiveDelivery lang={lang} compact focusSessionId={focusSessionId} /></div>
          <div style={{ padding: '8px 12px 12px' }}>
            <button type="button" className="ag-tap" onClick={go} style={{
              width: '100%', minHeight: 44, borderRadius: 10, border: 0, background: 'var(--anthropic-orange)', color: '#fff',
              fontFamily: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>{pt ? 'Abrir esteira de entregas' : 'Open Live Delivery'}</button>
          </div>
        </div>
      </div>, document.body)
  }

  return (
    <div ref={box} role="dialog" aria-label={title} data-live-popover
      onClick={e => { if (popoverClickGoes(e.target as HTMLElement)) go() }}
      style={{ position: 'absolute', top: '100%', right: 0, paddingTop: 8, zIndex: 910 }}>
      <div style={{
        position: 'relative', width: 'min(780px, calc(100vw / var(--ui-zoom, 1) - 24px))', height: 'min(560px, calc(72vh / var(--ui-zoom, 1)))', overflow: 'hidden', padding: 12, boxSizing: 'border-box',
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 18px 50px rgba(0,0,0,.45)', cursor: 'pointer',
      }}>
        <button type="button" aria-label={pt ? 'Fechar' : 'Close'} onClick={e => { e.stopPropagation(); onClose() }}
          style={{ position: 'absolute', top: 6, right: 6, zIndex: 1, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer' }}><X size={16} /></button>
        <LiveDelivery lang={lang} compact focusSessionId={focusSessionId} />
      </div>
    </div>
  )
}

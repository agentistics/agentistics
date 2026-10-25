import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useEscapeOwner } from '../lib/overlayStack'

/** Shared phone sheet frame: one Escape owner, focus containment and safe-area padding. */
export function BottomSheet({ open, onClose, title, lang, footer, children }: {
  open: boolean
  onClose: () => void
  title: string
  lang: 'pt' | 'en'
  footer?: ReactNode
  children: ReactNode
}) {
  const dialog = useRef<HTMLDivElement>(null)
  useEscapeOwner(open, onClose)
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.focus()
    return () => { if (opener?.isConnected) opener.focus() }
  }, [open])

  const trapFocus = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const targets = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
    )).filter(el => el.getClientRects().length > 0 && !el.closest('[inert]'))
    const first = targets[0]
    const last = targets[targets.length - 1]
    if (!first) { e.preventDefault(); e.currentTarget.focus(); return }
    if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) {
      e.preventDefault(); last?.focus()
    } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === e.currentTarget)) {
      e.preventDefault(); first.focus()
    }
  }
  if (!open) return null
  const pt = lang === 'pt'
  return (
    <div
      ref={dialog}
      role="dialog"
      tabIndex={-1}
      onKeyDown={trapFocus}
      aria-modal="true"
      aria-label={title}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 400, background: 'var(--ag-scrim)',
        display: 'flex', alignItems: 'flex-end',
      }}
    >
      <div style={{
        width: '100%', maxHeight: 'calc(88vh / var(--ui-zoom, 1))', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-surface)', borderTopLeftRadius: 16, borderTopRightRadius: 16,
        borderTop: '1px solid var(--border)',
        // The sheet reaches the bottom edge of the screen, so it owns the home-indicator band —
        // the same inset `.mobile-bottom-nav` pads itself with.
        paddingBottom: 'var(--mobile-nav-inset)',
        boxSizing: 'border-box',
      }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', flexShrink: 0,
          borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ margin: 0, flex: 1, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label={pt ? 'Fechar' : 'Close'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 44, height: 44, marginRight: -8, border: 'none', background: 'transparent',
              color: 'var(--text-tertiary)', cursor: 'pointer',
            }}
          >
            <X size={18} />
          </button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '12px 0 16px' }}>
          {children}
        </div>

        {footer}
      </div>
    </div>
  )
}

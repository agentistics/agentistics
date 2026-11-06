/**
 * LiveShortcut — the Live Delivery button in the Sessions top bar (LIVE.ATALHO, mockup V1).
 * Desktop: resting the pointer ~0.3 s opens a large popover with the REAL Live view (same component, same
 * book SSE + fleet stream — no polling of its own); it stays open while the pointer is over it; clicking the
 * button or the popover's own surface goes to Agentask → Live. Phone: tap opens a bottom sheet with the same
 * preview and an "Abrir Live Delivery" button. The board is mounted only while open.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Radio, X } from 'lucide-react'
import { useFleet } from '../../lib/fleet'
import { useIsMobile } from '../../hooks/useIsMobile'
import { pathOfView } from '../../lib/tasksViewRoute'
import { LiveDelivery } from './LiveDelivery'
import { HOVER_CLOSE_MS, HOVER_OPEN_MS, liveActivity, popoverClickGoes, shortcutLabel } from './liveShortcutModel'

const reduced = (): boolean => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }

export default function LiveShortcut({ lang, enabled = true }: { lang: 'pt' | 'en'; enabled?: boolean }) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const { fleet } = useFleet(lang, enabled)
  const act = liveActivity(fleet.sessions)
  const [open, setOpen] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = () => { if (openTimer.current) clearTimeout(openTimer.current); if (closeTimer.current) clearTimeout(closeTimer.current) }
  useEffect(() => clear, [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  if (!enabled) return null

  const go = () => { clear(); setOpen(false); navigate(pathOfView('live')) }
  const enter = () => { if (isMobile) return; clear(); openTimer.current = setTimeout(() => setOpen(true), HOVER_OPEN_MS) }
  const leave = () => { if (isMobile) return; clear(); closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS) }
  const fade = reduced() ? 'opacity .12s' : 'opacity .15s, transform .15s'

  const button = (
    <button
      type="button" className="ag-tap-icon" data-live-shortcut aria-label={shortcutLabel(act, pt)} title={shortcutLabel(act, pt)}
      aria-haspopup="dialog" aria-expanded={open}
      onClick={() => (isMobile ? setOpen(v => !v) : go())}
      style={{
        position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8,
        border: `1px solid ${act.waiting > 0 ? 'var(--anthropic-orange)' : 'var(--border)'}`, background: 'transparent',
        color: open ? 'var(--text-primary)' : 'var(--text-tertiary)', cursor: 'pointer', flexShrink: 0,
      }}
    >
      <Radio size={15} aria-hidden />
      {act.waiting > 0 ? (
        <span data-live-badge style={{
          position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, boxSizing: 'border-box',
          background: 'var(--anthropic-orange)', color: '#fff', fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center',
        }}>{act.waiting > 9 ? '9+' : act.waiting}</span>
      ) : act.working > 0 ? (
        <span data-live-pulse aria-hidden className={reduced() ? undefined : 'ag-live-pulse'} style={{
          position: 'absolute', top: -2, right: -2, width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-green, #3ecf8e)',
        }} />
      ) : null}
    </button>
  )

  if (isMobile) {
    return (
      <>
        {button}
        {open && createPortal(
          <div role="dialog" aria-modal="true" aria-label="Live Delivery" data-live-sheet style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'flex-end' }}>
            <div onClick={() => setOpen(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)' }} />
            <div style={{
              position: 'relative', width: '100%', maxHeight: 'calc(86dvh / var(--ui-zoom, 1))', display: 'flex', flexDirection: 'column', background: 'var(--bg-surface)',
              borderTopLeftRadius: 16, borderTopRightRadius: 16, border: '1px solid var(--border)', paddingBottom: 'var(--safe-bottom, 0px)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '6px 8px 0' }}>
                <button type="button" className="ag-tap-icon" aria-label={pt ? 'Fechar' : 'Close'} onClick={() => setOpen(false)}
                  style={{ width: 32, height: 32, border: 0, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer' }}><X size={18} /></button>
              </div>
              <div className="ag-scroll" style={{ overflowY: 'auto', padding: '0 12px 8px', minHeight: 0 }}><LiveDelivery lang={lang} compact /></div>
              <div style={{ padding: '8px 12px 12px' }}>
                <button type="button" className="ag-tap" onClick={go} style={{
                  width: '100%', minHeight: 44, borderRadius: 10, border: 0, background: 'var(--anthropic-orange)', color: '#fff',
                  fontFamily: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                }}>{pt ? 'Abrir Live Delivery' : 'Open Live Delivery'}</button>
              </div>
            </div>
          </div>, document.body)}
      </>
    )
  }

  return (
    <div style={{ position: 'relative', display: 'flex' }} onMouseEnter={enter} onMouseLeave={leave}>
      {button}
      {open && (
        <div
          role="dialog" aria-label="Live Delivery" data-live-popover
          onClick={e => { if (popoverClickGoes(e.target as HTMLElement)) go() }}
          style={{
            position: 'absolute', top: '100%', right: 0, paddingTop: 8, zIndex: 900, animation: 'none', transition: fade,
          }}
        >
          <div style={{
            width: 'min(780px, calc(100vw / var(--ui-zoom, 1) - 24px))', height: 'min(560px, calc(72vh / var(--ui-zoom, 1)))', overflow: 'hidden', padding: 12, boxSizing: 'border-box',
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 18px 50px rgba(0,0,0,.45)', cursor: 'pointer',
          }}><LiveDelivery lang={lang} compact /></div>
        </div>
      )}
    </div>
  )
}

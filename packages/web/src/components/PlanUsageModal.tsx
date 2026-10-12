/**
 * PlanUsageModal.tsx — every plan's limits in a centred modal, opened from the sidebar foot's
 * "Uso" button, its popover's "Abrir ›", the session drawer and the Nay notification card. The
 * body IS Nay's Limits tab (`NayLimitsTab`), so no meter or number is derived a second time.
 * Shell as `HardwareModal`: backdrop and `esc` close, focus is trapped and returned, edge-to-edge on a phone.
 */
import { useEffect, useRef } from 'react'
import { Gauge, X } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'
import { OVERLAY_TOP } from '../lib/mobileOverlay'
import { NayLimitsTab } from './nay/NayLimitsTab'

export function PlanUsageModal({ lang, onClose }: { lang: 'pt' | 'en'; onClose: () => void }) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    box.current?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
      if (e.key !== 'Tab' || !box.current) return
      const f = Array.from(box.current.querySelectorAll<HTMLElement>('button,a[href],[tabindex]:not([tabindex="-1"])'))
      if (f.length === 0) return
      const first = f[0]!, last = f[f.length - 1]!
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus?.() }
  }, [onClose])
  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label={pt ? 'Uso dos planos' : 'Plan usage'} data-plan-usage-modal
      style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center', padding: isMobile ? OVERLAY_TOP : 24 }}>
      <div ref={box} onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg-card)', border: isMobile ? 'none' : '1px solid var(--border)', borderRadius: isMobile ? 0 : 12, width: isMobile ? '100%' : 'min(560px, calc(96vw / var(--ui-zoom, 1)))', maxHeight: isMobile ? '100%' : 'calc(84vh / var(--ui-zoom, 1))', display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: isMobile ? '10px 12px' : '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 650 }}>
            <Gauge size={17} style={{ color: 'var(--anthropic-orange)' }} />{pt ? 'Uso dos planos' : 'Plan usage'}
          </div>
          <button type="button" onClick={onClose} aria-label={pt ? 'Fechar' : 'Close'}
            style={{ border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', minWidth: isMobile ? 44 : 32, height: isMobile ? 44 : 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={16} /></button>
        </div>
        <NayLimitsTab lang={lang} isMobile={isMobile} onNavigate={onClose} />
      </div>
    </div>
  )
}

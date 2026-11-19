import React from 'react'
import { ChevronRight } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'

/**
 * A collapsed section of a drawer (CONTAS.AGENDA-SALVAR r4 · N3): a heading row — label, a muted hint, a
 * chevron — closed by default, that opens its body on click or Enter/Space (it is a real `<button>`, so the
 * keyboard activates it natively) and states it with `aria-expanded`.
 *
 * The body stays MOUNTED while closed (`hidden`): the fields inside keep their state and nothing the user typed
 * is lost by folding the section. `forceOpen` keeps it open while something inside needs to be seen (a field
 * error), so a failed Save is never hidden behind a closed fold.
 */
export function DrawerFold({ id, label, hint, open, onToggle, forceOpen = false, children }: {
  /** Stable key for the section (`data-drawer-fold`, and the id of its body). */
  id: string
  label: string
  /** Muted text after the label (the prototype's "· opcional", "· Max 20x", "· Pessoal"). */
  hint?: string
  open: boolean
  onToggle: () => void
  forceOpen?: boolean
  children: React.ReactNode
}) {
  const isMobile = useIsMobile()
  const expanded = open || forceOpen
  const bodyId = `drawer-fold-${id}`
  return (
    <div data-drawer-fold-section={id} style={{ borderTop: '1px solid var(--border)' }}>
      <button
        type="button" data-drawer-fold={id} aria-expanded={expanded} aria-controls={bodyId}
        onClick={() => { if (!forceOpen) onToggle() }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 8,
          padding: '10px 0', minHeight: isMobile ? 44 : undefined, border: 0, background: 'transparent',
          font: 'inherit', fontSize: 12.5, color: 'var(--text-secondary)', cursor: forceOpen ? 'default' : 'pointer', textAlign: 'left',
        }}
      >
        <span>{label}{hint ? <span style={{ color: 'var(--text-tertiary)' }}> · {hint}</span> : null}</span>
        <ChevronRight size={14} aria-hidden style={{ flexShrink: 0, transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform 0.15s' }} />
      </button>
      <div id={bodyId} hidden={!expanded} style={{ paddingBottom: expanded ? 8 : 0 }}>{children}</div>
    </div>
  )
}

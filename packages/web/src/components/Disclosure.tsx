/**
 * Disclosure — the foldable block both the task rail (`RailSection`) and Settings → Accounts use:
 * one full-width button (chevron + `aria-expanded` + `aria-controls`, 44px target on mobile) over a
 * panel. The caller owns the open state and draws the header; this owns the button, the chevron and
 * the panel wiring.
 *
 * `keepMounted` keeps the panel in the DOM, `hidden` while shut, so `aria-controls` always resolves.
 * Without it a shut panel is not rendered and the attribute is only set while it is open.
 */
import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'

export function Disclosure({ open, onToggle, panelId, header, children, keepMounted = false, buttonStyle, panelStyle, panelLabel }: {
  open: boolean
  onToggle: () => void
  panelId: string
  /** Receives the chevron so the caller can place it inside its own layout. */
  header: (chevron: React.ReactNode, isMobile: boolean) => React.ReactNode
  children: React.ReactNode
  keepMounted?: boolean
  buttonStyle?: React.CSSProperties
  panelStyle?: React.CSSProperties
  panelLabel?: string
}) {
  const isMobile = useIsMobile()
  const Chevron = open ? ChevronDown : ChevronRight
  const chevron = <Chevron size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
  const mounted = open || keepMounted
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={mounted ? panelId : undefined}
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          background: 'none', border: 'none', cursor: 'pointer',
          padding: isMobile ? '12px 14px' : '10px 14px',
          minHeight: isMobile ? 44 : undefined,
          ...buttonStyle,
        }}
      >
        {header(chevron, isMobile)}
      </button>
      {mounted && (
        <div id={panelId} role="region" aria-label={panelLabel} hidden={!open} style={open ? panelStyle : { ...panelStyle, display: 'none' }}>{children}</div>
      )}
    </>
  )
}

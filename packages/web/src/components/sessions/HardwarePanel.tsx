/**
 * HardwarePanel — the hardware surface, as a RIGHT-SLOT panel (design §1, item 3).
 *
 * `HardwareModal.tsx` used to be the only way to read this: a dialog reached from a header chip.
 * That chip is now folded into the header's one panel switcher (item 2) alongside Contents, Studio,
 * Claude Code and Shell, so the surface it opens has to be a PANEL like the other three — the same
 * box, not a dialog floating over it. `panelSlots.ts` carries `hardware` RIGHT ONLY: a band under
 * the composer has no useful shape for three columns of figures, and nobody asked for it there.
 *
 * The CONTENT is shared with the modal (`HardwareBody`, `useHardwareSnapshot`) rather than
 * reimplemented — one figure, one poll, one 403 sentence. The modal survives unchanged for the
 * mobile "More" sheet tile, where a dialog is still the right shape (see that file's own header).
 */

import { Cpu, RefreshCw, X } from 'lucide-react'
import type { Lang } from '@agentistics/core'
import { HardwareBody, useHardwareSnapshot } from '../HardwareModal'
import { useIsMobile } from '../../hooks/useIsMobile'

export interface HardwarePanelProps {
  lang: Lang
  onClose: () => void
}

export function HardwarePanel({ lang, onClose }: HardwarePanelProps) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const { hardware, loading, error, lastRefreshed, refresh } = useHardwareSnapshot(lang)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        padding: '10px 12px', borderBottom: '1px solid var(--border)',
      }}>
        <Cpu size={15} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.3, color: 'var(--text-primary)' }}>
          {pt ? 'Recursos de hardware' : 'Hardware resources'}
        </span>
        {lastRefreshed && (
          <span style={{
            fontSize: 10.5, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums',
          }}>
            {pt ? 'Atualizado às' : 'Updated'} {lastRefreshed.toLocaleTimeString()}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="ag-tap-icon"
          onClick={refresh}
          disabled={loading}
          title={pt ? 'Atualizar' : 'Refresh'}
          aria-label={pt ? 'Atualizar' : 'Refresh'}
          style={panelIconBtn}
        >
          <RefreshCw size={13} className={loading ? 'ag-spin' : undefined} />
        </button>
        <button className="ag-tap-icon"
          onClick={onClose}
          title={pt ? 'Fechar' : 'Close'}
          aria-label={pt ? 'Fechar o painel de hardware' : 'Close the hardware panel'}
          style={panelIconBtn}
        >
          <X size={13} />
        </button>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: isMobile ? 12 : 16 }}>
        <HardwareBody lang={lang} hardware={hardware} error={error} isMobile={isMobile} />
      </div>
    </div>
  )
}

const panelIconBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 26, height: 22, flexShrink: 0, borderRadius: 6, padding: 0,
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)', cursor: 'pointer',
}

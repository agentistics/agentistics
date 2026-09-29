/**
 * AsideHeader — the top row of the left aside: the mark, and the control that folds the aside.
 *
 * The aside runs the full height of the window and this row is its first child, the way a chat
 * product's sidebar carries its own logo and its own collapse control. The fixed strip on the right
 * (`TopBar`) starts where the aside ends, so nothing here has to line up with anything in it; the
 * row's HEIGHT is the strip's, which keeps the two bands level.
 *
 * Expanded: the mark on the left, the collapse toggle on the right edge of the aside.
 * Collapsed: the mark alone, centred in the rail. It IS the control that reopens the aside — hover
 * or focus swaps it for the sidebar icon and a click reopens — so there is no second button beside
 * it and the rail stays one mark wide.
 */

import { useEffect, useState } from 'react'
import { PanelLeft } from 'lucide-react'
import { brandAsset } from '../../lib/brand'

export interface AsideHeaderProps {
  lang: 'pt' | 'en'
  /** The strip's height, so the two bands share a baseline. */
  height: number
  collapsed: boolean
  onToggle: () => void
}

const iconBtn: React.CSSProperties = {
  width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 8, border: 'none', background: 'transparent',
  color: 'var(--text-tertiary)', cursor: 'pointer', flexShrink: 0,
  transition: 'background 0.15s, color 0.15s',
}

export function AsideHeader({ lang, height, collapsed, onToggle }: AsideHeaderProps) {
  const pt = lang === 'pt'
  const [markHot, setMarkHot] = useState(false)
  // The collapsed button unmounts when the aside opens — under the pointer, so no mouseleave ever
  // fires — and the flag would stay true, showing the icon instead of the mark the next time the
  // aside collapses. Whatever changes the state starts it cold.
  useEffect(() => { setMarkHot(false) }, [collapsed])

  const showLabel = pt ? 'Mostrar barra lateral' : 'Show sidebar'
  const hideLabel = pt ? 'Ocultar barra lateral' : 'Hide sidebar'
  // A signature, not a banner: 60% of the band.
  const markH = Math.max(0, Math.round((height - 8) * 0.6))

  return (
    <div style={{
      height, flexShrink: 0, display: 'flex', alignItems: 'center',
      justifyContent: collapsed ? 'center' : 'space-between',
      padding: collapsed ? 0 : '0 2px', marginBottom: 6,
    }}>
      {collapsed ? (
        <button
          onClick={onToggle}
          onMouseEnter={() => setMarkHot(true)} onMouseLeave={() => setMarkHot(false)}
          onFocus={() => setMarkHot(true)} onBlur={() => setMarkHot(false)}
          aria-label={showLabel}
          title={`${showLabel}  ·  Ctrl+B`}
          style={{
            ...iconBtn, width: 36, height: 36, color: 'var(--text-primary)',
            background: markHot ? 'var(--bg-elevated)' : 'transparent',
          }}
        >
          {markHot
            ? <PanelLeft size={18} />
            : <img src={brandAsset('/minimalistLogo.png')} alt="agentistics" style={{ height: markH, width: 'auto', objectFit: 'contain' }} />}
        </button>
      ) : (
        <>
          <img
            src={brandAsset('/minimalistLogo.png')}
            alt="agentistics"
            style={{ height: markH, width: 'auto', maxWidth: '100%', objectFit: 'contain', flexShrink: 0, minWidth: 0 }}
          />
          <button
            onClick={onToggle}
            aria-label={hideLabel}
            title={`${hideLabel}  ·  Ctrl+B`}
            style={iconBtn}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--bg-elevated)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-tertiary)'; e.currentTarget.style.background = 'transparent' }}
          >
            <PanelLeft size={16} />
          </button>
        </>
      )}
    </div>
  )
}

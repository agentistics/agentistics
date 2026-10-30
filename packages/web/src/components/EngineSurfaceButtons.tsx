import { useEngineSurfaces } from '../hooks/useEngineSurfaces'
import { useIsMobile } from '../hooks/useIsMobile'
import { closeEngineSurface, openEngineSurface, useOpenEngineSurface } from '../lib/engineSurfaceHost'
import type { SurfaceIcon, SurfacePlacement } from '../lib/engineSurfaces'
import { PanelTop, Phone, PhoneOff, Sparkles } from 'lucide-react'

/**
 * One generic button per surface the engine announced for `placement` — nothing when there are none
 * (a community build, or every surface behind an experimental flag that is off). A click asks the
 * app-level `EngineSurfaceHost` to open the surface; the buttons own no overlay of their own, so a
 * surface outlives the screen (and the button) it was opened from.
 */
export function EngineSurfaceButtons({ placement, sessionId, lang, slotId }: { placement: SurfacePlacement; sessionId: string | null; lang: 'pt' | 'en'; slotId?: string }) {
  const surfaces = useEngineSurfaces(placement)
  const mobile = useIsMobile()
  const open = useOpenEngineSurface()
  if (surfaces.length === 0) return null
  return (
    <>
      {surfaces.map(s => {
        const active = placement === 'composer' && open?.surface.id === s.id && open.sessionId === sessionId
        const name = active ? (s.activeLabel ?? s.label)[lang] : s.label[lang]
        const size = placement === 'composer' ? 15 : 14
        const iconName: SurfaceIcon | undefined = active ? (s.activeIcon ?? s.icon) : s.icon
        const Glyph = iconName === 'phone' ? Phone : iconName === 'phone-off' ? PhoneOff : iconName === 'sparkles' ? Sparkles : iconName === 'panel' ? PanelTop : null
        const fill = s.activeTone === 'danger' ? 'var(--accent-red)' : 'var(--anthropic-orange)'
        return (
          <button key={s.id} type="button" data-engine-surface={s.id}
            aria-label={name} title={name}
            data-active={active ? 'true' : undefined} data-tone={active ? (s.activeTone ?? 'accent') : undefined}
            onClick={e => active ? closeEngineSurface() : openEngineSurface(s, { sessionId, lang, trigger: e.currentTarget, slotId })}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer',
              border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', color: 'var(--text-secondary)',
              fontFamily: 'inherit', fontSize: 11.5, padding: placement === 'composer' ? 0 : '2px 8px',
              ...(placement === 'composer' ? { width: 34, height: 34, borderRadius: 9, border: 'none', color: 'var(--text-tertiary)' } : {}),
              ...(active ? { background: fill, color: '#fff' } : {}),
              ...(mobile ? { minWidth: 44, minHeight: 44 } : {}),
            }}>
            {Glyph ? <Glyph size={size} aria-hidden /> : name}
          </button>
        )
      })}
    </>
  )
}

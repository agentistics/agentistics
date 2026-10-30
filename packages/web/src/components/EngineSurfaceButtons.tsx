import { useEngineSurfaces } from '../hooks/useEngineSurfaces'
import { useIsMobile } from '../hooks/useIsMobile'
import { closeEngineSurface, openEngineSurface, useMountedEngineSurfaces } from '../lib/engineSurfaceHost'
import type { SurfaceIcon, SurfacePlacement } from '../lib/engineSurfaces'
import { PanelTop, Phone, PhoneOff, Sparkles, type LucideIcon } from 'lucide-react'

/** The host's glyph for a surface icon name (the closed set), or `null`. */
export function surfaceGlyph(icon: SurfaceIcon | undefined): LucideIcon | null {
  return icon === 'phone' ? Phone : icon === 'phone-off' ? PhoneOff : icon === 'sparkles' ? Sparkles : icon === 'panel' ? PanelTop : null
}

/**
 * One generic button per surface the engine announced for `placement` — nothing when there are none
 * (a community build, or every surface behind an experimental flag that is off). A click asks the
 * app-level `EngineSurfaceHost` to open the surface; the buttons own no overlay of their own, so a
 * surface outlives the screen (and the button) it was opened from.
 */
export function EngineSurfaceButtons({ placement, sessionId, lang, slotId }: { placement: SurfacePlacement; sessionId: string | null; lang: 'pt' | 'en'; slotId?: string }) {
  const surfaces = useEngineSurfaces(placement)
  const mobile = useIsMobile()
  const mounted = useMountedEngineSurfaces()
  if (surfaces.length === 0) return null
  return (
    <>
      {surfaces.map(s => {
        // Active only while ON SCREEN from this session: its label, icon and fill promise what a click
        // does (take it off screen). Kept alive off screen, it shows the idle face again — and a click
        // brings it back, which is what the idle button means — marked `data-parked`.
        const entry = mounted.find(m => m.surface.id === s.id)
        const mine = placement === 'composer' && !!entry && entry.sessionId === sessionId
        const active = mine && entry?.parked === false
        const parked = mine && entry?.parked === true
        const name = active ? (s.activeLabel ?? s.label)[lang] : s.label[lang]
        const size = placement === 'composer' ? 15 : 14
        const iconName: SurfaceIcon | undefined = active ? (s.activeIcon ?? s.icon) : s.icon
        const Glyph = surfaceGlyph(iconName)
        const fill = s.activeTone === 'danger' ? 'var(--accent-red)' : 'var(--anthropic-orange)'
        return (
          <button key={s.id} type="button" data-engine-surface={s.id}
            aria-label={name} title={name}
            data-active={active ? 'true' : undefined} data-tone={active ? (s.activeTone ?? 'accent') : undefined}
            data-parked={parked ? 'true' : undefined}
            onClick={e => active && entry ? closeEngineSurface(entry.nonce) : openEngineSurface(s, { sessionId, lang, trigger: e.currentTarget, slotId })}
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

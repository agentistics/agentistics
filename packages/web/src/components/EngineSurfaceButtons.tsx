import { useEngineSurfaces } from '../hooks/useEngineSurfaces'
import { useIsMobile } from '../hooks/useIsMobile'
import { openEngineSurface } from '../lib/engineSurfaceHost'
import type { SurfacePlacement } from '../lib/engineSurfaces'

/**
 * One generic button per surface the engine announced for `placement` — nothing when there are none
 * (a community build, or every surface behind an experimental flag that is off). A click asks the
 * app-level `EngineSurfaceHost` to open the surface; the buttons own no overlay of their own, so a
 * surface outlives the screen (and the button) it was opened from.
 */
export function EngineSurfaceButtons({ placement, sessionId, lang }: { placement: SurfacePlacement; sessionId: string | null; lang: 'pt' | 'en' }) {
  const surfaces = useEngineSurfaces(placement)
  const mobile = useIsMobile()
  if (surfaces.length === 0) return null
  return (
    <>
      {surfaces.map(s => (
        <button key={s.id} type="button" data-engine-surface={s.id}
          onClick={e => openEngineSurface(s, { sessionId, lang, trigger: e.currentTarget })}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer',
            border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', color: 'var(--text-secondary)',
            fontFamily: 'inherit', fontSize: 11.5, padding: '2px 8px',
            ...(mobile ? { minWidth: 44, minHeight: 44 } : {}),
          }}>
          {s.label[lang]}
        </button>
      ))}
    </>
  )
}

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useEngineSurfaces } from '../hooks/useEngineSurfaces'
import { useEscapeOwner } from '../lib/overlayStack'
import { useIsMobile } from '../hooks/useIsMobile'
import { mountSurface, type EngineSurfaceInfo, type SurfaceHandle, type SurfacePlacement } from '../lib/engineSurfaces'

/** Test seam: how the module is imported. */
type Loader = (path: string) => Promise<unknown>

/**
 * One generic button per surface the engine announced for `placement` — nothing when there are none
 * (a community build, or every surface behind an experimental flag that is off). A click opens a host
 * overlay and mounts the surface's module into it.
 */
export function EngineSurfaceButtons({ placement, sessionId, lang, load }: { placement: SurfacePlacement; sessionId: string | null; lang: 'pt' | 'en'; load?: Loader }) {
  const surfaces = useEngineSurfaces(placement)
  const mobile = useIsMobile()
  const [active, setActive] = useState<EngineSurfaceInfo | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  if (surfaces.length === 0) return null
  return (
    <>
      {surfaces.map(s => (
        <button key={s.id} type="button" data-engine-surface={s.id}
          onClick={e => { trigger.current = e.currentTarget; setActive(s) }}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer',
            border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', color: 'var(--text-secondary)',
            fontFamily: 'inherit', fontSize: 11.5, padding: '2px 8px',
            ...(mobile ? { minWidth: 44, minHeight: 44 } : {}),
          }}>
          {s.label[lang]}
        </button>
      ))}
      {active && (
        <EngineSurfaceOverlay surface={active} sessionId={sessionId} lang={lang} load={load}
          onClose={() => { setActive(null); trigger.current?.focus() }} />
      )}
    </>
  )
}

/** The host-owned frame: focus moves in, Esc and the close button leave, `unmount` runs on every exit. */
export function EngineSurfaceOverlay({ surface, sessionId, lang, onClose, load }: {
  surface: EngineSurfaceInfo; sessionId: string | null; lang: 'pt' | 'en'; onClose: () => void; load?: Loader
}) {
  const host = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  const pt = lang === 'pt'
  useEscapeOwner(true, onClose)
  useEffect(() => {
    let handle: SurfaceHandle | null = null
    let dead = false
    const el = host.current
    if (!el) return
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    frame.current?.focus()
    mountSurface(surface, el, { sessionId, lang, reducedMotion, close: onClose }, load)
      .then(h => { if (dead) void h.unmount(); else handle = h })
      .catch(() => { if (!dead) setError(true) })
    return () => { dead = true; if (handle) void handle.unmount() }
    // The surface mounts once per opening; its context is a snapshot of that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.id])
  return (
    <div role="dialog" aria-modal="true" aria-label={surface.label[lang]} data-engine-overlay={surface.id}
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 700, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'min(24px, 2vw)' }}>
      <div ref={frame} tabIndex={-1} onClick={e => e.stopPropagation()}
        style={{ position: 'relative', width: 'min(960px, 100%)', maxHeight: '100%', overflow: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, outline: 'none' }}>
        <button type="button" onClick={onClose} aria-label={pt ? 'Fechar' : 'Close'}
          style={{ position: 'absolute', top: 8, right: 8, width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--text-secondary)' }}>
          <X size={18} />
        </button>
        {error && <p role="alert" style={{ color: 'var(--text-secondary)', margin: 0 }}>{pt ? 'Não foi possível carregar esta interface.' : 'This interface could not be loaded.'}</p>}
        <div ref={host} />
      </div>
    </div>
  )
}

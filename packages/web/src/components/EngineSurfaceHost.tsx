import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useEscapeOwner } from '../lib/overlayStack'
import { closeEngineSurface, setEngineSurfaceLayout, useOpenEngineSurface, type OpenSurface } from '../lib/engineSurfaceHost'
import { mountSurface, type SurfaceHandle } from '../lib/engineSurfaces'

/** Test seam: how the module is imported. */
type Loader = (path: string) => Promise<unknown>

/**
 * Mounted ONCE, at the app root. Draws the open engine surface in a frame the host owns: `full` is a
 * modal overlay (focus, Esc, close button), `side` a docked panel that leaves the page usable. The
 * frame is ONE element whose style changes, and the module's own container is a stable child — so
 * switching layout, or navigating to another screen, never unmounts the surface. It ends only on an
 * explicit close (the button, the surface's `ctx.close()`, or Esc while `full`).
 */
export function EngineSurfaceHost({ load }: { load?: Loader } = {}) {
  const open = useOpenEngineSurface()
  if (!open || typeof document === 'undefined') return null
  return createPortal(<Frame key={open.nonce} open={open} load={load} />, document.body)
}

function Frame({ open, load }: { open: OpenSurface; load?: Loader }) {
  const { surface, sessionId, lang, layout } = open
  const host = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  const pt = lang === 'pt'
  const full = layout === 'full'
  useEscapeOwner(full, closeEngineSurface)
  useEffect(() => {
    let handle: SurfaceHandle | null = null
    let dead = false
    const el = host.current
    if (!el) return
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    frame.current?.focus()
    mountSurface(surface, el, {
      sessionId, lang, reducedMotion, layout: 'full',
      setLayout: setEngineSurfaceLayout, close: closeEngineSurface,
    }, load)
      .then(h => { if (dead) void h.unmount(); else handle = h })
      .catch(() => { if (!dead) setError(true) })
    return () => { dead = true; if (handle) void handle.unmount() }
    // Mounted once per opening (the Frame is keyed by it); the context is a snapshot of that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const wrapper: React.CSSProperties = full
    ? { position: 'fixed', inset: 0, zIndex: 700, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'min(24px, 2vw)' }
    : { position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 700, width: 'min(420px, 100vw)', display: 'flex', pointerEvents: 'none' }
  const box: React.CSSProperties = full
    ? { position: 'relative', width: 'min(960px, 100%)', maxHeight: '100%', overflow: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, outline: 'none' }
    : { position: 'relative', width: '100%', height: '100%', overflow: 'auto', background: 'var(--bg-card)', borderLeft: '1px solid var(--border)', padding: 16, outline: 'none', pointerEvents: 'auto' }
  return (
    <div role={full ? 'dialog' : 'complementary'} aria-modal={full ? true : undefined} aria-label={surface.label[lang]}
      data-engine-overlay={surface.id} data-layout={layout}
      onClick={full ? closeEngineSurface : undefined} style={wrapper}>
      <div ref={frame} tabIndex={-1} onClick={e => e.stopPropagation()} style={box}>
        <button type="button" onClick={closeEngineSurface} aria-label={pt ? 'Fechar' : 'Close'}
          style={{ position: 'absolute', top: 8, right: 8, width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--text-secondary)' }}>
          <X size={18} />
        </button>
        {error && <p role="alert" style={{ color: 'var(--text-secondary)', margin: 0 }}>{pt ? 'Não foi possível carregar esta interface.' : 'This interface could not be loaded.'}</p>}
        <div ref={host} />
      </div>
    </div>
  )
}

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useEscapeOwner } from '../lib/overlayStack'
import { closeEngineSurface, effectiveSurfaceLayout, registerEngineInlineSlot, resolveInlineSlot, setEngineSurfaceLayout, useEngineInlineSlot, useOpenEngineSurface, type OpenSurface } from '../lib/engineSurfaceHost'
import { mountSurface, type SurfaceHandle, type SurfaceLayout, type SurfaceMountContext } from '../lib/engineSurfaces'

/** Test seam: how the module is imported. */
type Loader = (path: string) => Promise<unknown>

/**
 * Mounted ONCE, at the app root. Draws the open engine surface in a frame the host owns: `full` is a
 * modal overlay (focus, Esc, close button), `side` a docked panel that leaves the page usable. The
 * frame is ONE element whose style changes, and the module's own container is a stable child — so
 * switching layout, or navigating to another screen, never unmounts the surface. It ends only on an
 * explicit close (the button, the surface's `ctx.close()`, or Esc while `full`).
 */
export function EngineSurfaceHost({ load }: { load?: Loader }) {
  const open = useOpenEngineSurface()
  if (!open || typeof document === 'undefined') return null
  return createPortal(<Frame key={open.nonce} open={open} load={load} />, document.body)
}

/**
 * The slot above the session composer an `inline` surface is mounted into. Rendered by the session view
 * only while a `composer` surface opened from THAT session is `inline`; the conversation and the
 * composer around it stay fully usable.
 */
export function EngineSurfaceInlineSlot({ sessionId, slotId }: { sessionId: string; slotId: string }) {
  const open = useOpenEngineSurface()
  const own = useRef<HTMLElement | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (el) { own.current = el; registerEngineInlineSlot(slotId, sessionId, el) }
    else { registerEngineInlineSlot(slotId, sessionId, null, own.current); own.current = null }
  }, [slotId, sessionId])
  const want = !!open && open.layout === 'inline' && open.surface.placement === 'composer' && open.sessionId === sessionId
  if (!want) return null
  return <div ref={ref} data-engine-inline={open.surface.id} />
}

function Frame({ open, load }: { open: OpenSurface; load?: Loader }) {
  const { surface, sessionId, lang } = open
  const slot = useEngineInlineSlot()
  const layout = effectiveSurfaceLayout(open.layout, !!slot)
  const inline = layout === 'inline'
  const drawn = useRef<SurfaceLayout>(layout)
  drawn.current = layout
  const host = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  const pt = lang === 'pt'
  const full = layout === 'full'
  const bare = surface.frameless === true
  // The surface's own element: created once, re-parented between the inline slot and the frame, so a
  // layout switch never remounts it.
  const el = useMemo(() => document.createElement('div'), [])
  useEscapeOwner(full, closeEngineSurface)
  useLayoutEffect(() => {
    const target = inline ? slot : host.current
    if (target && el.parentElement !== target) target.appendChild(el)
  }, [inline, slot, el])
  useEffect(() => {
    let handle: SurfaceHandle | null = null
    let dead = false
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (open.layout !== 'inline') frame.current?.focus()
    // The slot may have been registered in this same commit: read the store, not the first render.
    drawn.current = effectiveSurfaceLayout(open.layout, resolveInlineSlot() !== null)
    const ctx: SurfaceMountContext = {
      sessionId, lang, reducedMotion,
      get layout() { return drawn.current },
      setLayout: setEngineSurfaceLayout, close: closeEngineSurface,
    }
    mountSurface(surface, el, ctx, load)
      .then(h => {
        if (dead) { void h.unmount(); return }
        handle = h
        if (drawn.current === 'inline') { el.tabIndex = -1; el.focus() }
      })
      .catch(() => { if (!dead) setError(true) })
    return () => { dead = true; if (handle) void handle.unmount() }
    // Mounted once per opening (the Frame is keyed by it); the context is a snapshot of that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (inline) return null
  const wrapper: React.CSSProperties = full
    ? { position: 'fixed', inset: 0, zIndex: 700, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: bare ? 0 : 'min(24px, calc(2vw / var(--ui-zoom, 1)))' }
    : { position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 700, width: 'min(420px, calc(100vw / var(--ui-zoom, 1)))', display: 'flex', pointerEvents: 'none' }
  const box: React.CSSProperties = bare
    ? (full
      ? { position: 'relative', width: 'min(960px, 100%)', maxHeight: '100%', overflow: 'auto', outline: 'none' }
      : { position: 'relative', width: '100%', height: '100%', overflow: 'auto', outline: 'none', pointerEvents: 'auto' })
    : full
      ? { position: 'relative', width: 'min(960px, 100%)', maxHeight: '100%', overflow: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, outline: 'none' }
      : { position: 'relative', width: '100%', height: '100%', overflow: 'auto', background: 'var(--bg-card)', borderLeft: '1px solid var(--border)', padding: 16, outline: 'none', pointerEvents: 'auto' }
  return (
    <div role={full ? 'dialog' : 'complementary'} aria-modal={full ? true : undefined} aria-label={surface.label[lang]}
      data-engine-overlay={surface.id} data-layout={layout} data-frameless={bare ? 'true' : undefined}
      onClick={full ? closeEngineSurface : undefined} style={wrapper}>
      <div ref={frame} tabIndex={-1} onClick={e => e.stopPropagation()} style={box}>
        {!bare && (
          <button type="button" onClick={closeEngineSurface} aria-label={pt ? 'Fechar' : 'Close'}
            style={{ position: 'absolute', top: 8, right: 8, width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        )}
        {error && <p role="alert" style={{ color: 'var(--text-secondary)', margin: 0 }}>{pt ? 'Não foi possível carregar esta interface.' : 'This interface could not be loaded.'}</p>}
        <div ref={host} />
      </div>
    </div>
  )
}

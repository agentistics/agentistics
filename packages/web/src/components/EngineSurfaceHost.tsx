import { NayWindowFrame } from './nay/NayWindowFrame'
import { type NayWindow, placeWindow } from '../lib/nayDock'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useEscapeOwner } from '../lib/overlayStack'
import {
  minimizeEngineSurface, registerEngineNaySlot, useEngineNaySlot, closeEngineSurface, effectiveSurfaceLayout, endEngineSurface, leaveEngineSurfacePage, onEngineSurfaceIndicatorEnd, openEngineSurface, openEngineSurfaceSession,
  registerEngineSessionView, registerEngineInlineSlot, registerEnginePageSlot, registerEngineSideSlot, resolveInlineSlot, resolveSideSlot, setEngineSurfaceIndicator, setEngineSurfaceKeepAlive,
  mountedEngineSurfaces, reconcileEngineSurfaces, setEngineSurfaceLayout, useEngineInlineSlot, useEngineSideAsideId, useEnginePageSlot, useEngineSideSlot, useMountedEngineSurfaces, useOpenEngineSurface, type OpenSurface,
} from '../lib/engineSurfaceHost'
import { readEngineStatus, useEngineSurfaceList } from '../hooks/useEngineSurfaces'
import { onEngineCapsInvalidated } from '../lib/engineCapsBus'
import {
  asSurfaceIndicator, mountSurface, stillAnnounced, surfaceIndicatorRefusals, type SurfaceHandle, type SurfaceIndicator, type SurfaceLayout,
  type SurfaceMountContext,
} from '../lib/engineSurfaces'

/** Test seam: how the module is imported. */
type Loader = (path: string) => Promise<unknown>

/**
 * Mounted ONCE, at the app root. Draws each mounted engine surface in a frame the host owns: `full` is a
 * modal overlay (focus, Esc, close button), `side` a docked panel that leaves the page usable. The
 * frame is ONE element whose style changes, and the module's own container is a stable child — so
 * switching layout, or navigating to another screen, never unmounts the surface. It ends only on an
 * explicit close (the button, the surface's `ctx.close()`, or Esc while `full`) — and a surface kept
 * alive is PARKED by those instead: the same element, still mounted, moved into an off-screen holder.
 */
export function EngineSurfaceHost({ load }: { load?: Loader }) {
  const list = useMountedEngineSurfaces()
  // The engine's announcement can change without a reload (the experimental switch, another engine):
  // a surface it no longer announces ends, kept alive or not.
  useEffect(() => onEngineCapsInvalidated(() => {
    void readEngineStatus().then(status => { const keep = stillAnnounced(status); if (keep) reconcileEngineSurfaces(keep) })
  }), [])
  if (list.length === 0 || typeof document === 'undefined') return null
  return createPortal(<>{list.map(open => <Frame key={open.nonce} open={open} load={load} />)}</>, document.body)
}

/**
 * A `rail` surface's page (`/x/<id>`): the main-area element the surface is mounted into, with no host
 * frame. Arriving opens the surface (or brings back the one kept alive); leaving parks it when it asked
 * to be kept alive and ends it otherwise.
 */
export function EngineSurfacePage({ surfaceId, lang }: { surfaceId: string; lang: 'pt' | 'en' }) {
  const list = useEngineSurfaceList('rail')
  const info = list?.find(s => s.id === surfaceId)
  const open = useOpenEngineSurface()
  const [asked, setAsked] = useState(0)
  // Set once this page has opened its surface: only then does "not on screen" mean it was closed.
  const [opened, setOpened] = useState(false)
  const own = useRef<HTMLElement | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (el) { own.current = el; registerEnginePageSlot(surfaceId, el) }
    else { registerEnginePageSlot(surfaceId, null, own.current); own.current = null }
  }, [surfaceId])
  const found = !!info
  useEffect(() => {
    if (!info) return
    setOpened(true)
    openEngineSurface(info, { sessionId: null, lang })
    return () => leaveEngineSurfacePage(info.id)
    // Opened once per arrival (or an explicit reopen); the surface object is re-created by every read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceId, found, asked])
  const pt = lang === 'pt'
  const note: React.CSSProperties = { color: 'var(--text-secondary)', margin: 0, padding: 16 }
  if (list === null) return null
  if (!info) return <p role="status" style={note}>{pt ? 'Esta página não está disponível.' : 'This page is not available.'}</p>
  const here = open?.surface.id === surfaceId || !opened
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {!here && (
        <div role="status" style={{ ...note, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{pt ? 'Esta página foi fechada.' : 'This page was closed.'}</span>
          <button type="button" onClick={() => setAsked(n => n + 1)}
            style={{ cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', fontFamily: 'inherit', padding: '4px 10px', minHeight: 32 }}>
            {pt ? 'Abrir de novo' : 'Open again'}
          </button>
        </div>
      )}
      <div ref={ref} data-engine-page={surfaceId} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }} />
    </div>
  )
}

/**
 * The slot above the session composer an `inline` surface is mounted into. Rendered by the session view
 * only while a `composer` surface opened from THAT session is `inline`; the conversation and the
 * composer around it stay fully usable.
 */
export function EngineSurfaceInlineSlot({ sessionId, slotId }: { sessionId: string; slotId: string }) {
  useEffect(() => {
    registerEngineSessionView(slotId, sessionId)
    return () => registerEngineSessionView(slotId, null)
  }, [slotId, sessionId])
  const open = useOpenEngineSurface()
  const own = useRef<HTMLElement | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (el) { own.current = el; registerEngineInlineSlot(slotId, sessionId, el) }
    else { registerEngineInlineSlot(slotId, sessionId, null, own.current); own.current = null }
  }, [slotId, sessionId])
  const want = !!open && !open.parked && open.layout === 'inline' && open.surface.placement === 'composer' && open.sessionId === sessionId
  if (!want) return null
  return <div ref={ref} data-engine-inline={open.surface.id} />
}

/**
 * The section of a session's right aside (the sessions workspace) a `side` surface of THAT session is
 * mounted into, instead of the host's fixed side panel. Rendered by the aside only while such a
 * surface is drawn as `side`; it fills the aside's height, so a surface sized `height: 100%` gets it.
 */
export function EngineSurfaceSideSlot({ sessionId, slotId }: { sessionId: string; slotId: string }) {
  const own = useRef<HTMLElement | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (el) { own.current = el; registerEngineSideSlot(slotId, sessionId, el) }
    else { registerEngineSideSlot(slotId, sessionId, null, own.current); own.current = null }
  }, [slotId, sessionId])
  return <div ref={ref} data-engine-side-slot={slotId} style={{ position: 'relative', flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }} />
}

/**
 * Where a parked surface's element waits: in the document (so it keeps running), out of sight and reach,
 * at the viewport's size rather than a 1px box, so a surface that measures itself is not squeezed.
 */
const PARKED: React.CSSProperties = { position: 'fixed', left: -100000, top: 0, width: 'calc(100vw / var(--ui-zoom, 1))', height: 'calc(100vh / var(--ui-zoom, 1))', overflow: 'hidden', pointerEvents: 'none' }

function Frame({ open, load }: { open: OpenSurface; load?: Loader }) {
  const { surface, sessionId, sessionKind, lang, nonce } = open
  // The slots answer for the surface ON SCREEN; a parked one never takes them.
  const inlineSlot = useEngineInlineSlot()
  const pageSlot = useEnginePageSlot()
  const sideSlot = useEngineSideSlot()
  const slot = open.parked ? null : inlineSlot
  const naySlot = useEngineNaySlot(surface.id)
  const nayTab = surface.placement === 'nay-tab'
  const page = open.layout === 'page'
  // A page whose route is not on screen is held off screen like a parked surface.
  // A session surface drawn as `side` whose session is shown in a Sessions pane never uses the fixed
  // panel: with no aside holding it yet it stays mounted, hidden, until one takes it or it is closed.
  const asideWanted = useEngineSideAsideId() !== null
  const heldForAside = !open.parked && !page && effectiveSurfaceLayout(open.layout, !!slot) === 'side' && !sideSlot && asideWanted
  const offscreen = open.parked || (nayTab && !naySlot) || (page && !pageSlot) || heldForAside
  // Parked, it reports the layout it had (and will come back in), not a fallback computed without a slot.
  const layout = open.parked ? open.layout : effectiveSurfaceLayout(open.layout, !!slot)
  const inline = layout === 'inline'
  // A session surface drawn as `side` whose session has its aside on screen lives inside that aside.
  const aside = !offscreen && layout === 'side' && !!sideSlot
  const drawn = useRef<SurfaceLayout>(layout)
  drawn.current = layout
  const host = useRef<HTMLDivElement>(null)
  const park = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  const [win, setWin] = useState<NayWindow>(() => ({ id: surface.id, x: Math.max(0, window.innerWidth - 440), y: 60, w: Math.min(420, window.innerWidth), h: Math.min(540, window.innerHeight - 60), minimized: false, z: 290 }))
  const pt = lang === 'pt'
  const full = layout === 'full'
  const bare = surface.frameless === true
  // The surface's own element: created once, re-parented between the inline slot and the frame, so a
  // layout switch never remounts it.
  const el = useMemo(() => document.createElement('div'), [])
  const hostClose = useCallback(() => closeEngineSurface(nonce), [nonce])
  useEscapeOwner(full && !nayTab && !offscreen, hostClose)
  useLayoutEffect(() => {
    const target = offscreen ? park.current : nayTab ? naySlot : page ? pageSlot : inline ? slot : aside ? sideSlot : host.current
    if (target && el.parentElement !== target) target.appendChild(el)
    // On its page, in an aside and in a frameless frame the surface fills its box (so a surface sized
    // `height: 100%`, or positioned `absolute; inset: 0`, gets a real box); inline, and inside a framed
    // card, its container sizes to its content.
    const fill = !offscreen && !inline && (page || aside || bare || nayTab || layout === 'float')
    el.style.flex = fill ? '1' : ''
    el.style.minHeight = fill ? '0' : ''
    el.style.position = fill ? 'relative' : ''
  }, [offscreen, page, pageSlot, inline, slot, aside, sideSlot, bare, nayTab, naySlot, layout, el])
  // Coming back from off screen moves focus exactly as the first mount did: into the frame (a `full`
  // dialog is modal), or onto the surface itself inline or on its page.
  const wasParked = useRef(offscreen)
  useEffect(() => {
    const back = wasParked.current && !offscreen
    wasParked.current = offscreen
    if (!back) return
    if (inline || page || aside) { el.tabIndex = -1; el.focus() } else frame.current?.focus()
  }, [offscreen, inline, page, aside, el])
  useEffect(() => {
    let handle: SurfaceHandle | null = null
    let dead = false
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (open.layout !== 'inline') frame.current?.focus()
    // The slot may have been registered in this same commit: read the store, not the first render.
    drawn.current = effectiveSurfaceLayout(open.layout, resolveInlineSlot() !== null)
    // Every verb is bound to THIS surface, so a parked one can never move the one on screen.
    const ctx: SurfaceMountContext = {
      sessionId, ...(sessionKind ? { sessionKind } : {}), lang, reducedMotion,
      get layout() { return drawn.current },
      setLayout: l => {
        setEngineSurfaceLayout(l, nonce)
        // `full` and `side` are always honoured, so `ctx.layout` reports them at once rather than after
        // the next render (`inline` depends on a slot being on screen and is settled by the render).
        if ((l === 'full' || l === 'side' || l === 'float') && mountedEngineSurfaces().some(s => s.nonce === nonce && s.layout === l)) drawn.current = l
      },
      close: () => endEngineSurface(nonce),
      keepAlive: on => setEngineSurfaceKeepAlive(nonce, on === true),
      setIndicator: (ind: SurfaceIndicator | null) => {
        if (ind === null) { setEngineSurfaceIndicator(nonce, null); return }
        const refused = surfaceIndicatorRefusals(ind)
        if (refused.length > 0) throw new Error(`surface-indicator-refused: ${refused.join(', ')}`)
        setEngineSurfaceIndicator(nonce, asSurfaceIndicator(ind))
      },
      onIndicatorEnd: fn => (typeof fn === 'function' ? onEngineSurfaceIndicatorEnd(nonce, fn) : () => {}),
      openSession: id => openEngineSurfaceSession(id),
    }
    mountSurface(surface, el, ctx, load)
      .then(h => {
        if (dead) { void h.unmount(); return }
        handle = h
        if (drawn.current === 'inline' || el.parentElement === resolveSideSlot()) { el.tabIndex = -1; el.focus() }
      })
      .catch(() => { if (!dead) setError(true) })
    return () => { dead = true; if (handle) void handle.unmount() }
    // Mounted once per opening (the Frame is keyed by it); the context is a snapshot of that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (offscreen) return <div ref={park} data-engine-parked={surface.id} aria-hidden="true" inert style={PARKED} />
  if (nayTab) return null
  if (page) return error && pageSlot ? createPortal(<p role="alert" style={{ color: 'var(--text-secondary)', margin: 0, padding: 16 }}>{pt ? 'Não foi possível carregar esta interface.' : 'This interface could not be loaded.'}</p>, pageSlot) : null
  if (inline || aside) return null
  if (layout === 'float') return <div data-engine-overlay={surface.id} data-layout="float">
    <NayWindowFrame responsive frameRef={frame} win={win} lang={lang} title={surface.label[lang]} onFocus={() => {}}
      onMove={next => setWin(w => placeWindow({ open: false, panelSession: null, windows: [w] }, w.id, next, { w: window.innerWidth, h: window.innerHeight }).windows[0]!)}
      onMinimize={() => minimizeEngineSurface(nonce)} onClose={hostClose}>
      {error && <p role="alert">{pt ? 'Não foi possível carregar esta interface.' : 'This interface could not be loaded.'}</p>}
      <div ref={host} style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'auto' }} />
    </NayWindowFrame>
  </div>
  const wrapper: React.CSSProperties = full
    ? { position: 'fixed', inset: 0, zIndex: 700, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: bare ? 0 : 'min(24px, calc(2vw / var(--ui-zoom, 1)))' }
    : { position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 700, width: 'min(420px, calc(100vw / var(--ui-zoom, 1)))', display: 'flex', pointerEvents: 'none' }
  const box: React.CSSProperties = bare
    // Frameless, the frame IS the surface's box: `full` covers the whole viewport and `side` the whole
    // panel, both as flex columns, so the surface's element (and anything in it sized `height: 100%` or
    // positioned `absolute; inset: 0`) has a real size. A box sized only by its content collapsed to
    // 0px around such a surface and the overlay drew nothing but its backdrop.
    ? (full
      ? { position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'auto', outline: 'none' }
      : { position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'auto', outline: 'none', pointerEvents: 'auto' })
    : full
      ? { position: 'relative', width: 'min(960px, 100%)', maxHeight: '100%', overflow: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, outline: 'none' }
      : { position: 'relative', width: '100%', height: '100%', overflow: 'auto', background: 'var(--bg-card)', borderLeft: '1px solid var(--border)', padding: 16, outline: 'none', pointerEvents: 'auto' }
  return (
    <div role={full ? 'dialog' : 'complementary'} aria-modal={full ? true : undefined} aria-label={surface.label[lang]}
      data-engine-overlay={surface.id} data-layout={layout} data-frameless={bare ? 'true' : undefined}
      onClick={full ? hostClose : undefined} style={wrapper}>
      <div ref={frame} tabIndex={-1} onClick={e => e.stopPropagation()} style={box}>
        {!bare && (
          <button type="button" onClick={hostClose} aria-label={pt ? 'Fechar' : 'Close'}
            style={{ position: 'absolute', top: 8, right: 8, width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        )}
        {error && <p role="alert" style={{ color: 'var(--text-secondary)', margin: 0 }}>{pt ? 'Não foi possível carregar esta interface.' : 'This interface could not be loaded.'}</p>}
        <div ref={host} style={bare ? { position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : undefined} />
      </div>
    </div>
  )
}

/** The active extra tab's slot. Its surface remains mounted in the root host when this disappears. */
export function EngineSurfaceNaySlot({ surfaceId }: { surfaceId: string }) {
  const own = useRef<HTMLElement | null>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (el) { own.current = el; registerEngineNaySlot(surfaceId, el) }
    else { registerEngineNaySlot(surfaceId, null, own.current); own.current = null }
  }, [surfaceId])
  return <div ref={ref} data-engine-nay-tab={surfaceId} style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'auto' }} />
}

/**
 * BrowserScreen — the live picture of one browser tab (NAVEGADOR S5, spec §3.2; prototype `.screen`).
 *
 * The last screencast frame fills the width, anchored at the top (the page's own header stays in view, as in
 * the prototype); the ring marks the model's last action at its exact point; a glass pill says whose turn it
 * is. The person's pointer and keys reach the page ONLY while the padlock is open (`browserInputOpen`):
 * locked, the picture carries no handler, no focus stop and no input element at all — there is no path to
 * the page to refuse. Focus is the consent, as with the terminal. Reused by the card, the panel and windows.
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import { Hand, Lock } from 'lucide-react'
import { browserScreenStatus, type BrowserScreenState } from '../../lib/browserStream'
import { browserInputOpen, browserKeyGoesToPage, cdpModifiers, normalizePoint, pointerButton, sampleMove, type BrowserLockMode } from '../../lib/terminalInput'
import { containBox, ringAt } from '../../lib/browserCard'
import type { BrowserInputEvent } from '../../hooks/useBrowserScreen'

export interface BrowserScreenProps {
  screen: BrowserScreenState
  lock: BrowserLockMode
  lang: 'pt' | 'en'
  /** Where the person's events go (the input socket). Ignored while locked. */
  onInput?: (ev: BrowserInputEvent) => void
  /** Hide the whose-turn pill (a surface that says it elsewhere). */
  noPill?: boolean
  onResize?: (size: { width: number; height: number; deviceScaleFactor: number }) => void
}

const ORANGE = 'var(--anthropic-orange)'

export function BrowserScreen({ screen, lock, lang, onInput, noPill = false, onResize }: BrowserScreenProps) {
  const pt = lang === 'pt'
  const imgRef = useRef<HTMLImageElement | null>(null)
  const lastMove = useRef(0)
  const open = browserInputOpen(lock) && onInput !== undefined
  const frame = screen.frame
  // The whole page, contained and centred (`containBox`), measured off the screen's own box.
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const initial = { width: el.clientWidth, height: el.clientHeight }
    if (initial.width > 0 && initial.height > 0) onResize?.({ ...initial, deviceScaleFactor: window.devicePixelRatio || 1 })
    const measure = () => {
      const size = { width: el.clientWidth, height: el.clientHeight }
      setBox(size)
      if (timer) clearTimeout(timer)
      if (size.width > 0 && size.height > 0) timer = setTimeout(() => onResize?.({ ...size, deviceScaleFactor: window.devicePixelRatio || 1 }), 250)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => { ro.disconnect(); if (timer) clearTimeout(timer) }
  }, [onResize])
  const fit = box ? containBox(box, frame) : null
  const ring = lock === 'locked' ? ringAt(screen.state?.lastAction ?? null, frame) : null
  const status = browserScreenStatus(screen, lang)
  const showStatus = !frame || screen.phase !== 'streaming' || !screen.watching

  const point = (e: { clientX: number; clientY: number }) => {
    const el = imgRef.current
    return el ? normalizePoint(e.clientX, e.clientY, el.getBoundingClientRect()) : null
  }
  const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => cdpModifiers(e)
  const pointer = (type: 'down' | 'up') => (e: PointerEvent<HTMLDivElement>) => {
    const p = point(e)
    if (!p) return
    if (type === 'down') { e.currentTarget.focus(); e.preventDefault() }
    onInput!({ op: 'pointer', type, x: p.x, y: p.y, button: pointerButton(e.button), clicks: Math.max(1, e.detail || 1), mods: mods(e) })
  }
  const handlers = open ? {
    tabIndex: 0,
    'data-browser-input': '',
    onPointerDown: pointer('down'),
    onPointerUp: pointer('up'),
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const at = sampleMove({ now: Date.now(), lastSentAt: lastMove.current, buttons: e.buttons, hover: false })
      if (at === null) return
      const p = point(e)
      if (!p) return
      lastMove.current = at
      onInput!({ op: 'pointer', type: 'move', x: p.x, y: p.y, button: e.buttons ? 'left' : 'none', mods: mods(e) })
    },
    onWheel: (e: WheelEvent<HTMLDivElement>) => {
      const p = point(e)
      if (!p) return
      onInput!({ op: 'pointer', type: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY, mods: mods(e) })
    },
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      if (!browserKeyGoesToPage(e.nativeEvent)) return
      e.preventDefault()
      onInput!({ op: 'key', type: 'down', key: e.key, code: e.code, ...(e.key.length === 1 ? { text: e.key } : {}), mods: mods(e) })
    },
    onKeyUp: (e: KeyboardEvent<HTMLDivElement>) => {
      if (!browserKeyGoesToPage(e.nativeEvent)) return
      onInput!({ op: 'key', type: 'up', key: e.key, code: e.code, mods: mods(e) })
    },
    onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => {
      const t = e.clipboardData.getData('text')
      if (t) { e.preventDefault(); onInput!({ op: 'text', text: t }) }
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  } : {}

  const pill: CSSProperties = {
    position: 'absolute', left: '50%', top: 10, transform: 'translateX(-50%)', zIndex: 2,
    display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', pointerEvents: 'none',
    padding: '5px 12px', borderRadius: 999, fontSize: 11.5,
    background: 'color-mix(in srgb, var(--bg-surface) 82%, transparent)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
    border: `1px solid ${lock === 'unlocked' ? ORANGE : 'var(--border-strong, var(--border))'}`,
    color: lock === 'unlocked' ? 'var(--anthropic-orange-light, var(--anthropic-orange))' : 'var(--text-primary)',
  }

  return (
    <div ref={boxRef} data-browser-screen data-lock={lock} style={{ position: 'relative', flex: 1, minHeight: 0, background: '#000', overflow: 'hidden' }}>
      <div
        {...handlers}
        aria-label={open ? (pt ? 'Página do navegador — clique e digite para usar' : 'Browser page — click and type to use it') : (pt ? 'Página do navegador (só olhando)' : 'Browser page (view only)')}
        role={open ? 'application' : 'img'}
        style={{
          outline: 'none', cursor: open ? 'default' : 'not-allowed', touchAction: open ? 'none' : 'auto',
          ...(fit ? { position: 'absolute', left: fit.left, top: fit.top, width: fit.width, height: fit.height } : { position: 'relative', width: '100%' }),
        }}
      >
        {frame && (
          <img
            ref={imgRef}
            alt=""
            draggable={false}
            src={`data:image/jpeg;base64,${frame.jpeg}`}
            style={{ display: 'block', width: '100%', height: fit ? '100%' : 'auto', userSelect: 'none', pointerEvents: 'none' }}
          />
        )}
        {ring && (
          <span data-browser-ring aria-hidden style={{
            position: 'absolute', left: `${ring.left}%`, top: `${ring.top}%`, width: 26, height: 26, transform: 'translate(-50%,-50%)',
            border: '3px solid var(--anthropic-orange-light, #F59E0B)', borderRadius: '50%', boxShadow: '0 0 0 6px rgba(245,158,11,.25)', pointerEvents: 'none', boxSizing: 'border-box',
          }} />
        )}
      </div>
      {!noPill && lock !== 'none' && (
        <div data-browser-pill style={pill}>
          {lock === 'unlocked'
            ? <><Hand size={13} aria-hidden />{pt ? 'Você está usando · o modelo espera' : 'You are using it · the model waits'}</>
            : <><Lock size={13} aria-hidden />{pt ? 'Só olhando · clique no cadeado para usar' : 'Just watching · click the padlock to use it'}</>}
        </div>
      )}
      {showStatus && (
        <div role="status" data-browser-status style={{
          position: frame ? 'absolute' : 'relative', ...(frame ? { left: 0, right: 0, bottom: 0 } : { height: '100%' }),
          display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '8px 14px',
          fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)',
          background: frame ? 'color-mix(in srgb, var(--bg-surface) 82%, transparent)' : 'transparent',
        }}>{status.detail || status.label}</div>
      )}
    </div>
  )
}

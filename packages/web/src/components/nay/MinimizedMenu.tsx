/**
 * MinimizedMenu.tsx — the list of minimized Nay windows, opened FROM the chat button.
 *
 * It replaced a row of orange outlined chips beside the button (owner, 2026-09-29): the chips cut
 * titles at a dozen characters, said nothing about what each session was doing, and sat on the
 * page as loud as a warning. Now the button carries a small count, and the list opens:
 *  - on HOVER with a mouse (a short delay, so passing over the button on the way elsewhere does
 *    not flash it open), and stays while the pointer travels into it;
 *  - on a LONG-PRESS with touch or a pen — a tap is still the chat button, because a phone has no
 *    hover and the tap already has a job. Tapping the count badge opens it too;
 *  - from the keyboard with ArrowUp on the focused button.
 * A long-press that opened the list swallows the click that follows it, so the chat never opens
 * underneath. A pointer that MOVES past `PRESS_SLOP` cancels the press: that is a drag, and a drag
 * must never open anything.
 *
 * The rows use the session's own words: the state label the server already localized, its color
 * from `STATE_COLOR` (the same token every other surface uses), and the harness's display label.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { PictureInPicture2, X } from 'lucide-react'
import type { HarnessId } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { STATE_COLOR } from '../../lib/sessionCardStyle'
import { HARNESS_LABELS } from '../../lib/harness'
import { minimizedBadge, menuPlacement, type MenuPlacement } from '../../lib/nayDock'

const HOVER_OPEN_MS = 140
const HOVER_CLOSE_MS = 260
const LONG_PRESS_MS = 450
const PRESS_SLOP = 6
const MENU_W = 320

export interface MinimizedItem {
  id: string
  row: ControlSession | undefined
}

export interface MinimizedMenuProps {
  pt: boolean
  items: MinimizedItem[]
  onRestore: (id: string) => void
  onClose: (id: string) => void
  /** Where the button sits on the screen. The wrapper is positioned by the caller. */
  anchorStyle: CSSProperties
  /** True while the button is being dragged: the list closes and nothing may open it. */
  suppressed?: boolean
  /** The chat button itself; its click is wrapped so a long-press can swallow it. */
  renderButton: (p: { onClickCapture: (e: ReactMouseEvent) => void; onKeyDown: (e: ReactKeyboardEvent) => void }) => ReactNode
}

export function MinimizedMenu({ pt, items, onRestore, onClose, anchorStyle, suppressed = false, renderButton }: MinimizedMenuProps) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<MenuPlacement>({ vertical: 'above', horizontal: 'right' })
  const anchorRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const press = useRef<{ x: number; y: number; timer: number } | null>(null)
  const swallowClick = useRef(false)
  const count = items.length

  const clearTimers = () => {
    if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null }
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null }
  }
  const show = useCallback(() => { clearTimers(); if (count > 0) setOpen(true) }, [count])
  const hideSoon = () => {
    if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null }
    if (closeTimer.current === null) closeTimer.current = window.setTimeout(() => { closeTimer.current = null; setOpen(false) }, HOVER_CLOSE_MS)
  }

  // Nothing left to list closes the list, and so does picking the button up.
  useEffect(() => { if (count === 0) setOpen(false) }, [count])
  useEffect(() => {
    if (!suppressed) return
    clearTimers()
    if (press.current) { window.clearTimeout(press.current.timer); press.current = null }
    setOpen(false)
  }, [suppressed])
  useEffect(() => () => { clearTimers(); if (press.current) window.clearTimeout(press.current.timer) }, [])

  // Which way to open is decided when it opens: above-and-left of the button by default, flipped
  // when the button sits too close to the top or the left edge of the window.
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const r = anchorRef.current.getBoundingClientRect()
    setPlace(menuPlacement(r, { w: window.innerWidth, h: window.innerHeight }, MENU_W))
  }, [open])

  // An outside press or Escape dismisses it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey) }
  }, [open])

  const onEnter = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse' || count === 0 || suppressed) return
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null }
    if (!open && openTimer.current === null) openTimer.current = window.setTimeout(() => { openTimer.current = null; setOpen(true) }, HOVER_OPEN_MS)
  }
  const onLeave = (e: ReactPointerEvent) => { if (e.pointerType === 'mouse') hideSoon() }

  const cancelPress = () => { if (press.current) { window.clearTimeout(press.current.timer); press.current = null } }
  const onDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse' || count === 0) return
    cancelPress()
    const timer = window.setTimeout(() => { press.current = null; swallowClick.current = true; show() }, LONG_PRESS_MS)
    press.current = { x: e.clientX, y: e.clientY, timer }
  }
  const onMove = (e: ReactPointerEvent) => {
    const p = press.current
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > PRESS_SLOP) cancelPress()
  }

  const onClickCapture = (e: ReactMouseEvent) => {
    if (!swallowClick.current) return
    swallowClick.current = false
    e.preventDefault(); e.stopPropagation()
  }
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowUp' && count > 0) { e.preventDefault(); show() }
  }

  const badge = minimizedBadge(count)
  const menuPos: CSSProperties = {
    position: 'absolute', width: MENU_W, maxWidth: 'calc(100vw - 24px)',
    ...(place.vertical === 'above' ? { bottom: 'calc(100% + 10px)' } : { top: 'calc(100% + 10px)' }),
    ...(place.horizontal === 'right' ? { right: 0 } : { left: 0 }),
  }

  return (
    <div
      ref={anchorRef}
      style={anchorStyle}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onContextMenu={e => { if (count > 0) e.preventDefault() }}
    >
      {renderButton({ onClickCapture, onKeyDown })}

      {badge && (
        <button
          type="button"
          onClick={e => { e.stopPropagation(); if (open) setOpen(false); else show() }}
          aria-label={pt ? `${count} janela(s) minimizada(s)` : `${count} minimized window(s)`}
          aria-expanded={open}
          className="ag-tap-icon"
          style={{
            position: 'absolute', top: -6, right: -6, minWidth: 20, height: 20, padding: '0 5px',
            borderRadius: 999, border: '1px solid var(--border)', background: 'var(--bg-elevated, var(--bg-surface))',
            color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 11, fontWeight: 600, lineHeight: '18px',
            fontVariantNumeric: 'tabular-nums', cursor: 'pointer', boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
          }}
        >{badge}</button>
      )}

      {open && count > 0 && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={pt ? 'Janelas minimizadas' : 'Minimized windows'}
          onPointerEnter={e => { if (e.pointerType === 'mouse' && closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null } }}
          onPointerLeave={onLeave}
          style={{
            ...menuPos, zIndex: 1, overflow: 'hidden',
            background: 'var(--bg-elevated, var(--bg-surface))', border: '1px solid var(--border)', borderRadius: 10,
            boxShadow: '0 14px 36px rgba(0, 0, 0, 0.34), 0 2px 6px rgba(0, 0, 0, 0.18)',
            animation: 'ag-fade-in 120ms ease-out',
          }}
        >
          <div style={{
            padding: '9px 12px 7px', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
            color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between',
          }}>
            <span>{pt ? 'Minimizadas' : 'Minimized'}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{count}</span>
          </div>
          <div style={{ maxHeight: 'min(360px, 60vh)', overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {items.map(({ id, row }) => {
              const title = row?.title ?? 'Nay'
              const color = row ? STATE_COLOR[row.state] : 'var(--text-tertiary)'
              const harness = row?.harness ? (HARNESS_LABELS[row.harness as HarnessId] ?? row.harness) : null
              return (
                <div key={id} role="none" style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--border)' }}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { onRestore(id); setOpen(false) }}
                    title={pt ? 'Restaurar a janela' : 'Restore the window'}
                    style={{
                      flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 6px 9px 12px',
                      border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                      color: 'var(--text-primary)',
                    }}
                    className="ag-menu-row"
                  >
                    <span style={{
                      fontSize: 13, fontWeight: 500, lineHeight: 1.35, overflow: 'hidden', display: '-webkit-box',
                      WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word',
                    }}>{title}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-tertiary)', minWidth: 0 }}>
                      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
                      <span style={{ color }}>{row?.stateLabel ?? (pt ? 'estado desconhecido' : 'state unknown')}</span>
                      {harness && <><span aria-hidden>·</span><span style={{ whiteSpace: 'nowrap' }}>{harness}</span></>}
                    </span>
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingRight: 6 }}>
                    <MenuIcon label={pt ? 'Restaurar' : 'Restore'} onClick={() => { onRestore(id); setOpen(false) }}>
                      <PictureInPicture2 size={14} />
                    </MenuIcon>
                    <MenuIcon label={pt ? 'Fechar a janela' : 'Close the window'} onClick={() => onClose(id)}>
                      <X size={14} />
                    </MenuIcon>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function MenuIcon({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="ag-tap-icon" style={{
      width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none',
      borderRadius: 7, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
    }}>{children}</button>
  )
}

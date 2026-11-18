/**
 * SessionRowMenu — the right-click menu on a session row.
 *
 * A portal, so it escapes the aside's `overflow` clipping, positioned at the pointer and flipped
 * when it would leave the viewport. It closes on an outside `mousedown` (on the press, not on a
 * release that may land somewhere else), on `Escape`, and after any entry is taken; focus returns
 * to the row.
 *
 * CASCADE (SESSAO.MENU-AGRUPADO): an entry with `children` opens a submenu — Windows-style, on hover
 * AND on click / Enter / →, closed by ← / Esc. The submenu is its OWN fixed portal (the root menu
 * scrolls, so a child inside it would be clipped), placed from the parent row's rect: to the right,
 * flipped to the left and shifted up when it would leave the viewport. On a phone there is no side
 * cascade: the submenu replaces the list in the same sheet, with a ‹ back row (44px targets).
 */

import { useEscapeOwner } from '../../lib/overlayStack'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Archive, Bell, ChevronLeft, Columns2, Crown, Folder, Pencil, Pin, Power, RotateCcw, Square, SquareCheck, Trash2 } from 'lucide-react'
import { isInsidePortalledMenu, menuMaxHeight, type MenuEntry } from '../../lib/rowMenu'
import { useIsMobile } from '../../hooks/useIsMobile'
import { RoleChip } from './RoleChip'
import { SESSION_ROW_MENU_Z } from '../../lib/zLayers'

export interface SessionRowMenuProps {
  x: number
  y: number
  entries: MenuEntry[]
  onPick: (action: string) => void
  onClose: () => void
  /** Dropdowns stay below their trigger and scroll in the available space. */
  below?: boolean
  sessionList?: boolean
  /** The dropdown trigger handles its own toggle, rather than counting as an outside press. */
  triggerRef?: RefObject<HTMLElement | null>
}

const ICONS: Record<string, typeof Pencil> = {
  pencil: Pencil, panel: Columns2, stop: Square, task: SquareCheck, folder: Folder, crown: Crown,
  bell: Bell, power: Power, trash: Trash2, resume: RotateCcw, archive: Archive,
}

const SUB_W = 232

/** Where a submenu goes: right of its parent row, flipped left and shifted up to stay on screen. */
export function submenuPlacement(
  anchor: { left: number; right: number; top: number }, w: number, h: number, vw: number, vh: number,
): { left: number; top: number; flipped: boolean } {
  let left = anchor.right + 2
  let flipped = false
  if (left + w > vw - 8) { left = anchor.left - w - 2; flipped = true }
  left = Math.max(8, Math.min(left, vw - w - 8))
  let top = anchor.top - 5
  if (top + h > vh - 4) top = vh - 4 - h
  top = Math.max(4, top)
  return { left, top, flipped }
}

function useGlass(): boolean {
  const reducedTransparency = window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches ?? false
  // Keep the opaque card surface unless both the tint and a blur implementation are supported.
  // `data-glass="off"` is the capture switch used by the real-screen gallery. Keep the
  // historical default when the attribute is absent so existing installs and tests do not
  // change merely because this experiment was shipped.
  return document.documentElement.dataset.glass !== 'off'
    && !reducedTransparency
    && !!(window.CSS?.supports('backdrop-filter', 'blur(16px)')
    || window.CSS?.supports('-webkit-backdrop-filter', 'blur(16px)'))
    && !!window.CSS?.supports('background', 'color-mix(in srgb, var(--bg-card) 72%, transparent)')
}

function surface(glass: boolean) {
  return {
    background: glass ? 'color-mix(in srgb, var(--bg-card) 72%, transparent)' : 'var(--bg-card)',
    ...(glass ? { backdropFilter: 'blur(16px) saturate(140%)', WebkitBackdropFilter: 'blur(16px) saturate(140%)' } : {}),
    border: '1px solid var(--border)', borderRadius: 10,
    padding: 4, boxShadow: 'var(--ag-shadow-pop)',
  } as const
}

/** Arrow-key movement among the enabled items of the menu that holds the focus. */
function moveFocus(e: KeyboardEvent<HTMLElement>, dir: 1 | -1 | 'first' | 'last') {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]:not(:disabled)'))
  if (items.length === 0) return
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = dir === 'first' ? 0 : dir === 'last' ? items.length - 1 : at < 0 ? (dir === 1 ? 0 : items.length - 1) : (at + dir + items.length) % items.length
  items[next]!.focus()
  e.preventDefault()
}

export function SessionRowMenu({ x, y, entries, onPick, onClose, below = false, sessionList = false, triggerRef }: SessionRowMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  // 44px of finger on a phone, and nowhere else. This menu is reached by a LONG PRESS on touch,
  // so every one of its entries is a touch target by construction.
  const isMobile = useIsMobile()
  /** Index (in `entries`) of the open cascading entry — desktop. */
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  /** The cascading entry the phone's sheet has drilled into. */
  const [drill, setDrill] = useState<MenuEntry | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const focusSub = useRef(false)

  const closeSub = () => { setOpenIdx(null) }
  useEscapeOwner(true, onClose)
  // Registered after the menu's own owner, so it is top-most while a submenu is open: Esc closes
  // the submenu first and a second Esc the menu.
  useEscapeOwner(openIdx !== null || drill !== null, () => {
    const i = openIdx
    setDrill(null); setOpenIdx(null)
    if (i !== null) rowRefs.current[i]?.focus()
  })
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !triggerRef?.current?.contains(e.target as Node) && !isInsidePortalledMenu(e.target)) onClose() }
    document.addEventListener('mousedown', away)
    return () => {
      document.removeEventListener('mousedown', away)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [onClose, triggerRef])

  const list = drill ? (drill.children ?? []) : entries
  const open = openIdx !== null && !isMobile ? entries[openIdx] : undefined

  // Flipped rather than clamped: a menu pinned to the viewport edge covers the row it belongs to.
  // 236 for the cascade (the approved prototype's width); the flat menus keep their 210.
  const w = Math.min(sessionList ? 380 : entries.some(e => e.children) ? 236 : 210, window.innerWidth - 16)
  const left = Math.max(8, Math.min(x, window.innerWidth - w - 8))
  // Capped to the viewport and scrollable: a long list (the tab strip's "all tabs") must never put
  // its last entries past the screen edge.
  const maxH = below ? Math.max(0, window.innerHeight - y - 4) : menuMaxHeight(window.innerHeight)
  const [rootHeight, setRootHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    const measure = () => setRootHeight(ref.current?.offsetHeight ?? 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [entries, drill, maxH, w])
  const h = rootHeight ?? 0
  const top = below ? y : y + h > window.innerHeight - 4 ? Math.max(4, y - h) : y

  const glass = useGlass()

  // The submenu's place is measured from its parent row, after layout.
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null)
  const subW = Math.min(SUB_W, window.innerWidth - 16)
  useLayoutEffect(() => {
    if (!open || openIdx === null) { setSubPos(null); return }
    const a = rowRefs.current[openIdx]?.getBoundingClientRect()
    if (!a) return
    const p = submenuPlacement(a, subW, subRef.current?.offsetHeight ?? 0, window.innerWidth, window.innerHeight)
    setSubPos({ left: p.left, top: p.top })
  }, [open, openIdx, subW, rootHeight])
  useEffect(() => {
    if (open && subPos && focusSub.current) {
      focusSub.current = false
      subRef.current?.querySelector<HTMLButtonElement>(':scope > [role="menuitem"]:not(:disabled)')?.focus()
    }
  }, [open, subPos])

  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null } }
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(closeSub, 220) }



  const renderItem = (e: MenuEntry, i: number, inSub: boolean, siblings: readonly MenuEntry[]): ReactNode => {
    const hasIcons = siblings.some(s => s.icon)
    const cascades = !!e.children && e.children.length > 0
    const Icon = e.icon ? ICONS[e.icon] : undefined
    const isOpen = !inSub && !isMobile && openIdx === i
    const color = e.danger ? 'var(--accent-red)' : e.enabled ? 'var(--text-primary)' : 'var(--text-tertiary)'
    return (
      <Fragment key={`${e.action}:${i}`}>
        {e.separatorBefore && <div role="separator" style={{ borderTop: '1px solid var(--border)', margin: '4px 6px' }} />}
        <button
          ref={inSub ? undefined : el => { rowRefs.current[i] = el }}
          role="menuitem"
          tabIndex={-1}
          disabled={!e.enabled}
          aria-haspopup={cascades ? 'menu' : undefined}
          aria-expanded={cascades ? isOpen : undefined}
          // The reason is on the entry itself, so a disabled row explains itself on hover instead
          // of leaving the reader to guess.
          title={e.reason ?? e.label}
          onClick={() => {
            if (!e.enabled) return
            if (cascades) {
              if (isMobile && !inSub) setDrill(e)
              else if (!inSub) { cancelClose(); focusSub.current = true; setOpenIdx(i) }
              return
            }
            onPick(e.action); onClose()
          }}
          style={{
            display: 'flex', alignItems: 'center', width: '100%', gap: 8,
            minHeight: isMobile ? 44 : 0,
            padding: '8px 10px', borderRadius: 7, border: 'none', textAlign: 'left',
            background: isOpen ? 'var(--bg-elevated)' : 'transparent', fontFamily: 'inherit', fontSize: 12.5,
            color,
            cursor: e.enabled ? 'pointer' : 'default',
          }}
          onMouseEnter={ev => {
            if (e.enabled) ev.currentTarget.style.background = 'var(--bg-elevated)'
            if (inSub || isMobile) return
            cancelClose()
            // Windows: moving onto another row swaps (or drops) the submenu at once.
            if (cascades && e.enabled) setOpenIdx(i)
            else setOpenIdx(null)
          }}
          onMouseLeave={ev => {
            if (!isOpen) ev.currentTarget.style.background = 'transparent'
            if (!inSub && !isMobile && cascades) scheduleClose()
          }}
        >
          {(sessionList || e.pinned) && <span aria-hidden style={{ width: 11, flexShrink: 0 }}>{e.pinned && <Pin size={11} style={{ color: 'var(--anthropic-orange)' }} />}</span>}
          {(sessionList || e.color) && <span aria-hidden style={{ flexShrink: 0, width: 8, height: 8, borderRadius: '50%', background: e.color ?? 'transparent' }} />}
          {hasIcons && (
            <span aria-hidden style={{ width: 14, height: 14, flexShrink: 0, display: 'inline-flex', color: e.danger ? 'var(--accent-red)' : 'var(--text-secondary)' }}>
              {Icon && <Icon size={14} />}
            </span>
          )}
          <span style={{ flex: e.hint ? '0 0 auto' : 1, minWidth: 0, whiteSpace: e.hint ? 'nowrap' : 'normal', overflowWrap: 'anywhere', lineHeight: 1.4 }}>
            <span data-menu-title>{e.label}</span>
            {e.leader && <span style={{ display: 'inline-block', marginLeft: 6 }}><RoleChip role="leader" pt={e.leaderLabel === 'Líder'} /></span>}
            {e.detail && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)' }}>{e.detail}</span>}
          </span>
          {e.hint && <span data-menu-hint style={{ marginLeft: 'auto', flexShrink: 1, minWidth: 0, maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--text-tertiary)' }}>{e.hint}</span>}
          {cascades && <span aria-hidden style={{ marginLeft: e.hint ? 6 : 'auto', flexShrink: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>▸</span>}
          {e.checked && <span aria-hidden style={{ marginLeft: 'auto', flexShrink: 0, width: 12, color: 'var(--text-primary)', fontWeight: 700, textAlign: 'right' }}>✓</span>}
        </button>
      </Fragment>
    )
  }

  // A row with a refused verb says why here too, not only on hover: a tooltip is a fact only
  // a mouse can reach.
  const note = (items: MenuEntry[]) => {
    const refused = items.find(e => !e.enabled && e.reason)
    return refused ? (
      <p data-menu-note style={{ margin: '4px 6px 2px', fontSize: 10.5, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>{refused.reason}</p>
    ) : null
  }

  const onRootKey = (ev: KeyboardEvent<HTMLElement>) => {
    if (ev.key === 'ArrowDown') moveFocus(ev, 1)
    else if (ev.key === 'ArrowUp') moveFocus(ev, -1)
    else if (ev.key === 'Home') moveFocus(ev, 'first')
    else if (ev.key === 'End') moveFocus(ev, 'last')
    else if (ev.key === 'ArrowRight' && !isMobile) {
      const i = rowRefs.current.indexOf(document.activeElement as HTMLButtonElement)
      const e = i >= 0 ? entries[i] : undefined
      if (e?.children?.length && e.enabled) { ev.preventDefault(); cancelClose(); focusSub.current = true; setOpenIdx(i) }
    }
  }
  const onSubKey = (ev: KeyboardEvent<HTMLElement>) => {
    if (ev.key === 'ArrowDown') moveFocus(ev, 1)
    else if (ev.key === 'ArrowUp') moveFocus(ev, -1)
    else if (ev.key === 'Home') moveFocus(ev, 'first')
    else if (ev.key === 'End') moveFocus(ev, 'last')
    else if (ev.key === 'ArrowLeft') {
      ev.preventDefault()
      const i = openIdx
      closeSub()
      if (i !== null) rowRefs.current[i]?.focus()
    }
  }

  return createPortal(
    <>
      <div
        ref={ref}
        role="menu"
        data-portalled-menu
        onKeyDown={onRootKey}
        style={{
          position: 'fixed', top, left, width: w, boxSizing: 'border-box', zIndex: SESSION_ROW_MENU_Z,
          visibility: rootHeight === null ? 'hidden' : 'visible',
          maxHeight: maxH, overflowY: 'auto', overscrollBehavior: 'contain',
          ...surface(glass),
        }}
      >
        {drill && (
          <button
            role="menuitem" data-menu-back tabIndex={-1}
            onClick={() => setDrill(null)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 44,
              padding: '8px 10px', borderRadius: 7, border: 'none', textAlign: 'left', background: 'transparent',
              fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer',
            }}
          >
            <ChevronLeft size={14} aria-hidden />{drill.label}
          </button>
        )}
        {list.map((e, i) => renderItem(e, i, drill !== null, list))}
        {note(list)}
      </div>
      {open?.children && (
        <div
          ref={subRef}
          role="menu"
          data-portalled-menu
          data-submenu={open.label}
          onKeyDown={onSubKey}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          style={{
            position: 'fixed', top: subPos?.top ?? 0, left: subPos?.left ?? 0, width: subW, boxSizing: 'border-box',
            visibility: subPos ? 'visible' : 'hidden',
            zIndex: SESSION_ROW_MENU_Z + 1, maxHeight: menuMaxHeight(window.innerHeight), overflowY: 'auto', overscrollBehavior: 'contain',
            ...surface(glass),
          }}
        >
          {open.heading && (
            <div style={{ padding: '7px 10px 3px', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{open.heading}</div>
          )}
          {open.children.map((e, i) => renderItem(e, i, true, open.children!))}
          {note(open.children)}
        </div>
      )}
    </>,
    document.body,
  )
}

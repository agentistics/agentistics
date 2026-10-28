/**
 * SessionRowMenu — the right-click menu on a session row.
 *
 * A portal, so it escapes the aside's `overflow` clipping, positioned at the pointer and flipped
 * when it would leave the viewport. It closes on an outside `mousedown` (on the press, not on a
 * release that may land somewhere else), on `Escape`, and after any entry is taken; focus returns
 * to the row.
 */

import { useEscapeOwner } from '../../lib/overlayStack'
import { Fragment, useEffect, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Pin } from 'lucide-react'
import { isInsidePortalledMenu, menuMaxHeight, type MenuEntry } from '../../lib/rowMenu'
import { useIsMobile } from '../../hooks/useIsMobile'
import { RoleChip } from './RoleChip'
import { BetaTag } from '../BetaTag'
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

/**
 * The entries that belong to the delivery board rather than to the session itself.
 *
 * `openTask` and `finishTask` were here and are gone with the verbs — a delivery is finished when
 * its session is STOPPED, which is where the question is asked now. Filing is what remains.
 */
const TASK_ENTRIES = new Set<string>(['link-task', 'unlink-task'])

export function SessionRowMenu({ x, y, entries, onPick, onClose, below = false, sessionList = false, triggerRef }: SessionRowMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  // 44px of finger on a phone, and nowhere else. This menu is reached by a LONG PRESS on touch,
  // so every one of its entries is a touch target by construction.
  const isMobile = useIsMobile()

  useEscapeOwner(true, onClose)
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !triggerRef?.current?.contains(e.target as Node) && !isInsidePortalledMenu(e.target)) onClose() }
    document.addEventListener('mousedown', away)
    return () => {
      document.removeEventListener('mousedown', away)
    }
  }, [onClose, triggerRef])

  // Flipped rather than clamped: a menu pinned to the viewport edge covers the row it belongs to.
  const w = Math.min(sessionList ? 380 : 210, window.innerWidth - 16)
  const rowH = isMobile ? 44 : 34
  const left = Math.max(8, Math.min(x, window.innerWidth - w - 8))
  // Capped to the viewport and scrollable: a long list (the tab strip's "all tabs") must never put
  // its last entries past the screen edge.
  const maxH = below ? Math.max(0, window.innerHeight - y - 4) : menuMaxHeight(window.innerHeight)
  const h = Math.min(entries.length * rowH + 12, maxH)
  const top = below ? y : y + h > window.innerHeight ? Math.max(4, y - h) : y

  // Keep the opaque card surface unless both the tint and a blur implementation are supported.
  const glass = (window.CSS?.supports('backdrop-filter', 'blur(16px)')
    || window.CSS?.supports('-webkit-backdrop-filter', 'blur(16px)'))
    && window.CSS?.supports('background', 'color-mix(in srgb, var(--bg-card) 72%, transparent)')

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-portalled-menu
      style={{
        position: 'fixed', top, left, width: w, boxSizing: 'border-box', zIndex: SESSION_ROW_MENU_Z,
        maxHeight: maxH, overflowY: 'auto', overscrollBehavior: 'contain',
        background: glass ? 'color-mix(in srgb, var(--bg-card) 72%, transparent)' : 'var(--bg-card)',
        ...(glass ? { backdropFilter: 'blur(16px) saturate(140%)', WebkitBackdropFilter: 'blur(16px) saturate(140%)' } : {}),
        border: '1px solid var(--border)', borderRadius: 10,
        padding: 4, boxShadow: 'var(--ag-shadow-pop)',
      }}
    >
      {entries.map((e, i) => (
        <Fragment key={`${e.action}:${i}`}>
        {e.separatorBefore && <div role="separator" style={{ borderTop: '1px solid var(--border)', margin: '4px 6px' }} />}
        <button
          key={`${e.action}:${i}`}
          role="menuitem"
          disabled={!e.enabled}
          // The reason is on the entry itself, so a disabled row explains itself on hover instead
          // of leaving the reader to guess.
          title={e.reason ?? e.label}
          onClick={() => { if (e.enabled) { onPick(e.action); onClose() } }}
          style={{
            display: 'flex', alignItems: 'center', width: '100%', gap: 8,
            minHeight: isMobile ? 44 : 0,
            padding: '8px 10px', borderRadius: 7, border: 'none', textAlign: 'left',
            background: 'transparent', fontFamily: 'inherit', fontSize: 12.5,
            color: e.enabled ? 'var(--text-primary)' : 'var(--text-tertiary)',
            cursor: e.enabled ? 'pointer' : 'default',
          }}
          onMouseEnter={ev => { if (e.enabled) ev.currentTarget.style.background = 'var(--bg-elevated)' }}
          onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent' }}
        >
          {(sessionList || e.pinned) && <span aria-hidden style={{ width: 11, flexShrink: 0 }}>{e.pinned && <Pin size={11} style={{ color: 'var(--anthropic-orange)' }} />}</span>}
          {(sessionList || e.color) && <span aria-hidden style={{ flexShrink: 0, width: 8, height: 8, borderRadius: '50%', background: e.color ?? 'transparent' }} />}
          <span style={{ flex: 1, minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.4 }}>
            <span data-menu-title>{e.label}</span>
            {e.leader && <span style={{ display: 'inline-block', marginLeft: 6 }}><RoleChip role="leader" pt={e.leaderLabel === 'Líder'} /></span>}
            {e.detail && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)' }}>{e.detail}</span>}
          </span>
          {e.checked && <span aria-hidden style={{ marginLeft: 'auto', flexShrink: 0, width: 12, color: 'var(--text-primary)', fontWeight: 700, textAlign: 'right' }}>✓</span>}
          {/* Same rule as the three-dot menu: where the delivery board reaches into a session
              surface, it says it is in beta. `link-task` is the entry that opens the picker. */}
          {TASK_ENTRIES.has(e.action) && i === entries.findIndex(x => TASK_ENTRIES.has(x.action)) && <BetaTag what="Tasks" style={{ marginLeft: 'auto', flexShrink: 0 }} />}
        </button>
        </Fragment>
      ))}
      {/* A row with a refused verb says why here too, not only on hover: a tooltip is a fact only
          a mouse can reach. */}
      {entries.some(e => !e.enabled && e.reason) && (
        <p style={{
          margin: '4px 6px 2px', fontSize: 10.5, lineHeight: 1.4, color: 'var(--text-tertiary)',
        }}>
          {entries.find(e => !e.enabled && e.reason)!.reason}
        </p>
      )}
    </div>,
    document.body,
  )
}

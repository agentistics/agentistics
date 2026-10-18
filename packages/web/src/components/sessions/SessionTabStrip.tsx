/**
 * SessionTabStrip — the open conversations as tabs, in their own row at the top of the conversation
 * panel (rounded tabs in a segmented track; flag `sessionTabs`). The header above it is unchanged.
 *
 * It holds NO rule: the order, the neighbour a close lands on and the caps are `lib/sessionTabs.ts`;
 * a pin is `lib/pinnedSessions.ts` (never a second store); how a state looks is `STATE_COLOR`.
 * Every status mark carries its word (`aria-label` + `title`) — colour is never the only signal.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { ChevronDown, Crown, List, Moon, Pin, X } from 'lucide-react'
import { sessionIdentityKey } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { STATE_COLOR } from '../../lib/sessionCardStyle'
import { needsAttention } from '../nav/AttentionDot'
import { useSessionRole } from '../../lib/sessionRoles'
import { tabStripEdgeFade, tabStripFadeMask } from '../../lib/tabStripEdge'
import { reorderByDrag, setDragPayload, readDragPayload } from '../../lib/dragReorder'
import {
  MAX_PINNED, getPinnedIds, movePinnedSession, pinnedServerSnapshot, subscribePinnedSessions, togglePinnedSession,
} from '../../lib/pinnedSessions'
import {
  ENDED, splitSleepingTabs, closeEnded, closeOthers, closeTab, closeToRight, enterTab, livePins, ownsTabShortcut, reconcileTabs, stepTab, stripOrder, tabAt,
} from '../../lib/sessionTabs'
import { getPrevActive, setOpenTabs, setPrevActive, trackStripMount, updateOpenTabs, useOpenTabs } from '../../lib/sessionTabsStore'
import { getActivePane, usePaneId } from '../../lib/paneScope'
import { matchTabShortcut } from '../../lib/panelShortcuts'
import { useIsMobile, useIsCoarsePointer } from '../../hooks/useIsMobile'
import { SessionRowMenu } from './SessionRowMenu'
import { HarnessMark } from './HarnessMark'
import type { MenuEntry } from '../../lib/rowMenu'

const LEADER_PREFIX = /^\[ (LÍDER|LEADER) \] - /

export interface SessionTabStripProps {
  lang: 'pt' | 'en'
  /** The fleet rows tabs resolve against (the whole fleet, ended rows included). */
  rows: readonly ControlSession[]
  /** False until the first fleet answer lands — nothing is pruned before that. */
  fleetReady: boolean
  /** The session on screen in this pane. */
  active: ControlSession
  /** Go to a session (the same path the aside takes). */
  onGo: (id: string) => void
  /** Reuse the fleet list's resume action, then follow the reopened row in this pane. */
  onReopen: (row: ControlSession) => Promise<{ ok: boolean; message: string }>
  /** Nothing left open: leave for the overview. */
  onNone: () => void
}

const keyOf = (r: ControlSession): string => sessionIdentityKey(r)

// ── the status mark every tab carries ──────────────────────────────────────────────────────────
function TabStatus({ state, label, size = 8 }: { state: ControlSession['state']; label: string; size?: number }) {
  const c = STATE_COLOR[state]
  const ended = ENDED.has(state)
  return (
    <span role="img" aria-label={label} title={label} style={{ position: 'relative', display: 'inline-flex', width: size, height: size, flexShrink: 0 }}>
      {state === 'waiting-approval' && (
        <span className="ag-mic-pulse" aria-hidden style={{ position: 'absolute', inset: -3, borderRadius: '50%', border: `1.5px solid ${c}` }} />
      )}
      <span aria-hidden className={state === 'working' ? 'ag-hint-pulse' : undefined} style={{
        width: size, height: size, borderRadius: '50%', boxSizing: 'border-box',
        background: ended ? 'transparent' : c, border: ended ? `1.5px solid ${c}` : 'none',
      }} />
    </span>
  )
}

interface TabProps {
  k: string
  row: ControlSession | undefined
  active: boolean
  pinned: boolean
  mobile: boolean
  /** Coarse pointer (touch): sizing/visibility of the × follow it, not only the width. */
  touch: boolean
  pt: boolean
  onPick: () => void
  onClose: () => void
  onUnpin: () => void
  onMenu: (x: number, y: number) => void
  onDropOn: (dragKey: string) => void
  setRef: (el: HTMLDivElement | null) => void
}

const FOCUS_RING = '2px solid var(--anthropic-orange)'
/** Enter/Space on the inner controls act on THEM; they must not reach the tab's own handler (which would activate it). */
const stopKeys = (e: { key: string; stopPropagation(): void }) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }

function Tab({ k, row, active, pinned, mobile, touch, pt, onPick, onClose, onUnpin, onMenu, onDropOn, setRef }: TabProps) {
  const role = useSessionRole(k)
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const [btnFocus, setBtnFocus] = useState(false)
  const big = mobile || touch
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const state = row?.state ?? 'unknown'
  const label = row?.stateLabel ?? (pt ? 'sem estado' : 'no state')
  const ended = ENDED.has(state)
  const needs = row !== undefined && needsAttention(row)
  const title = (row?.title ?? k.slice(0, 8)).replace(LEADER_PREFIX, '')
  const clear = () => { if (press.current !== null) { clearTimeout(press.current); press.current = null } }
  const btn: CSSProperties = {
    display: 'flex', width: big ? 32 : 20, height: big ? 32 : 20, alignItems: 'center', justifyContent: 'center',
    borderRadius: 4, flexShrink: 0, padding: 0, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
  }
  const style: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, cursor: 'pointer', fontFamily: 'inherit',
    height: mobile ? 44 : 30, padding: '0 6px 0 12px', borderRadius: 8, boxSizing: 'border-box',
    fontSize: 12, whiteSpace: 'nowrap', scrollSnapAlign: 'center',
    minWidth: mobile ? 132 : 110, maxWidth: mobile ? 168 : 240,
    fontWeight: active || needs ? 650 : 500,
    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
    background: active ? 'var(--bg-elevated)' : hover ? 'color-mix(in srgb, var(--bg-elevated) 50%, transparent)' : 'transparent',
    border: 'none',
    boxShadow: active ? 'var(--ag-shadow-seg), 0 0 0 1px var(--border)'
      : needs ? 'inset 0 -2px 0 color-mix(in srgb, var(--anthropic-orange) 55%, transparent)' : 'none',
  }
  return (
    <div
      ref={setRef}
      role="tab" aria-selected={active} tabIndex={active ? 0 : -1} data-session-tab={k}
      title={row ? `${row.title}\n${label} · ${row.cwd}` : title}
      draggable
      onDragStart={e => setDragPayload(e, k)}
      onDragOver={e => e.preventDefault()}
      onDrop={e => { const d = readDragPayload(e); if (d) { e.preventDefault(); onDropOn(d) } }}
      onClick={onPick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick() }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && !pinned) { e.preventDefault(); onClose() }
      }}
      onAuxClick={e => { if (e.button === 1) { e.preventDefault(); if (!pinned) onClose() } }}
      onContextMenu={e => { e.preventDefault(); onMenu(e.clientX, e.clientY) }}
      onTouchStart={e => { const t = e.touches[0]; if (t) { clear(); press.current = setTimeout(() => onMenu(t.clientX, t.clientY), 500) } }}
      onTouchEnd={clear} onTouchMove={clear} onTouchCancel={clear}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={style}
    >
      <TabStatus state={state} label={label} />
      {row && <span style={{ display: 'inline-flex', flexShrink: 0, opacity: active ? 1 : 0.6 }}><HarnessMark harness={row.harness} size={14} /></span>}
      {role === 'leader' && <Crown size={11} aria-label={pt ? 'Líder' : 'Leader'} style={{ color: 'var(--accent-purple)', flexShrink: 0, opacity: active ? 1 : 0.6 }} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0, opacity: ended && !active ? 0.7 : 1 }}>{title}</span>
      {pinned
        ? (
          <button
            type="button" aria-label={pt ? 'Desafixar' : 'Unpin'} title={pt ? 'Desafixar' : 'Unpin'}
            data-tab-unpin
            onClick={e => { e.stopPropagation(); onUnpin() }}
            onKeyDown={stopKeys}
            onFocus={() => setBtnFocus(true)} onBlur={() => setBtnFocus(false)}
            style={{ ...btn, background: 'transparent', outline: btnFocus ? FOCUS_RING : 'none' }}
          ><Pin size={12} style={{ color: 'var(--anthropic-orange)' }} /></button>
        )
        : (
          <button
            type="button" aria-label={pt ? 'Fechar aba' : 'Close tab'} title={pt ? 'Fechar aba' : 'Close tab'}
            data-tab-close
            onClick={e => { e.stopPropagation(); onClose() }}
            onKeyDown={stopKeys}
            onFocus={() => setBtnFocus(true)} onBlur={() => setBtnFocus(false)}
            style={{
              ...btn, color: 'var(--text-secondary)',
              background: hover ? 'var(--bg-elevated)' : 'transparent',
              opacity: active || hover || focus || btnFocus || big ? 1 : 0,
              outline: btnFocus ? FOCUS_RING : 'none',
            }}
          ><X size={13} /></button>
        )}
    </div>
  )
}

export function SessionTabStrip({ lang, rows, fleetReady, active, onGo, onReopen, onNone }: SessionTabStripProps) {
  const pt = lang === 'pt'
  const mobile = useIsMobile()
  const touch = useIsCoarsePointer()
  const pane = usePaneId()
  const open = useOpenTabs()
  const allPins = useSyncExternalStore(subscribePinnedSessions, getPinnedIds, pinnedServerSnapshot)
  const activeKey = keyOf(active)
  const knownKeys = useMemo(() => {
    if (!fleetReady || rows.length === 0) return null
    const k = new Set<string>([activeKey])
    for (const r of rows) k.add(keyOf(r))
    return k
  }, [fleetReady, rows, activeKey])
  // A pin whose session left the fleet outright is not a tab (the aside drops it the same way).
  const pins = useMemo(() => livePins(allPins, knownKeys), [allPins, knownKeys])
  const byKey = useMemo(() => {
    const m = new Map<string, ControlSession>()
    for (const r of rows) { m.set(keyOf(r), r); if (!m.has(r.id)) m.set(r.id, r) }
    return m
  }, [rows])
  const { drawn: order, sleeping } = useMemo(
    () => splitSleepingTabs(stripOrder(open, pins), pins, k => byKey.get(k)?.state),
    [open, pins, byKey],
  )
  const drawnPins = pins.filter(k => order.includes(k))
  const [notice, setNotice] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[]; below?: boolean; pick: (a: string) => void } | null>(null)

  useEffect(() => {
    if (notice === null) return
    const t = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(t)
  }, [notice])
  // The previous-active anchors outlive a remount (split pane) but not the last strip.
  useEffect(() => trackStripMount(), [])

  // Navigation IS "open a tab": whatever put a session on screen (aside, rail, `#` mention, reopen)
  // lands here, so there is exactly one place that adds one.
  useEffect(() => {
    const prev = getPrevActive(pane)
    setPrevActive(pane, { key: activeKey, id: active.id })
    updateOpenTabs(pane, cur => enterTab(cur, activeKey, prev, active.id, pins))
  }, [activeKey, active.id, pins, pane]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!fleetReady || rows.length === 0) return
    const list = rows.map(r => ({ id: r.id, key: keyOf(r) }))
    updateOpenTabs(pane, cur => reconcileTabs(cur, list, activeKey))
  }, [fleetReady, rows, pane, activeKey])

  const goTo = useCallback((key: string) => {
    const r = byKey.get(key)
    onGo(r?.id ?? key)
  }, [byKey, onGo])

  const closeKeys = useCallback((nextOpen: string[]) => {
    setOpenTabs(pane, nextOpen)
    // If the tab on screen was closed, land on the nearest one still open, else the overview.
    const stillThere = nextOpen.includes(activeKey) || pins.includes(activeKey)
    if (stillThere) return
    const left = splitSleepingTabs(stripOrder(nextOpen, pins), pins, k => byKey.get(k)?.state).drawn
    const at = order.indexOf(activeKey)
    const target = left.find(k => order.indexOf(k) > at) ?? left[left.length - 1]
    if (target) goTo(target); else onNone()
  }, [pane, activeKey, pins, order, byKey, goTo, onNone])

  const close = useCallback((key: string) => {
    const r = closeTab(order, key, activeKey, pins)
    setOpenTabs(pane, r.open)
    if (r.active !== activeKey) { if (r.active) goTo(r.active); else onNone() }
  }, [order, activeKey, pins, pane, goTo, onNone])

  const togglePin = useCallback((key: string) => {
    const out = togglePinnedSession(key)
    if (!out.ok && out.reason === 'limit') {
      setNotice(pt ? `No máximo ${MAX_PINNED} conversas fixadas. Solte uma antes de fixar outra.` : `At most ${MAX_PINNED} pinned conversations. Unpin one first.`)
      return
    }
    setNotice(null)
  }, [pt])

  const dropOn = useCallback((drag: string, drop: string) => {
    const a = pins.includes(drag), b = pins.includes(drop)
    if (a && b) movePinnedSession(drag, drop)
    else if (!a && !b) setOpenTabs(pane, reorderByDrag(open, drag, drop))
  }, [pins, open, pane])

  // ── keyboard: Ctrl+Alt+→/← step, Ctrl+Alt+1..9 jump (Ctrl+W is the browser's) ──────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!ownsTabShortcut(pane, getActivePane(), e.defaultPrevented)) return
      const el = e.target as Element | null
      const hit = matchTabShortcut({
        key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey,
        isComposing: e.isComposing, focusInTerminal: el?.closest?.('.xterm') != null,
      })
      if (!hit) return
      const target = hit.kind === 'step' ? stepTab(order, activeKey, hit.by) : tabAt(order, hit.n)
      if (target === null || target === activeKey) return
      e.preventDefault()
      goTo(target)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [order, activeKey, goTo])

  // ── scroll + edge fade, the active tab kept on screen (the mobile panel switcher's own pattern) ─
  const stripRef = useRef<HTMLDivElement | null>(null)
  const tabEls = useRef<Map<string, HTMLDivElement>>(new Map())
  const [edges, setEdges] = useState({ left: false, right: false })
  const measure = useCallback(() => {
    const el = stripRef.current
    if (el) setEdges(tabStripEdgeFade({ scrollLeft: el.scrollLeft, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }))
  }, [])
  const attach = useCallback((el: HTMLDivElement | null) => {
    stripRef.current = el
    if (el === null) return
    measure()
    tabEls.current.get(activeKey)?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [activeKey, measure])
  useEffect(() => {
    tabEls.current.get(activeKey)?.scrollIntoView({ inline: 'center', block: 'nearest' })
    measure()
  }, [activeKey, order.length, measure])
  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])
  const fade = tabStripFadeMask(edges)

  // ── menus ─────────────────────────────────────────────────────────────────────────────────────
  const tabMenu = (key: string, x: number, y: number) => {
    const pinned = pins.includes(key)
    const entries: MenuEntry[] = [
      { action: 'pin', label: pinned ? (pt ? 'Desafixar' : 'Unpin') : (pt ? 'Fixar' : 'Pin'), enabled: true },
      { action: 'close', label: pt ? 'Fechar' : 'Close', enabled: !pinned, ...(pinned ? { reason: pt ? 'Desafixe para fechar.' : 'Unpin to close.' } : {}) },
      { action: 'others', label: pt ? 'Fechar outras' : 'Close others', enabled: true },
      { action: 'right', label: pt ? 'Fechar à direita' : 'Close to the right', enabled: true },
    ]
    setMenu({
      x, y, entries,
      pick: a => {
        if (a === 'pin') togglePin(key)
        else if (a === 'close') close(key)
        else if (a === 'others') closeKeys(closeOthers(open, key))
        else if (a === 'right') closeKeys(closeToRight(order, key, pins).filter(k => !pins.includes(k)))
      },
    })
  }
  const listMenu = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const rowEntries: MenuEntry[] = order.map(k => {
      const row = byKey.get(k)
      const t = (row?.title ?? k.slice(0, 8)).replace(LEADER_PREFIX, '')
      return { action: `go:${k}`, label: `${t} · ${row?.stateLabel ?? ''}`, enabled: true, ...(pins.includes(k) ? { pinned: true } : {}), checked: k === activeKey, ...(row ? { color: STATE_COLOR[row.state] } : {}) }
    })
    const isEnded = (k: string) => { const row = byKey.get(k); return row ? ENDED.has(row.state) : false }
    setMenu({
      x: r.left, y: r.bottom + 4, below: true,
      entries: [
        ...rowEntries,
        ...(sleeping.length > 0 ? [
          { action: 'sleeping', label: pt ? 'Dormindo' : 'Sleeping', enabled: false, separatorBefore: true },
          ...sleeping.map(k => ({ action: `reopen:${k}`, label: (byKey.get(k)?.title ?? k).replace(LEADER_PREFIX, ''), enabled: true, pinned: true })),
        ] : []),
        { action: 'others', label: pt ? 'Fechar outras' : 'Close others', enabled: true, separatorBefore: true },
        { action: 'ended', label: pt ? 'Fechar encerradas' : 'Close ended', enabled: open.some(isEnded) },
        { action: 'all', label: pt ? 'Fechar todas' : 'Close all', enabled: open.length > 0 },
      ],
      pick: a => {
        if (a.startsWith('go:')) goTo(a.slice(3))
        else if (a.startsWith('reopen:')) {
          const row = byKey.get(a.slice(7))
          if (row) void onReopen(row).then(out => { if (!out.ok) setNotice(out.message) })
            .catch(error => setNotice(String(error)))
        }
        else if (a === 'others') closeKeys(closeOthers(open, activeKey))
        else if (a === 'ended') closeKeys(closeEnded(open, isEnded))
        else if (a === 'all') closeKeys([])
      },
    })
  }

  return (
    <div data-session-tabs style={{ position: 'relative', flexShrink: 0, minWidth: 0, borderBottom: '1px solid var(--border-subtle)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, padding: 0 }}>
      <button
        type="button" aria-haspopup="menu" aria-label={pt ? 'Abas abertas e dormindo' : 'Open and sleeping tabs'}
        onClick={e => listMenu(e.currentTarget)}
        style={{
          display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, height: mobile ? 44 : 30, minWidth: mobile ? 44 : 0, justifyContent: 'center',
          padding: '0 8px', marginLeft: 6, boxSizing: 'border-box', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)',
          cursor: 'pointer', fontFamily: 'inherit', fontSize: 11,
        }}
      ><List size={13} aria-hidden />{order.length}{sleeping.length > 0 && <Moon size={10} fill="currentColor" aria-hidden style={{ color: 'var(--text-tertiary)' }} />}<ChevronDown size={12} aria-hidden /></button>
      <div
        ref={attach} className="tabscroll" role="tablist" aria-label={pt ? 'Sessões abertas' : 'Open sessions'} onScroll={measure}
        style={{
          display: 'flex', alignItems: 'stretch', gap: 3, overflowX: 'auto', flex: 1, minWidth: 0,
          background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 3, margin: '4px 6px',
          WebkitOverflowScrolling: 'touch', scrollSnapType: 'x proximity',
          ...(fade !== null ? { maskImage: fade, WebkitMaskImage: fade } : null),
        }}
      >
        {order.map((k, i) => (
          <span key={k} style={{ display: 'contents' }}>
            {i === drawnPins.length && drawnPins.length > 0 && (
              <span aria-hidden style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)', margin: '6px 2px', flexShrink: 0 }} />
            )}
            <Tab
              k={k} row={byKey.get(k)} active={k === activeKey} pinned={pins.includes(k)} mobile={mobile} touch={touch} pt={pt}
              onPick={() => { if (k !== activeKey) goTo(k) }}
              onClose={() => close(k)}
              onUnpin={() => togglePin(k)}
              onMenu={(x, y) => tabMenu(k, x, y)}
              onDropOn={d => dropOn(d, k)}
              setRef={el => { if (el) tabEls.current.set(k, el); else tabEls.current.delete(k) }}
            />
          </span>
        ))}
      </div>
      {menu !== null && (
        <SessionRowMenu below={menu.below} x={menu.x} y={menu.y} entries={menu.entries} onPick={menu.pick} onClose={() => setMenu(null)} />
      )}
    </div>
    {notice !== null && (
      <p
        role="status" data-tab-notice
        style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, margin: 0, padding: '6px 10px',
          fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-surface)',
          border: '1px solid var(--border)', borderTop: 'none',
        }}
      >{notice}</p>
    )}
    </div>
  )
}

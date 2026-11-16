import { ActionNotice } from './ActionNotice'
/**
 * SessionTabStrip — the open conversations as tabs, in their own row at the top of the conversation
 * panel (rounded tabs in a segmented track; flag `sessionTabs`). The header above it is unchanged.
 *
 * It holds NO rule: the order, the neighbour a close lands on and the caps are `lib/sessionTabs.ts`;
 * a pin is `lib/pinnedSessions.ts` (never a second store); how a state looks is `STATE_COLOR`.
 * Every status mark carries its word (`aria-label` + `title`) — colour is never the only signal.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type Ref } from 'react'
import { RoleIcon } from '../nav/RoleIcon'
import { ChevronDown, List, Moon, Pin, Plus, X } from 'lucide-react'
import { sessionIdentityKey } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { STATE_COLOR } from '../../lib/sessionCardStyle'
import { needsAttention } from '../nav/AttentionDot'
import { getSessionRole, useSessionRole } from '../../lib/sessionRoles'
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

import { sessionDisplayTitle, hasLeaderTitle } from '../../lib/sessionDisplayTitle'

export interface SessionTabStripProps {
  onNoticeChange?: (notice: string | null) => void
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
/** The dot: filled (`hollow` false) or an outline; `pulse` = busy; `ring` = waiting on a person. */
export function TabDot({ color, hollow, pulse = false, ring = false, label, size = 8 }: { color: string; hollow: boolean; pulse?: boolean; ring?: boolean; label: string; size?: number }) {
  return (
    <span role="img" aria-label={label} title={label} style={{ position: 'relative', display: 'inline-flex', width: size, height: size, flexShrink: 0 }}>
      {ring && (
        <span className="ag-mic-pulse" aria-hidden style={{ position: 'absolute', inset: -3, borderRadius: '50%', border: `1.5px solid ${color}` }} />
      )}
      <span aria-hidden className={pulse ? 'ag-hint-pulse' : undefined} style={{
        width: size, height: size, borderRadius: '50%', boxSizing: 'border-box',
        background: hollow ? 'transparent' : color, border: hollow ? `1.5px solid ${color}` : 'none',
      }} />
    </span>
  )
}

function TabStatus({ state, label, size = 8 }: { state: ControlSession['state']; label: string; size?: number }) {
  return <TabDot color={STATE_COLOR[state]} hollow={ENDED.has(state)} pulse={state === 'working'} ring={state === 'waiting-approval'} label={label} size={size} />
}

/** What a session tab draws before its title: status, harness, role. */
function SessionTabLeading({ k, row, active, pt }: { k: string; row: ControlSession | undefined; active: boolean; pt: boolean }) {
  const role = useSessionRole(k)
  const state = row?.state ?? 'unknown'
  const label = row?.stateLabel ?? (pt ? 'sem estado' : 'no state')
  return (
    <>
      <TabStatus state={state} label={label} />
      {row && <span style={{ display: 'inline-flex', flexShrink: 0, opacity: active ? 1 : 0.6 }}><HarnessMark harness={row.harness} size={14} /></span>}
      <RoleIcon kind={role ?? (hasLeaderTitle(row?.title ?? '') ? 'leader' : 'auto')} size={11} pt={pt} style={{ opacity: active ? 1 : 0.6 }} />
    </>
  )
}

/**
 * One tab of a `TabStripView` — what it SAYS, never how it looks. The look (36px tab, 10/10/0/0 radius,
 * active on `--bg-card` with no border and no orange line; on the phone a 44px segment, radius 8, active on
 * `--bg-elevated`) belongs to the strip, so a browser's tabs and the session tabs cannot drift apart.
 */
export interface TabStripItem {
  key: string
  title: string
  tooltip: string
  /** Drawn before the title (the status dot, marks). */
  leading: ReactNode
  /** Pinned: an unpin button instead of the ×, and no close by key/middle click. */
  pinned?: boolean
  /** false = no × at all (a tab the person cannot close from here). Default true. */
  closable?: boolean
  /** Wants the person: bold, and the phone's underline. */
  emphasis?: boolean
  /** Finished: the title dims when not active. */
  ended?: boolean
}

interface TabProps {
  item: TabStripItem
  tabAttr: string
  active: boolean
  mobile: boolean
  /** Coarse pointer (touch): sizing/visibility of the × follow it, not only the width. */
  touch: boolean
  pt: boolean
  /** Phone only: the tab's width (default the whole strip — one session per snap). A browser's tabs use ~62 % so the neighbour shows. */
  mobileWidth?: string
  onFocused: () => void
  onFocusTab: (key: string) => void
  focusable: boolean
  onPick: () => void
  onClose: () => void
  onUnpin: () => void
  onMenu?: (x: number, y: number) => void
  onDropOn?: (dragKey: string) => void
  setRef: (el: HTMLDivElement | null) => void
}

const FOCUS_RING = '2px solid var(--anthropic-orange)'
/** Enter/Space on the inner controls act on THEM; they must not reach the tab's own handler (which would activate it). */
const stopKeys = (e: { key: string; stopPropagation(): void }) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }

function Tab({ item, tabAttr, active, mobile, touch, pt, mobileWidth, onFocused, onFocusTab, focusable, onPick, onClose, onUnpin, onMenu, onDropOn, setRef }: TabProps) {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const [btnFocus, setBtnFocus] = useState(false)
  const big = mobile || touch
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pinned = item.pinned === true
  const closable = item.closable !== false
  const ended = item.ended === true
  const needs = item.emphasis === true
  const title = item.title
  const clear = () => { if (press.current !== null) { clearTimeout(press.current); press.current = null } }
  const btn: CSSProperties = {
    display: 'flex', width: big ? 32 : 20, height: big ? 32 : 20, alignItems: 'center', justifyContent: 'center',
    borderRadius: 4, flexShrink: 0, padding: 0, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
  }
  const style: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, cursor: 'pointer', fontFamily: 'inherit',
    minHeight: mobile ? 44 : TAB_H, height: mobile ? undefined : TAB_H,
    padding: mobile ? '5px 6px 5px 12px' : '0 6px 0 12px', borderRadius: mobile ? 8 : '10px 10px 0 0', boxSizing: 'border-box',
    fontSize: 12, scrollSnapAlign: 'center', scrollSnapStop: 'always',
    minWidth: mobile ? 132 : 110, width: mobile ? (mobileWidth ?? '100%') : 'max-content', maxWidth: mobile ? (mobileWidth ?? '100%') : 360,
    fontWeight: active || needs ? 650 : 500,
    color: active || (!mobile && needs) ? 'var(--text-primary)' : 'var(--text-tertiary)',
    background: active ? (mobile ? 'var(--bg-elevated)' : 'var(--bg-card)') : hover ? 'color-mix(in srgb, var(--bg-elevated) 50%, transparent)' : 'transparent',
    border: 'none',
    // The track includes space for this overlap so horizontal scrolling cannot clip the join.
    boxShadow: mobile
      ? (active ? 'var(--ag-shadow-seg), 0 0 0 1px var(--border)' : needs ? 'inset 0 -2px 0 color-mix(in srgb, var(--anthropic-orange) 55%, transparent)' : 'none')
      : active ? `0 ${TAB_HEADER_OVERLAP}px 0 var(--bg-card)` : 'none',
  }
  return (
    <div
      ref={setRef}
      role="tab" aria-selected={active} tabIndex={focusable ? 0 : -1} {...{ [tabAttr]: item.key }}
      title={item.tooltip}
      draggable={onDropOn !== undefined}
      onDragStart={e => setDragPayload(e, item.key)}
      onDragOver={e => e.preventDefault()}
      onDrop={e => { const d = readDragPayload(e); if (d && onDropOn) { e.preventDefault(); onDropOn(d) } }}
      onClick={onPick}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); onFocusTab(e.key) }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick() }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && !pinned && closable) { e.preventDefault(); onClose() }
      }}
      onAuxClick={e => { if (e.button === 1) { e.preventDefault(); if (!pinned && closable) onClose() } }}
      onContextMenu={e => { if (!onMenu) return; e.preventDefault(); onMenu(e.clientX, e.clientY) }}
      onTouchStart={e => { const t = e.touches[0]; if (t && onMenu) { clear(); press.current = setTimeout(() => onMenu(t.clientX, t.clientY), 500) } }}
      onTouchEnd={clear} onTouchMove={clear} onTouchCancel={clear}
      onFocus={() => { setFocus(true); onFocused() }} onBlur={() => setFocus(false)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={style}
    >
      {item.leading}
      <span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', flex: 1, minWidth: 0, lineHeight: 1.35, opacity: ended && !active ? 0.7 : 1 }}>{title}</span>
      {!closable && !pinned ? null : pinned
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

/** App reserves precisely this band. The active tab paints 2px into the header, outside the
 * reserved height; the scroll track's bottom padding keeps that paint inside its clipping box. */
export const TAB_H = 36
export const TABLIST_TOP_PAD = 8
export const TAB_HEADER_OVERLAP = 2
export const TAB_STRIP_H = TAB_H + TABLIST_TOP_PAD

export interface TabStripViewProps {
  items: readonly TabStripItem[]
  activeKey: string
  pt: boolean
  /** The attribute naming the strip and each tab (`data-session-tabs` / `data-session-tab` for sessions). */
  stripAttr?: string
  tabAttr?: string
  tablistLabel: string
  /** How many leading items are pinned: a hairline separates them from the rest. */
  pinnedCount?: number
  /** The list button at the start: its label, the count it shows, what else it carries. */
  list: { label: string; count: number; extra?: ReactNode; expanded: boolean; onToggle: (el: HTMLButtonElement) => void; buttonRef?: Ref<HTMLButtonElement> }
  /** A "+" after the tabs (a browser's new tab). Absent = none. */
  plus?: { label: string; onClick: () => void; disabled?: boolean }
  /** Phone tab width (see `TabProps.mobileWidth`). */
  mobileTabWidth?: string
  onPick: (key: string) => void
  onClose?: (key: string) => void
  onUnpin?: (key: string) => void
  onMenu?: (key: string, x: number, y: number) => void
  onDropOn?: (drag: string, drop: string) => void
  /** Popovers drawn inside the row (menus). */
  children?: ReactNode
  /** Drawn under the row (a notice). */
  after?: ReactNode
}

/**
 * The tab strip's PRESENTATION, shared by the session tabs and the browser tabs (NAVEGADOR S5, spec §3.1):
 * list button with its count · scrolling tablist with edge fade · optional "+". Keyboard focus moves along the
 * tabs with the arrows; the active tab is kept in view. It holds no rule about WHAT a tab is.
 */
export function TabStripView({ items, activeKey, pt, stripAttr = 'data-session-tabs', tabAttr = 'data-session-tab', tablistLabel, pinnedCount = 0, list, plus, mobileTabWidth, onPick, onClose, onUnpin, onMenu, onDropOn, children, after }: TabStripViewProps) {
  const mobile = useIsMobile()
  const touch = useIsCoarsePointer()
  const order = useMemo(() => items.map(i => i.key), [items])
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
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
    setFocusedKey(activeKey)
    tabEls.current.get(activeKey)?.scrollIntoView({ inline: 'center', block: 'nearest' })
    measure()
  }, [activeKey, order.length, measure])
  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])
  const fade = tabStripFadeMask(edges)
  const listBtn: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0, height: mobile ? 44 : 30, minWidth: mobile ? 44 : 0, justifyContent: 'center',
    padding: '0 8px', marginLeft: 6, marginTop: mobile ? 0 : TABLIST_TOP_PAD, boxSizing: 'border-box', borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)',
    cursor: 'pointer', fontFamily: 'inherit', fontSize: 11,
  }

  return (
    <div {...{ [stripAttr]: '' }} style={{ position: 'relative', flexShrink: 0, minWidth: 0, boxSizing: 'border-box', ...(mobile ? { borderBottom: '1px solid var(--border-subtle)' } : { height: TAB_STRIP_H, background: 'var(--bg-base)' }) }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, padding: 0, ...(mobile ? null : { height: TAB_STRIP_H }) }}>
      <button
        ref={list.buttonRef}
        type="button" aria-haspopup="menu" aria-expanded={list.expanded} aria-label={list.label}
        onClick={e => list.onToggle(e.currentTarget)}
        style={listBtn}
      ><List size={13} aria-hidden />{list.count}{list.extra}<ChevronDown size={12} aria-hidden /></button>
      <div
        ref={attach} className="tabscroll" role="tablist" aria-label={tablistLabel} onScroll={measure}
        style={{
          display: 'flex', alignItems: 'stretch', gap: 3, overflowX: 'auto', flex: 1, minWidth: 0,
          ...(mobile ? {
            background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 3, margin: '4px 6px',
          } : {
            // Lift above the following header and extend the clipping box into it. No seam at 1× or 2× DPR.
            position: 'relative', zIndex: 1, alignSelf: 'flex-end', boxSizing: 'border-box',
            height: TAB_H + TAB_HEADER_OVERLAP, paddingBottom: TAB_HEADER_OVERLAP,
            margin: `0 6px -${TAB_HEADER_OVERLAP}px`,
          }),
          WebkitOverflowScrolling: 'touch', scrollSnapType: 'x mandatory',
          ...(!mobile && fade !== null ? { maskImage: fade, WebkitMaskImage: fade } : null),
        }}
      >
        {items.map((item, i) => {
          const k = item.key
          return (
            <span key={k} style={{ display: 'contents' }}>
              {i === pinnedCount && pinnedCount > 0 && (
                <span aria-hidden style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)', margin: '6px 2px', flexShrink: 0 }} />
              )}
              <Tab
                item={item} tabAttr={tabAttr} active={k === activeKey} mobile={mobile} touch={touch} pt={pt} {...(mobileTabWidth ? { mobileWidth: mobileTabWidth } : {})}
                onFocused={() => setFocusedKey(k)}
                focusable={k === (focusedKey && order.includes(focusedKey) ? focusedKey : activeKey)}
                onFocusTab={key => {
                  const target = key === 'Home' ? order[0] : key === 'End' ? order[order.length - 1] : stepTab(order, k, key === 'ArrowRight' ? 1 : -1)
                  if (target) { setFocusedKey(target); tabEls.current.get(target)?.focus(); tabEls.current.get(target)?.scrollIntoView({ inline: 'center', block: 'nearest' }) }
                }}
                onPick={() => { if (k !== activeKey) onPick(k) }}
                onClose={() => onClose?.(k)}
                onUnpin={() => onUnpin?.(k)}
                {...(onMenu ? { onMenu: (x: number, y: number) => onMenu(k, x, y) } : {})}
                {...(onDropOn ? { onDropOn: (d: string) => onDropOn(d, k) } : {})}
                setRef={el => { if (el) tabEls.current.set(k, el); else tabEls.current.delete(k) }}
              />
            </span>
          )
        })}
      </div>
      {plus && (
        <button
          type="button" aria-label={plus.label} title={plus.label} disabled={plus.disabled}
          onClick={plus.onClick}
          style={{ ...listBtn, marginLeft: 0, marginRight: 6, cursor: plus.disabled ? 'default' : 'pointer', opacity: plus.disabled ? 0.5 : 1 }}
        ><Plus size={13} aria-hidden /></button>
      )}
      {children}
    </div>
    {after}
    </div>
  )
}

export function SessionTabStrip({ lang, rows, fleetReady, active, onGo, onReopen, onNone, onNoticeChange }: SessionTabStripProps) {
  const pt = lang === 'pt'
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
  useEffect(() => { onNoticeChange?.(notice) }, [notice, onNoticeChange])
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

  // The scroll, the edge fade and the active tab kept on screen live in `TabStripView`.
  const listMenuButtonRef = useRef<HTMLButtonElement>(null)

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
      const t = sessionDisplayTitle(row?.title ?? k.slice(0, 8))
      return { action: `go:${k}`, label: t, detail: row?.stateLabel, leader: getSessionRole(k) === 'leader' || (row ? hasLeaderTitle(row.title) : false), leaderLabel: pt ? 'Líder' : 'Leader', enabled: true, ...(pins.includes(k) ? { pinned: true } : {}), checked: k === activeKey, ...(row ? { color: STATE_COLOR[row.state] } : {}) }
    })
    const isEnded = (k: string) => { const row = byKey.get(k); return row ? ENDED.has(row.state) : false }
    setMenu({
      x: r.left, y: r.bottom + 4, below: true,
      entries: [
        ...rowEntries,
        ...(sleeping.length > 0 ? [
          { action: 'sleeping', label: pt ? 'Dormindo' : 'Sleeping', enabled: false, separatorBefore: true },
          ...sleeping.map(k => ({ action: `reopen:${k}`, label: sessionDisplayTitle(byKey.get(k)?.title ?? k), detail: pt ? 'Reabrir' : 'Reopen', leader: getSessionRole(k) === 'leader' || hasLeaderTitle(byKey.get(k)?.title ?? ''), leaderLabel: pt ? 'Líder' : 'Leader', enabled: true, pinned: true })),
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

  const items: TabStripItem[] = order.map(k => {
    const row = byKey.get(k)
    const active2 = k === activeKey
    const label = row?.stateLabel ?? (pt ? 'sem estado' : 'no state')
    const title = sessionDisplayTitle(row?.title ?? k.slice(0, 8))
    return {
      key: k, title,
      tooltip: row ? `${row.title}\n${label} · ${row.cwd}` : title,
      leading: <SessionTabLeading k={k} row={row} active={active2} pt={pt} />,
      pinned: pins.includes(k),
      emphasis: row !== undefined && needsAttention(row),
      ended: ENDED.has(row?.state ?? 'unknown'),
    }
  })

  return (
    <TabStripView
      items={items} activeKey={activeKey} pt={pt} pinnedCount={drawnPins.length}
      tablistLabel={pt ? 'Sessões abertas' : 'Open sessions'}
      list={{
        label: pt ? 'Abas abertas e dormindo' : 'Open and sleeping tabs', count: order.length, expanded: Boolean(menu?.below), buttonRef: listMenuButtonRef,
        extra: sleeping.length > 0 ? <Moon size={10} fill="currentColor" aria-hidden style={{ color: 'var(--text-tertiary)' }} /> : null,
        onToggle: el => { if (menu?.below) setMenu(null); else listMenu(el) },
      }}
      onPick={goTo}
      onClose={close}
      onUnpin={togglePin}
      onMenu={tabMenu}
      onDropOn={dropOn}
      after={notice !== null && !onNoticeChange ? <ActionNotice message={notice} lang={lang} onDismiss={() => setNotice(null)} /> : null}
    >
      {menu !== null && (
        <SessionRowMenu triggerRef={menu.below ? listMenuButtonRef : undefined} sessionList={menu.below} below={menu.below} x={menu.x} y={menu.y} entries={menu.entries} onPick={menu.pick} onClose={() => setMenu(null)} />
      )}
    </TabStripView>
  )
}

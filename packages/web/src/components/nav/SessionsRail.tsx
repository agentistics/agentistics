/**
 * SessionsRail — the sessions workspace, in a 64px column.
 *
 * The aside used to withhold this body when collapsed, and `App.tsx` recorded why: "a 64px rail
 * cannot show a session's title, and a list of unlabelled dots is a list nobody can read." So it
 * fell through to the DASHBOARD's nav — Home, Costs, Tools — which is the one thing the sessions
 * workspace certainly is not.
 *
 * The objection is answered rather than overruled: the glyph never carries the fact alone. The
 * mark says which assistant, the dot says whether it is RUNNING or wants somebody, and the
 * TOOLTIP carries
 * exactly what the open row carries, by rendering the same `SessionFacts`.
 *
 * Hover-only is acceptable HERE AND ONLY HERE: `SideNav` is not rendered below the mobile
 * breakpoint, so there is no touch reader being asked to hover. It opens on keyboard focus too.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { HarnessMark } from '../sessions/HarnessMark'
import { SessionFacts } from '../sessions/SessionFacts'
import { sessionPath } from '../../lib/sessionRoute'
import { NewSessionModal } from '../sessions/NewSessionModal'
import { claimOrphanWizard } from '../../lib/newSessionWizardStore'
import { markSessionPending } from '../../lib/pendingSessionStore'
import { Filter, Folder, Pin, Plus } from 'lucide-react'
import { getPinnedIds, subscribePinnedSessions } from '../../lib/pinnedSessions'
import { getSessionGroups, subscribeSessionGroups } from '../../lib/sessionUserGroups'
import { sessionIdentityKey } from '../../lib/sessionIdentity'
import { railLayout, type RailFolderCounts, type RailItem } from '../../lib/railLayout'

/**
 * The dot a state earns, or null for one that earns none.
 *
 * Only the ACTIVE states are marked. A dot on every row is a rail with no contrast left, and the
 * point of the marker is that the handful of sessions doing something stand out from the history
 * under them — the same reasoning `sessionCardStyle.ts` records for the open list.
 */
function stateDot(state: string): string | null {
  if (state === 'waiting' || state === 'waiting-approval') return 'var(--anthropic-orange)'
  if (state === 'working') return '#22c55e'
  return null
}

/** How many marks the rail draws before it says how many more there are. */
const RAIL_MAX = 12

/** The folder tooltip's one line of counts — only the facts that are not zero, so it stays short. */
function folderCountsLine(c: RailFolderCounts, pt: boolean): string {
  const parts: string[] = []
  if (c.folders > 0) parts.push(pt ? `${c.folders} ${c.folders === 1 ? 'pasta' : 'pastas'}` : `${c.folders} ${c.folders === 1 ? 'folder' : 'folders'}`)
  if (c.waiting > 0) parts.push(pt ? `${c.waiting} aguardando` : `${c.waiting} waiting`)
  if (c.active > 0) parts.push(pt ? `${c.active} ${c.active === 1 ? 'ativa' : 'ativas'}` : `${c.active} active`)
  if (c.ended > 0) parts.push(pt ? `${c.ended} ${c.ended === 1 ? 'encerrada' : 'encerradas'}` : `${c.ended} ended`)
  return parts.join(' · ')
}

type FolderItem = Extract<RailItem<ControlSession>, { kind: 'folder' }>

export function SessionsRail({
  rows, allRows, selectedId, lang, hideNew, filtersOpen, filtersCount, onToggleFilters, filtersButtonRef,
}: {
  rows: readonly ControlSession[]
  /** The WHOLE fleet, unfiltered — pins and folders resolve against it, as they do in the open
   *  aside. See `railLayout.ts`. Absent reads as `rows`. */
  allRows?: readonly ControlSession[]
  selectedId?: string
  lang: 'pt' | 'en'
  /** Withholds "New session" where this surface cannot start one (a central). */
  hideNew?: boolean
  /** THE FILTROS TRIGGER (design item 4) — "visível também com ela minimizada": the rail is
   *  exactly that minimized state, so the icon carries the same badge the open list's button does.
   *  See `SessionsAside`'s own prop of the same name for the full story. */
  filtersOpen: boolean
  filtersCount: number
  onToggleFilters: () => void
  filtersButtonRef: (el: HTMLButtonElement | null) => void
}) {
  const navigate = useNavigate()
  const pt = lang === 'pt'
  // The wizard lives HERE too: the expanded aside owns its own copy, and it is unmounted while the
  // rail is showing, so a rail button that only set a flag would open nothing.
  const [creating, setCreating] = useState(false)
  // A layout swap unmounted the open wizard: take it over (see `newSessionWizardStore`).
  useEffect(() => { if (claimOrphanWizard()) setCreating(true) }, [])
  const [tip, setTip] = useState<{ top: number; left: number; session: ControlSession } | null>(null)
  const [folderTip, setFolderTip] = useState<{ top: number; left: number; folder: FolderItem } | null>(null)
  /** The folder whose sessions are open as a dropdown — replaces its tooltip while open. */
  const [openFolder, setOpenFolder] = useState<{ top: number; left: number; id: string } | null>(null)
  const dropdownRef = useRef<HTMLDivElement | null>(null)
  // Pins and folders are the SAME shared stores the open aside writes, so the rail follows a change
  // made there (or on another device) without a reload.
  const pinnedKeys = useSyncExternalStore(subscribePinnedSessions, getPinnedIds, getPinnedIds)
  const groupsValue = useSyncExternalStore(subscribeSessionGroups, getSessionGroups, getSessionGroups)
  const items = railLayout({
    rows, allRows: allRows ?? rows, pinnedKeys, groups: groupsValue.groups, keyOf: sessionIdentityKey,
  })
  const shown = items.slice(0, RAIL_MAX)
  const more = items.length - shown.length
  const openFolderItem = openFolder
    ? items.find((i): i is FolderItem => i.kind === 'folder' && i.id === openFolder.id)
    : undefined

  // A dropdown closes on a click outside it and on Escape — every menu in this app does.
  useEffect(() => {
    if (!openFolder) return
    const onDown = (e: MouseEvent) => {
      if (dropdownRef.current?.contains(e.target as Node)) return
      setOpenFolder(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenFolder(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openFolder])

  return (
    <nav className="ag-noscroll" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      overflowY: 'auto', overflowX: 'hidden', flex: 1, paddingTop: 4,
    }}>
      {/* The one solid accent control, as in the open aside: it is the only one that CREATES. It
          leads the rail, above the first session, so starting work is where it always is. */}
      {!hideNew && (
        <button
          onClick={() => setCreating(true)}
          aria-label={pt ? 'Nova sessão' : 'New session'}
          title={pt ? 'Nova sessão' : 'New session'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            width: 40, height: 40, borderRadius: 10, cursor: 'pointer', marginBottom: 4,
            border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)', color: '#141414',
          }}
          onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(1.1)' }}
          onMouseLeave={e => { e.currentTarget.style.filter = 'none' }}
        >
          <Plus size={18} />
        </button>
      )}
      {/* FILTROS, minimized — the same trigger `SessionsAside`'s open row carries, one icon instead
          of a labelled button. The badge is the digit alone (no room here for a pill around it). */}
      <button
        ref={filtersButtonRef}
        onClick={onToggleFilters}
        aria-expanded={filtersOpen}
        aria-label={pt ? 'Filtros — restringe a lista de sessões' : 'Filters — narrows the fleet list'}
        title={pt ? 'Filtros — restringe a lista de sessões' : 'Filters — narrows the fleet list'}
        style={{
          position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0, width: 40, height: 40, borderRadius: 10, cursor: 'pointer', marginBottom: 4,
          border: `1px solid ${filtersOpen ? 'var(--anthropic-orange)' : 'var(--border-subtle)'}`,
          background: filtersOpen ? 'var(--anthropic-orange-dim)' : 'transparent',
          color: filtersOpen ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
        }}
      >
        <Filter size={16} />
        {filtersCount > 0 && (
          <span aria-hidden style={{
            position: 'absolute', top: 2, right: 2,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minWidth: 13, height: 13, padding: '0 3px', borderRadius: 7,
            background: 'var(--anthropic-orange)', color: '#fff',
            fontSize: 8.5, fontWeight: 700, lineHeight: 1,
          }}>
            {filtersCount}
          </span>
        )}
      </button>
      {shown.map(item => {
        if (item.kind === 'folder') {
          const c = item.counts
          const dot = c.waiting > 0 ? 'var(--anthropic-orange)' : c.active > 0 ? '#22c55e' : null
          const isOpen = openFolder?.id === item.id
          return (
            <button
              key={`folder-${item.id}`}
              aria-label={`${item.name} — ${folderCountsLine(c, pt)}`}
              aria-expanded={isOpen}
              aria-haspopup="menu"
              onClick={e => {
                const r = e.currentTarget.getBoundingClientRect()
                setFolderTip(null)
                // The mousedown that reaches here is outside the dropdown and has already closed it,
                // so a second click on the same folder reopens rather than toggling — close it on
                // purpose when it is this folder's own.
                setOpenFolder(cur => (cur?.id === item.id ? null : { top: r.top, left: r.right + 10, id: item.id }))
              }}
              onMouseDown={e => { if (isOpen) e.stopPropagation() }}
              onMouseEnter={e => {
                if (openFolder) return
                const r = e.currentTarget.getBoundingClientRect()
                setFolderTip({ top: r.top, left: r.right + 10, folder: item })
              }}
              onFocus={e => {
                if (openFolder) return
                const r = e.currentTarget.getBoundingClientRect()
                setFolderTip({ top: r.top, left: r.right + 10, folder: item })
              }}
              onMouseLeave={() => setFolderTip(null)}
              onBlur={() => setFolderTip(null)}
              style={{
                position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 40, height: 40, borderRadius: 10, border: 'none', cursor: 'pointer',
                background: isOpen ? 'var(--bg-elevated)' : 'transparent',
                boxShadow: isOpen ? 'inset 0 0 0 1px var(--border)' : undefined,
                color: 'var(--anthropic-orange)',
              }}
            >
              <Folder size={20} />
              {dot && (
                <span aria-hidden style={{
                  position: 'absolute', top: 4, right: 4, width: 7, height: 7, borderRadius: 4,
                  background: dot, boxShadow: '0 0 0 2px var(--bg-surface)',
                }} />
              )}
            </button>
          )
        }
        const s = item.row
        return (
          <button
          key={s.id}
          onClick={() => navigate(sessionPath(s.id))}
          aria-label={item.pinned ? `${s.title} — ${pt ? 'fixada' : 'pinned'}` : s.title}
          onMouseEnter={e => {
            const r = e.currentTarget.getBoundingClientRect()
            setTip({ top: r.top, left: r.right + 10, session: s })
          }}
          onFocus={e => {
            const r = e.currentTarget.getBoundingClientRect()
            setTip({ top: r.top, left: r.right + 10, session: s })
          }}
          onMouseLeave={() => setTip(null)}
          onBlur={() => setTip(null)}
          style={{
            position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 40, height: 40, borderRadius: 10, border: 'none', cursor: 'pointer',
            background: s.id === selectedId ? 'var(--bg-elevated)' : 'transparent',
            boxShadow: s.id === selectedId ? 'inset 0 0 0 1px var(--border)' : undefined,
          }}
        >
          <HarnessMark harness={s.harness} size={22} />
          {/* PINNED, said on the mark itself (owner, 2026-09-29) — a small pin over the top-left
              corner, clear of the state dot in the top-right. Pins lead the rail, as in the aside. */}
          {item.pinned && (
            <span aria-hidden style={{
              position: 'absolute', top: 1, left: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 14, height: 14, borderRadius: 7, background: 'var(--bg-surface)',
              color: 'var(--anthropic-orange)',
            }}>
              <Pin size={9} />
            </span>
          )}
          {/* THREE STATES, TWO COLOURS, AND ABSENCE IS THE THIRD.
              The dot used to appear only for a row that WANTS somebody, which left a session that
              is WORKING looking exactly like one that finished hours ago — reported after turning
              "active only" off, where the twelve marks on the rail carry three needing a person
              and nine that could be anything. Running is the fact the rail exists to show.

              Orange for needs-you, green for working, nothing for a row that is neither. The
              green is `COLORS.running`'s own token rather than `--accent-green`, for the reason
              the cockpit records: the success green reads as teal and sits within a hair of the
              codex harness colour, which is the one thing a mark-and-dot pair must not do.

              It never carries the message alone — that is why the tooltip exists and why it
              renders the row's whole card. In a 64px rail there is no room for the word, so the
              rule becomes: the dot is the HINT, the tooltip is the FACT. */}
          {stateDot(s.state) && (
            <span aria-hidden style={{
              position: 'absolute', top: 4, right: 4, width: 7, height: 7, borderRadius: 4,
              background: stateDot(s.state)!, boxShadow: '0 0 0 2px var(--bg-surface)',
            }} />
          )}
        </button>
        )
      })}
      {more > 0 && (
        <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', paddingTop: 2 }}>+{more}</span>
      )}
      {creating && (
        <NewSessionModal
          lang={lang}
          onClose={() => setCreating(false)}
          onStarted={(id, started) => {
            setCreating(false)
            // Same hand-off as the open aside: the row is not in this browser's fleet yet, so the
            // router state says "this id is on its way" instead of letting the page fall back to
            // the overview for a poll. `markSessionPending` reaches the expanded aside's own
            // placeholder too, even though this collapsed rail draws none of its own.
            if (id) {
              markSessionPending({ id, ...started })
              navigate(sessionPath(id), { state: { creating: started ?? {} } })
            }
          }}
        />
      )}
      {folderTip && !openFolder && createPortal(
        <div role="tooltip" style={{
          position: 'fixed', top: Math.min(folderTip.top, window.innerHeight - 80), left: folderTip.left,
          maxWidth: 260, zIndex: 500, pointerEvents: 'none',
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
          padding: '8px 11px', boxShadow: 'var(--ag-shadow-pop)',
        }}>
          <div style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--text-primary)', marginBottom: 3 }}>
            {folderTip.folder.name}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            {folderCountsLine(folderTip.folder.counts, pt)}
          </div>
        </div>,
        document.body,
      )}
      {/* THE FOLDER, OPENED — a small navigation in place of the tooltip: the folder's own sessions,
          then each nested folder's under its name. Picking one opens it and closes this. */}
      {openFolder && openFolderItem && createPortal(
        <div
          ref={dropdownRef}
          role="menu"
          aria-label={openFolderItem.name}
          style={{
            position: 'fixed', top: Math.max(8, Math.min(openFolder.top, window.innerHeight - 360)), left: openFolder.left,
            width: 280, maxHeight: 'min(420px, calc(100vh - 16px))', overflowY: 'auto', zIndex: 510,
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
            padding: 6, boxShadow: 'var(--ag-shadow-pop)',
          }}
        >
          <div style={{ padding: '4px 8px 6px' }}>
            <div style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--text-primary)' }}>{openFolderItem.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {folderCountsLine(openFolderItem.counts, pt)}
            </div>
          </div>
          {openFolderItem.sections.map((sec, i) => (
            <div key={sec.id}>
              {/* The folder's OWN sessions need no heading — the header above is its name. */}
              {!(i === 0 && sec.id === openFolderItem.id) && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 8px 4px',
                  fontSize: 11, fontWeight: 650, color: 'var(--text-tertiary)',
                }}>
                  <Folder size={12} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sec.name}</span>
                </div>
              )}
              {sec.rows.map(r => {
                const d = stateDot(r.state)
                return (
                  <button
                    key={r.id}
                    role="menuitem"
                    onClick={() => { setOpenFolder(null); navigate(sessionPath(r.id)) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0,
                      padding: '6px 8px', borderRadius: 7, border: 'none', cursor: 'pointer', textAlign: 'left',
                      fontFamily: 'inherit', fontSize: 12.5,
                      background: r.id === selectedId ? 'var(--bg-elevated)' : 'transparent',
                      color: r.id === selectedId ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                    onMouseEnter={e => { if (r.id !== selectedId) e.currentTarget.style.background = 'var(--bg-elevated)' }}
                    onMouseLeave={e => { if (r.id !== selectedId) e.currentTarget.style.background = 'transparent' }}
                  >
                    <HarnessMark harness={r.harness} size={15} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.title}
                    </span>
                    {d && <span aria-hidden style={{ width: 7, height: 7, borderRadius: 4, background: d, flexShrink: 0 }} />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>,
        document.body,
      )}
      {tip && createPortal(
        <div role="tooltip" style={{
          position: 'fixed', top: Math.min(tip.top, window.innerHeight - 140), left: tip.left,
          width: 260, zIndex: 500, pointerEvents: 'none',
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
          padding: '9px 11px', boxShadow: 'var(--ag-shadow-pop)',
        }}>
          <SessionFacts session={tip.session} />
        </div>,
        document.body,
      )}
    </nav>
  )
}

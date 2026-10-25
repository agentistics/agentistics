/**
 * SessionsRail — the sessions workspace, in a 64px column.
 *
 * It MIRRORS the open aside (owner, 2026-10-23: "A + C + D", open AND collapsed): the same three
 * tabs as icons with the same badges, and under them the same arrangement in marks —
 *
 * - **Ativas**: one card per leader (the crown avatar) with its team's marks under it; a folded team
 *   shows "+N" instead, and clicking the folded leader UNFOLDS (it never opens). Sessions with no
 *   leader follow a dashed separator; what fell is one quiet icon at the foot that leads to Encerradas.
 * - **Grupos**: one folder per top-level folder with its live count; clicking opens it in place,
 *   with the same fold the open aside stores.
 * - **Encerradas**: reopen-what-fell, then the fallen, the sleeping and today's finished marks.
 *
 * The tab and the folds are the SAME stored arrangement the open aside reads (`sessionsAsidePrefs`),
 * and the teams and sections come from the same pure module (`asideTabs.ts`), so collapsing the
 * aside never rearranges anything.
 *
 * The glyph never carries the fact alone: the TOOLTIP renders `SessionFacts` — exactly what the open
 * row carries — plus the team line. Hover-only is acceptable HERE AND ONLY HERE: `SideNav` is not
 * rendered below the mobile breakpoint, so there is no touch reader being asked to hover. It opens
 * on keyboard focus too.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Archive, Crown, Folder, List, Plus, RotateCcw } from 'lucide-react'
import { ACTIVE_STATES, sortSessions, type ControlSession } from '@agentistics/tui/control/session-fleet'
import { HarnessMark } from '../sessions/HarnessMark'
import { SessionFacts } from '../sessions/SessionFacts'
import { SessionPickModal } from '../sessions/SessionPickModal'
import { sessionPath } from '../../lib/sessionRoute'
import { NewSessionModal } from '../sessions/NewSessionModal'
import { claimOrphanWizard, onWizardOrphaned } from '../../lib/newSessionWizardStore'
import { markSessionPending } from '../../lib/pendingSessionStore'
import { getPinnedIds, subscribePinnedSessions } from '../../lib/pinnedSessions'
import { getSessionGroups, subscribeSessionGroups } from '../../lib/sessionUserGroups'
import { sessionIdentityKey } from '../../lib/sessionIdentity'
import { railLayout, type RailFolderCounts, type RailItem } from '../../lib/railLayout'
import { sessionDisplayTitle, hasLeaderTitle } from '../../lib/sessionDisplayTitle'
import { getSessionRole, useSessionRoles } from '../../lib/sessionRoles'
import { buildPickRows } from '../../lib/sessionPick'
import { withReopening } from '../../lib/reopeningStore'
import { endDispatch, tryBeginDispatch } from '../../lib/dispatchGuard'
import { loadClosedFleet } from '../../lib/fleet'
import type { RowVerb } from '../../lib/rowMenu'
import {
  readAsideGroupPrefs, toggleFoldedTeam, useAsideTab, useFoldedTeams, writeAsideGroupPrefs, subscribeAsideGroupPrefs,
} from '../../lib/sessionsAsidePrefs'
import { buildTeams, endedSections, isWaitingState, teamSummary, type AsideTab } from '../../lib/asideTabs'
import { SegmentedTabs } from './SegmentedTabs'

/** The dot a state earns on a mark: orange for needs-you, green for working, nothing otherwise. */
function stateDot(state: string): string | null {
  if (state === 'waiting' || state === 'waiting-approval') return 'var(--anthropic-orange)'
  if (state === 'working') return '#22c55e'
  return null
}

/** How many marks one ended section draws before it says how many more there are. */
const SECTION_MAX = 8

/** The folder tooltip's one line of counts — only the facts that are not zero, so it stays short. */
function folderCountParts(c: RailFolderCounts, pt: boolean): string[] {
  const parts: string[] = []
  if (c.folders > 0) parts.push(pt ? `${c.folders} ${c.folders === 1 ? 'pasta' : 'pastas'}` : `${c.folders} ${c.folders === 1 ? 'folder' : 'folders'}`)
  if (c.waiting > 0) parts.push(pt ? `${c.waiting} aguardando` : `${c.waiting} waiting`)
  if (c.active > 0) parts.push(pt ? `${c.active} ${c.active === 1 ? 'ativa' : 'ativas'}` : `${c.active} active`)
  if (c.ended > 0) parts.push(pt ? `${c.ended} ${c.ended === 1 ? 'encerrada' : 'encerradas'}` : `${c.ended} ended`)
  return parts
}

export function RailFolderFacts({ counts, pt }: { counts: RailFolderCounts; pt: boolean }) {
  return <span style={{ display: 'flex', flexWrap: 'wrap', columnGap: 10, rowGap: 3 }}>
    {folderCountParts(counts, pt).map(part => <span key={part}>{part}</span>)}
  </span>
}

type FolderItem = Extract<RailItem<ControlSession>, { kind: 'folder' }>

type TipBody =
  | { kind: 'session'; session: ControlSession; lines: string[] }
  | { kind: 'folder'; folder: FolderItem }
type Tip = TipBody & { top: number; left: number }

const ACTIVE = new Set<string>(ACTIVE_STATES)

export function SessionsRail({
  rows, allRows, selectedId, lang, hideNew, rowsById, act,
}: {
  rows: readonly ControlSession[]
  /** The WHOLE fleet, unfiltered — teams, pins and folders resolve against it, as they do in the
   *  open aside. Absent reads as `rows`. */
  allRows?: readonly ControlSession[]
  selectedId?: string
  lang: 'pt' | 'en'
  /** Withholds "New session" where this surface cannot start one (a central). */
  hideNew?: boolean
  /** The fleet's verb-carrying rows — which ones FELL, for the badge and the reopen. */
  rowsById?: Map<string, { verbs: RowVerb[]; fell?: boolean; title?: string; project?: string; cwd?: string; stateLabel?: string }>
  /** Performs the group reopen. Absent = the reopen icon is not drawn. */
  act?: (req: { id: string; action: string; ids?: readonly string[] }) => Promise<{ ok: boolean; message: string }>
}) {
  const navigate = useNavigate()
  const pt = lang === 'pt'
  // The wizard lives HERE too: the expanded aside owns its own copy, and it is unmounted while the
  // rail is showing, so a rail button that only set a flag would open nothing.
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    const adopt = () => { if (claimOrphanWizard()) setCreating(true) }
    adopt()
    return onWizardOrphaned(adopt)
  }, [])
  const [tip, setTip] = useState<Tip | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const acting = useRef(false)
  const tab = useAsideTab()
  const setTab = (t: AsideTab) => writeAsideGroupPrefs({ tab: t })
  const foldedTeams = useFoldedTeams()
  const collapsedFolders = useSyncExternalStore(
    subscribeAsideGroupPrefs, () => readAsideGroupPrefs().collapsedUserGroups.join('\u0000'), () => '',
  )
  useSessionRoles()
  const pinnedKeys = useSyncExternalStore(subscribePinnedSessions, getPinnedIds, getPinnedIds)
  const groupsValue = useSyncExternalStore(subscribeSessionGroups, getSessionGroups, getSessionGroups)
  const fleet = allRows ?? rows
  const isLeader = (r: ControlSession) => (getSessionRole(sessionIdentityKey(r)) ?? (hasLeaderTitle(r.title) ? 'leader' : undefined)) === 'leader'
  const isPinned = (r: ControlSession) => pinnedKeys.includes(sessionIdentityKey(r))
  const fellRows = useMemo(() => buildPickRows(rowsById ? rowsById.values() : [], pt).fellRows, [rowsById, pt])
  const fellIds = useMemo(() => new Set(fellRows.map(r => r.id)), [fellRows])
  const live = sortSessions(fleet.filter(r => ACTIVE.has(r.state) && !fellIds.has(r.id)), readAsideGroupPrefs().sort)
  const { teams, loose } = buildTeams(live, { isLeader, pinned: isPinned, keyOf: sessionIdentityKey })
  const ended = endedSections(fleet, { fellIds, keep: isPinned, now: Date.now() })
  const folders = railLayout({ rows: [], allRows: fleet, pinnedKeys: [], groups: groupsValue.groups.filter(g => !g.hidden), keyOf: sessionIdentityKey })
    .filter((i): i is FolderItem => i.kind === 'folder')
  useEffect(() => { if (tab === 'ended') loadClosedFleet() }, [tab])

  const showTip = (el: HTMLElement, t: TipBody) => {
    const r = el.getBoundingClientRect()
    setTip({ ...t, top: r.top, left: r.right + 10 })
  }
  const tipHandlers = (t: TipBody) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => showTip(e.currentTarget, t),
    onFocus: (e: React.FocusEvent<HTMLElement>) => showTip(e.currentTarget, t),
    onMouseLeave: () => setTip(null),
    onBlur: () => setTip(null),
  })

  /** One session as a round mark: the crown for a leader, the harness mark otherwise. */
  const mark = (s: ControlSession, o: { lines?: string[]; onClick?: () => void; fell?: boolean } = {}) => {
    const leader = isLeader(s)
    const dot = o.fell ? null : stateDot(s.state)
    const dim = !o.fell && !ACTIVE.has(s.state)
    const size = leader ? 34 : 30
    const selected = s.id === selectedId
    return (
      <button
        key={s.id}
        type="button"
        data-rail-mark={s.id}
        onClick={o.onClick ?? (() => navigate(sessionPath(s.id)))}
        aria-label={`${sessionDisplayTitle(s.title)}${leader ? (pt ? ' · líder' : ' · leader') : ''}, ${s.stateLabel}`}
        {...tipHandlers({ kind: 'session', session: s, lines: o.lines ?? [] })}
        style={{
          position: 'relative', width: size, height: size, flexShrink: 0, borderRadius: '50%', padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          background: o.fell ? 'color-mix(in srgb, var(--accent-red) 16%, var(--bg-elevated))'
            : leader ? 'color-mix(in srgb, var(--accent-purple) 14%, var(--bg-elevated))' : 'var(--bg-elevated)',
          border: leader ? '1.5px solid color-mix(in srgb, var(--accent-purple) 55%, transparent)' : '1px solid var(--border)',
          boxShadow: selected ? '0 0 0 2px var(--anthropic-orange)' : undefined,
          opacity: dim ? 0.55 : 1,
          color: o.fell ? 'var(--accent-red)' : 'var(--text-secondary)',
        }}
      >
        {leader ? <Crown size={14} style={{ color: 'var(--accent-purple)' }} /> : <HarnessMark harness={s.harness} size={16} />}
        {dot && (
          <span aria-hidden style={{
            position: 'absolute', right: -2, bottom: -2, width: 10, height: 10, borderRadius: '50%',
            background: dot, border: '2px solid var(--bg-surface)', boxSizing: 'border-box',
          }} />
        )}
      </button>
    )
  }
  const sep = (key: string) => <div key={key} aria-hidden style={{ width: 32, borderTop: '1px dashed var(--border)', flexShrink: 0 }} />
  const card: React.CSSProperties = {
    width: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '5px 0 6px',
    borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-card)', flexShrink: 0,
  }
  const membersCol: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, paddingLeft: 6, marginLeft: 6,
    borderLeft: '1px solid var(--border)',
  }
  const ended_ = (list: readonly ControlSession[], key: string, fell = false) => [
    ...list.slice(0, SECTION_MAX).map(s => mark(s, { fell })),
    ...(list.length > SECTION_MAX ? [<span key={`${key}-more`} style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>+{list.length - SECTION_MAX}</span>] : []),
  ]

  return (
    <nav className="ag-noscroll" aria-label={pt ? 'Sessões' : 'Sessions'} style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
      overflowY: 'auto', overflowX: 'hidden', flex: 1, paddingTop: 4,
    }}>
      {/* The one solid accent control, as in the open aside: it is the only one that CREATES. */}
      {!hideNew && (
        <button
          onClick={() => setCreating(true)}
          aria-label={pt ? 'Nova sessão' : 'New session'}
          title={pt ? 'Nova sessão' : 'New session'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            width: 36, height: 36, borderRadius: 8, cursor: 'pointer',
            border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)', color: '#141414',
          }}
          onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(1.1)' }}
          onMouseLeave={e => { e.currentTarget.style.filter = 'none' }}
        >
          <Plus size={17} />
        </button>
      )}
      <div style={{ width: 44, flexShrink: 0 }}>
        <SegmentedTabs<AsideTab>
          collapsed
          badgeOutside
          ariaLabel={pt ? 'Sessões' : 'Sessions'}
          containerName="aside-tabs"
          className="ag-aside-tabs"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'active', label: pt ? 'Ativas' : 'Active', icon: <List size={15} />, badge: live.length, badgeTone: 'quiet',
              badgeLabel: pt ? `${live.length} ativas` : `${live.length} active` },
            { id: 'groups', label: pt ? 'Grupos' : 'Groups', icon: <Folder size={15} /> },
            { id: 'ended', label: pt ? 'Encerradas' : 'Ended', icon: <Archive size={15} />, badge: fellRows.length, badgeTone: 'alert',
              badgeLabel: pt ? `${fellRows.length} caíram` : `${fellRows.length} fell` },
          ]}
        />
      </div>

      {tab === 'active' && <>
        {teams.map(t => {
          const folded = foldedTeams.includes(t.key) && t.members.length > 0
          const title = sessionDisplayTitle(t.leader.title)
          const team = t.members.length > 0 ? [teamSummary(t.members, pt)] : []
          return (
            <div key={t.key} data-rail-team={t.key} style={card}>
              {mark(t.leader, { lines: team, ...(folded ? { onClick: () => toggleFoldedTeam(t.key) } : {}) })}
              {folded ? (
                <button type="button" data-rail-more onClick={() => toggleFoldedTeam(t.key)}
                  aria-label={pt ? `Mostrar a equipe de ${title}` : `Show ${title}'s team`}
                  style={{
                    border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit',
                    fontSize: 10.5, color: t.members.some(m => isWaitingState(m.state)) ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                  }}>
                  +{t.members.length}
                </button>
              ) : t.members.length > 0 && (
                <div style={membersCol}>
                  {t.members.map(m => mark(m, { lines: [pt ? `equipe de ${title}` : `${title}'s team`] }))}
                </div>
              )}
            </div>
          )
        })}
        {loose.length > 0 && <>{sep('loose')}{loose.map(s => mark(s))}</>}
        {fellRows.length > 0 && (
          <button type="button" onClick={() => setTab('ended')}
            aria-label={pt ? `${fellRows.length} ${fellRows.length === 1 ? 'caiu' : 'caíram'} · ver em Encerradas` : `${fellRows.length} fell · see in Ended`}
            title={pt ? `${fellRows.length} ${fellRows.length === 1 ? 'caiu' : 'caíram'} · ver em Encerradas` : `${fellRows.length} fell · see in Ended`}
            style={{
              marginTop: 'auto', position: 'relative', width: 36, height: 36, flexShrink: 0, borderRadius: 8, cursor: 'pointer',
              border: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--anthropic-orange)', opacity: 0.8,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <RotateCcw size={15} />
          </button>
        )}
      </>}

      {tab === 'groups' && folders.map(f => {
        const open = !collapsedFolders.split('\u0000').includes(f.id)
        const liveRows = f.sections.flatMap(sec => sec.rows).filter(r => ACTIVE.has(r.state))
        return (
          <div key={f.id} data-rail-folder={f.id} style={open ? card : { ...card, borderColor: 'transparent', background: 'transparent' }}>
            <button type="button"
              aria-expanded={open}
              aria-label={`${pt ? 'Pasta' : 'Folder'} ${f.name}, ${liveRows.length} ${pt ? (liveRows.length === 1 ? 'sessão ativa' : 'sessões ativas') : 'active'}`}
              onClick={() => {
                const cur = readAsideGroupPrefs().collapsedUserGroups
                writeAsideGroupPrefs({ collapsedUserGroups: cur.includes(f.id) ? cur.filter(x => x !== f.id) : [...cur, f.id] })
              }}
              {...tipHandlers({ kind: 'folder', folder: f })}
              style={{
                position: 'relative', width: 30, height: 30, borderRadius: 8, padding: 0, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--anthropic-orange)',
              }}>
              <Folder size={15} />
              <span aria-hidden style={{
                position: 'absolute', top: -5, right: -8, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
                fontSize: 10, fontWeight: 600, background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
              }}>{liveRows.length}</span>
            </button>
            {open && liveRows.length > 0 && (
              <div style={membersCol}>{liveRows.map(s => mark(s, { lines: [`${pt ? 'pasta' : 'folder'} ${f.name}`] }))}</div>
            )}
          </div>
        )
      })}

      {tab === 'ended' && <>
        {ended.fell.length > 0 && act && (
          <button type="button" onClick={() => setPicking(true)}
            aria-label={pt ? `Reabrir as ${fellRows.length} que caíram` : `Reopen the ${fellRows.length} that fell`}
            title={pt ? `Reabrir as ${fellRows.length} que caíram` : `Reopen the ${fellRows.length} that fell`}
            style={{
              width: 36, height: 36, flexShrink: 0, borderRadius: 8, cursor: 'pointer',
              border: '1px solid color-mix(in srgb, var(--anthropic-orange) 30%, transparent)',
              background: 'color-mix(in srgb, var(--anthropic-orange) 7%, transparent)', color: 'var(--anthropic-orange)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            <RotateCcw size={15} />
          </button>
        )}
        {ended_(ended.fell, 'fell', true)}
        {ended.fell.length > 0 && (ended.sleeping.length > 0 || ended.today.length > 0) && sep('after-fell')}
        {ended_(ended.sleeping, 'sleeping')}
        {ended.sleeping.length > 0 && ended.today.length > 0 && sep('after-sleeping')}
        {ended_(ended.today, 'today')}
      </>}

      {picking && act && (
        <SessionPickModal
          kind="reopen"
          lang={lang}
          rows={fellRows}
          busy={busy}
          onClose={() => { if (!busy) setPicking(false) }}
          onConfirm={ids => {
            if (!tryBeginDispatch(acting)) return
            setBusy(true)
            void withReopening(ids, () => act({ id: ids[0] ?? '', action: 'reopenFell', ids }))
              .then(() => setPicking(false))
              .finally(() => { endDispatch(acting); setBusy(false) })
          }}
        />
      )}
      {creating && (
        <NewSessionModal
          lang={lang}
          onClose={() => setCreating(false)}
          onStarted={(id, started) => {
            setCreating(false)
            // Same hand-off as the open aside: the row is not in this browser's fleet yet, so the
            // router state says "this id is on its way" instead of letting the page fall back to
            // the overview for a poll.
            if (id) {
              markSessionPending({ id, ...started })
              navigate(sessionPath(id), { state: { creating: started ?? {} } })
            }
          }}
        />
      )}
      {tip && createPortal(
        <div role="tooltip" style={{
          position: 'fixed', top: Math.min(tip.top, window.innerHeight - 140), left: tip.left,
          width: 260, zIndex: 500, pointerEvents: 'none',
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
          padding: '9px 11px', boxShadow: 'var(--ag-shadow-pop)',
        }}>
          {tip.kind === 'session' ? <>
            <SessionFacts session={tip.session} />
            {tip.lines.map(l => <div key={l} style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 4 }}>{l}</div>)}
          </> : <>
            <div style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--text-primary)', marginBottom: 3 }}>{tip.folder.name}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}><RailFolderFacts counts={tip.folder.counts} pt={pt} /></div>
          </>}
        </div>,
        document.body,
      )}
    </nav>
  )
}

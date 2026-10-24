/**
 * SessionLine — one session, on one line: title, then time, then the state dot.
 *
 * The approved list design ("A + C + D", 2026-10-23) draws every session the same way in all three
 * tabs: no harness, model or task line (those stay in the open session's header), and the state is
 * said ONCE — the dot carries the state and the text beside it carries the TIME, never the state
 * word again. The full card (`SessionRow`) remains for the surfaces that still want it.
 *
 * Everything a row could do before is still here: open, right-click / long-press menu with the
 * row's own verbs, pin, reopen, the "go to session" button of the Nay dock, the muted mark and the
 * reopening status. Titles WRAP rather than end in "…" — nothing is hidden behind an ellipsis.
 */

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { BellOff, Crown, MoreVertical, Pin, RotateCcw, SquareArrowOutUpRight } from 'lucide-react'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { STATE_COLOR } from '../../lib/sessionCardStyle'
import { sessionDisplayTitle, hasLeaderTitle } from '../../lib/sessionDisplayTitle'
import { sessionIdentityKey } from '../../lib/sessionIdentity'
import { mutedTooltip, useMutedKeys } from '../../lib/notifyMenu'
import { registerSessionRoleAlias, useSessionRole } from '../../lib/sessionRoles'
import { reopeningLabel, useReopening } from '../../lib/reopeningStore'
import { isLive, isWaitingState } from '../../lib/asideTabs'
import type { RowVerb } from '../../lib/rowMenu'
import { AgentisticsLoader } from '../AgentisticsLoader'
import { IconButton } from '../sessions/RepoSearchView'

/**
 * How a row reaches `onGoToSession` without threading it through every list between the aside and
 * the row. `null` = no button (the workspace itself, where the row click already goes there).
 */
export const GoToSessionContext = createContext<((id: string) => void) | null>(null)

/** The dot a state earns: filled for the two states that mean something is happening, outlined otherwise. */
export function lineDot(state: ControlSession['state'], fell = false): { background: string; border: string } {
  if (fell) return { background: STATE_COLOR.lost, border: 'none' }
  if (state === 'working' || isWaitingState(state)) return { background: STATE_COLOR[state], border: 'none' }
  return { background: 'transparent', border: '1px solid var(--border)' }
}

export interface SessionLineProps {
  session: ControlSession
  selected: boolean
  /** Minimum row height on mobile — 44px, and undefined on desktop. */
  tap?: number
  /** The right-hand time ("4 min", "13:51"). Absent draws nothing. */
  time?: string | null
  /** The machine says this one fell — the dot and the time take the fell colour. */
  fell?: boolean
  /** Bold, slightly taller — the leader line of a team. */
  lead?: boolean
  /** Drawn between the title and the time — the folded leader's "3 na equipe · 1 esperando você". */
  summary?: string
  /** Facts under the title (role chip, project) — the "No leader" rows' own identification. */
  facts?: ReactNode
  /** Something before the open button (the team's fold chevron). */
  leading?: ReactNode
  pinned?: boolean
  onPin?: () => void
  /** What a click on the title does. Absent = the click is `onToggle` (a folded leader only unfolds). */
  onOpen: () => void
  /** Accessible name override for the open button (the folded leader's "Mostrar a equipe de …"). */
  openLabel?: string
  verbs?: RowVerb[]
  onOpenMenu?: (x: number, y: number, verbs: RowVerb[]) => void
  onReopen?: () => void
  reopenVerb?: RowVerb
  lang: 'pt' | 'en'
}

export function SessionLine({
  session, selected, tap, time, fell = false, lead = false, summary, facts, leading, pinned = false, onPin, onOpen, openLabel,
  verbs, onOpenMenu, onReopen, reopenVerb, lang,
}: SessionLineProps) {
  const pt = lang !== 'en'
  const roleKey = sessionIdentityKey(session)
  const storedRole = useSessionRole(roleKey)
  const leader = (storedRole ?? (hasLeaderTitle(session.title) ? 'leader' : undefined)) === 'leader'
  useEffect(() => { registerSessionRoleAlias(session.id, roleKey) }, [session.id, roleKey])
  const muted = useMutedKeys().includes(roleKey)
  const reopening = useReopening().has(session.id)
  const goTo = useContext(GoToSessionContext)
  const waiting = isWaitingState(session.state)
  const dot = lineDot(session.state, fell)
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearLongPress = () => { if (longPress.current !== null) { clearTimeout(longPress.current); longPress.current = null } }
  const canMenu = !!verbs && verbs.length > 0 && !!onOpenMenu
  const title = sessionDisplayTitle(session.title)
  const iconSize = tap ?? 22
  const iconBtn = {
    border: 'none', background: 'transparent', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, width: iconSize, height: iconSize, borderRadius: 6, cursor: 'pointer', color: 'var(--text-tertiary)',
  } as const
  return (
    <div
      data-session-row
      data-session-line
      data-state={session.state}
      aria-current={selected ? 'true' : undefined}
      onContextMenu={e => {
        if (!canMenu) return
        e.preventDefault()
        onOpenMenu!(e.clientX, e.clientY, verbs!)
      }}
      onTouchStart={e => {
        if (!canMenu) return
        const t = e.touches[0]
        if (!t) return
        const x = t.clientX, y = t.clientY
        longPress.current = setTimeout(() => onOpenMenu!(x, y, verbs!), 500)
      }}
      onTouchMove={clearLongPress}
      onTouchEnd={clearLongPress}
      onTouchCancel={clearLongPress}
      style={{
        position: 'relative', display: 'flex', alignItems: 'center', gap: 4, width: '100%', boxSizing: 'border-box', minWidth: 0,
        minHeight: tap ?? (lead ? 34 : 30), padding: '0 4px 0 0', borderRadius: 7,
        background: selected ? 'var(--bg-elevated)' : 'transparent',
        color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
        transition: 'background 0.15s',
      }}
      className="ag-session-line"
    >
      {leading}
      <button
        type="button"
        data-session-open
        onClick={onOpen}
        {...(openLabel ? { 'aria-label': openLabel } : {})}
        title={fell ? `${title} · ${pt ? 'esta sessão caiu' : 'this session fell'}` : title}
        style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8,
          minHeight: tap ?? (lead ? 32 : 28), padding: leading ? '3px 6px 3px 4px' : '3px 6px', borderRadius: 6,
          border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
        }}
      >
        {leader && <Crown size={13} aria-label={pt ? 'líder' : 'leader'} style={{ flexShrink: 0, color: 'var(--accent-purple)' }} />}
        {/* Title and the folded team's summary share one wrapping box: the summary drops under the
            name when the line is short, instead of crushing the name to a letter per line. */}
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 1 }}>
          <span style={{
            flex: '0 1 auto', minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.35,
            fontSize: 13, fontWeight: lead || waiting ? 600 : 500,
            color: fell ? STATE_COLOR.lost : undefined,
          }}>
            {title}
          </span>
          {summary && (
            <span data-team-summary style={{ flexBasis: '100%', minWidth: 0, fontSize: 11, lineHeight: 1.35, color: 'var(--text-tertiary)', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{summary}</span>
          )}
          {facts && (
            <span data-session-facts style={{ flexBasis: '100%', minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 2, fontSize: 11, lineHeight: 1.35, color: 'var(--text-tertiary)' }}>{facts}</span>
          )}
        </span>
        {/* Muted sits with the title, not in the trailing columns, so time and dot keep their x. */}
        {muted && (
          <span role="img" aria-label={mutedTooltip(pt)} title={mutedTooltip(pt)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 14, color: 'var(--text-tertiary)' }}>
            <BellOff size={12} />
          </span>
        )}
        {reopening && (
          <span role="status" style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: 11, color: 'var(--anthropic-orange)' }}>
            <AgentisticsLoader size={12} label={reopeningLabel(pt)} />
            {reopeningLabel(pt)}
          </span>
        )}
        {time && (
          <span data-line-time style={{
            flexShrink: 0, fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
            color: waiting && isLive(session.state) ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          }}>{time}</span>
        )}
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, boxSizing: 'border-box', ...dot }} />
      </button>
      {onReopen && reopenVerb && (
        <IconButton
          label={!reopenVerb.enabled && reopenVerb.reason ? reopenVerb.reason : (pt ? 'Reabrir' : 'Reopen')}
          size={iconSize}
          disabled={!reopenVerb.enabled || reopening} color="var(--anthropic-orange)"
          onClick={e => { e.stopPropagation(); if (reopenVerb.enabled && !reopening) onReopen() }}
        >
          <RotateCcw size={13} />
        </IconButton>
      )}
      {goTo && (
        <button type="button"
          aria-label={pt ? 'Ir para a sessão' : 'Go to session'}
          title={pt ? 'Abrir esta sessão na tela de Sessões' : 'Open this session in the Sessions workspace'}
          onClick={e => { e.stopPropagation(); goTo(session.id) }}
          style={iconBtn}
        >
          <SquareArrowOutUpRight size={13} />
        </button>
      )}
      {/*
        * THE TRAILING COLUMNS ARE ONE GRID: time, dot, then (on a phone) the ⋮ slot, then the pin slot —
        * reserved on EVERY row, empty where the row has nothing to put there, so leaders, members,
        * loose rows and folder rows line up column for column.
        */}
      {tap && (canMenu ? (
        <button type="button"
          aria-label={pt ? `Opções de ${title}` : `Options for ${title}`}
          aria-haspopup="menu"
          onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onOpenMenu!(r.left, r.bottom, verbs!) }}
          style={iconBtn}
        >
          <MoreVertical size={13} />
        </button>
      ) : <span aria-hidden data-slot="menu" style={{ width: iconSize, flexShrink: 0 }} />)}
      {/* The pin: a leader shows it faint until set (prototype); any other row shows it when pinned,
          and on desktop on hover/focus. On a phone a non-leader pins from its ⋮ menu instead. */}
      {onPin && (lead || pinned || !tap) ? (
        <button type="button"
          aria-pressed={pinned}
          aria-label={pinned ? (pt ? 'Desafixar' : 'Unpin') : (pt ? 'Fixar no topo' : 'Pin to the top')}
          title={pinned ? (pt ? 'Fixada no topo' : 'Pinned to the top') : (pt ? 'Fixar no topo' : 'Pin to the top')}
          onClick={e => { e.stopPropagation(); onPin() }}
          className={lead || pinned || tap ? undefined : 'ag-row-pin'}
          style={{
            ...iconBtn,
            color: pinned ? 'var(--text-primary)' : 'var(--text-tertiary)',
            opacity: pinned ? 1 : lead ? 0.45 : tap ? 1 : 0, transition: 'opacity 0.15s',
          }}
        >
          <Pin size={12} fill={pinned ? 'currentColor' : 'none'} />
        </button>
      ) : <span aria-hidden data-slot="pin" style={{ width: iconSize, flexShrink: 0 }} />}
    </div>
  )
}

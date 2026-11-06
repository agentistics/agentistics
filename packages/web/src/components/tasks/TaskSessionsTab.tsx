/**
 * TaskSessionsTab — the task's sessions, drawn so that a hundred of them stay readable (owner,
 * 2026-11-05: the long list at the foot of the detail was unusable with many sessions).
 *
 *  - `LeaderCards` sit at the TOP of the task: only a leader is filed on the task itself, so these
 *    are the sessions that lead it (compact, always visible, alive ones first).
 *  - `TaskSessionsTab` is the full view: filter Alive (default) / Ended / All, a search box, and the
 *    rows grouped by subtask — plus "Leaders" and a "No subtask" group for LEGACY workers that were
 *    filed straight on the task before the leaders-only rule (never hidden, never deleted).
 *
 * The grouping, counting and filtering is the pure `sessionsPlan.ts`; this file only draws it.
 */

import { useState } from 'react'
import { ExternalLink, Search, Star } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SESSION_STATE, fmtTokens, harnessColor, microLabel, numeric, surface } from './board'
import { useMoney } from './money'
import { StateDot } from './StateDot'
import { orderRows, planGroups, summarize, type PlanRow, type SessionsFilter } from './sessionsPlan'
import { sessionsCopy } from './sessionsCopy'
import { usePlanRows } from './useSessionStates'
import { sessionPath } from '../../lib/sessionRoute'
import type { Lang } from './copy'
import type { TaskDetail } from '../../lib/tasks'

const stateWord = (r: PlanRow, lang: Lang): string => {
  const sc = sessionsCopy(lang)
  if (r.state) return sc.state[r.state] ?? r.state
  if (r.row.historical) return sc.historical
  return r.row.endedAt ? sc.finished : sc.notInFleet
}

/** At most this many leader cards are drawn open: a task handed from leader to leader through many
 *  sessions keeps every old leader, and a wall of finished cards pushes the work off the screen. */
const LEADER_CARDS_OPEN = 6
/** Rows a group draws before "show more" — a group of ninety must not be the page. */
const GROUP_ROWS_OPEN = 15

function LeaderCard({ r, lang }: { r: PlanRow; lang: Lang }) {
  const sc = sessionsCopy(lang)
  const money = useMoney()
  const st = r.state ? SESSION_STATE[r.state] : undefined
  return (
    <a
      href={r.row.historical ? undefined : sessionPath(r.row.id)}
      className="ag-tap"
      style={{
        ...surface, padding: '9px 11px', display: 'grid', gap: 3, textDecoration: 'none', minWidth: 0,
        borderColor: r.alive ? 'color-mix(in srgb, var(--anthropic-orange) 40%, var(--border))' : undefined,
        opacity: r.alive ? 1 : 0.7,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <StateDot r={r} withHarness />
        <Star size={11} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
        <span style={{ ...microLabel, color: 'var(--anthropic-orange)' }}>{sc.leader}</span>
        <span style={{ fontSize: 11.5, color: st?.color ?? 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{stateWord(r, lang)}</span>
      </span>
      <span style={{ fontSize: 12.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {r.row.label?.trim() || r.row.id.slice(0, 8)}
      </span>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {[r.row.harness, r.row.model, fmtTokens(r.row.tokens) + ' tok', money(r.row.costUSD, r.row.costUSD === null ? null : { [r.row.harness]: r.row.costUSD })].filter(Boolean).join(' · ')}
      </span>
    </a>
  )
}

export function LeaderCards({ detail, lang }: { detail: TaskDetail; lang: Lang }) {
  const sc = sessionsCopy(lang)
  const [more, setMore] = useState(false)
  const leaders = orderRows(usePlanRows(detail.sessions).filter(r => r.leader && r.row.subtaskId === null))
  if (leaders.length === 0) return null
  const alive = leaders.filter(r => r.alive)
  // Alive leaders lead; with none alive, the newest finished one still says who led this.
  const open = (alive.length > 0 ? alive : leaders).slice(0, alive.length > 0 ? LEADER_CARDS_OPEN : 1)
  const hidden = leaders.filter(r => !open.includes(r))
  const grid: React.CSSProperties = { display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={grid}>{open.map(r => <LeaderCard key={r.row.id} r={r} lang={lang} />)}</div>
      {hidden.length > 0 && (
        <>
          <button
            onClick={() => setMore(v => !v)}
            style={{ justifySelf: 'start', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, color: 'var(--anthropic-orange)', padding: '4px 0', minHeight: 32 }}
          >{more ? sc.hideEnded : sc.seeEnded(hidden.length, null)}</button>
          {more && <div style={{ ...grid, maxHeight: 260, overflowY: 'auto' }}>{hidden.map(r => <LeaderCard key={r.row.id} r={r} lang={lang} />)}</div>}
        </>
      )}
    </div>
  )
}

function SessionLine({ r, lang, mobile }: { r: PlanRow; lang: Lang; mobile: boolean }) {
  const sc = sessionsCopy(lang)
  const money = useMoney()
  const st = r.state ? SESSION_STATE[r.state] : undefined
  const cost = money(r.row.costUSD, r.row.costUSD === null ? null : { [r.row.harness]: r.row.costUSD })
  const open = r.row.historical
    ? <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{sc.noSession}</span>
    : (
      <a href={sessionPath(r.row.id)} className="ag-tap" style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--anthropic-orange)',
        textDecoration: 'none', whiteSpace: 'nowrap', minHeight: mobile ? 44 : undefined,
      }}>{sc.open} <ExternalLink size={12} /></a>
    )
  const title = r.row.label?.trim() || r.row.id.slice(0, 8)
  if (mobile) {
    return (
      <div style={{ padding: '9px 12px', borderTop: '1px solid var(--border)', display: 'grid', gap: 3 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <StateDot r={r} withHarness />
          <span style={{ fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{title}</span>
          {open}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: st?.color }}>{stateWord(r, lang)}</span>
          <span>{[r.row.model, fmtTokens(r.row.tokens) + ' tok', cost].filter(Boolean).join(' · ')}</span>
        </span>
      </div>
    )
  }
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '54px minmax(0,1fr) 110px 150px 80px 80px 70px', gap: 10,
      alignItems: 'center', padding: '7px 12px', borderTop: '1px solid var(--border)', fontSize: 12.5,
    }}>
      <StateDot r={r} withHarness />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }} title={r.row.id}>{title}</span>
      <span style={{ color: st?.color ?? 'var(--text-tertiary)', fontSize: 12 }}>{stateWord(r, lang)}</span>
      <span style={{ color: harnessColor(r.row.harness), fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.row.model ?? r.row.harness}</span>
      <span style={{ ...numeric, textAlign: 'right' }}>{fmtTokens(r.row.tokens)}</span>
      <span style={{ ...numeric, textAlign: 'right' }}>{cost}</span>
      {open}
    </div>
  )
}

export function TaskSessionsTab({ detail, lang }: { detail: TaskDetail; lang: Lang }) {
  const sc = sessionsCopy(lang)
  const isMobile = useIsMobile()
  const money = useMoney()
  const rows = usePlanRows(detail.sessions)
  const [filter, setFilter] = useState<SessionsFilter>('alive')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const total = summarize(rows)
  const groups = planGroups({
    rows,
    subtasks: detail.subtasks.map(s => ({ id: s.id, title: s.title })),
    filter, query, titles: { leaders: sc.leaders, none: sc.noSubtask },
  })
  if (rows.length === 0) {
    return <div style={{ ...surface, padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)' }}>{sc.noneFiled}</div>
  }
  const tabs: Array<[SessionsFilter, string, number]> = [
    ['alive', sc.alive, total.alive], ['ended', sc.ended, total.ended], ['all', sc.all, rows.length],
  ]
  return (
    <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div role="tablist" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          {tabs.map(([key, label, n]) => (
            <button
              key={key} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}
              style={{
                border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, padding: '0 12px',
                height: isMobile ? 44 : 30, background: filter === key ? 'var(--ag-tint-3)' : 'transparent',
                color: filter === key ? 'var(--text-primary)' : 'var(--text-tertiary)', fontWeight: filter === key ? 600 : 500,
              }}
            >{label} <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>{n}</span></button>
          ))}
        </div>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 180px', minWidth: 0, border: '1px solid var(--border)',
          borderRadius: 8, padding: '0 10px', height: isMobile ? 44 : 30, background: 'var(--bg-card)',
        }}>
          <Search size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          <input
            value={query} onChange={e => setQuery(e.target.value)} placeholder={sc.search}
            style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 16 }}
          />
        </label>
      </div>

      {groups.length === 0 && (
        <div style={{ ...surface, padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)' }}>{sc.noneMatch}</div>
      )}
      {groups.map(g => (
        <div key={g.key} style={{ ...surface, overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', background: 'var(--ag-tint-3)' }}>
            <span style={{ ...microLabel, color: g.kind === 'leaders' ? 'var(--anthropic-orange)' : undefined }}>
              {g.kind === 'leaders' && '★ '}{g.title}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {sc.aliveShort(g.summary.alive)} · {sc.endedShort(g.summary.ended)}
              {g.summary.costUSD !== null && ` · ${money(g.summary.costUSD, null)}`}
            </span>
          </div>
          {g.kind === 'none' && (
            <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-tertiary)' }}>{sc.legacyHint}</div>
          )}
          {(expanded.has(g.key) || query.trim() ? g.rows : g.rows.slice(0, GROUP_ROWS_OPEN)).map(r => <SessionLine key={r.row.id} r={r} lang={lang} mobile={isMobile} />)}
          {!expanded.has(g.key) && !query.trim() && g.rows.length > GROUP_ROWS_OPEN && (
            <button
              onClick={() => setExpanded(prev => new Set(prev).add(g.key))}
              style={{ width: '100%', background: 'none', border: 'none', borderTop: '1px solid var(--border)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: 'var(--anthropic-orange)', padding: '10px 12px', minHeight: isMobile ? 44 : 34, textAlign: 'left' }}
            >{sc.showMore(g.rows.length - GROUP_ROWS_OPEN)}</button>
          )}
        </div>
      ))}
    </div>
  )
}

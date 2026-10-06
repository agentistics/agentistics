/**
 * CentralTaskBoard — the deliveries the machines of this central chose to share.
 *
 * Grouped BY MACHINE by default, with a switch to see them all at once — the shape the members
 * panel already uses, and the right one here: a board belongs to the person whose machine runs it,
 * and a central is many people. **A machine that shares nothing is shown and EMPTY**: "this machine
 * has no deliveries" and "this machine shares none of them" are different facts, and a machine that
 * simply vanished from the list would read as the first while being the second.
 *
 * It is READ-ONLY and has no verbs at all. The board lives on the machine that owns it; a status
 * changed here would have nowhere to land.
 *
 * Every row states its own shortfall. A delivery whose sessions this machine withholds is measured
 * short, and the two reasons are kept apart in words: a rule somebody set (`sessionsWithheld`) and
 * a session that has not arrived (`sessionsMissing`). A figure that shrank with nothing on screen
 * explaining why is the same defect as a confident zero.
 */

import { Fragment, useMemo, useState, type CSSProperties } from 'react'
import { Laptop, Layers, Rows3 } from 'lucide-react'
import {
  cycleSort, fmtCost, sortRowsBy, type SortKey, type SortSpec, type SortableRow,
} from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import type { CentralTaskMachine, CentralTaskRow } from '../../lib/tasks'
import {
  NA, button, fmtInt, fmtTokens, liveStatusOrder, microLabel, numeric, pill, statusStyle, surface,
} from './board'
import { SortTh } from './SortHeader'
import { SortControl } from './SortControl'
import { boardCopy } from './copy'
import { TaskProgressBar } from './TaskProgressBar'
import { HarnessBadges } from './HarnessBadges'

export interface CentralTaskBoardProps {
  machines: CentralTaskMachine[]
  lang: 'pt' | 'en'
  currency: 'USD' | 'BRL'
  brlRate: number
}

/**
 * A central has no filesystem access to a member's board, so it never sees that machine's LIVE
 * status list (`TaskStatusDef[]`) — only the bare status id each shared `CentralTaskRow` carries.
 * `statusStyle(null, status)` resolves it against the fixed legacy vocabulary and, for anything
 * that machine created beyond it, renders the bare id in a neutral colour rather than mislabelling
 * it as some other status — the same honest-fallback rule every other reader of a live list follows
 * when that list cannot be had at all.
 */
function StatusPill({ status }: { status: string }) {
  const s = statusStyle(null, status)
  return <span style={{ ...pill(s.color), background: s.dim }}>{s.label}</span>
}

/**
 * The Sessions column prints `sessionsLinked` — what this central actually holds — so that is what
 * it is ordered by (see `RepoTasksTab`'s `asSortable`, the same reasoning).
 */
const asSortable = (r: CentralTaskRow): SortableRow => ({
  ...r, rollup: { ...r.rollup, sessionsUsed: r.rollup.sessionsLinked },
})

/**
 * A central has no live status list to order by (see `StatusPill`), so a status sort follows the
 * fixed legacy pipeline; a status only that machine defined sorts after every known one.
 */
const STATUS_ORDER = liveStatusOrder(null)

const SORT_OPTIONS = (pt: boolean): Array<{ key: SortKey; label: string }> => [
  { key: 'title', label: pt ? 'Tarefa' : 'Task' },
  { key: 'status', label: 'Status' },
  { key: 'progress', label: pt ? 'Progresso' : 'Progress' },
  { key: 'sessions', label: pt ? 'Sessões' : 'Sessions' },
  { key: 'rounds', label: pt ? 'Seus prompts' : 'Your prompts' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'cost', label: pt ? 'Custo' : 'Cost' },
  { key: 'harnesses', label: 'Harnesses' },
]

/** What this central cannot see of a delivery, in words — never a silently smaller number. */
function shortfall(row: CentralTaskRow, pt: boolean): string | null {
  const parts: string[] = []
  if (row.sessionsWithheld > 0) {
    parts.push(pt
      ? `${row.sessionsWithheld} sessão${row.sessionsWithheld === 1 ? '' : 'es'} que esta máquina não compartilha`
      : `${row.sessionsWithheld} session${row.sessionsWithheld === 1 ? '' : 's'} this machine does not share`)
  }
  if (row.sessionsMissing > 0) {
    parts.push(pt
      ? `${row.sessionsMissing} que ainda não chegou${row.sessionsMissing === 1 ? '' : 'ram'} aqui`
      : `${row.sessionsMissing} that ${row.sessionsMissing === 1 ? 'has' : 'have'} not arrived here`)
  }
  if (parts.length === 0) return null
  return pt
    ? `Medida a menos: ${parts.join(' e ')}.`
    : `Measured short: ${parts.join(' and ')}.`
}

export function CentralTaskBoard(p: CentralTaskBoardProps) {
  const isMobile = useIsMobile()
  const pt = p.lang === 'pt'
  const [flat, setFlat] = useState(false)
  // One order for the whole board, machines and the flat list alike. `null` = the order the rows
  // arrive in (most recently touched first in the flat list) and the way back from any header.
  const [sort, setSort] = useState<SortSpec | null>(null)
  const L = boardCopy(p.lang).list
  const order = (rows: CentralTaskRow[]) =>
    sort ? sortRowsBy(rows, sort, asSortable, { statusOrder: STATUS_ORDER }) : rows
  const cost = (n: number | null) => (n === null ? NA : fmtCost(n, p.currency, p.brlRate))

  const all = useMemo(
    () => p.machines.flatMap(m => m.rows).sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt)),
    [p.machines],
  )
  const total = all.length

  const seg = (active: boolean): CSSProperties => ({
    ...button(isMobile),
    height: isMobile ? 44 : 30,
    border: 'none',
    background: active ? 'var(--bg-elevated)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
  })

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          {pt
            ? `${total} tarefa${total === 1 ? '' : 's'} compartilhada${total === 1 ? '' : 's'} por ${p.machines.length} máquina${p.machines.length === 1 ? '' : 's'}`
            : `${total} shared task${total === 1 ? '' : 's'} across ${p.machines.length} machine${p.machines.length === 1 ? '' : 's'}`}
        </span>
        <div style={{ ...surface, display: 'flex', padding: 3, gap: 2, marginLeft: 'auto' }}>
          <button style={seg(!flat)} onClick={() => setFlat(false)}>
            <Layers size={14} /> {pt ? 'Por máquina' : 'By machine'}
          </button>
          <button style={seg(flat)} onClick={() => setFlat(true)}>
            <Rows3 size={14} /> {pt ? 'Ver tudo' : 'See all'}
          </button>
        </div>
      </div>

      {isMobile && (
        // A phone has no column titles to press; the same order is one control, above every list.
        <SortControl
          label={L.sortBy}
          options={SORT_OPTIONS(pt)}
          current={sort}
          onPick={k => setSort(k === null ? null : { key: k, dir: 'asc' })}
          onDir={() => setSort(cur => cur && { key: cur.key, dir: cur.dir === 'asc' ? 'desc' : 'asc' })}
          defaultLabel={L.sortDefault} ascLabel={L.sortAsc} descLabel={L.sortDesc}
          mobile
        />
      )}

      {flat
        ? <RowList rows={order(all)} showMachine lang={p.lang} cost={cost} isMobile={isMobile} sort={sort} onSort={setSort} />
        : p.machines.map(m => (
          <section key={m.memberId} style={{ display: 'grid', gap: 8 }}>
            <h2 style={{
              margin: 0, fontSize: 13, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 7,
              color: 'var(--text-primary)',
            }}>
              <Laptop size={14} style={{ color: 'var(--text-tertiary)' }} /> {m.user}
              <span style={{ ...microLabel, fontSize: 10 }}>{m.rows.length}</span>
            </h2>
            {m.rows.length === 0
              // Present and empty, deliberately: this machine shares none of its deliveries, which
              // is not the same as having none.
              ? (
                <div style={{ ...surface, padding: 12, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                  {pt
                    ? 'Esta máquina não compartilha nenhuma tarefa com esta central.'
                    : 'This machine shares no task with this central.'}
                </div>
              )
              : <RowList rows={order(m.rows)} lang={p.lang} cost={cost} isMobile={isMobile} sort={sort} onSort={setSort} />}
          </section>
        ))}
    </div>
  )
}

function RowList({ rows, showMachine, lang, cost, isMobile, sort, onSort }: {
  rows: CentralTaskRow[]
  showMachine?: boolean
  lang: 'pt' | 'en'
  cost: (n: number | null) => string
  isMobile: boolean
  sort: SortSpec | null
  onSort: (next: SortSpec | null) => void
}) {
  const pt = lang === 'pt'
  const L = boardCopy(lang).list
  const columns: Array<{ key: SortKey; label: string; numeric?: boolean }> = [
    { key: 'title', label: pt ? 'Tarefa' : 'Task' },
    { key: 'status', label: 'Status' },
    { key: 'progress', label: pt ? 'Progresso' : 'Progress' },
    { key: 'sessions', label: pt ? 'Sessões' : 'Sessions', numeric: true },
    { key: 'rounds', label: pt ? 'Seus prompts' : 'Your prompts', numeric: true },
    { key: 'tokens', label: 'Tokens', numeric: true },
    { key: 'cost', label: pt ? 'Custo' : 'Cost', numeric: true },
    { key: 'harnesses', label: 'Harnesses' },
  ]

  // Cards on a phone, a table on a desktop — the same rows either way.
  if (isMobile) {
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map(r => {
          const note = shortfall(r, pt)
          return (
            <div key={`${r.memberId}:${r.task.id}`} style={{ ...surface, padding: 12, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <StatusPill status={r.task.status} />
                {showMachine && <span style={{ ...microLabel, fontSize: 10 }}>{r.user}</span>}
              </div>
              <span style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{r.task.title}</span>
              {r.counts.subtasks > 0 && (
                <TaskProgressBar done={r.counts.subtasksDone} inProgress={r.subtasks.filter(s => !s.done && s.status === 'in_progress').length} total={r.counts.subtasks} />
              )}
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', ...numeric, fontSize: 11.5 }}>
                <span>{fmtInt(r.rollup.sessionsLinked)} <span style={microLabel}>{pt ? 'sessões' : 'sessions'}</span></span>
                <span>{fmtInt(r.rollup.rounds)} <span style={microLabel}>{pt ? 'seus prompts' : 'your prompts'}</span></span>
                <span>{fmtTokens(r.rollup.tokens)} <span style={microLabel}>tokens</span></span>
                <span style={{ color: 'var(--anthropic-orange)' }}>{cost(r.rollup.costUSD)}</span>
              </div>
              {note && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{note}</span>}
            </div>
          )
        })}
      </div>
    )
  }

  const th: CSSProperties = {
    ...microLabel, textAlign: 'left', padding: '7px 10px', fontWeight: 600,
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  }
  const td: CSSProperties = {
    padding: '8px 10px', fontSize: 12.5, borderBottom: '1px solid var(--border)', verticalAlign: 'middle',
  }
  const tdNum: CSSProperties = { ...td, ...numeric, textAlign: 'right' }

  return (
    <div style={{ ...surface, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: showMachine ? 860 : 760 }}>
        <thead>
          <tr>
            {columns.map(c => (
              <Fragment key={c.key}>
                <SortTh
                  label={c.label} sortKey={c.key} current={sort} mobile={false}
                  onSort={k => onSort(cycleSort(sort, k))}
                  title={L.sortByColumn.replace('{column}', c.label)}
                  style={{ ...th, textAlign: c.numeric ? 'right' : 'left' }}
                />
                {/* The machine is a column of its own only in the flat list. It is not a sort key
                    (`SortKey` orders tasks, and a machine is where one lives), so it is plain. */}
                {c.key === 'title' && showMachine && <th style={th}>{pt ? 'Máquina' : 'Machine'}</th>}
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const note = shortfall(r, pt)
            return (
              <tr key={`${r.memberId}:${r.task.id}`}>
                <td style={{ ...td, maxWidth: 340 }}>
                  <div style={{ display: 'grid', gap: 3 }}>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.task.title}</span>
                    {note && <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{note}</span>}
                  </div>
                </td>
                {showMachine && <td style={{ ...td, color: 'var(--text-secondary)' }}>{r.user}</td>}
                <td style={td}><StatusPill status={r.task.status} /></td>
                <td style={{ ...td, minWidth: 120 }}>
                  {r.counts.subtasks > 0
                    ? <TaskProgressBar done={r.counts.subtasksDone} inProgress={r.subtasks.filter(s => !s.done && s.status === 'in_progress').length} total={r.counts.subtasks} />
                    : <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>—</span>}
                </td>
                {/* `sessionsLinked`: what this central actually holds. `sessionsUsed` would count a
                    session it cannot see, which is what the shortfall sentence is for. */}
                <td style={tdNum}>{fmtInt(r.rollup.sessionsLinked)}</td>
                <td style={tdNum}>{fmtInt(r.rollup.rounds)}</td>
                <td style={tdNum}>{fmtTokens(r.rollup.tokens)}</td>
                <td style={{ ...tdNum, color: 'var(--anthropic-orange)' }}>{cost(r.rollup.costUSD)}</td>
                <td style={td}><HarnessBadges harnesses={r.harnesses} fontSize={10} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

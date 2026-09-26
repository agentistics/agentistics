/**
 * TaskBoard — the two ways to look at the deliveries: a BOARD and a TABLE.
 *
 * Board is the default because the first question is "what is in flight", which is a shape, not a
 * list. Table is there because the second question is "which config was cheapest", which is a
 * comparison, and comparisons want columns.
 *
 * Neither computes anything: every figure arrives already decided from `/api/tasks`.
 */

import { useEffect, useMemo, useState } from 'react'
import { Activity, Bot, CalendarClock, CircleCheck, ListChecks, MessageSquare, Paperclip, Terminal } from 'lucide-react'
import { canReorderBy, DEFAULT_SORT, sortRows, type SortSpec, type TaskStatusDef } from '@agentistics/core'
import {
  PRIORITY, cardStyle, claimLeft, fmtInt, fmtTokens, liveStatusOrder, microLabel,
  numeric, pill, statusStyle, surface, type BoardStatus,
} from './board'
import type { LaneKey } from './boardPrefs'
import { TaskProgressBar } from './TaskProgressBar'
import { HarnessBadges } from './HarnessBadges'
import { boardCopy, statusLabel } from './copy'
import { BOARD_SORT_KEYS } from './BoardArrange'
import { ColumnSortMenu } from './ColumnSortMenu'
import {
  clearColumnSort, effectiveSort, hasOverride, pickColumnSort, withColumnSort, type ColumnSorts,
} from './columnSort'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useMoney } from './money'
import type { TaskListRow } from '../../lib/tasks'

function Facts({ row }: { row: TaskListRow }) {
  const fmt = useMoney()
  const r = row.rollup
  const money = r.mixedCurrency || (r.credits !== null && r.costUSD === null)
    ? `${r.credits!.premiumRequests} req`
    : fmt(r.costUSD, r.costByHarness)
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
      <span style={{ minWidth: 0 }}>
        <span style={{ ...microLabel, display: 'block' }}>Cost</span>
        <span style={{ ...numeric, display: 'block', color: r.costUSD === null && r.credits === null ? 'var(--text-tertiary)' : 'var(--anthropic-orange)' }}>
          {money}
        </span>
      </span>
      <span title="How many times you prompted, across every session filed here">
        <span style={{ ...microLabel, display: 'block' }}>Your prompts</span>
        <span style={{ ...numeric, display: 'block' }}>{fmtInt(r.rounds)}</span>
      </span>
      <span>
        <span style={{ ...microLabel, display: 'block' }}>Sessions</span>
        <span style={{ ...numeric, display: 'block' }}>{r.sessionsUsed}</span>
      </span>
      <span>
        <span style={{ ...microLabel, display: 'block' }}>Tokens</span>
        <span style={{ ...numeric, display: 'block' }}>{fmtTokens(r.tokens)}</span>
      </span>
    </div>
  )
}

function Card({ row, onOpen, live, nowMs, statuses }: {
  row: TaskListRow
  onOpen: () => void
  live: readonly { id: string; state: string; harness: string; title: string }[]
  nowMs: number
  statuses: readonly TaskStatusDef[] | null
}) {
  const s = statusStyle(statuses, row.task.status)
  const counts = row.counts
  const priority = row.task.priority && row.task.priority !== 'none'
    ? PRIORITY[row.task.priority]
    : undefined
  const dueMs = row.task.dueDate ? Date.parse(`${row.task.dueDate}T23:59:59`) : NaN
  const closed = row.task.status === 'done' || row.task.status === 'abandoned'
  const late = !closed && Number.isFinite(dueMs) && dueMs < nowMs
  return (
    <button
      onClick={onOpen}
      style={{ ...cardStyle, position: 'relative', overflow: 'hidden' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-card-hover)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-card)' }}
    >
      {/* The status stripe: the same colour the column header and the table cell use. */}
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: s.color }} />
      <div style={{ paddingLeft: 6, display: 'grid', gap: 8 }}>
        {(priority || row.task.dueDate) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {priority && (
              <span style={{
                padding: '1px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                background: priority.dim, color: priority.color,
                border: `1px solid ${priority.color}`,
              }}>{priority.label}</span>
            )}
            {row.task.dueDate && (
              <span
                style={{
                  ...microLabel, textTransform: 'none', letterSpacing: 0, fontSize: 10.5,
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  color: late ? 'var(--accent-red)' : 'var(--text-tertiary)',
                  fontWeight: late ? 700 : 400,
                }}
                title={late ? 'past its due date' : 'due'}
              ><CalendarClock size={10} /> {row.task.dueDate}</span>
            )}
          </div>
        )}
        <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{row.task.title}</div>
        {row.task.detail && (
          <div style={{
            fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.45,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{row.task.detail}</div>
        )}

        {counts && <TaskProgressBar done={counts.subtasksDone} total={counts.subtasks} />}

        <Agents row={row} live={live} nowMs={nowMs} />

        <Facts row={row} />

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {row.harnesses.length > 0 && <HarnessBadges harnesses={row.harnesses} max={3} />}
          {row.attempts > 0 && (
            <span style={pill()}>{row.attempts} attempt{row.attempts === 1 ? '' : 's'}</span>
          )}
          <span style={{ flex: 1 }} />
          {counts && counts.comments > 0 && (
            <span style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <MessageSquare size={11} /> {counts.comments}
            </span>
          )}
          {counts && counts.files > 0 && (
            <span style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Paperclip size={11} /> {counts.files}
            </span>
          )}
          {row.rollup.sessionsUsed > 0 && (
            <span style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Terminal size={11} /> {row.rollup.sessionsUsed}
            </span>
          )}
        </div>

        {/* The one caveat that must never be implied by a missing number. */}
        {row.rollup.sessionsLinked < row.rollup.sessionsUsed && (
          <div style={{ ...microLabel, textTransform: 'none', fontSize: 10.5, letterSpacing: 0 }}>
            cost covers {row.rollup.sessionsLinked} of {row.rollup.sessionsUsed} sessions
          </div>
        )}
      </div>
    </button>
  )
}

/** A session counts as "on" while it could still be doing something — the same set
 *  `SessionPicker`/`TaskComposer`/`BlockedSubtaskResolve` already use for "this session is live". */
const ACTIVE_SESSION_STATES = new Set(['working', 'waiting', 'waiting-approval'])

/**
 * Who is ON this card right now, and how it is progressing — as COUNTS, never a pill per session.
 *
 * A card used to grow a pill for every session the task had EVER had filed under it — a delivery
 * with 42 historical sessions rendered 42 pills, most of them `finished`/`lost` from weeks ago. The
 * only things worth a glance here are: is somebody claiming it, how many subtasks does it have, how
 * many sessions are actually live right now, and how many subtasks are already done (which, by the
 * server's own `done_needs_session` rule, can only be true once a session was linked to them). A
 * CLAIM is still drawn as its own pill — it is a statement somebody made ("this is mine until
 * 14:20"), one fact and one pill, unlike the live fleet which is a count.
 */
function Agents({ row, live, nowMs }: {
  row: TaskListRow
  live: readonly { id: string; state: string; harness: string; title: string }[]
  nowMs: number
}) {
  const claim = row.task.claim
  const lease = claim ? claimLeft(claim.expiresAt, nowMs) : null
  const counts = row.counts
  const sessionsOn = live.filter(s => ACTIVE_SESSION_STATES.has(s.state)).length
  const hasSubtasks = counts && counts.subtasks > 0
  const hasDone = counts && counts.subtasksDone > 0
  if (!claim && !hasSubtasks && sessionsOn === 0 && !hasDone) return null
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      {claim && (
        <span
          style={pill(lease!.expired ? 'var(--text-tertiary)' : 'var(--accent-green)')}
          title={lease!.expired
            ? `${claim.by} claimed this, and the lease has run out — it is available again`
            : `${claim.by} is on it · ${lease!.text}`}
        >
          <Bot size={10} /> {claim.by}{lease!.expired ? ' · lapsed' : ''}
        </span>
      )}
      {hasSubtasks && (
        <span
          style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 3 }}
          title={`${counts.subtasks} subtask${counts.subtasks === 1 ? '' : 's'}`}
        >
          <ListChecks size={11} /> {counts.subtasks}
        </span>
      )}
      {sessionsOn > 0 && (
        <span
          style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--anthropic-orange)' }}
          title={`${sessionsOn} session${sessionsOn === 1 ? '' : 's'} live right now`}
        >
          <Activity size={11} /> {sessionsOn}
        </span>
      )}
      {hasDone && (
        <span
          style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--accent-green)' }}
          title={`${counts.subtasksDone} subtask${counts.subtasksDone === 1 ? '' : 's'} done, with a session linked`}
        >
          <CircleCheck size={11} /> {counts.subtasksDone}
        </span>
      )}
    </div>
  )
}

export interface BoardViewProps {
  rows: TaskListRow[]
  /** The reader's language. Absent = English, for a caller not yet threaded. */
  lang?: 'pt' | 'en'
  onOpen: (id: string) => void
  /** A drop into another column. It is a STATUS change, and only the server writes it. */
  onStatus?: (id: string, status: BoardStatus) => void
  /** A drop within a column — the hand-arranged order. */
  onMove?: (id: string, index: number) => void
  /** The live fleet, so a card can say which session is on it. Matched by task NAME, which is what
   *  `/api/fleet` carries; a row filed under no task simply never matches. */
  sessions?: readonly { id: string; state: string; harness: string; title: string; task?: string }[]
  /** The board's own order — the default for every column nobody has sorted by its title. */
  sort: SortSpec
  /** A column's OWN order, set by clicking its title (`ColumnSortMenu`), by status id. */
  columnSort: ColumnSorts
  onColumnSort: (next: ColumnSorts) => void
  lanes: LaneKey
  /** Per-status card limits. A column over its limit SAYS so; nothing is ever blocked. */
  wip: Record<string, number>
  /** Which columns to draw, in order. Absent = the whole pipeline. */
  columns?: readonly BoardStatus[]
  /** The board's LIVE status list (`lib/tasks.ts`'s `useTaskStatuses`) — `null` while it loads. */
  statuses: readonly TaskStatusDef[] | null
}

/** What a lane is called, and which rows belong to it. */
function laneOf(row: TaskListRow, key: LaneKey): string {
  switch (key) {
    case 'repo': return row.task.repo || 'no repository'
    case 'harness': return row.harnesses[0] ?? 'no harness yet'
    case 'priority': return row.task.priority ?? 'none'
    case 'none': return ''
  }
}

export function BoardView(p: BoardViewProps) {
  const { rows, onOpen } = p
  const isMobile = useIsMobile()
  const L = boardCopy(p.lang ?? 'en').list
  const [drag, setDrag] = useState<string | null>(null)
  /**
   * A drop that was REFUSED because the column is not in hand order. It stays on screen (the column
   * says why, in words, with the way out beside it) until the next drag starts or a few seconds
   * pass — a refusal that flashes and vanishes is indistinguishable from a drop that did nothing.
   */
  const [refused, setRefused] = useState<{ lane: string; status: BoardStatus } | null>(null)
  useEffect(() => {
    if (!refused) return
    const t = setTimeout(() => setRefused(null), 6000)
    return () => clearTimeout(t)
  }, [refused])
  const [over, setOver] = useState<{ lane: string; status: BoardStatus; index: number } | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const liveByTask = useMemo(() => {
    const m = new Map<string, NonNullable<BoardViewProps['sessions']>[number][]>()
    for (const s of p.sessions ?? []) {
      if (!s.task) continue
      const list = m.get(s.task) ?? []
      list.push(s)
      m.set(s.task, list)
    }
    return m
  }, [p.sessions])

  /** Lanes in a stable order, each holding the chosen columns. One lane when `lanes` is `none`. */
  const lanes = useMemo(() => {
    const names = p.lanes === 'none'
      ? ['']
      : [...new Set(rows.map(r => laneOf(r, p.lanes)))].sort()
    // The chosen columns, in the chosen order — falling back to the LIVE list's own order (the
    // whole pipeline), so a board whose preference has never been touched shows every status the
    // board currently has, custom ones included, rather than the fixed legacy seven.
    const shown = p.columns && p.columns.length > 0 ? p.columns : liveStatusOrder(p.statuses)
    return names.map(name => ({
      name,
      columns: shown.map(status => ({
        status,
        rows: sortRows(
          rows.filter(r => (r.task.status as BoardStatus) === status
            && (p.lanes === 'none' || laneOf(r, p.lanes) === name)),
          effectiveSort(p.sort, p.columnSort, status),
          { statusOrder: liveStatusOrder(p.statuses) },
        ),
      })),
    }))
  }, [rows, p.lanes, p.sort, p.columnSort, p.columns, p.statuses])

  /** May a card be moved to a new POSITION in this column? Only under hand order — see `canReorderBy`. */
  const reorderable = (status: BoardStatus) =>
    canReorderBy(effectiveSort(p.sort, p.columnSort, status))

  const drop = (lane: string, status: BoardStatus, index: number) => {
    const id = drag
    setDrag(null); setOver(null)
    if (!id) return
    const row = rows.find(r => r.task.id === id)
    if (!row) return
    // Two different writes, and only one of them applies: a drop into another column is a STATUS
    // change (the board's whole vocabulary), and a drop inside one is a reorder. Doing both from
    // one gesture would write two facts and leave a card in a column its status does not name if
    // the second failed.
    if ((row.task.status as BoardStatus) !== status) p.onStatus?.(id, status)
    // A rank is only meaningful under the order that reads it: a drop under any other sort would
    // land the card somewhere other than where it was put. REFUSED IN WORDS (the column's note),
    // never a drop that silently does nothing — and never a silent switch of the column's order
    // behind the reader's back.
    else if (reorderable(status)) p.onMove?.(id, index)
    else setRefused({ lane, status })
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {lanes.map(lane => (
        <div key={lane.name} style={{ display: 'grid', gap: 8 }}>
          {lane.name !== '' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>
                {lane.name}
              </span>
              <span style={{ ...microLabel, fontSize: 10.5 }}>
                {lane.columns.reduce((n, c) => n + c.rows.length, 0)}
              </span>
              <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>
          )}
          <div
            className="ag-noscroll"
            style={{
              /*
               * ONE ROW, scrolled sideways. A kanban that wraps is not a kanban: the columns stop
               * reading as a pipeline the moment `in_review` sits underneath `backlog`, and the eye
               * has to re-find the order on every glance. Seven fixed columns will not fit any
               * screen, so the BOARD scrolls — inside its own container, because the page body must
               * never scroll horizontally (the 390px rule). `overscroll-behavior-x: contain` keeps
               * that scroll from turning into a browser back-swipe on a trackpad.
               */
              display: 'flex', gap: 12, alignItems: 'flex-start',
              overflowX: 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain',
              paddingBottom: 4, marginInline: -2, paddingInline: 2,
              scrollSnapType: 'x proximity',
            }}
          >
            {lane.columns.map(col => {
              const s = statusStyle(p.statuses, col.status)
              const limit = p.wip[col.status]
              const over_ = limit !== undefined && col.rows.length > limit
              const isOverCol = over?.lane === lane.name && over.status === col.status
              const colSort = effectiveSort(p.sort, p.columnSort, col.status)
              const canMove = reorderable(col.status)
              const dragged = drag ? rows.find(r => r.task.id === drag) : undefined
              // The note is for a card that WOULD reorder here: one coming from another column is a
              // status change, which a sorted column accepts like any other.
              const reordering = dragged !== undefined && (dragged.task.status as BoardStatus) === col.status
              const showRefusal = !canMove && (
                (isOverCol && reordering)
                || (refused?.lane === lane.name && refused.status === col.status)
              )
              return (
                <section
                  key={col.status}
                  onDragOver={e => {
                    if (!drag) return
                    e.preventDefault()
                    if (!isOverCol) setOver({ lane: lane.name, status: col.status, index: col.rows.length })
                  }}
                  onDrop={e => { e.preventDefault(); drop(lane.name, col.status, over?.index ?? col.rows.length) }}
                  style={{
                    display: 'grid', gap: 10, alignContent: 'start',
                    // Fixed, not fractional: columns of different widths read as different
                    // importance, and a `1fr` column collapses to nothing once seven of them share
                    // a phone.
                    flex: '0 0 clamp(240px, 78vw, 288px)',
                    scrollSnapAlign: 'start',
                    outline: isOverCol && !(reordering && !canMove)
                      ? '1px dashed var(--anthropic-orange)' : 'none',
                    outlineOffset: 4, borderRadius: 'var(--radius-md)',
                  }}
                >
                  <header style={{
                    ...surface, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8,
                    borderTop: `2px solid ${s.color}`, position: 'sticky', top: 0, zIndex: 1,
                  }}>
                    {/* The same word the table's band and every chip print — and the control that
                        orders THIS column: pressing the title opens the keys the board offers. */}
                    <ColumnSortMenu
                      title={statusLabel(col.status, p.lang ?? 'en', p.statuses)}
                      color={s.color}
                      sort={colSort}
                      overridden={hasOverride(p.columnSort, col.status)}
                      options={BOARD_SORT_KEYS.map(key => ({ key, label: L.keys[key] ?? key }))}
                      onPick={key => p.onColumnSort(pickColumnSort(p.sort, p.columnSort, col.status, key))}
                      onClear={() => p.onColumnSort(clearColumnSort(p.columnSort, col.status))}
                      tooltip={L.columnSortTitle}
                      followLabel={L.sortDefault}
                      isMobile={isMobile}
                    />
                    <span style={{ ...microLabel, fontSize: 11 }}>
                      {col.rows.length}{limit !== undefined ? ` / ${limit}` : ''}
                    </span>
                    {over_ && (
                      // A WIP limit WARNS and never blocks: the limit is an agreement a team makes
                      // with itself, and a board that refuses a drop teaches people to work around
                      // it rather than to look at it.
                      <span
                        style={pill('var(--accent-red)')}
                        title={`${col.rows.length} in this column, over the limit of ${limit}`}
                      >over WIP</span>
                    )}
                  </header>
                  {showRefusal && (
                    <div
                      role="status"
                      style={{
                        ...surface, padding: '8px 10px', display: 'grid', gap: 6,
                        border: '1px dashed var(--anthropic-orange)',
                        fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-secondary)',
                      }}
                    >
                      <span>{L.columnReorderOff.replace('{key}', L.keys[colSort.key] ?? colSort.key)}</span>
                      <button
                        type="button"
                        // Drops the column back on HAND ORDER (an explicit override when the board's
                        // own order is something else) — the reader's own click, never a side effect
                        // of the drag.
                        onClick={() => {
                          p.onColumnSort(withColumnSort(p.sort, p.columnSort, col.status, DEFAULT_SORT))
                          setRefused(null)
                        }}
                        style={{
                          justifySelf: 'start', background: 'none', border: 'none', padding: 0,
                          cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
                          color: 'var(--anthropic-orange)', minHeight: isMobile ? 44 : undefined,
                        }}
                      >{L.columnUseHand}</button>
                    </div>
                  )}
                  {col.rows.length === 0
                    ? (
                      // Short and quiet. An empty column still has to be VISIBLE — a status that
                      // vanishes when nothing is in it makes the reader learn the vocabulary to
                      // notice the gap — but seven full-height "Nothing here" boxes are most of the
                      // screen.
                      <div style={{
                        ...surface, padding: '10px 12px', fontSize: 11, color: 'var(--text-tertiary)',
                        borderStyle: 'dashed', textAlign: 'center',
                      }}>
                        —
                      </div>
                    )
                    : col.rows.map((r, i) => (
                      <div
                        key={r.task.id}
                        draggable
                        onDragStart={() => { setDrag(r.task.id); setRefused(null) }}
                        onDragEnd={() => { setDrag(null); setOver(null) }}
                        onDragOver={e => {
                          if (!drag) return
                          e.preventDefault()
                          e.stopPropagation()
                          // Above or below the card the pointer is over — the whole of what a drop
                          // position is.
                          const box = e.currentTarget.getBoundingClientRect()
                          const after = e.clientY > box.top + box.height / 2
                          // `-1` = "over this column, but there is no position to offer": a card
                          // moved within a column that is not in hand order gets no drop line (a
                          // line would promise a place the drop cannot give it).
                          setOver({
                            lane: lane.name, status: col.status,
                            index: reordering && !canMove ? -1 : after ? i + 1 : i,
                          })
                        }}
                        style={{
                          borderTop: isOverCol && over?.index === i
                            ? '2px solid var(--anthropic-orange)' : '2px solid transparent',
                          opacity: drag === r.task.id ? 0.45 : 1,
                        }}
                      >
                        <Card
                          row={r}
                          nowMs={nowMs}
                          live={liveByTask.get(r.task.title) ?? []}
                          onOpen={() => onOpen(r.task.id)}
                          statuses={p.statuses}
                        />
                      </div>
                    ))}
                </section>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

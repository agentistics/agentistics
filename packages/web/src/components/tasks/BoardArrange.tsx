/**
 * BoardArrange — the kanban's own controls: what the cards are ordered BY, what the rows are, and
 * how many cards a column should hold. They are segments of the ONE view bar every task screen
 * draws (`ViewBar.tsx`): Group (swimlanes) · Columns · Sort, plus the board-only WIP limits.
 *
 * They sit above the board rather than inside a settings dialog because all three change what is on
 * screen right now, and a control whose effect you cannot see while you press it is one people
 * press twice.
 *
 * The SORT is the table's sort — one field, written by both. A board that ranks its cards one way
 * in the grid and another in the columns is two boards.
 */

import { X } from 'lucide-react'
import { PRIORITY_ORDER, type SortKey, type SortSpec, type TaskStatusDef } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  button, field, liveStatusMap, liveStatusOrder, microLabel, pill, type BoardStatus,
} from './board'
import { boardCopy, type Lang } from './copy'
import { PanelMenu, PickerMenu } from './PickerMenu'
import { ViewBar, ViewSortMenu, segmentBadge, viewSegment } from './ViewBar'
import { LANE_KEYS, type LaneKey } from './boardPrefs'
import type { ColumnSorts } from './columnSort'

/**
 * The orders a KANBAN offers, which are deliberately fewer than the table's.
 *
 * A column of cards is read top to bottom; a key nobody can see on the card (attempts, comments)
 * would order it by something invisible, and the reader would conclude the board was shuffled.
 */
const BOARD_SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'manual', label: 'Hand order' },
  { key: 'priority', label: 'Priority' },
  { key: 'due', label: 'Due date' },
  { key: 'updated', label: 'Last touched' },
  { key: 'created', label: 'Newest' },
  { key: 'cost', label: 'Cost' },
  { key: 'rounds', label: 'Your prompts' },
  { key: 'title', label: 'Title' },
]

/** The keys alone, for a surface that words them itself (the column titles' sort menu). */
export const BOARD_SORT_KEYS: readonly SortKey[] = BOARD_SORTS.map(s => s.key)

const LANE_LABEL: Record<LaneKey, string> = {
  none: 'No swimlanes',
  repo: 'Repository',
  harness: 'Harness',
  priority: 'Priority',
}

export interface BoardArrangeProps {
  sort: SortSpec
  onSort: (s: SortSpec) => void
  /** Columns that have been given an order of their own by clicking their title — see
   *  `ColumnSortMenu`. Only the RESET reads them: it must put those back too, or "Reset" leaves a
   *  board that is still not the plain one. */
  columnSorts?: ColumnSorts
  onColumnSorts?: (next: ColumnSorts) => void
  lanes: LaneKey
  onLanes: (l: LaneKey) => void
  wip: Record<string, number>
  onWip: (w: Record<string, number>) => void
  /** Which columns the board draws, in order. The same stored set the table's groups use. */
  columns: readonly BoardStatus[]
  onColumns: (next: BoardStatus[]) => void
  /** How many cards sit in each status, so a HIDDEN column still says what it holds. */
  counts: Record<string, number>
  /** The board's LIVE status list (`lib/tasks.ts`'s `useTaskStatuses`) — `null` while it loads. */
  statuses: readonly TaskStatusDef[] | null
  /** The reader's language. Absent = English, for a caller that has not been threaded yet — same
   *  default `TaskTable`'s own `lang` prop uses. */
  lang?: Lang
}

export function BoardArrange(p: BoardArrangeProps) {
  const isMobile = useIsMobile()
  const copy = boardCopy(p.lang ?? 'en')
  const statusOrder = liveStatusOrder(p.statuses)
  const statusMap = liveStatusMap(p.statuses)
  const limited = Object.keys(p.wip).length

  const row = (on: boolean): React.CSSProperties => ({
    display: 'flex', gap: 8, alignItems: 'center', textAlign: 'left', width: '100%',
    padding: '6px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
    border: `1px solid ${on ? 'var(--anthropic-orange)' : 'transparent'}`,
    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
    minHeight: isMobile ? 44 : 28,
  })
  const note: React.CSSProperties = {
    ...microLabel, textTransform: 'none', letterSpacing: 0, padding: '4px 8px', lineHeight: 1.5,
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <ViewBar label={`${copy.viewBar.group} · ${copy.viewBar.columns} · ${copy.viewBar.sort}`}>
        {/* GROUP — the swimlanes: a lane per value, each holding the whole pipeline. */}
        <PanelMenu
          title={copy.viewBar.group}
          width={230}
          triggerStyle={viewSegment(isMobile, p.lanes !== 'none')}
          render={close => (
            <>
              {LANE_KEYS.map(k => (
                <button key={k} type="button" onClick={() => { close(); p.onLanes(k) }} style={row(p.lanes === k)}>
                  {LANE_LABEL[k]}
                </button>
              ))}
              <div style={note}>
                A lane per value, each holding the whole pipeline — which repository, which agent,
                which harness is doing what.
              </div>
            </>
          )}
        >{copy.viewBar.group}{p.lanes !== 'none' ? `: ${LANE_LABEL[p.lanes]}` : ''}</PanelMenu>

        {/*
         * WHICH COLUMNS, and in what order.
         *
         * Seven fixed columns are wider than any screen, so the board scrolled sideways and the last
         * two were simply off the edge with nothing offering to hide them — the arrangement existed
         * for the table and not for the board it was more needed on. Reorderable too: a pipeline that
         * runs backlog → done is a sequence, and a team that reviews before it blocks should be able
         * to say so.
         */}
        <PickerMenu
          title={copy.pickers.boardColumnsTitle}
          lang={p.lang ?? 'en'}
          triggerStyle={viewSegment(isMobile)}
          items={statusOrder.map(st => ({
            value: st,
            label: statusMap[st]?.label ?? st,
            color: statusMap[st]?.color ?? 'var(--text-tertiary)',
            hint: String(p.counts[st] ?? 0),
          }))}
          value={p.columns}
          onChange={next => p.onColumns(next as BoardStatus[])}
          orderable
          note={copy.pickers.boardColumnsNote}
        >
          {copy.viewBar.columns}
          {p.columns.length !== statusOrder.length && <span style={segmentBadge}>{p.columns.length}</span>}
        </PickerMenu>

        {/* SORT — the table's sort, one field written by both. Hand order is the board's resting
            order, so it is the "default" row rather than a key. */}
        <ViewSortMenu
          label={copy.viewBar.sort}
          title={copy.viewBar.sortBy}
          options={BOARD_SORTS.filter(s => s.key !== 'manual')}
          current={p.sort.key === 'manual' ? null : p.sort}
          onChange={next => p.onSort(next ?? { key: 'manual', dir: 'asc' })}
          defaultLabel="Hand order"
          ascLabel={copy.viewBar.asc}
          descLabel={copy.viewBar.desc}
          note="A card nothing could price sorts last whichever way the arrow points."
        />

        {/* WIP is the board's own — a table has no column to limit. */}
        <PanelMenu
          title="Cards per column"
          width={260}
          triggerStyle={viewSegment(isMobile, limited > 0)}
          render={() => (
            <>
              {statusOrder.map(st => {
                const c = statusMap[st] ?? { label: st, color: 'var(--text-tertiary)' }
                const v = p.wip[st]
                return (
                  <label key={st} style={{ ...row(v !== undefined), cursor: 'default' }}>
                    <span style={{ flex: 1, color: c.color }}>{c.label}</span>
                    <input
                      type="number" min={1} inputMode="numeric"
                      value={v ?? ''}
                      placeholder="—"
                      onChange={e => {
                        const n = Number(e.target.value)
                        const next = { ...p.wip }
                        // An empty box means NO limit, which is not the same as a limit of zero:
                        // zero would put every column over its limit the moment anything landed.
                        if (!Number.isFinite(n) || n <= 0) delete next[st]
                        else next[st] = Math.floor(n)
                        p.onWip(next)
                      }}
                      style={{ ...field(isMobile), width: 72, padding: '4px 8px' }}
                    />
                  </label>
                )
              })}
              <div style={note}>
                A limit WARNS, it never blocks a drop. It is an agreement you make with yourself —
                a board that refuses work teaches people to route around it.
              </div>
            </>
          )}
        >WIP{limited > 0 ? <span style={segmentBadge}>{limited}</span> : null}</PanelMenu>
      </ViewBar>

      {p.lanes === 'priority' && (
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          {PRIORITY_ORDER.map(id => <span key={id} style={pill()}>{id}</span>)}
        </span>
      )}

      <span style={{ flex: 1 }} />
      {(p.sort.key !== 'manual' || p.lanes !== 'none' || limited > 0
        || p.columns.length !== statusOrder.length
        || Object.keys(p.columnSorts ?? {}).length > 0) && (
        <button
          onClick={() => {
            p.onSort({ key: 'manual', dir: 'asc' })
            p.onColumnSorts?.({})
            p.onLanes('none')
            p.onWip({})
            p.onColumns([...statusOrder])
          }}
          style={{ ...button(isMobile), height: isMobile ? 44 : 28, gap: 6, color: 'var(--text-tertiary)' }}
          title="Back to the plain board"
        ><X size={12} /> Reset</button>
      )}
    </div>
  )
}

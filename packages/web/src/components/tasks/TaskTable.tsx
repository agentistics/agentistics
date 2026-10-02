/**
 * TaskTable — the board as a GRID you operate, in the shape monday.com established.
 *
 * The anatomy it reproduces, and why each piece is there:
 *
 *  - **Groups**: a coloured bar, a collapsible header and a count. The grouping is the STATUS by
 *    default, because that is the question the board answers first; the column set is shared by
 *    every group, so a row keeps its meaning when it moves between them.
 *  - **Rows**: a checkbox on the left, a chevron when there are subtasks, and typed cells.
 *  - **Subitems**: expand INSIDE the row, with their own column set. Monday's rule, and the right
 *    one: a subtask is a smaller piece of the same work, not a second task — it has no attempts and
 *    no rollup of its own, because cost is measured per SESSION and rolls up to the task. Giving it
 *    a second, smaller rollup would either double-count the same sessions or invent a split nobody
 *    recorded.
 *  - **Batch actions**: selecting rows raises a bar at the foot saying how many, with the verbs that
 *    can act on many at once.
 *  - **`+` in the header**: choose which columns are shown. The defaults are the ones that answer
 *    the three questions the product exists for — what it cost, in how many rounds, across how many
 *    sessions — so the table is useful before anyone configures anything.
 *  - **`+ Add` row** at the foot of each group: type a title, press Enter.
 *
 * It computes NOTHING. Every figure arrives already decided from `/api/tasks`.
 */

import React, { useEffect, useMemo, useState } from 'react'
import {
  Bot, CheckSquare, ChevronDown, ChevronRight, Columns3, MessageSquare, Paperclip, Plus,
  Rows3, SquareArrowOutUpRight, Trash2, X,
} from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  NA, PRIORITY, button, claimLeft, field, fmtDateTime, fmtInt, fmtStamp, fmtTokens, harnessColor, liveStatusMap,
  liveStatusOrder, microLabel, NO_TYPE_KEY, numeric, pill, statusStyle, surface, typeStyle, type BoardStatus, type ColumnId,
} from './board'
import { useMoney, type Money } from './money'
import {
  nextSort, PRIORITY_ORDER, sortRows,
  type SortKey, type SubtaskSortKey, type SubtaskSortSpec, type TaskPriorityId,
  type TaskStatusDef, type TaskTypeDef, sortTaskTypes,
} from '@agentistics/core'
import { DEFAULT_PREFS, useBoardPref } from './boardPrefs'
import { SortTh } from './SortHeader'
import {
  clearTicks, escapeLeavesMode, groupCheck, leaveMode, NO_SELECTION, selectedVisible, setRows,
  toggleMode, toggleRow, type Selection,
} from './selection'
import { orderedSubtasks } from './subtaskSortView'
import { effectiveSubtaskSort, pickSubtaskSort } from './subtaskSortInherit'
import { ConfirmModal } from '../../pages/settings/primitives'
import { SessionPicker } from './SessionPicker'
import { ChipSelect, statusOptions } from './ChipSelect'
import { StatusChip } from './StatusChip'
import { boardCopy, statusLabel, type Lang } from './copy'
import { SubtaskActionsMenu } from './SubtaskActionsMenu'
import {
  clusterBarStyle, clusterSubtaskRows, clusterTintStyle, groupMembers, groupOf, isGroupMember,
  isGroupSubtask, visibleClusterRows,
} from './subtaskGroups'
import { costCellFor, tokensCellFor } from './subtaskRollup'
import { CostCellView, TokensCellView } from './SubtaskMoneyCells'
import { ModelCellView } from './SubtaskModelCell'
import { SessionRef } from './SessionRef'
import { subtaskColumnCell } from './subtaskColumnCell'
import { DEFAULT_SUBTASK_COLUMNS, SUBTASK_COLUMNS, type SubtaskColumnId } from './subtaskColumnDefs'
import { EMPTY_SUBTASK_FILTER, filterSubtaskRows, type SubtaskFilterState } from './subtaskFilter'
import { SubtaskFilterMenu } from './SubtaskFilterMenu'
import { PickerMenu } from './PickerMenu'
import { subtaskGridLayout } from './subtaskGridLayout'
import { TaskProgressBar } from './TaskProgressBar'
import { HarnessBadges } from './HarnessBadges'
import { useStagedDialogs, type StagedTarget } from './useStagedDialogs'
import { useStagedFire } from './useStagedFire'
import { pushNotification } from '../../lib/notifications'
import {
  clearStagedSession, saveStagedSession, uploadFile,
  type StatusWriteResult, type Subtask, type SubtaskPatch,
  type SubtaskView, type TaskClaim, type TaskDetail, type TaskFile, type TaskListRow,
  type TaskSessionRow, type TaskStatus,
} from '../../lib/tasks'

/** `SubtaskColumnId` and `SubtaskSortKey` (`@agentistics/core`) name the same seven legacy columns
 *  by the same string — `model` is the one column with no sort key at all, so its header carries no
 *  click affordance, the SAME rule this file's own `cellFor` applies to any main-table column with
 *  no `sort` in its `ColumnDef`. Mirror of `SubtaskTable.tsx`'s identical helper — kept as its own
 *  copy rather than a shared import so neither file has to import the other's internals for one
 *  three-line function. */
function subtaskSortKeyFor(id: SubtaskColumnId): SubtaskSortKey | undefined {
  return id === 'model' ? undefined : (id as SubtaskSortKey)
}

// ---------------------------------------------------------------------------- columns

export type { ColumnId }

export interface ColumnDef {
  id: ColumnId
  /** Right-aligned, tabular. Every measured number is one; a chip column is not. */
  numeric?: boolean
  width: number
  /**
   * Which `SortKey` this column sorts by — absent means the column is not sortable, and its header
   * then carries no affordance at all rather than a control that does nothing.
   */
  sort?: SortKey
}

/**
 * The default set answers the three questions the product exists for before anyone configures
 * anything. The rest are one click away in the `+` menu.
 *
 * No `label` here — it used to be a hardcoded English literal per column, which is why this table's
 * headers stayed English on a Portuguese board while the inline subtask headers right below them
 * (`subtaskColumns`) were already localized through `boardCopy`. The label is now resolved at render
 * time from `boardCopy(lang).columns`, the SAME record the "Columns" picker reads, so the picker and
 * the headers can never disagree.
 */
export const COLUMNS: ColumnDef[] = [
  // No `sort` on Status, deliberately: this table is GROUPED by status, so every row inside a band
  // has the same one and a sort by it would reorder nothing while its arrow lit up — a control that
  // looks like it works and does not. The order of the bands themselves is the Groups picker's.
  { id: 'status', width: 116 },
  // Sortable, unlike Status: the table is only grouped by type when the person asks for it.
  { id: 'type', width: 104, sort: 'type' },
  { id: 'priority', width: 96, sort: 'priority' },
  { id: 'claim', width: 132 },
  { id: 'progress', width: 132, sort: 'progress' },
  { id: 'due', width: 96, sort: 'due' },
  { id: 'sessions', numeric: true, width: 84, sort: 'sessions' },
  { id: 'rounds', numeric: true, width: 108, sort: 'rounds' },
  { id: 'cost', numeric: true, width: 88, sort: 'cost' },
  { id: 'tokens', numeric: true, width: 84, sort: 'tokens' },
  { id: 'harnesses', width: 150, sort: 'harnesses' },
  { id: 'subtasks', numeric: true, width: 84, sort: 'subtasks' },
  { id: 'attempts', numeric: true, width: 84, sort: 'attempts' },
  { id: 'comments', numeric: true, width: 92, sort: 'comments' },
  { id: 'files', numeric: true, width: 68 },
  { id: 'links', numeric: true, width: 68 },
  { id: 'blockedBy', numeric: true, width: 92 },
  { id: 'created', width: 104, sort: 'created' },
  { id: 'updated', width: 104, sort: 'updated' },
]

export const DEFAULT_COLUMNS: ColumnId[] =
  ['status', 'priority', 'progress', 'claim', 'sessions', 'rounds', 'cost', 'tokens', 'harnesses']

// ------------------------------------------------------------------------------- cells

const cellPad = '7px 10px'

/**
 * A phone's thumb over a table cell.
 *
 * The glyph stays the size the table needs; the PADDING is what makes it 44px, so a dense row is
 * still dense and still tappable. Growing the icon instead would make the table unreadable to buy
 * the same hit area.
 */
const tap = (mobile: boolean): React.CSSProperties =>
  mobile ? { minHeight: 44, minWidth: 44, justifyContent: 'center' } : {}

function Num({ v, accent }: { v: number | null | undefined; accent?: boolean }) {
  const absent = v === null || v === undefined
  return (
    <span style={{
      ...numeric, fontSize: 12,
      color: absent ? 'var(--text-tertiary)' : accent ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
    }}>{absent ? NA : v.toLocaleString()}</span>
  )
}

/**
 * A due date, and whether it has passed.
 *
 * A CLOSED task never reads as late: the work is finished, and colouring a delivered row red says
 * something false about a thing nobody can act on any more.
 */
function DueCell({ date, closed, nowMs }: { date: string; closed: boolean; nowMs: number }) {
  const due = Date.parse(`${date}T23:59:59`)
  const late = !closed && Number.isFinite(due) && due < nowMs
  return (
    <span style={{
      fontSize: 11.5, fontWeight: late ? 600 : 400,
      color: late ? 'var(--accent-red)' : 'var(--text-secondary)',
    }}>{date}</span>
  )
}

/**
 * Who has the task RIGHT NOW.
 *
 * An expired lease is said out loud ("lease expired") rather than blanked: the task is available
 * again, and a cell that simply stopped naming a holder would read as one nobody ever took.
 */
function ClaimCell({ claim, nowMs }: { claim?: TaskClaim; nowMs: number }) {
  if (!claim) return <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
  const left = claimLeft(claim.expiresAt, nowMs)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
      <span style={pill(left.expired ? 'var(--text-tertiary)' : 'var(--accent-green)')}>
        <Bot size={10} /> {claim.by}
      </span>
      <span style={{ fontSize: 10, color: left.expired ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}>
        {left.text}
      </span>
    </span>
  )
}

function cellFor(
  col: ColumnId,
  row: TaskListRow,
  onStatus: (s: TaskStatus) => void,
  onPriority: (p: TaskPriorityId) => void,
  nowMs: number,
  lang: 'pt' | 'en',
  money: Money,
  statuses: readonly TaskStatusDef[] | null,
  types: readonly TaskTypeDef[] | null,
  onType: (t: string) => void,
  noTypeLabel: string,
): React.ReactNode {
  const r = row.rollup
  switch (col) {
    // The SAME control the delivery's own screen and the card draw — see `StatusChip`. The table
    // used to build its own option list here and the rail built another one, in another component,
    // with English labels either way.
    case 'status': return (
      <StatusChip
        compact
        value={row.task.status}
        lang={lang}
        statuses={statuses}
        onPick={v => onStatus(v as TaskStatus)}
      />
    )
    // The priority cell's own control, over the type vocabulary. An unclassified task carries the
    // reserved `NO_TYPE_KEY` as its value and picking it again is what clears a type.
    case 'type': return (
      <ChipSelect
        compact
        value={row.task.type ?? NO_TYPE_KEY}
        options={[
          { value: NO_TYPE_KEY, ...typeStyle(null, undefined), label: noTypeLabel },
          ...sortTaskTypes(types ?? []).map(t => ({ value: t.id, ...typeStyle(types, t.id) })),
        ]}
        onPick={v => onType(v === NO_TYPE_KEY ? '' : v)}
      />
    )
    case 'priority': return (
      <ChipSelect
        compact
        value={!row.task.priority || row.task.priority === 'none' ? 'low' : row.task.priority}
        options={PRIORITY_ORDER.map(id => ({
          value: id, label: PRIORITY[id]!.label, color: PRIORITY[id]!.color, dim: PRIORITY[id]!.dim,
        }))}
        onPick={v => onPriority(v as TaskPriorityId)}
      />
    )
    case 'due': return row.task.dueDate
      ? <DueCell date={row.task.dueDate} closed={row.task.status === 'done' || row.task.status === 'abandoned'} nowMs={nowMs} />
      : <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
    case 'claim': return <ClaimCell claim={row.task.claim} nowMs={nowMs} />
    case 'progress': return row.counts.subtasks === 0
      // Nothing to be a fraction of. An empty bar here would say "0% done" about a task nobody
      // broke up, which is a claim about the work rather than about the board.
      ? <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
      : <TaskProgressBar done={row.counts.subtasksDone} total={row.counts.subtasks} />
    case 'updated': return (
      <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        {new Date(row.task.updatedAt).toLocaleDateString()}
      </span>
    )
    case 'sessions': {
      // "N · M priced" — a SEPARATOR, not parentheses ("N (M priced)" wrapped onto a second line in
      // an 84px column), one line, and the WORD is localized (`boardCopy`, `sessionsPriced`) rather
      // than hardcoded English on an otherwise-Portuguese board.
      const short = r.sessionsLinked < r.sessionsUsed
      return (
        <span
          style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap' }}
          title={short ? `${r.sessionsLinked} ${boardCopy(lang).sessionsPriced}` : undefined}
        >
          <Num v={r.sessionsUsed} />
          {short && (
            <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
              · {r.sessionsLinked} {boardCopy(lang).sessionsPriced}
            </span>
          )}
        </span>
      )
    }
    case 'rounds': return <Num v={r.rounds} />
    case 'cost': return r.mixedCurrency || (r.credits !== null && r.costUSD === null)
      ? <span style={{ ...numeric, fontSize: 12 }}>{r.credits!.premiumRequests} req</span>
      : <span style={{ ...numeric, fontSize: 12, color: r.costUSD === null ? 'var(--text-tertiary)' : 'var(--anthropic-orange)' }}>{money(r.costUSD, r.costByHarness)}</span>
    case 'tokens': return <span style={{ ...numeric, fontSize: 12, color: r.tokens === null ? 'var(--text-tertiary)' : undefined }}>{fmtTokens(r.tokens)}</span>
    case 'harnesses': return <HarnessBadges harnesses={row.harnesses} />
    case 'subtasks': return row.counts.subtasks === 0
      ? <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
      : <span style={{ ...numeric, fontSize: 12 }}>{row.counts.subtasksDone}/{row.counts.subtasks}</span>
    case 'attempts': return <Num v={row.attempts} />
    case 'comments': return row.counts.comments === 0
      ? <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
      : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...numeric, fontSize: 12 }}>
          <MessageSquare size={11} />{row.counts.comments}
        </span>
    case 'files': return row.counts.files === 0
      ? <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
      : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...numeric, fontSize: 12 }}>
          <Paperclip size={11} />{row.counts.files}
        </span>
    case 'links': return <Num v={row.task.links?.length ?? 0} />
    case 'blockedBy': {
      const n = row.task.blockedBy?.length ?? 0
      return n === 0
        ? <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
        : <span style={pill('var(--accent-red)')}>{n}</span>
    }
    case 'created': return (
      <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        {new Date(row.task.createdAt).toLocaleDateString()}
      </span>
    )
  }
}

// ------------------------------------------------------------------------------ subrow

function SubtaskRows({
  subtasks, subtaskRollups, indent, mainCols, subtaskCols, sessions, lang, nowMs, statuses, onPatch, onRemove,
  onCreateGroup, onLinkSession, onUnfile, onOpenSession, stagedFor,
}: {
  subtasks: Subtask[]
  /** The delivery's own `TaskDetail.subtaskRollups` — a GROUP's own `groupProgress` (§F.1), and now
   *  also the per-subtask Cost/Tokens cells (owner-approved reversal of this table's earlier "the
   *  rest of this row's numbers stay off this table by design" — they no longer do, and are drawn
   *  through the SAME `subtaskColumnCell` `SubtaskTable.tsx`'s own grid draws them through). */
  subtaskRollups: readonly SubtaskView[]
  indent: number
  /** How many MAIN table columns are shown — the filler cell has to close the row exactly. */
  mainCols: number
  /** Which SUBTASK columns are shown, in order (t-63b7d3b2b0 #1) — the SAME arrangement
   *  `SubtaskTable.tsx`'s own grid reads/writes, via `boardPrefs.subtaskColumns`. `status` is drawn
   *  through `ChipSelect` here (not `subtaskColumnCell`, which deliberately omits it — see that
   *  module's own header) whenever it appears in this list. */
  subtaskCols: readonly SubtaskColumnId[]
  /** The DELIVERY's sessions. Each subtask draws the ones filed under IT — see `SubtaskSessions`. */
  sessions: readonly TaskSessionRow[]
  lang: Lang
  /** Feeds `fmtDateTime`'s "same calendar year as now" check — see `TaskTable`'s own `nowMs`. */
  nowMs: number
  /** The board's LIVE status list (`lib/tasks.ts`'s `useTaskStatuses`) — `null` while it loads. */
  statuses: readonly TaskStatusDef[] | null
  onPatch: (id: string, patch: SubtaskPatch) => Promise<StatusWriteResult>
  onRemove: (id: string) => void
  onCreateGroup: (title: string) => Promise<string | null>
  onLinkSession: (subtaskId: string) => void
  onUnfile: (sessionId: string) => void
  onOpenSession?: (sessionId: string) => void
  /** The staged-session section of each subtask's gear — the same one the delivery page offers. */
  stagedFor: (t: Subtask) => NonNullable<React.ComponentProps<typeof SubtaskActionsMenu>['staged']>
}) {
  const isMobile = useIsMobile()
  const money = useMoney()
  const bare: React.CSSProperties = {
    width: '100%', background: 'transparent', border: 'none', outline: 'none',
    color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'inherit',
    minHeight: isMobile ? 44 : undefined,
  }
  /**
   * Which GROUPS are showing their members — collapsed by default, mirroring `SubtaskTable`'s own
   * accordion state exactly (see its doc comment). Local to this component, which is deliberate
   * rather than incidental: `SubtaskRows` only mounts while its task row is expanded (the caller
   * renders it behind `{open && (…)}`), so folding the task closed and reopening it already resets
   * every group back to collapsed — one state reset instead of two.
   */
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const toggleGroup = (groupId: string) => setExpandedGroups(prev => {
    const next = new Set(prev)
    next.has(groupId) ? next.delete(groupId) : next.add(groupId)
    return next
  })
  // Icon-only, small on purpose — `.ag-tap-icon` (index.css) projects the mobile 44px hit area
  // around it without painting a 44x44 box in a table cell that has no room to spare. Same rule
  // `SubtaskActionsMenu`'s gear trigger and `SubtaskTable`'s own version of this chevron follow.
  const chevronBtn: React.CSSProperties = {
    background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
    flexShrink: 0, minWidth: 18, minHeight: 18,
  }
  // 1 (leading) + 1 (title) + `subtaskCols.length` named cells + filler must equal `mainCols + 2` —
  // the task row above is [leading][title][mainCols…], and the leading column is there in BOTH
  // modes (Select only adds the checkbox INSIDE it), so this arithmetic does not depend on whether
  // rows are being picked. See `subtaskGridLayout.ts` — the caller decides `inline` vs `nested`
  // from this same pair before ever reaching this component.
  const filler = Math.max(0, mainCols - subtaskCols.length)
  // See `SubtaskTable`'s own doc comment for the full §F.1 clustering reasoning — this mirrors it
  // exactly, over the same `subtasks` pool (already scoped to one delivery): a member renders
  // directly under its group regardless of creation order, connected by an inset bar plus a shared
  // tint, rather than a caption repeated on every member row.
  //
  // The `id: null` direct-branch bucket — sessions filed straight on the delivery, under no
  // subtask (t-63b7d3b2b0 #5). `SubtaskTable.tsx`'s own standalone grid has always drawn this as a
  // footer row with the sessions listed by name and openable; this inline view never did, so a
  // delivery whose sessions are ALL direct (no subtask at all) rendered nothing here beyond
  // "+ Add subtask" — the cost/tokens rollup was visible one level up, on the task row, with no way
  // to see WHICH sessions produced it short of opening the task. Mirrored here for the same reason
  // every other subtask cell is mirrored: a fact drawn on one surface and not the other teaches
  // people the fact does not exist.
  const directView = subtaskRollups.find(v => v.id === null)
  const directSessions = sessions.filter(s => s.subtaskId === null)
  return (
    <>
      {visibleClusterRows(clusterSubtaskRows(subtasks), expandedGroups).map(({ subtask: t, depth, clustered }) => {
        const isMember = isGroupMember(t)
        const isGroup = isGroupSubtask(t)
        const view = subtaskRollups.find(v => v.id === t.id)
        const parentGroup = isMember && !clustered ? groupOf(t, subtasks) : undefined
        const tint = clusterTintStyle(clustered)
        // A non-empty group's own header — see `SubtaskTable`'s identical reasoning.
        const isGroupHeader = isGroup && clustered
        const groupOpen = expandedGroups.has(t.id)
        const memberCount = isGroupHeader ? groupMembers(t.id, subtasks).length : 0
        return (
        <tr key={t.id} style={{ background: clustered ? undefined : 'var(--bg-surface)' }}>
          {/* The leading "checkbox" slot every row above this one uses for batch-select — a subtask
              is never batch-selectable, so it was always blank here. It now carries the ONE gear
              menu instead (`SubtaskActionsMenu`'s own doc comment): group actions, the
              staged-session lifecycle (the same one the task page offers — the rocket lives
              HERE, on the subtask, never on the task row) and remove. The inset left bar
              (`clusterBarStyle`) lands here — the leading edge of every clustered row, header
              through last member, so it reads as one continuous stripe. */}
          <td style={{ padding: cellPad, whiteSpace: 'nowrap', ...tint, ...clusterBarStyle(clustered) }}>
            <SubtaskActionsMenu
              subtask={t}
              siblings={subtasks}
              lang={lang}
              statuses={statuses}
              onPatch={onPatch}
              onCreateGroup={onCreateGroup}
              onRemove={onRemove}
              staged={stagedFor(t)}
            />
          </td>
          {/* A MEMBER is indented one level further than the base subtask indent — the visual
              nesting that replaces the old "parte do grupo" caption for every properly clustered
              row. `indent` is the BASE (0 here — see the call site's own note: it used to be 34,
              leaving a ~50px gap between the gear button and the title nobody asked for); the
              member's own +20 offset is unchanged, so a member still sits exactly as far under its
              group as it always did. */}
          <td style={{ padding: cellPad, paddingLeft: indent + (depth === 1 ? 20 : 0), ...tint }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {/* Same accordion toggle as `SubtaskTable`'s inline view — collapsed by default. */}
              {isGroupHeader && (
                <button
                  type="button"
                  onClick={() => toggleGroup(t.id)}
                  aria-expanded={groupOpen}
                  aria-label={groupOpen
                    ? (lang === 'pt' ? `Recolher grupo: ${t.title}` : `Collapse group: ${t.title}`)
                    : (lang === 'pt' ? `Expandir grupo: ${t.title}` : `Expand group: ${t.title}`)}
                  title={groupOpen
                    ? (lang === 'pt' ? 'Recolher grupo' : 'Collapse group')
                    : (lang === 'pt' ? 'Expandir grupo' : 'Expand group')}
                  className="ag-tap-icon"
                  style={chevronBtn}
                >{groupOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
              )}
              <input
                value={t.title}
                onChange={e => void onPatch(t.id, { title: e.target.value })}
                style={{
                  ...bare, flex: 1, minWidth: 0,
                  color: t.done ? 'var(--text-tertiary)' : 'var(--text-secondary)', fontSize: 12.5,
                  textDecoration: t.done ? 'line-through' : 'none',
                  // A GROUP's header reads as a container's title, not another row — the weight is
                  // what makes it read as a HEADING when the row is scanned rather than compared
                  // cell-by-cell against its neighbours.
                  fontWeight: isGroup && clustered ? 700 : undefined,
                }}
              />
            </div>
            {/* Collapsed, say how many members are folded — the same summary `SubtaskTable` shows. */}
            {isGroupHeader && !groupOpen && (
              <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
                {memberCount} {memberCount === 1
                  ? (lang === 'pt' ? 'subtarefa' : 'subtask')
                  : (lang === 'pt' ? 'subtarefas' : 'subtasks')}
              </div>
            )}
            {isGroup && view?.groupProgress && (
              <TaskProgressBar done={view.groupProgress.done} total={view.groupProgress.total} height={3} />
            )}
            {/* An ORPHANED member only (its group is gone from this list) — the one case with no
                cluster to place it in, so the words are the only thing left saying where it came
                from. A properly clustered member says nothing here; its position already does. */}
            {isMember && !clustered && (
              <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                {lang === 'pt' ? 'parte do grupo: ' : 'part of group: '}
                <span style={{ color: 'var(--text-secondary)' }}>
                  {parentGroup?.title ?? (lang === 'pt' ? '(não encontrado)' : '(not found)')}
                </span>
              </div>
            )}
            {/* "Ready to fire" stays glanceable, exactly as on the task page — the verbs behind
                it are in the gear. */}
            {!isMember && t.stagedSession && (
              <div style={{ marginTop: 3 }}>
                <span style={{ ...pill('var(--anthropic-orange)'), fontSize: 9.5 }}>
                  {boardCopy(lang).staged.ready}
                </span>
              </div>
            )}
          </td>
          {subtaskCols.map(id => {
            const def = SUBTASK_COLUMNS.find(c => c.id === id)!
            return (
              <td key={id} style={{ padding: cellPad, textAlign: def.numeric ? 'right' : 'left', ...tint }}>
                {id === 'status'
                  ? (
                    <ChipSelect
                      compact
                      value={t.status}
                      options={statusOptions(liveStatusMap(statuses), liveStatusOrder(statuses))}
                      onPick={v => void onPatch(t.id, { status: v as TaskStatus })}
                    />
                  )
                  : subtaskColumnCell(id, {
                    subtask: t, isMember, sessions, subtaskRollups, lang, nowMs, isMobile, money,
                    onLink: onLinkSession, onUnfile, onOpenSession,
                  })}
              </td>
            )
          })}
          {filler > 0 && <td colSpan={filler} style={tint} />}
        </tr>
        )
      })}
      {directView && (
        <tr style={{ background: 'var(--bg-surface)' }}>
          <td style={{ padding: cellPad }} />
          <td style={{
            padding: cellPad, paddingLeft: indent, color: 'var(--text-tertiary)',
            fontStyle: 'italic', fontSize: 12,
          }}>
            {boardCopy(lang).directSessions}
          </td>
          {subtaskCols.map(id => {
            const def = SUBTASK_COLUMNS.find(c => c.id === id)!
            return (
              <td key={id} style={{ padding: cellPad, textAlign: def.numeric ? 'right' : 'left' }}>
                {id === 'sessions' && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', minWidth: 0 }}>
                    {directSessions.map(s => (
                      <SessionRef
                        key={s.id} id={s.id} title={s.label} harness={s.harness} lang={lang}
                        historical={s.historical === true} onOpen={onOpenSession}
                        onUnfile={sid => void onUnfile(sid)}
                      />
                    ))}
                  </span>
                )}
                {id === 'model' && <ModelCellView sessions={directSessions} />}
                {id === 'cost' && <CostCellView r={directView.rollup} cost={costCellFor(directView.rollup)} money={money} />}
                {id === 'tokens' && <TokensCellView tok={tokensCellFor(directView.rollup)} />}
              </td>
            )
          })}
          {filler > 0 && <td colSpan={filler} />}
        </tr>
      )}
    </>
  )
}

// ------------------------------------------------------------------------------- table

/** A group's header checkbox: ticked, half-ticked (`indeterminate`) or clear. */
function GroupCheck({ state, label, mobile, onChange }: {
  state: 'all' | 'some' | 'none'
  label: string
  mobile: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label
      title={label}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        ...tap(mobile),
      }}
    >
      <input
        type="checkbox"
        aria-label={label}
        checked={state === 'all'}
        ref={el => { if (el) el.indeterminate = state === 'some' }}
        onChange={e => onChange(e.target.checked)}
        style={{ width: mobile ? 20 : 14, height: mobile ? 20 : 14, accentColor: 'var(--anthropic-orange)' }}
      />
    </label>
  )
}

export interface TaskTableProps {
  rows: TaskListRow[]
  /** The reader's language. Absent = English, for a caller that has not been threaded yet. */
  lang?: 'pt' | 'en'
  /** Details already fetched for expanded rows — subtasks come from here. */
  details: Map<string, TaskDetail>
  onOpen: (id: string) => void
  onStatus: (ref: string, status: TaskStatus) => void
  onPriority?: (ref: string, priority: TaskPriorityId) => void
  /** Set a task's type; an empty string clears it. */
  onType?: (ref: string, type: string) => void
  onCreate: (title: string, status: TaskStatus, type?: string) => void
  onExpand: (id: string) => void
  onAddSubtask: (ref: string, title: string) => void
  /** Returns the write's outcome — the group-forming gestures (§F.1) need it to show
   *  `invalid_group`/`subtask_has_sessions`/`group_field_conflict` instead of swallowing a refusal,
   *  the same standard `SubtaskTable`'s own `onPatch` already holds this board to. */
  onPatchSubtask: (ref: string, id: string, patch: SubtaskPatch) => Promise<StatusWriteResult>
  onRemoveSubtask: (ref: string, id: string) => void
  /** Mint a new GROUP subtask (§F.1) and return its id, or `null` on failure — see
   *  `SubtaskTable`'s own `onCreateGroup`. */
  onCreateGroupSubtask: (ref: string, title: string) => Promise<string | null>
  onBatchStatus: (ids: string[], status: TaskStatus) => void
  onBatchDelete: (ids: string[]) => void
  /**
   * File a session under a SUBTASK. A delivery takes no sessions directly — the delivery is the
   * unit of delivery, the subtask the unit of work — so this verb names both, always.
   */
  onLinkSession: (ref: string, subtaskId: string, sessionId: string) => void | Promise<void>
  /** Take a session out of wherever it is filed. */
  onUnfileSession: (ref: string, sessionId: string) => void | Promise<void>
  /** Open a session's own screen. Absent renders each reference as a label. */
  onOpenSession?: (sessionId: string) => void
  /** The board's LIVE status list (`lib/tasks.ts`'s `useTaskStatuses`) — `null` while it loads. */
  statuses: readonly TaskStatusDef[] | null
  /** The board's LIVE type list (`useTaskTypes`) — `null` while it loads. */
  types: readonly TaskTypeDef[] | null
  /** Re-read ONE delivery's detail, cached or not — `onExpand` is a no-op once it is cached, so a
   *  write that must show its result (a staged draft saved, a session fired) calls this instead. */
  onRefreshDetail: (ref: string) => Promise<unknown> | void
  /** Drawn at the START of the toolbar row — the page's search box, so the table has ONE row of
   *  controls instead of a search row above a controls row. */
  toolbarStart?: React.ReactNode
}

type TableStagedTarget = StagedTarget & { taskId: string }

export function TaskTable(p: TaskTableProps) {
  const isMobile = useIsMobile()
  const money = useMoney()
  // The arrangement is read LIVE from the per-person store (`boardPrefs.ts`) — never seeded once, or
  // a value the server answers after mount would wait for the next remount to appear.
  const [storedColumns, setColumns] = useBoardPref('columns')
  const shown = storedColumns ?? DEFAULT_COLUMNS
  // Which SUBTASK columns every expanded delivery's inline grid shows, in the order they were
  // picked (t-63b7d3b2b0 #1) — ONE arrangement for the whole table, shared through the same
  // `boardPrefs.subtaskColumns` slot `SubtaskTable.tsx`'s own standalone grid reads/writes, so
  // opening a delivery here and opening it from its own page never disagree about the columns.
  const [storedSubtaskCols, setSubtaskColumns] = useBoardPref('subtaskColumns')
  const shownSubtaskCols: SubtaskColumnId[] = storedSubtaskCols ?? DEFAULT_SUBTASK_COLUMNS
  /** The subtask column filter (t-63b7d3b2b0 #2) — ONE filter for the whole table, applied to every
   *  expanded delivery's own subtasks; ephemeral, like the per-delivery sort override below. */
  const [subtaskFilter, setSubtaskFilter] = useState<SubtaskFilterState>(EMPTY_SUBTASK_FILTER)
  const [sort, setSort] = useBoardPref('sort')
  // One clock for every lease cell on the screen, ticking a minute at a time. A card that says
  // "3m left" forever is worse than one that says nothing, and a timer per cell would be N timers.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  // The live list resolves ASYNCHRONOUSLY (`useTaskStatuses`) — a status a person just created
  // must still get its own group the first time it renders, so a default (never customized: no
  // stored `groups`) is DERIVED from the list on every render rather than frozen.
  const [storedGroups, setGroups] = useBoardPref('groups')
  const [groupBy, setGroupBy] = useBoardPref('groupBy')
  const [storedTypeGroups, setTypeGroups] = useBoardPref('typeGroups')
  const [storedCollapsed, setStoredCollapsed] = useBoardPref('collapsed')
  const collapsed = useMemo(() => new Set<string>(storedCollapsed), [storedCollapsed])
  const [menu, setMenu] = useState<'columns' | 'groups' | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // SELECT MODE (selection.ts): the checkboxes are behind it, it starts off, and leaving it clears
  // the ticks — a batch verb must never act on rows nobody can see are armed.
  const [sel, setSel] = useState<Selection>(NO_SELECTION)
  /**
   * Per-task OVERRIDES only — `null` means "no override, follow the main table's own sort"
   * (`subtaskSortInherit.ts`'s `effectiveSubtaskSort`/`pickSubtaskSort`), not "creation order"
   * outright as it used to. Clicking one grid's header must not reshuffle another open grid the
   * reader is not looking at, so the override is keyed per task and never touches the others.
   */
  const [subSort, setSubSort] = useState<Record<string, SubtaskSortSpec | null>>({})
  const [adding, setAdding] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [subDraft, setSubDraft] = useState<Record<string, string>>({})
  /** Which subtask is being given a session — `taskId/subtaskId`, so the patch knows both. */
  const [linkingSub, setLinkingSub] = useState<{ task: string; sub: string } | null>(null)
  // The board's own dialog, never `window.confirm` — see the note on the detail page's delete.
  const [confirmBatch, setConfirmBatch] = useState(false)
  /**
   * The staged-session lifecycle (compose / edit / view / fire / delete) lives in each SUBTASK's
   * gear, exactly as on the delivery's own page — a staged session belongs to a subtask or a group,
   * never to the delivery row. Both hooks are the ones `SubtaskTable`/`DeliveryDetail` use, so the
   * table carries no second copy of the draft form or of the spawn rules.
   */
  const stagedDialogs = useStagedDialogs<TableStagedTarget>(p.lang ?? 'en', {
    save: (t, d) => saveStagedSession(t.taskId, t.subtask.id, d)
      .then(r => { if (r.ok) void p.onRefreshDetail(t.taskId); return r }),
    clear: async t => { await clearStagedSession(t.taskId, t.subtask.id); await p.onRefreshDetail(t.taskId) },
    upload: (t, f) => uploadFile(t.taskId, f),
  })
  // A filing refused because the subtask is blocked is SAID, never swallowed — the session exists
  // and runs either way; what the reader must learn is that it is not filed where they asked.
  const fire = useStagedFire(p.lang ?? 'en', b => pushNotification({
    type: 'error', code: 'tasks.fire_filing_blocked', meta: { blockedBy: b.blockedBy.join(', ') },
  }))
  const stagedFor = (taskId: string, files: readonly TaskFile[]) => (t: Subtask) => {
    const target: TableStagedTarget = { taskId, subtask: t, files }
    return {
      hasDraft: Boolean(t.stagedSession),
      preparing: fire.preparingId === t.id,
      onCompose: () => stagedDialogs.compose(target),
      onEdit: () => stagedDialogs.compose(target),
      onFire: () => void fire.startFire({ taskId, subtask: t, files, reload: () => p.onRefreshDetail(taskId) }),
      onView: () => stagedDialogs.view(target),
      onDelete: () => stagedDialogs.remove(target),
    }
  }
  const copy = boardCopy(p.lang ?? 'en')
  const L = copy.list
  // The MAIN table's column labels — the one record the header row and the "Columns" picker both
  // read, so a header can never say something the picker's own row does not.
  const colLabel = (id: ColumnId): string => copy.columns[id]

  const cols = useMemo(
    () => COLUMNS.filter(c => shown.includes(c.id)).sort(
      (a, b) => shown.indexOf(a.id) - shown.indexOf(b.id)),
    [shown],
  )
  // How few shown columns it takes before an expanded delivery's subtasks no longer fit as rows of
  // THIS table without overshooting the main row's own width — see `subtaskGridLayout.ts`. Every
  // row's column count is the same `cols.length`, so this is decided once for the whole table
  // rather than per expanded row. Moves with `shownSubtaskCols.length` too: narrowing the subtask
  // grid's own columns is exactly what lets a narrower main table stay `inline`.
  const gridLayout = useMemo(
    () => subtaskGridLayout(cols.length, shownSubtaskCols.length),
    [cols.length, shownSubtaskCols.length],
  )

  // Every group is BUILT, even a hidden one: the chooser needs its count to say what it is hiding.
  // Sorted INSIDE the group, never across: the grouping is the first ordering and a sort that
  // reordered the bands would silently undo the arrangement chosen a control away.
  // The bands of the ACTIVE grouping. A band is `{ key, label, color, rows }` whichever dimension it
  // is: the status bands are keyed by status id (as they always were — a stored fold survives), the
  // type bands by `type:<id>` so a type can never collide with a status of the same word, and tasks
  // with no type fall in the `type:__none__` band, last.
  const typeList = useMemo(() => sortTaskTypes(p.types ?? []), [p.types])
  const sortCtx = useMemo(
    () => ({ statusOrder: liveStatusOrder(p.statuses), typeOrder: typeList.map(t => t.id) }),
    [p.statuses, typeList],
  )
  const groups = useMemo(() => {
    if (groupBy === 'type') {
      const known = new Set(typeList.map(t => t.id))
      return [
        ...typeList.map(t => ({ id: t.id, key: `type:${t.id}`, label: t.label, color: t.color })),
        { id: NO_TYPE_KEY, key: `type:${NO_TYPE_KEY}`, label: copy.types.none, color: typeStyle(null, undefined).color },
      ].map(g => ({
        key: g.key, label: g.label, color: g.color,
        createStatus: 'todo' as TaskStatus,
        createType: g.id === NO_TYPE_KEY ? undefined : g.id,
        rows: sortRows(p.rows.filter(r => (g.id === NO_TYPE_KEY
          // A task naming a type the list no longer holds is unclassified for grouping purposes.
          ? !r.task.type || !known.has(r.task.type)
          : r.task.type === g.id)), sort, sortCtx),
      }))
    }
    return liveStatusOrder(p.statuses).map(status => ({
      key: status,
      label: statusLabel(status, p.lang ?? 'en', p.statuses),
      color: statusStyle(p.statuses, status).color,
      createStatus: status as TaskStatus,
      createType: undefined as string | undefined,
      rows: sortRows(p.rows.filter(r => (r.task.status as BoardStatus) === status), sort, sortCtx),
    }))
  }, [p.rows, sort, p.statuses, p.lang, groupBy, typeList, sortCtx, copy.types.none])
  // Which bands are on screen, and in what order — a stored choice per grouping, derived from the
  // live list while nobody has customised it so a type created a moment ago gets its own band.
  const groupsShown = useMemo(
    () => (groupBy === 'type'
      ? storedTypeGroups?.map(k => `type:${k}`) ?? groups.map(g => g.key)
      : storedGroups ?? liveStatusOrder(p.statuses)),
    [groupBy, storedTypeGroups, storedGroups, p.statuses, groups],
  )

  const foldGroup = (key: string) => {
    const next = new Set(collapsed)
    next.has(key) ? next.delete(key) : next.add(key)
    setStoredCollapsed([...next] as BoardStatus[])
  }

  const toggleIn = (set: Set<string>, id: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set)
    next.has(id) ? next.delete(id) : next.add(id)
    apply(next)
  }

  // Escape leaves Select mode — unless it was meant for something else (a text field, an open
  // dialog): `escapeLeavesMode` is the one place that decides.
  useEffect(() => {
    if (!sel.on || confirmBatch) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (escapeLeavesMode(sel, {
        key: e.key, defaultPrevented: e.defaultPrevented,
        targetTag: t?.tagName, targetType: (t as HTMLInputElement | null)?.type,
        targetEditable: t?.isContentEditable,
      })) setSel(leaveMode())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel, confirmBatch])

  const th: React.CSSProperties = {
    ...microLabel, textAlign: 'left', padding: '7px 10px', fontWeight: 600,
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  }

  const menuBox: React.CSSProperties = {
    position: 'absolute', top: 34, right: 0, zIndex: 41, width: 210,
    ...surface, background: 'var(--bg-elevated)', padding: 8, display: 'grid', gap: 3,
    boxShadow: 'var(--shadow-elevated)', maxHeight: 340, overflowY: 'auto',
  }
  const check: React.CSSProperties = {
    display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer',
    fontSize: 12, color: 'var(--text-secondary)', minHeight: isMobile ? 34 : 22,
  }

  // In the CHOSEN order, not the canonical one — see the chooser's note.
  const visible = groupsShown
    .map(st => groups.find(g => g.key === st))
    .filter((g): g is typeof groups[number] => g !== undefined)

  // The selection that ACTS is the one on screen: a row in a hidden or folded group, filtered out by
  // the search box or deleted since, is not something the bar's count or a batch verb reaches.
  const selected = selectedVisible(
    sel,
    visible.filter(g => !collapsed.has(g.key)).flatMap(g => g.rows.map(r => r.task.id)),
  )

  // Every toolbar trigger is the same height and shape — a row of mixed sizes reads as unrelated
  // controls. On a phone they share the row evenly, each a full 44px target.
  const TRIGGER: React.CSSProperties = {
    ...button(isMobile), height: isMobile ? 44 : 28, gap: 6,
    ...(isMobile ? { flex: '1 1 auto', justifyContent: 'center' } : {}),
  }

  const openBtn: React.CSSProperties = {
    background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
    minWidth: 24, minHeight: 24, ...tap(isMobile),
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* ONE toolbar row: what to look for (search, injected by the page), how it is ordered (the
          sort chip, only when it is not the default), then the three things that shape the table —
          filter, groups, columns — and Select. The subtask grid's filter and columns live INSIDE
          those same controls (the filter is subtask-only and says so; "Columns" has a Tasks and
          a Subtasks tab), rather than on a second row of bare, unlabeled selects. Every menu is the
          app's portal popover — a menu opened inside a scrolling table is clipped by it. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {p.toolbarStart && (
          <div style={{ flex: isMobile ? '1 1 100%' : '0 1 340px', minWidth: 0 }}>{p.toolbarStart}</div>
        )}
        {(sort.key !== DEFAULT_PREFS.sort.key || sort.dir !== DEFAULT_PREFS.sort.dir) && (
          // Said in words, with the way out beside it: a sort is invisible once you have scrolled
          // past the header, and "why is this board in this order" should never need investigating.
          <button
            onClick={() => setSort(DEFAULT_PREFS.sort)}
            title={L.resetSort}
            style={{
              ...button(isMobile), height: isMobile ? 44 : 28, fontSize: 11,
              color: 'var(--anthropic-orange)',
            }}
          >
            {L.sortedByPrefix} {L.keys[sort.key] ?? sort.key} {sort.dir === 'asc' ? '↑' : '↓'}
            <X size={12} />
          </button>
        )}
        {!isMobile && <span style={{ flex: 1 }} />}
        <SubtaskFilterMenu
          value={subtaskFilter} onChange={setSubtaskFilter}
          sessions={[...p.details.values()].flatMap(d => d.sessions)}
          statuses={p.statuses} lang={p.lang ?? 'en'}
          label={copy.subtaskFilter.title}
          triggerStyle={TRIGGER}
        />
        {/* One or the other, per person: a single-choice list over the same PickerMenu the Groups and
            Columns pickers use — picking the row that is not current moves the choice to it. */}
        <PickerMenu
          title={copy.types.groupBy}
          lang={p.lang ?? 'en'}
          triggerStyle={TRIGGER}
          items={[
            { value: 'status', label: copy.types.groupByStatus },
            { value: 'type', label: copy.types.groupByType },
          ]}
          value={[groupBy]}
          onChange={next => {
            const picked = next.find(v => v !== groupBy)
            if (picked === 'status' || picked === 'type') setGroupBy(picked)
          }}
        >
          {copy.types.groupBy}: {groupBy === 'type' ? copy.types.groupByType : copy.types.groupByStatus}
        </PickerMenu>
        <PickerMenu
          title={copy.pickers.groupsTitle}
          lang={p.lang ?? 'en'}
          triggerStyle={TRIGGER}
          items={groups.map(g => ({
            value: g.key,
            // The SAME word the chip in every row of this group prints — one vocabulary, one language.
            label: g.label,
            color: g.color,
            // The count of a HIDDEN group too — "hidden" must not read as "empty".
            hint: String(g.rows.length),
          }))}
          value={groupsShown}
          // The picked ORDER is kept, not re-canonicalised: the board and the table share this field.
          onChange={next => (groupBy === 'type'
            ? setTypeGroups(next.map(k => k.replace(/^type:/, '')))
            : setGroups(next as BoardStatus[]))}
          orderable
          note={groupBy === 'type' ? copy.types.groupsNote : copy.pickers.groupsNote}
        >
          <Rows3 size={13} /> {copy.pickers.groupsTrigger}
          {/* How many are on screen, on the trigger itself — it used to be a separate caption. */}
          <span style={{ ...microLabel, fontSize: 10.5 }}>{visible.length}/{groups.length}</span>
        </PickerMenu>
        <PickerMenu
          title={copy.pickers.columnsTitle}
          lang={p.lang ?? 'en'}
          width={270}
          triggerStyle={TRIGGER}
          tabs={[
            {
              id: 'deliveries', label: copy.pickers.deliveriesTab, orderable: true,
              items: COLUMNS.map(c => ({ value: c.id, label: colLabel(c.id) })),
              value: shown, onChange: next => setColumns(next as ColumnId[]),
              note: copy.pickers.columnsNote,
            },
            {
              id: 'subtasks', label: copy.pickers.subtasksTab, orderable: true,
              items: SUBTASK_COLUMNS.map(c => ({ value: c.id, label: copy.subtaskColumns[c.id] })),
              value: shownSubtaskCols, onChange: next => setSubtaskColumns(next as SubtaskColumnId[]),
              note: copy.pickers.subtaskColumnsNote,
            },
          ]}
        >
          <Columns3 size={13} /> {copy.pickers.columnsTrigger}
        </PickerMenu>
        <button
          type="button"
          onClick={() => setSel(toggleMode)}
          aria-pressed={sel.on}
          title={L.selectTitle}
          style={{
            ...TRIGGER,
            ...(sel.on ? {
              color: 'var(--anthropic-orange)', border: '1px solid var(--anthropic-orange)',
              background: 'var(--anthropic-orange-dim)',
            } : {}),
          }}
        >
          <CheckSquare size={13} /> {L.select}{sel.on && selected.length > 0 ? ` · ${selected.length}` : ''}
        </button>
      </div>

      {visible.length === 0 && (
        <div style={{ ...surface, padding: 16, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          Every group is hidden. Open <strong style={{ color: 'var(--text-secondary)' }}>Groups</strong> above
          to bring one back — the tasks are still there.
        </div>
      )}

      {/* One CARD per group, each folding on its own. A single table holding every status made the
          whole board one scroll and one thing to collapse; a group is what people actually work in. */}
      {visible.map(g => {
        const s = { color: g.color }
        const isFolded = collapsed.has(g.key)
        return (
          <div key={g.key} style={{ ...surface, overflow: 'hidden', borderLeft: `3px solid ${s.color}` }}>
            <div
              onClick={() => foldGroup(g.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                padding: '9px 11px', background: 'var(--bg-base)',
                minHeight: isMobile ? 44 : 32,
              }}
            >
              {isFolded ? <ChevronRight size={14} color={s.color} /> : <ChevronDown size={14} color={s.color} />}
              {/* The reader's word, not the constant — the picker one control away already said
                  `Em andamento` over the very band this heading called `In progress`. */}
              <span style={{ fontSize: 12.5, fontWeight: 700, color: s.color }}>
                {g.label}
              </span>
              <span style={{ ...microLabel, fontSize: 11 }}>{g.rows.length}</span>
            </div>

            {!isFolded && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: g.rows.length === 0 ? 0 : 760 }}>
                  {/* No heading row over an EMPTY group: eight column names above nothing is eight
                      names for a table that is not there, repeated once per empty status. */}
                  {g.rows.length > 0 && (
                    <thead>
                      <tr>
                        {/* The leading column holds [checkbox — Select mode only][open][chevron].
                            In Select mode its header carries the group's own select-all. */}
                        <th style={{ ...th, width: 1 }}>
                          {sel.on && (
                            <GroupCheck
                              state={groupCheck(sel, g.rows.map(r => r.task.id))}
                              label={L.selectAllInGroup}
                              mobile={isMobile}
                              onChange={checked => setSel(cur => setRows(cur, g.rows.map(r => r.task.id), checked))}
                            />
                          )}
                        </th>
                        <SortTh
                          label={L.taskColumn} sortKey="title" current={sort} mobile={isMobile}
                          onSort={k => setSort(nextSort(sort, k))}
                          title={L.sortByColumn.replace('{column}', L.keys.title!)}
                          style={{ ...th, minWidth: 240 }}
                        />
                        {cols.map(c => (
                          // A column with no `sort` carries NO affordance — a header that looks
                          // clickable and does nothing is worse than a plain one.
                          <SortTh
                            key={c.id} label={colLabel(c.id)} sortKey={c.sort} current={sort} mobile={isMobile}
                            onSort={k => setSort(nextSort(sort, k))}
                            title={L.sortByColumn.replace('{column}', colLabel(c.id))}
                            style={{ ...th, width: c.width, textAlign: c.numeric ? 'right' : 'left' }}
                          />
                        ))}
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {g.rows.map(row => {
                      const open = expanded.has(row.task.id)
                      const detail = p.details.get(row.task.id)
                      // The column FILTER (t-63b7d3b2b0 #2) narrows what is drawn, never `p.subtasks`
                      // itself — same "display only" rule `sort` already follows one line below.
                      const subs = filterSubtaskRows(
                        detail?.subtasks ?? [], detail?.sessions ?? [], subtaskFilter,
                      )
                      // The sub-header row, `SubtaskRows` and the "+ Add subtask" row, sized against
                      // `effectiveCols` — the REAL `cols.length` when they are drawn as rows of this
                      // table (`gridLayout.mode === 'inline'`), or `shownSubtaskCols.length` when
                      // they are drawn inside their OWN nested table (see `subtaskGridLayout.ts`),
                      // which is what makes their filler come out to zero in that case.
                      const renderSubtaskGrid = (effectiveCols: number) => (
                        <>
                          <tr style={{ background: 'var(--bg-surface)' }}>
                            <td style={{ padding: '5px 10px' }} />
                            {/* The title column is always shown — never in the "Subtask columns"
                                picker, exactly like the task table's own leading name column. */}
                            <SortTh
                              label={copy.subtasks} sortKey="title"
                              current={effectiveSubtaskSort(sort, subSort[row.task.id] ?? null)}
                              mobile={isMobile}
                              onSort={k => setSubSort(m => (
                                { ...m, [row.task.id]: pickSubtaskSort(sort, m[row.task.id] ?? null, k) }
                              ))}
                              title={L.sortByColumn.replace('{column}', copy.subtasks)}
                              style={{
                                ...microLabel, fontWeight: 600, padding: '5px 10px', whiteSpace: 'nowrap',
                                paddingLeft: 0,
                              }}
                            />
                            {shownSubtaskCols.map(id => {
                              const def = SUBTASK_COLUMNS.find(c => c.id === id)!
                              const label = copy.subtaskColumns[id]
                              // Sortable like every other header. The grid orders itself by the
                              // EFFECTIVE sort (`subtaskSortInherit.ts`): an explicit click on
                              // THIS grid's own header (`subSort`) if there is one, otherwise
                              // whatever the main table's own sort translates to — so sorting
                              // the board by "Cost" re-sorts every open subtask grid by cost too,
                              // until a reader clicks one of these headers directly. Clusters
                              // survive either way because the renderer rebuilds them from the
                              // sorted list (`subtaskSortView.ts`).
                              return (
                                <SortTh
                                  key={id} label={label} sortKey={subtaskSortKeyFor(id)}
                                  current={effectiveSubtaskSort(sort, subSort[row.task.id] ?? null)}
                                  mobile={isMobile}
                                  onSort={k => setSubSort(m => (
                                    { ...m, [row.task.id]: pickSubtaskSort(sort, m[row.task.id] ?? null, k) }
                                  ))}
                                  title={L.sortByColumn.replace('{column}', label)}
                                  style={{
                                    ...microLabel, fontWeight: 600, padding: '5px 10px', whiteSpace: 'nowrap',
                                    paddingLeft: 10,
                                    textAlign: def.numeric ? 'right' : 'left',
                                  }}
                                />
                              )
                            })}
                            {effectiveCols > shownSubtaskCols.length && (
                              <td colSpan={effectiveCols - shownSubtaskCols.length} />
                            )}
                          </tr>
                          <SubtaskRows
                            subtasks={orderedSubtasks(
                              subs, effectiveSubtaskSort(sort, subSort[row.task.id] ?? null),
                              {
                                views: detail?.subtaskRollups ?? [],
                                sessions: detail?.sessions ?? [],
                                statusOrder: liveStatusOrder(p.statuses),
                              },
                            )}
                            subtaskRollups={detail?.subtaskRollups ?? []}
                            // Was 34 — the gear cell's own right padding (10px, `cellPad`) already
                            // separates the button from the title, so a further 34px was an
                            // unintended ~44-50px gap nobody asked for. A GROUP MEMBER still sits
                            // its own +20 deeper (see the title cell's own note).
                            indent={0} mainCols={effectiveCols} subtaskCols={shownSubtaskCols}
                            sessions={detail?.sessions ?? []}
                            lang={p.lang ?? 'en'}
                            nowMs={nowMs}
                            statuses={p.statuses}
                            onPatch={(id, patch) => p.onPatchSubtask(row.task.id, id, patch)}
                            onRemove={id => p.onRemoveSubtask(row.task.id, id)}
                            onCreateGroup={title => p.onCreateGroupSubtask(row.task.id, title)}
                            onLinkSession={sub => setLinkingSub({ task: row.task.id, sub })}
                            onUnfile={sid => p.onUnfileSession(row.task.id, sid)}
                            onOpenSession={p.onOpenSession}
                            stagedFor={stagedFor(row.task.id, detail?.files ?? [])}
                          />
                          <tr style={{ background: 'var(--bg-surface)' }}>
                            <td style={{ padding: '5px 10px' }} />
                            <td colSpan={effectiveCols + 1} style={{ padding: '5px 10px', paddingLeft: 34 }}>
                              <input
                                value={subDraft[row.task.id] ?? ''}
                                placeholder="+ Add subtask"
                                onChange={e => setSubDraft({ ...subDraft, [row.task.id]: e.target.value })}
                                onClick={e => e.stopPropagation()}
                                onKeyDown={e => {
                                  const v = subDraft[row.task.id] ?? ''
                                  if (e.key === 'Enter' && v.trim()) {
                                    p.onAddSubtask(row.task.id, v.trim())
                                    setSubDraft({ ...subDraft, [row.task.id]: '' })
                                  }
                                }}
                                style={{
                                  width: '100%', maxWidth: 320, background: 'transparent', border: 'none',
                                  outline: 'none', color: 'var(--text-secondary)', fontSize: 12,
                                  fontFamily: 'inherit',
                                }}
                              />
                            </td>
                          </tr>
                        </>
                      )
                      return (
                        <React.Fragment key={row.task.id}>
                          <tr
                            style={{ borderTop: '1px solid var(--border)' }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-card-hover)' }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                          >
                            {/*
                              * The LEADING cell, left to right: [checkbox — Select mode only]
                              * [open the task][chevron that lists the subtasks in place].
                              *
                              * The open button used to be the last cell of the row, a full table
                              * width away from the name it opens; it sits beside the chevron now and
                              * the trailing cell is gone (two controls for one act in one row is a
                              * question of which to press). The row keeps ONE width for this cell
                              * whether or not the task has subtasks — the chevron is always there,
                              * because expanding is also how a first subtask gets added — so the
                              * columns never shift between rows.
                              */}
                            <td style={{ padding: cellPad, whiteSpace: 'nowrap' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: isMobile ? 0 : 4 }}>
                                {sel.on && (
                                  <label
                                    title={L.selectRow}
                                    style={{
                                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                      cursor: 'pointer', ...tap(isMobile),
                                    }}
                                  >
                                    <input
                                      type="checkbox" checked={sel.ids.has(row.task.id)}
                                      aria-label={`${L.selectRow}: ${row.task.title}`}
                                      onChange={() => setSel(cur => toggleRow(cur, row.task.id))}
                                      style={{
                                        width: isMobile ? 20 : 14, height: isMobile ? 20 : 14,
                                        accentColor: 'var(--anthropic-orange)',
                                      }}
                                    />
                                  </label>
                                )}
                                <button
                                  type="button"
                                  onClick={e => { e.stopPropagation(); p.onOpen(row.task.id) }}
                                  title={L.openTask} aria-label={`${L.openTask}: ${row.task.title}`}
                                  style={openBtn}
                                ><SquareArrowOutUpRight size={13} /></button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    toggleIn(expanded, row.task.id, setExpanded)
                                    if (!open) p.onExpand(row.task.id)
                                  }}
                                  aria-expanded={open}
                                  title={open ? L.hideSubtasks : L.showSubtasks}
                                  aria-label={`${open ? L.hideSubtasks : L.showSubtasks}: ${row.task.title}`}
                                  style={openBtn}
                                >{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                              </span>
                            </td>
                            {/* The NAME still opens the subitems, as it always did — the row's name
                                belongs to the row, and pressing it never leaves the board. It is a
                                pointer convenience over the chevron's button, not a second tab stop. */}
                            <td style={{ padding: cellPad }}>
                              <span
                                role="presentation"
                                onClick={() => {
                                  toggleIn(expanded, row.task.id, setExpanded)
                                  if (!open) p.onExpand(row.task.id)
                                }}
                                style={{
                                  display: 'block', cursor: 'pointer', minWidth: 0, textAlign: 'left',
                                  fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                  ...(isMobile ? { minHeight: 44, lineHeight: '44px' } : {}),
                                }}
                              >
                                {row.task.title}
                              </span>
                            </td>
                            {cols.map(c => (
                              <td
                                key={c.id}
                                style={{ padding: cellPad, textAlign: c.numeric ? 'right' : 'left' }}
                              >
                                {cellFor(
                                  c.id, row,
                                  st => p.onStatus(row.task.id, st),
                                  pr => p.onPriority?.(row.task.id, pr),
                                  nowMs,
                                  p.lang ?? 'en',
                                  money,
                                  p.statuses,
                                  p.types,
                                  t => p.onType?.(row.task.id, t),
                                  copy.types.none,
                                )}
                              </td>
                            ))}
                          </tr>

                          {open && (
                            gridLayout.mode === 'inline'
                              ? renderSubtaskGrid(cols.length)
                              : (
                                // Fewer main columns shown than the subtask grid's own current
                                // column count: its fixed cells alone would already overshoot the
                                // main row's `cols.length + 2`, so instead of drawing more rows of
                                // THIS table it gets ONE row — a leading cell plus a single cell
                                // spanning the rest (matching the "+ Add subtask" row's own
                                // `colSpan={cols.length + 1}` right below it) — holding its own
                                // nested table, sized as though there were exactly
                                // `shownSubtaskCols.length` columns (so ITS filler comes out to
                                // zero) and scrolling horizontally inside itself rather than ever
                                // widening the outer one.
                                <tr style={{ background: 'var(--bg-surface)' }}>
                                  <td style={{ padding: '5px 10px' }} />
                                  <td colSpan={cols.length + 1} style={{ padding: '6px 10px' }}>
                                    <div style={{ overflowX: 'auto' }}>
                                      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
                                        <tbody>{renderSubtaskGrid(shownSubtaskCols.length)}</tbody>
                                      </table>
                                    </div>
                                  </td>
                                </tr>
                              )
                          )}
                        </React.Fragment>
                      )
                    })}

                    <tr style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: cellPad }} />
                      <td colSpan={cols.length + 1} style={{ padding: cellPad }}>
                        {adding === g.key ? (
                          <input
                            autoFocus value={draft} placeholder="Task name, then Enter"
                            onChange={e => setDraft(e.target.value)}
                            onBlur={() => { setAdding(null); setDraft('') }}
                            onKeyDown={e => {
                              if (e.key === 'Escape') { setAdding(null); setDraft('') }
                              if (e.key === 'Enter' && draft.trim()) {
                                p.onCreate(draft.trim(), g.createStatus, g.createType)
                                setDraft(''); setAdding(null)
                              }
                            }}
                            style={{
                              width: '100%', maxWidth: 360, background: 'transparent',
                              border: 'none', outline: 'none', color: 'var(--text-primary)',
                              fontSize: 12.5, fontFamily: 'inherit',
                            }}
                          />
                        ) : (
                          <button
                            onClick={() => { setAdding(g.key); setDraft('') }}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                              color: 'var(--text-tertiary)', fontSize: 12,
                              display: 'inline-flex', alignItems: 'center', gap: 5,
                              minHeight: isMobile ? 44 : 20,
                            }}
                          ><Plus size={12} /> Add</button>
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}

      <ConfirmModal
        open={confirmBatch}
        title={`Delete ${selected.length} task${selected.length === 1 ? '' : 's'}?`}
        message="Their comments, subtasks, files and links go with them. The SESSIONS filed under them are kept — deleting a board entry never deletes work."
        confirmLabel={`Delete ${selected.length}`}
        cancelLabel="Keep them"
        // Typing the count is the guard against a muscle-memory delete of a whole selection: the
        // one gesture on this board that can take many rows at once.
        requireText={selected.length > 1 ? String(selected.length) : undefined}
        requireTextHint={selected.length > 1 ? `Type ${selected.length} to confirm` : undefined}
        onCancel={() => setConfirmBatch(false)}
        onConfirm={() => {
          setConfirmBatch(false)
          p.onBatchDelete([...selected])
          setSel(clearTicks)
        }}
      />

      {linkingSub && (
        <SessionPicker
          // A subtask holds any number of sessions, so the picker is MULTIPLE and the attaches are
          // sequential — each one read-modify-writes the same store.
          onPick={async ids => {
            for (const id of ids) await p.onLinkSession(linkingSub.task, linkingSub.sub, id)
          }}
          onClose={() => setLinkingSub(null)}
        />
      )}

      {stagedDialogs.element}
      {fire.element}

      {sel.on && selected.length > 0 && (
        // Monday's batch bar: it says how many, and it carries only the verbs that make sense on
        // many rows at once. Renaming many is not one of them.
        <div style={{
          position: 'fixed', left: '50%', transform: 'translateX(-50%)',
          bottom: isMobile ? 'calc(var(--mobile-nav-h) + 12px)' : 20, zIndex: 50,
          ...surface, background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-elevated)',
          padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          maxWidth: 'min(92vw, 620px)',
        }}>
          <span style={{ ...numeric, fontSize: 13, color: 'var(--text-primary)' }}>
            {selected.length}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>selected</span>
          <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
          {/* One SELECT, not seven buttons: the bar is the same act as the row's status cell, and
              two shapes for one act is two things to learn. `__none__` is the resting label — the
              control has no current value, it only sets one. */}
          <span style={{ minWidth: 150 }}>
            <ChipSelect
              value="__none__"
              options={[
                { value: '__none__', label: 'Move to…', color: 'var(--text-secondary)', dim: 'var(--bg-elevated)' },
                ...statusOptions(liveStatusMap(p.statuses), liveStatusOrder(p.statuses)),
              ]}
              onPick={v => {
                if (v === '__none__') return
                p.onBatchStatus([...selected], v as TaskStatus)
                setSel(clearTicks)
              }}
            />
          </span>
          <button
            onClick={() => setConfirmBatch(true)}
            style={{ ...button(isMobile), color: 'var(--accent-red)', height: isMobile ? 34 : 26 }}
          ><Trash2 size={13} /></button>
          <button
            onClick={() => setSel(clearTicks)}
            aria-label="Clear the selection" title="Clear the selection"
            style={{
              background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
              display: 'inline-flex', ...tap(isMobile),
            }}
          ><X size={14} /></button>
        </div>
      )}
    </div>
  )
}

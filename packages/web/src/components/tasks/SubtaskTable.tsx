/**
 * SubtaskTable — the subtasks, as the SAME grid the table view expands inside a row.
 *
 * One component drawn in two places, deliberately: a subtask that shows every column on the board
 * and only some of them on the detail page is two different records as far as the reader is
 * concerned, and the one with fewer columns teaches people the fields do not exist. (`TaskTable.tsx`'s
 * inline subitem rows mirror the base columns — Cost and Tokens included — plus the group-forming
 * controls below.)
 *
 * A subtask carries a SESSION — which piece of work is being done where — and now a ROLLUP of its
 * own: cost, rounds and tokens are still measured per SESSION, never stored on the subtask itself,
 * but the server's `subtaskViews()` (`task-report.ts`) sums a subtask's own sessions the same way
 * `attemptViews()` sums an attempt's, as a partition of the task's rows rather than a second count
 * of them — nothing here double-counts a session or invents a split the data does not record. See
 * docs/superpowers/specs/2026-09-10-task-session-hierarchy-design.md §4.2.
 *
 * **Subtask GROUPS (§F.1 of docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md) are a real
 * hierarchy level, not a label two subtasks share** — a peer row in this same table, never a nested
 * sub-list. A GROUP is the only thing in its branch that may hold a session; a MEMBER never carries
 * one (refused server-side, `subtask_in_group`) and therefore has no rollup bucket of its own at all
 * — `subtaskRollupOf` returns `undefined` for it by construction, which already renders as the fully
 * empty cost/tokens cells below, the same convention every untracked subtask uses. The
 * create/join/leave/dissolve gestures live in `SubtaskActionsMenu`'s leading gear now (see its own
 * doc comment); `subtaskGroups.ts` holds the pure reads (`isGroupSubtask`/`isGroupMember`/`groupOf`/
 * candidate lists) that component and `TaskTable.tsx` share.
 *
 * **The rows CLUSTER, they do not just carry a caption** (product feedback, 2026-09-19: a caption
 * under a member row was the ONLY signal that it belonged to a group, which reads as a flat list
 * with a label rather than one connected unit). `clusterSubtaskRows` (`subtaskGroups.ts`) reorders
 * the DISPLAY only — never `p.subtasks` itself, never a write — so every member renders directly
 * under its group regardless of creation order (the common case is grouping two subtasks that
 * already exist, so the group's own row is usually the newest and would otherwise land at the
 * bottom with its members scattered above it). A clustered row gets an inset left bar plus a shared
 * background tint (`clusterBarStyle`/`clusterTintStyle`) running unbroken from the group's header
 * through its last member, and a member's title cell is indented under it — the caption is dropped
 * for a properly clustered member (the position and the bar already say it) and kept only for an
 * ORPHANED one (`groupOf` returns `undefined`: its group is gone, so there is no cluster to place it
 * in and the words are the only thing left saying where it came from).
 *
 * The Cost/Tokens columns below read `p.subtaskRollups` through `subtaskRollupOf`, which resolves by
 * the subtask's OWN id, always (`rollupKeyOf` — the legacy `groupId`-based union §B once used is
 * superseded and inert) — and render them through `CostCellView`/`TokensCellView`
 * (`SubtaskMoneyCells.tsx`), the ONE rendering `TaskTable.tsx`'s own inline subitem rows draw too —
 * a second formatting rule for the same figure is exactly what this codebase forbids (see
 * `CLAUDE.md`'s "Calculation functions — single source of truth"). A subtask with no session filed
 * yet still gets a bucket from the server (`sessionsUsed: 0`, every metric `null`), and that renders
 * as an EMPTY cell — no field at all, not even "N/A" — through `costCellFor`/`tokensCellFor`'s
 * `isUntracked` check: metric tracking starts the moment a session is actually linked, not before.
 * "N/A" is reserved for a session that IS linked but whose figure genuinely cannot be produced. See
 * `subtaskRollup.ts`.
 *
 * The `id: null` direct-branch bucket (sessions filed straight on the delivery, under no subtask —
 * see `task-attach.ts` and docs/superpowers/specs/2026-09-10-task-session-hierarchy-design.md §4.1)
 * is drawn as a FOOTER row below the subtask rows, styled distinctly (no status chip, no due date —
 * it is not a piece of planned work, it is "everything not broken out") and only when the server
 * actually reports one — a task with no direct sessions gets no footer row at all, per §4.4.
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import {
  commentCounts, cycleSort, type StagedSessionDraft, type SubtaskSortKey, type SubtaskSortSpec, type TaskStatusDef,
} from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  liveStatusOrder, microLabel, pill,
  statusStyle, surface, type BoardStatus,
} from './board'
import { SessionPicker } from './SessionPicker'
import { DoneNeedsSessionDialog } from './DoneNeedsSessionDialog'
import { TaskProgressBar } from './TaskProgressBar'
import { CommentCountButton } from './CommentThreadDialog'
import { SubtaskActionsMenu } from './SubtaskActionsMenu'
import {
  clusterBarStyle, clusterSubtaskRows, clusterTintStyle, groupMembers, groupOf, isGroupMember,
  isGroupSubtask, visibleClusterRows,
} from './subtaskGroups'
import { SessionRef } from './SessionRef'
import { SortTh } from './SortHeader'
import { orderedSubtasks } from './subtaskSortView'
import { useStagedDialogs, type StagedTarget } from './useStagedDialogs'
import { boardCopy, statusLabel, type Lang } from './copy'
import { useMoney } from './money'
import { costCellFor, tokensCellFor } from './subtaskRollup'
import { CostCellView, TokensCellView } from './SubtaskMoneyCells'
import { ModelCellView } from './SubtaskModelCell'
import { PickerMenu } from './PickerMenu'
import { StatusChip } from './StatusChip'
import { ViewBar, ViewSortMenu, segmentBadge, viewSegment } from './ViewBar'
import { useBoardPref } from './boardPrefs'
import { DEFAULT_SUBTASK_COLUMNS, SUBTASK_COLUMNS, type SubtaskColumnId } from './subtaskColumnDefs'
import { subtaskColumnCell } from './subtaskColumnCell'
import { EMPTY_SUBTASK_FILTER, filterSubtaskRows, type SubtaskFilterState } from './subtaskFilter'
import { SubtaskFilterMenu } from './SubtaskFilterMenu'
import type {
  StagedSessionWriteResult, StatusWriteResult, Subtask, SubtaskPatch, SubtaskView,
  TaskComment, TaskFile, TaskSessionRow, TaskStatus,
} from '../../lib/tasks'

/** `SubtaskColumnId` and `SubtaskSortKey` (`@agentistics/core`) name the same seven legacy columns
 *  by the same string — `model` is the one column with no sort key at all (there is nothing on the
 *  server to sort a raw session field by), so its header carries no click affordance, the same rule
 *  `TaskTable.tsx`'s own `cellFor` applies to any column with no `sort` in its `ColumnDef`. */
function subtaskSortKeyFor(id: SubtaskColumnId): SubtaskSortKey | undefined {
  return id === 'model' || id === 'progress' ? undefined : (id as SubtaskSortKey)
}

const cell: React.CSSProperties = { padding: '7px 9px', borderTop: '1px solid var(--border)' }
const bare: React.CSSProperties = {
  width: '100%', background: 'transparent', border: 'none', outline: 'none',
  color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'inherit',
}

export interface SubtaskTableProps {
  subtasks: Subtask[]
  /** The DELIVERY's sessions. Each row shows the ones filed under it — see `SubtaskSessions`. */
  sessions: readonly TaskSessionRow[]
  /** One rollup per subtask, plus the `id: null` direct-branch bucket drawn as the footer row —
   *  `TaskDetail.subtaskRollups`, straight off the server's `subtaskViews()`. */
  subtaskRollups: readonly SubtaskView[]
  lang: Lang
  /** The board's LIVE status list (`lib/tasks.ts`'s `useTaskStatuses`) — `null` while it loads. */
  statuses: readonly TaskStatusDef[] | null
  onAdd: (title: string) => void | Promise<void>
  /** Returns the write's outcome — the status pick below needs it to catch `done_needs_session`
   *  and open the resolution dialog, rather than swallow the refusal like every other patch; the
   *  group menu needs it the same way for `invalid_group`/`subtask_has_sessions`/
   *  `group_field_conflict` (§F.1). Generic over id, so the group menu can patch a SIBLING (the one
   *  being joined) as well as this row. */
  onPatch: (id: string, patch: SubtaskPatch) => Promise<StatusWriteResult>
  onRemove: (id: string) => void | Promise<void>
  /** Mint a new GROUP subtask (§F.1) and return its id, or `null` on failure — the first step of
   *  "create a group with…", which then joins both the picked sibling and the row it started from
   *  to it. */
  onCreateGroup: (title: string) => Promise<string | null>
  /** File a session under a subtask. */
  onAttach: (subtaskId: string, sessionId: string) => void | Promise<void>
  /** Take a session out of wherever it is filed. */
  onUnfile: (sessionId: string) => void | Promise<void>
  /** Open a session's own screen. Absent renders the reference as a label. */
  onOpenSession?: (sessionId: string) => void
  /**
   * The staged-session draft (t-918cc82233) — a dormant session composed ahead of time on a loose
   * subtask or a group, fired later. Never offered on a group MEMBER (`isGroupMember`): a member can
   * never hold a session of its own, so a draft that could never be fired there is refused at the
   * same point `task-attach.ts`'s `subtask_in_group` already refuses filing a real one.
   */
  taskFiles: readonly TaskFile[]
  onUploadFile: (file: File) => Promise<string | null>
  onSaveStagedSession: (subtaskId: string, draft: StagedSessionDraft) => Promise<StagedSessionWriteResult>
  onClearStagedSession: (subtaskId: string) => void | Promise<void>
  /** Fire an EXISTING draft — the caller decides the direct-launch-vs-wizard-fallback path (see
   *  `DeliveryDetail`'s `startFire`), since only it holds the navigation this can end in. */
  onFireStagedSession: (subtask: Subtask) => void
  /** The subtask whose attachments are being materialized into real paths right now, so its Fire
   *  button reads busy instead of looking inert during the brief round trip. */
  preparingStagedSessionId?: string | null
  /** The delivery's comments — each row shows its THREAD's count (`commentCounts`: a group's
   *  includes its members'). Absent = no comment control on the rows. */
  comments?: readonly TaskComment[]
  /** Open one subtask's or group's thread. */
  onOpenComments?: (subtask: Subtask) => void
}

export function SubtaskTable(p: SubtaskTableProps) {
  const isMobile = useIsMobile()
  const copy = boardCopy(p.lang)
  const money = useMoney()
  // Only feeds `fmtDateTime`'s "is this the same calendar year" check — that answer does not need
  // to tick, unlike the lease countdown `TaskTable`'s own `nowMs` state exists for.
  const nowMs = Date.now()
  const threadCounts = commentCounts(p.comments ?? [], p.subtasks).bySubtask
  const [draft, setDraft] = useState('')
  const [linking, setLinking] = useState<string | null>(null)
  /** Set when a status write refused `done` for having no session filed yet — see
   *  `DoneNeedsSessionDialog`. Named so its shortcut can reopen `SessionPicker` for the SAME row. */
  const [doneRefusal, setDoneRefusal] = useState<{ id: string; title: string } | null>(null)
  // The staged-session draft's dialogs — shared with `TaskTable`'s inline rows (`useStagedDialogs`).
  const stagedDialogs = useStagedDialogs<StagedTarget>(p.lang, {
    save: (t, d) => p.onSaveStagedSession(t.subtask.id, d),
    clear: t => p.onClearStagedSession(t.subtask.id),
    upload: (_t, f) => p.onUploadFile(f),
  })
  const target = (t: Subtask): StagedTarget => ({ subtask: t, files: p.taskFiles })
  /**
   * Which GROUPS are showing their members (product feedback, 2026-09-21: "por padrão sempre vem
   * minimizado os grupos e o usuário escolhe expandir") — a group with at least one member starts
   * COLLAPSED, the same accordion `TaskTable`'s own task-row expansion already uses one level up.
   * Never persisted and never seeded from anything remembered: the same "a mode nobody chose must
   * not still be armed tomorrow" reasoning this board already applies to Select mode — a fresh
   * mount starts every group closed again.
   */
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const toggleGroup = (groupId: string) => setExpandedGroups(prev => {
    const next = new Set(prev)
    next.has(groupId) ? next.delete(groupId) : next.add(groupId)
    return next
  })
  // Icon-only, small on purpose — `.ag-tap-icon` (index.css) projects the mobile 44px hit area
  // around it without painting a 44x44 box in a table cell that has no room to spare.
  const chevronBtn: React.CSSProperties = {
    background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0,
    flexShrink: 0, minWidth: 18, minHeight: 18,
  }
  const staged = boardCopy(p.lang).staged
  const L = boardCopy(p.lang).list
  /**
   * The order a column title asked for. `null` is creation order — the list as it came, and the way
   * back from any sort. Display only: it reorders what is DRAWN (and the cluster is rebuilt from the
   * sorted list, so a group and its members stay together), never `p.subtasks` and never a write.
   */
  const [sort, setSort] = useState<SubtaskSortSpec | null>(null)
  // Which columns are shown, in the order they were picked (t-63b7d3b2b0 #1) — read LIVE from the
  // per-person board arrangement (server-side, `boardPrefs.ts`), the same slot `TaskTable.tsx`'s
  // inline subtask grid writes, so both surfaces always draw the same columns.
  const [storedCols, setColumns] = useBoardPref('subtaskColumns')
  const shownCols: SubtaskColumnId[] = storedCols ?? DEFAULT_SUBTASK_COLUMNS
  /** The column filter (t-63b7d3b2b0 #2) — ephemeral, like the sort above: it narrows this one look
   *  at the grid and is never remembered across a remount. */
  const [filter, setFilter] = useState<SubtaskFilterState>(EMPTY_SUBTASK_FILTER)
  /** Group header rows per status ("Em andamento · 3"). Ephemeral like the filter and the sort: it
   *  shapes this one look at the grid. On by default — the board's own vocabulary is its statuses. */
  const [groupByStatus, setGroupByStatus] = useState(true)
  const filtered = filterSubtaskRows(p.subtasks, p.sessions, filter)
  const ordered = orderedSubtasks(filtered, sort, {
    views: p.subtaskRollups,
    sessions: p.sessions,
    statusOrder: liveStatusOrder(p.statuses),
  })
  const colCount = 3 + shownCols.length

  const pickStatus = async (t: Subtask, status: TaskStatus) => {
    const result = await p.onPatch(t.id, { status })
    if (!result.ok && result.reason === 'done_needs_session') {
      setDoneRefusal({ id: t.id, title: t.title })
    }
  }

  const done = p.subtasks.filter(t => t.done).length

  // The visible rows (clusters already folded), optionally bucketed under one header row per
  // status. A cluster — a GROUP and its members — travels together under the GROUP's status, so
  // grouping never tears a group apart; the buckets follow the board's own status order.
  type RowItem =
    | { kind: 'head'; status: string; color: string; count: number }
    | { kind: 'row'; row: ReturnType<typeof visibleClusterRows>[number] }
  const visibleRows = visibleClusterRows(clusterSubtaskRows(ordered), expandedGroups)
  const rowItems: RowItem[] = []
  if (!groupByStatus) {
    for (const row of visibleRows) rowItems.push({ kind: 'row', row })
  } else {
    const clusters: Array<typeof visibleRows> = []
    for (const row of visibleRows) {
      if (row.depth === 0 || clusters.length === 0) clusters.push([row])
      else clusters[clusters.length - 1]!.push(row)
    }
    const order = liveStatusOrder(p.statuses)
    const rank = (st: string) => { const i = order.indexOf(st as BoardStatus); return i === -1 ? order.length : i }
    const sorted = clusters
      .map((c, i) => ({ c, i }))
      .sort((a, b) => rank(a.c[0]!.subtask.status) - rank(b.c[0]!.subtask.status) || a.i - b.i)
      .map(x => x.c)
    let last: string | null = null
    for (const c of sorted) {
      const st = c[0]!.subtask.status
      if (st !== last) {
        last = st
        rowItems.push({
          kind: 'head', status: st, color: statusStyle(p.statuses, st).color,
          count: sorted.filter(x => x[0]!.subtask.status === st).length,
        })
      }
      for (const row of c) rowItems.push({ kind: 'row', row })
    }
  }

  // The direct-branch footer row — sessions filed straight on the delivery, under no subtask.
  // `subtaskRollupOf` only resolves a SUBTASK's bucket (it takes `{ id, groupId }`, never `null`),
  // so the `id: null` view is read straight off the list here instead. Never affected by the column
  // FILTER above — it is not a subtask, so a status/harness/model filter has nothing on it to judge
  // (see `subtaskFilter.ts`'s own header on why a filter never touches this bucket).
  const directView = p.subtaskRollups.find(v => v.id === null)
  const directSessions = p.sessions.filter(s => s.subtaskId === null)
  const directCost = costCellFor(directView?.rollup)
  const directTok = tokensCellFor(directView?.rollup)

  // Desktop only: the header row stays put while the grid's own box scrolls (see the box below).
  const stickyHead: React.CSSProperties = isMobile
    ? {}
    : { position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-card)' }

  return (
    <div style={{ ...surface, overflowX: 'auto' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', flexWrap: 'wrap',
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={microLabel}>{copy.subtasks}</span>
        {/* The shared bar — it rounds DOWN, so this one cannot say 100% while the grid below it
            still shows an open row. That disagreement is exactly what one component prevents. */}
        <div style={{ flex: 1, maxWidth: 220 }}>
          <TaskProgressBar done={done} total={p.subtasks.length} />
        </div>
        {/* The grid's own controls: ONE bar — Filter · Group · Columns · Sort — whose segments open
            the existing menus in the same portal panel (see `ViewBar.tsx`). */}
        <span style={{ flex: 1 }} />
        <ViewBar label={copy.viewBar.filter + ' · ' + copy.viewBar.group + ' · ' + copy.viewBar.columns + ' · ' + copy.viewBar.sort}>
          <SubtaskFilterMenu
            value={filter} onChange={setFilter} sessions={p.sessions} statuses={p.statuses} lang={p.lang}
            label={copy.viewBar.filter} noIcon
            triggerStyle={viewSegment(isMobile)}
            activeTriggerStyle={viewSegment(isMobile, true)}
          />
          <PickerMenu
            title={copy.viewBar.group}
            lang={p.lang}
            width={210}
            triggerStyle={viewSegment(isMobile, groupByStatus)}
            items={[
              { value: 'none', label: copy.viewBar.groupNone },
              { value: 'status', label: copy.viewBar.groupStatus },
            ]}
            value={[groupByStatus ? 'status' : 'none']}
            onChange={next => {
              // Single choice over the multi-select list: the row that is not current wins.
              const picked = next.find(v => v !== (groupByStatus ? 'status' : 'none'))
              if (picked) setGroupByStatus(picked === 'status')
            }}
          >{copy.viewBar.group}{groupByStatus ? `: ${copy.subtaskColumns.status.toLowerCase()}` : ''}</PickerMenu>
          <PickerMenu
            title={copy.pickers.columnsTitle}
            lang={p.lang}
            width={230}
            orderable
            triggerStyle={viewSegment(isMobile)}
            items={SUBTASK_COLUMNS.map(c => ({ value: c.id, label: copy.subtaskColumns[c.id] }))}
            value={shownCols}
            onChange={next => setColumns(next as SubtaskColumnId[])}
            note={copy.pickers.columnsNote}
          >
            {copy.viewBar.columns}
            {shownCols.length !== SUBTASK_COLUMNS.length && (
              <span style={segmentBadge}>{shownCols.length}</span>
            )}
          </PickerMenu>
          <ViewSortMenu
            label={copy.viewBar.sort}
            title={copy.viewBar.sortBy}
            options={[
              { key: 'title' as SubtaskSortKey, label: copy.subtasks },
              ...shownCols.flatMap(id => {
                const k = subtaskSortKeyFor(id)
                return k ? [{ key: k, label: copy.subtaskColumns[id] }] : []
              }),
            ]}
            current={sort}
            onChange={setSort}
            defaultLabel={copy.viewBar.sortDefault}
            ascLabel={copy.viewBar.asc}
            descLabel={copy.viewBar.desc}
            note={copy.viewBar.sortNote}
          />
        </ViewBar>
      </div>

      {/* The grid's OWN scroll box. Its last column (Tokens) was cut off at 1440: a flat 760px table
          minimum plus a 180px title and a 190px sessions cell overran the task page's 742px column,
          and the horizontal scrollbar that could reach it sat under every row — on a 47-row task,
          two screens below the cut. Now (1) no fixed table minimum and tighter cell minimums, so a
          six-column arrangement fits outright, and (2) on desktop the box is bounded in height, so
          an arrangement wider than the column (the default eight are ~890px) keeps its scrollbar
          on screen, with the header row sticky so the columns stay named while it scrolls. A phone
          swipes sideways and has no scrollbar to lose, so it keeps the page's own vertical scroll —
          a nested one there traps the thumb. */}
      <div style={isMobile ? { overflowX: 'auto' } : { maxHeight: '70vh', overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {/* The leading '' is the gear-menu column (`SubtaskActionsMenu`) — no header text, same
                convention the old trailing actions column used, and no sort: nothing to order by. */}
            <th style={{ ...microLabel, padding: '6px 9px', fontWeight: 600, ...stickyHead }} />
            {/* The title column is always shown — the row's own name, never in the "Columns"
                picker, exactly like `TaskTable.tsx`'s own leading name column. */}
            <SortTh
              label={copy.subtasks} sortKey="title" current={sort} mobile={isMobile}
              onSort={k => setSort(cycleSort(sort, k))}
              title={L.sortByColumn.replace('{column}', copy.subtasks)}
              style={{ ...microLabel, padding: '6px 9px', fontWeight: 600, whiteSpace: 'nowrap', ...stickyHead }}
            />
            {shownCols.map(id => {
              const def = SUBTASK_COLUMNS.find(c => c.id === id)!
              const sortKey = subtaskSortKeyFor(id)
              return (
                <SortTh
                  key={id}
                  label={boardCopy(p.lang).subtaskColumns[id]}
                  sortKey={sortKey}
                  current={sort}
                  mobile={isMobile}
                  onSort={k => setSort(cycleSort(sort, k))}
                  title={L.sortByColumn.replace('{column}', boardCopy(p.lang).subtaskColumns[id])}
                  align={def.numeric ? 'right' : 'left'}
                  style={{
                    ...microLabel, padding: '6px 9px', fontWeight: 600, whiteSpace: 'nowrap',
                    textAlign: def.numeric ? 'right' : 'left', ...stickyHead,
                  }}
                />
              )
            })}
            {/* Trailing actions column — no title, no sort: nothing to order by. */}
            <th style={{ ...microLabel, padding: '6px 9px', fontWeight: 600, ...stickyHead }} />
          </tr>
        </thead>
        <tbody>
          {ordered.length === 0 && (
            <tr>
              <td colSpan={colCount} style={{ ...cell, fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.55 }}>
                {p.subtasks.length === 0 ? copy.nothingBrokenOut : boardCopy(p.lang).subtaskFilter.noMatch}
              </td>
            </tr>
          )}
          {rowItems.map(item => {
            if (item.kind === 'head') {
              return (
                <tr key={`head:${item.status}`}>
                  <td colSpan={colCount} style={{
                    ...cell, background: 'var(--bg-surface)', fontSize: 11.5, fontWeight: 600,
                    color: 'var(--text-secondary)', padding: '6px 10px',
                  }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: item.color }} />
                      {statusLabel(item.status, p.lang, p.statuses)} · {item.count}
                    </span>
                  </td>
                </tr>
              )
            }
            const { subtask: t, depth, clustered } = item.row

            // A GROUP MEMBER (§F.1) never carries a session of its own — refused server-side
            // (`subtask_in_group`) — so it has no rollup bucket at all (`subtaskViews` excludes it
            // outright), which `subtaskColumnCell`'s own cost/tokens cases already read as the
            // fully empty cell — the same "nothing filed here yet" convention every untracked
            // subtask uses, never a fake zero.
            const isMember = isGroupMember(t)
            const isGroup = isGroupSubtask(t)
            const view = p.subtaskRollups.find(v => v.id === t.id)
            // Only an ORPHANED member reaches this — a properly clustered one (`clustered === true`)
            // is drawn directly under its group by `clusterSubtaskRows`, and the position plus the
            // bar/tint below already say where it belongs; the caption would just repeat that.
            const parentGroup = isMember && !clustered ? groupOf(t, p.subtasks) : undefined
            const tint = clusterTintStyle(clustered)
            // A non-empty group's own header — `clustered` is only ever true on a group row when it
            // HAS members (see `clusterSubtaskRows`), so this is exactly the accordion toggle.
            const isGroupHeader = isGroup && clustered
            const groupOpen = expandedGroups.has(t.id)
            const memberCount = isGroupHeader ? groupMembers(t.id, p.subtasks).length : 0
            return (
            <tr key={t.id}>
              {/* The leading cell carries only the cluster's inset bar (`clusterBarStyle`) — the leading
                  edge of every clustered row, header through last member, so it reads as one
                  continuous stripe. The row's actions moved to the trailing cell, where they show
                  on hover/focus (and always on touch). */}
              <td style={{ ...cell, width: 1, padding: 0, ...tint, ...clusterBarStyle(clustered) }} />
              {/* A MEMBER is indented one level under its group's header — the visual nesting that
                  replaces the old "parte do grupo" caption for every properly clustered row. */}
              <td style={{ ...cell, minWidth: isMobile ? 150 : 280, width: isMobile ? undefined : '100%', ...tint, ...(depth === 1 ? { paddingLeft: 30 } : {}) }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {/* The accordion toggle — collapsed by default (product feedback, 2026-09-21),
                      the same chevron interaction `TaskTable`'s own task-row expansion already
                      uses one level up. A separate button, never the title input itself: the title
                      is an editable field and clicking into it must focus it, not fold the group. */}
                  {isGroupHeader && (
                    <button
                      type="button"
                      onClick={() => toggleGroup(t.id)}
                      aria-expanded={groupOpen}
                      aria-label={groupOpen
                        ? (p.lang === 'pt' ? `Recolher grupo: ${t.title}` : `Collapse group: ${t.title}`)
                        : (p.lang === 'pt' ? `Expandir grupo: ${t.title}` : `Expand group: ${t.title}`)}
                      title={groupOpen
                        ? (p.lang === 'pt' ? 'Recolher grupo' : 'Collapse group')
                        : (p.lang === 'pt' ? 'Expandir grupo' : 'Expand group')}
                      className="ag-tap-icon"
                      style={chevronBtn}
                    >{groupOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                  )}
                  <input
                    defaultValue={t.title}
                    onBlur={e => { if (e.target.value.trim() !== t.title) void p.onPatch(t.id, { title: e.target.value }) }}
                    style={{
                      ...bare, flex: 1, minWidth: 0,
                      color: t.done ? 'var(--text-tertiary)' : 'var(--text-primary)',
                      textDecoration: t.done ? 'line-through' : 'none',
                      fontSize: 12.5,
                      // A GROUP's header reads as a container's title, not another row — the bar and
                      // tint carry most of it, but the weight is what makes it read as a HEADING when
                      // the row is scanned rather than compared cell-by-cell against its neighbours.
                      fontWeight: isGroup && clustered ? 700 : undefined,
                    }}
                  />
                </div>
                {/* Collapsed, the header still says how many members are folded away — the whole
                    point of the accordion is scanning many groups without opening each one. Gone
                    the instant it opens: the members below already say it better. */}
                {isGroupHeader && !groupOpen && (
                  <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {memberCount} {memberCount === 1
                      ? (p.lang === 'pt' ? 'subtarefa' : 'subtask')
                      : (p.lang === 'pt' ? 'subtarefas' : 'subtasks')}
                  </div>
                )}
                {/* A GROUP's own progress, from its members' `status` (§F.1's `groupProgress`) —
                    the same round-down bar the header above draws for the whole task, one
                    hierarchy level down. Absent when the group has no members yet. Kept visible
                    whether the group is open or closed — completion is worth seeing at a glance. */}
                {isGroup && view?.groupProgress && (
                  <TaskProgressBar done={view.groupProgress.done} total={view.groupProgress.total} height={3} />
                )}
                {/* An ORPHANED member only (its group is gone from this list) — the one case with no
                    cluster to place it in, so the words are the only thing left saying where it came
                    from. A properly clustered member says nothing here; its position already does. */}
                {isMember && !clustered && (
                  <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {p.lang === 'pt' ? 'parte do grupo: ' : 'part of group: '}
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {parentGroup?.title ?? (p.lang === 'pt' ? '(não encontrado)' : '(not found)')}
                    </span>
                  </div>
                )}
                {/* The one status badge that stays glanceable at a glance, per the product
                    feedback — the fire/edit actions BEHIND it moved into the gear menu above,
                    but "is this one ready to go" is a fact worth seeing without opening anything. */}
                {!isMember && t.stagedSession && (
                  <div style={{ marginTop: 3 }}>
                    <span style={{ ...pill('var(--anthropic-orange)'), fontSize: 9.5 }}>{staged.ready}</span>
                  </div>
                )}
              </td>
              {shownCols.map(id => {
                const def = SUBTASK_COLUMNS.find(c => c.id === id)!
                return (
                  <td
                    key={id}
                    style={{
                      ...cell, ...tint, whiteSpace: id === 'model' ? undefined : 'nowrap',
                      minWidth: id === 'sessions' ? 160 : id === 'status' ? 90 : undefined,
                      textAlign: def.numeric ? 'right' : 'left',
                    }}
                  >
                    {id === 'status'
                      ? (
                        <StatusChip
                          value={t.status} lang={p.lang} statuses={p.statuses} compact block={false}
                          onPick={st => void pickStatus(t, st)}
                        />
                      )
                      : subtaskColumnCell(id, {
                        subtask: t, isMember, sessions: p.sessions, subtaskRollups: p.subtaskRollups,
                        lang: p.lang, nowMs, isMobile, money,
                        onLink: setLinking, onUnfile: sid => void p.onUnfile(sid), onOpenSession: p.onOpenSession,
                      })}
                  </td>
                )
              })}
              {/* Row actions: the thread (a count that is always readable) and the ⋯ menu, which
                  appears on hover / keyboard focus and stays put on touch (`.ag-row-actions`). */}
              <td style={{ ...cell, ...tint, width: 1, whiteSpace: 'nowrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {p.onOpenComments && (
                    <CommentCountButton
                      count={threadCounts[t.id] ?? 0}
                      label={p.lang === 'pt' ? `Comentários: ${t.title}` : `Comments: ${t.title}`}
                      mobile={isMobile}
                      onOpen={() => p.onOpenComments?.(t)}
                    />
                  )}
                  <span className="ag-row-actions" style={{ display: 'inline-flex' }}>
                    <SubtaskActionsMenu
                      subtask={t}
                      siblings={p.subtasks}
                      lang={p.lang}
                      statuses={p.statuses}
                      onPatch={p.onPatch}
                      onCreateGroup={p.onCreateGroup}
                      onRemove={p.onRemove}
                      staged={{
                        hasDraft: Boolean(t.stagedSession),
                        preparing: p.preparingStagedSessionId === t.id,
                        onCompose: () => stagedDialogs.compose(target(t)),
                        onEdit: () => stagedDialogs.compose(target(t)),
                        onFire: () => p.onFireStagedSession(t),
                        onView: () => stagedDialogs.view(target(t)),
                        onDelete: () => stagedDialogs.remove(target(t)),
                      }}
                    />
                  </span>
                </span>
              </td>
            </tr>
            )
          })}
          {directView && (
            // The `id: null` direct-branch bucket — sessions filed straight on the delivery,
            // under no subtask. Styled distinctly from a real subtask row: no status chip, no
            // due date, because this is not a piece of planned work — it is "everything not
            // broken out". See docs/superpowers/specs/2026-09-10-task-session-hierarchy-design.md
            // §4.4. It disappears entirely when there is nothing filed directly (the server only
            // emits this bucket when `direct.length > 0` — see `subtaskViews()`).
            <tr>
              {/* No gear here — this bucket is not a subtask, it has nothing a menu could act on. */}
              <td style={cell} />
              <td style={{ ...cell, minWidth: isMobile ? 150 : 280, color: 'var(--text-tertiary)', fontStyle: 'italic', fontSize: 12 }}>
                {copy.directSessions}
              </td>
              {shownCols.map(id => {
                const def = SUBTASK_COLUMNS.find(c => c.id === id)!
                return (
                  <td key={id} style={{ ...cell, textAlign: def.numeric ? 'right' : 'left', minWidth: id === 'sessions' ? 160 : undefined }}>
                    {id === 'sessions' && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', minWidth: 0 }}>
                        {directSessions.map(s => (
                          <SessionRef
                            key={s.id}
                            id={s.id}
                            title={s.label}
                            harness={s.harness}
                            lang={p.lang}
                            historical={s.historical === true}
                            onOpen={p.onOpenSession}
                            onUnfile={sid => void p.onUnfile(sid)}
                          />
                        ))}
                      </span>
                    )}
                    {id === 'model' && <ModelCellView sessions={directSessions} />}
                    {id === 'cost' && <CostCellView r={directView.rollup} cost={directCost} money={money} />}
                    {id === 'tokens' && <TokensCellView tok={directTok} />}
                  </td>
                )
              })}
              <td style={cell} />
            </tr>
          )}
          <tr>
            <td colSpan={colCount} style={{ ...cell }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%' }}>
                <Plus size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                <input
                  value={draft} placeholder={copy.addSubtask}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && draft.trim()) { void p.onAdd(draft.trim()); setDraft('') }
                  }}
                  style={{ ...bare, maxWidth: 340, minHeight: isMobile ? 34 : 20 }}
                />
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      </div>

      {linking && (
        <SessionPicker
          // MULTIPLE, because a subtask holds any number of sessions — and sequential on the way
          // out, since every attach read-modify-writes the same store.
          onPick={async ids => { for (const id of ids) await p.onAttach(linking, id) }}
          onClose={() => setLinking(null)}
        />
      )}

      {doneRefusal && (
        <DoneNeedsSessionDialog
          title={doneRefusal.title}
          scope="subtask"
          lang={p.lang}
          onCancel={() => setDoneRefusal(null)}
          onFile={() => {
            // The SAME shortcut `SubtaskSessions`' own `⋯` menu opens — this row's
            // `SessionPicker`, not a second implementation of it.
            const id = doneRefusal.id
            setDoneRefusal(null)
            setLinking(id)
          }}
        />
      )}

      {stagedDialogs.element}
    </div>
  )
}

/**
 * SubtaskTable — the subtasks, as the SAME grid the table view expands inside a row.
 *
 * One component drawn in two places, deliberately: a subtask that shows five columns on the board
 * and a checkbox on the detail page is two different records as far as the reader is concerned, and
 * the one with fewer columns teaches people the fields do not exist. (`TaskTable.tsx`'s inline
 * subitem rows mirror the base columns, including the group-forming controls below.)
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
 * superseded and inert) — and render them with the exact same formatters `TaskTable.tsx`'s own
 * cost/tokens cells use (`useMoney()`, `fmtTokens`). A subtask with no session filed yet still gets a
 * bucket from the server (`sessionsUsed: 0`, every metric `null`), and that renders as an EMPTY cell
 * — no field at all, not even "N/A" — through `costCellFor`/`tokensCellFor`'s `isUntracked` check:
 * metric tracking starts the moment a session is actually linked, not before. "N/A" is reserved for a
 * session that IS linked but whose figure genuinely cannot be produced. See `subtaskRollup.ts`.
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
  cycleSort, type StagedSessionDraft, type SubtaskSortKey, type SubtaskSortSpec, type TaskStatusDef,
} from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { ConfirmModal } from '../../pages/settings/primitives'
import {
  fmtStamp, fmtTokens, liveStatusMap, liveStatusOrder, microLabel, numeric, pill, statusStyle,
  surface, type BoardStatus,
} from './board'
import { SessionPicker } from './SessionPicker'
import { DoneNeedsSessionDialog } from './DoneNeedsSessionDialog'
import { TaskProgressBar } from './TaskProgressBar'
import { subtaskSessions } from './SubtaskSessions'
import { SubtaskActionsMenu } from './SubtaskActionsMenu'
import {
  clusterBarStyle, clusterSubtaskRows, clusterTintStyle, groupMembers, groupOf, isGroupMember,
  isGroupSubtask, visibleClusterRows,
} from './subtaskGroups'
import { SessionRef } from './SessionRef'
import { SortTh } from './SortHeader'
import { orderedSubtasks } from './subtaskSortView'
import { StagedSessionCompose } from './StagedSessionCompose'
import { StagedSessionView } from './StagedSessionView'
import { boardCopy, statusLabel, type Lang } from './copy'
import { useMoney, type Money } from './money'
import { costCaveat, costCellFor, subtaskRollupOf, tokensCellFor, type CostCell, type TokensCell } from './subtaskRollup'
import type {
  AttemptRollup, StagedSessionWriteResult, StatusWriteResult, Subtask, SubtaskPatch, SubtaskView,
  TaskFile, TaskSessionRow, TaskStatus,
} from '../../lib/tasks'

function StatusPick({ value, lang, statuses, onPick }: {
  value: TaskStatus
  lang: Lang
  /** The board's LIVE status list (`lib/tasks.ts`'s `useTaskStatuses`) — `null` while it loads. */
  statuses: readonly TaskStatusDef[] | null
  onPick: (s: TaskStatus) => void
}) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const s = statusStyle(statuses, value)
  const map = liveStatusMap(statuses)
  const order = liveStatusOrder(statuses)
  return (
    <div style={{ position: 'relative' }}>
      <button className="ag-tap"
        onClick={() => setOpen(v => !v)}
        style={{
          border: `1px solid ${s.color}`, cursor: 'pointer', padding: '3px 9px', borderRadius: 5,
          background: s.dim, color: s.color, fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap',
        }}
      >{statusLabel(value, lang, statuses)}</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 31, marginTop: 4, minWidth: 128,
            ...surface, background: 'var(--bg-elevated)', padding: 4, display: 'grid', gap: 2,
            boxShadow: 'var(--shadow-elevated)',
          }}>
            {order.map(st => {
              const c = map[st] ?? { label: st, color: 'var(--text-tertiary)', dim: 'var(--border)' }
              return (
                <button
                  // A MENU ROW pays its 44px in PAINT. `.ag-tap` is for controls whose smallness
                  // is their meaning; these sit in a `gap: 2` list, where a projected box covers
                  // the row above and its bottom band selects the row below.
                  key={st} onClick={() => { setOpen(false); onPick(st) }}
                  style={{
                    border: 'none', cursor: 'pointer', textAlign: 'left', padding: '5px 9px',
                    minHeight: isMobile ? 44 : undefined,
                    borderRadius: 5, background: c.dim, color: c.color, fontSize: 10.5, fontWeight: 600,
                  }}
                >{statusLabel(st, lang, statuses)}</button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

const cell: React.CSSProperties = { padding: '7px 9px', borderTop: '1px solid var(--border)' }
const bare: React.CSSProperties = {
  width: '100%', background: 'transparent', border: 'none', outline: 'none',
  color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'inherit',
}

/** One rendering for the cost cell — the subtask rows and the direct-sessions footer row draw the
 *  EXACT same figure the exact same way, so this lives once rather than being copy-pasted twice. */
function CostCellView({ r, cost, money }: { r: AttemptRollup | undefined; cost: CostCell; money: Money }) {
  if (cost.kind === 'empty') return null
  if (cost.kind === 'credits') {
    return <span style={{ ...numeric, fontSize: 12 }}>{cost.premiumRequests} req</span>
  }
  return (
    <span
      style={{ ...numeric, fontSize: 12, color: cost.usd === null ? 'var(--text-tertiary)' : 'var(--anthropic-orange)' }}
      title={costCaveat(r)}
    >{money(cost.usd, r?.costByHarness)}</span>
  )
}

/** The tokens column's own version of `CostCellView`. */
function TokensCellView({ tok }: { tok: TokensCell }) {
  if (tok.kind === 'empty') return null
  return (
    <span style={{ ...numeric, fontSize: 12, color: tok.n === null ? 'var(--text-tertiary)' : undefined }}>
      {fmtTokens(tok.n)}
    </span>
  )
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
}

export function SubtaskTable(p: SubtaskTableProps) {
  const isMobile = useIsMobile()
  const copy = boardCopy(p.lang)
  const money = useMoney()
  const [draft, setDraft] = useState('')
  const [linking, setLinking] = useState<string | null>(null)
  /** Set when a status write refused `done` for having no session filed yet — see
   *  `DoneNeedsSessionDialog`. Named so its shortcut can reopen `SessionPicker` for the SAME row. */
  const [doneRefusal, setDoneRefusal] = useState<{ id: string; title: string } | null>(null)
  /** The subtask/group whose staged-session compose dialog is open — see `StagedSessionCompose`. */
  const [composing, setComposing] = useState<Subtask | null>(null)
  /** The subtask/group whose read-only staged-session summary is open — see `StagedSessionView`. */
  const [viewing, setViewing] = useState<Subtask | null>(null)
  /** The subtask/group whose draft is being confirmed for deletion, from the menu directly — never
   *  requires opening `StagedSessionCompose` first. */
  const [deleting, setDeleting] = useState<Subtask | null>(null)
  const [stagedError, setStagedError] = useState<string | null>(null)
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
  const ordered = orderedSubtasks(p.subtasks, sort, {
    views: p.subtaskRollups,
    sessions: p.sessions,
    statusOrder: liveStatusOrder(p.statuses),
  })

  const pickStatus = async (t: Subtask, status: TaskStatus) => {
    const result = await p.onPatch(t.id, { status })
    if (!result.ok && result.reason === 'done_needs_session') {
      setDoneRefusal({ id: t.id, title: t.title })
    }
  }

  const done = p.subtasks.filter(t => t.done).length

  // The direct-branch footer row — sessions filed straight on the delivery, under no subtask.
  // `subtaskRollupOf` only resolves a SUBTASK's bucket (it takes `{ id, groupId }`, never `null`),
  // so the `id: null` view is read straight off the list here instead.
  const directView = p.subtaskRollups.find(v => v.id === null)
  const directSessions = p.sessions.filter(s => s.subtaskId === null)
  const directCost = costCellFor(directView?.rollup)
  const directTok = tokensCellFor(directView?.rollup)

  return (
    <div style={{ ...surface, overflowX: 'auto' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px',
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={microLabel}>{copy.subtasks}</span>
        {/* The shared bar — it rounds DOWN, so this one cannot say 100% while the grid below it
            still shows an open row. That disagreement is exactly what one component prevents. */}
        <div style={{ flex: 1, maxWidth: 220 }}>
          <TaskProgressBar done={done} total={p.subtasks.length} />
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
        <thead>
          <tr>
            {/* The leading '' is the gear-menu column (`SubtaskActionsMenu`) — no header text, same
                convention the old trailing actions column used, and no sort: nothing to order by. */}
            <th style={{ ...microLabel, padding: '6px 9px', fontWeight: 600 }} />
            {([
              [copy.subtasks, 'title'], ['Status', 'status'],
              [copy.started, 'started'], [copy.completed, 'completed'], [copy.sessions, 'sessions'],
              [copy.cost, 'cost'], [copy.tokens, 'tokens'],
            ] as Array<[string, SubtaskSortKey]>).map(([h, key]) => (
              <SortTh
                key={key}
                label={h}
                sortKey={key}
                current={sort}
                mobile={isMobile}
                onSort={k => setSort(cycleSort(sort, k))}
                title={L.sortByColumn.replace('{column}', h)}
                align={key === 'cost' || key === 'tokens' ? 'right' : 'left'}
                style={{
                  ...microLabel, padding: '6px 9px', fontWeight: 600,
                  textAlign: key === 'cost' || key === 'tokens' ? 'right' : 'left',
                }}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {p.subtasks.length === 0 && (
            <tr>
              <td colSpan={8} style={{ ...cell, fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.55 }}>
                {copy.nothingBrokenOut}
              </td>
            </tr>
          )}
          {visibleClusterRows(clusterSubtaskRows(ordered), expandedGroups).map(({ subtask: t, depth, clustered }) => {
            // A GROUP MEMBER (§F.1) never carries a session of its own — refused server-side
            // (`subtask_in_group`) — so it has no rollup bucket at all (`subtaskViews` excludes it
            // outright). `r` is therefore `undefined` for it by construction, which already renders
            // as the fully empty cost/tokens cells below — the same "nothing filed here yet"
            // convention every untracked subtask uses, never a fake zero.
            const isMember = isGroupMember(t)
            const isGroup = isGroupSubtask(t)
            const r = subtaskRollupOf(p.subtaskRollups, t)
            const cost = costCellFor(r)
            const tok = tokensCellFor(r)
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
              {/* ONE gear, leading the row — every action that used to be a scattered icon-only
                  button (blocked-by, group forming, staged-session compose/edit/fire, remove) lives
                  in this single labeled popover now. See `SubtaskActionsMenu`'s own doc comment.
                  The inset left bar (`clusterBarStyle`) lands here — the leading edge of every
                  clustered row, header through last member, so it reads as one continuous stripe. */}
              <td style={{ ...cell, width: 1, ...tint, ...clusterBarStyle(clustered) }}>
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
                    onCompose: () => setComposing(t),
                    onEdit: () => setComposing(t),
                    onFire: () => p.onFireStagedSession(t),
                    onView: () => setViewing(t),
                    onDelete: () => setDeleting(t),
                  }}
                />
              </td>
              {/* A MEMBER is indented one level under its group's header — the visual nesting that
                  replaces the old "parte do grupo" caption for every properly clustered row. */}
              <td style={{ ...cell, minWidth: 180, ...tint, ...(depth === 1 ? { paddingLeft: 30 } : {}) }}>
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
                    the same round-down bar the header above draws for the whole delivery, one
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
              <td style={{ ...cell, minWidth: 90, whiteSpace: 'nowrap', ...tint }}>
                <StatusPick
                  value={t.status} lang={p.lang} statuses={p.statuses}
                  onPick={s => void pickStatus(t, s)}
                />
              </td>
              {/* `startedAt`/`deliveredAt` are SYSTEM facts, never a date somebody typed — see
                  `Subtask.startedAt`'s own note. Read-only: no picker, no owner column, nothing to
                  type. */}
              <td style={{ ...cell, ...tint }}>
                <span style={{
                  fontSize: 12,
                  color: t.startedAt ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                }}>{fmtStamp(t.startedAt, p.lang)}</span>
              </td>
              <td style={{ ...cell, ...tint }}>
                <span style={{
                  fontSize: 12,
                  color: t.deliveredAt ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                }}>{fmtStamp(t.deliveredAt, p.lang)}</span>
              </td>
              <td style={{ ...cell, minWidth: 190, ...tint }}>
                {/* A MEMBER can never hold a session (`subtask_in_group`, refused server-side) —
                    so it gets no filing control at all, not a control that always refuses. Its
                    own chips are moot for the same reason: it has none, and never a UNION of its
                    group's — that was §B's shared-bucket model, superseded by §F.1. */}
                {!isMember && subtaskSessions({
                  subtaskId: t.id,
                  // A GROUP's own chips are its own direct sessions — never a union of its
                  // members', who can never carry one. See
                  // docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §F.3.
                  subtaskIds: [t.id],
                  sessions: p.sessions,
                  lang: p.lang,
                  mobile: isMobile,
                  onLink: setLinking,
                  onUnfile: sid => void p.onUnfile(sid),
                  onOpen: p.onOpenSession,
                })}
              </td>
              {/* `r` absent (no bucket at all — always true for a MEMBER) or `sessionsUsed: 0` (a
                  bucket, but nobody has filed a session here yet) both render as a fully EMPTY
                  cell — no field at all, not even "N/A" — via `CostCellView`/`TokensCellView`'s
                  `isUntracked` check. */}
              <td style={{ ...cell, textAlign: 'right', ...tint }}>
                <CostCellView r={r} cost={cost} money={money} />
              </td>
              <td style={{ ...cell, textAlign: 'right', ...tint }}>
                <TokensCellView tok={tok} />
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
              <td style={{ ...cell, minWidth: 180, color: 'var(--text-tertiary)', fontStyle: 'italic', fontSize: 12 }}>
                {copy.directSessions}
              </td>
              <td style={cell} />
              <td style={cell} />
              <td style={cell} />
              <td style={{ ...cell, minWidth: 190 }}>
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
              </td>
              <td style={{ ...cell, textAlign: 'right' }}>
                <CostCellView r={directView.rollup} cost={directCost} money={money} />
              </td>
              <td style={{ ...cell, textAlign: 'right' }}>
                <TokensCellView tok={directTok} />
              </td>
            </tr>
          )}
          <tr>
            <td colSpan={8} style={{ ...cell }}>
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
            // The SAME shortcut `SubtaskSessions`' own "filiar" button opens — this row's
            // `SessionPicker`, not a second implementation of it.
            const id = doneRefusal.id
            setDoneRefusal(null)
            setLinking(id)
          }}
        />
      )}

      {composing && (
        <StagedSessionCompose
          lang={p.lang}
          subtaskTitle={composing.title}
          {...(composing.stagedSession ? { initial: composing.stagedSession } : {})}
          taskFiles={p.taskFiles}
          onUpload={p.onUploadFile}
          onSave={async d => {
            const result = await p.onSaveStagedSession(composing.id, d)
            if (!result.ok) {
              // Structurally unreachable through this UI (the control is absent on a member row),
              // but the server is the authority and a network hiccup can still refuse — say so
              // rather than pretending the dialog's close meant success. The compose dialog still
              // closes: what was typed was not saved, and repeating it in a member row would refuse
              // again — this is defence in depth, not a path a person composing from this table can
              // actually reach.
              setStagedError(result.reason === 'subtask_in_group'
                ? (p.lang === 'pt'
                  ? 'Esta subtarefa pertence a um grupo e não pode receber uma sessão em espera.'
                  : 'This subtask belongs to a group and cannot hold a staged session.')
                : staged.networkError)
            }
          }}
          {...(composing.stagedSession
            ? { onDiscard: () => void p.onClearStagedSession(composing.id) }
            : {})}
          onClose={() => setComposing(null)}
        />
      )}

      {viewing && viewing.stagedSession && (
        <StagedSessionView
          lang={p.lang}
          subtaskTitle={viewing.title}
          draft={viewing.stagedSession}
          taskFiles={p.taskFiles}
          onEdit={() => { const t = viewing; setViewing(null); setComposing(t) }}
          onClose={() => setViewing(null)}
        />
      )}

      {/* Reachable straight from the gear menu — never requires opening `StagedSessionCompose`
          first. Product ask, verbatim: "deletar eh acao destrutiva entao precisa de modal de
          confirmacao" — the same `ConfirmModal` every other destructive act in this app uses,
          rather than a second bespoke dialog for this one. */}
      <ConfirmModal
        open={deleting !== null}
        title={staged.discardTitle}
        message={staged.discardMessage}
        confirmLabel={staged.discard}
        cancelLabel={staged.cancel}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return
          void p.onClearStagedSession(deleting.id)
          setDeleting(null)
        }}
      />

      {stagedError && (
        <div
          role="alertdialog" aria-modal="true"
          onClick={e => { if (e.target === e.currentTarget) setStagedError(null) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 435, background: 'var(--ag-scrim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
        >
          <div style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 14,
            width: '100%', maxWidth: 380, padding: 18, display: 'grid', gap: 12,
          }}>
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-primary)', lineHeight: 1.5 }}>
              {stagedError}
            </p>
            <button
              type="button" onClick={() => setStagedError(null)}
              style={{
                justifySelf: 'flex-end', padding: '7px 14px', borderRadius: 7,
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >OK</button>
          </div>
        </div>
      )}
    </div>
  )
}

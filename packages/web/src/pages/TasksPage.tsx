/**
 * TasksPage — the board.
 *
 * Two shapes, because there are two questions. BOARD answers "what is in flight" (a shape, not a
 * list). TABLE answers "which configuration was cheapest" (a comparison, and comparisons want
 * columns). The detail is a Jira-style split: the work on the left, the facts on the right.
 *
 * It computes NOTHING. Every figure arrives already decided from `/api/tasks`, resolved through the
 * same `task-rollup.ts` / `task-stats.ts` the CLI prints — a dashboard and a terminal must never
 * disagree about what a delivery cost.
 *
 * What this file owns is the honesty of the rendering: a `null` is `N/A` and never `0`, a partial
 * cost says how much of the attempt it covers, an attempt holding both dollars and Copilot credits
 * shows both and no total, and an open task shows no duration — "still running" is not "took N h".
 */

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import {
  ArrowLeft, BarChart3, ClipboardList, ExternalLink, FileText, Link2,
  Filter, LayoutGrid, MessageSquare, Pencil, Plus, Rows3, Search, Settings2, Trash2, X, XCircle,
} from 'lucide-react'
import { PRIORITY_ORDER, type SortSpec, type TaskPriorityId } from '@agentistics/core'
import { ChevronDown } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'
import type { AppContext } from '../lib/app-context'
import { useFleet } from '../lib/fleet'
import { sessionPath } from '../lib/sessionRoute'
import {
  bodyWithAttachments, looksLikeImage, parseCommentBody,
  type CommentAttachment, type CommentPart,
} from '../lib/commentBody'
import { BoardView, MobileLane } from '../components/tasks/TaskBoard'
import { effectiveView, hasStoredView, resolveLane } from '../components/tasks/mobileLanes'
import { mobileBoardCopy } from '../components/tasks/boardCopyThreads'
import { TaskTable } from '../components/tasks/TaskTable'
import { SubtaskTable } from '../components/tasks/SubtaskTable'
import {
  useBoardPref,
} from '../components/tasks/boardPrefs'
import { BoardArrange } from '../components/tasks/BoardArrange'
import { DeliveryDetail, type DeliveryTab } from '../components/tasks/DeliveryDetail'
import { TaskHero } from '../components/tasks/TaskHero'
import { liveSessionsOf } from '../components/tasks/threadView'
import { useMoney } from '../components/tasks/money'
import { RailSection } from '../components/tasks/RailSection'
import { ConfirmModal, Select } from './settings/primitives'
import { DatePicker } from '../components/DatePicker'
import { BlockedDialog } from '../components/tasks/BlockedDialog'
import { TaskProgressBar } from '../components/tasks/TaskProgressBar'
import { BetaTag } from '../components/BetaTag'
import { StatusChip } from '../components/tasks/StatusChip'
import { boardCopy, statusLabel, type Lang } from '../components/tasks/copy'
import { TaskFiles } from '../components/tasks/TaskFiles'
import { TaskSharing } from '../components/tasks/TaskSharing'
import { BoardOverviewView } from '../components/tasks/BoardOverviewView'
import { CentralTaskBoard } from '../components/tasks/CentralTaskBoard'
import { NewTaskWizard } from '../components/tasks/NewTaskWizard'
import { ManageStatusesModal } from '../components/tasks/ManageStatusesModal'
import { NewSessionModal } from '../components/sessions/NewSessionModal'
import { markSessionPending } from '../lib/pendingSessionStore'
import {
  NA, PRIORITY, SESSION_STATE, button, claimLeft, field, fmtInt, fmtTokens, harnessColor,
  liveStatusOrder, microLabel, numeric, pill, statusStyle, surface, type BoardStatus,
} from '../components/tasks/board'
import {
  addComment, addLink, addSubtask, createTask, deleteFile, deleteTask, editComment, fileUrl,
  attachSession, detachSession, fmtDuration, markTask, patchSubtask, removeComment, removeLink,
  removeSubtask,
  editTask, moveTask, setBlockedBy, uploadFile,
  useCentralTasks, useTaskDetail, useTaskList, useTaskStatuses, useTaskTypes,
  type AttemptRollup, type AttemptView, type TaskDetail, type TaskFieldPatch, type TaskFile,
  type TaskListRow, type TaskRecord, type TasksError, type TaskStatus,
} from '../lib/tasks'

function EmptyNotice({ error }: { error: TasksError }) {
  const text = error === 'refused'
    ? 'The task board is a local store, and this instance does not host one.'
    : error === 'down'
      ? 'The server did not answer. Nothing is claimed about your tasks either way.'
      : 'No tasks yet. Create one above, or file sessions under one with agentop session batch.'
  return (
    <div style={{ ...surface, padding: 16, color: 'var(--text-tertiary)', display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
      <ClipboardList size={16} /> {text}
    </div>
  )
}


/**
 * The central's board.
 *
 * A DIFFERENT page from the machine's, and deliberately so: there is no board on a central. What it
 * holds is what its machines chose to share, it is read-only, and it groups by machine because a
 * board belongs to the person whose machine runs it.
 */
function CentralBoard() {
  const { lang, currency, brlRate } = useOutletContext<AppContext>()
  const isMobile = useIsMobile()
  const { machines, error } = useCentralTasks(true)

  return (
    <div style={{
      padding: isMobile ? 12 : 18,
      paddingBottom: isMobile ? 'calc(var(--mobile-nav-h) + 24px)' : 18,
      display: 'grid', gap: 14,
    }}>
      <div>
        <h1 style={{ fontSize: 19, margin: 0, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 8 }}>
          Agentask
          <BetaTag what="Agentask" />
        </h1>
        <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
          {lang === 'pt'
            ? 'O que cada máquina escolheu compartilhar. Uma tarefa só viaja quando o dono dela liga o compartilhamento, e as sessões dela continuam seguindo as regras da conexão.'
            : 'What each machine chose to share. A task travels only when its owner turns sharing on, and its sessions still follow the connection’s rules.'}
        </p>
      </div>

      {machines === null && (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>Loading…</div>
      )}
      {machines !== null && error && <EmptyNotice error={error} />}
      {machines !== null && !error && machines.length === 0 && (
        <div style={{ ...surface, padding: 16, color: 'var(--text-tertiary)', display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
          <ClipboardList size={16} />
          {lang === 'pt'
            ? 'Nenhuma máquina conectada a esta central ainda. Uma máquina aparece aqui assim que se conecta, mesmo sem compartilhar tarefa nenhuma.'
            : 'No machine is connected to this central yet. A machine appears here as soon as it connects, even when it shares no task at all.'}
        </div>
      )}
      {machines !== null && !error && machines.length > 0 && (
        <CentralTaskBoard machines={machines} lang={lang} currency={currency} brlRate={brlRate} />
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------- list

function TaskList() {
  // The SAME filters the rest of the dashboard edits. The board is not a separate world: the date
  // range and the harness / project / repo chips scope which SESSIONS count toward each task, which
  // is what makes "what did this cost me last week" answerable.
  const { filters, lang } = useOutletContext<AppContext>()
  const { rows, overview, excluded, error, reload } = useTaskList(filters)
  const { statuses, reload: reloadStatuses } = useTaskStatuses()
  const { types, reload: reloadTypes } = useTaskTypes()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  // Metrics FIRST. The kanban answers "which column is full"; this answers "what is it costing me",
  // which is the question the product exists for.
  // Restored, not re-decided: opening a task navigates away and unmounts this list, so a view that
  // resets itself on every back-press is a view nobody can stay in.
  // Read LIVE from the per-person store (`boardPrefs.ts`), not seeded once: on a device that opens
  // the board before the server answers, the arrangement lands as soon as it does.
  const [storedView, setView] = useBoardPref('view')
  // A phone with no stored choice opens on the kanban, not on the metrics.
  const view = effectiveView(storedView, isMobile, hasStoredView())
  const [lane, setLane] = useState<string | null>(null)
  const [sheet, setSheet] = useState(false)
  const MB = mobileBoardCopy(lang)
  // The kanban's arrangement, persisted with everything else the board remembers. The SORT is
  // shared with the table on purpose: a board that ranks its cards one way in the grid and another
  // in the columns is two boards, and the reader has to hold both.
  const [sort, setSort] = useBoardPref('sort')
  // A column's OWN order (set by clicking its title), by status id — persisted beside the board's
  // own, in the same per-person store for the same reason: it is one viewer's arrangement.
  const [columnSort, setColumnSort] = useBoardPref('columnSort')
  const [lanes, setLanes] = useBoardPref('lanes')
  const [wip, setWip] = useBoardPref('wip')
  // The visible columns, shared with the table's group chooser — `boardPrefs.groups`. Falls back to
  // the LIVE list's own order (every status the board currently has, custom ones included) rather
  // than the fixed legacy seven, so a board nobody has customized shows what is really there.
  // The live list resolves asynchronously, so the fallback is derived on every render rather than
  // frozen at whatever the first render saw.
  const [storedGroups, setBoardColumns] = useBoardPref('groups')
  const boardColumns = useMemo(() => storedGroups ?? liveStatusOrder(statuses), [storedGroups, statuses])
  /**
   * The tasks on their way to `blocked`, waiting on the dialog's answer.
   *
   * Every path that can set a status funnels through `toStatus` below — the rail, the table cell,
   * the batch bar, a drop into the Blocked column — so the question is asked ONCE, in one place,
   * rather than four times with four chances to forget one.
   */
  const [blocking, setBlocking] = useState<string[] | null>(null)
  // The board's own fleet read — for the kanban's "who is running this" join. The orchestration
  // reads (the ready queue, the activity log) went with the Agents view; nothing else on this page
  // needs them.
  const { fleet } = useFleet('en')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  /** The status vocabulary editor (see its own docblock) — closing it reloads the live list, so a
   *  rename, a recolour or a new/deleted status reaches the board immediately without a page
   *  refresh. */
  const [managingStatuses, setManagingStatuses] = useState(false)
  /** The task TYPE vocabulary editor — the same modal, over the other list. */
  const [managingTypes, setManagingTypes] = useState(false)
  /** The task whose session wizard is up — see `onCreateSession`. */
  const [starting, setStarting] = useState<{ taskId: string; title: string } | null>(null)
  /** Details fetched for the rows the table has expanded — subtasks live there. */
  const [details, setDetails] = useState<Map<string, TaskDetail>>(new Map())

  /** The ONE way a status is set from this page. `blocked` asks its question first. */
  const toStatus = async (ids: string[], status: TaskStatus) => {
    if (status === 'blocked') { setBlocking(ids); return }
    for (const id of ids) await markTask(id, status)
    await reload()
  }

  const refreshDetail = async (id: string) => {
    const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`)
    if (!res.ok) return
    const body = await res.json() as { task: TaskDetail }
    setDetails(m => new Map(m).set(id, body.task))
    await reload()
  }

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle || !rows) return rows ?? []
    return rows.filter(r =>
      r.task.title.toLowerCase().includes(needle)
      || (r.task.detail ?? '').toLowerCase().includes(needle))
  }, [rows, q])


  const seg = (active: boolean): React.CSSProperties => ({
    ...button(isMobile),
    height: isMobile ? 44 : 30,
    border: 'none',
    background: active ? 'var(--bg-elevated)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
  })

  const laneChips = liveStatusOrder(statuses)
    .filter(st => boardColumns.includes(st))
    .map(st => ({ status: st, count: shown.filter(r => r.task.status === st).length }))
  const activeLane = resolveLane(lane, laneChips)
  const arrange = (
<BoardArrange
            lang={lang}
            sort={sort} onSort={setSort}
            columnSorts={columnSort} onColumnSorts={setColumnSort}
            lanes={lanes} onLanes={setLanes}
            wip={wip} onWip={setWip}
            // The board and the table share ONE set of visible columns: they are the LIVE statuses,
            // and letting each remember its own would mean hiding a status twice.
            columns={boardColumns}
            onColumns={setBoardColumns}
            statuses={statuses}
            counts={Object.fromEntries(liveStatusOrder(statuses).map(st => [
              st, shown.filter(r => r.task.status === st).length,
            ]))}
          />
  )

  // The table draws this INSIDE its own toolbar row (`toolbarStart`); the board keeps it above.
  const searchBox = (
    <div style={{ position: 'relative', maxWidth: 380 }}>
      <Search size={14} style={{ position: 'absolute', left: 11, top: isMobile ? 15 : 8, color: 'var(--text-tertiary)' }} />
      <input
        style={{ ...field(isMobile), paddingLeft: 32, ...(isMobile ? {} : { height: 28 }) }}
        value={q} placeholder={lang === 'pt' ? 'Buscar' : 'Search'}
        onChange={e => setQ(e.target.value)}
      />
    </div>
  )

  return (
    <div style={{
      padding: isMobile ? 12 : 18,
      paddingBottom: isMobile ? 'calc(var(--mobile-nav-h) + 24px)' : 18,
      display: 'grid', gap: 14,
    }}>
      {isMobile && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ fontSize: 20, margin: 0, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
              Agentask
              <BetaTag what="Agentask" />
            </h1>
            <button style={button(true, 'primary')} onClick={() => setOpen(v => !v)}>
              <Plus size={15} /> New task
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>{searchBox}</div>
            <button
              style={{ ...button(true), flexShrink: 0, gap: 6 }}
              onClick={() => setSheet(true)}
              aria-label={MB.adjust}
            ><Settings2 size={15} /> {MB.adjust}</button>
          </div>
          {view === 'board' && shown.length > 0 && (
            <div
              className="ag-noscroll" role="tablist" aria-label={MB.chips}
              style={{
                display: 'flex', gap: 6, overflowX: 'auto', margin: '0 -12px', padding: '0 12px',
                scrollbarWidth: 'none',
              }}
            >
              {laneChips.map(c => {
                const on = c.status === activeLane
                return (
                  <button
                    key={c.status} role="tab" aria-selected={on}
                    onClick={() => setLane(c.status)}
                    style={{
                      flex: '0 0 auto', minHeight: 44, padding: '0 14px', borderRadius: 999,
                      border: `1px solid ${on ? 'transparent' : 'var(--border)'}`, fontSize: 13,
                      cursor: 'pointer', fontFamily: 'inherit',
                      background: on ? 'var(--anthropic-orange-dim)' : 'var(--bg-card)',
                      color: on ? 'var(--anthropic-orange-light)' : 'var(--text-secondary)',
                      fontWeight: on ? 600 : 400,
                    }}
                  >{statusLabel(c.status, lang, statuses)} · {c.count}</button>
                )
              })}
            </div>
          )}
        </>
      )}
      {sheet && isMobile && createPortal(
        <>
          <div onClick={() => setSheet(false)} style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.45)' }} />
          <div role="dialog" aria-label={MB.adjustTitle} style={{
            position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1110, maxHeight: '80dvh', overflowY: 'auto',
            background: 'var(--bg-surface)', borderTop: '1px solid var(--border)',
            borderRadius: '16px 16px 0 0', boxShadow: '0 -8px 30px rgba(0,0,0,0.35)',
            padding: '8px 12px calc(16px + env(safe-area-inset-bottom))', display: 'grid', gap: 14,
          }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)', margin: '4px auto 0' }} />
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ flex: 1, fontWeight: 650, fontSize: 15 }}>{MB.adjustTitle}</span>
              <button style={{ ...button(true), padding: '0 12px' }} onClick={() => setSheet(false)} aria-label={MB.close}><X size={15} /></button>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{MB.view}</span>
              <div style={{ ...surface, display: 'flex', padding: 3, gap: 2 }}>
                <button style={{ ...seg(view === 'overview'), flex: 1 }} onClick={() => setView('overview')}><BarChart3 size={14} /> Metrics</button>
                <button style={{ ...seg(view === 'board'), flex: 1 }} onClick={() => setView('board')}><LayoutGrid size={14} /> Board</button>
                <button style={{ ...seg(view === 'table'), flex: 1 }} onClick={() => setView('table')}><Rows3 size={14} /> Table</button>
              </div>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{MB.manage}</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button style={{ ...button(true), gap: 6 }} onClick={() => { setSheet(false); setManagingStatuses(true) }}><Settings2 size={14} /> {MB.statuses}</button>
                <button style={{ ...button(true), gap: 6 }} onClick={() => { setSheet(false); setManagingTypes(true) }}><Settings2 size={14} /> {MB.types}</button>
              </div>
            </div>
            {view === 'board' && shown.length > 0 && arrange}
          </div>
        </>,
        document.body,
      )}
      {!isMobile && <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h1 style={{ fontSize: 19, margin: 0, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 8 }}>
            Agentask
            <BetaTag what="Agentask" />
          </h1>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
            What each piece of work cost, in how many rounds and across how many sessions.
          </p>
        </div>
        <div style={{ ...surface, display: 'flex', padding: 3, gap: 2 }}>
          <button style={seg(view === 'overview')} onClick={() => setView('overview')}>
            <BarChart3 size={14} /> Metrics
          </button>
          <button style={seg(view === 'board')} onClick={() => setView('board')}>
            <LayoutGrid size={14} /> Board
          </button>
          <button style={seg(view === 'table')} onClick={() => setView('table')}>
            <Rows3 size={14} /> Table
          </button>
        </div>
        <button
          style={{ ...button(isMobile), padding: '0 9px' }}
          onClick={() => setManagingStatuses(true)}
          title="Manage statuses"
        >
          <Settings2 size={14} />
        </button>
        <button
          style={{ ...button(isMobile), padding: '0 9px', gap: 6 }}
          onClick={() => setManagingTypes(true)}
          title={boardCopy(lang).types.manage}
          aria-label={boardCopy(lang).types.manage}
        >
          <Settings2 size={14} />{!isMobile && <span style={{ fontSize: 12 }}>{boardCopy(lang).types.manage}</span>}
        </button>
        <button style={button(isMobile, 'primary')} onClick={() => setOpen(v => !v)}>
          <Plus size={15} /> New task
        </button>
      </div>}

      {managingStatuses && (
        <ManageStatusesModal
          lang={lang}
          onClose={() => { setManagingStatuses(false); void reloadStatuses() }}
        />
      )}

      {managingTypes && (
        <ManageStatusesModal
          kind="type"
          lang={lang}
          onClose={() => { setManagingTypes(false); void reloadTypes() }}
        />
      )}

      {open && (
        <NewTaskWizard
          onClose={() => setOpen(false)}
          onDone={async taskId => {
            setOpen(false)
            await reload()
            navigate(`/tasks/${encodeURIComponent(taskId)}`)
          }}
          onCreateSession={(taskId, taskTitle) => {
            // The session wizard that already exists, pre-filled with the task — a second spawn
            // form would be a second set of spawn rules.
            setOpen(false)
            setStarting({ taskId, title: taskTitle })
          }}
        />
      )}

      {starting && (
        <NewSessionModal
          lang={lang}
          initialTask={starting.title}
          initialTaskId={starting.taskId}
          onClose={() => setStarting(null)}
          onStarted={async (id, started) => {
            const to = starting.taskId
            setStarting(null)
            // This page navigates to the TASK, not the session — but the sessions aside is the
            // same persistent sidebar the reader may open next, so it gets the same placeholder
            // row every other `NewSessionModal` caller publishes.
            if (id) markSessionPending({ id, ...started })
            await reload()
            navigate(`/tasks/${encodeURIComponent(to)}`)
          }}
        />
      )}

      {view === 'board' && !isMobile && searchBox}

      {rows === null && <div style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>Loading…</div>}

      {excluded > 0 && (
        // Said, never swallowed: a rollup that silently shrank is the same defect as a confident
        // zero — the figure is smaller and nothing on screen explains why.
        <div style={{
          ...surface, padding: '8px 12px', fontSize: 11.5, color: 'var(--text-tertiary)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Filter size={13} />
          Scoped by the filters above — {excluded} session{excluded === 1 ? '' : 's'} left out of
          these numbers.
        </div>
      )}

      {view === 'overview' && overview && <BoardOverviewView o={overview} statuses={statuses} />}

      {view !== 'overview' && rows !== null && shown.length === 0 && (
        <EmptyNotice error={rows.length > 0 ? null : error} />
      )}
      {view === 'board' && shown.length > 0 && (
        <>
          {!isMobile && arrange}
          {isMobile ? (
            <MobileLane
              rows={shown} status={activeLane} lang={lang} sort={sort} columnSort={columnSort}
              statuses={statuses} sessions={fleet.sessions}
              onOpen={id => navigate(`/tasks/${encodeURIComponent(id)}`)}
            />
          ) : <BoardView
          lang={lang}
            rows={shown}
            sort={sort}
            columnSort={columnSort}
            onColumnSort={setColumnSort}
            lanes={lanes}
            wip={wip}
            columns={boardColumns}
            statuses={statuses}
            sessions={fleet.sessions}
            onOpen={id => navigate(`/tasks/${encodeURIComponent(id)}`)}
            onStatus={(id, status) => void toStatus([id], status)}
            onMove={async (id, index) => { await moveTask(id, index); await reload() }}
          />}
        </>
      )}
      {view === 'table' && (
        <TaskTable
          rows={shown}
          lang={lang}
          statuses={statuses}
          types={types}
          details={details}
          onOpen={id => navigate(`/tasks/${encodeURIComponent(id)}`)}
          onStatus={(ref, status) => void toStatus([ref], status)}
          onPriority={async (ref, priority) => { await editTask(ref, { priority }); await reload() }}
          onType={async (ref, type) => { await editTask(ref, { type }); await reload() }}
          onCreate={async (title, status, type) => {
            const made = await createTask(title, undefined, type)
            // Created straight into the group it was typed in — the "+ Add" row of a status column
            // is a statement about where the work stands, not just where the row goes.
            if (made && status !== 'todo') await markTask(made.id, status)
            await reload()
          }}
          onExpand={async id => {
            if (details.has(id)) return
            const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`)
            if (!res.ok) return
            const body = await res.json() as { task: TaskDetail }
            setDetails(m => new Map(m).set(id, body.task))
          }}
          onRefreshDetail={refreshDetail}
          onCommentsChanged={async ref => { await reload(); await refreshDetail(ref) }}
          toolbarStart={isMobile ? undefined : searchBox}
          onAddSubtask={async (ref, title) => { await addSubtask(ref, title); await refreshDetail(ref) }}
          onPatchSubtask={async (ref, sid, patch) => {
            // The RESULT reaches the caller — the group-forming gestures (§F.1) need it to show
            // `invalid_group`/`subtask_has_sessions`/`group_field_conflict` instead of a swallowed
            // refusal.
            const result = await patchSubtask(ref, sid, patch)
            await refreshDetail(ref)
            return result
          }}
          onRemoveSubtask={async (ref, sid) => { await removeSubtask(ref, sid); await refreshDetail(ref) }}
          onCreateGroupSubtask={async (ref, title) => {
            const newId = await addSubtask(ref, title, { isGroup: true })
            await refreshDetail(ref)
            return newId
          }}
          onBatchStatus={(ids, status) => void toStatus(ids, status)}
          onBatchDelete={async ids => {
            for (const id of ids) await deleteTask(id)
            await reload()
          }}
          // Filing is per SUBTASK now, so the list's verb names both and the picker lives inside
          // the expanded row — there is no delivery-level "link a session" left to open.
          onLinkSession={async (ref, subtaskId, sessionId) => {
            await attachSession(ref, sessionId, subtaskId)
            await refreshDetail(ref)
            await reload()
          }}
          onUnfileSession={async (ref, sessionId) => {
            await detachSession(ref, sessionId)
            await refreshDetail(ref)
            await reload()
          }}
          onOpenSession={sid => navigate(sessionPath(sid))}
        />
      )}

      {blocking && rows && (
        <BlockedDialog
          titles={blocking.map(id => rows.find(r => r.task.id === id)?.task.title ?? id)}
          rows={rows}
          already={blocking.length === 1
            ? rows.find(r => r.task.id === blocking[0])?.task.blockedBy ?? []
            : []}
          onCancel={() => setBlocking(null)}
          onConfirm={async ({ reason, blockedBy }) => {
            const ids = blocking
            setBlocking(null)
            for (const id of ids) await markTask(id, 'blocked', { reason, blockedBy })
            await reload()
          }}
        />
      )}

    </div>
  )
}

// ----------------------------------------------------------------------------- detail


function TaskDetailView({ id }: { id: string }) {
  const { filters, lang } = useOutletContext<AppContext>()
  const { detail, error, reload } = useTaskDetail(id, filters)
  const { statuses } = useTaskStatuses()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [tab, setTab] = useState<DeliveryTab>('threads')
  // The fleet poll is module-level and shared — this subscribes to the same snapshot the sessions
  // workspace reads, so the hero's "N live" costs no request of its own.
  const { fleet, loading: fleetLoading } = useFleet(lang)

  if (error === 'missing') return <div style={{ padding: 18 }}><EmptyNotice error={null} /></div>
  if (error) return <div style={{ padding: 18 }}><EmptyNotice error={error} /></div>
  if (!detail) return <div style={{ padding: 18, color: 'var(--text-tertiary)', fontSize: 12.5 }}>Loading…</div>

  const live = fleetLoading ? null : liveSessionsOf(detail.sessions, fleet.sessions).length

  return (
    <div style={{
      padding: isMobile ? 0 : 18, // @overlay-intentional: the page, not an overlay — the hero runs edge to edge
      // The mobile bottom nav is FIXED, so the last thing on the page sits underneath it and cannot
      // be tapped — measured: "Delete task" was intercepted by `nav.mobile-bottom-nav` at every
      // scroll position. `--mobile-nav-h` is the token that already knows how tall that chrome is,
      // safe-area inset included.
      paddingBottom: isMobile ? 'calc(var(--mobile-nav-h) + 24px)' : 18,
      display: 'grid', gap: isMobile ? 10 : 14,
    }}>
      {/* The task's IDENTITY (owner's choice 2026-10-04: A's cockpit on C's conversations). */}
      <TaskHero
        detail={detail}
        lang={lang}
        statuses={statuses}
        live={live}
        onBack={() => navigate('/tasks')}
        onAbout={() => setTab('about')}
      />

      <div style={{ padding: isMobile ? '0 12px' : 0, display: 'grid', gap: 14, minWidth: 0 }}>
        <DeliveryDetail
          id={id}
          detail={detail}
          lang={lang}
          reload={reload}
          tab={tab}
          onTabChange={setTab}
          onDeleted={() => navigate('/tasks')}
        />

        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
          {lang === 'pt'
            ? 'Isso é custo, prompts e tempo. Se o trabalho ficou bom não é medido aqui.'
            : 'These are cost, prompts and time. Whether the work is any good is not measured here.'}
        </p>
      </div>
    </div>
  )
}

export default function TasksPage() {
  const { id } = useParams<{ id: string }>()
  const { isCentral } = useOutletContext<AppContext>()
  // A central has no local board to open a task IN, so it never renders the detail either: the
  // record lives on the machine that owns it, and the row here is a report, not a door.
  if (isCentral) return <CentralBoard />
  return id ? <TaskDetailView id={id} /> : <TaskList />
}

/**
 * TaskChips — everything the task page's old right rail held, as editable chips in the HEADER.
 *
 * Owner's choice (2026-10-04, proposal A "Cabeçalho que edita"): no rail. Status and priority are
 * the same `StatusChip` / `ChipSelect` the table draws, editable in place; the dates are pills (the
 * due date opens the app's `DatePicker`); links and blockers are small pills with a count that open
 * a popover in the SAME portal panel the board's menus use (`PanelMenu`, `PickerMenu.tsx`); and
 * delete lives behind a ⋯ button (`TaskMoreMenu`) built like the subtask row's menu.
 *
 * It is one component for two callers — the page's `TaskHero` and the session aside's dense
 * `DeliveryDetail`, which has no hero — so a control that exists on the page cannot be missing from
 * the aside. It owns the dialogs its writes can raise (`blocked` asks for a reason, `done` is
 * refused without a session), because the status chip is the only thing that raises them.
 */

import { useState } from 'react'
import { Link2, MoreHorizontal, Pencil, Plus, Trash2, XCircle } from 'lucide-react'
import { PRIORITY_ORDER, sortTaskTypes, type TaskPriorityId, type TaskStatusDef } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Select, ConfirmModal } from '../../pages/settings/primitives'
import { DatePicker } from '../DatePicker'
import {
  PRIORITY, button, field, fmtDateTime, fmtStamp, pill, statusStyle,
} from './board'
import { BlockedDialog } from './BlockedDialog'
import { boardCopy, statusLabel, type Lang } from './copy'
import { chipStyle, ChipSelect } from './ChipSelect'
import { DoneNeedsSessionDialog } from './DoneNeedsSessionDialog'
import { PanelMenu } from './PickerMenu'
import { StatusChip } from './StatusChip'
import { DurationCellView } from './SubtaskDurationCell'
import { rowButtonStyle } from './SubtaskActionsMenu'
import {
  addLink, deleteTask, editTask, markTask, removeLink, setBlockedBy, useTaskList,
  useTaskTypes,
  type TaskDetail, type TaskListRow, type TaskRecord, type TaskStatus,
} from '../../lib/tasks'
import { durationChipLabel, typeChipLabel } from './taskChipParts'

type Statuses = readonly TaskStatusDef[] | null

/** The look of a header pill — the hero's own, so a popover trigger and a read-only date agree. */
function pillStyle(tone?: string): React.CSSProperties {
  return chipStyle(tone ?? 'var(--text-secondary)', 'var(--ag-tint-2)')
}

/** Links out — a PR, an issue, a doc. Only http(s) reaches here; the server refuses the rest. */
function LinksList({ id, task, lang, onChanged }: {
  id: string
  task: TaskRecord
  lang: Lang
  onChanged: () => Promise<void> | void
}) {
  const isMobile = useIsMobile()
  const copy = boardCopy(lang).header
  const [url, setUrl] = useState('')
  const links = task.links ?? []
  const add = async () => {
    if (!url.trim()) return
    // A GitHub PR/issue URL names its own kind — nobody should have to say it twice.
    const kind = /\/pull\/\d+/.test(url) ? 'pr' : /\/issues\/\d+/.test(url) ? 'issue' : undefined
    await addLink(id, url.trim(), undefined, kind)
    setUrl('')
    await onChanged()
  }
  return (
    <div style={{ display: 'grid', gap: 9, padding: 2 }}>
      {links.length === 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{copy.noLinks}</div>
      )}
      {links.map(l => (
        <div key={l.id} style={{ display: 'flex', gap: 7, alignItems: 'center', minHeight: isMobile ? 34 : 22 }}>
          <Link2 size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          <a
            href={l.url} target="_blank" rel="noreferrer"
            style={{
              fontSize: 11.5, color: 'var(--anthropic-orange)', textDecoration: 'none',
              flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >{l.label ?? l.url.replace(/^https?:\/\//, '')}</a>
          {l.kind && <span style={pill()}>{l.kind}</span>}
          <button
            className="ag-tap-icon"
            onClick={() => void removeLink(id, l.id).then(onChanged)}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
            title={copy.remove} aria-label={copy.remove}
          ><XCircle size={13} /></button>
        </div>
      ))}
      <input
        style={field(isMobile)} value={url} placeholder={copy.pasteLink}
        onChange={e => setUrl(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void add() }}
      />
    </div>
  )
}

/**
 * The blockers, Jira's "is blocked by".
 *
 * A blocker that is already closed is struck through rather than removed: the record of what held
 * the work up is part of the task's story, and silently dropping it rewrites that story.
 */
function BlockerList({ id, task, lang, statuses, onChanged }: {
  id: string
  task: TaskRecord
  lang: Lang
  statuses: Statuses
  onChanged: () => Promise<void> | void
}) {
  const isMobile = useIsMobile()
  const copy = boardCopy(lang).header
  const { rows } = useTaskList()
  const [picking, setPicking] = useState(false)
  const blockers = (task.blockedBy ?? [])
    .map(bid => rows?.find(r => r.task.id === bid))
    .filter((r): r is TaskListRow => r !== undefined)
  const openBlockers = blockers.filter(b => b.task.status !== 'done' && b.task.status !== 'abandoned')
  const set = async (ids: string[]) => { await setBlockedBy(id, ids); await onChanged() }

  return (
    <div style={{ display: 'grid', gap: 9, padding: 2 }}>
      {openBlockers.length > 0 && (
        <span style={{ ...pill('var(--accent-red)'), justifySelf: 'start' }}>
          {copy.openRows.replace('{n}', String(openBlockers.length))}
        </span>
      )}
      {blockers.length === 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{copy.noBlockers}</div>
      )}
      {blockers.map(b => {
        const closed = b.task.status === 'done' || b.task.status === 'abandoned'
        return (
          <div key={b.task.id} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: isMobile ? 34 : 22 }}>
            <span style={{
              fontSize: 11.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textDecoration: closed ? 'line-through' : 'none',
              color: closed ? 'var(--text-tertiary)' : 'var(--text-secondary)',
            }}>{b.task.title}</span>
            <span style={pill(statusStyle(statuses, b.task.status).color)}>
              {statusLabel(b.task.status, lang, statuses)}
            </span>
            <button
              className="ag-tap-icon"
              onClick={() => void set((task.blockedBy ?? []).filter(x => x !== b.task.id))}
              style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
              title={copy.remove} aria-label={copy.remove}
            ><XCircle size={13} /></button>
          </div>
        )
      })}
      {picking
        ? (
          // The APPLICATION's picker, not the browser's: searchable once the board has more than a
          // handful of tasks, which is exactly when picking a blocker by scrolling stops working.
          <Select
            value=""
            placeholder={copy.pickTask}
            searchPlaceholder={copy.searchTasks}
            options={(rows ?? [])
              // A task never blocks itself, and one already listed is not offered twice.
              .filter(r => r.task.id !== id && !(task.blockedBy ?? []).includes(r.task.id))
              .map(r => ({
                value: r.task.id,
                label: r.task.title,
                hint: statusLabel(r.task.status, lang, statuses),
              }))}
            onChange={v => {
              if (v) void set([...(task.blockedBy ?? []), v])
              setPicking(false)
            }}
          />
        )
        : (
          <button style={{ ...button(isMobile), justifySelf: 'start' }} onClick={() => setPicking(true)}>
            <Plus size={13} /> {copy.addBlocker.replace(/^\+\s*/, '')}
          </button>
        )}
    </div>
  )
}

export function TaskChips({ id, detail, lang, statuses, reload, onFileSession, children }: {
  id: string
  detail: TaskDetail
  lang: Lang
  /** The board's LIVE status list (`lib/tasks.ts`'s `useTaskStatuses`) — `null` while it loads. */
  statuses: Statuses
  /** Re-read the task after a write. The CALLER owns the fetch — see `useTaskDetail`. */
  reload: () => void | Promise<void>
  /** "File a session" from the done-needs-a-session refusal — the caller opens its Subtasks tab. */
  onFileSession?: () => void
  /** Extra pills at the end of the row (the hero's "N live"). */
  children?: React.ReactNode
}) {
  const copy = boardCopy(lang)
  const h = copy.header
  const task = detail.task
  const { rows: boardRows } = useTaskList()
  const { types } = useTaskTypes()
  const [busy, setBusy] = useState(false)
  /** Set while the task is on its way to `blocked` — the reason dialog is ours. */
  const [blocking, setBlocking] = useState(false)
  /** Set when a `done` write refused for having no session filed under this task yet. */
  const [doneRefusal, setDoneRefusal] = useState(false)

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); await fn(); await reload(); setBusy(false) }
  const onStatus = async (st: TaskStatus) => {
    if (st === 'blocked') { setBlocking(true); return }
    setBusy(true)
    const result = await markTask(id, st)
    setBusy(false)
    if (!result.ok && result.reason === 'done_needs_session') { setDoneRefusal(true); return }
    await reload()
  }

  // `startedAt`/`deliveredAt` are SYSTEM facts, never a date somebody typed — see `Task.startedAt`'s
  // own note — so they are read as a full moment and are pills, not pickers. The DUE date is the
  // one date a person sets.
  const times = detail.times
  const startedAt = times ? times.startedAt ?? undefined : task.startedAt
  const completedAt = times ? times.completedAt ?? undefined : task.deliveredAt
  const now = Date.now()
  const linkCount = task.links?.length ?? 0
  const blockerIds = task.blockedBy ?? []
  const openBlockers = blockerIds.filter(bid => {
    const r = boardRows?.find(x => x.task.id === bid)
    return r ? r.task.status !== 'done' && r.task.status !== 'abandoned' : false
  }).length

  const blockedStyle = statusStyle(statuses, 'blocked')

  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <StatusChip
          value={task.status} lang={lang} statuses={statuses} compact block={false}
          {...(busy ? { disabled: true } : {})}
          onPick={st => void onStatus(st as TaskStatus)}
        />
        <ChipSelect
          value={!task.priority || task.priority === 'none' ? 'low' : task.priority}
          compact block={false}
          disabled={busy}
          options={PRIORITY_ORDER.map(pid => ({
            value: pid, label: PRIORITY[pid]!.label, color: PRIORITY[pid]!.color, dim: PRIORITY[pid]!.dim,
          }))}
          onPick={v => void run(() => editTask(id, { priority: v as TaskPriorityId }))}
        />
        <ChipSelect
          value={task.type ?? '__none__'}
          compact block={false}
          disabled={busy}
          options={[
            { value: '__none__', label: typeChipLabel(undefined, types, h.type, '—'), color: 'var(--text-tertiary)', dim: 'var(--border)' },
            ...sortTaskTypes(types ?? []).map(t => ({
              value: t.id, label: typeChipLabel(t.id, types, h.type, '—'), color: t.color, dim: `rgba(${parseInt(t.color.slice(1, 3), 16)}, ${parseInt(t.color.slice(3, 5), 16)}, ${parseInt(t.color.slice(5, 7), 16)}, 0.16)`,
            })),
          ]}
          onPick={v => void run(() => editTask(id, { type: v === '__none__' ? '' : v }))}
        />

        {startedAt && (
          <span title={fmtStamp(startedAt, lang)} style={pillStyle()}>
            {h.start.replace('{date}', fmtDateTime(startedAt, lang, now))}
          </span>
        )}
        {/* The due date: the existing calendar, in a pill-shaped frame. It reaches into the future,
            which the picker's default bound (today) forbids. */}
        <span style={{ ...pillStyle(), padding: 0 }}>
          <DatePicker
            value={task.dueDate ?? ''}
            onChange={d => void run(() => editTask(id, { dueDate: d }))}
            label={lang === 'pt' ? 'Prazo' : 'Due'}
            placeholder="—"
            max="2100-12-31"
            stuck
            lang={lang}
            labelStyle={{ textTransform: 'none', letterSpacing: 0, fontSize: 12, fontWeight: 600, opacity: 1 }}
          />
        </span>
        {completedAt && (
          <span title={fmtStamp(completedAt, lang)} style={pillStyle()}>
            {h.done.replace('{date}', fmtDateTime(completedAt, lang, now))}
          </span>
        )}
        {((startedAt && completedAt) || (times && times.activeMinutes !== null)) && (
          <span style={pillStyle()} title={copy.duration}>
            {durationChipLabel(startedAt, completedAt, times?.activeMinutes ?? null, lang)}
          </span>
        )}

        <PanelMenu
          title={copy.links}
          width={320}
          triggerClassName="ag-tap"
          triggerStyle={{ ...pillStyle(), cursor: 'pointer', ...(linkCount === 0 ? { color: 'var(--text-tertiary)' } : {}) }}
          render={() => <LinksList id={id} task={task} lang={lang} onChanged={reload} />}
        >
          {linkCount > 0 ? <><Link2 size={12} />{h.links.replace('{n}', String(linkCount))}</> : h.addLink}
        </PanelMenu>

        <PanelMenu
          title={copy.blockedBy}
          width={320}
          triggerClassName="ag-tap"
          triggerStyle={{
            ...pillStyle(openBlockers > 0 ? 'var(--accent-red)' : undefined), cursor: 'pointer',
            ...(blockerIds.length === 0 ? { color: 'var(--text-tertiary)' } : {}),
          }}
          render={() => <BlockerList id={id} task={task} lang={lang} statuses={statuses} onChanged={reload} />}
        >
          {blockerIds.length > 0 ? h.blocked.replace('{n}', String(blockerIds.length)) : h.addBlocker}
        </PanelMenu>
        {children}
      </div>

      {task.status === 'blocked' && task.blockedReason && (
        // Asking for the reason and then not showing it would be theatre. It sits under the chips,
        // in the blocked status's own colour, and goes when the task leaves `blocked`.
        <div style={{
          fontSize: 12, lineHeight: 1.5, padding: '8px 10px', borderRadius: 7,
          background: blockedStyle.dim, color: 'var(--text-secondary)',
          border: `1px solid ${blockedStyle.color}`, marginTop: 8,
        }}>
          <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 3, color: blockedStyle.color }}>
            {copy.waitingOn}
          </span>
          {task.blockedReason}
        </div>
      )}

      {blocking && (
        <BlockedDialog
          titles={[task.title]}
          rows={(boardRows ?? []).filter(r => r.task.id !== id)}
          already={task.blockedBy ?? []}
          onCancel={() => setBlocking(false)}
          onConfirm={async ({ reason, blockedBy }) => {
            setBlocking(false)
            await run(() => markTask(id, 'blocked', { reason, blockedBy }))
          }}
        />
      )}

      {doneRefusal && (
        <DoneNeedsSessionDialog
          title={task.title}
          scope="task"
          lang={lang}
          onCancel={() => setDoneRefusal(false)}
          onFile={() => { setDoneRefusal(false); onFileSession?.() }}
        />
      )}
    </>
  )
}

/** The ⋯ at the header's right: today only Delete, behind the confirmation it always had. */
export function TaskMoreMenu({ id, task, lang, onDeleted, onRename }: {
  id: string
  task: TaskRecord
  lang: Lang
  onDeleted: () => void
  /** Start renaming in place (the page's heading). Absent = no Rename row. */
  onRename?: () => void
}) {
  const isMobile = useIsMobile()
  const h = boardCopy(lang).header
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <PanelMenu
        width={220}
        align="right"
        ariaLabel={h.more}
        triggerClassName="ag-tap-icon"
        triggerStyle={{
          ...button(isMobile), height: isMobile ? 36 : 32, width: isMobile ? 36 : 32, padding: 0,
          background: 'var(--ag-tint-2)',
        }}
        render={close => (
          <>
            {onRename && (
              <button
                onClick={() => { close(); onRename() }}
                style={rowButtonStyle(isMobile, false)}
              ><Pencil size={13} /> {h.renameTask}</button>
            )}
            <button
              disabled={busy}
              onClick={() => { close(); setConfirm(true) }}
              style={rowButtonStyle(isMobile, true)}
            ><Trash2 size={13} /> {h.deleteTask}</button>
          </>
        )}
      ><MoreHorizontal size={15} /></PanelMenu>
      <ConfirmModal
        open={confirm}
        title="Delete this task?"
        message={`"${task.title}" and its comments, subtasks, files and links go. The SESSIONS filed under it are kept — deleting a board entry never deletes work.`}
        confirmLabel="Delete task"
        cancelLabel="Keep it"
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false)
          setBusy(true)
          void deleteTask(id).then(() => { setBusy(false); onDeleted() })
        }}
      />
    </>
  )
}

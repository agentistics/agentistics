/**
 * SubtaskDetail — one SUBTASK's own view, drawn where a session filed under it needs its own
 * numbers rather than the whole delivery's.
 *
 * `SessionTasksTab` used to hand the WHOLE `TaskDetail` to `DeliveryDetail` even when the session
 * sits under one specific subtask, so the panel showed the TASK's own status/priority/dates and the
 * TASK's own delivery-evidence numbers (files/errors/lines/tokens/commits) beside a session that
 * only ever touched a slice of that work — a delivery reading `files 123` next to a session that
 * filed three of them. See docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §C.5.
 *
 * This is a NEW, SMALLER sibling of `DeliveryDetail` rather than a `scopeToSubtask` prop threaded
 * through it — that component is 1400+ lines that never need to know about one subtask, and
 * teaching it two contradictory modes (the whole task vs. one piece of it) would spread the concept
 * through every one of its reads instead of keeping it in one place.
 *
 * What it reuses UNMODIFIED (exported from `DeliveryDetail.tsx` for exactly this): `Rollup` and
 * `Stat` (the same building blocks the rail draws the whole task's numbers with), and `CommentsTab`
 * — comments carry no `subtaskId` today and stay TASK-WIDE by design (the spec's own §C.5
 * reasoning), so every comment shows here, never a filtered set. `subtaskSessions` draws the chip
 * list of sessions filed under this subtask (or its group, see below) exactly as `SubtaskTable.tsx`
 * already does on the board.
 *
 * What it deliberately DROPS relative to the full page: attempts, the subtasks table (a subtask has
 * no subtasks of its own), the files tab and the activity log — task-level administrivia a person
 * can still reach with the "Open on the board" button `SessionTasksTab` already offers above this
 * panel.
 *
 * **No priority row.** `Subtask` carries no `priority` field — that column is task-only — so
 * showing the TASK's priority here would be exactly the bug this component exists to fix, one field
 * at a time. Omitting it is the honest choice, the same "N/A over a confident but wrong number"
 * rule this codebase applies everywhere else.
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useIsMobile } from '../../hooks/useIsMobile'
import { sessionPath } from '../../lib/sessionRoute'
import { NA, field, fmtInt, microLabel, surface } from './board'
import { boardCopy, type Lang } from './copy'
import { RailSection } from './RailSection'
import { StatusChip } from './StatusChip'
import { TaskProgressBar } from './TaskProgressBar'
import { subtaskSessions } from './SubtaskSessions'
import { SessionPicker } from './SessionPicker'
import { DatePicker } from '../DatePicker'
import { CommentsTab, Rollup, Stat } from './DeliveryDetail'
import { subtaskRollupOf, subtaskStatsOf } from './subtaskRollup'
import { isGroupSubtask } from './subtaskGroups'
import {
  attachSession, detachSession, fmtDuration, patchSubtask,
  type Subtask, type TaskDetail, type TaskStatus,
} from '../../lib/tasks'

export interface SubtaskDetailProps {
  taskId: string
  /** The subtask this session is filed under — resolved by `SessionTasksTab` from the session's own
   *  row, never guessed. */
  subtask: Subtask
  detail: TaskDetail
  lang: Lang
  /** Re-read the delivery after a write. The CALLER owns the fetch — see `useTaskDetail`. */
  reload: () => void | Promise<void>
}

export function SubtaskDetail(p: SubtaskDetailProps) {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const copy = boardCopy(p.lang)
  const pt = p.lang === 'pt'
  const [busy, setBusy] = useState(false)
  const [linking, setLinking] = useState(false)

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); await fn(); await p.reload(); setBusy(false) }
  const patch = (changes: Partial<Pick<Subtask, 'status' | 'assignee' | 'dueDate' | 'startDate'>>) =>
    run(() => patchSubtask(p.taskId, p.subtask.id, changes))

  const rollup = subtaskRollupOf(p.detail.subtaskRollups, p.subtask)
  const stats = subtaskStatsOf(p.detail.subtaskRollups, p.subtask)
  const duration = stats ? fmtDuration(stats.deliveryMs) : null

  // §F.1 supersedes §B's shared-bucket model: a MEMBER can never hold a session (refused
  // server-side, `subtask_in_group`), so this panel is only ever reached for a loose subtask or a
  // GROUP — either way, its own sessions are exactly the ones filed on ITS OWN id, never a union of
  // a group's members'. See docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §F.3.
  const groupIds = [p.subtask.id]
  const view = p.detail.subtaskRollups.find(v => v.id === p.subtask.id)

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ ...surface, padding: 14, display: 'grid', gap: 11 }}>
        <span style={{ fontSize: 13.5, fontWeight: 650 }}>{p.subtask.title}</span>

        {/* A GROUP's own progress (§F.1) — from its members' `status`, the same round-down bar
            `SubtaskTable` draws on the board. A loose subtask has no `groupProgress` and this
            renders nothing, same as `TaskProgressBar`'s own "nothing to be a fraction of" rule. */}
        {isGroupSubtask(p.subtask) && view?.groupProgress && (
          <TaskProgressBar done={view.groupProgress.done} total={view.groupProgress.total} />
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 120px', display: 'grid', gap: 5, minWidth: 0 }}>
            <span style={{ ...microLabel, fontSize: 9 }}>Status</span>
            <StatusChip
              value={p.subtask.status}
              lang={p.lang}
              {...(busy ? { disabled: true } : {})}
              onPick={st => void patch({ status: st as TaskStatus })}
            />
          </div>
          <div style={{ flex: '1 1 120px', display: 'grid', gap: 5, minWidth: 0 }}>
            <span style={{ ...microLabel, fontSize: 9 }}>{copy.owner}</span>
            <input
              defaultValue={p.subtask.assignee ?? ''} placeholder="—"
              onBlur={e => {
                if (e.target.value !== (p.subtask.assignee ?? '')) void patch({ assignee: e.target.value })
              }}
              style={field(isMobile)}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {([
            ['Start', copy.start, p.subtask.startDate ?? ''],
            ['Due', copy.due, p.subtask.dueDate ?? ''],
          ] as const).map(([key, label, value]) => (
            <div
              key={key}
              style={{
                flex: '1 1 120px', display: 'flex', alignItems: 'center', ...surface,
                background: 'var(--bg-elevated)', borderRadius: 7, padding: '1px 4px',
              }}
            >
              <DatePicker
                value={value} label={label} placeholder="DD/MM/YY" lang={p.lang}
                {...(key === 'Due' && p.subtask.startDate ? { min: p.subtask.startDate } : {})}
                onChange={v => void patch(key === 'Start' ? { startDate: v } : { dueDate: v })}
              />
            </div>
          ))}
        </div>
      </div>

      {rollup && (
        <div style={{ ...surface, padding: 14 }}>
          <div style={{ ...microLabel, marginBottom: 9 }}>{pt ? 'Nesta parte' : 'In this part'}</div>
          <Rollup r={rollup} lang={p.lang} />
        </div>
      )}

      <RailSection id="subtask-evidence" title={copy.delivery} badge={duration ?? NA} defaultOpen>
        {stats
          ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <Stat label={copy.deliveryTime} value={duration ?? NA} />
              {duration === null && (
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: -8 }}>{copy.stillOpen}</div>
              )}
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <Stat label={copy.agentRuns} value={fmtInt(stats.agentRuns)} />
                <Stat label={copy.commits} value={fmtInt(stats.commits)} />
              </div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <Stat label={copy.files} value={fmtInt(stats.filesModified)} />
                <Stat label={copy.errors} value={fmtInt(stats.toolErrors)} />
              </div>
              <Stat
                label={copy.lines}
                value={stats.linesAdded === null && stats.linesRemoved === null
                  ? NA : `+${stats.linesAdded ?? 0} / −${stats.linesRemoved ?? 0}`}
              />
            </div>
          )
          : (
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              {pt ? 'Nada filiado aqui ainda.' : 'Nothing filed here yet.'}
            </div>
          )}
      </RailSection>

      <RailSection id="subtask-sessions" title={copy.sessions} defaultOpen>
        {subtaskSessions({
          subtaskId: p.subtask.id,
          subtaskIds: groupIds,
          sessions: p.detail.sessions,
          lang: p.lang,
          mobile: isMobile,
          onLink: () => setLinking(true),
          onUnfile: sid => void run(() => detachSession(p.taskId, sid)),
          onOpen: sid => navigate(sessionPath(sid)),
        })}
      </RailSection>

      <CommentsTab id={p.taskId} detail={p.detail} onChanged={p.reload} />

      {linking && (
        <SessionPicker
          onPick={async ids => {
            for (const id of ids) await attachSession(p.taskId, id, p.subtask.id)
            await p.reload()
          }}
          onClose={() => setLinking(false)}
        />
      )}
    </div>
  )
}

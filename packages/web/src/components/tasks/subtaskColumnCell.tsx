/**
 * subtaskColumnCell — the non-status cells a subtask row draws, keyed by `SubtaskColumnId`, shared
 * between `SubtaskTable.tsx`'s own grid and `TaskTable.tsx`'s inline subitem rows (t-63b7d3b2b0 #1)
 * so hiding, showing or reordering a column reads the identical cell wherever it is drawn — a second
 * formatting rule for the same figure is exactly what `CLAUDE.md`'s "Calculation functions — single
 * source of truth" forbids.
 *
 * `status` is deliberately NOT here: the two surfaces draw it through genuinely different controls
 * (a custom popover on the standalone grid, `ChipSelect` on the inline one, unrelated to this pass)
 * and each still renders it itself when its own column loop reaches `'status'`.
 */

import { fmtDateTime, fmtStamp } from './board'
import { DurationCellView } from './SubtaskDurationCell'
import { SubtaskSessions } from './SubtaskSessions'
import { CostCellView, TokensCellView } from './SubtaskMoneyCells'
import { ModelCellView } from './SubtaskModelCell'
import { TaskProgressBar } from './TaskProgressBar'
import { isGroupSubtask } from './subtaskGroups'
import { costCellFor, effectiveTimes, subtaskRollupOf, tokensCellFor } from './subtaskRollup'
import type { Money } from './money'
import type { Lang } from './copy'
import type { Subtask, SubtaskView, TaskSessionRow } from '../../lib/tasks'
import type { SubtaskColumnId } from './subtaskColumnDefs'

export interface SubtaskColumnContext {
  subtask: Subtask
  /** True for a group MEMBER (`isGroupMember`) — a member can never hold a session of its own
   *  (`subtask_in_group`), so the 'sessions' column offers no filing control at all here, matching
   *  every caller's own pre-existing `{!isMember && <SubtaskSessions .../>}` guard. */
  isMember: boolean
  /** The DELIVERY's whole sessions list — every column here filters it down to this subtask's own
   *  rows itself, exactly like `SubtaskSessions` already does internally for the sessions cell. */
  sessions: readonly TaskSessionRow[]
  subtaskRollups: readonly SubtaskView[]
  lang: Lang
  nowMs: number
  isMobile: boolean
  money: Money
  onLink: (subtaskId: string) => void
  onUnfile: (sessionId: string) => void
  onOpenSession?: (sessionId: string) => void
}

export function subtaskColumnCell(
  col: Exclude<SubtaskColumnId, 'status'>,
  ctx: SubtaskColumnContext,
): React.ReactNode {
  const t = ctx.subtask
  const times = effectiveTimes(ctx.subtaskRollups, t)
  switch (col) {
    case 'progress': {
      // A GROUP's bar is its members' (`groupProgress`, round-down like every bar here); a plain
      // subtask is one unit of work, done or not. A group with no members draws nothing — the
      // same "nobody broke this up" rule `TaskProgressBar` applies.
      const gp = isGroupSubtask(t) ? ctx.subtaskRollups.find(v => v.id === t.id)?.groupProgress : undefined
      if (isGroupSubtask(t) && !gp) return null
      const done = gp ? gp.done : t.done ? 1 : 0
      const total = gp ? gp.total : 1
      return <div style={{ minWidth: 72 }}><TaskProgressBar done={done} total={total} showPercent={false} /></div>
    }
    case 'started':
      return (
        <span
          title={times.startedAt ? fmtStamp(times.startedAt, ctx.lang) : undefined}
          style={{
            fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
            color: times.startedAt ? 'var(--text-secondary)' : 'var(--text-tertiary)',
          }}
        >{fmtDateTime(times.startedAt, ctx.lang, ctx.nowMs)}</span>
      )
    case 'completed':
      return (
        <span
          title={times.completedAt ? fmtStamp(times.completedAt, ctx.lang) : undefined}
          style={{
            fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
            color: times.completedAt ? 'var(--text-secondary)' : 'var(--text-tertiary)',
          }}
        >{fmtDateTime(times.completedAt, ctx.lang, ctx.nowMs)}</span>
      )
    case 'duration':
      return <DurationCellView startedAt={times.startedAt} deliveredAt={times.completedAt} activeMinutes={times.activeMinutes} lang={ctx.lang} />
    case 'sessions':
      return ctx.isMember ? null : (
        <SubtaskSessions
          subtaskId={t.id} subtaskIds={[t.id]} sessions={ctx.sessions} lang={ctx.lang}
          mobile={ctx.isMobile} onLink={ctx.onLink} onUnfile={ctx.onUnfile} onOpen={ctx.onOpenSession}
        />
      )
    case 'model':
      return <ModelCellView sessions={ctx.sessions.filter(s => s.subtaskId === t.id)} />
    case 'cost': {
      const r = subtaskRollupOf(ctx.subtaskRollups, t)
      return <CostCellView r={r} cost={costCellFor(r)} money={ctx.money} />
    }
    case 'tokens': {
      const r = subtaskRollupOf(ctx.subtaskRollups, t)
      return <TokensCellView tok={tokensCellFor(r)} />
    }
  }
}

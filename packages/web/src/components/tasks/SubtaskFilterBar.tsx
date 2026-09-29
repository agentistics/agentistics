/**
 * SubtaskFilterBar — the subtask grid's own column filter: status, harness, model (t-63b7d3b2b0 #2).
 *
 * Three `ChipSelect`s, each with an "All" sentinel as its resting value — the same shape the batch
 * bar's own `Move to…` select already uses for "no value picked yet". Client-side, over one
 * delivery's own already-loaded rows (`subtaskFilter.ts`'s own header explains why the server is not
 * involved), and NOT persisted: it narrows what is on screen for this one look at the board, the same
 * ephemeral lifetime `TaskTable.tsx`'s own per-column sort override already has.
 */

import { ChipSelect, type ChipOption } from './ChipSelect'
import { harnessColor, liveStatusMap, liveStatusOrder } from './board'
import {
  distinctHarnesses, distinctModels, EMPTY_SUBTASK_FILTER, subtaskFilterActive, type SubtaskFilterState,
} from './subtaskFilter'
import { boardCopy, type Lang } from './copy'
import type { TaskSessionRow } from '../../lib/tasks'
import type { TaskStatusDef } from '@agentistics/core'

const ALL = '__all__'
const neutral = (label: string): ChipOption =>
  ({ value: ALL, label, color: 'var(--text-secondary)', dim: 'var(--bg-elevated)' })

export function SubtaskFilterBar({ value, onChange, sessions, statuses, lang }: {
  value: SubtaskFilterState
  onChange: (next: SubtaskFilterState) => void
  /** The delivery's whole sessions list — the filter's harness/model options come from what is
   *  actually filed, so it never offers a value nothing could ever match. */
  sessions: readonly TaskSessionRow[]
  statuses: readonly TaskStatusDef[] | null
  lang: Lang
}) {
  const copy = boardCopy(lang).subtaskFilter
  const map = liveStatusMap(statuses)
  const statusOptions: ChipOption[] = [
    neutral(copy.all),
    ...liveStatusOrder(statuses).map(id => {
      const s = map[id] ?? { label: id, color: 'var(--text-tertiary)', dim: 'var(--border)' }
      return { value: id, label: s.label, color: s.color, dim: s.dim }
    }),
  ]
  const harnessOptions: ChipOption[] = [
    neutral(copy.all),
    ...distinctHarnesses(sessions).map(h => ({ value: h, label: h, color: harnessColor(h), dim: 'var(--bg-elevated)' })),
  ]
  const modelOptions: ChipOption[] = [
    neutral(copy.all),
    ...distinctModels(sessions).map(m => ({ value: m, label: m, color: 'var(--text-secondary)', dim: 'var(--bg-elevated)' })),
  ]
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ minWidth: 108 }}>
        <ChipSelect
          compact block={false} title={copy.status} value={value.status ?? ALL} options={statusOptions}
          onPick={v => onChange({ ...value, status: v === ALL ? null : v })}
        />
      </span>
      <span style={{ minWidth: 108 }}>
        <ChipSelect
          compact block={false} title={copy.harness} value={value.harness ?? ALL} options={harnessOptions}
          onPick={v => onChange({ ...value, harness: v === ALL ? null : v })}
        />
      </span>
      <span style={{ minWidth: 108 }}>
        <ChipSelect
          compact block={false} title={copy.model} value={value.model ?? ALL} options={modelOptions}
          onPick={v => onChange({ ...value, model: v === ALL ? null : v })}
        />
      </span>
      {subtaskFilterActive(value) && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_SUBTASK_FILTER)}
          style={{
            background: 'none', border: 'none', color: 'var(--anthropic-orange)', cursor: 'pointer',
            fontSize: 11, textDecoration: 'underline', padding: 0,
          }}
        >{copy.clear}</button>
      )}
    </span>
  )
}

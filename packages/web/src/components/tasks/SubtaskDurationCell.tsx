/**
 * SubtaskDurationCell — the Duration cell ("deliveredAt − startedAt") a subtask row draws, wherever
 * a subtask row is drawn (`SubtaskTable.tsx`'s own grid and `TaskTable.tsx`'s inline subitem rows) —
 * one rendering rule for the same figure, the same reason `SubtaskMoneyCells.tsx` exists for
 * Cost/Tokens (see `CLAUDE.md`'s "Calculation functions — single source of truth").
 *
 * EMPTY (no text at all, not even N/A) whenever either timestamp is missing — a subtask not yet
 * delivered has no total, and that is a different fact from a total that could not be computed.
 * `NA` only when both timestamps exist but the span itself is unusable (bad data, e.g. delivered
 * stamped before started) — `elapsedMs`/`fmtElapsed` (`@agentistics/core`) decide that, the SAME
 * arithmetic `subtaskSort.ts`'s `duration` key sorts by, so the cell and the comparator can never
 * disagree about what counts as "no answer".
 *
 * The title tooltip is the exact span, spelled out as the two moments it runs between
 * (`fmtStamp`, which always carries the full date, time and year) — "1h 2min" on the cell would
 * otherwise be the only place a reader could see WHEN that hour and two minutes happened.
 */

import { fmtElapsed, elapsedMs } from '@agentistics/core'
import { NA, fmtStamp } from './board'
import type { Lang } from './copy'

export function DurationCellView({ startedAt, deliveredAt, lang }: {
  startedAt?: string
  deliveredAt?: string
  lang: Lang
}) {
  if (!startedAt || !deliveredAt) return null
  const ms = elapsedMs(startedAt, deliveredAt)
  const text = ms === null ? null : fmtElapsed(ms, lang)
  return (
    <span
      title={`${fmtStamp(startedAt, lang)} → ${fmtStamp(deliveredAt, lang)}`}
      style={{
        fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
        color: text === null ? 'var(--text-tertiary)' : 'var(--text-secondary)',
      }}
    >{text ?? NA}</span>
  )
}

/**
 * SubtaskModelCell — the Model cell a subtask row draws, wherever a subtask row is drawn
 * (`SubtaskTable.tsx`'s own grid and `TaskTable.tsx`'s inline subitem rows) — one rendering rule for
 * the same figure, the same reason `SubtaskMoneyCells.tsx`/`SubtaskDurationCell.tsx` exist (t-63b7d3b2b0 #3).
 *
 * EMPTY (no text at all, not even "N/A") when nothing is filed under the subtask yet — the same
 * "not measured" rule `subtaskRollup.ts`'s `isUntracked` applies to Cost/Tokens, read here over the
 * raw session rows instead of the server's rollup (there is no model total to bucket by). "N/A" is
 * reserved for sessions that ARE filed but named no model at all (an unresolved harness, or a
 * session whose transcript never recorded one) — a real measurement that came back empty.
 *
 * A subtask can hold several sessions running DIFFERENT models — the distinct values are shown
 * side by side, never collapsed into a generic "mixed" label, which would hide exactly the fact
 * somebody opened this column to see.
 */

import { NA } from './board'
import { modelDisplay } from '../../lib/modelDisplay'
import type { TaskSessionRow } from '../../lib/tasks'

/** The distinct, non-null models among these sessions, in first-seen order. */
export function modelsOf(sessions: readonly TaskSessionRow[]): string[] {
  const out: string[] = []
  for (const s of sessions) {
    if (s.model && !out.includes(s.model)) out.push(s.model)
  }
  return out
}

/**
 * The distinct models as a person reads them — `harness · Sonnet 5.5`, the very shape the Live card's
 * runtime pill draws (`cardPills` in `liveDeliveryModel.ts`, through the shared `modelDisplay`), so one
 * session never reads "claude-sonnet-5-5" here and "claude · Sonnet 5.5" there. `modelsOf` stays the
 * raw ids: the model FILTER matches on what was recorded.
 */
export function modelLabelsOf(sessions: readonly TaskSessionRow[]): string[] {
  const out: string[] = []
  for (const s of sessions) {
    if (!s.model) continue
    const label = `${s.harness} · ${modelDisplay(s.harness, s.model) ?? s.model}`
    if (!out.includes(label)) out.push(label)
  }
  return out
}

export function ModelCellView({ sessions }: { sessions: readonly TaskSessionRow[] }) {
  if (sessions.length === 0) return null
  const models = modelLabelsOf(sessions)
  if (models.length === 0) {
    return <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{NA}</span>
  }
  return (
    <span
      title={models.join(', ')}
      style={{
        fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden',
        textOverflow: 'ellipsis', display: 'inline-block', maxWidth: '100%',
      }}
    >{models.join(', ')}</span>
  )
}

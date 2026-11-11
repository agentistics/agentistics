/**
 * HarnessBadges — the harnesses a delivery's sessions ran on, as a bounded row of pills.
 *
 * One component instead of four near-identical inline renders (the main board table, a repo's
 * Tasks tab table and its mobile card, the kanban card) is what
 * `TaskProgressBar` already does for the progress bar, and for the same reason: four copies of one
 * rule is four chances for it to read differently on each screen.
 *
 * The rule it fixes: a task's harnesses list was rendered in full, `flexWrap`-ped, with no cap —
 * every harness this product supports, every one a distinct pill, in a column that has to sit next
 * to five or six other columns. A task whose sessions spanned most harnesses turned the column into
 * a block of colour nobody could read at a glance ("acumula badges e fica ilegível"). `capList`
 * (`board.ts`) caps it, and the remainder becomes a single `+N` pill — truthful (it names the exact
 * count) rather than silently dropped, and its `title` still lists every hidden harness so nothing
 * is actually lost, only deferred to a hover.
 */

import { capList, harnessColor, pill, NA } from './board'

const DEFAULT_MAX = 4

export function HarnessBadges({ harnesses, max = DEFAULT_MAX, fontSize }: {
  harnesses: readonly string[]
  /** How many pills to draw before folding the rest into `+N`. */
  max?: number
  /** Some callers (dense table cells) run the pill text smaller than the board default. */
  fontSize?: number
}) {
  if (harnesses.length === 0) return <span style={{ color: 'var(--text-tertiary)' }}>{NA}</span>
  const { shown, extra } = capList(harnesses, max)
  const style = fontSize ? { fontSize } : undefined
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
      {shown.map(h => (
        <span key={h} style={{ ...pill(harnessColor(h)), ...style }}>{h}</span>
      ))}
      {extra > 0 && (
        <span
          title={harnesses.slice(max).join(', ')}
          style={{ ...pill(), ...style, fontWeight: 600 }}
        >
          +{extra}
        </span>
      )}
    </span>
  )
}

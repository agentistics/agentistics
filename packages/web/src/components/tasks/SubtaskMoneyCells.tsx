/**
 * SubtaskMoneyCells — the Cost/Tokens cells a subtask row draws, wherever a subtask row is drawn.
 *
 * Pulled out of `SubtaskTable.tsx` (the delivery detail page's own subtask grid) so `TaskTable.tsx`'s
 * inline subitem rows (the board's Table view, expanding a delivery in place) can draw the EXACT same
 * cell rather than a second formatting rule for the same figure — which is what this codebase forbids
 * (see `CLAUDE.md`'s "Calculation functions — single source of truth"). Both callers hand it a
 * `CostCell`/`TokensCell` from `subtaskRollup.ts`'s `costCellFor`/`tokensCellFor`, so the
 * empty-vs-N/A-vs-a-real-number decision is made ONCE, upstream of both.
 *
 * `r` (the raw `AttemptRollup`, only needed by the cost cell for its "N of M sessions priced"
 * tooltip) is passed alongside the already-decided `cost`/`tok` cells rather than re-derived here —
 * this component renders, it never resolves.
 */

import { fmtTokens, numeric } from './board'
import { costCaveat, type CostCell, type TokensCell } from './subtaskRollup'
import { copilotCreditsTooltip, formatTaskCost, type Money } from './money'
import type { AttemptRollup } from '../../lib/tasks'

/** One rendering for the cost cell — every subtask grid draws the EXACT same figure the exact same
 *  way, so this lives once rather than being copy-pasted per surface. */
export function CostCellView({ r, cost, money, lang }: { r: AttemptRollup | undefined; cost: CostCell; money: Money; lang: 'pt' | 'en' }) {
  if (cost.kind === 'empty') return null
  if (cost.kind === 'credits') {
    return <span style={{ ...numeric, fontSize: 12 }} title={copilotCreditsTooltip(cost.premiumRequests, lang)}>
      {formatTaskCost(money, r?.costUSD ?? null, r?.credits, r?.costByHarness)}
    </span>
  }
  return (
    <span
      style={{ ...numeric, fontSize: 12, color: cost.usd === null ? 'var(--text-tertiary)' : 'var(--anthropic-orange)' }}
      title={costCaveat(r)}
    >{money(cost.usd, r?.costByHarness)}</span>
  )
}

/** The tokens column's own version of `CostCellView`. */
export function TokensCellView({ tok }: { tok: TokensCell }) {
  if (tok.kind === 'empty') return null
  return (
    <span style={{ ...numeric, fontSize: 12, color: tok.n === null ? 'var(--text-tertiary)' : undefined }}>
      {fmtTokens(tok.n)}
    </span>
  )
}

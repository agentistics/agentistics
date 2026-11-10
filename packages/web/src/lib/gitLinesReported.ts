import type { Filters, SurfaceHarnessId } from '@agentistics/core'
import { capable } from './harness'

/**
 * Does ANY harness in the current selection report file/line edits? The home cards used to ask only
 * `filters.harness` (the legacy single-harness field, now always unset), so with the multi-select
 * `filters.harnesses = ['opencode']` the Files card printed a confident 0 for a harness that never
 * reports the figure. False means "not reported" — the card says so instead of 0. An empty selection
 * is the unfiltered view and keeps the figure.
 */
export function gitLinesReported(filters: Pick<Filters, 'harness' | 'harnesses'>): boolean {
  const chosen = [...new Set([...(filters.harnesses ?? []), ...(filters.harness ? [filters.harness] : [])])] as SurfaceHarnessId[]
  if (chosen.length === 0) return true
  return chosen.some(h => capable(h, 'gitLines'))
}

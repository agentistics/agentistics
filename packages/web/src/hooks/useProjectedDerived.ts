/**
 * useProjectedDerived: the projected overlay of the web's session, cost and tool figures (A4.7).
 *
 * The answer is `null`, which means "draw `computeDerivedStats` as it is", in these cases:
 * - the server did not say `projectionsWeb`;
 * - the filters hold a scope the API cannot express;
 * - the first answer is still pending;
 * - the route refused.
 *
 * It re-reads whenever `/api/data` was re-read (`stamp`) and whenever the filters change, so the
 * server's push moves both paths together.
 */
import { useEffect, useState } from 'react'
import { httpMetricsQuery, ProjectionUnavailable, type Filters } from '@agentistics/core'
import { blendedCostPerToken, getDateRangeFilter } from './useData'
import { projectedDerived, projectedScope, type ProjectedDerived } from '../lib/projectedDerived'

export function useProjectedDerived(opts: {
  enabled: boolean
  filters: Filters
  activeOnly: boolean
  stamp: unknown
}): ProjectedDerived | null {
  const { enabled, filters, activeOnly, stamp } = opts
  const [overlay, setOverlay] = useState<ProjectedDerived | null>(null)
  const range = getDateRangeFilter(filters.dateRange, filters.customStart, filters.customEnd)
  const scope = enabled ? projectedScope(filters, activeOnly, range) : null
  const key = scope ? JSON.stringify(scope) : null
  useEffect(() => {
    if (!scope) { setOverlay(null); return }
    let live = true
    projectedDerived(httpMetricsQuery(''), scope, blendedCostPerToken)
      .then(o => { if (live) setOverlay(o) })
      .catch(err => {
        if (!live) return
        // A refusal or an unreachable route leaves the legacy figures; anything else is a defect,
        // reported to the console rather than swallowed.
        if (!(err instanceof ProjectionUnavailable)) console.error('[projections] web overlay failed', err)
        setOverlay(null)
      })
    return () => { live = false }
    // `key` stands for `scope` (a fresh object every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stamp])
  return scope ? overlay : null
}

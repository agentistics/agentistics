/**
 * useProjectedFigures — the dashboard's figures off the projections (A4.6): the default, with
 * `AGENTISTICS_PROJECTIONS_SURFACES=legacy` as the fallback.
 *
 * `null` means "draw the selectors over `/api/data`". That is the answer when this surface did not opt
 * in, while the first answer is pending, and whenever the server refuses: 404 when its
 * `AGENTISTICS_PROJECTIONS` gate is off, 409 on a central, 503 with no reader. The server's refusal
 * decides, because the TUI process does not see the server's environment or its preference.
 *
 * It re-reads whenever `/api/data` was re-read (`stamp`, the snapshot's identity). The server's push
 * therefore moves both paths together, with no second stream.
 */

import { useEffect, useState } from 'react'
import { httpMetricsQuery, projectionSurfaceOn, ProjectionUnavailable, type HarnessId } from '@agentistics/core'
import { projectedFigures, type DashboardFigures } from '../projected-figures'

/** One read. `null` on a refusal, which sends the screens back to the legacy figures. */
export async function loadProjectedFigures(
  apiBase: string,
  harness: HarnessId | null,
  fetchFn: typeof fetch = fetch,
): Promise<DashboardFigures | null> {
  try {
    return await projectedFigures(httpMetricsQuery(apiBase, fetchFn), harness)
  } catch (err) {
    if (err instanceof ProjectionUnavailable) return null
    throw err
  }
}

export function useProjectedFigures(apiBase: string | null, opts: {
  enabled: boolean
  harness: HarnessId | null
  /** Any value that changes when `/api/data` was re-read: the snapshot object itself. */
  stamp: unknown
  nonce?: number
  env?: Record<string, string | undefined>
}): DashboardFigures | null {
  const optedIn = projectionSurfaceOn('tui', opts.env ?? process.env)
  const [figures, setFigures] = useState<DashboardFigures | null>(null)
  useEffect(() => {
    if (!optedIn || !apiBase) { setFigures(null); return }
    if (!opts.enabled) return
    let live = true
    loadProjectedFigures(apiBase, opts.harness)
      .then(f => { if (live) setFigures(f) })
      // A read that failed outright (no answer at all) also leaves the legacy path drawing.
      .catch(() => { if (live) setFigures(null) })
    return () => { live = false }
  }, [optedIn, apiBase, opts.enabled, opts.harness, opts.stamp, opts.nonce])
  return optedIn ? figures : null
}

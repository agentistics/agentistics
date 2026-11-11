import { SURFACE_HARNESS_ORDER, type SurfaceHarnessId } from './types'

/** Distinct harnesses present in a session list (missing harness = 'claude'), in the canonical
 *  `SURFACE_HARNESS_ORDER`. Pure. */
export function distinctHarnesses(sessions: { harness?: SurfaceHarnessId }[]): SurfaceHarnessId[] {
  const set = new Set<SurfaceHarnessId>()
  for (const s of sessions) set.add(s.harness ?? 'claude')
  return SURFACE_HARNESS_ORDER.filter(h => set.has(h))
}

/** Multi-select harness predicate. Empty/undefined selection = all sessions pass.
 *  Sessions with no `harness` field are treated as 'claude'. Pure. */
export function filterByHarnesses<T extends { harness?: SurfaceHarnessId }>(sessions: T[], harnesses: SurfaceHarnessId[]): T[] {
  if (!harnesses || harnesses.length === 0) return sessions
  const set = new Set(harnesses)
  return sessions.filter(s => set.has(s.harness ?? 'claude'))
}

/**
 * projections/adapter-versions.ts — the adapter versions running NOW, by `source.id` (master spec
 * §19.4, §45). A materialised projection records the set it was built under; when this set changes the
 * catch-up pass rebuilds it from the journal (`catalog.ts`, `planProjection`) — the re-projection lever,
 * with no file to touch and no cache to delete.
 *
 * Read off the ENGINE's integrations (`engine/load.ts`), each entry's own `version` — never restated
 * here. A harness's `source.id` is its `HarnessId`. A community build has no integrations and so runs
 * no adapter: the set is empty, which is the truth, and there is nothing in its journal to re-project.
 */
import { HARNESS_ORDER } from '@agentistics/core'
import { engineIntegrations, type HostIntegrations } from '../engine/load'

/** PURE over `registry`. Defaults to the loaded engine's, read per call. */
export function currentAdapterVersions(registry: HostIntegrations = engineIntegrations()): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of HARNESS_ORDER) {
    const entry = registry[h]
    if (entry) out[h] = entry.version
  }
  return out
}

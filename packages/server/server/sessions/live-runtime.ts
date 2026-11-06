/**
 * live-runtime.ts — what each harness runs with when a session was started with no flags.
 *
 * The Live card shows harness · model · effort for EVERY harness. A session started without
 * `--model`/`--effort` has neither in the registry, and the harness's own default is the real
 * answer (read the way the New-session wizard reads it), so the card falls back to it instead of
 * printing the bare harness name. `effortConcept` says whether the harness HAS an effort setting at
 * all — only then is "default effort" a sentence worth saying; for the rest the part is omitted.
 */

import { HARNESS_ORDER } from '@agentistics/core'
import { readHarnessDefaults } from './harness-defaults'
import { SPAWN_SPECS } from './spawn-spec'
import type { RuntimeFacts } from './task-live-view'

const TTL_MS = 60_000
let cache: { atMs: number; value: Record<string, RuntimeFacts> } | null = null
let inFlight: Promise<Record<string, RuntimeFacts>> | null = null

/** Does this harness take a reasoning effort? Pure over the spawn table. */
export function hasEffortConcept(harness: string): boolean {
  const spec = (SPAWN_SPECS as Record<string, { efforts?: string[]; effortFlag?: string; effortArgs?: unknown } | null | undefined>)[harness]
  return !!spec && ((spec.efforts?.length ?? 0) > 0 || !!spec.effortFlag || !!spec.effortArgs)
}

export async function liveRuntimeFacts(nowMs = Date.now()): Promise<Record<string, RuntimeFacts>> {
  if (cache && nowMs - cache.atMs < TTL_MS) return cache.value
  if (inFlight) return inFlight
  inFlight = (async () => {
    const out: Record<string, RuntimeFacts> = {}
    for (const h of HARNESS_ORDER) {
      const spec = (SPAWN_SPECS as Record<string, { defaultEffort?: string } | null | undefined>)[h]
      let d: { model?: string; effort?: string } = {}
      try { d = await readHarnessDefaults(h) } catch { /* nothing readable: nothing claimed */ }
      const effort = d.effort ?? spec?.defaultEffort
      out[h] = { ...(d.model ? { model: d.model } : {}), ...(effort ? { effort } : {}), effortConcept: hasEffortConcept(h) }
    }
    cache = { atMs: nowMs, value: out }
    return out
  })()
  try { return await inFlight } finally { inFlight = null }
}

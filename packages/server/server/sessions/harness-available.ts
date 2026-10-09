/**
 * harness-available.ts — which assistants this machine can actually START.
 *
 * `SPAWN_SPECS` answers a different question: which harnesses agentop knows how to spawn AT ALL. A
 * harness with no spec is absent from every offer, and that part is already right. What was missing
 * is the second half — a spec says how to run `codex`, not that `codex` exists here — so the session
 * wizard listed all six on a machine with one installed, and picking one of the other five started
 * a tmux session that died on `command not found` behind a screen nobody was looking at.
 *
 * The rule was already written once, in `cli-hooks.ts`, for the skill it generates: a skill that
 * offers `codex` where no codex exists teaches a command that fails. It lives here now so the two
 * cannot drift — the same reason `task-reopen.ts` exists.
 *
 * WHEN NOTHING RESOLVES the answer is a FACT, not "unknown". This used to fall back to every
 * startable harness, on the reasoning that an empty wizard is indistinguishable from a broken one.
 * But zero assistants on a PATH is the signature of a broken PATH — a service started from a unit
 * that predates `Environment=PATH` sees systemd's minimal one — and offering all six there meant
 * every pick spawned a pane that died in the same second. So `ids` keeps the old fallback for the
 * callers that only need a list to TEACH (the skill `cli-hooks.ts` writes, from an interactive
 * shell), while `blind` says it happened, and the session wizard offers NOTHING and says why
 * (`cli-i18n`'s `sessNoHarnessOnPath`, naming the PATH). An empty list with a sentence is not a
 * broken wizard; a full list whose every entry fails is.
 */

import { adoptUserBinOnPath, userSearchPath } from './user-path'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { SPAWN_SPECS } from './spawn-spec'

/** Every harness agentop knows how to spawn, spec-derived and never a second hand-written list. */
export function startableHarnessIds(): HarnessId[] {
  return HARNESS_ORDER.filter(h => SPAWN_SPECS[h] !== null)
}

/**
 * Memoized, but only for `AVAILABILITY_TTL_MS`: the wizard asks on every mount and the skill on every
 * install, and `Bun.which` is a filesystem walk per harness. The first version kept the answer for the
 * life of the process on the reasoning that a CLI does not appear on PATH mid-process — but a person
 * installs one (kimi) while the server runs, and the wizard then offered nothing for it until a
 * restart. A short TTL keeps the walk off the hot path and lets the next ask after an install see it.
 */
export const AVAILABILITY_TTL_MS = 15_000
let cached: HarnessId[] | null = null
let cachedAt = 0
/** Set with `cached`: true when not one startable CLI resolved on this process's PATH. */
let blind = false

/**
 * The startable harnesses whose CLI is on PATH — or, when none of them are, all of them.
 *
 * `narrowed` says which of the two answers this is; `blind` says NONE resolved, which a caller that
 * STARTS something must treat as "offer nothing", never as "offer everything" — see the header.
 */
export function availableHarnesses(now: number = Date.now()): { ids: HarnessId[]; narrowed: boolean; blind: boolean } {
  if (cached === null || now - cachedAt >= AVAILABILITY_TTL_MS || now < cachedAt) {
    cachedAt = now
    adoptUserBinOnPath()
    const startable = startableHarnessIds()
    const installed = startable.filter(h => !!Bun.which(SPAWN_SPECS[h]!.bin, { PATH: userSearchPath() }))
    cached = installed.length > 0 ? installed : startable
    blind = installed.length === 0
  }
  return { ids: cached, narrowed: cached.length !== startableHarnessIds().length, blind }
}

/** Test seam — the memo is per process, and a test that changes PATH must be able to clear it. */
export function resetHarnessAvailability(): void {
  cached = null
  cachedAt = 0
  blind = false
}

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

import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { SPAWN_SPECS } from './spawn-spec'

/** Every harness agentop knows how to spawn, spec-derived and never a second hand-written list. */
export function startableHarnessIds(): HarnessId[] {
  return HARNESS_ORDER.filter(h => SPAWN_SPECS[h] !== null)
}

/**
 * Memoized: the wizard asks on every mount and the skill on every install, while a CLI appearing on
 * PATH mid-process is not a thing that happens. `Bun.which` is a filesystem walk per harness.
 */
let cached: HarnessId[] | null = null
/** Set with `cached`: true when not one startable CLI resolved on this process's PATH. */
let blind = false

/**
 * The startable harnesses whose CLI is on PATH — or, when none of them are, all of them.
 *
 * `narrowed` says which of the two answers this is; `blind` says NONE resolved, which a caller that
 * STARTS something must treat as "offer nothing", never as "offer everything" — see the header.
 */
export function availableHarnesses(): { ids: HarnessId[]; narrowed: boolean; blind: boolean } {
  if (cached === null) {
    const startable = startableHarnessIds()
    const installed = startable.filter(h => !!Bun.which(SPAWN_SPECS[h]!.bin, { PATH: process.env.PATH ?? '' }))
    cached = installed.length > 0 ? installed : startable
    blind = installed.length === 0
  }
  return { ids: cached, narrowed: cached.length !== startableHarnessIds().length, blind }
}

/** Test seam — the memo is per process, and a test that changes PATH must be able to clear it. */
export function resetHarnessAvailability(): void {
  cached = null
  blind = false
}

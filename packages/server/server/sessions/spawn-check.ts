/**
 * spawn-check.ts — did the session we just started stay up? One check for EVERY spawn site.
 *
 * `spawn-outcome.ts` holds the pure reading and the measurements behind `SETTLE_MS`; this is the
 * polling around it. It lived as a private helper of `cli-session.ts`, whose own comment warned
 * that "a check in only one of them is the same bug surviving in the other two" — and the path the
 * browser, the cockpit and the VS Code extension all use (`spawnManaged`) was the one without it.
 * A service whose PATH could not reach `claude` then answered every "new session" with success and
 * a row that was already dead: `off` under Inactive, "transcript not found", no Reopen. Moving the
 * check here is what makes a fourth caller cheap to give it.
 */

import type { SessionBackend } from './types'
import type { HarnessId } from '@agentistics/core'
import { noteFreshSpawn } from './harness-spawnable'
import { POLL_MS, SETTLE_MS, spawnOutcome, type SpawnOutcome } from './spawn-outcome'

/**
 * Poll the just-spawned session until it dies or `deadlineMs` passes.
 *
 * Returns the outcome when it DIED, `undefined` when it is still running at the deadline. Polled
 * rather than slept, so a death costs what it costs and only a healthy session waits out the whole
 * deadline — see `SETTLE_MS` for why that deadline is five seconds and not a guess.
 */
export async function spawnDeath(
  backend: Pick<SessionBackend, 'capture'>,
  id: string,
  deadlineMs: number = SETTLE_MS,
  freshHarness?: HarnessId,
  record: typeof noteFreshSpawn | ((harness: HarnessId, outcome: SpawnOutcome | undefined, startedAt: number) => Promise<void>) = noteFreshSpawn,
): Promise<SpawnOutcome | undefined> {
  const startedAt = Date.now()
  const deadline = startedAt + deadlineMs
  let observed = false
  // At least ONE look, however short the deadline: on a loaded machine the clock can already be
  // past a tiny deadline at the first check, and a session nobody looked at was never observed —
  // neither its death nor its staying up would be recorded.
  for (let first = true; first || Date.now() < deadline; first = false) {
    await new Promise(r => setTimeout(r, POLL_MS))
    let frame: string[]
    try { frame = await backend.capture(id, 40) } catch { continue }
    observed = true
    const outcome = spawnOutcome(frame)
    if (outcome.died) {
      if (freshHarness) await record(freshHarness, outcome, startedAt)
      return outcome
    }
  }
  if (freshHarness && observed) await record(freshHarness, undefined, startedAt)
  return undefined
}

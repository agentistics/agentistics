/**
 * `agentop session kill` on a session something live is using.
 *
 * A session being used is idle between turns, so nothing on its row says a person is on the other side; killing
 * it cuts them off mid-sentence. The verb refuses unless `--force`, and says WHAT holds it, in the engine's own
 * words. The hold lives in the server process (the engine), so this one-shot CLI asks the running server;
 * no server means nothing holds it. A server that cannot answer is UNKNOWN, which is not "free to kill": it is
 * refused too, with the way out (`--force`) named.
 */
import { PORT } from '../config'
import { holdLine, holdsFromServer, observeFromAnswer, type HoldAnswer, type HoldKeyed } from './hold-state'
import type { HoldObservation } from './retire-plan'

export type KillGuard =
  | { allow: true; warn?: string }
  | { allow: false; message: string }

/** PURE. What `kill` does given what is known about the hold. */
export function decideKillAgainstHold(
  id: string,
  hold: HoldObservation,
  force: boolean,
  now: number,
  why?: string,
): KillGuard {
  if (hold.state === 'none') return { allow: true }
  if (hold.state === 'held') {
    const who = holdLine(hold, now)
    return force
      ? { allow: true, warn: `Killing ${id} anyway (--force): ${who}. Whoever is using it is cut off.` }
      : { allow: false, message: `Not killing ${id}: ${who}. Wait for it to end, retire it instead (\`agentop session retire ${id}\` waits for it to end), or pass --force to cut it off.` }
  }
  const reason = why ? ` (${why})` : ''
  return force
    ? { allow: true, warn: `Could not tell whether ${id} is in use right now${reason}; killing it anyway (--force).` }
    : { allow: false, message: `Not killing ${id}: could not tell whether something live is using it${reason}. Pass --force to kill it regardless.` }
}

export async function guardKillAgainstHold(
  row: HoldKeyed,
  force: boolean,
  ask: () => Promise<HoldAnswer> = () => holdsFromServer(PORT, row),
  now: () => number = Date.now,
): Promise<KillGuard> {
  const answer = await ask()
  return decideKillAgainstHold(row.id, observeFromAnswer(answer), force, now(), answer.state === 'unknown' ? answer.why : undefined)
}

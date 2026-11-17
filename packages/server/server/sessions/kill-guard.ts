/**
 * `agentop session kill` on a session the owner is in a voice call with (LIGACAO-SUCESSOR).
 *
 * A session in a call is idle between turns, so nothing on its row says a person is on the line; killing
 * it hangs up on them mid-sentence. The verb refuses unless `--force`, and says WHO is in the call. The
 * call lives in the server process (the engine's voice), so this one-shot CLI asks the running server;
 * no server means no call. A server that cannot answer is UNKNOWN, which is not "free to kill": it is
 * refused too, with the way out (`--force`) named.
 */
import { PORT } from '../config'
import { callSentence, callsFromServer, observeFromCalls, type CallKeyed, type CallsAnswer } from './call-state'

export type KillGuard =
  | { allow: true; warn?: string }
  | { allow: false; message: string }

/** PURE. What `kill` does given what is known about the call. */
export function decideKillAgainstCall(
  id: string,
  call: ReturnType<typeof observeFromCalls>,
  force: boolean,
  now: number,
  why?: string,
): KillGuard {
  if (call.state === 'none') return { allow: true }
  if (call.state === 'active') {
    const who = callSentence(call, now)
    return force
      ? { allow: true, warn: `Killing ${id} anyway (--force): ${who}. The call is hung up.` }
      : { allow: false, message: `Not killing ${id}: ${who}. End the call first, retire it instead (\`agentop session retire ${id}\` waits for the call to end), or pass --force to hang up on them.` }
  }
  const reason = why ? ` (${why})` : ''
  return force
    ? { allow: true, warn: `Could not tell whether ${id} is in a voice call${reason}; killing it anyway (--force).` }
    : { allow: false, message: `Not killing ${id}: could not tell whether the owner is in a voice call with it${reason}. Pass --force to kill it regardless.` }
}

export async function guardKillAgainstCall(
  row: CallKeyed,
  force: boolean,
  ask: () => Promise<CallsAnswer> = () => callsFromServer(PORT),
  now: () => number = Date.now,
): Promise<KillGuard> {
  const answer = await ask()
  return decideKillAgainstCall(row.id, observeFromCalls(row, answer), force, now(), answer.state === 'unknown' ? answer.why : undefined)
}

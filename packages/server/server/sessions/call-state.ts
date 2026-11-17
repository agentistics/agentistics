/**
 * WHO IS ON THE LINE — what the host knows about a voice call aimed at a session (LIGACAO-SUCESSOR).
 *
 * The call lives in the ENGINE (voice is private); the host reads it through `Engine.voice`
 * (`@agentistics/engine-api` 1.29). A session in a call is idle between turns, so activity can never tell:
 * `retire-plan.ts` holds a retire while a call is open and `agentop session kill` refuses without `--force`.
 *
 * Two readers, one rule. `probeCall` runs in the SERVER process (it holds the engine and the live calls);
 * `callsFromServer` is what a one-shot CLI process uses, because its own engine copy would know no call.
 * Both answer `unknown` rather than `none` when they cannot read: unknown is never quiet.
 */
import type { EngineVoice } from '@agentistics/engine-api'
import type { CallObservation } from './retire-plan'

/** A row is called by its managed id; the voice page may have been opened with the conversation id. */
export interface CallKeyed { id: string; conversationId?: string }

/** The call aimed at `row`, read from the engine's voice. `null`/absent voice = no call can exist = `none`. */
export function probeCall(row: CallKeyed, voice: Pick<EngineVoice, 'activeCall'> | null | undefined): CallObservation {
  if (!voice) return { state: 'none' }
  try {
    for (const key of [row.id, row.conversationId]) {
      if (!key) continue
      const c = voice.activeCall(key)
      if (c) return { state: 'active', since: c.startedAt, callId: c.callId }
    }
    return { state: 'none' }
  } catch {
    return { state: 'unknown' }
  }
}

/** One call on the wire (`GET /api/fleet/calls`). */
export interface WireCall { callId: string; sessionId: string; startedAt: number }

export type CallsAnswer =
  /** The server answered; `calls` is every live call (empty = nobody is on a line). */
  | { state: 'ok'; calls: readonly WireCall[] }
  /** Nothing is listening on the port: no server, so no call (a call lives in the server process). */
  | { state: 'no-server' }
  /** A server answered and said no, or something odd came back: the call state is UNKNOWN. */
  | { state: 'unknown'; why: string }

/** PURE. The call among `answer` aimed at `row`, as an observation. */
export function observeFromCalls(row: CallKeyed, answer: CallsAnswer): CallObservation {
  if (answer.state === 'no-server') return { state: 'none' }
  if (answer.state === 'unknown') return { state: 'unknown' }
  const c = answer.calls.find(x => x.sessionId === row.id || (row.conversationId !== undefined && x.sessionId === row.conversationId))
  return c ? { state: 'active', since: c.startedAt, callId: c.callId } : { state: 'none' }
}

/** IO. Ask the running server for its live calls. `fetchFn` is injectable for the tests. */
export async function callsFromServer(port: number, fetchFn: typeof fetch = fetch): Promise<CallsAnswer> {
  let res: Response
  try {
    res = await fetchFn(`http://localhost:${port}/api/fleet/calls`, { signal: AbortSignal.timeout(1500) })
  } catch (e) {
    // Connection refused is "no server"; a timeout means something is there and did not answer.
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return timedOut ? { state: 'unknown', why: 'the server did not answer in time' } : { state: 'no-server' }
  }
  if (!res.ok) return { state: 'unknown', why: `the server answered HTTP ${res.status}` }
  try {
    const body = await res.json() as { calls?: unknown }
    if (!Array.isArray(body.calls)) return { state: 'unknown', why: 'the server answered something that is not a call list' }
    const calls = body.calls.filter((c): c is WireCall =>
      !!c && typeof c === 'object' && typeof (c as WireCall).callId === 'string' && typeof (c as WireCall).sessionId === 'string' && typeof (c as WireCall).startedAt === 'number')
    return { state: 'ok', calls }
  } catch {
    return { state: 'unknown', why: 'the server answered something that is not JSON' }
  }
}

/** One sentence naming who is on the call (for `kill`'s refusal and the retire reply). */
export function callSentence(call: Extract<CallObservation, { state: 'active' }>, now: number): string {
  const mins = Math.max(0, Math.round((now - call.since) / 60_000))
  return `the owner is in a voice call with it (${call.callId ? `call ${call.callId}, ` : ''}since ${new Date(call.since).toISOString()}, ${mins} min ago)`
}

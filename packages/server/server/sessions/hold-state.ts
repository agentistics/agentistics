/**
 * WHAT HOLDS A SESSION — what the host knows about something live using a session it is about to stop.
 *
 * What holds it lives in the ENGINE; the host reads it through `Engine.holds` (`@agentistics/engine-api` 1.29)
 * and never names it: the human sentence arrives from the engine (`sentence`, per language). A held session can be
 * idle between turns, so activity can never tell: `retire-plan.ts` holds a retire while something uses the session
 * and `agentop session kill` refuses without `--force`.
 *
 * Two readers, one rule. `probeHold` runs in the SERVER process (it holds the engine); `holdsFromServer` is what a
 * one-shot CLI process uses, because its own engine copy would know nothing live.
 * Both answer `unknown` rather than `none` when they cannot read: unknown is never quiet.
 */
import type { EngineHolds } from '@agentistics/engine-api'
import type { HoldObservation } from './retire-plan'

/** A row is called by its managed id, or by the conversation id the engine may know it under. */
export interface HoldKeyed { id: string; conversationId?: string }

/** What the engine says about `row`. No `holds` = nothing can hold it = `none`; a throwing engine = `unknown`. */
export async function probeHold(row: HoldKeyed, holds: Pick<EngineHolds, 'observe'> | null | undefined): Promise<HoldObservation> {
  if (!holds) return { state: 'none' }
  try {
    return normalizeHold(await holds.observe({ id: row.id, ...(row.conversationId ? { conversationId: row.conversationId } : {}) }))
  } catch {
    return { state: 'unknown' }
  }
}

/** An engine answer is untrusted input: anything that is not one of the three shapes is `unknown`, never `none`. */
export function normalizeHold(x: unknown): HoldObservation {
  const o = x as { state?: unknown; since?: unknown; sentence?: { en?: unknown; pt?: unknown } } | null
  if (o && o.state === 'none') return { state: 'none' }
  if (o && o.state === 'held' && typeof o.since === 'number' && typeof o.sentence?.en === 'string' && typeof o.sentence?.pt === 'string') {
    return { state: 'held', since: o.since, sentence: { en: o.sentence.en, pt: o.sentence.pt } }
  }
  return { state: 'unknown' }
}

export type HoldAnswer =
  /** The server answered with its reading of the row. */
  | { state: 'ok'; hold: HoldObservation }
  /** Nothing is listening on the port: no server, so nothing live holds anything (it lives in the server process). */
  | { state: 'no-server' }
  /** A server answered and said no, or something odd came back: the state is UNKNOWN. */
  | { state: 'unknown'; why: string }

/** PURE. The observation a server answer stands for. */
export function observeFromAnswer(answer: HoldAnswer): HoldObservation {
  if (answer.state === 'no-server') return { state: 'none' }
  if (answer.state === 'unknown') return { state: 'unknown' }
  return answer.hold
}

/** IO. Ask the running server about one row. `fetchFn` is injectable for the tests. */
export async function holdsFromServer(port: number, row: HoldKeyed, fetchFn: typeof fetch = fetch): Promise<HoldAnswer> {
  let res: Response
  try {
    res = await fetchFn(`http://localhost:${port}/api/fleet/holds?session=${encodeURIComponent(row.id)}`, { signal: AbortSignal.timeout(1500) })
  } catch (e) {
    // Connection refused is "no server"; a timeout means something is there and did not answer.
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return timedOut ? { state: 'unknown', why: 'the server did not answer in time' } : { state: 'no-server' }
  }
  if (!res.ok) return { state: 'unknown', why: `the server answered HTTP ${res.status}` }
  try {
    const body = await res.json() as { available?: unknown; session?: { hold?: unknown } }
    if (body.available === false) return { state: 'ok', hold: { state: 'none' } }
    if (!body.session || !('hold' in body.session)) return { state: 'unknown', why: 'the server did not resolve the session' }
    const hold = normalizeHold(body.session.hold)
    return hold.state === 'unknown' ? { state: 'unknown', why: 'the server answered something that is not a hold reading' } : { state: 'ok', hold }
  } catch {
    return { state: 'unknown', why: 'the server answered something that is not JSON' }
  }
}

/** One sentence naming what holds the session, in the engine's own words (for `kill`'s refusal and the retire reply). */
export function holdLine(hold: Extract<HoldObservation, { state: 'held' }>, now: number, lang: 'en' | 'pt' = 'en'): string {
  const mins = Math.max(0, Math.round((now - hold.since) / 60_000))
  return lang === 'pt' ? `${hold.sentence.pt} (há ${mins} min)` : `${hold.sentence.en} (since ${new Date(hold.since).toISOString()}, ${mins} min ago)`
}

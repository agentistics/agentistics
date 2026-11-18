/**
 * THE ONE GUARD BEHIND EVERY KILL.
 *
 * A session something live is using is idle between turns, so nothing on its row says a person is on the other
 * side, and killing it cuts them off mid-sentence. `killAndRetireSession` is the door every kill goes through
 * (the CLI verb, the web/cockpit button, an account switch, a mode migration, the retire runner): it asks
 * `observeHoldNow` right before the kill and throws `HoldError` unless the caller passed `force`. Callers
 * that can wait (the account switch) defer; callers that can ask (the web/cockpit) confirm and pass `force`.
 *
 * Where the answer comes from: the hold lives in the SERVER process (the engine), so the server reads
 * it directly; any other process (the one-shot CLI, the cockpit's own host) asks the running server.
 * Unknown is never free to kill.
 */
import { PORT } from '../config'
import { holdLine, holdsFromServer, observeFromAnswer, probeHold, type HoldKeyed } from './hold-state'
import { decideKillAgainstHold } from './kill-guard'
import type { HoldObservation } from './retire-plan'
import { isServerProcess } from './shared-snapshot'

/** Thrown by `killAndRetireSession` when something live holds the session (or cannot be ruled out). Nothing was killed. */
export class HoldError extends Error {
  constructor(readonly id: string, readonly hold: Exclude<HoldObservation, { state: 'none' }>, now: number = Date.now()) {
    super(holdSentence(id, hold, now))
    this.name = 'HoldError'
  }
}

/** The English sentence (CLI and logs); surfaces with a language of their own word it themselves from `hold`. */
export function holdSentence(id: string, hold: Exclude<HoldObservation, { state: 'none' }>, now: number): string {
  const g = decideKillAgainstHold(id, hold, false, now)
  return g.allow ? '' : g.message
}

let testObserver: ((row: HoldKeyed) => Promise<HoldObservation>) | null = null
/** TEST SEAM (scripts/test-preload.ts): a test run never asks the developer's real server port whether anything holds a session. */
export function __setHoldObserverForTest(fn: ((row: HoldKeyed) => Promise<HoldObservation>) | null): void { testObserver = fn }

/** What holds `row`, right now, from wherever this process can know it. Never throws; unreadable = `unknown`. */
export async function observeHoldNow(row: HoldKeyed): Promise<HoldObservation> {
  if (testObserver) return testObserver(row)
  if (isServerProcess()) {
    try {
      const { engine, loadEngine } = await import('../engine/load')
      await loadEngine() // never throws by contract; a rejection here is an unreadable engine, not an absent one
      return probeHold(row, engine()?.holds ?? null)
    } catch {
      return { state: 'unknown' }
    }
  }
  return observeFromAnswer(await holdsFromServer(PORT, row))
}

export { holdLine }

/**
 * endingSessions.ts — which sessions are being ENDED right now.
 *
 * Opening a session has a state of its own (`SessionCreating`); ending one had none, so pressing
 * "End session" left the conversation and its composer looking alive for the seconds the kill takes
 * — indistinguishable from a click that did nothing. The mark is set the instant a `kill` is sent
 * (`useFleet`'s `act`, the ONE door every surface ends a session through, the header menu and the
 * aside row menu alike). A successful kill stays marked for at least 800 ms AND until the fleet
 * confirms it has left Active. The caller only navigates after both conditions hold. A refusal
 * clears the mark immediately so the mounted conversation and draft return. This is transient
 * request state, held in memory and never persisted.
 */
import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react'

// A selection can keep this attempt after it leaves the map. That lets a successful loader
// survive the router's deferred navigation without retaining completed sessions globally.
interface EndingAttempt { succeeded: boolean; doneAt?: number }
const ending = new Map<string, EndingAttempt>()
/** Ids whose kill was acknowledged but whose row never left Active within ENDING_TIMEOUT_MS. */
const timedOut = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void { version++; for (const l of listeners) l() }

export function markEnding(id: string): void {
  if (ending.has(id)) return
  ending.set(id, { succeeded: false })
  emit()
}

export function unmarkEnding(id: string): void {
  const had = ending.delete(id)
  const out = timedOut.delete(id)
  if (had || out) emit()
}

export function isEnding(id: string | undefined): boolean {
  return id !== undefined && ending.has(id)
}

/** True when the kill was acknowledged but the session still shows as running after the timeout. */
export function isEndingTimedOut(id: string | undefined): boolean {
  return id !== undefined && timedOut.has(id)
}

/** Test seam: forget everything. */
export function resetEnding(): void {
  ending.clear()
  timedOut.clear()
  emit()
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** True while `id` is ending, including its minimum visible interval. */
export function useEnding(id: string | undefined): boolean {
  useSyncExternalStore(subscribe, () => version, () => 0)
  return isEnding(id)
}

/** The in-progress label — one wording for the session view and the aside row. */
export const endingLabel = (pt: boolean): string => (pt ? 'Encerrando…' : 'Ending…')

export const ENDING_MIN_MS = 800
/** After this long without the fleet confirming, the overlay stops spinning and states the outcome. */
export const ENDING_TIMEOUT_MS = 15_000
/** How long a successful ending keeps the overlay across the router's deferred navigation. */
export const ENDING_HOLD_MS = 2_000

/** The outcome sentence once the timeout has passed. */
export const endingTimeoutText = (pt: boolean): { title: string; body: string; retry: string; dismiss: string } => pt
  ? { title: 'Ainda aparece em execução', body: 'O pedido foi aceito, mas a sessão não saiu da lista de ativas.', retry: 'Tentar de novo', dismiss: 'Fechar aviso' }
  : { title: 'Still shown as running', body: 'The request was accepted, but the session has not left the active list.', retry: 'Try again', dismiss: 'Dismiss' }

export function useEndingTimedOut(id: string | undefined): boolean {
  useSyncExternalStore(subscribe, () => version, () => 0)
  return isEndingTimedOut(id)
}

/** Keep success visible until both the reading interval and the fleet transition have finished. */
export async function withEnding<T extends { ok: boolean }>(
  id: string,
  action: () => Promise<T>,
  waitUntilInactive: () => Promise<void>,
  isActive: () => boolean = () => true,
  timeoutMs: number = ENDING_TIMEOUT_MS,
): Promise<T> {
  const started = Date.now()
  markEnding(id)
  let keep = false
  try {
    const result = await action()
    if (result.ok) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
      const outcome = await Promise.race([
        Promise.all([
          waitUntilInactive(),
          new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ENDING_MIN_MS - (Date.now() - started)))),
        ]).then(() => 'done' as const),
        expired,
      ])
      clearTimeout(timer)
      if (outcome === 'timeout' && isActive()) {
        // Do not spin forever: leave the mark, flag the outcome and let the overlay offer a retry.
        timedOut.add(id)
        keep = true
        emit()
      } else {
        const attempt = ending.get(id)
        if (attempt) { attempt.succeeded = true; attempt.doneAt = Date.now() }
      }
    }
    return result
  } finally { if (!keep) unmarkEnding(id) }
}

/** Retain the selected view when a fast fleet update removes its row during the reading interval. */
export function useEndingSelection<T extends { id: string }>(route: string | undefined, row: T | undefined) {
  const held = useRef<{ route: string | undefined; row: T | undefined; attempt?: EndingAttempt }>({ route, row })
  const rowEnding = useEnding(row?.id)
  const heldEnding = useEnding(held.current.route === route ? held.current.row?.id : undefined)
  if (held.current.route !== route) held.current = { route, row }
  // Clearing request state is synchronous; navigation commits in a React transition. Keep the
  // successful attempt on THIS selection until that commit, so the chat never flashes between.
  const attempt = held.current.attempt
  const graceLeft = attempt?.succeeded === true && attempt.doneAt !== undefined ? ENDING_HOLD_MS - (Date.now() - attempt.doneAt) : 0
  const [, release] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (graceLeft <= 0) return
    const t = setTimeout(release, graceLeft + 20)
    return () => clearTimeout(t)
  }, [graceLeft])
  const holding = rowEnding || heldEnding || graceLeft > 0
  if (!holding) held.current = { route, row }
  else if (!held.current.attempt) {
    const id = rowEnding ? row?.id : held.current.row?.id
    if (id) held.current.attempt = ending.get(id)
  }
  return { row: holding ? held.current.row : row, ending: holding }
}

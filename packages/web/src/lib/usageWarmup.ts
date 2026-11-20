/**
 * USO.LENTO r3b — the account list the rings wait for starts when the person's INTENT to open Usage shows
 * (pointer over / focus / press on its entry) and when the page begins to render, not after the charts commit.
 *
 * ONE slot, no second fetch: the Usage accounts panel TAKES the warmed answer instead of asking again, and
 * asks itself exactly as before when there is none (or it is stale, or it is a reload after an edit).
 * Bounded: hovering never fetches again within `HOVER_DEDUPE_MS`; an answer older than `TAKE_MAX_AGE_MS` is
 * never handed over (the list must not show a sign-in state from a minute ago). No timer, no poll, and
 * nothing is requested while the tab is hidden.
 */
export const HOVER_DEDUPE_MS = 30_000
export const TAKE_MAX_AGE_MS = 10_000

type Slot = { at: number; promise: Promise<Response>; /** The parsed answer once it has arrived (null: it was not ok). */ body?: { accounts?: unknown[] } | null }
let slot: Slot | null = null

const hidden = (): boolean => typeof document !== 'undefined' && document.hidden

/** `hover`: the person may only be passing by. `open`: the page is rendering, so a takeable answer is needed. */
export function warmUsageAccounts(why: 'hover' | 'open', now: number = Date.now()): void {
  if (hidden() || typeof fetch !== 'function') return
  const age = slot ? now - slot.at : Infinity
  if (slot && age < (why === 'hover' ? HOVER_DEDUPE_MS : TAKE_MAX_AGE_MS)) return
  const promise = fetch('/api/accounts', { signal: AbortSignal.timeout(15_000) })
  promise.catch(() => { if (slot?.promise === promise) slot = null })
  const mine: Slot = { at: now, promise }
  slot = mine
  // Keep the parsed answer too, so a page that opens AFTER it arrived can draw the rows in its FIRST commit.
  promise.then(r => (r.ok ? r.clone().json() : null)).then(b => { mine.body = b }).catch(() => { /* the page asks itself */ })
}

/** The warmed answer if it is fresh (it is SHARED, not spent: a remount of the same open reuses it), else null: the caller fetches as it always did. */
export function takeWarmAccounts(now: number = Date.now()): Promise<Response> | null {
  if (!slot || now - slot.at >= TAKE_MAX_AGE_MS) return null
  // NOT spent: every consumer of the same open (the panel, a remount) shares this one answer while it is fresh.
  return slot.promise.then(r => r.clone()) // a body reads once: each consumer gets its own clone
}

/** The answer itself when it already arrived and is fresh (shared, not spent), else undefined. */
export function takeWarmAccountsBody(now: number = Date.now()): { accounts?: unknown[] } | null | undefined {
  if (!slot || slot.body === undefined || now - slot.at >= TAKE_MAX_AGE_MS) return undefined
  return slot.body
}

export function resetUsageWarmup(): void { slot = null }

/** Handlers for the entry of the Usage area/page: any of the three intents warms the list. Empty for every other entry. */
export function usageIntentProps(isUsage: boolean): { onPointerEnter?: () => void; onFocus?: () => void; onPointerDown?: () => void } {
  if (!isUsage) return {}
  const warm = () => warmUsageAccounts('hover')
  return { onPointerEnter: warm, onFocus: warm, onPointerDown: warm }
}

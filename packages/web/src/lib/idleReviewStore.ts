/**
 * idleReviewStore.ts — the ONE small external store the idle-review card reads, wherever it mounts.
 *
 * `SessionsAside.tsx` renders the card in TWO places that are really the SAME component mounted
 * twice: the desktop sidebar (from `App.tsx`) and the mobile "Sessions" tab (from `SessionsPage.tsx`
 * itself) — each backed by its OWN `useFleet()` poll. `useIdleSessions` must still run exactly ONCE
 * (in `SessionsPage`, which already owns the fleet the feature judges), so the two mounts of the
 * card cannot each compute their own candidates — they read what that one call PUBLISHES here,
 * the same `useSyncExternalStore` pattern `lib/notifications.ts` uses for the bell.
 *
 * Snooze and dismiss live HERE rather than as React state on `SessionsPage`, because the card's own
 * buttons are what trigger them, and the card is not always inside a component that holds that
 * state — the desktop aside is a sibling of `SessionsPage` in `App.tsx`'s tree, not a descendant.
 *
 * `dismissedKeys` persists in `sessionStorage` exactly like `snoozedUntil` (try/catch on every read
 * and write; a corrupt or missing value reads as empty) — a page reload used to bring the card back
 * for the very batch the user had just dismissed, because the Set lived only in this module's
 * memory. It is pruned on every `publishIdleReview`: a dismissed key that has dropped out of the
 * CURRENT candidate set is removed from storage, so the set does not grow forever — this never
 * changes `bannerVisible`'s answer (it only ever tests membership of the CURRENT candidateKeys), it
 * only keeps what is stored bounded. The "a new candidate outside the dismissed set makes the card
 * reappear" rule is untouched.
 */
import { useSyncExternalStore } from 'react'
import { bannerVisible } from './idleExecution'

const SNOOZE_KEY = 'agentistics-idle-snooze'
const SNOOZE_MS = 3_600_000
const DISMISSED_KEY = 'agentistics-idle-dismissed'

export interface IdleReviewSummary {
  count: number
  freedBytes: number | null
  /** Every current candidate's identity key — never rendered, only compared against dismissals. */
  candidateKeys: readonly string[]
}

export interface IdleReviewSnapshot {
  count: number
  freedBytes: number | null
  visible: boolean
}

interface IdleReviewState extends IdleReviewSummary {
  modalOpen: boolean
  snoozedUntil: number | null
  dismissedKeys: ReadonlySet<string>
}

function readSnooze(): number | null {
  try {
    const v = Number(sessionStorage.getItem(SNOOZE_KEY))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

/** A corrupt, missing, or non-array-of-strings value reads as empty — never throws, never wedges. */
function readDismissed(): ReadonlySet<string> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((k): k is string => typeof k === 'string'))
  } catch {
    return new Set()
  }
}

function writeDismissed(keys: ReadonlySet<string>): void {
  try { sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...keys])) } catch { /* private tab, quota, disabled */ }
}

/**
 * Drops any dismissed key that is no longer among the CURRENT candidates, so the stored set never
 * grows unbounded with sessions that have long since stopped being idle candidates. Returns the same
 * reference when nothing changes, which is what lets the caller skip a pointless storage write.
 */
function pruneDismissed(dismissedKeys: ReadonlySet<string>, candidateKeys: readonly string[]): ReadonlySet<string> {
  if (dismissedKeys.size === 0) return dismissedKeys
  const kept = new Set(candidateKeys.filter(k => dismissedKeys.has(k)))
  return kept.size === dismissedKeys.size ? dismissedKeys : kept
}

let state: IdleReviewState = {
  count: 0, freedBytes: null, candidateKeys: [],
  modalOpen: false,
  snoozedUntil: readSnooze(),
  dismissedKeys: readDismissed(),
}

function computeSnapshot(s: IdleReviewState, now: number): IdleReviewSnapshot {
  return {
    count: s.count,
    freedBytes: s.freedBytes,
    visible: bannerVisible({
      candidates: s.count, modalOpen: s.modalOpen, snoozedUntil: s.snoozedUntil, now,
      candidateKeys: s.candidateKeys, dismissedKeys: s.dismissedKeys,
    }),
  }
}

// `useSyncExternalStore` requires `getSnapshot` to return the SAME reference until the store
// actually changes, or React re-invokes the component forever trying to "settle" on a value that a
// fresh object literal can never equal twice — so the snapshot is computed once per mutation, here,
// and cached; never inside the getter every render calls.
let cached: IdleReviewSnapshot = computeSnapshot(state, Date.now())

const listeners = new Set<() => void>()
function emit(): void {
  for (const l of listeners) l()
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function commit(next: IdleReviewState): void {
  state = next
  cached = computeSnapshot(state, Date.now())
  emit()
}

/** `SessionsPage`'s own call, on every candidates/modal change — the only writer of the summary. */
export function publishIdleReview(summary: IdleReviewSummary, modalOpen: boolean): void {
  const dismissedKeys = pruneDismissed(state.dismissedKeys, summary.candidateKeys)
  if (dismissedKeys !== state.dismissedKeys) writeDismissed(dismissedKeys)
  commit({ ...state, ...summary, modalOpen, dismissedKeys })
}

/** The card's "Snooze 1h" button. */
export function snoozeIdleReview(): void {
  const until = Date.now() + SNOOZE_MS
  try { sessionStorage.setItem(SNOOZE_KEY, String(until)) } catch { /* private tab, quota, disabled */ }
  commit({ ...state, snoozedUntil: until })
}

/** The card's `×` — dismisses the CURRENT batch only; see `bannerVisible`'s own header. */
export function dismissIdleReview(): void {
  const dismissedKeys = new Set(state.candidateKeys)
  writeDismissed(dismissedKeys)
  commit({ ...state, dismissedKeys })
}

/** Non-reactive read, for a caller outside React and for tests. Components use `useIdleReviewCard`. */
export function getIdleReviewSnapshot(): IdleReviewSnapshot {
  return cached
}

/**
 * Test-only: recomputes visibility at an arbitrary instant without touching the cached snapshot —
 * `snoozeIdleReview` reads the real clock, so this is how a snooze's expiry is tested without a
 * fake timer.
 */
export function previewIdleReviewVisible(now: number): boolean {
  return computeSnapshot(state, now).visible
}

export function useIdleReviewCard(): IdleReviewSnapshot {
  return useSyncExternalStore(subscribe, getIdleReviewSnapshot, getIdleReviewSnapshot)
}

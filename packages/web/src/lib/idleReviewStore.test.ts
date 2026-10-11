import { beforeEach, describe, expect, it } from 'bun:test'
import {
  dismissIdleReview, getIdleReviewSnapshot, previewIdleReviewVisible, publishIdleReview, resetIdleReviewForTests, snoozeIdleReview,
} from './idleReviewStore'

/**
 * Bun's test runner has no DOM, so `sessionStorage` is not a global here — a bare reference throws
 * `ReferenceError`, which the store's own try/catch already swallows exactly like a real private tab
 * would. The persistence tests below need a WORKING store to prove a value actually survives a
 * simulated reload, so they install a minimal in-memory stub for the module's lifetime — and restore
 * whatever was there before (nothing, on Bun) so it cannot leak into any other test file.
 */
function stubSessionStorage(): { restore: () => void } {
  const original = (globalThis as { sessionStorage?: Storage }).sessionStorage
  let backing = new Map<string, string>()
  const stub: Storage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => { backing.set(k, v) },
    removeItem: (k: string) => { backing.delete(k) },
    clear: () => { backing = new Map() },
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    get length() { return backing.size },
  }
  Object.defineProperty(globalThis, 'sessionStorage', { value: stub, configurable: true, writable: true })
  return {
    restore: () => {
      if (original === undefined) delete (globalThis as { sessionStorage?: Storage }).sessionStorage
      else Object.defineProperty(globalThis, 'sessionStorage', { value: original, configurable: true, writable: true })
    },
  }
}

// Module-level state, exercised in order — the same style `idleReviewRequest.test.ts` already uses
// for its own module-level flag. The snooze test is last on purpose: it is the one test that leaves
// state a later test could not un-do without a fake timer.
describe('idleReviewStore', () => {
  beforeEach(() => resetIdleReviewForTests())
  it('starts invisible with nothing published', () => {
    expect(getIdleReviewSnapshot()).toEqual({ count: 0, freedBytes: null, visible: false })
  })

  it('becomes visible once candidates are published, and reports the count and freed memory', () => {
    publishIdleReview({ count: 2, freedBytes: 1_000_000_000, candidateKeys: ['a', 'b'] }, false)
    expect(getIdleReviewSnapshot()).toEqual({ count: 2, freedBytes: 1_000_000_000, visible: true })
  })

  it('hides while the review modal is open, without losing the count', () => {
    publishIdleReview({ count: 2, freedBytes: null, candidateKeys: ['a', 'b'] }, true)
    expect(getIdleReviewSnapshot()).toEqual({ count: 2, freedBytes: null, visible: false })
    publishIdleReview({ count: 2, freedBytes: null, candidateKeys: ['a', 'b'] }, false)
    expect(getIdleReviewSnapshot().visible).toBe(true)
  })

  it('dismissing hides the current batch until a session outside it becomes a candidate', () => {
    publishIdleReview({ count: 2, freedBytes: null, candidateKeys: ['a', 'b'] }, false)
    dismissIdleReview()
    expect(getIdleReviewSnapshot().visible).toBe(false)
    // Same two sessions republished (a poll tick with nothing new) — stays dismissed.
    publishIdleReview({ count: 2, freedBytes: null, candidateKeys: ['a', 'b'] }, false)
    expect(getIdleReviewSnapshot().visible).toBe(false)
    // A third, never-dismissed session joins the batch.
    publishIdleReview({ count: 3, freedBytes: null, candidateKeys: ['a', 'b', 'c'] }, false)
    expect(getIdleReviewSnapshot().visible).toBe(true)
  })

  it('snoozing hides it until the snooze elapses (last — leaves snoozedUntil set)', () => {
    publishIdleReview({ count: 1, freedBytes: null, candidateKeys: ['solo'] }, false)
    expect(getIdleReviewSnapshot().visible).toBe(true)
    snoozeIdleReview()
    expect(getIdleReviewSnapshot().visible).toBe(false)
    expect(previewIdleReviewVisible(Date.now() + 1_000)).toBe(false)
    expect(previewIdleReviewVisible(Date.now() + 3_600_001)).toBe(true)
  })
})

// `dismissedKeys`'s own module-level state is read from `sessionStorage` ONCE, at import time — so
// "a simulated reload" here means a genuinely fresh module instance, not a fresh call. Bun treats a
// query-suffixed specifier as a distinct module, which is what lets each test below get its own
// `state` while still sharing the (stubbed) `sessionStorage` a real reload would also share.
const DISMISSED_KEY = 'agentistics-idle-dismissed'
type StoreModule = typeof import('./idleReviewStore')
let reloadCounter = 0
function freshStore(): Promise<StoreModule> {
  reloadCounter += 1
  return import(`./idleReviewStore?reload=${reloadCounter}`) as Promise<StoreModule>
}

describe('idleReviewStore dismissal persistence', () => {
  it('the dismissed set survives a simulated reload', async () => {
    const { restore } = stubSessionStorage()
    try {
      const before = await freshStore()
      before.publishIdleReview({ count: 2, freedBytes: null, candidateKeys: ['x', 'y'] }, false)
      before.dismissIdleReview()
      expect(before.getIdleReviewSnapshot().visible).toBe(false)

      // A fresh module instance, standing in for the page reloading — it reads `dismissedKeys` off
      // the SAME `sessionStorage` at its own import time, before anything is published to it.
      const after = await freshStore()
      after.publishIdleReview({ count: 2, freedBytes: null, candidateKeys: ['x', 'y'] }, false)
      expect(after.getIdleReviewSnapshot().visible).toBe(false)
    } finally {
      restore()
    }
  })

  it('a candidate outside the persisted dismissed set still makes the card reappear after reload', async () => {
    const { restore } = stubSessionStorage()
    try {
      const before = await freshStore()
      before.publishIdleReview({ count: 1, freedBytes: null, candidateKeys: ['x'] }, false)
      before.dismissIdleReview()

      const after = await freshStore()
      after.publishIdleReview({ count: 2, freedBytes: null, candidateKeys: ['x', 'new'] }, false)
      expect(after.getIdleReviewSnapshot().visible).toBe(true)
    } finally {
      restore()
    }
  })

  it('corrupt JSON in storage reads as an empty dismissed set, not a crash', async () => {
    const { restore } = stubSessionStorage()
    try {
      sessionStorage.setItem(DISMISSED_KEY, '{not valid json')
      const mod = await freshStore()
      mod.publishIdleReview({ count: 1, freedBytes: null, candidateKeys: ['x'] }, false)
      expect(mod.getIdleReviewSnapshot().visible).toBe(true)
    } finally {
      restore()
    }
  })

  it('a non-array value in storage also reads as an empty dismissed set', async () => {
    const { restore } = stubSessionStorage()
    try {
      sessionStorage.setItem(DISMISSED_KEY, JSON.stringify({ not: 'an array' }))
      const mod = await freshStore()
      mod.publishIdleReview({ count: 1, freedBytes: null, candidateKeys: ['x'] }, false)
      expect(mod.getIdleReviewSnapshot().visible).toBe(true)
    } finally {
      restore()
    }
  })

  it('a missing key in storage reads as an empty dismissed set', async () => {
    const { restore } = stubSessionStorage()
    try {
      const mod = await freshStore()
      mod.publishIdleReview({ count: 1, freedBytes: null, candidateKeys: ['x'] }, false)
      expect(mod.getIdleReviewSnapshot().visible).toBe(true)
    } finally {
      restore()
    }
  })

  it('pruning drops a dismissed key once it is no longer a candidate, so storage stays bounded', async () => {
    const { restore } = stubSessionStorage()
    try {
      const mod = await freshStore()
      mod.publishIdleReview({ count: 2, freedBytes: null, candidateKeys: ['a', 'b'] }, false)
      mod.dismissIdleReview()
      expect(JSON.parse(sessionStorage.getItem(DISMISSED_KEY)!).sort()).toEqual(['a', 'b'])

      // 'a' drops out of the candidate set (session ended, or stopped being idle) and 'c' joins.
      mod.publishIdleReview({ count: 2, freedBytes: null, candidateKeys: ['b', 'c'] }, false)
      expect(JSON.parse(sessionStorage.getItem(DISMISSED_KEY)!)).toEqual(['b'])
      // The card reappears for 'c', which was never dismissed — pruning changes storage, not visibility.
      expect(mod.getIdleReviewSnapshot().visible).toBe(true)
    } finally {
      restore()
    }
  })
})

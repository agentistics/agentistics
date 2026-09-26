import { describe, expect, it } from 'bun:test'
import {
  dismissIdleReview, getIdleReviewSnapshot, previewIdleReviewVisible, publishIdleReview, snoozeIdleReview,
} from './idleReviewStore'

// Module-level state, exercised in order — the same style `idleReviewRequest.test.ts` already uses
// for its own module-level flag. The snooze test is last on purpose: it is the one test that leaves
// state a later test could not un-do without a fake timer.
describe('idleReviewStore', () => {
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

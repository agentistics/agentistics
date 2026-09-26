import { describe, expect, it } from 'bun:test'
import { requestIdleReview, takeIdleReviewRequest } from './idleReviewRequest'

describe('idleReviewRequest', () => {
  it('starts with nothing pending', () => {
    expect(takeIdleReviewRequest()).toBe(false)
  })

  it('is pending exactly once after a request', () => {
    requestIdleReview()
    expect(takeIdleReviewRequest()).toBe(true)
    expect(takeIdleReviewRequest()).toBe(false)
  })

  it('a second request re-arms it, independent of an earlier take', () => {
    requestIdleReview()
    expect(takeIdleReviewRequest()).toBe(true)
    requestIdleReview()
    requestIdleReview()
    expect(takeIdleReviewRequest()).toBe(true)
    expect(takeIdleReviewRequest()).toBe(false)
  })
})

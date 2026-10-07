import { describe, expect, test } from 'bun:test'
import { ProjectionUnavailable } from '@agentistics/core'
import { shouldDisableProjectedOverlay } from './projectedFallback'

describe('projected overlay fallback', () => {
  test('a 503 disables projection requests for the rest of the page load', () => {
    expect(shouldDisableProjectedOverlay(new ProjectionUnavailable(503, 'projections_backfilling'))).toBe(true)
  })

  test('unrelated failures remain visible as defects', () => {
    expect(shouldDisableProjectedOverlay(new Error('network failure'))).toBe(false)
  })
})

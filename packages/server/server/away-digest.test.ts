import { describe, expect, test } from 'bun:test'
import { AWAY_DIGEST_AFTER, AWAY_DIGEST_BUCKET, awayDigestOfferDue, awayDigestWindow, startAwayDigestTimer, stopAwayDigestTimer } from './away-digest'

const start = Date.parse('2026-01-01T00:00:00.000Z')
const away = { on: true as const, since: new Date(start).toISOString(), until: null, authorizations: [], note: '', workerCeiling: null, topModelCaps: {} }

describe('away digest trigger', () => {
  test('is silent before five hours and due at the first boundary', () => {
    expect(awayDigestOfferDue(away, undefined, start + AWAY_DIGEST_AFTER - 1)).toBeNull()
    expect(awayDigestOfferDue(away, undefined, start + AWAY_DIGEST_AFTER)).toBe(20)
  })

  test('uses fifteen-minute buckets and persists dedupe across restarts', () => {
    const now = start + AWAY_DIGEST_AFTER + AWAY_DIGEST_BUCKET
    expect(awayDigestOfferDue(away, { since: away.since, lastBucket: 20 }, now)).toBe(21)
    expect(awayDigestOfferDue(away, { since: away.since, lastBucket: 21 }, now)).toBeNull()
  })

  test('expires with until and resets state for a new away window', () => {
    const ended = { ...away, until: new Date(start + AWAY_DIGEST_AFTER).toISOString() }
    expect(awayDigestWindow(ended, start + AWAY_DIGEST_AFTER + 1)).toBeNull()
    const next = { ...away, since: new Date(start + 1000).toISOString() }
    expect(awayDigestOfferDue(next, { since: away.since, lastBucket: 99 }, start + AWAY_DIGEST_AFTER + 1000)).toBe(20)
  })

  test('snooze suppresses offers until the snooze deadline', () => {
    const now = start + AWAY_DIGEST_AFTER + 1
    expect(awayDigestOfferDue(away, { since: away.since, lastBucket: 0, snoozedUntil: now + 1000 }, now)).toBeNull()
    expect(awayDigestOfferDue(away, { since: away.since, lastBucket: 19, snoozedUntil: now + 1000 }, now + 1001)).toBe(20)
  })

  test('starts a delivered digest window at lastDeliveredAt', () => {
    const delivered = start + AWAY_DIGEST_AFTER + 1
    expect(awayDigestWindow(away, delivered + 1000, { since: away.since, lastBucket: 20, lastDeliveredAt: delivered })).toEqual({ since: delivered, until: delivered + 1000 })
    expect(awayDigestOfferDue(away, { since: away.since, lastBucket: 20, lastDeliveredAt: delivered }, delivered + AWAY_DIGEST_AFTER + AWAY_DIGEST_BUCKET)).toBe(21)
  })

  test('timer start and stop can be reset without leaving a live interval', () => {
    startAwayDigestTimer(60 * 60 * 1000)
    stopAwayDigestTimer()
    startAwayDigestTimer(60 * 60 * 1000)
    stopAwayDigestTimer()
  })
})

import { describe, expect, test } from 'bun:test'
import { AWAY_DIGEST_AFTER, AWAY_DIGEST_BUCKET, offerAwayDigestWithDeps, type AwayDigestState, awayDigestOfferDue, awayDigestOfferState, awayDigestWindow, startAwayDigestTimer, stopAwayDigestTimer } from './away-digest'

const start = Date.parse('2026-01-01T00:00:00.000Z')
const away = { on: true as const, since: new Date(start).toISOString(), until: null, authorised: [], note: '', maxWorkers: 6, topCaps: {} }

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

  test('new offers preserve delivery history and keep the next tick deduplicated', () => {
    const delivered = start + AWAY_DIGEST_AFTER
    const now = delivered + AWAY_DIGEST_AFTER + AWAY_DIGEST_BUCKET
    const prior = { since: away.since, lastBucket: 20, lastDeliveredAt: delivered, conversationId: 'old-nay' }
    const bucket = awayDigestOfferDue(away, prior, now)!
    const offered = awayDigestOfferState(away.since, bucket, prior)
    expect(offered).toEqual({ since: away.since, lastBucket: 21, lastDeliveredAt: delivered })
    expect(awayDigestWindow(away, now, offered)?.since).toBe(delivered)
    expect(awayDigestOfferDue(away, offered, now + 1)).toBeNull()
    expect(awayDigestOfferState(new Date(now).toISOString(), bucket, prior).lastDeliveredAt).toBeUndefined()
  })

  test('while autonomous mode is ON the summary is delivered as an informational notice — no offer, no Nay, no question', async () => {
    const now = start + AWAY_DIGEST_AFTER
    let prefs: { away?: typeof away; awayDigest?: AwayDigestState; lang?: string } = { away, lang: 'en' }
    const notified: { code: string; meta: Record<string, unknown> }[] = []
    const pushed: string[] = []
    let built = 0
    const deps = {
      read: async () => prefs,
      update: async (mutate: (cur: typeof prefs) => Partial<typeof prefs> | undefined) => { const patch = mutate(prefs); if (patch) prefs = { ...prefs, ...patch } },
      build: async () => { built++; return { tasks: [{}, {}], sessions: [{}], checkIns: [], awayNotices: [{}], releases: 'unavailable' } },
      notify: (code: string, meta: Record<string, unknown>) => { notified.push({ code, meta }) },
      push: (_title: string, body: string) => { pushed.push(body) },
    }
    await offerAwayDigestWithDeps(deps as never, now)
    expect(built).toBe(1)
    expect(notified).toHaveLength(1)
    expect(notified[0]!.code).toBe('away.digest')
    expect(notified[0]!.code).not.toBe('away.digest_offer')
    expect(notified[0]!.meta).toMatchObject({ tasks: 2, sessions: 1, checkIns: 0, notices: 1, releases: 0, bucket: 20, since: away.since })
    expect(pushed[0]).toContain('Informational only')
    expect(pushed[0]).not.toContain('Would you like')
    // Delivery is recorded (the next window starts here) and the same bucket is never announced twice.
    expect(prefs.awayDigest).toMatchObject({ since: away.since, lastBucket: 20, lastDeliveredAt: now })
    await offerAwayDigestWithDeps(deps as never, now + 1000)
    expect(notified).toHaveLength(1)
  })

  test('with autonomous mode OFF there is no window, so nothing is delivered', async () => {
    const notified: string[] = []
    await offerAwayDigestWithDeps({
      read: async () => ({ away: { ...away, on: false } }),
      update: async () => { throw new Error('must not write') },
      build: async () => ({}),
      notify: code => { notified.push(code) },
      push: () => { throw new Error('must not push') },
    }, start + AWAY_DIGEST_AFTER)
    expect(notified).toHaveLength(0)
  })

  test('timer start and stop can be reset without leaving a live interval', () => {
    startAwayDigestTimer(60 * 60 * 1000)
    stopAwayDigestTimer()
    startAwayDigestTimer(60 * 60 * 1000)
    stopAwayDigestTimer()
  })
})

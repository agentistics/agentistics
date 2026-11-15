import { describe, expect, test } from 'bun:test'
import { LIVE_FLEET_MAX_STALE_MS, LIVE_REPLY_MAX_STALE_MS, planLiveFleetRead, planLiveReplyRead } from './live-fleet-plan'

const reply = (o: Partial<Parameters<typeof planLiveReplyRead>[0]>) => planLiveReplyRead({
  keyMatches: true, hasCache: true, ageMs: 0, freshMs: 5_000, inFlightSameKey: false, inFlightAny: false, ...o,
})

describe('planLiveReplyRead', () => {
  test('inside the freshness window: fresh', () => { expect(reply({ ageMs: 4_999 })).toEqual({ kind: 'fresh' }) })
  test('expired by age only: stale, one refresh', () => {
    expect(reply({ ageMs: 5_000 })).toEqual({ kind: 'stale', refresh: true })
    expect(reply({ ageMs: 5_000, inFlightAny: true })).toEqual({ kind: 'stale', refresh: false })
  })
  test('past the stale bound: wait for the build', () => {
    expect(reply({ ageMs: LIVE_REPLY_MAX_STALE_MS }).kind).toBe('stale')
    expect(reply({ ageMs: LIVE_REPLY_MAX_STALE_MS + 1 }).kind).toBe('build')
  })
  test('a changed source key or a dropped cache (a book write) is NEVER answered stale', () => {
    expect(reply({ keyMatches: false, ageMs: 6_000 }).kind).toBe('build')
    expect(reply({ hasCache: false, ageMs: 6_000 }).kind).toBe('build')
  })
  test('a build of the same key running is joined when nothing can be served', () => {
    expect(reply({ keyMatches: false, inFlightSameKey: true })).toEqual({ kind: 'join' })
  })
})

const A = {}, B = {}
const cache = (snapshot: unknown, atMs: number, lang = 'en') => ({ lang, snapshot, atMs })

describe('planLiveFleetRead', () => {
  test('same snapshot, same language: the cache is fresh', () => {
    expect(planLiveFleetRead({ lang: 'en', snapshot: A, nowMs: 1e6, cache: cache(A, 0), inFlight: null })).toEqual({ kind: 'fresh' })
  })
  test('a newer snapshot with rows younger than the bound answers stale and starts ONE refresh', () => {
    expect(planLiveFleetRead({ lang: 'en', snapshot: B, nowMs: 5_000, cache: cache(A, 0), inFlight: null })).toEqual({ kind: 'stale', refresh: true })
  })
  test('a refresh already running is not started twice', () => {
    expect(planLiveFleetRead({ lang: 'en', snapshot: B, nowMs: 5_000, cache: cache(A, 0), inFlight: { lang: 'en', snapshot: B } })).toEqual({ kind: 'stale', refresh: false })
  })
  test('the bound is inclusive; one ms past it the caller waits for a fresh build', () => {
    const at = (age: number) => planLiveFleetRead({ lang: 'en', snapshot: B, nowMs: age, cache: cache(A, 0), inFlight: null })
    expect(at(LIVE_FLEET_MAX_STALE_MS).kind).toBe('stale')
    expect(at(LIVE_FLEET_MAX_STALE_MS + 1).kind).toBe('build')
  })
  test('rows built for another language are never served', () => {
    expect(planLiveFleetRead({ lang: 'pt', snapshot: B, nowMs: 1, cache: cache(A, 0, 'en'), inFlight: null }).kind).toBe('build')
    expect(planLiveFleetRead({ lang: 'pt', snapshot: A, nowMs: 1, cache: cache(A, 0, 'en'), inFlight: null }).kind).toBe('build')
  })
  test('no cache: join a build of this snapshot, otherwise build', () => {
    expect(planLiveFleetRead({ lang: 'en', snapshot: A, nowMs: 1, cache: null, inFlight: { lang: 'en', snapshot: A } })).toEqual({ kind: 'join' })
    expect(planLiveFleetRead({ lang: 'en', snapshot: A, nowMs: 1, cache: null, inFlight: { lang: 'en', snapshot: B } })).toEqual({ kind: 'build' })
    expect(planLiveFleetRead({ lang: 'en', snapshot: A, nowMs: 1, cache: null, inFlight: null })).toEqual({ kind: 'build' })
  })
  test('a clock that went backwards never counts as fresh', () => {
    expect(planLiveFleetRead({ lang: 'en', snapshot: B, nowMs: 0, cache: cache(A, 100), inFlight: null }).kind).toBe('build')
  })
})

import { describe, expect, test } from 'bun:test'
import { liveRowsSignature, LIVE_FLEET_MAX_STALE_MS, LIVE_REPLY_MAX_STALE_MS, planLiveFleetRead, planLiveReplyRead } from './live-fleet-plan'

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
const cache = (snapshot: unknown, atMs: number, lang = 'en', signature: string | null = 'x') => ({ lang, snapshot, atMs, signature })

describe('planLiveFleetRead', () => {
  test('same snapshot, same language: the cache is fresh', () => {
    expect(planLiveFleetRead({ lang: 'en', snapshot: A, nowMs: 1e6, signature: 'x', cache: cache(A, 0), inFlight: null })).toEqual({ kind: 'fresh' })
  })
  test('a newer snapshot with rows younger than the bound answers stale and starts ONE refresh', () => {
    expect(planLiveFleetRead({ lang: 'en', snapshot: B, nowMs: 5_000, cache: cache(A, 0), inFlight: null, signature: 'x' })).toEqual({ kind: 'stale', refresh: true })
  })
  test('a refresh already running is not started twice', () => {
    expect(planLiveFleetRead({ lang: 'en', snapshot: B, nowMs: 5_000, cache: cache(A, 0), inFlight: { lang: 'en', snapshot: B }, signature: 'x' })).toEqual({ kind: 'stale', refresh: false })
  })
  test('the bound is inclusive; one ms past it the caller waits for a fresh build', () => {
    const at = (age: number) => planLiveFleetRead({ lang: 'en', snapshot: B, nowMs: age, cache: cache(A, 0), inFlight: null, signature: 'x' })
    expect(at(LIVE_FLEET_MAX_STALE_MS).kind).toBe('stale')
    expect(at(LIVE_FLEET_MAX_STALE_MS + 1).kind).toBe('build')
  })
  test('rows built for another language are never served', () => {
    expect(planLiveFleetRead({ lang: 'pt', snapshot: B, nowMs: 1, cache: cache(A, 0, 'en'), inFlight: null, signature: 'x' }).kind).toBe('build')
    expect(planLiveFleetRead({ lang: 'pt', snapshot: A, nowMs: 1, cache: cache(A, 0, 'en'), inFlight: null, signature: 'x' }).kind).toBe('build')
  })
  test('no cache: join a build of this snapshot, otherwise build', () => {
    expect(planLiveFleetRead({ lang: 'en', snapshot: A, nowMs: 1, cache: null, inFlight: { lang: 'en', snapshot: A }, signature: 'x' })).toEqual({ kind: 'join' })
    expect(planLiveFleetRead({ lang: 'en', snapshot: A, nowMs: 1, cache: null, inFlight: { lang: 'en', snapshot: B }, signature: 'x' })).toEqual({ kind: 'build' })
    expect(planLiveFleetRead({ lang: 'en', snapshot: A, nowMs: 1, cache: null, inFlight: null, signature: 'x' })).toEqual({ kind: 'build' })
  })
  test('a clock that went backwards never counts as fresh', () => {
    expect(planLiveFleetRead({ lang: 'en', snapshot: B, nowMs: 0, cache: cache(A, 100), inFlight: null, signature: 'x' }).kind).toBe('build')
  })
})

describe('LIVE.12S r3 — stale only when no session changed state', () => {
  const read = (cacheSig: string | null, nowSig: string | null) =>
    planLiveFleetRead({ lang: 'en', snapshot: B, nowMs: 5_000, signature: nowSig, cache: cache(A, 0, 'en', cacheSig), inFlight: null })
  test('same signature: stale is fine', () => { expect(read('s1:running:working', 's1:running:working').kind).toBe('stale') })
  test('a state changed inside the stale window (stale-sim): wait for the fresh build', () => {
    expect(read('s1:running:working', 's1:running:waiting').kind).toBe('build')
  })
  test('a cache no signature vouches for, or no signature now, is never served stale', () => {
    expect(read(null, 's1:running:working').kind).toBe('build')
    expect(read('s1:running:working', null).kind).toBe('build')
    expect(read(null, null).kind).toBe('build')
  })
  test('a build of the changed snapshot already running is joined', () => {
    const p = planLiveFleetRead({ lang: 'en', snapshot: B, nowMs: 5_000, signature: 'n', cache: cache(A, 0, 'en', 'o'), inFlight: { lang: 'en', snapshot: B } })
    expect(p.kind).toBe('join')
  })
})

describe('liveRowsSignature', () => {
  const v = (id: string, status: string, activity?: string, background?: boolean) => ({ id, status, activity, background })
  test('reads id, status, activity and background; skips closed conversations', () => {
    const sig = (rows: ReturnType<typeof v>[]) => liveRowsSignature({ sessions: rows })
    expect(sig([v('a', 'running', 'working'), v('c', 'closed')])).toBe('a:running:working:0')
    expect(sig([v('a', 'running', 'working')])).not.toBe(sig([v('a', 'running', 'waiting')]))
    expect(sig([v('a', 'running', 'working')])).not.toBe(sig([v('a', 'exited', 'working')]))
    expect(sig([v('a', 'running', 'waiting')])).not.toBe(sig([v('a', 'running', 'waiting', true)]))
    expect(sig([v('a', 'running', 'working')])).not.toBe(sig([v('a', 'running', 'working'), v('b', 'running', 'working')]))
    expect(liveRowsSignature(null)).toBeNull()
  })
})

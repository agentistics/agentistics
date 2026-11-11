/**
 * rate-limit.test.ts — the window/lockout math, driven by an explicit clock so nothing
 * depends on wall time.
 */
import { describe, expect, it } from 'bun:test'
import {
  evaluate,
  registerFailure,
  MemoryLimiter,
  RULES,
  rateRuleFor,
  tooManyRequests,
  type Bucket,
  type RateRule,
} from './rate-limit'

const rule: RateRule = { limit: 3, windowMs: 60_000, blockMs: 300_000, backoff: true }
const t0 = 1_000_000

describe('evaluate', () => {
  it('allows the first request and starts a window', () => {
    const r = evaluate(undefined, rule, t0)
    expect(r.allowed).toBe(true)
    expect(r.next.count).toBe(1)
    expect(r.next.windowStart).toBe(t0)
  })

  it('allows up to the limit inside one window', () => {
    let b: Bucket | undefined
    for (let i = 0; i < rule.limit; i++) {
      const r = evaluate(b, rule, t0)
      expect(r.allowed).toBe(true)
      b = r.next
    }
    expect(b!.count).toBe(3)
  })

  it('blocks the request past the limit and reports Retry-After', () => {
    let b: Bucket | undefined
    for (let i = 0; i < rule.limit; i++) b = evaluate(b, rule, t0).next
    const r = evaluate(b, rule, t0)
    expect(r.allowed).toBe(false)
    expect(r.retryAfterSec).toBeGreaterThan(0)
  })

  it('starts a fresh window once the old one elapsed', () => {
    let b: Bucket | undefined
    for (let i = 0; i < rule.limit; i++) b = evaluate(b, rule, t0).next
    const r = evaluate(b, rule, t0 + rule.windowMs + 1)
    expect(r.allowed).toBe(true)
    expect(r.next.count).toBe(1)
  })

  it('keeps blocking while blockedUntil is in the future', () => {
    const blocked: Bucket = { count: 0, windowStart: t0, strikes: 1, blockedUntil: t0 + 10_000 }
    const r = evaluate(blocked, rule, t0 + 5_000)
    expect(r.allowed).toBe(false)
    expect(r.retryAfterSec).toBe(5)
  })

  it('releases the block once it expires', () => {
    const blocked: Bucket = { count: 99, windowStart: t0, strikes: 1, blockedUntil: t0 + 10_000 }
    const r = evaluate(blocked, rule, t0 + 10_001)
    expect(r.allowed).toBe(true)
  })

  it('never mutates the bucket it was given', () => {
    const b: Bucket = { count: 1, windowStart: t0, strikes: 0, blockedUntil: 0 }
    evaluate(b, rule, t0)
    expect(b.count).toBe(1)
  })
})

describe('registerFailure', () => {
  const fresh = (): Bucket => ({ count: 0, windowStart: t0, strikes: 0, blockedUntil: 0, fails: 0, failWindowStart: t0 })

  it('does NOT block before the allowance is spent — a typo is not an attack', () => {
    // The whole point: rule.limit failures are free. This used to block on the first one, so an
    // owner who mistyped their password twice was locked out for half an hour.
    let b = fresh()
    for (let i = 1; i < rule.limit; i++) {
      b = registerFailure(b, rule, t0 + i * 1000)
      expect(b.blockedUntil).toBe(0)
      expect(evaluate(b, rule, t0 + i * 1000 + 1).allowed).toBe(true)
    }
  })

  it('blocks once the allowance IS spent', () => {
    let b = fresh()
    for (let i = 0; i < rule.limit; i++) b = registerFailure(b, rule, t0 + i * 1000)
    expect(b.blockedUntil).toBeGreaterThan(t0)
    expect(evaluate(b, rule, t0 + rule.limit * 1000).allowed).toBe(false)
  })

  it('doubles the block on each further round of failures when backoff is on', () => {
    const spend = (b: Bucket, at: number): Bucket => {
      for (let i = 0; i < rule.limit; i++) b = registerFailure(b, rule, at)
      return b
    }
    let b = spend(fresh(), t0)
    const first = b.blockedUntil - t0
    b = spend(b, t0)
    expect(b.blockedUntil - t0).toBe(first * 2)
  })

  it('keeps a flat block when backoff is off', () => {
    const flat: RateRule = { ...rule, backoff: false }
    const spend = (b: Bucket, at: number): Bucket => {
      for (let i = 0; i < flat.limit; i++) b = registerFailure(b, flat, at)
      return b
    }
    let b = spend(fresh(), t0)
    const first = b.blockedUntil - t0
    b = spend(b, t0)
    expect(b.blockedUntil - t0).toBe(first)
  })

  it('caps the block at 24h', () => {
    let b = fresh()
    for (let i = 0; i < 40 * rule.limit; i++) b = registerFailure(b, rule, t0)
    expect(b.blockedUntil - t0).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })

  it('forgets the failures once the window passes, so mistakes do not accumulate for ever', () => {
    let b = fresh()
    for (let i = 0; i < rule.limit - 1; i++) b = registerFailure(b, rule, t0)
    // One more, a full window later: it opens a fresh tally instead of tipping the old one over.
    b = registerFailure(b, rule, t0 + rule.windowMs + 1)
    expect(b.blockedUntil).toBe(0)
  })

  it('decays the strike history after a quiet day, so backoff punishes a burst and not a memory', () => {
    const spend = (b: Bucket, at: number): Bucket => {
      for (let i = 0; i < rule.limit; i++) b = registerFailure(b, rule, at)
      return b
    }
    let b = spend(fresh(), t0)
    const first = b.blockedUntil - t0
    const muchLater = t0 + 25 * 60 * 60 * 1000
    b = spend(b, muchLater)
    expect(b.blockedUntil - muchLater).toBe(first) // back to the base block, not double
  })

  it('clears the failure tally when a served block expires', () => {
    let b = fresh()
    for (let i = 0; i < rule.limit; i++) b = registerFailure(b, rule, t0)
    const after = evaluate(b, rule, b.blockedUntil + 1)
    expect(after.allowed).toBe(true)
    expect(after.next.fails).toBe(0)
  })
})

describe('MemoryLimiter.blocked — the per-account read that spends nothing', () => {
  it('answers "not blocked" without consuming the attempt budget', () => {
    const lim = new MemoryLimiter()
    // The whole allowance, read a hundred times: reading is not attempting.
    for (let i = 0; i < 100; i++) expect(lim.blocked('acct:a', t0).allowed).toBe(true)
    for (let i = 0; i < rule.limit; i++) lim.fail('acct:a', rule, t0)
    expect(lim.blocked('acct:a', t0).allowed).toBe(false)
  })

  it('lets exactly `limit` failures through before blocking', () => {
    const lim = new MemoryLimiter()
    for (let i = 1; i < rule.limit; i++) {
      lim.fail('acct:b', rule, t0)
      expect(lim.blocked('acct:b', t0).allowed).toBe(true)
    }
    lim.fail('acct:b', rule, t0)
    expect(lim.blocked('acct:b', t0).allowed).toBe(false)
  })

  it('opens again when the block expires', () => {
    const lim = new MemoryLimiter()
    for (let i = 0; i < rule.limit; i++) lim.fail('acct:c', rule, t0)
    const wait = lim.blocked('acct:c', t0).retryAfterSec
    expect(lim.blocked('acct:c', t0 + wait * 1000 + 1).allowed).toBe(true)
  })
})

describe('MemoryLimiter', () => {
  it('isolates keys from each other', () => {
    const l = new MemoryLimiter()
    for (let i = 0; i < rule.limit; i++) l.check('a', rule, t0)
    expect(l.check('a', rule, t0).allowed).toBe(false)
    expect(l.check('b', rule, t0).allowed).toBe(true)
  })

  it('clears a key on reset (successful login)', () => {
    const l = new MemoryLimiter()
    l.fail('a', rule, t0)
    l.reset('a')
    expect(l.check('a', rule, t0).allowed).toBe(true)
  })

  it('sweeps expired buckets so memory cannot grow without bound', () => {
    const l = new MemoryLimiter()
    l.check('a', rule, t0)
    expect(l.size()).toBe(1)
    l.sweep(t0 + 25 * 60 * 60 * 1000)
    expect(l.size()).toBe(0)
  })

  it('never sweeps a bucket that is still blocked', () => {
    const l = new MemoryLimiter()
    l.fail('a', rule, t0 + 25 * 60 * 60 * 1000)
    l.sweep(t0 + 25 * 60 * 60 * 1000)
    expect(l.size()).toBe(1)
  })
})

describe('RULES', () => {
  it('the generic API ceiling is generous — it only blunts scraping', () => {
    expect(RULES.api.limit).toBeGreaterThanOrEqual(300)
  })
})

describe('rateRuleFor', () => {
  it('every path is governed by the generic API ceiling', () => {
    expect(rateRuleFor('/api/data')).toBe(RULES.api)
    expect(rateRuleFor('/api/tags/abc')).toBe(RULES.api)
  })
})

describe('tooManyRequests', () => {
  it('is a 429 carrying Retry-After and a stable code', async () => {
    const res = tooManyRequests(42)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('42')
    expect(await res.json()).toEqual({ error: 'rate_limited', retryAfterSec: 42 })
  })
})

import { describe, expect, it } from 'bun:test'
import type { ProviderError } from './errors'
import { decideRetry, DEFAULT_RETRY_POLICY, type RetryPolicy } from './retry-plan'

/** A minimal, complete `ProviderError` — only the fields a test cares about are overridden. */
function err(overrides: Partial<ProviderError> & Pick<ProviderError, 'kind'>): ProviderError {
  return {
    retryable: false,
    usageOutcome: 'none-reported',
    userCode: 'provider.error',
    ...overrides,
  }
}

describe('decideRetry — retry-after', () => {
  it('is honoured: delay equals the header value, reason retry-after', () => {
    const decision = decideRetry({
      attempt: 1,
      elapsedMs: 0,
      error: err({ kind: 'rate-limited', retryable: true, retryAfterMs: 5000 }),
    })
    expect(decision).toEqual({ retry: true, delayMs: 5000, reason: 'retry-after', nextAttempt: 2 })
  })

  it('wins over backoff when both could apply', () => {
    // Same attempt/elapsed that would yield a 2000ms backoff (attempt 1, default policy) — the
    // retry-after value is honoured instead, not blended or overridden by it.
    const decision = decideRetry({
      attempt: 1,
      elapsedMs: 0,
      error: err({ kind: 'rate-limited', retryable: true, retryAfterMs: 7000 }),
    })
    expect(decision).toEqual({ retry: true, delayMs: 7000, reason: 'retry-after', nextAttempt: 2 })
  })

  it('refuses when it exceeds maxDelayMs — retry-after-exceeds-budget', () => {
    const decision = decideRetry({
      attempt: 1,
      elapsedMs: 0,
      error: err({ kind: 'rate-limited', retryable: true, retryAfterMs: 40_000 }), // > 30_000 maxDelayMs
    })
    expect(decision).toEqual({ retry: false, reason: 'retry-after-exceeds-budget' })
  })

  it('refuses when it exceeds the remaining elapsed budget — same reason', () => {
    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxElapsedMs: 10_000 }
    const decision = decideRetry({
      attempt: 1,
      elapsedMs: 9_000, // remaining budget: 1_000ms
      policy,
      error: err({ kind: 'rate-limited', retryable: true, retryAfterMs: 2_000 }), // under maxDelayMs, over remaining
    })
    expect(decision).toEqual({ retry: false, reason: 'retry-after-exceeds-budget' })
  })
})

describe('decideRetry — backoff', () => {
  it('follows baseDelayMs × factor^(attempt-1): 2000, then 4000', () => {
    const first = decideRetry({
      attempt: 1,
      elapsedMs: 0,
      error: err({ kind: 'overloaded', retryable: true }),
    })
    expect(first).toEqual({ retry: true, delayMs: 2000, reason: 'backoff', nextAttempt: 2 })

    const second = decideRetry({
      attempt: 2,
      elapsedMs: 2000, // after sleeping the first delay
      error: err({ kind: 'overloaded', retryable: true }),
    })
    expect(second).toEqual({ retry: true, delayMs: 4000, reason: 'backoff', nextAttempt: 3 })
  })

  it('caps at maxDelayMs with a custom policy', () => {
    const policy: RetryPolicy = {
      maxAttempts: 5,
      baseDelayMs: 2000,
      factor: 2,
      maxDelayMs: 3000, // uncapped attempt-3 backoff would be 2000 * 2^2 = 8000
      maxElapsedMs: 100_000,
    }
    const decision = decideRetry({
      attempt: 3,
      elapsedMs: 6000,
      policy,
      error: err({ kind: 'api-error', retryable: true }),
    })
    expect(decision).toEqual({ retry: true, delayMs: 3000, reason: 'backoff', nextAttempt: 4 })
  })

  it('refuses when the (uncapped-by-elapsed) backoff would exceed the remaining elapsed budget', () => {
    // elapsedMs (4000) is still under maxElapsedMs (5000) — this is check 7's own refusal, not
    // check 5's "already past the deadline" one.
    const policy: RetryPolicy = { maxAttempts: 5, baseDelayMs: 2000, factor: 2, maxDelayMs: 30_000, maxElapsedMs: 5000 }
    const decision = decideRetry({
      attempt: 2, // backoff = 2000 * 2^1 = 4000; remaining = 5000 - 4000 = 1000
      elapsedMs: 4000,
      policy,
      error: err({ kind: 'api-error', retryable: true }),
    })
    expect(decision).toEqual({ retry: false, reason: 'elapsed-exhausted' })
  })
})

describe('decideRetry — budgets', () => {
  it('refuses once the attempt count reaches maxAttempts', () => {
    const decision = decideRetry({
      attempt: 3, // DEFAULT_RETRY_POLICY.maxAttempts === 3
      elapsedMs: 0,
      error: err({ kind: 'overloaded', retryable: true }),
    })
    expect(decision).toEqual({ retry: false, reason: 'attempts-exhausted' })
  })

  it('refuses once elapsed time reaches maxElapsedMs', () => {
    const decision = decideRetry({
      attempt: 1,
      elapsedMs: 60_000, // DEFAULT_RETRY_POLICY.maxElapsedMs === 60_000
      error: err({ kind: 'overloaded', retryable: true }),
    })
    expect(decision).toEqual({ retry: false, reason: 'elapsed-exhausted' })
  })
})

describe('decideRetry — O-1: ambiguous outcomes are never retried', () => {
  it('client-timeout (usageOutcome unknown) is refused — checked before retryability', () => {
    const decision = decideRetry({
      attempt: 1,
      elapsedMs: 0,
      error: err({ kind: 'client-timeout', retryable: false, usageOutcome: 'unknown' }),
    })
    expect(decision).toEqual({ retry: false, reason: 'ambiguous-outcome' })
  })

  it('a network failure with requestSent true (unknown outcome) is refused EVEN IF retryable is true', () => {
    const decision = decideRetry({
      attempt: 1,
      elapsedMs: 0,
      error: err({ kind: 'network', retryable: true, usageOutcome: 'unknown' }),
    })
    expect(decision).toEqual({ retry: false, reason: 'ambiguous-outcome' })
  })

  it('a network failure with requestSent false (known outcome) retries normally', () => {
    const decision = decideRetry({
      attempt: 1,
      elapsedMs: 0,
      error: err({ kind: 'network', retryable: true, usageOutcome: 'none-reported' }),
    })
    expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'backoff', nextAttempt: 2 })
  })
})

describe('decideRetry — aborted', () => {
  it('is never retried, even when retryable/usageOutcome would otherwise allow it', () => {
    const decision = decideRetry({
      attempt: 1,
      elapsedMs: 0,
      error: err({ kind: 'aborted', retryable: true, usageOutcome: 'none-reported' }),
    })
    expect(decision).toEqual({ retry: false, reason: 'aborted' })
  })
})

describe('decideRetry — non-retryable kinds', () => {
  it('authentication is never retried', () => {
    const decision = decideRetry({
      attempt: 1,
      elapsedMs: 0,
      error: err({ kind: 'authentication', retryable: false, usageOutcome: 'none-reported' }),
    })
    expect(decision).toEqual({ retry: false, reason: 'not-retryable' })
  })

  it('spend-cap is never retried', () => {
    const decision = decideRetry({
      attempt: 1,
      elapsedMs: 0,
      error: err({ kind: 'spend-cap', retryable: false, usageOutcome: 'none-reported' }),
    })
    expect(decision).toEqual({ retry: false, reason: 'not-retryable' })
  })
})

describe('decideRetry — nextAttempt', () => {
  it('is always attempt + 1 on a retry', () => {
    const a = decideRetry({ attempt: 1, elapsedMs: 0, error: err({ kind: 'overloaded', retryable: true }) })
    const b = decideRetry({ attempt: 2, elapsedMs: 2000, error: err({ kind: 'overloaded', retryable: true }) })
    expect(a.retry && a.nextAttempt).toBe(2)
    expect(b.retry && b.nextAttempt).toBe(3)
  })
})

describe('decideRetry — a simulated 3-attempt loop over [529, 529, 529]', () => {
  it('retries twice, then exhausts the attempt budget — each attempt distinct', () => {
    const overloaded = () => err({ kind: 'overloaded', retryable: true })

    const attempt1 = decideRetry({ attempt: 1, elapsedMs: 0, error: overloaded() })
    expect(attempt1).toEqual({ retry: true, delayMs: 2000, reason: 'backoff', nextAttempt: 2 })

    const attempt2 = decideRetry({ attempt: 2, elapsedMs: 2000, error: overloaded() })
    expect(attempt2).toEqual({ retry: true, delayMs: 4000, reason: 'backoff', nextAttempt: 3 })

    const attempt3 = decideRetry({ attempt: 3, elapsedMs: 6000, error: overloaded() })
    expect(attempt3).toEqual({ retry: false, reason: 'attempts-exhausted' })
  })
})

describe('decideRetry — purity', () => {
  it('returns the same output for the same input, and mutates nothing', () => {
    const error = Object.freeze(err({ kind: 'overloaded', retryable: true }))
    const input = Object.freeze({ attempt: 1, elapsedMs: 0, error })

    const first = decideRetry(input)
    const second = decideRetry({ attempt: 1, elapsedMs: 0, error: err({ kind: 'overloaded', retryable: true }) })

    expect(first).toEqual(second)
    // Object.freeze makes an in-place mutation throw in strict mode (ES modules are always strict),
    // so simply not throwing here is itself evidence nothing was written back into the input.
    expect(input.attempt).toBe(1)
    expect(input.elapsedMs).toBe(0)
    expect(input.error.kind).toBe('overloaded')
  })

  it('never throws on a malformed attempt/elapsed', () => {
    expect(() =>
      decideRetry({ attempt: Number.NaN, elapsedMs: -50, error: err({ kind: 'overloaded', retryable: true }) })
    ).not.toThrow()
    expect(() =>
      decideRetry({ attempt: 0, elapsedMs: Number.POSITIVE_INFINITY, error: err({ kind: 'overloaded', retryable: true }) })
    ).not.toThrow()
  })
})

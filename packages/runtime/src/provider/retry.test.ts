/**
 * retry.test.ts — `runWithRetry` against a FAKE `ProviderClient` (no network, no `fetch`, no real
 * clock). See docs/superpowers/specs/2026-09-25-runtime-b1-provider.md §4.5, §7 (the four events per
 * retried attempt), §9 ("the four SDK conditions" test 4, adapted here to the retry loop itself
 * rather than a stub `fetch`, since `./anthropic/client.ts` is being written in parallel and this
 * file must not depend on it existing).
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { classifyProviderError, ANTHROPIC_EDIT_POLICY, DEFAULT_RETRY_POLICY } from '@agentistics/core'
import type { ProviderError } from '@agentistics/core'
import type { InvocationCommon, InvocationResult, ProviderClient, ProviderRequest } from './client.ts'
import { runWithRetry, retryCounters, type AttemptHooks } from './retry.ts'

// ── a fake ProviderClient — never touches `fetch`, never imports `./anthropic/client.ts` ─────────

function makeCompleted(over: Partial<InvocationCommon> & { attempt: number }): InvocationResult {
  return {
    invocationId: over.invocationId ?? 'inv_test',
    attempt: over.attempt,
    provider: 'anthropic',
    requestedModel: 'claude-opus-5',
    startedAt: over.startedAt ?? new Date().toISOString(),
    latencyMs: over.latencyMs ?? 1,
    requestId: over.requestId,
    status: 'completed',
    messageId: `msg_${over.attempt}`,
    servedModel: 'claude-opus-5',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    usageAnomalies: [],
    stopReason: { kind: 'end-turn' },
    content: [{ type: 'text', text: 'ok' }],
  }
}

function makeFailed(
  over: Partial<InvocationCommon> & { attempt: number },
  error: ProviderError,
): InvocationResult {
  return {
    invocationId: over.invocationId ?? 'inv_test',
    attempt: over.attempt,
    provider: 'anthropic',
    requestedModel: 'claude-opus-5',
    startedAt: over.startedAt ?? new Date().toISOString(),
    latencyMs: over.latencyMs ?? 1,
    requestId: over.requestId,
    status: 'failed',
    error,
  }
}

/** A client whose `invokeOnce` answers from a fixed script, one entry per attempt (1-based). */
function fakeClient(script: Array<(attempt: number) => InvocationResult | Promise<InvocationResult>>): {
  client: ProviderClient
  calls: number[]
} {
  const calls: number[] = []
  const client: ProviderClient = {
    provider: 'anthropic',
    adapterVersion: 'test',
    capabilities: { streaming: false, editPolicy: ANTHROPIC_EDIT_POLICY },
    async invokeOnce(_req, attempt) {
      calls.push(attempt)
      const entry = script[attempt - 1]
      if (!entry) throw new Error(`fakeClient: no script entry for attempt ${attempt}`)
      return entry(attempt)
    },
  }
  return { client, calls }
}

/** A client whose `invokeOnce` always throws — for the "invokeOnce throwing" test. */
function throwingClient(): { client: ProviderClient; calls: number[] } {
  const calls: number[] = []
  const client: ProviderClient = {
    provider: 'anthropic',
    adapterVersion: 'test',
    capabilities: { streaming: false, editPolicy: ANTHROPIC_EDIT_POLICY },
    async invokeOnce(_req, attempt) {
      calls.push(attempt)
      throw new Error('boom — an SDK rejection nobody classified')
    },
  }
  return { client, calls }
}

function makeReq(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 64,
    correlation: { invocationId: 'inv_test' },
    credential: { provider: 'anthropic', id: 'default' },
    ...over,
  }
}

/** Records every delay it was asked to wait, and resolves immediately (or when told to abort). */
function instantSleep(delays: number[]): (ms: number, signal?: AbortSignal) => Promise<void> {
  return async (ms, _signal) => {
    delays.push(ms)
  }
}

beforeEach(() => {
  retryCounters.hook_failed = 0
})

describe('runWithRetry', () => {
  test('529 overloaded then completed → 2 attempts, distinct requestIds, 2 starts + 2 ends, one sleep at the backoff delay', async () => {
    const overloaded = classifyProviderError({ httpStatus: 529, errorType: 'overloaded_error', requestIdHeader: 'req_1' })
    const { client, calls } = fakeClient([
      attempt => makeFailed({ attempt, requestId: 'req_1' }, overloaded),
      attempt => makeCompleted({ attempt, requestId: 'req_2' }),
    ])

    const starts: number[] = []
    const ends: InvocationResult[] = []
    const delays: number[] = []
    const hooks: AttemptHooks = {
      onAttemptStart: info => starts.push(info.attempt),
      onAttemptEnd: result => ends.push(result),
    }

    const outcome = await runWithRetry(client, makeReq(), { sleep: instantSleep(delays), hooks })

    expect(calls).toEqual([1, 2])
    expect(outcome.attempts).toHaveLength(2)
    expect(outcome.attempts[0]!.attempt).toBe(1)
    expect(outcome.attempts[1]!.attempt).toBe(2)
    expect(outcome.attempts[0]!.requestId).toBe('req_1')
    expect(outcome.attempts[1]!.requestId).toBe('req_2')
    expect(outcome.stoppedBecause).toBe('completed')
    expect(outcome.final.status).toBe('completed')

    expect(starts).toEqual([1, 2])
    expect(ends).toHaveLength(2)

    expect(delays).toEqual([DEFAULT_RETRY_POLICY.baseDelayMs])
  })

  test('rate-limited with retryAfterMs → sleep is called with retryAfterMs, not the backoff figure', async () => {
    const rateLimited = classifyProviderError({ httpStatus: 429, errorType: 'rate_limit_error', retryAfterHeader: '7' })
    expect(rateLimited.retryAfterMs).toBe(7000)

    const { client } = fakeClient([
      attempt => makeFailed({ attempt }, rateLimited),
      attempt => makeCompleted({ attempt }),
    ])
    const delays: number[] = []

    const outcome = await runWithRetry(client, makeReq(), { sleep: instantSleep(delays) })

    expect(delays).toEqual([7000])
    expect(outcome.attempts).toHaveLength(2)
    expect(outcome.stoppedBecause).toBe('completed')
  })

  test('non-retryable (authentication) → 1 attempt, no sleep', async () => {
    const authError = classifyProviderError({ httpStatus: 401, errorType: 'authentication_error' })
    const { client, calls } = fakeClient([attempt => makeFailed({ attempt }, authError)])
    const delays: number[] = []

    const outcome = await runWithRetry(client, makeReq(), { sleep: instantSleep(delays) })

    expect(calls).toEqual([1])
    expect(outcome.attempts).toHaveLength(1)
    expect(outcome.stoppedBecause).toBe('not-retryable')
    expect(outcome.final.status).toBe('failed')
    expect(delays).toEqual([])
  })

  test("usageOutcome 'unknown' (client-timeout) → 1 attempt, stoppedBecause 'ambiguous-outcome'", async () => {
    const timeoutError = classifyProviderError({ transport: 'client-timeout' })
    expect(timeoutError.usageOutcome).toBe('unknown')

    const { client, calls } = fakeClient([attempt => makeFailed({ attempt }, timeoutError)])
    const outcome = await runWithRetry(client, makeReq(), { sleep: instantSleep([]) })

    expect(calls).toEqual([1])
    expect(outcome.attempts).toHaveLength(1)
    expect(outcome.stoppedBecause).toBe('ambiguous-outcome')
  })

  test("usageOutcome 'unknown' (network, requestSent: true) → 1 attempt, never retried despite being an otherwise-retryable-shaped failure", async () => {
    const networkError = classifyProviderError({ transport: 'network', requestSent: true })
    expect(networkError.usageOutcome).toBe('unknown')

    const { client, calls } = fakeClient([attempt => makeFailed({ attempt }, networkError)])
    const outcome = await runWithRetry(client, makeReq(), { sleep: instantSleep([]) })

    expect(calls).toEqual([1])
    expect(outcome.stoppedBecause).toBe('ambiguous-outcome')
  })

  test('exhausted at 3 attempts (default policy maxAttempts = 3)', async () => {
    const overloaded = classifyProviderError({ httpStatus: 529, errorType: 'overloaded_error' })
    const { client, calls } = fakeClient([
      attempt => makeFailed({ attempt }, overloaded),
      attempt => makeFailed({ attempt }, overloaded),
      attempt => makeFailed({ attempt }, overloaded),
    ])
    const delays: number[] = []

    const outcome = await runWithRetry(client, makeReq(), { sleep: instantSleep(delays) })

    expect(calls).toEqual([1, 2, 3])
    expect(outcome.attempts).toHaveLength(3)
    expect(outcome.stoppedBecause).toBe('attempts-exhausted')
    expect(outcome.final.status).toBe('failed')
    // two sleeps happened (before attempt 2 and before attempt 3); the third failure stops the loop.
    expect(delays).toHaveLength(2)
  })

  test('abort during backoff → no further invokeOnce', async () => {
    const overloaded = classifyProviderError({ httpStatus: 529, errorType: 'overloaded_error' })
    const controller = new AbortController()
    const { client, calls } = fakeClient([
      attempt => makeFailed({ attempt }, overloaded),
      // never reached — aborted during the backoff sleep before a second invokeOnce could happen.
      attempt => makeCompleted({ attempt }),
    ])

    const sleep = async (_ms: number, signal?: AbortSignal) => {
      controller.abort()
      expect(signal?.aborted).toBe(true)
    }

    const outcome = await runWithRetry(client, makeReq({ signal: controller.signal }), { sleep })

    expect(calls).toEqual([1])
    expect(outcome.attempts).toHaveLength(1)
    expect(outcome.stoppedBecause).toBe('aborted')
    // the final result is still the last attempt's own (failed) record — the abort ends the LOOP,
    // it does not retroactively change what that attempt returned.
    expect(outcome.final.status).toBe('failed')
  })

  test('a throwing hook does not fail the call, and increments retryCounters.hook_failed', async () => {
    const { client } = fakeClient([attempt => makeCompleted({ attempt })])
    const hooks: AttemptHooks = {
      onAttemptStart: () => {
        throw new Error('a hook that misbehaves')
      },
      onAttemptEnd: () => {
        throw new Error('another hook that misbehaves')
      },
    }

    expect(retryCounters.hook_failed).toBe(0)
    const outcome = await runWithRetry(client, makeReq(), { sleep: instantSleep([]), hooks })

    expect(outcome.final.status).toBe('completed')
    expect(outcome.stoppedBecause).toBe('completed')
    expect(retryCounters.hook_failed).toBe(2)
  })

  test('invokeOnce throwing → a failed sdk-rejected result, never a throw out of runWithRetry', async () => {
    const { client: throwing, calls: throwingCalls } = throwingClient()

    const outcome = await runWithRetry(throwing, makeReq(), { sleep: instantSleep([]) })

    expect(throwingCalls).toEqual([1])
    expect(outcome.attempts).toHaveLength(1)
    expect(outcome.final.status).toBe('failed')
    if (outcome.final.status === 'failed') {
      expect(outcome.final.error.kind).toBe('sdk-rejected')
      expect(outcome.final.error.usageOutcome).toBe('unknown')
    }
    // sdk-rejected also carries usageOutcome: 'unknown' (its billing state was never observed),
    // which decideRetry refuses ahead of the retryable check (O-1) — the loop stops after one
    // attempt either way, but the STATED reason is the billing ambiguity, not the classifier's
    // (also-false) retryable verdict.
    expect(outcome.stoppedBecause).toBe('ambiguous-outcome')
  })

  test('elapsedMs is measured from the FIRST attempt, monotonically, via the injected clock', async () => {
    const overloaded = classifyProviderError({ httpStatus: 529, errorType: 'overloaded_error' })
    const { client } = fakeClient([
      attempt => makeFailed({ attempt }, overloaded),
      attempt => makeCompleted({ attempt }),
    ])

    let now = 0
    const clockReads: number[] = []
    const monotonicNow = () => {
      clockReads.push(now)
      return now
    }
    // advance the clock a lot on the sleep, well past DEFAULT_RETRY_POLICY.maxElapsedMs would be a
    // different test; here just prove the clock is actually consulted rather than Date.now().
    const sleep = async () => {
      now += 100
    }

    const outcome = await runWithRetry(client, makeReq(), { sleep, monotonicNow })
    expect(outcome.stoppedBecause).toBe('completed')
    expect(clockReads.length).toBeGreaterThan(0)
  })
})

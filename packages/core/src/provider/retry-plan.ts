/**
 * retry-plan.ts — the retry the RUNTIME owns, never the SDK. B1 spec §4.5
 * (docs/superpowers/specs/2026-09-25-runtime-b1-provider.md).
 *
 * PURE. No clock, no sleep, no IO — `elapsedMs` is an INPUT, never read from `Date.now()` in here.
 * The AI SDK is configured with `maxRetries: 0`, always: an SDK-internal retry would be invisible
 * to this product (no `model.invoked` / `model.completed | model.failed` pair, no attempt number,
 * nothing for a surface to show). `retry.ts` (owned elsewhere) calls `invokeOnce` once per attempt,
 * emits that attempt's own events, asks `decideRetry`, sleeps abortably, and loops — so three
 * attempts are SIX events, never one event carrying a count.
 *
 * WHY AN AMBIGUOUS ATTEMPT IS NEVER RETRIED (O-1). The AI SDK sends no idempotency key (research 13
 * §5), and whether Anthropic's Messages API even accepts an `Idempotency-Key` header is UNVERIFIED
 * (O-1 — R13 asserts it with no citation to an Anthropic page; R12 is silent). Until that is
 * verified, retrying an attempt whose outcome is unknown — the request may have already completed
 * and billed server-side — risks a SECOND charge with nothing to reconcile the two against. So
 * `decideRetry` refuses `usageOutcome: 'unknown'` outright, belt-and-braces over whatever
 * `errors.ts`'s classifier separately decided about `retryable` — an attempt can be classified
 * retryable (e.g. a `network` failure where the capturing fetch could not tell whether the request
 * left) and still be refused here because its BILLING state, not its retryability, is what is
 * unknown.
 */

import type { ProviderError } from './errors'

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  factor: number
  maxDelayMs: number
  maxElapsedMs: number
}

// Targets chosen to match the vendors' own defaults (spec §4.5), not measured against Anthropic's
// server behaviour: 2 retries — official SDKs retry twice (R12 §1.7) — 2000ms initial delay and a
// factor of 2 — the AI SDK's own defaults (R13 §5). A policy object, not constants scattered through
// `retry.ts`.
export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = {
  maxAttempts: 3,
  baseDelayMs: 2000,
  factor: 2,
  maxDelayMs: 30_000,
  maxElapsedMs: 60_000,
}

export type RetryDecision =
  | { retry: true; delayMs: number; reason: 'retry-after' | 'backoff'; nextAttempt: number }
  | {
      retry: false
      reason:
        | 'not-retryable'
        | 'attempts-exhausted'
        | 'retry-after-exceeds-budget'
        | 'elapsed-exhausted'
        | 'aborted'
        // Addition beyond the spec's four-reason list (§4.5): the O-1 refusal needs its own name,
        // distinct from `not-retryable`, because the ERROR may be classified retryable and still be
        // refused — the reason names the actual cause (unknown billing state), not the classifier's
        // verdict.
        | 'ambiguous-outcome'
    }

export interface DecideRetryInput {
  /** The 1-based number of the attempt that just FAILED. Each attempt is its own invocation, its
   * own event pair and its own number — the planner never merges attempts, so `nextAttempt` below
   * is simply `attempt + 1`, never a count. */
  attempt: number
  error: ProviderError
  elapsedMs: number
  policy?: RetryPolicy
}

/**
 * Decide whether the attempt that just failed should be retried, and if so, after how long.
 *
 * Order of checks (spec §4.5, read top to bottom — the first match wins):
 *   1. `aborted` — never retried (matches the SDK's own guard, R13 §6).
 *   2. `usageOutcome === 'unknown'` — never retried (O-1), even when `retryable` says otherwise.
 *   3. `!retryable` — refused by the classifier itself.
 *   4. attempt budget exhausted.
 *   5. elapsed budget exhausted.
 *   6. `retryAfterMs` present — wins over backoff; refused if it would exceed either budget.
 *   7. otherwise exponential backoff, capped at `maxDelayMs`, refused if it would exceed what is
 *      left of the elapsed budget.
 *
 * No jitter. The spec does not call for one (§4.5 only names `baseDelayMs × factor^(attempt-1)`
 * capped at `maxDelayMs`) — left as an OPEN POINT for whoever wires this into `retry.ts`, not a
 * decision made here.
 */
export function decideRetry(input: DecideRetryInput): RetryDecision {
  const { error } = input
  const policy = input.policy ?? DEFAULT_RETRY_POLICY

  // Defensive: never throw on a malformed input. A non-finite or sub-1 attempt number is read as
  // the first attempt (the most conservative reading — it under-counts progress toward the attempt
  // budget rather than over-counting it); a non-finite or negative elapsed reads as zero elapsed
  // (nothing has been spent yet, the most conservative reading for the elapsed budget too).
  const attempt = Number.isFinite(input.attempt) && input.attempt >= 1 ? Math.floor(input.attempt) : 1
  const elapsedMs = Number.isFinite(input.elapsedMs) && input.elapsedMs > 0 ? input.elapsedMs : 0

  // 1. Abort ends the loop immediately, and is never retried — matching the SDK's own guard.
  if (error.kind === 'aborted') return { retry: false, reason: 'aborted' }

  // 2. O-1: no idempotency key is sent, so an attempt whose billing outcome is unknown is never
  // repeated — even if the classifier separately marked the error `retryable`.
  if (error.usageOutcome === 'unknown') return { retry: false, reason: 'ambiguous-outcome' }

  // 3. Only a kind the classifier marked retryable may be retried at all.
  if (!error.retryable) return { retry: false, reason: 'not-retryable' }

  // 4. Attempt budget.
  if (attempt >= policy.maxAttempts) return { retry: false, reason: 'attempts-exhausted' }

  // 5. Elapsed budget.
  if (elapsedMs >= policy.maxElapsedMs) return { retry: false, reason: 'elapsed-exhausted' }

  const remainingMs = policy.maxElapsedMs - elapsedMs

  // 6. `retry-after` (seconds, converted to ms upstream by the classifier) wins over backoff
  // whenever it is present.
  if (error.retryAfterMs !== undefined) {
    if (error.retryAfterMs > policy.maxDelayMs || error.retryAfterMs > remainingMs) {
      return { retry: false, reason: 'retry-after-exceeds-budget' }
    }
    return { retry: true, delayMs: error.retryAfterMs, reason: 'retry-after', nextAttempt: attempt + 1 }
  }

  // 7. Exponential backoff, capped at `maxDelayMs`.
  const backoffMs = Math.min(policy.baseDelayMs * Math.pow(policy.factor, attempt - 1), policy.maxDelayMs)
  if (backoffMs > remainingMs) return { retry: false, reason: 'elapsed-exhausted' }
  return { retry: true, delayMs: backoffMs, reason: 'backoff', nextAttempt: attempt + 1 }
}

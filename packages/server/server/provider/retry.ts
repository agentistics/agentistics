/**
 * retry.ts — the retry loop the RUNTIME owns, never the SDK (B1 spec §4.5, subtask B1.4(c)).
 *
 * IO: this is the ONE place that owns the clock (`monotonicNow`, default `performance.now`) and the
 * sleep (default a plain abortable `setTimeout`-based wait). `@agentistics/core`'s `decideRetry` is
 * pure and receives `elapsedMs` as an input — it never reads a clock itself (retry-plan.ts's own
 * doc comment). The SDK is configured with `maxRetries: 0` (`anthropic/client.ts`), so this loop is
 * the ONLY caller of `client.invokeOnce`, and it calls it exactly once per attempt: a retried SDK
 * call would be invisible to the journal (no `model.invoked`/`model.completed|failed` pair, no
 * attempt number), which is the whole reason the runtime — not the SDK — owns this.
 *
 * Each attempt becomes its own `InvocationResult` in `RetryOutcome.attempts`, in order, never
 * merged or summed — three attempts are three records, matching the "three attempts are SIX
 * journal events" rule the emission layer (B1.6) builds on top of `AttemptHooks`.
 *
 * NON-HOLDER (provider-secrets.lint.test.ts): this file never touches a credential. It imports only
 * TYPES from `./client.ts` (never `PROVIDER_CLIENTS` or any runtime binding), so its tests never
 * depend on `./anthropic/client.ts` — and by extension never on the Anthropic SDK or a credential —
 * existing at all.
 */

import { DEFAULT_RETRY_POLICY, decideRetry, classifyProviderError } from '@agentistics/core'
import type { RetryDecision, RetryPolicy } from '@agentistics/core'
import type { InvocationResult, ProviderClient, ProviderRequest } from './client.ts'

/**
 * The seams B1.6's `emit.ts` attaches `model.invoked` / `model.completed` / `model.failed` to. A
 * hook that throws must NEVER fail the call — it is a reporting side-channel, not part of the
 * invocation's own outcome — so every call site here is wrapped and a failure is counted rather
 * than propagated or swallowed silently.
 */
export interface AttemptHooks {
  onAttemptStart?(info: { invocationId: string; attempt: number; startedAt: string }): void
  onAttemptEnd?(result: InvocationResult): void
  onRetryScheduled?(info: {
    attempt: number
    delayMs: number
    reason: Extract<RetryDecision, { retry: true }>['reason']
  }): void
}

/** Every reason `decideRetry` can give for stopping, plus the one success outcome. */
export type RetryStoppedBecause = 'completed' | Extract<RetryDecision, { retry: false }>['reason']

export interface RetryOutcome {
  final: InvocationResult
  /** one record per HTTP attempt, in order — never merged. */
  attempts: InvocationResult[]
  stoppedBecause: RetryStoppedBecause
}

export interface RunWithRetryOptions {
  policy?: RetryPolicy
  /**
   * Abortable wait. The default resolves early when `signal` fires mid-sleep — an abort during
   * backoff must not block the loop from noticing it and returning without another `invokeOnce`.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Monotonic clock for `elapsedMs`; never a wall-clock subtraction (spec §4.1's `latencyMs` rule,
   *  applied to the retry budget too). Defaults to `performance.now`. */
  monotonicNow?: () => number
  hooks?: AttemptHooks
}

/**
 * A hook is a reporting side-channel and must never affect the invocation's own outcome. Every
 * failure is caught here and counted, never re-thrown and never logged with a value that could
 * carry the credential (the hook itself is the caller's code — this file does not inspect what it
 * threw).
 */
export const retryCounters = { hook_failed: 0 }

function safeInvoke<T extends unknown[]>(fn: ((...args: T) => void) | undefined, ...args: T): void {
  if (!fn) return
  try {
    fn(...args)
  } catch {
    retryCounters.hook_failed++
  }
}

function defaultMonotonicNow(): number {
  return performance.now()
}

/**
 * The default sleep: a plain `setTimeout`, resolved early (and the timer cleared) the instant
 * `signal` aborts. `ms <= 0` resolves immediately without scheduling a timer at all — `retryAfterMs`
 * can legitimately be `0`.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) return Promise.resolve()
  if (signal?.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * `invokeOnce` never throws by contract (`ProviderClient.invokeOnce`'s own doc), but this loop is
 * the outermost caller and a defensive wrap is cheap insurance: a throw here becomes a `'failed'`
 * result classified `sdk-rejected` via the core classifier, rather than propagating out of
 * `runWithRetry` and losing the attempt record (and every attempt already made) entirely.
 */
function asFailedResult(
  err: unknown,
  ctx: { invocationId: string; attempt: number; provider: ProviderClient['provider']; requestedModel: string; startedAt: string; latencyMs: number },
): InvocationResult {
  void err // never inspected: whatever it carries must not be logged or surfaced (it is arbitrary caller/SDK state)
  return {
    invocationId: ctx.invocationId,
    attempt: ctx.attempt,
    provider: ctx.provider,
    requestedModel: ctx.requestedModel,
    startedAt: ctx.startedAt,
    latencyMs: ctx.latencyMs,
    status: 'failed',
    error: classifyProviderError({ sdkRejected: true }),
  }
}

/**
 * Run one `ProviderRequest` to completion, retrying failed attempts per `@agentistics/core`'s
 * `decideRetry` (spec §4.5). Loop shape:
 *
 *   attempt = 1, 2, … → `client.invokeOnce(req, attempt)`
 *     → completed: stop, `stoppedBecause: 'completed'`.
 *     → failed: ask `decideRetry({attempt, error, elapsedMs, policy})` with `elapsedMs` measured by
 *       the monotonic clock from the FIRST attempt's start.
 *         → `retry: false`: stop with that decision's `reason`.
 *         → `retry: true`: sleep `delayMs` (abortably); if the request's `signal` fired during that
 *           sleep, stop WITHOUT another `invokeOnce` (`stoppedBecause: 'aborted'` — an abort during
 *           backoff emits no new attempt, spec §4.5); otherwise loop with `decision.nextAttempt`.
 *
 * No jitter — `decideRetry` (core) does not apply one and this loop invents none; an open point for
 * later, not a decision made here (see `retry-plan.ts`'s own doc comment).
 */
export async function runWithRetry(
  client: ProviderClient,
  req: ProviderRequest,
  opts: RunWithRetryOptions = {},
): Promise<RetryOutcome> {
  const policy = opts.policy ?? DEFAULT_RETRY_POLICY
  const sleep = opts.sleep ?? defaultSleep
  const monotonicNow = opts.monotonicNow ?? defaultMonotonicNow
  const hooks = opts.hooks ?? {}

  const invocationId = req.correlation.invocationId
  const attempts: InvocationResult[] = []
  const firstAttemptStart = monotonicNow()

  let attempt = 1
  for (;;) {
    const startedAt = new Date().toISOString()
    const attemptStartMono = monotonicNow()
    safeInvoke(hooks.onAttemptStart, { invocationId, attempt, startedAt })

    let result: InvocationResult
    try {
      result = await client.invokeOnce(req, attempt)
    } catch (err) {
      result = asFailedResult(err, {
        invocationId,
        attempt,
        provider: client.provider,
        requestedModel: req.model,
        startedAt,
        latencyMs: monotonicNow() - attemptStartMono,
      })
    }

    attempts.push(result)
    safeInvoke(hooks.onAttemptEnd, result)

    if (result.status === 'completed') {
      return { final: result, attempts, stoppedBecause: 'completed' }
    }

    const elapsedMs = monotonicNow() - firstAttemptStart
    const decision = decideRetry({ attempt, error: result.error, elapsedMs, policy })

    if (!decision.retry) {
      return { final: result, attempts, stoppedBecause: decision.reason }
    }

    safeInvoke(hooks.onRetryScheduled, { attempt, delayMs: decision.delayMs, reason: decision.reason })

    await sleep(decision.delayMs, req.signal)

    if (req.signal?.aborted) {
      // Abort during backoff: no further invokeOnce, and this iteration emits no new
      // model.invoked. The last attempt's own result stays the `final` value (it is still the most
      // recent fact about the call); only `stoppedBecause` says the LOOP was cut short by the abort
      // rather than by that attempt's own classification.
      return { final: result, attempts, stoppedBecause: 'aborted' }
    }

    attempt = decision.nextAttempt
  }
}

/**
 * Lifecycle for the suites that run the delivery engine over REAL stores in a temp dir.
 *
 * Bun does not cancel a test that times out: it reports the failure, runs `afterEach` and moves on while the body is still running.
 * A body mid-tick then finds its temp dir removed, and every later read or rename surfaces as "Unhandled error between tests",
 * which is attributed to no test and so fails the whole run without the pre-commit retry. These suites do real fsynced writes
 * (a custody fixture alone is ~50 ticks), so under a loaded machine they do pass Bun's 5 s default.
 *
 * Two parts, and a suite needs both: `setDefaultTimeout(REAL_STORE_TIMEOUT_MS)` so load is not a failure, and `afterEach` awaiting
 * `settled()` BEFORE it removes the dir, so a body that still overruns is one attributable timeout and nothing else.
 */
import { test as bunTest } from 'bun:test'

export const REAL_STORE_TIMEOUT_MS = 60_000

/** `test` that remembers its body, and `settled()` which resolves once every remembered body has finished (either way). */
export function ownedTests() {
  const running = new Set<Promise<unknown>>()
  const test = (name: string, body: () => unknown, timeoutMs?: number): void => {
    bunTest(name, () => {
      // The same promise goes to Bun, which judges it; `settled` only waits for it and never swallows its outcome.
      const p = Promise.resolve(body())
      running.add(p)
      return p as Promise<void>
    }, timeoutMs)
  }
  const settled = async (): Promise<void> => {
    await Promise.allSettled([...running])
    running.clear()
  }
  return { test, settled }
}

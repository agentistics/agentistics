/**
 * session/scheduler.ts — `createRunScheduler({ceiling})`: a CEILING on concurrent runs, never a
 * timer (§24.4, mirrored from the cockpit's `SHELL_CAP` rule in CLAUDE.md: a TTL kills the run that
 * is still legitimately working at an hour nobody was watching; a ceiling only ever refuses a NEW
 * run and never touches one already in flight).
 *
 * `tryAcquire()` is synchronous and cheap on purpose — `runtime.ts` calls it before anything else a
 * `run()` does, so a machine already at capacity never mints a run id, never opens a lease and never
 * spends a model call finding out it should have refused. `release()` is idempotent: calling it twice
 * (a `finally` racing an explicit release) must not let the ceiling drift upward over time.
 */

export interface RunScheduler {
  /** How many runs may be in flight at once. */
  readonly ceiling: number
  /** How many are in flight right now. */
  inFlight(): number
  tryAcquire(): { ok: true; release(): void } | { ok: false; code: 'at-ceiling'; sentence: string }
}

export interface RunSchedulerOptions {
  ceiling: number
}

export function createRunScheduler(opts: RunSchedulerOptions): RunScheduler {
  const ceiling = Math.max(1, Math.floor(opts.ceiling))
  let inFlight = 0

  return {
    ceiling,
    inFlight: () => inFlight,
    tryAcquire() {
      if (inFlight >= ceiling) {
        return {
          ok: false,
          code: 'at-ceiling',
          sentence: `Refused: this machine is already running ${ceiling} of ${ceiling} sessions at once.`,
        }
      }
      inFlight += 1
      let released = false
      return {
        ok: true,
        release() {
          if (released) return
          released = true
          inFlight = Math.max(0, inFlight - 1)
        },
      }
    },
  }
}

/**
 * session-hub.ts — ONE fleet poller per process, and everything that reads the fleet reads it.
 *
 * Before this, the server polled the fleet once per REQUEST (`/api/fleet`, every chat stream's 1 Hz
 * retry, every send's `record()`), and the event producer ran a SECOND poller of its own beside it
 * (ENGINE.MAP P-01, P-02, P-03, P-08). Measured on a throwaway server with ONE idle session: 36 tmux
 * calls a minute with nothing open, 84 with one client polling `/api/fleet`, 270 with one chat open
 * on a row whose transcript did not exist yet — and two pollers disagreeing about working/waiting,
 * because "working" is MOVEMENT since the previous poll OF THAT POLLER.
 *
 * The hub owns the poller and the last snapshot:
 *
 * - **Single flight.** Any number of concurrent readers share one poll in flight; a poll never runs
 *   twice at once, so the poller's between-poll memory (frame digests, confirmation) only ever moves
 *   forward one poll at a time.
 * - **Timer-driven, on DEMAND.** While something holds a subscription (the event producer, a
 *   `/api/fleet/events` stream, an open chat waiting for its link) or a reader asked within the last
 *   `leaseMs`, the hub polls every `intervalMs` on its own and readers are answered from the last
 *   snapshot. With no demand at all it does not poll — a central, or a machine nobody is looking at,
 *   pays nothing. N clients cost one tick, never N.
 * - **`refresh()` after an act.** A spawn, a kill, a rename changes the fleet NOW; the caller asks for
 *   a poll that STARTS after the act (one already in flight began before it and cannot have seen it),
 *   and subscribers get the result on the same push path as any tick.
 * - **Listeners never throw into the hub.** One that throws is reported and the rest still receive.
 *
 * Pure apart from the injected clock and timers, so every rule above is pinned by a test.
 */
import type { SessionSnapshot } from './sessions-host'

export interface SessionHubOptions {
  /** One real poll. The hub never calls it twice at once. */
  poll(): Promise<SessionSnapshot>
  /** The tick interval while there is demand. */
  intervalMs: number
  /** How long one `read()` keeps the hub ticking with no subscriber. Default 30 s. */
  leaseMs?: number
  /**
   * How old a snapshot `read()` accepts when the hub is NOT ticking. Default 1 s — the same window the
   * old per-request memo used, so a burst of routes opening one session still costs one poll.
   */
  idleMaxAgeMs?: number
  now?: () => number
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  warn?: (message: string) => void
}

export interface SessionHubStats {
  polls: number
  subscribers: number
  ticking: boolean
}

export interface SessionHub {
  /** The last completed snapshot, or `null` before the first poll. Never polls. */
  last(): SessionSnapshot | null
  /**
   * A snapshot fresh enough for a reader: the last one while the hub is ticking (it is at most one
   * interval old), otherwise one no older than `maxAgeMs` (default `idleMaxAgeMs`). Joins a poll in
   * flight rather than starting a second. Every read extends the demand lease.
   */
  read(opts?: { maxAgeMs?: number }): Promise<SessionSnapshot>
  /** A poll that starts AFTER this call — for a caller that just changed the fleet. */
  refresh(): Promise<SessionSnapshot>
  /** Every completed poll, and DEMAND: while held, the hub ticks. */
  subscribe(cb: (snap: SessionSnapshot) => void): () => void
  /** Every completed poll, WITHOUT demand (a passive observer such as the engine's fleet view). */
  observe(cb: (snap: SessionSnapshot) => void): () => void
  stats(): SessionHubStats
  /** Stop ticking and drop every listener (tests, shutdown). */
  stop(): void
}

export const DEFAULT_LEASE_MS = 30_000
export const DEFAULT_IDLE_MAX_AGE_MS = 1_000

export function createSessionHub(o: SessionHubOptions): SessionHub {
  const now = o.now ?? (() => Date.now())
  const setTimer = o.setTimer ?? ((f, ms) => setTimeout(f, ms))
  const clearTimer = o.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
  const warn = o.warn ?? ((m: string) => console.warn(m))
  const leaseMs = o.leaseMs ?? DEFAULT_LEASE_MS
  const idleMaxAgeMs = o.idleMaxAgeMs ?? DEFAULT_IDLE_MAX_AGE_MS

  const subs = new Set<(snap: SessionSnapshot) => void>()
  const observers = new Set<(snap: SessionSnapshot) => void>()
  let last: SessionSnapshot | null = null
  /** When `last` was taken, by the hub's clock (the snapshot's own `polledAtMs` is the poller's). */
  let lastAt = -Infinity
  let inflight: Promise<SessionSnapshot> | null = null
  let inflightStartedAt = -Infinity
  /** A poll asked for by `refresh()` while one was in flight: it runs as soon as that one settles. */
  let queued: Promise<SessionSnapshot> | null = null
  let timer: unknown = null
  let leaseUntil = -Infinity
  let polls = 0
  let stopped = false

  const demand = (): boolean => !stopped && (subs.size > 0 || now() < leaseUntil)
  const ticking = (): boolean => timer !== null

  function notify(snap: SessionSnapshot): void {
    for (const cb of [...observers, ...subs]) {
      try { cb(snap) } catch (e) { warn(`[session-hub] listener failed: ${e instanceof Error ? e.message : String(e)}`) }
    }
  }

  function schedule(): void {
    if (timer !== null) { clearTimer(timer); timer = null }
    if (!demand()) return
    // From the START of the last poll, so a refresh between ticks does not stretch the cadence and two
    // polls never land closer than one interval apart on their own.
    const due = Math.max(0, inflightStartedAt + o.intervalMs - now())
    timer = setTimer(() => {
      timer = null
      if (!demand()) return
      void start().catch(() => { /* reported to the readers that asked; the next tick retries */ })
    }, due)
  }

  function start(): Promise<SessionSnapshot> {
    if (inflight) return inflight
    inflightStartedAt = now()
    polls++
    const p = (async () => {
      try {
        const snap = await o.poll()
        if (!stopped) {
          last = snap
          lastAt = now()
          notify(snap)
        }
        return snap
      } finally {
        inflight = null
        if (!stopped) schedule()
      }
    })()
    inflight = p
    return p
  }

  function ensureTicking(): void {
    if (!ticking() && !inflight && demand()) schedule()
  }

  return {
    last: () => last,

    read(opts) {
      leaseUntil = Math.max(leaseUntil, now() + leaseMs)
      if (inflight) return inflight
      const maxAge = opts?.maxAgeMs ?? (ticking() ? o.intervalMs * 2 : idleMaxAgeMs)
      if (last && now() - lastAt <= maxAge) {
        ensureTicking()
        return Promise.resolve(last)
      }
      return start()
    },

    refresh() {
      leaseUntil = Math.max(leaseUntil, now() + leaseMs)
      if (!inflight) return start()
      if (!queued) {
        queued = inflight.catch(() => undefined).then(() => {
          queued = null
          return start()
        })
      }
      return queued
    },

    subscribe(cb) {
      subs.add(cb)
      ensureTicking()
      return () => {
        subs.delete(cb)
        if (!demand() && timer !== null) { clearTimer(timer); timer = null }
      }
    },

    observe(cb) {
      observers.add(cb)
      return () => { observers.delete(cb) }
    },

    stats: () => ({ polls, subscribers: subs.size, ticking: ticking() }),

    stop() {
      stopped = true
      if (timer !== null) { clearTimer(timer); timer = null }
      subs.clear()
      observers.clear()
    },
  }
}

/**
 * LIVE.12S r2 — how the Live line reads the fleet: PURE decision, IO stays in `fleet-web.ts`.
 *
 * `readLiveFleet` cached the rows per hub SNAPSHOT identity, and the hub takes a new snapshot every poll
 * (5 s while anything watches), so the cache missed on almost every call and each Live read paid a whole
 * `host.sessions()` rebuild (130 ms warm, 0.8 s under load, 1.3–2.6 s on a cold hub, 3.6k rows) in front of
 * a view that only needs agent states.
 *
 * Stale-while-revalidate, BOUNDED: rows built at most `LIVE_FLEET_MAX_STALE_MS` ago answer at once while a
 * single refresh runs behind them. Bounded on purpose — an unbounded SWR would show a "working" agent that
 * finished an hour ago. Nothing else that reads `host.sessions()` goes through this.
 */

/** One minute. Past this the caller waits for a fresh build exactly as before. */
export const LIVE_FLEET_MAX_STALE_MS = 60_000

/** How long a book reply past its 5 s freshness may still answer while it rebuilds behind it. */
export const LIVE_REPLY_MAX_STALE_MS = 60_000

export type LiveReplyPlan =
  | { kind: 'fresh' }
  /** Same source files, only AGE expired: answer now, rebuild behind (unless one is running). */
  | { kind: 'stale'; refresh: boolean }
  | { kind: 'join' }
  | { kind: 'build' }

/**
 * The book reply behind `/api/tasks/live`. Only AGE may be answered stale: a different source key (a file
 * changed) or a dropped cache (a book write) always waits for a fresh build, so a write is never hidden.
 */
export function planLiveReplyRead(o: {
  keyMatches: boolean
  hasCache: boolean
  ageMs: number
  freshMs: number
  maxStaleMs?: number
  inFlightSameKey: boolean
  inFlightAny: boolean
}): LiveReplyPlan {
  if (o.hasCache && o.keyMatches) {
    if (o.ageMs >= 0 && o.ageMs < o.freshMs) return { kind: 'fresh' }
    if (o.ageMs >= 0 && o.ageMs <= (o.maxStaleMs ?? LIVE_REPLY_MAX_STALE_MS)) return { kind: 'stale', refresh: !o.inFlightAny }
  }
  return o.inFlightSameKey ? { kind: 'join' } : { kind: 'build' }
}

export interface LiveFleetCacheFacts { lang: string; snapshot: unknown; atMs: number }
export interface LiveFleetFlightFacts { lang: string; snapshot: unknown }

export type LiveFleetPlan =
  /** The cached rows ARE this snapshot's. */
  | { kind: 'fresh' }
  /** Answer with the cached rows now; start a refresh unless one is already running. */
  | { kind: 'stale'; refresh: boolean }
  /** A build for this very snapshot is running: wait for it. */
  | { kind: 'join' }
  | { kind: 'build' }

export function planLiveFleetRead(o: {
  lang: string
  snapshot: unknown
  nowMs: number
  cache: LiveFleetCacheFacts | null
  inFlight: LiveFleetFlightFacts | null
  maxStaleMs?: number
}): LiveFleetPlan {
  const { cache, inFlight } = o
  const maxStale = o.maxStaleMs ?? LIVE_FLEET_MAX_STALE_MS
  if (cache && cache.lang === o.lang) {
    if (cache.snapshot === o.snapshot) return { kind: 'fresh' }
    const age = o.nowMs - cache.atMs
    if (age >= 0 && age <= maxStale) return { kind: 'stale', refresh: !(inFlight && inFlight.lang === o.lang) }
  }
  if (inFlight && inFlight.lang === o.lang && inFlight.snapshot === o.snapshot) return { kind: 'join' }
  return { kind: 'build' }
}

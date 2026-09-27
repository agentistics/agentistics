/**
 * integrations/live/file-tail.ts — the file-tail floor (A5.3): a LIVE transcript's new bytes reach
 * the journal within one poll, through the SAME fold the replay uses, under the SAME event ids.
 *
 * The shadow writer (`journal/shadow.ts`) rides the build, which runs every ~30 s only while somebody
 * is watching a dashboard — so without this a conversation that is being written reaches the journal
 * whenever a person happens to look. The tail is the floor under that: every `LIVE_INTERVAL_MS` it
 * stats the sources, picks the ones whose stamp MOVED, and replays exactly those by their cursor.
 * Nothing here decides what an entry means — it is the replay's `replay(source, cursor)` called
 * sooner, and the rules that make that sound are the replay's own:
 *
 * - **Same fold, same ids, so the two paths CONVERGE.** An event id is derived from the source record
 *   (`deriveEventId`: sourceKind / sourceId / sourceRef / type / ordinal / providerRequestId), and
 *   provenance is not in that preimage. So whichever of the tail and the build reads a line first
 *   writes it and the other one's copy lands as a `duplicate` — the journal's UNIQUE id is the whole
 *   reconciliation, and `file-tail.test.ts` pins it in both orders.
 * - **The tail follows only what GROWS.** Its first tick is a BASELINE: it remembers every stamp and
 *   reads nothing. History is the build's and `agentop journal import`'s job; a timer that re-read the
 *   store on boot would be the 2.3 GB-every-30 s load `shadow.ts`'s header measured, on a second clock.
 * - **Bounded, far below the replay's own walk memory.** At most `LIVE_MAX_SOURCES` sources per tick,
 *   newest first in a TOTAL order (mtime, then id — never Map or readdir order); the rest are DEFERRED
 *   and remain candidates next tick. The cap is a quarter of `MAX_STATES` (the walks the Claude replay
 *   retains) so the tail's walks and the build's cannot evict each other into full re-reads.
 * - **A cursor advances only over what the journal ACCEPTED**, the shadow's rule: `append` reports
 *   `accepted` (the journal's `dropped` counter did not move), and anything else leaves the cursor —
 *   and the remembered stamp — where they were, so the next tick reads it again.
 * - **The tail NEVER emits `*.ended` by itself.** It reads only sources whose stamp is moving, and
 *   the replay emits a conversation's ends only once the file has been quiet for its settle window —
 *   by which time the stamp has stopped moving and the tail has stopped reading it. The build's
 *   shadow run closes it afterwards: a source last accepted while live is replayed once more after it
 *   settles (`SETTLE_MARGIN_MS`), which is why the tail reports every acceptance back (`onAccepted`).
 * - **It can only log.** One source's failure costs that source, never the tick; `tick` never throws;
 *   a tick that finds one running returns `busy`; the timer is `unref`'d so it never keeps the process
 *   alive.
 *
 * ## Provenance: `observed`, not `live`
 *
 * The brief asked for `mode: 'live'`, which is not a member of the CLOSED `ProvenanceMode`
 * vocabulary. `observed` is that vocabulary's own definition of this path — "read off a harness's
 * own artifact while it was live". Hooks and OTLP (round 2) will be `instrumented`. `asObserved`
 * re-stamps the mode and nothing else; the id is unchanged because the mode is not in its preimage.
 */
import type { AgentisticsEvent } from '@agentistics/core'
import type { SourceStamp } from '../../journal/shadow'
import { createLimiter } from '../../utils'
import type { HarnessReplay, ReplayCursor, ReplaySource } from '../types'

/** The fleet poll's cadence: a live screen and a live journal move at the same speed. */
export const LIVE_INTERVAL_MS = 5000
/** Sources replayed per tick. Deliberately a quarter of `MAX_STATES` (transcript-state.ts) — see the
 *  header; `file-tail.test.ts` asserts the ratio, so raising one without the other fails the build. */
export const LIVE_MAX_SOURCES = 8
/** Sources replayed at once within a tick. */
export const LIVE_CONCURRENCY = 2
/** Events per `append` — the shadow's `FLUSH_EVENTS`, one transaction each. */
export const LIVE_FLUSH_EVENTS = 500

export interface TailPlan {
  /** Replay these this tick, in this order. */
  tail: string[]
  /** Changed, but over the cap: candidates again next tick. */
  deferred: string[]
  /** The first tick: every stamp remembered, nothing read. */
  baseline: boolean
}

/**
 * PURE. Which sources to replay. `prev === null` is the baseline. Otherwise a source is a candidate
 * when its stamp key differs from the remembered one (a new source counts as changed); candidates are
 * ordered newest first, ties by id — a TOTAL order, so the same inputs always tail the same sources.
 */
export function planTail(
  prev: ReadonlyMap<string, SourceStamp> | null,
  current: ReadonlyMap<string, SourceStamp>,
  opts: { maxSources: number },
): TailPlan {
  if (prev === null) return { tail: [], deferred: [], baseline: true }
  const candidates: { id: string; mtimeMs: number }[] = []
  for (const [id, stamp] of current) {
    if (prev.get(id)?.key !== stamp.key) candidates.push({ id, mtimeMs: stamp.mtimeMs })
  }
  candidates.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const cap = Math.max(0, Math.floor(opts.maxSources))
  return {
    tail: candidates.slice(0, cap).map(c => c.id),
    deferred: candidates.slice(cap).map(c => c.id),
    baseline: false,
  }
}

/**
 * PURE. What to remember after a tick: the current stamps, except that a source in `retry` keeps its
 * PREVIOUS stamp (or is absent when it had none) so it is a candidate again next tick. Bounded to the
 * sources that exist now — a stamp for a vanished transcript is not kept.
 */
export function nextBaseline(
  prev: ReadonlyMap<string, SourceStamp> | null,
  current: ReadonlyMap<string, SourceStamp>,
  retry: Iterable<string>,
): Map<string, SourceStamp> {
  const out = new Map(current)
  for (const id of retry) {
    const before = prev?.get(id)
    if (before) out.set(id, before)
    else out.delete(id)
  }
  return out
}

/** A copy of `e` with `provenance.mode = 'observed'`; everything else, the id included, untouched. */
export function asObserved(e: AgentisticsEvent): AgentisticsEvent {
  return { ...e, provenance: { ...e.provenance, mode: 'observed' } }
}

export interface TailAppendResult {
  written: number
  duplicates: number
  rejected: number
  /** Nothing was dropped by the journal — the only condition under which a cursor may advance. */
  accepted: boolean
}

export interface FileTailDeps {
  readStamps: () => Promise<Map<string, SourceStamp>>
  replay: HarnessReplay
  append: (events: readonly AgentisticsEvent[]) => Promise<TailAppendResult>
  getCursor: (id: string) => ReplayCursor
  setCursor: (id: string, cursor: ReplayCursor) => void
  /** Called once a source's events were all accepted, with the stamp the tick read for it. */
  onAccepted?: (id: string, stamp: SourceStamp) => void
  intervalMs?: number
  maxSources?: number
  concurrency?: number
  flushEvents?: number
  /** Default `console.warn`. */
  warn?: (msg: string) => void
  /** Injectable timer, so a test drives `tick()` itself. Defaults: the global ones. */
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export interface TailStats {
  /** Ticks that ran (baseline included; `busy` ones are counted apart). */
  ticks: number
  busy: number
  /** Source replays attempted, summed over ticks. */
  tailed: number
  /** Sources deferred over the cap, summed over ticks. */
  deferred: number
  /** Source replays that threw or whose append was not accepted. */
  failed: number
  events: number
  written: number
  duplicates: number
  rejected: number
  /** Wall time of the last tick that ran. */
  lastTickMs: number
}

export type TailTick =
  | { status: 'busy' }
  | { status: 'failed' }
  | { status: 'baseline'; sources: number }
  | {
    status: 'ran'
    tailed: number
    deferred: number
    failed: number
    events: number
    written: number
    duplicates: number
    rejected: number
    ms: number
  }

export interface FileTail {
  tick(): Promise<TailTick>
  /** Starts the unref'd timer. Idempotent. */
  start(): void
  stop(): void
  stats(): TailStats
}

export function createFileTail(deps: FileTailDeps): FileTail {
  const intervalMs = Math.max(1, deps.intervalMs ?? LIVE_INTERVAL_MS)
  const maxSources = Math.max(1, deps.maxSources ?? LIVE_MAX_SOURCES)
  const concurrency = Math.max(1, deps.concurrency ?? LIVE_CONCURRENCY)
  const flushEvents = Math.max(1, deps.flushEvents ?? LIVE_FLUSH_EVENTS)
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  const setTimer = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearTimer = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))

  let remembered: Map<string, SourceStamp> | null = null
  /** id → source from earlier `discover()` calls, bounded to the ids in the latest stamp map. */
  const known = new Map<string, ReplaySource>()
  let running = false
  let timer: unknown = null
  const stats: TailStats = {
    ticks: 0, busy: 0, tailed: 0, deferred: 0, failed: 0,
    events: 0, written: 0, duplicates: 0, rejected: 0, lastTickMs: 0,
  }

  async function resolve(ids: readonly string[], current: ReadonlyMap<string, SourceStamp>): Promise<void> {
    for (const id of known.keys()) if (!current.has(id)) known.delete(id)
    if (ids.every(id => known.has(id))) return
    let found: ReplaySource[]
    try { found = await deps.replay.discover() } catch (e) {
      warn(`[journal] live tail could not discover sources: ${String(e)}`)
      return
    }
    for (const src of found) {
      if (current.has(src.sessionId) && !known.has(src.sessionId)) known.set(src.sessionId, src)
    }
  }

  async function run(): Promise<TailTick> {
    const t0 = performance.now()
    let current: Map<string, SourceStamp>
    try { current = await deps.readStamps() } catch (e) {
      warn(`[journal] live tail could not read stamps: ${String(e)}`)
      return { status: 'failed' }
    }
    const plan = planTail(remembered, current, { maxSources })
    if (plan.baseline) {
      remembered = nextBaseline(null, current, [])
      stats.ticks++
      stats.lastTickMs = Math.round(performance.now() - t0)
      return { status: 'baseline', sources: current.size }
    }

    await resolve(plan.tail, current)
    const retry = new Set(plan.deferred)
    let events = 0
    let written = 0
    let duplicates = 0
    let rejected = 0
    let failed = 0
    let tailed = 0

    const limit = createLimiter(concurrency)
    await Promise.all(plan.tail.map(id => limit(async () => {
      // A source discover() cannot name is left to the build — its stamp is adopted, not retried
      // every tick, since a re-discover per tick is the store scan this module exists to avoid.
      const src = known.get(id)
      if (!src) return
      tailed++
      try {
        let batch: { events: AgentisticsEvent[]; cursor: ReplayCursor } | null =
          await deps.replay.replay(src, deps.getCursor(id))
        let accepted = true
        for (let i = 0; i < batch.events.length; i += flushEvents) {
          const slice = batch.events.slice(i, i + flushEvents).map(asObserved)
          const res = await deps.append(slice)
          events += slice.length
          written += res.written
          duplicates += res.duplicates
          rejected += res.rejected
          if (!res.accepted) accepted = false
        }
        const cursor = batch.cursor
        batch = null // the only whole conversation this tick holds; let it go before the next one
        if (accepted) {
          deps.setCursor(id, cursor)
          const stamp = current.get(id)
          if (stamp) deps.onAccepted?.(id, stamp)
        } else {
          failed++
          retry.add(id)
        }
      } catch (e) {
        failed++
        retry.add(id)
        warn(`[journal] live tail failed for ${src.sourceRef}: ${String(e)}`)
      }
    })))

    remembered = nextBaseline(remembered, current, retry)
    const ms = Math.round(performance.now() - t0)
    stats.ticks++
    stats.tailed += tailed
    stats.deferred += plan.deferred.length
    stats.failed += failed
    stats.events += events
    stats.written += written
    stats.duplicates += duplicates
    stats.rejected += rejected
    stats.lastTickMs = ms
    return { status: 'ran', tailed, deferred: plan.deferred.length, failed, events, written, duplicates, rejected, ms }
  }

  async function tick(): Promise<TailTick> {
    if (running) { stats.busy++; return { status: 'busy' } }
    running = true
    try {
      return await run()
    } catch (e) {
      warn(`[journal] live tail tick failed: ${String(e)}`)
      return { status: 'failed' }
    } finally {
      running = false
    }
  }

  return {
    tick,
    start() {
      if (timer !== null) return
      timer = setTimer(() => { void tick() }, intervalMs)
      const h = timer as { unref?: () => void }
      if (typeof h?.unref === 'function') h.unref()
    },
    stop() {
      if (timer === null) return
      clearTimer(timer)
      timer = null
    },
    stats: () => ({ ...stats }),
  }
}

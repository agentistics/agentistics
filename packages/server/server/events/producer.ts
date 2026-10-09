/**
 * producer.ts — the thing that watches. One long-lived poller, and everything that follows from
 * that being long-lived.
 *
 * ## Why this MUST be long-lived, and why it therefore rides along with the daemon
 *
 * `createSessionsPoller` holds two things between polls: the digest of each session's last frame,
 * and each session's last activity. Both are in memory, and both are what make the answer correct:
 *
 *  - **Movement is the only universal "working" signal.** For several harnesses the screen looks
 *    identical whether they are streaming output or sitting idle — codex draws the same footer
 *    either way — so the only proof of work is that the frame CHANGED since last time. A process
 *    that polls once has no "last time".
 *  - **tmux's own `session_activity` is not a substitute.** Measured on this machine while writing
 *    this: a session that had been working continuously for 53 minutes reported its last tmux
 *    activity 3185 seconds earlier, because nothing was attached to it. That is well past the
 *    marker staleness window, so a single-invocation read discards the `esc to interrupt` marker
 *    too and lands on `waiting`.
 *
 * Put together: **a single-invocation poll reports working sessions as finished.** A `agentop
 * events` implemented as a cron job or a per-invocation check would announce that five sessions
 * finished at the moment they all started. False notifications are worse than none — people stop
 * looking — so the producer is a loop that keeps its memory, and there is no single-shot event
 * source in this design except the Claude `Stop` hook, which is exact by construction and infers
 * nothing.
 *
 * That settles the daemon question. A separate process the user must remember to start is a process
 * that will be dead when it matters, so the producer runs INSIDE the daemon `agentop server`
 * already starts (`otel-watcher`), where it costs one extra tmux capture per session per five
 * seconds and starts with the machine. `agentop events run` starts the same producer in the
 * foreground for someone who does not run the server — and `agentop events status` says which of
 * the two is up, because "nothing is producing events" must be a visible state.
 *
 * ## First poll writes nothing
 *
 * See `event-plan.ts`: a session the producer has never seen has no previous state, so nothing can
 * be said to have changed about it. Restarting the daemon therefore does not replay the fleet into
 * the inbox as a flood of "started waiting".
 */

import type { HarnessProcess } from '../live-sessions'
import type { SessionSnapshot, SessionsPoller } from '../sessions/sessions-host'
import { SESSION_POLL_MS } from '../sessions/sessions-host'
import { dedupeEvents } from './event-dedupe'
import { EMPTY_MEMORY, planEvents, seedMemory, type EventMemory } from './event-plan'
import { createEventStore, type EventStore } from './event-store'
import type { EventCandidate, SessionEvent } from './event-types'
import { deliver, readMutedKeys, type DeliveryReport } from './notifier'
import { desktopSetup, type DesktopSetup } from './desktop'
import { kindsToRecord, type Subscription } from './subscriptions'

/** How many recent events the dedupe is judged against. Two polls' worth of a large fleet. */
const DEDUPE_LOOKBACK = 50

/** A `SessionView` reduced to what an event needs. Exported so the tests can build one. */
export function toCandidate(v: {
  id: string
  harness?: EventCandidate['harness']
  cwd: string
  task?: string
  label?: string
  conversationId?: string
  activity?: EventCandidate['activity']
  lastLines?: string[]
}): EventCandidate {
  return {
    id: v.id,
    ...(v.harness ? { harness: v.harness } : {}),
    cwd: v.cwd,
    ...(v.task ? { task: v.task } : {}),
    ...(v.label ? { label: v.label } : {}),
    ...(v.conversationId ? { conversationId: v.conversationId } : {}),
    ...(v.activity ? { activity: v.activity } : {}),
    ...(v.lastLines && v.lastLines.length > 0 ? { lines: v.lastLines } : {}),
  }
}

export interface ProducerTick {
  /** What was written this tick. Empty on most ticks, which is the point. */
  written: SessionEvent[]
  delivery: DeliveryReport
  /** Why the fleet reading may be incomplete, already a sentence. */
  unavailable?: string
}

export interface Producer {
  /** One poll. Returns what it wrote and what it delivered. */
  tick(): Promise<ProducerTick>
  /**
   * One snapshot somebody ELSE polled — the server's SessionHub (`session-hub.ts`), so the server runs
   * ONE poller rather than two that disagree (ENGINE.MAP P-01). Same rules as `tick`; the caller must
   * hand each poll over once and in order.
   */
  consume(snap: SessionSnapshot): Promise<ProducerTick>
  /** Loop until `stop()`. Resolves when the loop has ended. */
  run(): Promise<void>
  stop(): void
  /** What the producer believes about the fleet — what makes the next tick a comparison. */
  memory(): EventMemory
}

export function createProducer(o: {
  poller: SessionsPoller
  /** Read on every tick, so a subscription registered while the producer runs takes effect without
   *  restarting it. A user who has to bounce a daemon to add a filter will not add the filter. */
  readSubscriptions: () => Promise<Subscription[]>
  store?: EventStore
  desktop?: DesktopSetup
  nowIso?: () => string
  nowMs?: () => number
  intervalMs?: number
  /** Reported to the caller instead of thrown: a producer that dies on one bad poll is a producer
   *  that is not running when it matters. */
  onError?: (message: string) => void
}): Producer {
  const store = o.store ?? createEventStore()
  const nowIso = o.nowIso ?? (() => new Date().toISOString())
  const nowMs = o.nowMs ?? (() => Date.now())
  const interval = o.intervalMs ?? SESSION_POLL_MS

  let memory: EventMemory = EMPTY_MEMORY
  let seeded = false
  let stopped = false
  let desktop = o.desktop

  async function tick(): Promise<ProducerTick> {
    return consume(await o.poller.poll())
  }

  async function consume(snap: SessionSnapshot): Promise<ProducerTick> {
    const sessions = snap.sessions.map(toCandidate)

    // A failed poll returns the PREVIOUS list plus a reason. Comparing against it would report
    // nothing changed, which is true of the list and not of the world — so a tick that could not
    // read the fleet writes no events and says why, rather than producing a confident silence.
    if (snap.unavailable !== undefined) {
      return { written: [], delivery: { lines: [], peersReached: 0, peersFailed: 0, toastsShown: 0, toastsFailed: 0 }, unavailable: snap.unavailable }
    }

    const subs = await o.readSubscriptions().catch(() => [] as Subscription[])

    if (!seeded) {
      // The first sighting is not a transition. See the header.
      memory = seedMemory(sessions)
      seeded = true
      return { written: [], delivery: { lines: [], peersReached: 0, peersFailed: 0, toastsShown: 0, toastsFailed: 0 } }
    }

    const planned = planEvents({ memory, sessions, nowIso: nowIso(), kinds: kindsToRecord(subs) })
    // The memory advances whether or not anything was written — see `planEvents`.
    memory = planned.memory
    const candidates = planned.events

    if (candidates.length === 0) {
      return { written: [], delivery: { lines: [], peersReached: 0, peersFailed: 0, toastsShown: 0, toastsFailed: 0 } }
    }

    // The hook may already have reported the same end of turn. Judged against the inbox tail rather
    // than against in-memory state, because the hook writes from a DIFFERENT process.
    const recent = (await store.recent(DEDUPE_LOOKBACK).catch(() => ({ events: [] as SessionEvent[] }))).events
    const fresh = dedupeEvents(candidates, recent, nowMs())
    if (fresh.length === 0) {
      return { written: [], delivery: { lines: [], peersReached: 0, peersFailed: 0, toastsShown: 0, toastsFailed: 0 } }
    }

    const written = await store.append(fresh)
    if (desktop === undefined && subs.some(s => s.desktop)) desktop = await desktopSetup()
    const delivery = await deliver({
      events: written,
      subscriptions: subs,
      muted: await readMutedKeys(),
      ...(desktop ? { desktop } : {}),
    })
    return { written, delivery }
  }

  async function run(): Promise<void> {
    stopped = false
    while (!stopped) {
      try {
        await tick()
      } catch (e) {
        o.onError?.(e instanceof Error ? e.message : String(e))
      }
      if (stopped) break
      await new Promise(r => setTimeout(r, interval))
    }
  }

  return { tick, consume, run, stop: () => { stopped = true }, memory: () => memory }
}

/**
 * The producer this machine's daemon runs, wired to the real backend.
 *
 * Null when the session backend cannot run here at all — on Windows there is no tmux and no fleet
 * to watch, and a producer that polls a backend that will never answer is a loop burning a process
 * to learn the same nothing. The caller reports the reason.
 */
export async function createHostProducer(o?: {
  readSubscriptions?: () => Promise<Subscription[]>
  onError?: (message: string) => void
}): Promise<{ producer: Producer } | { unavailable: string }> {
  const [{ resolveBackend }, { readRegistry }, { scanProcesses }, { createSessionsPoller }, { loadConversations }] =
    await Promise.all([
      import('../sessions/index'),
      import('../sessions/registry'),
      import('../live-sessions'),
      import('../sessions/sessions-host'),
      import('../sessions/conversations'),
    ])

  const backend = await resolveBackend()
  const blocked = await backend.unavailable()
  if (blocked) return { unavailable: blocked }

  const poller = createSessionsPoller({
    backend,
    readRegistry,
    scanProcesses: scanProcesses as () => Promise<{ procs: HarnessProcess[] }>,
    loadConversations,
  })

  const { readSubscriptions } = await import('./subscription-store')
  return {
    producer: createProducer({
      poller,
      readSubscriptions: o?.readSubscriptions ?? readSubscriptions,
      ...(o?.onError ? { onError: o.onError } : {}),
    }),
  }
}

/**
 * The producer INSIDE the server: it polls nothing of its own and consumes the snapshots of the
 * server's ONE poller (`session-hub.ts`) — the caller subscribes it to the hub. Null-equivalent
 * (`unavailable`) under the same condition as `createHostProducer`: a backend that cannot run here.
 */
export async function createHubProducer(o: {
  hub: { read(): Promise<SessionSnapshot> }
  readSubscriptions?: () => Promise<Subscription[]>
  onError?: (message: string) => void
}): Promise<{ producer: Producer } | { unavailable: string }> {
  const { resolveBackend } = await import('../sessions/index')
  const backend = await resolveBackend()
  const blocked = await backend.unavailable()
  if (blocked) return { unavailable: blocked }
  const { readSubscriptions } = await import('./subscription-store')
  return {
    producer: createProducer({
      // `tick()` is never driven on this producer (the hub drives `consume`); a stray call reads the
      // hub's last snapshot rather than polling.
      poller: { poll: () => o.hub.read() },
      readSubscriptions: o.readSubscriptions ?? readSubscriptions,
      ...(o.onError ? { onError: o.onError } : {}),
    }),
  }
}

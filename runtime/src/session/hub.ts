/**
 * session/hub.ts — one fan-out per session, shared by every surface watching it (spec
 * docs/superpowers/specs/2026-09-27-runtime-b4-sessions.md §5, B4.3).
 *
 * ## The shape, in one paragraph
 *
 * `createSessionHub` holds ONE entry per session: a monotonic `seq` counter, a bounded REPLAY RING
 * of the frames that carry a `seq` (`event` / `delta` / `ask` / `ask-closed` — see
 * `protocol.ts`'s `SequencedOutboundFrame`), the set of watchers currently attached, an optional
 * INPUT DRIVER (the one function that actually runs a submitted input) and the pending person-asks
 * this session has open. `publish` does O(watchers) enqueue work and nothing else — no timer, no
 * loop, no IO — which is what makes the fan-out cost per SESSION rather than per watcher, the same
 * shape `terminal-hub.ts` already established for a tmux capture loop (there: one poll shared by N
 * readers; here: one broadcast shared by N readers, and there is no poll at all).
 *
 * ## Two independent bounds, on purpose
 *
 * The RING bounds how far back a RECONNECTING watcher can be caught up (`ringSize`, default 512).
 * The per-watcher QUEUE bounds how far a watcher that is falling BEHIND right now can lag before it
 * is told so (`watcherQueueSize`, default 256). They answer different questions — "how much history
 * exists at all" against "how much can one slow reader owe" — and conflating them would either make
 * every watcher pay for a deep ring it never asked for, or make the ring only as deep as the
 * slowest reader's queue.
 *
 * A watcher's queue **never grows past its cap**: the moment a push would exceed it, the entire
 * backlog is dropped and replaced by exactly one `gap` frame naming how many frames were lost and
 * where the live edge resumes — never a queue that grows without bound, and never a publish that
 * blocks waiting for a slow reader to catch up (`publish` never awaits anything).
 *
 * ## Input is a strict FIFO, one run at a time
 *
 * `attachDriver` gives a session the one function that actually executes a submitted input
 * (`runtime.ts`'s job — not this module's). `submit` enqueues by `clientRef`+text, refusing
 * immediately (never silently) when the session has no driver (`not-driver` — this process does
 * not hold the session's lease), is full (`queue-full`) or has ended (`session-closed`). Inputs run
 * strictly one at a time, in arrival order; a driver that throws is caught so the NEXT input still
 * runs — one bad input must never wedge every input behind it.
 *
 * ## HubAsker lives beside this, not inside it
 *
 * The hub owns the pending-ask REGISTRY (`registerAsk` / `unregisterAsk` / `answer`) because
 * `close()` must be able to cancel every open question uniformly, the same reason it owns the
 * input driver's pending queue. The ask/timeout/signal LOGIC itself is `createHubAsker` below, kept
 * as a thin `PersonAsker` built only from the hub's own public surface — it broadcasts the
 * question, resolves on whichever watcher answers first (a later answer for the same question is
 * refused — `answer` returns `false`), and answers `answered:false` when nobody could ever have
 * seen the question (zero watchers at ask time) — a DENIAL, never an approval, exactly as
 * `contract.ts` requires.
 */

import type { AgentisticsEvent } from '@agentistics/core'
import type { PersonAnswer, PersonAsker, PersonQuestion } from '../tools/contract.ts'
import type {
  AckFrame,
  AskOutcome,
  GapFrame,
  InputRefusalCode,
  OutboundFrame,
  SequencedOutboundFrame,
} from './protocol.ts'
import { isSequencedFrame } from './protocol.ts'

// ── public shapes ────────────────────────────────────────────────────────────────────────────────

/** What `publish` accepts — the CONTENT of a sequenced frame; the hub assigns the `seq`. */
export type HubPublishItem =
  | { kind: 'event'; event: AgentisticsEvent }
  | { kind: 'delta'; runId?: string; text: string }
  | { kind: 'ask'; question: PersonQuestion }
  | { kind: 'ask-closed'; questionId: string; outcome: AskOutcome }

export interface WatchOptions {
  /** Resume from just after this seq: replay from the ring when it is still held, else a `gap`
   *  followed by whatever the ring still has. Absent: join at the live edge, nothing replayed. */
  fromSeq?: number
}

/** One watcher's live view of a session. Iterate it with `for await`; call `close()` exactly once
 *  when you are done (an early `break`/`return` out of a `for await` calls it for you). */
export interface SessionWatcher extends AsyncIterable<OutboundFrame> {
  readonly sessionId: string
  close(): void
}

export interface SubmitInput {
  clientRef: string
  text: string
}

export interface AttachDriverOptions {
  /** How many inputs may be queued (not counting the one currently running). Default 16. */
  capacity?: number
}

export interface SessionHub {
  /** Broadcast one sequenced item to every current watcher of `sessionId`, assigning it the next
   *  `seq` and storing it in the replay ring. Returns the assigned seq. Never blocks. */
  publish(sessionId: string, item: HubPublishItem): number

  /** Attach as a watcher of `sessionId`. Never throws; a session over its watcher ceiling returns a
   *  watcher that is already closed, with the reason named in words on its one `closed` frame. */
  watch(sessionId: string, opts?: WatchOptions): SessionWatcher

  /** How many watchers `sessionId` currently has (0 for an untracked session). */
  watcherCount(sessionId: string): number

  /** How many sessions this hub is currently tracking. */
  sessionCount(): number

  /** Give `sessionId` the function that actually runs a submitted input. Replaces any previous
   *  driver for this session (the ordinary case: a process re-acquiring a lease it just took). */
  attachDriver(sessionId: string, drive: (text: string) => Promise<void>, opts?: AttachDriverOptions): void

  /** Remove `sessionId`'s driver. Inputs already running finish; nothing new is dequeued. Anything
   *  still WAITING in the queue is refused (`not-driver`), the same as if none had ever been attached. */
  detachDriver(sessionId: string): void

  /** Enqueue one input. Returns synchronously — the same value that is also broadcast as an `ack`
   *  frame to every watcher, per §5 ("every surface sees it"). */
  submit(sessionId: string, input: SubmitInput): AckFrame

  /** Register the resolver for one open question. Internal to an asker implementation
   *  (`createHubAsker`); exposed because the hub, not the asker, must be able to cancel it on
   *  `close()`. Overwrites a previous registration under the same id, if any. */
  registerAsk(sessionId: string, questionId: string, resolver: AskResolver): void

  /** Remove a pending ask's registration without resolving it — the timeout/cancel paths call this
   *  themselves (they already know the outcome and drive the resolver directly). A no-op if the id
   *  is not pending (already answered, already closed). */
  unregisterAsk(sessionId: string, questionId: string): void

  /** Deliver an answer to the FIRST pending question named `questionId` in `sessionId`. Returns
   *  whether it was accepted — `false` when nothing is pending under that id (already answered,
   *  already timed out, already cancelled, or the id names nothing this session ever asked). */
  answer(sessionId: string, questionId: string, ans: { choice?: number; text?: string }): boolean

  /** End `sessionId`: every watcher gets one `closed` frame and its iteration ends; every pending
   *  ask resolves `cancelled`; every input still waiting in the queue is refused `session-closed`.
   *  A watcher that attaches AFTER `close` still gets any replayable history followed by `closed`. */
  close(sessionId: string, reason: string): void
}

/** What a pending ask's registered resolver is called with. `answer` is present only for
 *  `'answered'`. */
export type AskResolver = (outcome: AskOutcome, answer?: { choice?: number; text?: string }) => void

export interface SessionHubOptions {
  /** Per-session replay ring depth — how many sequenced frames a reconnecting watcher can catch up
   *  on. Default 512. */
  ringSize?: number
  /** Per-watcher queue depth before a slow reader is told it missed frames. Default 256. Clamped to
   *  at least 3: an overflow needs room for a still-undelivered `hello`, the `gap` marker, and the
   *  frame that follows it (see `enqueueToWatcher`) — a cap below 3 cannot express the guarantee
   *  this module makes for a watcher that has not yet read even its handshake. */
  watcherQueueSize?: number
  /** Ceiling on tracked sessions. Default 1000. When exceeded, the LEAST recently active session
   *  that has ENDED and has NO watchers is evicted (LRU) to make room. If no such session exists —
   *  every tracked session is either still open or still watched — the ceiling is exceeded rather
   *  than losing live fan-out for a session that is, by definition, still in use: a soft ceiling
   *  that is occasionally exceeded is a smaller defect than dropping an active session's watchers. */
  maxSessions?: number
  /** Ceiling on watchers per session. Default 32. */
  maxWatchersPerSession?: number
  /** Injected clock, for LRU bookkeeping in tests. */
  now?: () => number
}

const DEFAULT_RING_SIZE = 512
const DEFAULT_WATCHER_QUEUE_SIZE = 256
const DEFAULT_MAX_SESSIONS = 1000
const DEFAULT_MAX_WATCHERS_PER_SESSION = 32
const MIN_WATCHER_QUEUE_SIZE = 3

// ── internal state ──────────────────────────────────────────────────────────────────────────────

interface RingItem {
  seq: number
  frame: SequencedOutboundFrame
}

interface PendingResolveWaiter {
  resolve: (r: IteratorResult<OutboundFrame>) => void
}

interface WatcherState {
  id: number
  queue: OutboundFrame[]
  waiter: PendingResolveWaiter | null
  /** Set once a `closed` frame has been enqueued for this watcher — no further frames are accepted
   *  (queueing behind a terminal frame would never be delivered anyway: the consumer stops reading
   *  once it sees `closed`). */
  terminal: boolean
}

interface DriverState {
  drive: (text: string) => Promise<void>
  capacity: number
  pending: Array<{ inputSeq: number; clientRef: string; text: string }>
  running: boolean
  nextInputSeq: number
}

interface SessionEntry {
  seq: number
  ring: RingItem[]
  watchers: Map<number, WatcherState>
  ended: boolean
  endedReason: string | null
  lastActivity: number
  driver: DriverState | null
  pendingAsks: Map<string, AskResolver>
}

let nextWatcherId = 1

export function createSessionHub(opts?: SessionHubOptions): SessionHub {
  const ringSize = opts?.ringSize ?? DEFAULT_RING_SIZE
  const watcherQueueSize = Math.max(MIN_WATCHER_QUEUE_SIZE, opts?.watcherQueueSize ?? DEFAULT_WATCHER_QUEUE_SIZE)
  const maxSessions = opts?.maxSessions ?? DEFAULT_MAX_SESSIONS
  const maxWatchersPerSession = opts?.maxWatchersPerSession ?? DEFAULT_MAX_WATCHERS_PER_SESSION
  const now = opts?.now ?? (() => Date.now())

  const sessions = new Map<string, SessionEntry>()

  function newEntry(): SessionEntry {
    return {
      seq: 0,
      ring: [],
      watchers: new Map(),
      ended: false,
      endedReason: null,
      lastActivity: now(),
      driver: null,
      pendingAsks: new Map(),
    }
  }

  /** Pick the least-recently-active session that has ended and has no watchers — the only kind of
   *  entry it is ever safe to drop without losing something a watcher or a driver still depends on. */
  function evictionCandidate(): string | null {
    let bestId: string | null = null
    let bestActivity = Infinity
    for (const [id, entry] of sessions) {
      if (!entry.ended || entry.watchers.size > 0) continue
      if (entry.lastActivity < bestActivity) {
        bestActivity = entry.lastActivity
        bestId = id
      }
    }
    return bestId
  }

  function getOrCreate(sessionId: string): SessionEntry {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    if (sessions.size >= maxSessions) {
      const victim = evictionCandidate()
      if (victim !== null) sessions.delete(victim)
      // else: no evictable candidate — exceed the ceiling rather than drop a live session (see
      // SessionHubOptions.maxSessions doc).
    }
    const entry = newEntry()
    sessions.set(sessionId, entry)
    return entry
  }

  function seqOf(frame: OutboundFrame): number | undefined {
    return isSequencedFrame(frame) ? frame.seq : undefined
  }

  /** Deliver `frame` to one watcher, respecting its bounded queue. On overflow the backlog is
   *  dropped and replaced with one `gap` frame naming exactly how many were lost, then `frame`
   *  itself is delivered right after it — "exactly one gap, then live" (§5), never a queue that
   *  grows past its cap.
   *
   *  Two things must survive a clear, or repeated overflow (a watcher that never reads through an
   *  entire burst) silently under-reports: an undelivered `hello` — a watcher's one-time protocol
   *  handshake, never re-sent, so it is kept and never counted as missed — and an EXISTING `gap`
   *  already sitting in the queue from a PRIOR overflow. Dropping that prior gap and starting a
   *  fresh count at each subsequent overflow would report only the last few missed frames instead
   *  of the true total (measured while writing this: 9 events published with no read in between,
   *  cap 3, reported `missed: 2` instead of 9, because every later overflow re-cleared the earlier
   *  gap along with everything else). So an existing gap is MERGED into: its `missed` grows by
   *  whatever else is being dropped this time, and `resumeAt` moves to the new resume point —
   *  "exactly one gap frame" holds across the whole burst, not just the last overflow. */
  function enqueueToWatcher(w: WatcherState, frame: OutboundFrame, liveSeq: number): void {
    if (w.terminal) return
    if (w.queue.length >= watcherQueueSize) {
      const hello = w.queue.find((f) => f.kind === 'hello')
      const existingGap = w.queue.find((f): f is GapFrame => f.kind === 'gap')
      const resumeAt = seqOf(frame) ?? liveSeq
      const kept = (hello ? 1 : 0) + (existingGap ? 1 : 0)
      const newlyDropped = w.queue.length - kept
      const gap: GapFrame = existingGap
        ? { kind: 'gap', missed: existingGap.missed + newlyDropped, resumeAt }
        : { kind: 'gap', missed: newlyDropped, resumeAt }
      w.queue = hello ? [hello, gap] : [gap]
    }
    deliverOrQueue(w, frame)
    if (frame.kind === 'closed') w.terminal = true
  }

  function deliverOrQueue(w: WatcherState, frame: OutboundFrame): void {
    if (w.waiter) {
      const waiter = w.waiter
      w.waiter = null
      waiter.resolve({ value: frame, done: false })
      return
    }
    w.queue.push(frame)
  }

  function broadcast(entry: SessionEntry, frame: OutboundFrame): void {
    const liveSeq = entry.seq
    for (const w of entry.watchers.values()) enqueueToWatcher(w, frame, liveSeq)
  }

  function toSequencedFrame(seq: number, item: HubPublishItem): SequencedOutboundFrame {
    switch (item.kind) {
      case 'event':
        return { kind: 'event', seq, event: item.event }
      case 'delta':
        return item.runId !== undefined
          ? { kind: 'delta', seq, runId: item.runId, text: item.text }
          : { kind: 'delta', seq, text: item.text }
      case 'ask':
        return { kind: 'ask', seq, question: item.question }
      case 'ask-closed':
        return { kind: 'ask-closed', seq, questionId: item.questionId, outcome: item.outcome }
    }
  }

  function publish(sessionId: string, item: HubPublishItem): number {
    const entry = getOrCreate(sessionId)
    entry.seq += 1
    const seq = entry.seq
    const frame = toSequencedFrame(seq, item)
    entry.ring.push({ seq, frame })
    if (entry.ring.length > ringSize) entry.ring.shift()
    entry.lastActivity = now()
    broadcast(entry, frame)
    return seq
  }

  function makeWatcher(sessionId: string, entry: SessionEntry, w: WatcherState): SessionWatcher {
    let detached = false

    function detach(): void {
      if (detached) return
      detached = true
      entry.watchers.delete(w.id)
      if (w.waiter) {
        const waiter = w.waiter
        w.waiter = null
        waiter.resolve({ value: undefined, done: true })
      }
    }

    const iterator: AsyncIterator<OutboundFrame> = {
      next(): Promise<IteratorResult<OutboundFrame>> {
        if (w.queue.length > 0) {
          const value = w.queue.shift() as OutboundFrame
          return Promise.resolve({ value, done: false })
        }
        // The queue is drained. `detached` (the CONSUMER left) and `w.terminal` (the HUB delivered
        // its one `closed` frame and will never push another) both mean nothing further is ever
        // coming — a `for await` must end here, not hang on a waiter nothing will ever resolve.
        if (detached || w.terminal) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          w.waiter = { resolve }
        })
      },
      return(): Promise<IteratorResult<OutboundFrame>> {
        detach()
        return Promise.resolve({ value: undefined, done: true })
      },
    }

    return {
      sessionId,
      close: detach,
      [Symbol.asyncIterator]() {
        return iterator
      },
    }
  }

  /** A watcher over its session's own ceiling: return one already-closed instead of throwing or
   *  silently widening the cap — the same "refused in a sentence, never merely absent" rule the
   *  rest of this codebase applies to every other ceiling. */
  function refusedWatcher(sessionId: string, reason: string): SessionWatcher {
    const frame: OutboundFrame = { kind: 'closed', reason }
    let delivered = false
    const iterator: AsyncIterator<OutboundFrame> = {
      next(): Promise<IteratorResult<OutboundFrame>> {
        if (!delivered) {
          delivered = true
          return Promise.resolve({ value: frame, done: false })
        }
        return Promise.resolve({ value: undefined, done: true })
      },
      return(): Promise<IteratorResult<OutboundFrame>> {
        delivered = true
        return Promise.resolve({ value: undefined, done: true })
      },
    }
    return {
      sessionId,
      close() {},
      [Symbol.asyncIterator]() {
        return iterator
      },
    }
  }

  function watch(sessionId: string, opts?: WatchOptions): SessionWatcher {
    const entry = getOrCreate(sessionId)
    if (entry.watchers.size >= maxWatchersPerSession) {
      return refusedWatcher(sessionId, 'too many watchers are already attached to this session')
    }

    const w: WatcherState = { id: nextWatcherId++, queue: [], waiter: null, terminal: false }
    entry.watchers.set(w.id, w)
    entry.lastActivity = now()

    const fromSeq = opts?.fromSeq
    const oldestRetained = entry.ring.length > 0 ? (entry.ring[0] as RingItem).seq : entry.seq + 1

    let cursor: number
    const seed: OutboundFrame[] = []

    if (fromSeq === undefined) {
      cursor = entry.seq
    } else if (fromSeq >= entry.seq) {
      cursor = entry.seq
    } else if (entry.ring.length > 0 && fromSeq >= oldestRetained - 1) {
      cursor = fromSeq
      for (const item of entry.ring) if (item.seq > fromSeq) seed.push(item.frame)
    } else {
      const resumeAt = entry.ring.length > 0 ? oldestRetained : entry.seq + 1
      const missed = resumeAt - 1 - fromSeq
      seed.push({ kind: 'gap', missed, resumeAt })
      cursor = fromSeq
      for (const item of entry.ring) seed.push(item.frame)
    }

    seed.unshift({ kind: 'hello', sessionId, cursor, protocol: 1 })
    if (entry.ended) seed.push({ kind: 'closed', reason: entry.endedReason ?? 'this session has ended' })

    for (const frame of seed) enqueueToWatcher(w, frame, entry.seq)

    return makeWatcher(sessionId, entry, w)
  }

  function watcherCount(sessionId: string): number {
    return sessions.get(sessionId)?.watchers.size ?? 0
  }

  function sessionCount(): number {
    return sessions.size
  }

  function pump(sessionId: string, entry: SessionEntry): void {
    const driver = entry.driver
    if (!driver || driver.running) return
    const next = driver.pending.shift()
    if (!next) return
    driver.running = true
    void Promise.resolve()
      .then(() => driver.drive(next.text))
      .catch(() => {
        // A throwing driver must not stop the queue — the next input still runs (§5).
      })
      .finally(() => {
        driver.running = false
        pump(sessionId, entry)
      })
  }

  function attachDriver(sessionId: string, drive: (text: string) => Promise<void>, opts2?: AttachDriverOptions): void {
    const entry = getOrCreate(sessionId)
    entry.driver = { drive, capacity: opts2?.capacity ?? 16, pending: [], running: false, nextInputSeq: 1 }
  }

  function detachDriver(sessionId: string): void {
    const entry = sessions.get(sessionId)
    if (!entry || !entry.driver) return
    refuseAllPending(entry, 'not-driver')
    entry.driver = null
  }

  function refuseAllPending(entry: SessionEntry, code: InputRefusalCode): void {
    const driver = entry.driver
    if (!driver) return
    const pending = driver.pending
    driver.pending = []
    for (const p of pending) {
      const ack = refusalAck(p.clientRef, code)
      broadcast(entry, ack)
    }
  }

  function refusalSentence(code: InputRefusalCode): string {
    switch (code) {
      case 'queue-full':
        return 'Too many inputs are already queued for this session — try again shortly.'
      case 'session-closed':
        return 'This session has ended and can no longer accept input.'
      case 'not-driver':
        return 'This session is not being driven by this process right now.'
    }
  }

  function refusalAck(clientRef: string, code: InputRefusalCode): AckFrame {
    return { kind: 'ack', clientRef, status: 'refused', code, sentence: refusalSentence(code) }
  }

  function submit(sessionId: string, input: SubmitInput): AckFrame {
    const entry = getOrCreate(sessionId)
    if (entry.ended) {
      const ack = refusalAck(input.clientRef, 'session-closed')
      broadcast(entry, ack)
      return ack
    }
    const driver = entry.driver
    if (!driver) {
      const ack = refusalAck(input.clientRef, 'not-driver')
      broadcast(entry, ack)
      return ack
    }
    if (driver.pending.length >= driver.capacity) {
      const ack = refusalAck(input.clientRef, 'queue-full')
      broadcast(entry, ack)
      return ack
    }
    const inputSeq = driver.nextInputSeq++
    driver.pending.push({ inputSeq, clientRef: input.clientRef, text: input.text })
    entry.lastActivity = now()
    const ack: AckFrame = { kind: 'ack', inputSeq, clientRef: input.clientRef, status: 'queued' }
    broadcast(entry, ack)
    pump(sessionId, entry)
    return ack
  }

  function registerAsk(sessionId: string, questionId: string, resolver: AskResolver): void {
    const entry = getOrCreate(sessionId)
    entry.pendingAsks.set(questionId, resolver)
  }

  function unregisterAsk(sessionId: string, questionId: string): void {
    sessions.get(sessionId)?.pendingAsks.delete(questionId)
  }

  function answer(sessionId: string, questionId: string, ans: { choice?: number; text?: string }): boolean {
    const entry = sessions.get(sessionId)
    const resolver = entry?.pendingAsks.get(questionId)
    if (!resolver) return false
    resolver('answered', ans)
    return true
  }

  function close(sessionId: string, reason: string): void {
    const entry = sessions.get(sessionId)
    if (!entry || entry.ended) return
    entry.ended = true
    entry.endedReason = reason
    entry.lastActivity = now()

    for (const resolver of [...entry.pendingAsks.values()]) resolver('cancelled')
    entry.pendingAsks.clear()

    refuseAllPending(entry, 'session-closed')
    entry.driver = null

    broadcast(entry, { kind: 'closed', reason })
  }

  return {
    publish,
    watch,
    watcherCount,
    sessionCount,
    attachDriver,
    detachDriver,
    submit,
    registerAsk,
    unregisterAsk,
    answer,
    close,
  }
}

// ── HubAsker ────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000

export interface HubAskerOptions {
  /** Default 10 minutes. */
  timeoutMs?: number
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (h: ReturnType<typeof setTimeout>) => void
}

/**
 * A `PersonAsker` that broadcasts to every watcher of one session and resolves on whichever
 * answers first. Built ONLY from `SessionHub`'s public surface, so it needs no access to the
 * hub's internals beyond `publish` / `watcherCount` / `registerAsk` / `unregisterAsk` — `answer`
 * is called by whoever relayed a watcher's `answer` frame, not by this function itself.
 */
export function createHubAsker(hub: SessionHub, sessionId: string, opts?: HubAskerOptions): PersonAsker {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS
  const setTv = opts?.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTv = opts?.clearTimeout ?? ((h: ReturnType<typeof setTimeout>) => clearTimeout(h))

  return {
    ask(question: PersonQuestion, signal?: AbortSignal): Promise<PersonAnswer> {
      if (hub.watcherCount(sessionId) === 0) {
        return Promise.resolve({ answered: false, reason: 'unavailable' })
      }
      if (signal?.aborted) {
        return Promise.resolve({ answered: false, reason: 'cancelled' })
      }

      return new Promise<PersonAnswer>((resolve) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let onAbort: (() => void) | undefined

        function finish(outcome: AskOutcome, answer?: { choice?: number; text?: string }): void {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTv(timer)
          if (onAbort && signal) signal.removeEventListener('abort', onAbort)
          hub.unregisterAsk(sessionId, question.id)
          hub.publish(sessionId, { kind: 'ask-closed', questionId: question.id, outcome })
          resolve(
            outcome === 'answered'
              ? { answered: true, choice: answer?.choice, text: answer?.text }
              : { answered: false, reason: outcome },
          )
        }

        hub.registerAsk(sessionId, question.id, finish)
        hub.publish(sessionId, { kind: 'ask', question })

        timer = setTv(() => finish('timeout'), timeoutMs)
        if (signal) {
          onAbort = () => finish('cancelled')
          signal.addEventListener('abort', onAbort)
        }
      })
    },
  }
}

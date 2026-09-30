/**
 * event-stream.ts — ONE stream, any number of readers (master spec §24.2, §24.4).
 *
 * A runtime-owned hub: a single producer publishes, every subscriber gets its own `AsyncIterable`.
 * The fan-out rule is `terminal-hub.ts`'s, applied to events: **cost is per watched entity, never
 * per watcher** — the source (a model stream, say) is pulled by ONE loop (`pipe`), however many
 * readers are watching, and each reader holds only its own bounded queue.
 *
 * What this module guarantees, and the decisions behind each:
 *
 *  - **BOUNDED.** Every subscriber's queue holds at most `bufferLimit` deliveries
 *    (`STREAM_BUFFER_LIMIT` by default). A stalled reader costs that many entries and never more;
 *    everything else it is owed is O(1) state on the subscription (a missed counter, an end reason).
 *
 *  - **OVERFLOW POLICY: ephemeral events are dropped and COUNTED, record events are kept.** The hub
 *    is generic, so which events are ephemeral is a parameter (`droppable`). When a subscriber's
 *    queue is full:
 *      - a DROPPABLE event is not queued; the subscriber's missed counter goes up, and before the
 *        next event it receives (or when it drains) it is handed ONE `lagged` marker carrying the
 *        exact number it missed. A gap is never silent.
 *      - a RECORD event (non-droppable — for a provider stream, `started`, `tool-call`,
 *        `tool-call-failed`, `end`) is never dropped to make room for itself. The queue is first
 *        COMPACTED: every run of droppable events already queued is folded into one `lagged`
 *        marker at the same position, so ordering and the missed count both stay exact. Only when
 *        the queue is full of records and markers even after compaction — a reader stalled so long
 *        that more records than the whole buffer piled up — is the subscriber DETACHED, and it
 *        receives an `ended` delivery with reason `detached-stalled` after what it had queued. A
 *        detach is stated, never a silent loss.
 *    Why drop rather than block: one stalled reader (a closed laptop lid, a paused terminal) must
 *    not stall every other reader nor the model stream itself. Deltas exist for people watching
 *    live; the record of what happened is the terminal event, which is exactly what is kept.
 *
 *  - **BACKPRESSURE, with a grace period.** `publish()` resolves once every subscriber that is
 *    keeping up has room. A subscriber that is still full after `stallGraceMs` is marked LAGGING and
 *    stops holding the producer back until it has fully drained — so a slow-but-alive reader slows
 *    the producer down (no drops), while a stalled one costs the producer one grace period, once,
 *    and then takes the overflow policy above. `offer()` is the non-waiting variant.
 *
 *  - **LATE SUBSCRIBERS get future events only, plus a bounded replay of ONE event**: the most
 *    recent event matching `retain` (for a provider stream, the terminal `end`). A reader that joins
 *    after the outcome still learns it; a reader never receives a backlog of deltas it did not
 *    watch. Subscribing to a hub that has already ended yields the retained event and then ends.
 *
 *  - **Iteration never throws.** `return()` on the iterator (breaking out of a `for await`) frees
 *    its queue immediately; `close()` ends every iterator after it drains; a source that throws in
 *    `pipe` ends every iterator with an `ended` delivery of reason `source-failed` — no error text
 *    is carried (it can hold anything the source saw).
 */

/** Default per-subscriber queue ceiling. Large enough that a reader rendering to a terminal or a
 *  socket never overflows on a normal model answer (a response of a few thousand tokens arrives as
 *  a few hundred deltas), small enough that a stalled reader costs a few hundred small objects —
 *  a ceiling, not a timer (the `SHELL_CAP` rationale, master spec §24.4). */
export const STREAM_BUFFER_LIMIT = 256

/** How long a full subscriber may hold the producer back before it is treated as stalled. Long
 *  enough to absorb a reader's hiccup (a GC pause, a slow write), short enough that a model stream
 *  is never visibly held by a reader nobody is looking at. */
export const STREAM_STALL_GRACE_MS = 250

/** What a subscriber receives. */
export type StreamDelivery<E> =
  | { kind: 'event'; event: E }
  /** `missed` droppable events were not delivered at this point in the sequence. */
  | { kind: 'lagged'; missed: number }
  /** The stream ended abnormally for this reader; always the last delivery. */
  | { kind: 'ended'; reason: StreamEndReason }

export type StreamEndReason = 'source-failed' | 'detached-stalled'

export interface EventStreamOptions<E> {
  /** Which events may be dropped (and counted) when a reader falls behind. Absent = none may. */
  droppable?: (event: E) => boolean
  /** Which events are retained for late subscribers (the latest match only). Absent = none. */
  retain?: (event: E) => boolean
  /** Per-subscriber queue ceiling; default `STREAM_BUFFER_LIMIT`. Minimum 2 (a marker + an event). */
  bufferLimit?: number
  /** Default `STREAM_STALL_GRACE_MS`. */
  stallGraceMs?: number
}

export interface StreamSubscription<E> extends AsyncIterableIterator<StreamDelivery<E>> {
  /** Deliveries currently queued for this reader — never more than the buffer limit. */
  buffered(): number
  /** Total droppable events this reader has missed so far (delivered or pending as `lagged`). */
  missed(): number
}

export interface EventStream<E> {
  subscribe(): StreamSubscription<E>
  /** Deliver now, never waiting: the overflow policy applies to any full reader. */
  offer(event: E): void
  /** Wait until every reader that is keeping up has room (bounded by the stall grace), then offer. */
  publish(event: E): Promise<void>
  /** Pull `source` to its end through `publish`, then close; a throwing source fails the hub. */
  pipe(source: AsyncIterable<E>): Promise<void>
  /** Normal end: every reader ends after draining what it has queued. Idempotent. */
  close(): void
  /** Abnormal end: every reader receives `ended: source-failed` after its queue. Idempotent. */
  fail(): void
  subscriberCount(): number
  isClosed(): boolean
}

type Waiter<T> = (value: T) => void

interface Sub<E> {
  queue: StreamDelivery<E>[]
  /** droppable events missed since the last marker was queued */
  pendingMissed: number
  totalMissed: number
  /** set once no further event will be accepted; delivered after the queue (null = normal end) */
  ending: { reason: StreamEndReason | null } | null
  /** excluded from backpressure until it drains completely */
  lagging: boolean
  done: boolean
  pull: Waiter<IteratorResult<StreamDelivery<E>>> | null
  room: Waiter<void>[]
}

export function createEventStream<E>(opts: EventStreamOptions<E> = {}): EventStream<E> {
  const droppable = opts.droppable ?? (() => false)
  const retain = opts.retain
  const limit = Math.max(2, opts.bufferLimit ?? STREAM_BUFFER_LIMIT)
  const grace = Math.max(0, opts.stallGraceMs ?? STREAM_STALL_GRACE_MS)

  const subs = new Set<Sub<E>>()
  let retained: E | undefined
  let hasRetained = false
  let ended: { reason: StreamEndReason | null } | null = null

  const wakeRoom = (s: Sub<E>): void => {
    const waiters = s.room
    s.room = []
    for (const w of waiters) w()
  }

  /** The next delivery for a reader, or null when there is nothing yet. Marks done at the end. */
  const nextFor = (s: Sub<E>): StreamDelivery<E> | null | 'done' => {
    const head = s.queue.shift()
    if (head !== undefined) {
      if (s.queue.length < limit) wakeRoom(s)
      if (s.queue.length === 0 && s.pendingMissed === 0) s.lagging = false
      return head
    }
    if (s.pendingMissed > 0) {
      const missed = s.pendingMissed
      s.pendingMissed = 0
      s.lagging = false
      return { kind: 'lagged', missed }
    }
    if (s.ending) {
      const reason = s.ending.reason
      s.ending = { reason: null }
      if (reason !== null) return { kind: 'ended', reason }
      s.done = true
      return 'done'
    }
    return null
  }

  const flush = (s: Sub<E>): void => {
    if (!s.pull) return
    const next = nextFor(s)
    if (next === null) return
    const resolve = s.pull
    s.pull = null
    if (next === 'done') { finish(s); resolve({ value: undefined, done: true }) }
    else resolve({ value: next, done: false })
  }

  const finish = (s: Sub<E>): void => {
    s.done = true
    s.queue = []
    s.pendingMissed = 0
    subs.delete(s)
    wakeRoom(s)
  }

  /** Fold every run of droppable events (and adjacent markers) into one `lagged` marker. */
  const compact = (s: Sub<E>): void => {
    const out: StreamDelivery<E>[] = []
    let run = 0
    for (const d of s.queue) {
      if (d.kind === 'lagged') { run += d.missed; continue }
      if (d.kind === 'event' && droppable(d.event)) { run += 1; s.totalMissed += 1; continue }
      if (run > 0) { out.push({ kind: 'lagged', missed: run }); run = 0 }
      out.push(d)
    }
    if (run > 0) out.push({ kind: 'lagged', missed: run })
    s.queue = out
  }

  const deliver = (s: Sub<E>, event: E): void => {
    if (s.done || s.ending) return
    const needed = () => 1 + (s.pendingMissed > 0 ? 1 : 0)
    const push = (): void => {
      if (s.pendingMissed > 0) {
        s.queue.push({ kind: 'lagged', missed: s.pendingMissed })
        s.pendingMissed = 0
      }
      s.queue.push({ kind: 'event', event })
    }
    if (s.queue.length + needed() <= limit) { push(); flush(s); return }
    if (droppable(event)) {
      s.pendingMissed += 1
      s.totalMissed += 1
      s.lagging = true
      return
    }
    compact(s)
    // A trailing marker in the queue and a pending count would be two markers for one gap.
    const tail = s.queue[s.queue.length - 1]
    if (tail?.kind === 'lagged' && s.pendingMissed > 0) { tail.missed += s.pendingMissed; s.pendingMissed = 0 }
    if (s.queue.length + needed() <= limit) { push(); flush(s); return }
    s.ending = { reason: 'detached-stalled' }
    s.lagging = true
    wakeRoom(s)
    flush(s)
  }

  const subscribe = (): StreamSubscription<E> => {
    const s: Sub<E> = {
      queue: [], pendingMissed: 0, totalMissed: 0, ending: null, lagging: false, done: false, pull: null, room: [],
    }
    if (hasRetained) s.queue.push({ kind: 'event', event: retained as E })
    if (ended) s.ending = { reason: ended.reason }
    subs.add(s)

    const it: StreamSubscription<E> = {
      next(): Promise<IteratorResult<StreamDelivery<E>>> {
        if (s.done) return Promise.resolve({ value: undefined, done: true })
        if (s.pull) {
          // A second concurrent next() is not a pattern for-await produces; answer it as done
          // rather than orphaning the first waiter.
          return Promise.resolve({ value: undefined, done: true })
        }
        const next = nextFor(s)
        if (next === 'done') { finish(s); return Promise.resolve({ value: undefined, done: true }) }
        if (next !== null) return Promise.resolve({ value: next, done: false })
        return new Promise(resolve => { s.pull = resolve })
      },
      return(): Promise<IteratorResult<StreamDelivery<E>>> {
        const pending = s.pull
        s.pull = null
        finish(s)
        pending?.({ value: undefined, done: true })
        return Promise.resolve({ value: undefined, done: true })
      },
      [Symbol.asyncIterator]() { return it },
      buffered: () => s.queue.length,
      missed: () => s.totalMissed,
    }
    return it
  }

  const offer = (event: E): void => {
    if (ended) return
    if (retain?.(event)) { retained = event; hasRetained = true }
    for (const s of [...subs]) deliver(s, event)
  }

  /** Resolves when `s` has room, or after the grace — then `s` is lagging until it drains. */
  const awaitRoom = (s: Sub<E>): Promise<void> => new Promise(resolve => {
    let settled = false
    const done = (): void => { if (!settled) { settled = true; clearTimeout(timer); resolve() } }
    const timer = setTimeout(() => { if (!settled) { s.lagging = true; done() } }, grace)
    s.room.push(done)
  })

  const publish = async (event: E): Promise<void> => {
    if (ended) return
    const full = [...subs].filter(s => !s.done && !s.ending && !s.lagging && s.queue.length >= limit)
    if (full.length > 0) await Promise.all(full.map(awaitRoom))
    offer(event)
  }

  const end = (reason: StreamEndReason | null): void => {
    if (ended) return
    ended = { reason }
    for (const s of [...subs]) {
      if (s.done) continue
      if (!s.ending) s.ending = { reason }
      wakeRoom(s)
      flush(s)
    }
  }

  const pipe = async (source: AsyncIterable<E>): Promise<void> => {
    try {
      for await (const event of source) {
        if (ended) break
        await publish(event)
      }
      end(null)
    } catch {
      end('source-failed')
    }
  }

  return {
    subscribe,
    offer,
    publish,
    pipe,
    close: () => end(null),
    fail: () => end('source-failed'),
    subscriberCount: () => subs.size,
    isClosed: () => ended !== null,
  }
}

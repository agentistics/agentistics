import { describe, expect, test } from 'bun:test'
import { createHubAsker, createSessionHub, type SessionWatcher } from './hub.ts'
import type { AckFrame, OutboundFrame } from './protocol.ts'
import type { PersonQuestion } from '../tools/contract.ts'

// ── test helpers ────────────────────────────────────────────────────────────────────────────────

/** Drain exactly `n` frames from a watcher. Never call this with more frames than the test knows
 *  are actually queued — the watcher's `next()` blocks (a pending promise) when its queue is
 *  empty, which would hang the test rather than fail it. */
async function take(w: SessionWatcher, n: number): Promise<OutboundFrame[]> {
  const it = w[Symbol.asyncIterator]()
  const out: OutboundFrame[] = []
  for (let i = 0; i < n; i++) {
    const r = await it.next()
    if (r.done) break
    out.push(r.value)
  }
  return out
}

/** Proves the NEGATIVE — "nothing more has arrived" — without risking a hang: races the next
 *  frame against a short real timer. */
async function nextOrNone(w: SessionWatcher, ms = 20): Promise<OutboundFrame | 'none'> {
  const it = w[Symbol.asyncIterator]()
  return Promise.race([
    it.next().then((r) => (r.done ? ('none' as const) : r.value)),
    new Promise<'none'>((resolve) => setTimeout(() => resolve('none'), ms)),
  ])
}

/** Flushes pending microtasks (and one macrotask turn) — used after `submit`/`ask` calls whose
 *  effects (the driver actually running, the `ask` frame actually publishing) are scheduled a
 *  turn later, never to simulate a real wait. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Manually-driven timers — so a 10-minute default ask timeout is provoked instantly and
 *  deterministically, never by actually waiting. */
function fakeTimers() {
  type Entry = { id: number; fn: () => void }
  let nextId = 1
  const pending = new Map<number, Entry>()
  return {
    setTimeout: (fn: () => void, _ms: number) => {
      const id = nextId++
      pending.set(id, { id, fn })
      return id as unknown as ReturnType<typeof globalThis.setTimeout>
    },
    clearTimeout: (h: unknown) => {
      pending.delete(h as number)
    },
    fireAll: () => {
      const toFire = [...pending.values()]
      pending.clear()
      for (const e of toFire) e.fn()
    },
  }
}

function question(id: string): PersonQuestion {
  return { id, kind: 'question', text: 'pick one', options: [{ label: 'a' }, { label: 'b' }] }
}

/** A settable "resolve this pending drive" cell. Plain `let release: (() => void) | null = null`
 *  reassigned only from inside a Promise executor type-checks as `never` at the call site — a real
 *  TypeScript narrowing quirk (confirmed against a minimal repro), not a mistake in the logic — so
 *  the indirection through an object property is the fix, not a workaround for a bug of ours. */
function releaseBox(): { release: (() => void) | null } {
  return { release: null }
}

// ── publish / watch / replay ────────────────────────────────────────────────────────────────────

describe('publish + watch', () => {
  test('two watchers of the same session see identical seq streams', async () => {
    const hub = createSessionHub()
    const w1 = hub.watch('s1')
    const w2 = hub.watch('s1')

    const seqA = hub.publish('s1', { kind: 'delta', text: 'a' })
    const seqB = hub.publish('s1', { kind: 'delta', text: 'b' })
    expect(typeof seqA).toBe('number') // publish returns synchronously — never a Promise, never blocks
    expect(seqB).toBe(seqA + 1)

    const f1 = await take(w1, 3) // hello, delta a, delta b
    const f2 = await take(w2, 3)
    expect(f1).toEqual(f2)
    expect(f1.map((f) => f.kind)).toEqual(['hello', 'delta', 'delta'])
  })

  test('publish is O(watchers): fan-out reaches every watcher, none miss a frame the others get', async () => {
    const hub = createSessionHub()
    const watchers = Array.from({ length: 5 }, () => hub.watch('s1'))
    hub.publish('s1', { kind: 'delta', text: 'x' })
    const all = await Promise.all(watchers.map((w) => take(w, 2))) // hello, delta
    for (const frames of all) expect(frames.map((f) => f.kind)).toEqual(['hello', 'delta'])
  })

  test('a late watcher replays from a cursor when the ring still holds it', async () => {
    const hub = createSessionHub()
    const seq1 = hub.publish('s1', { kind: 'delta', text: 'a' })
    hub.publish('s1', { kind: 'delta', text: 'b' })
    hub.publish('s1', { kind: 'delta', text: 'c' })

    const w = hub.watch('s1', { fromSeq: seq1 })
    const frames = await take(w, 3) // hello, then only what came AFTER seq1: b, c
    expect(frames[0]?.kind).toBe('hello')
    expect(frames.slice(1).map((f) => (f as { text: string }).text)).toEqual(['b', 'c'])
    // nothing else pending — 'a' was correctly NOT replayed (the watcher already had it)
    expect(await nextOrNone(w)).toBe('none')
  })

  test('a watcher whose fromSeq predates the ring gets a gap naming exactly what fell out, then what remains', async () => {
    const hub = createSessionHub({ ringSize: 2 })
    hub.publish('s1', { kind: 'delta', text: 'a' }) // seq 1, will be evicted
    hub.publish('s1', { kind: 'delta', text: 'b' }) // seq 2, will be evicted
    hub.publish('s1', { kind: 'delta', text: 'c' }) // seq 3 — ring now holds [b? no: holds c,? ] ringSize=2 keeps last 2
    hub.publish('s1', { kind: 'delta', text: 'd' }) // seq 4 — ring holds [c(3), d(4)]

    const w = hub.watch('s1', { fromSeq: 1 }) // asks to resume after seq 1 — seq 2 is gone
    const frames = await take(w, 3) // hello, gap, then whatever the ring still has (c, d) — but we only pull 3
    expect(frames[0]?.kind).toBe('hello')
    expect(frames[1]?.kind).toBe('gap')
    expect((frames[1] as { missed: number }).missed).toBe(1) // exactly seq 2 fell out
    expect((frames[2] as { text: string }).text).toBe('c')
    const last = await take(w, 1)
    expect((last[0] as { text: string })?.text).toBe('d')
  })

  test('a session over its watcher ceiling refuses a new watcher with a closed frame naming why', async () => {
    const hub = createSessionHub({ maxWatchersPerSession: 1 })
    hub.watch('s1')
    const refused = hub.watch('s1')
    const frames = await take(refused, 1)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.kind).toBe('closed')
  })
})

// ── slow-watcher overflow ───────────────────────────────────────────────────────────────────────

describe('slow watcher overflow', () => {
  test('exactly one gap frame carrying the TRUE accumulated count, then live — queue never exceeds its cap', async () => {
    const CAP = 3
    const hub = createSessionHub({ watcherQueueSize: CAP })
    const w = hub.watch('s1')
    const N = 50
    for (let i = 1; i <= N; i++) {
      const seq = hub.publish('s1', { kind: 'delta', text: `d${i}` })
      expect(typeof seq).toBe('number') // never returns a promise — publish never blocks on a slow reader
    }

    // The watcher never read anything during the whole burst, so at most CAP frames can possibly
    // be sitting in its queue: hello, one merged gap, and the single most recent delta.
    const frames = await take(w, CAP)
    expect(frames.map((f) => f.kind)).toEqual(['hello', 'gap', 'delta'])
    expect((frames[1] as { missed: number }).missed).toBe(N - 1) // every delta but the last one
    expect((frames[2] as { text: string }).text).toBe(`d${N}`)
    expect(await nextOrNone(w)).toBe('none') // proves nothing beyond CAP was ever buffered
  })

  test('a watcher that keeps reading never sees a gap at all', async () => {
    const hub = createSessionHub({ watcherQueueSize: 3 })
    const w = hub.watch('s1')
    await take(w, 1) // consume hello
    for (let i = 1; i <= 20; i++) {
      hub.publish('s1', { kind: 'delta', text: `d${i}` })
      const frame = await take(w, 1)
      expect(frame[0]?.kind).toBe('delta')
      expect((frame[0] as { text: string }).text).toBe(`d${i}`)
    }
  })
})

// ── input FIFO ──────────────────────────────────────────────────────────────────────────────────

describe('input FIFO', () => {
  test('strict FIFO order, one ack per input, refused on queue-full', async () => {
    const hub = createSessionHub()
    const started: string[] = []
    const finished: string[] = []
    const box = releaseBox()

    hub.attachDriver(
      's1',
      (text) =>
        new Promise<void>((resolve) => {
          started.push(text)
          box.release = () => {
            finished.push(text)
            resolve()
          }
        }),
      { capacity: 1 },
    )

    const ack1 = hub.submit('s1', { clientRef: 'c1', text: 'a' })
    expect(ack1).toEqual({ kind: 'ack', inputSeq: 1, clientRef: 'c1', status: 'queued' })
    await flush()
    expect(started).toEqual(['a'])

    const ack2 = hub.submit('s1', { clientRef: 'c2', text: 'b' }) // capacity 1: fits behind the running one
    expect(ack2).toEqual({ kind: 'ack', inputSeq: 2, clientRef: 'c2', status: 'queued' })

    const ack3 = hub.submit('s1', { clientRef: 'c3', text: 'c' }) // capacity now exhausted
    expect(ack3.kind).toBe('ack')
    expect(ack3.status).toBe('refused')
    expect(ack3.code).toBe('queue-full')
    expect(typeof ack3.sentence).toBe('string')

    box.release?.()
    await flush()
    await flush()
    expect(started).toEqual(['a', 'b']) // b only starts after a finishes — never overlapping
    expect(finished).toEqual(['a'])

    box.release?.()
    await flush()
    expect(finished).toEqual(['a', 'b'])
  })

  test('every ack is also broadcast to every watcher', async () => {
    const hub = createSessionHub()
    const box = releaseBox()
    hub.attachDriver('s1', () => new Promise<void>((resolve) => { box.release = resolve }))
    const w = hub.watch('s1')
    hub.submit('s1', { clientRef: 'c1', text: 'a' })
    const frames = await take(w, 2) // hello, ack
    expect(frames[1]).toEqual({ kind: 'ack', inputSeq: 1, clientRef: 'c1', status: 'queued' })
    box.release?.()
  })

  test('a driver that throws does not stop the queue — the next input still runs', async () => {
    const hub = createSessionHub()
    const ran: string[] = []
    hub.attachDriver('s1', async (text) => {
      ran.push(text)
      if (text === 'bad') throw new Error('boom')
    })
    hub.submit('s1', { clientRef: 'c1', text: 'bad' })
    hub.submit('s1', { clientRef: 'c2', text: 'good' })
    await flush()
    await flush()
    await flush()
    expect(ran).toEqual(['bad', 'good'])
  })

  test('submit refuses not-driver when no driver is attached', () => {
    const hub = createSessionHub()
    const ack = hub.submit('s1', { clientRef: 'c1', text: 'a' })
    expect(ack.status).toBe('refused')
    expect(ack.code).toBe('not-driver')
  })

  test('detachDriver refuses anything still waiting, and further submits, as not-driver', async () => {
    const hub = createSessionHub()
    const box = releaseBox()
    hub.attachDriver('s1', () => new Promise<void>((resolve) => { box.release = resolve }), { capacity: 2 })
    hub.submit('s1', { clientRef: 'c1', text: 'a' })
    await flush()
    const waiting = hub.submit('s1', { clientRef: 'c2', text: 'b' })
    expect(waiting.status).toBe('queued')

    hub.detachDriver('s1')
    const after = hub.submit('s1', { clientRef: 'c3', text: 'c' })
    expect(after.status).toBe('refused')
    expect(after.code).toBe('not-driver')
    box.release?.()
  })
})

// ── HubAsker ────────────────────────────────────────────────────────────────────────────────────

describe('createHubAsker', () => {
  test('answered:false, reason unavailable — a denial, never an approval — when nobody is watching', async () => {
    const hub = createSessionHub()
    const asker = createHubAsker(hub, 's1')
    const result = await asker.ask(question('q1'))
    expect(result).toEqual({ answered: false, reason: 'unavailable' })
  })

  test('first answer wins; a later answer for the same question is refused', async () => {
    const hub = createSessionHub()
    hub.watch('s1')
    const asker = createHubAsker(hub, 's1')
    const pending = asker.ask(question('q1'))
    await flush()

    expect(hub.answer('s1', 'q1', { choice: 0 })).toBe(true)
    expect(hub.answer('s1', 'q1', { choice: 1 })).toBe(false) // already resolved — refused

    const result = await pending
    expect(result).toEqual({ answered: true, choice: 0, text: undefined })
  })

  test('publishes ask then ask-closed, in that order, visible to a watcher', async () => {
    const hub = createSessionHub()
    const w = hub.watch('s1')
    const asker = createHubAsker(hub, 's1')
    const pending = asker.ask(question('q2'))
    await flush()
    hub.answer('s1', 'q2', { choice: 1 })
    await pending

    const frames = await take(w, 3) // hello, ask, ask-closed
    expect(frames.map((f) => f.kind)).toEqual(['hello', 'ask', 'ask-closed'])
    expect((frames[2] as { outcome: string }).outcome).toBe('answered')
  })

  test('timeout resolves answered:false / reason timeout, driven by an injected timer (never a real wait)', async () => {
    const hub = createSessionHub()
    hub.watch('s1')
    const ft = fakeTimers()
    const asker = createHubAsker(hub, 's1', {
      timeoutMs: 1000,
      setTimeout: ft.setTimeout,
      clearTimeout: ft.clearTimeout,
    })
    const pending = asker.ask(question('q3'))
    await flush()
    ft.fireAll()
    const result = await pending
    expect(result).toEqual({ answered: false, reason: 'timeout' })
  })

  test('an aborted signal cancels the ask and publishes ask-closed with outcome cancelled', async () => {
    const hub = createSessionHub()
    const w = hub.watch('s1')
    const asker = createHubAsker(hub, 's1')
    const controller = new AbortController()
    const pending = asker.ask(question('q4'), controller.signal)
    await flush()
    controller.abort()
    const result = await pending
    expect(result).toEqual({ answered: false, reason: 'cancelled' })

    const frames = await take(w, 3) // hello, ask, ask-closed(cancelled)
    expect(frames.map((f) => f.kind)).toEqual(['hello', 'ask', 'ask-closed'])
    expect((frames[2] as { outcome: string }).outcome).toBe('cancelled')
  })

  test('a pre-aborted signal never even publishes the question', async () => {
    const hub = createSessionHub()
    const w = hub.watch('s1')
    const asker = createHubAsker(hub, 's1')
    const controller = new AbortController()
    controller.abort()
    const result = await asker.ask(question('q5'), controller.signal)
    expect(result).toEqual({ answered: false, reason: 'cancelled' })

    const frames = await take(w, 1) // only hello was ever sent
    expect(frames.map((f) => f.kind)).toEqual(['hello'])
    expect(await nextOrNone(w)).toBe('none')
  })

  test('an answer after the timeout already fired is refused', async () => {
    const hub = createSessionHub()
    hub.watch('s1')
    const ft = fakeTimers()
    const asker = createHubAsker(hub, 's1', { setTimeout: ft.setTimeout, clearTimeout: ft.clearTimeout })
    const pending = asker.ask(question('q6'))
    await flush()
    ft.fireAll()
    await pending
    expect(hub.answer('s1', 'q6', { choice: 0 })).toBe(false)
  })
})

// ── close ───────────────────────────────────────────────────────────────────────────────────────

describe('close', () => {
  test('every watcher gets exactly one closed frame and iteration ends there', async () => {
    const hub = createSessionHub()
    const w = hub.watch('s1')
    hub.close('s1', 'finished')
    const frames = await take(w, 2) // hello, closed
    expect(frames.map((f) => f.kind)).toEqual(['hello', 'closed'])
    expect((frames[1] as { reason: string }).reason).toBe('finished')
    expect(await nextOrNone(w)).toBe('none')
  })

  test('a watcher that attaches AFTER close still gets hello then closed', async () => {
    const hub = createSessionHub()
    const w1 = hub.watch('s1')
    hub.close('s1', 'done working')
    await take(w1, 2)

    const w2 = hub.watch('s1')
    const frames = await take(w2, 2)
    expect(frames.map((f) => f.kind)).toEqual(['hello', 'closed'])
    expect((frames[1] as { reason: string }).reason).toBe('done working')
  })

  test('every pending ask resolves cancelled on close', async () => {
    const hub = createSessionHub()
    hub.watch('s1')
    const asker = createHubAsker(hub, 's1')
    const pending = asker.ask(question('q1'))
    await flush()
    hub.close('s1', 'bye')
    const result = await pending
    expect(result).toEqual({ answered: false, reason: 'cancelled' })
  })

  test('an input still waiting in the queue is refused session-closed, and so is anything submitted after', async () => {
    const hub = createSessionHub()
    hub.attachDriver('s1', () => new Promise<void>(() => {}), { capacity: 2 }) // never resolves
    const w = hub.watch('s1')
    hub.submit('s1', { clientRef: 'c1', text: 'a' }) // starts running
    await flush()
    hub.submit('s1', { clientRef: 'c2', text: 'b' }) // waits behind it
    await flush()

    hub.close('s1', 'stop')

    const frames = await take(w, 5) // hello, ack(c1 queued), ack(c2 queued), ack(c2 refused), closed
    const acks = frames.filter((f): f is AckFrame => f.kind === 'ack')
    const c2Refusal = acks.find((a) => a.clientRef === 'c2' && a.status === 'refused')
    expect(c2Refusal?.code).toBe('session-closed')
    expect(frames.at(-1)?.kind).toBe('closed')

    const afterClose = hub.submit('s1', { clientRef: 'c3', text: 'c' })
    expect(afterClose.status).toBe('refused')
    expect(afterClose.code).toBe('session-closed')
  })

  test('closing twice is a no-op the second time', () => {
    const hub = createSessionHub()
    hub.watch('s1')
    hub.close('s1', 'first reason')
    hub.close('s1', 'second reason') // must not overwrite the recorded reason or re-broadcast
    expect(hub.watcherCount('s1')).toBe(1) // the watcher was never detached by close()
  })
})

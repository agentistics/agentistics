import { describe, expect, test } from 'bun:test'
import { createEventStream, STREAM_BUFFER_LIMIT, type StreamDelivery } from './event-stream.ts'

type Ev = { kind: 'delta'; n: number } | { kind: 'record'; n: number } | { kind: 'end' }

const droppable = (e: Ev) => e.kind === 'delta'
const retain = (e: Ev) => e.kind === 'end'

async function drain<E>(it: AsyncIterable<StreamDelivery<E>>): Promise<StreamDelivery<E>[]> {
  const out: StreamDelivery<E>[] = []
  for await (const d of it) out.push(d)
  return out
}

async function* source(events: Ev[]): AsyncIterable<Ev> {
  for (const e of events) yield e
}

describe('createEventStream — fan-out', () => {
  test('N readers receive identical, ordered events from ONE pull of the source', async () => {
    const hub = createEventStream<Ev>({ droppable, retain })
    const readers = [hub.subscribe(), hub.subscribe(), hub.subscribe()]
    let pulled = 0
    async function* counted(): AsyncIterable<Ev> {
      for (let n = 0; n < 50; n++) { pulled++; yield { kind: 'delta', n } }
      pulled++; yield { kind: 'end' }
    }
    const results = Promise.all(readers.map(drain))
    await hub.pipe(counted())
    const all = await results
    expect(pulled).toBe(51)
    const expected: StreamDelivery<Ev>[] = [
      ...Array.from({ length: 50 }, (_, n) => ({ kind: 'event' as const, event: { kind: 'delta' as const, n } })),
      { kind: 'event', event: { kind: 'end' } },
    ]
    for (const got of all) expect(got).toEqual(expected)
  })
})

describe('createEventStream — bounded', () => {
  test('a reader that never reads stays within the bound across 100k events', () => {
    const hub = createEventStream<Ev>({ droppable, retain })
    const stalled = hub.subscribe()
    let max = 0
    for (let n = 0; n < 100_000; n++) {
      hub.offer({ kind: 'delta', n })
      if (stalled.buffered() > max) max = stalled.buffered()
    }
    expect(max).toBeLessThanOrEqual(STREAM_BUFFER_LIMIT)
    expect(stalled.buffered()).toBeLessThanOrEqual(STREAM_BUFFER_LIMIT)
    expect(stalled.missed()).toBe(100_000 - STREAM_BUFFER_LIMIT)
  })

  test('the lagged marker count is exact and sits where the gap is', async () => {
    const hub = createEventStream<Ev>({ droppable, bufferLimit: 4 })
    const r = hub.subscribe()
    for (let n = 0; n < 10; n++) hub.offer({ kind: 'delta', n })
    hub.close()
    const got = await drain(r)
    expect(got).toEqual([
      { kind: 'event', event: { kind: 'delta', n: 0 } },
      { kind: 'event', event: { kind: 'delta', n: 1 } },
      { kind: 'event', event: { kind: 'delta', n: 2 } },
      { kind: 'event', event: { kind: 'delta', n: 3 } },
      { kind: 'lagged', missed: 6 },
    ])
    const missed = got.reduce((s, d) => s + (d.kind === 'lagged' ? d.missed : 0), 0)
    const delivered = got.filter(d => d.kind === 'event').length
    expect(missed + delivered).toBe(10)
  })

  test('a marker precedes the next event a lagging reader accepts once it drained', async () => {
    const hub = createEventStream<Ev>({ droppable, bufferLimit: 3 })
    const r = hub.subscribe()
    for (let n = 0; n < 5; n++) hub.offer({ kind: 'delta', n }) // 0,1,2 queued; 3,4 missed
    const first = await r.next(); const second = await r.next(); const third = await r.next()
    expect([first.value, second.value, third.value].map(d => d?.kind === 'event' && d.event.kind === 'delta' ? d.event.n : null))
      .toEqual([0, 1, 2])
    hub.offer({ kind: 'delta', n: 5 })
    hub.close()
    expect(await drain(r)).toEqual([
      { kind: 'lagged', missed: 2 },
      { kind: 'event', event: { kind: 'delta', n: 5 } },
    ])
  })
})

describe('createEventStream — records are never dropped', () => {
  test('a terminal event reaches a stalled reader, with the gap before it counted', async () => {
    const hub = createEventStream<Ev>({ droppable, retain, bufferLimit: 8 })
    const r = hub.subscribe()
    for (let n = 0; n < 1000; n++) hub.offer({ kind: 'delta', n })
    hub.offer({ kind: 'end' })
    hub.close()
    const got = await drain(r)
    expect(got[got.length - 1]).toEqual({ kind: 'event', event: { kind: 'end' } })
    expect(got.length).toBeLessThanOrEqual(8)
    const missed = got.reduce((s, d) => s + (d.kind === 'lagged' ? d.missed : 0), 0)
    const deltas = got.filter(d => d.kind === 'event' && d.event.kind === 'delta').length
    expect(missed + deltas).toBe(1000)
  })

  test('records interleaved with overflowing deltas keep their order and the count stays exact', async () => {
    // Each record costs its slot plus one marker for the gap before it: 4 records fit in 10.
    const hub = createEventStream<Ev>({ droppable, bufferLimit: 10 })
    const r = hub.subscribe()
    for (let i = 0; i < 4; i++) {
      for (let n = 0; n < 20; n++) hub.offer({ kind: 'delta', n: i * 100 + n })
      hub.offer({ kind: 'record', n: i })
      expect(r.buffered()).toBeLessThanOrEqual(10)
    }
    hub.close()
    const got = await drain(r)
    const records = got.flatMap(d => d.kind === 'event' && d.event.kind === 'record' ? [d.event.n] : [])
    expect(records).toEqual([0, 1, 2, 3])
    const missed = got.reduce((s, d) => s + (d.kind === 'lagged' ? d.missed : 0), 0)
    const deltas = got.filter(d => d.kind === 'event' && d.event.kind === 'delta').length
    expect(missed + deltas).toBe(80)
  })

  test('a reader buried under more records than the buffer holds is DETACHED in words', async () => {
    const hub = createEventStream<Ev>({ droppable, bufferLimit: 4 })
    const r = hub.subscribe()
    const other = hub.subscribe()
    const kept: StreamDelivery<Ev>[] = []
    for (let n = 0; n < 10; n++) {
      hub.offer({ kind: 'record', n })
      expect(r.buffered()).toBeLessThanOrEqual(4)
      kept.push((await other.next()).value!) // this reader keeps up
    }
    hub.close()
    const got = await drain(r)
    expect(got.map(d => d.kind === 'event' && d.event.kind === 'record' ? d.event.n : d.kind))
      .toEqual([0, 1, 2, 3, 'ended'])
    expect(got[got.length - 1]).toEqual({ kind: 'ended', reason: 'detached-stalled' })
    expect(r.buffered()).toBe(0)
    expect(hub.subscriberCount()).toBe(1)
    // the reader that kept up got everything, and was never detached
    expect(kept.filter(d => d.kind === 'event')).toHaveLength(10)
    expect(await drain(other)).toEqual([])
  })
})

describe('createEventStream — backpressure', () => {
  test('publish waits for a slow reader instead of dropping, then continues', async () => {
    const hub = createEventStream<Ev>({ droppable, bufferLimit: 2, stallGraceMs: 10_000 })
    const r = hub.subscribe()
    const received: number[] = []
    const reader = (async () => {
      for await (const d of r) {
        if (d.kind === 'event' && d.event.kind === 'delta') received.push(d.event.n)
        await new Promise(res => setTimeout(res, 1))
      }
    })()
    await hub.pipe(source(Array.from({ length: 20 }, (_, n) => ({ kind: 'delta' as const, n }))))
    await reader
    expect(received).toEqual(Array.from({ length: 20 }, (_, n) => n))
    expect(r.missed()).toBe(0)
  })

  test('a stalled reader holds the producer for one grace period at most, then lags', async () => {
    const hub = createEventStream<Ev>({ droppable, retain, bufferLimit: 2, stallGraceMs: 20 })
    const stalled = hub.subscribe()
    const live = hub.subscribe()
    const liveDone = drain(live)
    const events: Ev[] = [...Array.from({ length: 200 }, (_, n) => ({ kind: 'delta' as const, n })), { kind: 'end' }]
    const t0 = performance.now()
    await hub.pipe(source(events))
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(1000)
    expect((await liveDone).filter(d => d.kind === 'event')).toHaveLength(201)
    const got = await drain(stalled)
    expect(got[got.length - 1]).toEqual({ kind: 'event', event: { kind: 'end' } })
  })
})

describe('createEventStream — lifecycle', () => {
  test('return() (break) frees the reader immediately and the others keep going', async () => {
    const hub = createEventStream<Ev>({ droppable })
    const a = hub.subscribe()
    const b = hub.subscribe()
    for (let n = 0; n < 10; n++) hub.offer({ kind: 'delta', n })
    expect(hub.subscriberCount()).toBe(2)
    for await (const _ of a) break
    expect(a.buffered()).toBe(0)
    expect(hub.subscriberCount()).toBe(1)
    hub.offer({ kind: 'delta', n: 10 })
    hub.close()
    expect((await drain(b)).length).toBe(11)
    expect(await a.next()).toEqual({ value: undefined, done: true })
  })

  test('return() while a read is pending resolves it as done', async () => {
    const hub = createEventStream<Ev>()
    const a = hub.subscribe()
    const pending = a.next()
    await a.return!()
    expect(await pending).toEqual({ value: undefined, done: true })
    expect(hub.subscriberCount()).toBe(0)
  })

  test('close ends a waiting reader', async () => {
    const hub = createEventStream<Ev>()
    const a = hub.subscribe()
    const pending = a.next()
    hub.close()
    expect(await pending).toEqual({ value: undefined, done: true })
  })

  test('a throwing source ends every reader with a marker — iteration never throws', async () => {
    const hub = createEventStream<Ev>({ droppable })
    const a = hub.subscribe()
    const b = hub.subscribe()
    async function* bad(): AsyncIterable<Ev> {
      yield { kind: 'delta', n: 1 }
      throw new Error('socket reset: secret conversation text')
    }
    const done = Promise.all([drain(a), drain(b)])
    await hub.pipe(bad())
    for (const got of await done) {
      expect(got).toEqual([
        { kind: 'event', event: { kind: 'delta', n: 1 } },
        { kind: 'ended', reason: 'source-failed' },
      ])
      expect(JSON.stringify(got)).not.toContain('secret')
    }
  })

  test('a late subscriber gets only future events — no backlog of deltas', async () => {
    const hub = createEventStream<Ev>({ droppable, retain })
    const early = hub.subscribe()
    const earlyDone = drain(early)
    hub.offer({ kind: 'delta', n: 1 })
    hub.offer({ kind: 'delta', n: 2 })
    const late = hub.subscribe()
    hub.offer({ kind: 'delta', n: 3 })
    hub.offer({ kind: 'end' })
    hub.close()
    expect((await drain(late)).map(d => d.kind === 'event' ? d.event : d)).toEqual([
      { kind: 'delta', n: 3 }, { kind: 'end' },
    ])
    expect(await earlyDone).toHaveLength(4)
  })

  test('a subscriber after the end still learns the outcome (one retained event), then ends', async () => {
    const hub = createEventStream<Ev>({ droppable, retain })
    await hub.pipe(source([{ kind: 'delta', n: 1 }, { kind: 'end' }]))
    expect(hub.isClosed()).toBe(true)
    expect(await drain(hub.subscribe())).toEqual([{ kind: 'event', event: { kind: 'end' } }])
  })

  test('a subscriber after a failure learns the failure', async () => {
    const hub = createEventStream<Ev>()
    hub.fail()
    expect(await drain(hub.subscribe())).toEqual([{ kind: 'ended', reason: 'source-failed' }])
  })

  test('offer and publish after close are ignored', async () => {
    const hub = createEventStream<Ev>()
    const a = hub.subscribe()
    hub.close()
    hub.offer({ kind: 'delta', n: 1 })
    await hub.publish({ kind: 'delta', n: 2 })
    expect(await drain(a)).toEqual([])
  })
})

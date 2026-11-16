/**
 * NAVEGADOR S4c — a DIRECT SSE viewer whose client vanished without a clean close must not hold a viewer
 * (and with it the 15-min auto-lock) forever. The mux path (`bounded: false`) is unchanged.
 */
import { describe, expect, test } from 'bun:test'
import { openSseStream, streamBoundsFor } from './browser-stream-web'
import type { ScreencastHub, ScreenSink, Subscription } from './browser-screencast'

function fakeHub() {
  const st = { open: 0, closed: 0, sink: null as ScreenSink | null }
  const hub: ScreencastHub = {
    subscribe: async (_k, _t, sink): Promise<Subscription> => { st.open++; st.sink = sink; return { close: () => { st.closed++ }, drained: () => {} } },
    browserGone: () => {}, viewport: () => null, loops: () => 0, readers: () => st.open - st.closed,
  }
  return { hub, st }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('direct SSE liveness bounds', () => {
  test('a client that never reads (socket dead, no abort) is dropped after N stalled keepalives', async () => {
    const { hub, st } = fakeHub()
    const ac = new AbortController()
    openSseStream(hub, 'k', null, ac.signal, { bounded: true, keepaliveMs: 10, stallKeepalives: 3, lifetimeMs: 60_000 })
    await sleep(15)
    expect(st.open).toBe(1)
    await sleep(120)
    expect(st.closed).toBe(1) // the viewer was released with no abort
  })

  test('a reader that keeps draining is NOT dropped by the stall rule', async () => {
    const { hub, st } = fakeHub()
    const ac = new AbortController()
    const body = openSseStream(hub, 'k', null, ac.signal, { bounded: true, keepaliveMs: 10, stallKeepalives: 3, lifetimeMs: 60_000 })
    const r = body.getReader()
    const t0 = Date.now()
    while (Date.now() - t0 < 150) await Promise.race([r.read(), sleep(20)])
    expect(st.closed).toBe(0)
    ac.abort()
    await sleep(5)
    expect(st.closed).toBe(1)
  })

  test('a lifetime cap ends even a healthy direct stream (the client reconnects)', async () => {
    const { hub, st } = fakeHub()
    const ac = new AbortController()
    const body = openSseStream(hub, 'k', null, ac.signal, { bounded: true, keepaliveMs: 10, stallKeepalives: 3, lifetimeMs: 60 })
    const r = body.getReader()
    let done = false
    const t0 = Date.now()
    while (!done && Date.now() - t0 < 500) { const x = await Promise.race([r.read(), sleep(20).then(() => null)]); if (x?.done) done = true }
    expect(done).toBe(true)
    expect(st.closed).toBe(1)
  })

  test('the mux path (bounded: false) has neither bound', async () => {
    const { hub, st } = fakeHub()
    const ac = new AbortController()
    openSseStream(hub, 'k', null, ac.signal, { bounded: false, keepaliveMs: 10, stallKeepalives: 3, lifetimeMs: 30 })
    await sleep(150)
    expect(st.closed).toBe(0)
    ac.abort()
  })

  test('which path gets which bounds: a mux replay is unbounded, a direct request is bounded', () => {
    expect(streamBoundsFor(true).bounded).toBe(false)
    expect(streamBoundsFor(false).bounded).toBe(true)
  })
})

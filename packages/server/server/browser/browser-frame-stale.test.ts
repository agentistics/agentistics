/**
 * NAVEGADOR S5c r4 — a frame of an OLD size is never painted.
 *
 * Measured (S5cr4-trace-probe.log, 2026-11-16): right after the viewport changed Chromium sent a first frame
 * whose JPEG was 718x400 while its metadata said 1596x400; a still page sent nothing after it and the card kept
 * the wrong-size picture (black bars). And a late viewer used to be handed `loop.lastFrame`, a picture taken
 * before the resize the very same subscribe call had just made.
 */
import { describe, expect, test } from 'bun:test'
import { createViewportCast } from './browser-viewport'
import { isStaleFrame, jpegDims } from './browser-frame-check'
import {
  createScreencastHub, MAX_STALE_KICKS, STALE_KICK_DELAY_MS,
  type CastFrame, type RawCastFrame, type ScreenSink,
} from './browser-screencast'

/** A minimal JPEG (SOI + SOF0 header) of the given pixel size, base64. */
export function fakeJpeg(w: number, h: number): string {
  const b = Buffer.alloc(40)
  b[0] = 0xff; b[1] = 0xd8
  b[2] = 0xff; b[3] = 0xc0; b.writeUInt16BE(17, 4); b[6] = 8; b.writeUInt16BE(h, 7); b.writeUInt16BE(w, 9)
  return b.toString('base64')
}

describe('jpegDims / isStaleFrame', () => {
  test('reads the SOF size', () => {
    expect(jpegDims(fakeJpeg(1596, 400))).toEqual({ w: 1596, h: 400 })
    expect(jpegDims('not a jpeg at all, just text here')).toBeNull()
  })
  test('an aspect that is not the page one is stale; the same aspect scaled down is not', () => {
    expect(isStaleFrame({ jpeg: { w: 718, h: 400 }, meta: { w: 1596, h: 400 } })).toBe(true)
    expect(isStaleFrame({ jpeg: { w: 1596, h: 400 }, meta: { w: 1596, h: 400 } })).toBe(false)
    expect(isStaleFrame({ jpeg: { w: 798, h: 200 }, meta: { w: 1596, h: 400 } })).toBe(false)
  })
  test('a frame whose metadata is not the viewport the cast applied is stale', () => {
    expect(isStaleFrame({ jpeg: { w: 1314, h: 400 }, meta: { w: 1314, h: 400 }, expected: { w: 1596, h: 400 } })).toBe(true)
    expect(isStaleFrame({ jpeg: { w: 1596, h: 400 }, meta: { w: 1596, h: 400 }, expected: { w: 1596, h: 400 } })).toBe(false)
  })
  test('what cannot be told is not stale', () => {
    expect(isStaleFrame({ jpeg: null, meta: { w: 1596, h: 400 } })).toBe(false)
    expect(isStaleFrame({ jpeg: { w: 10, h: 10 }, meta: { w: 0, h: 0 } })).toBe(false)
  })
})

function clock() {
  let now = 1_000_000
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>()
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { const t = ++id; timers.set(t, { at: now + ms, fn }); return t },
    clearTimeout: (t: unknown) => { timers.delete(t as number) },
    setInterval: (fn: () => void, ms: number) => { const t = ++id; timers.set(t, { at: now + ms, fn, every: ms }); return t },
    clearInterval: (t: unknown) => { timers.delete(t as number) },
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [tid, t] = due
        now = Math.max(now, t.at)
        if (t.every) t.at = now + t.every
        else timers.delete(tid)
        t.fn()
      }
      now = end
    },
  }
}

/** A hub over a REAL `createViewportCast` (so `viewport()` follows asks), with a scripted CDP. */
function fixture() {
  const c = clock()
  const sent: Array<[string, Record<string, unknown>]> = []
  let emit: (f: RawCastFrame) => void = () => {}
  let sid = 0
  const hub = createScreencastHub({
    start: async (_k, _t, onFrame, size) => {
      emit = onFrame
      const cast = createViewportCast(async (m, p) => { sent.push([m, p]) })
      await cast.start(size)
      return { ok: true, ack: () => {}, stop: async () => { await cast.stop() }, resize: v => cast.resize(v), viewport: () => cast.current() }
    },
    state: (_k, tab) => ({ tab, lock: 'none', url: 'http://x/', title: 'X', loading: false, tabs: [{ id: tab, title: 'X', active: true }], lastAction: null, activeTab: tab }),
    activeTab: () => 'T1',
    viewer: () => {},
    now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, setInterval: c.setInterval, clearInterval: c.clearInterval,
  })
  const raw = (metaW: number, metaH: number, jpegW = metaW, jpegH = metaH) => { sid++; emit({ data: fakeJpeg(jpegW, jpegH), sessionId: sid, metadata: { deviceWidth: metaW, deviceHeight: metaH } }) }
  const sink = () => {
    const frames: CastFrame[] = []
    const s: ScreenSink = { frame: f => { frames.push(f); return true }, state: () => {}, gone: () => {} }
    return { s, frames }
  }
  const resizes = () => sent.filter(([m]) => m === 'Emulation.setDeviceMetricsOverride').length
  return { hub, c, raw, sink, sent, resizes }
}
const tick = () => new Promise(r => setTimeout(r, 0))
const V = (width: number, height: number) => ({ width, height, deviceScaleFactor: 1 })

describe('the hub never delivers a frame of an old size', () => {
  for (const [width, height] of [[818, 205], [348, 148], [318, 148], [348, 192]]) {
    test(`r5: two-tab surface ${width}x${height} rejects the previous size and paints its own`, async () => {
      const f = fixture(), a = f.sink(), b = f.sink()
      const old = await f.hub.subscribe('k', 'T1', a.s, V(818, 249))
      f.raw(1314, 400); f.c.advance(100); old.close()
      await f.hub.subscribe('k', 'T2', b.s, V(width!, height!))
      f.raw(1314, 400); f.c.advance(100)
      expect(b.frames).toHaveLength(0)
      const size = f.sent.filter(([m]) => m === 'Emulation.setDeviceMetricsOverride').at(-1)![1]
      f.raw(Number(size.width), Number(size.height)); f.c.advance(100)
      expect(b.frames).toHaveLength(1)
      expect(b.frames[0]).toMatchObject({ w: size.width, h: size.height })
    })
  }
  test('r5: a raw startup frame is validated even before the cast is returned', async () => {
    const c = clock(), frames: CastFrame[] = []
    const hub = createScreencastHub({
      ...c, activeTab: () => 'T1', state: () => null, viewer: () => {},
      start: async (_k, _t, emit) => {
        emit({ data: fakeJpeg(1024, 652), sessionId: 1, metadata: { deviceWidth: 1024, deviceHeight: 652 } })
        expect(frames).toHaveLength(0)
        return { ok: true, ack: () => {}, stop: async () => {}, resize: async () => {}, viewport: () => ({ w: 1024, h: 435 }) }
      },
    })
    await hub.subscribe('k', 'T1', { frame: f => { frames.push(f); return true }, state: () => {}, gone: () => {} }, V(348, 148))
    expect(frames).toHaveLength(0)
  })
  test('r5: reconnects and tab switches never reuse an epoch/seq pair', async () => {
    const f = fixture()
    const a = f.sink(), b = f.sink(), c = f.sink()
    const sub = await f.hub.subscribe('k', 'T1', a.s, V(350, 223))
    f.raw(1024, 652); f.c.advance(100)
    sub.close()
    const next = await f.hub.subscribe('k', 'T2', b.s, V(348, 148))
    f.raw(1024, 435); f.c.advance(100)
    next.close()
    await f.hub.subscribe('k', 'T1', c.s, V(348, 148))
    f.raw(1024, 435); f.c.advance(100)
    const frames = [...a.frames, ...b.frames, ...c.frames]
    expect(frames).toHaveLength(3)
    expect(new Set(frames.map(x => `${x.epoch}:${x.seq}`)).size).toBe(3)
  })
  test('r5: after the fast retry budget, a silent page is re-requested with backoff and recovers', async () => {
    const f = fixture(), a = f.sink()
    const sub = await f.hub.subscribe('k', 'T1', a.s, V(818, 205))
    for (let i = 0; i < MAX_STALE_KICKS; i++) { f.raw(1596, 400, 718, 400); f.c.advance(STALE_KICK_DELAY_MS + 100); await tick() }
    const before = f.resizes()
    f.c.advance(6000); await tick()
    expect(f.resizes()).toBeGreaterThan(before)
    f.raw(1596, 400); f.c.advance(100)
    expect(a.frames).toHaveLength(1)
    sub.close()
    const stopped = f.resizes()
    f.c.advance(30000); await tick()
    expect(f.resizes()).toBe(stopped)
  })
  test('two tabs, page opened at 1280: the 718x400 first frame is dropped, the cast re-asked, the right frame painted', async () => {
    const f = fixture()
    const a = f.sink()
    await f.hub.subscribe('k', 'T1', a.s, V(818, 205)) // clamps to 1596x400
    f.raw(1596, 400, 718, 400) // the measured stale first frame
    f.c.advance(100)
    expect(a.frames).toHaveLength(0)
    const before = f.resizes()
    f.c.advance(STALE_KICK_DELAY_MS + 1)
    await tick()
    expect(f.resizes()).toBe(before + 1) // re-asked: override + startScreencast again
    f.raw(1596, 400)
    f.c.advance(100)
    expect(a.frames.map(x => `${x.w}x${x.h}`)).toEqual(['1596x400'])
  })

  test('the fast re-ask budget is bounded: a page that only renders stale frames backs off', async () => {
    const f = fixture()
    const a = f.sink()
    await f.hub.subscribe('k', 'T1', a.s, V(818, 205))
    const before = f.resizes()
    for (let i = 0; i < MAX_STALE_KICKS + 4; i++) {
      f.raw(1596, 400, 718, 400)
      f.c.advance(STALE_KICK_DELAY_MS + 100)
      await tick()
    }
    expect(f.resizes() - before).toBe(MAX_STALE_KICKS)
    expect(a.frames).toHaveLength(0)
  })

  test('a good frame resets the budget', async () => {
    const f = fixture()
    const a = f.sink()
    await f.hub.subscribe('k', 'T1', a.s, V(818, 205))
    for (let i = 0; i < MAX_STALE_KICKS; i++) { f.raw(1596, 400, 718, 400); f.c.advance(STALE_KICK_DELAY_MS + 100); await tick() }
    f.raw(1596, 400); f.c.advance(100)
    const before = f.resizes()
    f.raw(1596, 400, 718, 400); f.c.advance(STALE_KICK_DELAY_MS + 100); await tick()
    expect(f.resizes() - before).toBe(1)
  })

  test('a late viewer with ANOTHER size is never handed the frame taken before its resize', async () => {
    const f = fixture()
    const a = f.sink(), b = f.sink()
    await f.hub.subscribe('k', 'T1', a.s, V(818, 249)) // 1314x400
    f.raw(1314, 400); f.c.advance(100)
    expect(a.frames.map(x => `${x.w}x${x.h}`)).toEqual(['1314x400'])
    await f.hub.subscribe('k', 'T1', b.s, V(818, 205)) // resizes the page to 1596x400
    expect(b.frames).toHaveLength(0) // no replay of the 1314x400 picture
    f.raw(1596, 400); f.c.advance(100)
    expect(b.frames.map(x => `${x.w}x${x.h}`)).toEqual(['1596x400'])
  })

  test('a frame of the previous size that was in flight across the resize is dropped, and epochs only grow', async () => {
    const f = fixture()
    const a = f.sink(), b = f.sink()
    await f.hub.subscribe('k', 'T1', a.s, V(818, 249))
    f.raw(1314, 400); f.c.advance(100)
    await f.hub.subscribe('k', 'T1', b.s, V(818, 205))
    f.raw(1314, 400) // old size still arriving after the new viewport was asked
    f.c.advance(100)
    expect(b.frames).toHaveLength(0)
    f.raw(1596, 400); f.c.advance(100)
    const e0 = a.frames[0]!.epoch, e1 = b.frames[0]!.epoch
    expect(e1).toBeGreaterThan(e0)
  })

  test('a viewer with no size (nothing overridden) is never judged against a viewport', async () => {
    const f = fixture()
    const a = f.sink()
    await f.hub.subscribe('k', 'T1', a.s)
    f.raw(1280, 800); f.c.advance(100)
    expect(a.frames).toHaveLength(1)
  })
})

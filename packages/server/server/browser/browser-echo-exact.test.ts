/**
 * NAVEGADOR.FLUIDEZ-NITIDEZ (adopted from the r2 re-QA): try to break the "byte-exact echo" rule. The screen must always end on the
 * page as it is (or a sharp picture of it), never on an older picture.
 */
import { expect, test } from 'bun:test'
import {
  createScreencastHub, SHARP_ECHO_MS, STILL_MS, FRAME_INTERVAL_MS,
  type CastFrame, type RawCastFrame, type ScreenSink,
} from './browser-screencast'
import type { ViewerViewport } from './browser-viewport'

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
const tick = () => new Promise(r => setTimeout(r, 0))

/** A minimal JPEG header (SOF0) so jpegDims reads w x h; the tag makes the bytes unique. */
function fakeJpeg(w: number, h: number, tag: string): string {
  const b = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])
  return Buffer.concat([b, Buffer.from(tag)]).toString('base64')
}

async function rig(opts: { sharp?: () => Promise<string | null>; resizable?: boolean } = {}) {
  const c = clock()
  let emit: (f: RawCastFrame) => void = () => {}
  let vp: { w: number; h: number } | null = { w: 1280, h: 800 }
  let sharps = 0
  const hub = createScreencastHub({
    start: async (_k, _t, onFrame) => {
      emit = onFrame
      return {
        ok: true, ack: () => {}, stop: async () => {},
        sharp: () => { sharps++; return (opts.sharp ?? (async () => 'SHARP'))() },
        ...(opts.resizable ? { resize: async (v: ViewerViewport) => { vp = { w: v.width, h: v.height } }, viewport: () => vp } : {}),
      }
    },
    state: (_k, tab) => ({ tab, lock: 'locked', url: 'u', title: 't', loading: false, tabs: [{ id: tab, title: 't', active: true }], lastAction: null, activeTab: tab }),
    activeTab: () => 'T1',
    viewer: () => {},
    now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, setInterval: c.setInterval, clearInterval: c.clearInterval,
  })
  const frames: CastFrame[] = []
  const s: ScreenSink = { frame: f => { frames.push(f); return true }, state: () => {}, gone: () => {} }
  const sub = await hub.subscribe('k', 'T1', s)
  let n = 0
  const raw = (data: string, w = 1280, h = 800) => { n++; emit({ data, sessionId: n, metadata: { deviceWidth: w, deviceHeight: h } }) }
  const settle = async () => { c.advance(10_000); await tick(); c.advance(10_000); await tick() }
  return { c, hub, frames, raw, sub, settle, sharps: () => sharps }
}

const last = (fs: CastFrame[]) => fs.at(-1)!.jpeg

test('REQA toggle back to an EARLIER picture right after the sharp frame (A, sharp, B, A) ends on A', async () => {
  let page = 'A'
  const r = await rig({ sharp: async () => `SHARP_OF_${page}` })
  r.raw('A'); r.c.advance(STILL_MS); await tick()
  expect(last(r.frames)).toBe('SHARP_OF_A')
  r.c.advance(50); page = 'B'; r.raw('B')
  r.c.advance(40); page = 'A'; r.raw('A') // the very bytes of the earlier frame: a real change back
  await r.settle()
  expect(['A', 'SHARP_OF_A']).toContain(last(r.frames))
  r.sub.close()
})

test('REQA toggle back while the screenshot is in flight (A, shot…, B, A, shot lands) ends on A', async () => {
  let release: (v: string | null) => void = () => {}
  const r = await rig({ sharp: () => new Promise(res => { release = res }) })
  r.raw('A'); r.c.advance(STILL_MS)
  r.c.advance(10); r.raw('B')
  r.c.advance(FRAME_INTERVAL_MS + 5); r.raw('A')
  release('SHARP_PRE')
  await r.settle()
  expect(['A', 'SHARP']).toContain(last(r.frames).replace('SHARP_PRE', 'X'))
  expect(r.frames.some(f => f.jpeg === 'SHARP_PRE')).toBe(false)
  r.sub.close()
})

test('REQA toggle back inside one delivery slot (B waiting, A again) shows A, never B', async () => {
  const r = await rig()
  r.raw('A'); r.c.advance(1) // A delivered at once
  r.raw('B'); r.raw('A') // B waits for the slot, then the page went back
  await r.settle()
  expect(['A', 'SHARP']).toContain(last(r.frames))
  r.sub.close()
})

test('REQA a page that repaints identically (same bytes every 50 ms) still gets one sharp frame and no extra frames', async () => {
  const r = await rig()
  r.raw('A'); r.c.advance(1)
  for (let i = 0; i < 20; i++) { r.c.advance(50); r.raw('A'); await tick() }
  await r.settle()
  expect(last(r.frames)).toBe('SHARP')
  expect(r.sharps()).toBe(1)
  expect(r.frames.filter(f => !f.sharp).length).toBe(1)
  r.sub.close()
})

test('REQA identical repaints right after a real change do not hide that change', async () => {
  const r = await rig()
  r.raw('A'); r.c.advance(STILL_MS); await tick()
  r.c.advance(30); r.raw('B'); r.raw('B'); r.raw('B')
  await r.settle()
  expect(['B', 'SHARP']).toContain(last(r.frames))
  expect(r.frames.some(f => f.jpeg === 'B')).toBe(true)
  r.sub.close()
})

test('REQA resize while the screenshot is in flight: the old-size shot is never shown, the new frame is', async () => {
  let release: (v: string | null) => void = () => {}
  const r = await rig({ resizable: true, sharp: () => new Promise(res => { release = res }) })
  r.raw(fakeJpeg(1280, 800, 'A'))
  r.c.advance(STILL_MS)
  expect(r.sharps()).toBe(1)
  const s2: CastFrame[] = []
  const sub2 = await r.hub.subscribe('k', 'T1', { frame: f => { s2.push(f); return true }, state: () => {}, gone: () => {} }, { width: 1440, height: 900, deviceScaleFactor: 1 })
  release(fakeJpeg(1280, 800, 'SHARP_OLD'))
  await tick()
  const A2 = fakeJpeg(1440, 900, 'A2')
  r.raw(A2, 1440, 900)
  await r.settle()
  expect(r.frames.some(f => f.jpeg === fakeJpeg(1280, 800, 'SHARP_OLD'))).toBe(false)
  expect(s2.some(f => f.jpeg === A2 || f.sharp)).toBe(true)
  expect(s2.at(-1)!.w).toBe(1440)
  sub2.close(); r.sub.close()
})

test('REQA resize right after the sharp frame (echo window open): the new-size frame is shown, not held', async () => {
  const r = await rig({ resizable: true, sharp: async () => fakeJpeg(2240, 1400, 'SHARP') })
  r.raw(fakeJpeg(1280, 800, 'A'))
  r.c.advance(STILL_MS); await tick()
  expect(r.frames.at(-1)!.sharp).toBe(true)
  r.c.advance(20)
  const s2: CastFrame[] = []
  const sub2 = await r.hub.subscribe('k', 'T1', { frame: f => { s2.push(f); return true }, state: () => {}, gone: () => {} }, { width: 1440, height: 900, deviceScaleFactor: 1 })
  const A2 = fakeJpeg(1440, 900, 'A2')
  r.c.advance(20); r.raw(A2, 1440, 900)
  r.c.advance(FRAME_INTERVAL_MS) // within what the echo window used to be
  expect(s2.some(f => f.jpeg === A2)).toBe(true)
  await r.settle()
  sub2.close(); r.sub.close()
})

// Hypothetical ordering: the screenshot's same-bytes echo arriving AFTER a real frame. Real Chromium decides if it
// can happen (zz-reqa-real.integration.test.ts checks the final pixel); here we only document what the hub does.
test('REQA (ordering probe) a late same-bytes echo after a real change: what ends on screen', async () => {
  const r = await rig()
  r.raw('A'); r.c.advance(STILL_MS); await tick()
  r.c.advance(20); r.raw('B') // real change during the echo window
  r.c.advance(FRAME_INTERVAL_MS + 5); r.raw('A') // a late echo of the old page (bytes of A)
  await r.settle()
  console.log('REQA late-echo frames:', r.frames.map(f => f.jpeg + (f.sharp ? '*' : '')).join(','))
  r.sub.close()
})

void SHARP_ECHO_MS

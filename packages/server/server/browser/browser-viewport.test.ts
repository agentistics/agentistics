import { expect, test } from 'bun:test'
import { clampViewport, createViewportCast, createViewportQueue } from './browser-viewport'
import { toCdpCommands } from './browser-input-protocol'
import { QUALITY_MOTION } from './browser-screencast'

test('viewer dimensions are finite; DPR is bounded', () => {
  expect(clampViewport({ width: NaN, height: 400, deviceScaleFactor: 1 })).toBeNull()
  expect(clampViewport({ width: 800, height: 400, deviceScaleFactor: 10 })?.deviceScaleFactor).toBe(3)
  expect(clampViewport({ width: 800, height: 400, deviceScaleFactor: 0.5 })?.deviceScaleFactor).toBe(1)
})

test('the page takes the surface ASPECT RATIO at a desktop width, never its raw size', () => {
  // a 390px phone card: 348x209 -> a desktop 1024 page with the same aspect, no 348px layout
  expect(clampViewport({ width: 348, height: 209, deviceScaleFactor: 2 })).toEqual({ width: 1024, height: 615, deviceScaleFactor: 2 })
  // a wide surface keeps its own width when it is larger than 1024
  expect(clampViewport({ width: 1280, height: 640, deviceScaleFactor: 1 })).toEqual({ width: 1280, height: 640, deviceScaleFactor: 1 })
  // 2-tab strip: 818x205 -> the height would be 257 (<400): raise the height and widen so the aspect holds
  const r = clampViewport({ width: 818, height: 205, deviceScaleFactor: 1 })!
  expect(r.height).toBe(400)
  expect(r.width).toBe(1596)
  expect(Math.abs(r.width / r.height - 818 / 205)).toBeLessThan(0.01)
})

test('caps: width <= 1920, height >= 400, width >= 1024 always', () => {
  expect(clampViewport({ width: 3000, height: 1500, deviceScaleFactor: 1 })).toEqual({ width: 1920, height: 960, deviceScaleFactor: 1 })
  expect(clampViewport({ width: 100, height: 20, deviceScaleFactor: 1 })!.height).toBeGreaterThanOrEqual(400)
  // full screen on a phone (388x646): tall page that keeps the aspect, still 1024 wide
  const t = clampViewport({ width: 388, height: 646, deviceScaleFactor: 3 })!
  expect(t.width).toBe(1024)
  expect(Math.abs(t.height / t.width - 646 / 388)).toBeLessThan(0.01)
  // a locked full-screen phone card (388x707): aspect 1.82 still fits the height cap
  const u = clampViewport({ width: 388, height: 707, deviceScaleFactor: 3 })!
  expect(Math.abs(u.height / u.width - 707 / 388)).toBeLessThan(0.01)
  // an absurdly tall surface never goes below a desktop width
  expect(clampViewport({ width: 100, height: 9000, deviceScaleFactor: 1 })!.width).toBe(1024)
  for (const [w, h] of [[348, 209], [818, 205], [818, 249], [848, 595], [388, 646], [500, 90]] as Array<[number, number]>) {
    const v = clampViewport({ width: w, height: h, deviceScaleFactor: 1 })!
    expect(v.width).toBeGreaterThanOrEqual(1024)
    expect(v.height).toBeGreaterThanOrEqual(400)
  }
})

test('no watcher means zero CDP; last resize wins, cast follows, last leave clears', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const cast = createViewportCast(async (method, params) => { calls.push([method, params]) })
  expect(calls).toEqual([])
  await cast.start({ width: 390, height: 260, deviceScaleFactor: 2 })
  await Promise.all([cast.resize({ width: 1100, height: 550, deviceScaleFactor: 1 }), cast.resize({ width: 1200, height: 600, deviceScaleFactor: 2 })])
  expect(calls.filter(([m]) => m === 'Emulation.setDeviceMetricsOverride').at(-1)?.[1]).toEqual({ width: 1200, height: 600, deviceScaleFactor: 2, mobile: false })
  expect(calls.filter(([m]) => m === 'Page.startScreencast').at(-1)?.[1]).toMatchObject({ maxWidth: 2400, maxHeight: 1200 })
  await cast.stop()
  expect(calls.slice(-2).map(([m]) => m)).toEqual(['Page.stopScreencast', 'Emulation.clearDeviceMetricsOverride'])
})

test('normalized input maps to resized CSS viewport, independent of device scale', () => {
  // the frame is scaled down to the surface: a normalized point maps on the PAGE's own CSS size
  const [cmd] = toCdpCommands({ seq: 1, op: 'pointer', type: 'down', x: .25, y: .5, button: 'left', clicks: 1, deltaX: 0, deltaY: 0, mods: 0 }, { w: 1024, h: 615 })
  expect(cmd?.params).toMatchObject({ x: 256, y: 308 })
})

test('last stop clears the override even without any resize', async () => {
  const calls: string[] = []
  const cast = createViewportCast(async method => { calls.push(method) })
  await cast.start({ width: 500, height: 300, deviceScaleFactor: 1 })
  await cast.stop()
  expect(calls.at(-1)).toBe('Emulation.clearDeviceMetricsOverride')
})

test('screencast bounds match the viewers viewport', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const cast = createViewportCast(async (method, params) => { calls.push([method, params]) })
  await cast.start({ width: 1200, height: 600, deviceScaleFactor: 2 })
  expect(calls.at(-1)).toEqual(['Page.startScreencast', { format: 'jpeg', quality: QUALITY_MOTION, maxWidth: 2400, maxHeight: 1200, everyNthFrame: 1 }])
})

test('reconnect cannot clear the new viewers metrics after applying them', async () => {
  const queue = createViewportQueue()
  const calls: string[] = []
  const send = async (method: string) => { await Promise.resolve(); calls.push(method) }
  const old = createViewportCast(send, fn => queue('T1', fn))
  const next = createViewportCast(send, fn => queue('T1', fn))
  await old.start({ width: 1100, height: 600, deviceScaleFactor: 1 })
  calls.length = 0
  await Promise.all([old.stop(), next.start({ width: 1300, height: 650, deviceScaleFactor: 2 })])
  expect(calls).toEqual(['Page.stopScreencast', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setDeviceMetricsOverride', 'Page.startScreencast'])
})

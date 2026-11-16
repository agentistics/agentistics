import { expect, test } from 'bun:test'
import { clampViewport, createViewportCast, createViewportQueue } from './browser-viewport'
import { toCdpCommands } from './browser-input-protocol'

test('viewer dimensions are finite, rounded and bounded in CSS pixels', () => {
  expect(clampViewport({ width: 10, height: 9000, deviceScaleFactor: 10 })).toEqual({ width: 320, height: 1200, deviceScaleFactor: 3 })
  expect(clampViewport({ width: 777.8, height: 400.2, deviceScaleFactor: 2 })).toEqual({ width: 778, height: 400, deviceScaleFactor: 2 })
  expect(clampViewport({ width: NaN, height: 400, deviceScaleFactor: 1 })).toBeNull()
})

test('no watcher means zero CDP; last resize wins, cast follows, last leave clears', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const cast = createViewportCast(async (method, params) => { calls.push([method, params]) })
  expect(calls).toEqual([])
  await cast.start({ width: 390, height: 260, deviceScaleFactor: 2 })
  await Promise.all([cast.resize({ width: 800, height: 500, deviceScaleFactor: 1 }), cast.resize({ width: 900, height: 600, deviceScaleFactor: 2 })])
  expect(calls.filter(([m]) => m === 'Emulation.setDeviceMetricsOverride').at(-1)?.[1]).toEqual({ width: 900, height: 600, deviceScaleFactor: 2, mobile: false })
  expect(calls.filter(([m]) => m === 'Page.startScreencast').at(-1)?.[1]).toMatchObject({ maxWidth: 900, maxHeight: 600 })
  await cast.stop()
  expect(calls.slice(-2).map(([m]) => m)).toEqual(['Page.stopScreencast', 'Emulation.clearDeviceMetricsOverride'])
})

test('normalized input maps to resized CSS viewport, independent of device scale', () => {
  const [cmd] = toCdpCommands({ seq: 1, op: 'pointer', type: 'down', x: .25, y: .5, button: 'left', clicks: 1, deltaX: 0, deltaY: 0, mods: 0 }, { w: 900, h: 600 })
  expect(cmd?.params).toMatchObject({ x: 225, y: 300 })
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
  await cast.start({ width: 390, height: 260, deviceScaleFactor: 2 })
  expect(calls.at(-1)).toEqual(['Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 390, maxHeight: 260, everyNthFrame: 1 }])
})

test('reconnect cannot clear the new viewers metrics after applying them', async () => {
  const queue = createViewportQueue()
  const calls: string[] = []
  const send = async (method: string) => { await Promise.resolve(); calls.push(method) }
  const old = createViewportCast(send, fn => queue('T1', fn))
  const next = createViewportCast(send, fn => queue('T1', fn))
  await old.start({ width: 390, height: 300, deviceScaleFactor: 1 })
  calls.length = 0
  await Promise.all([old.stop(), next.start({ width: 900, height: 600, deviceScaleFactor: 2 })])
  expect(calls).toEqual(['Page.stopScreencast', 'Emulation.clearDeviceMetricsOverride', 'Emulation.setDeviceMetricsOverride', 'Page.startScreencast'])
})

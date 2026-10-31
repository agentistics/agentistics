import { beforeEach, expect, test } from 'bun:test'
import type { EngineSurfaceInfo } from './engineSurfaces'
import {
  endEngineSurfaceFromHost, mountedEngineSurfaces, onEngineSurfaceIndicatorEnd, openEngineSurface,
  resetEngineSurfaceHostForTests, setEngineSurfaceIndicator, setEngineSurfaceKeepAlive,
} from './engineSurfaceHost'

const surface: EngineSurfaceInfo = { id: 'end-demo', placement: 'composer', label: { pt: 'Demo', en: 'Demo' }, module: '/api/engine/x/demo.js' }
const indicator = { label: { pt: 'Em curso', en: 'Running' }, endLabel: { pt: 'Encerrar', en: 'End' } }

function openKept() {
  openEngineSurface(surface, { sessionId: 's1', lang: 'en' })
  const n = mountedEngineSurfaces()[0]!.nonce
  setEngineSurfaceKeepAlive(n, true)
  setEngineSurfaceIndicator(n, indicator)
  return n
}

beforeEach(() => resetEngineSurfaceHostForTests())

test('with an end handler, the host end runs it and leaves the ending to the surface', () => {
  const n = openKept()
  let calls = 0
  onEngineSurfaceIndicatorEnd(n, () => { calls++ })
  endEngineSurfaceFromHost(n)
  expect(calls).toBe(1)
  expect(mountedEngineSurfaces()).toHaveLength(1)
})

test('without a handler, the host end removes the kept-alive surface and its indicator', () => {
  const n = openKept()
  expect(mountedEngineSurfaces()[0]!.indicator).not.toBeNull()
  endEngineSurfaceFromHost(n)
  expect(mountedEngineSurfaces()).toHaveLength(0)
})

test('a throwing end handler never breaks the host', () => {
  const n = openKept()
  onEngineSurfaceIndicatorEnd(n, () => { throw new Error('boom') })
  expect(() => endEngineSurfaceFromHost(n)).not.toThrow()
})

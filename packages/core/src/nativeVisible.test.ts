import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER, NATIVE_HARNESS_ID, SURFACE_HARNESS_ORDER, nativeVisibleFrom, surfaceHarnesses, withoutHiddenNative, type SurfaceHarnessId } from './types'

/**
 * v2.103 listed the native harness on every surface with the experimental flag OFF. These pin the
 * three pieces every surface now goes through: the gate's reading, the list, and the data scrub.
 */
const engine = (over: Record<string, unknown> = {}) => ({
  present: true, manifest: { provides: { nativeRuntime: true } }, nativeExperimental: true, ...over,
})

describe('nativeVisibleFrom — the gate read off GET /api/engine', () => {
  it('is visible only with an engine that provides the runtime AND the flag on', () => {
    expect(nativeVisibleFrom(engine())).toBe(true)
  })
  it('the flag off hides it — the v2.103 regression', () => {
    expect(nativeVisibleFrom(engine({ nativeExperimental: false }))).toBe(false)
  })
  it('no engine, an engine without the runtime, junk: hidden', () => {
    expect(nativeVisibleFrom(engine({ present: false }))).toBe(false)
    expect(nativeVisibleFrom(engine({ manifest: { provides: {} } }))).toBe(false)
    expect(nativeVisibleFrom(null)).toBe(false)
    expect(nativeVisibleFrom('yes')).toBe(false)
    expect(nativeVisibleFrom({})).toBe(false)
  })
})

describe('surfaceHarnesses', () => {
  it('drops the native harness while hidden, and only it', () => {
    expect(surfaceHarnesses(false)).toEqual(HARNESS_ORDER)
    expect(surfaceHarnesses(false)).not.toContain(NATIVE_HARNESS_ID)
  })
  it('is the whole surface registry while visible', () => {
    expect(surfaceHarnesses(true)).toEqual(SURFACE_HARNESS_ORDER)
  })
})

describe('withoutHiddenNative', () => {
  const data = {
    harnesses: ['claude', NATIVE_HARNESS_ID] as SurfaceHarnessId[],
    sessions: [{ harness: 'claude' as SurfaceHarnessId }, { harness: NATIVE_HARNESS_ID as SurfaceHarnessId }, {}],
    other: 1,
  }
  it('removes the native sessions and harness entry while hidden, keeping everything else', () => {
    const out = withoutHiddenNative(data, false)
    expect(out.harnesses).toEqual(['claude'])
    expect(out.sessions).toEqual([{ harness: 'claude' }, {}])
    expect(out.other).toBe(1)
    expect(data.harnesses).toContain(NATIVE_HARNESS_ID) // never mutates
  })
  it('is the identity while visible, and when nothing native is present', () => {
    expect(withoutHiddenNative(data, true)).toBe(data)
    const plain = { harnesses: ['claude'] as SurfaceHarnessId[], sessions: [{}] }
    expect(withoutHiddenNative(plain, false)).toBe(plain)
  })
})

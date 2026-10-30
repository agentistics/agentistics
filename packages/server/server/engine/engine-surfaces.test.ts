import { describe, expect, it } from 'bun:test'
import type { EngineSurface } from '@agentistics/engine-api'
import { engineSurfacesFor } from './engine-surfaces'

const s = (o: Partial<EngineSurface> = {}): EngineSurface => ({
  id: 'demo', placement: 'session-header', label: { pt: 'Demo', en: 'Demo' }, module: '/api/engine/x/demo/mount.js', ...o,
})

describe('engineSurfacesFor', () => {
  it('is empty with no engine (community build)', () => {
    expect(engineSurfacesFor(undefined, {})).toEqual([])
  })
  it('hides an experimental surface until its flag is 1', () => {
    const list = [s(), s({ id: 'beta', experimental: 'DEMO_FLAG' })]
    expect(engineSurfacesFor(list, {}).map(x => x.id)).toEqual(['demo'])
    expect(engineSurfacesFor(list, { DEMO_FLAG: '0' }).map(x => x.id)).toEqual(['demo'])
    expect(engineSurfacesFor(list, { DEMO_FLAG: '1' }).map(x => x.id)).toEqual(['demo', 'beta'])
  })
  it('offers nothing when any surface is invalid', () => {
    expect(engineSurfacesFor([s(), s({ id: 'bad', module: 'https://evil.example/a.js' })], {})).toEqual([])
  })
  it('accepts the official Nay voice-call page surface contract', () => {
    const voiceCall = s({ id: 'voice-calls-nay', placement: 'nay-dock', layout: 'page' })
    expect(engineSurfacesFor([voiceCall], {})).toEqual([voiceCall])
  })
})

it('gates float and nay-sessions with the existing experimental flag', () => {
  const entries = [s({ id: 'floating', layout: 'float', floatOnLeave: true, experimental: 'DEMO_FLAG' }), s({ id: 'extra-tab', placement: 'nay-sessions', experimental: 'DEMO_FLAG' })]
  expect(engineSurfacesFor(entries, {})).toEqual([])
  expect(engineSurfacesFor(entries, { DEMO_FLAG: '1' })).toEqual(entries)
})

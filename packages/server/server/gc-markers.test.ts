import { describe, expect, it } from 'bun:test'
import { DEFAULT_GC_MARKERS, GC_MARKERS_ENV, gcMarkersPlan, selfArgv } from './gc-markers'

describe('gcMarkersPlan', () => {
  it('re-executes with one marker by default on Linux and macOS', () => {
    expect(gcMarkersPlan({}, 'linux')).toBe(DEFAULT_GC_MARKERS)
    expect(gcMarkersPlan({}, 'darwin')).toBe(DEFAULT_GC_MARKERS)
  })
  it('never on Windows', () => {
    expect(gcMarkersPlan({}, 'win32')).toBeNull()
  })
  it('a value already in the environment wins — and is what stops a second re-exec', () => {
    expect(gcMarkersPlan({ [GC_MARKERS_ENV]: '4' }, 'linux')).toBeNull()
    expect(gcMarkersPlan({ [GC_MARKERS_ENV]: '1' }, 'linux')).toBeNull()
  })
  it('AGENTISTICS_GC_MARKERS picks the count, 0 opts out, junk opts out', () => {
    expect(gcMarkersPlan({ AGENTISTICS_GC_MARKERS: '2' }, 'linux')).toBe(2)
    expect(gcMarkersPlan({ AGENTISTICS_GC_MARKERS: '0' }, 'linux')).toBeNull()
    expect(gcMarkersPlan({ AGENTISTICS_GC_MARKERS: 'many' }, 'linux')).toBeNull()
    expect(gcMarkersPlan({ AGENTISTICS_GC_MARKERS: '' }, 'linux')).toBe(DEFAULT_GC_MARKERS)
  })
})

describe('selfArgv', () => {
  it('from source: runtime flags and the script come along', () => {
    expect(selfArgv({ execPath: '/b/bun', argv: ['bun', '/r/cli.ts', 'server', '--port', '48881'], execArgv: ['--cpu-prof'] }))
      .toEqual(['/b/bun', '--cpu-prof', '/r/cli.ts', 'server', '--port', '48881'])
  })
  it('a compiled binary is its own script', () => {
    expect(selfArgv({ execPath: '/home/u/.local/bin/agentop', argv: ['bun', '/$bunfs/root/agentop', 'server'], execArgv: [] }))
      .toEqual(['/home/u/.local/bin/agentop', 'server'])
    expect(selfArgv({ execPath: '/x/agentop', argv: ['bun', '/$bunfs/root/cli.js', 'server'], execArgv: [] }))
      .toEqual(['/x/agentop', 'server'])
  })
  it('nothing to name, nothing to run', () => {
    expect(selfArgv({ execPath: '', argv: [], execArgv: [] })).toBeNull()
  })
})

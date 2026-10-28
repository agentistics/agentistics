import { describe, expect, it } from 'bun:test'
import {
  ENGINE_API_VERSION, ENGINE_SOCKET_LIMITS, RESERVED_PREFIXES, checkEngine, frameCap, surfaceModuleOk, surfaceRefusals,
  type EngineManifest, type EngineSurface,
} from './index'

const surface = (o: Partial<EngineSurface> = {}): EngineSurface => ({
  id: 'demo', placement: 'nay-dock', label: { pt: 'Demo', en: 'Demo' }, module: '/api/engine/x/demo/mount.js', ...o,
})
const manifest = (surfaces?: EngineSurface[]): EngineManifest => ({
  name: 'agentistics-engine', version: '0', apiVersion: ENGINE_API_VERSION,
  provides: { nativeRuntime: false, replay: [], live: [], providers: [] }, ...(surfaces ? { surfaces } : {}),
})
const route = { prefix: '/api/engine/x', capability: 'localShell' as const, handle: async () => null }

describe('1.15', () => {
  it('reserves /api/engine/x', () => expect(RESERVED_PREFIXES).toContain('/api/engine/x'))
  it('module paths: only same-origin, under the prefix, no tricks', () => {
    expect(surfaceModuleOk('/api/engine/x/demo/mount.mjs')).toBe(true)
    for (const bad of [
      'https://evil.example/api/engine/x/a.js', '//evil.example/api/engine/x/a.js', '/api/engine/x/../../a.js',
      '/api/engine/x/%2e%2e/a.js', '/api/engine/x/a.js?x=1', '/api/engine/x/a.js#h', '/api/engine/x/a.css',
      '/api/provider/a.js', '/api/engine/x/', '/api/engine/x//a.js', '/api/engine/x/a\\b.js', 'javascript:alert(1)', 42,
    ]) expect(surfaceModuleOk(bad)).toBe(false)
  })
  it('judges ids, placements, labels, flags and duplicates', () => {
    expect(surfaceRefusals([surface()])).toEqual([])
    expect(surfaceRefusals([surface({ id: 'Bad Id' })])[0]!.reason).toBe('bad-id')
    expect(surfaceRefusals([surface(), surface()])[0]!.reason).toBe('duplicate-id')
    expect(surfaceRefusals([surface({ placement: 'footer' as never })])[0]!.reason).toBe('bad-placement')
    expect(surfaceRefusals([surface({ label: { pt: '', en: 'x' } })])[0]!.reason).toBe('bad-label')
    expect(surfaceRefusals([surface({ experimental: 'lower' })])[0]!.reason).toBe('bad-flag')
    expect(surfaceRefusals([surface({ module: '/elsewhere.js' })])[0]!.reason).toBe('bad-module')
  })
  it('checkEngine refuses a bad surface, and surfaces with no /api/engine/x route', () => {
    const cap = (p: string) => (p === '/api/engine/x' ? 'localShell' as const : null)
    expect(checkEngine({ manifest: manifest([surface()]), routes: [route], commands: [] }, ENGINE_API_VERSION, cap)).toEqual([])
    expect(checkEngine({ manifest: manifest([surface({ module: '/x.js' })]), routes: [route], commands: [] }, ENGINE_API_VERSION, cap)[0]!.kind).toBe('surface')
    expect(checkEngine({ manifest: manifest([surface()]), routes: [], commands: [] }, ENGINE_API_VERSION, cap)).toEqual([{ kind: 'surface-no-route' }])
  })
  it('a host that does not reserve the prefix refuses the route', () => {
    expect(checkEngine({ manifest: manifest(), routes: [route], commands: [] }, ENGINE_API_VERSION, () => null)[0]!.kind).toBe('route-capability')
  })
  it('accepts the app-bar placement', () => {
    expect(surfaceRefusals([surface({ placement: 'app-bar' })])).toEqual([])
  })
  it('frame cap only narrows', () => {
    expect(frameCap(undefined)).toBe(ENGINE_SOCKET_LIMITS.maxFrameBytes)
    expect(frameCap(10)).toBe(10)
    expect(frameCap(1e9)).toBe(ENGINE_SOCKET_LIMITS.maxFrameBytes)
    expect(frameCap(NaN)).toBe(ENGINE_SOCKET_LIMITS.maxFrameBytes)
  })
})

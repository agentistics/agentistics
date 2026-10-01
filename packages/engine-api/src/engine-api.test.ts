import { describe, expect, it } from 'bun:test'
import {
  ENGINE_API_VERSION,
  RESERVED_PREFIXES,
  apiCompatible,
  checkEngine,
  hasReplay,
  isReservedPrefix,
  missingReuseMembers,
  REUSE_SURFACE_MEMBERS,
  type ReuseSurface,
  type CapabilityName,
  type EngineManifest,
  type HarnessIntegration,
} from './index'

describe('apiCompatible', () => {
  it('accepts the same version', () => {
    expect(apiCompatible(ENGINE_API_VERSION, ENGINE_API_VERSION)).toBe(true)
  })
  it('accepts an engine on an older minor and any patch', () => {
    expect(apiCompatible('1.3.0', '1.2.9')).toBe(true)
    expect(apiCompatible('1.3.0', '1.3.7')).toBe(true)
  })
  it('refuses an engine on a newer minor — it may use what the host lacks', () => {
    expect(apiCompatible('1.2.0', '1.3.0')).toBe(false)
  })
  it('refuses a different major in either direction', () => {
    expect(apiCompatible('1.0.0', '2.0.0')).toBe(false)
    expect(apiCompatible('2.0.0', '1.0.0')).toBe(false)
  })
  it('refuses what does not parse', () => {
    expect(apiCompatible('1.0.0', '')).toBe(false)
    expect(apiCompatible('1.0', '1.0.0')).toBe(false)
    expect(apiCompatible('1.0.0', '^1.0.0')).toBe(false)
    expect(apiCompatible('1.0.0', '01.0.0')).toBe(false)
  })
})

describe('isReservedPrefix', () => {
  it('matches every reserved prefix exactly', () => {
    for (const p of RESERVED_PREFIXES) expect(isReservedPrefix(p)).toBe(true)
  })
  it('refuses a sub-path, a trailing slash and an unreserved prefix', () => {
    expect(isReservedPrefix('/api/provider/x')).toBe(false)
    expect(isReservedPrefix('/api/provider/')).toBe(false)
    expect(isReservedPrefix('/api/exec')).toBe(false)
    expect(isReservedPrefix('/api/prov')).toBe(false)
  })
})

describe('checkEngine', () => {
  const manifest: EngineManifest = {
    name: 'agentistics-engine',
    version: '0.0.1',
    apiVersion: ENGINE_API_VERSION,
    provides: { nativeRuntime: false, replay: [], live: [], providers: [] },
  }
  const table = (p: string): CapabilityName | null => (p === '/api/provider' ? 'localShell' : null)
  const route = (prefix: string, capability: CapabilityName) => ({
    prefix,
    capability,
    handle: async () => null,
  })
  const command = (verb: 'code' | 'provider' | 'ingest') => ({
    verb,
    summary: { en: '', pt: '' },
    run: async () => 0,
  })

  it('accepts a conforming engine', () => {
    expect(checkEngine({ manifest, routes: [route('/api/provider', 'localShell')], commands: [command('code')] }, ENGINE_API_VERSION, table)).toEqual([])
  })
  it('refuses a mismatched contract version', () => {
    const r = checkEngine({ manifest: { ...manifest, apiVersion: '2.0.0' }, routes: [], commands: [] }, '1.0.0', table)
    expect(r).toEqual([{ kind: 'api-mismatch', host: '1.0.0', engine: '2.0.0' }])
  })
  it('refuses a route outside the reserved prefixes', () => {
    const r = checkEngine({ manifest, routes: [route('/api/exec', 'localShell')], commands: [] }, ENGINE_API_VERSION, table)
    expect(r).toEqual([{ kind: 'route-not-reserved', prefix: '/api/exec' }])
  })
  it('refuses a route that declares a weaker capability than the host table', () => {
    const r = checkEngine({ manifest, routes: [route('/api/provider', 'localTranscripts')], commands: [] }, ENGINE_API_VERSION, table)
    expect(r).toEqual([{ kind: 'route-capability', prefix: '/api/provider', declared: 'localTranscripts', expected: 'localShell' }])
  })
  it('refuses a reserved route the host table does not guard', () => {
    const r = checkEngine({ manifest, routes: [route('/api/ingest', 'localShell')], commands: [] }, ENGINE_API_VERSION, table)
    expect(r).toEqual([{ kind: 'route-capability', prefix: '/api/ingest', declared: 'localShell', expected: null }])
  })
  it('refuses two commands with one verb', () => {
    const r = checkEngine({ manifest, routes: [], commands: [command('code'), command('code')] }, ENGINE_API_VERSION, table)
    expect(r).toEqual([{ kind: 'duplicate-command', verb: 'code' }])
  })
})

describe('hasReplay', () => {
  const base = { id: 'claude' as const, version: 'v1', capabilities: {} }
  it('is true for an entry with a replay', () => {
    const i: HarnessIntegration = { ...base, replay: { discover: async () => [], replay: async () => ({ events: [], cursor: null }) } }
    expect(hasReplay(i)).toBe(true)
  })
  it('is false for a declared absence', () => {
    const i: HarnessIntegration = { ...base, replayAbsent: 'no stored record' }
    expect(hasReplay(i)).toBe(false)
  })
})

// Every `ReuseSurface` key is in the member list, and the list names nothing else (`satisfies`).
type MissingFromList = Exclude<keyof ReuseSurface, (typeof REUSE_SURFACE_MEMBERS)[number]>
const listIsExhaustive: [MissingFromList] extends [never] ? true : false = true

describe('the reuse surface (1.2)', () => {
  it('names exactly the 48 members an engine reuses, once each', () => {
    expect(listIsExhaustive).toBe(true)
    expect(REUSE_SURFACE_MEMBERS.length).toBe(48)
    expect(new Set(REUSE_SURFACE_MEMBERS).size).toBe(48)
  })
  it('an empty surface (a 1.1 host) lacks every member', () => {
    expect(missingReuseMembers({})).toEqual([...REUSE_SURFACE_MEMBERS])
  })
  it('a surface missing one member names exactly that one', () => {
    const offered = Object.fromEntries(REUSE_SURFACE_MEMBERS.map(k => [k, () => {}]))
    delete offered.planTranscriptRead
    expect(missingReuseMembers(offered)).toEqual(['planTranscriptRead'])
  })
  it('a falsy constant still counts as offered — only an absent member is missing', () => {
    const offered: Record<string, unknown> = Object.fromEntries(REUSE_SURFACE_MEMBERS.map(k => [k, () => {}]))
    offered.MAX_STATES = 0
    expect(missingReuseMembers(offered)).toEqual([])
  })
})

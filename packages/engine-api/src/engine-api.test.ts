import { describe, expect, it, test } from 'bun:test'
import {
  AMEND_REFUSED_REASONS, SUBMIT_REFUSED_REASONS, structuredRegistry, validIdempotencyKey,
  type StructuredAmendResult, type StructuredCancelReceipt, type StructuredDeclaration, type StructuredDriver, type StructuredSpawn, type StructuredSubmitReceipt,
} from './structured'
import {
  ENGINE_API_VERSION,
  asCodePort,
  type CodeHost,
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

describe('ES.6h — the typed code host (1.8)', () => {
  const port = () => ({
    kind: 'code-host' as const, dispose: async () => {},
    availability: () => ({ ok: true as const }), defaults: async () => ({}), openTasks: async () => ({ ok: true as const, tasks: [] }),
    createTask: async () => ({ ok: false as const, sentence: 'x' }), start: async () => ({ ok: false as const, sentence: 'x' }),
    resume: async () => ({ ok: false as const, sentence: 'x' }), subscribe: () => () => {}, submit: () => ({ ok: true as const }),
    answer: () => ({ ok: false as const, sentence: 'x' }), cancel: () => ({ ok: false as const, sentence: 'x' }), end: async () => {},
  })
  test('the engine-api is 1.9 (1.8 + the chat channel) and a 1.7 engine\'s opaque handle still satisfies CodeHost but is not a port', () => {
    expect(ENGINE_API_VERSION).toBe('1.21.0')
    const opaque: CodeHost = { kind: 'code-host', dispose: async () => {} }
    expect(asCodePort(opaque)).toBeNull()
    expect(asCodePort(null)).toBeNull()
  })
  test('a handle carrying every member is the port; a missing member is not', () => {
    expect(asCodePort(port() as unknown as CodeHost)).not.toBeNull()
    const { end: _e, ...rest } = port()
    expect(asCodePort(rest as unknown as CodeHost)).toBeNull()
  })
  test('apiCompatible: an engine built against 1.7 loads on a 1.8 host, and the reverse is refused', () => {
    expect(apiCompatible('1.8.0', '1.7.0')).toBe(true)
    expect(apiCompatible('1.7.0', '1.8.0')).toBe(false)
  })
})

describe('1.18 — forkOf and a blocked start ride the structured registry untouched', () => {
  const driver = (seen: StructuredSpawn[]): StructuredDriver => ({
    id: 'acp', status: 'ready', harnesses: ['opencode'], note: 't',
    declares: () => { throw new Error('unused') },
    start: async req => { seen.push(req); return req.forkOf === 'ses_old' ? { ok: false, reason: 'opencode ≥1.18.0 is needed', blocked: { kind: 'harness-version', need: '1.18.0', found: '1.17.9' } } : { ok: false, reason: 'plain refusal' } },
  })
  test('the driver receives forkOf as sent; a blocked refusal keeps its `blocked`, a plain one has none', async () => {
    const seen: StructuredSpawn[] = []
    const reg = structuredRegistry([driver(seen)])
    const blocked = await reg.start({ id: 'a', harness: 'opencode', cwd: '/w', forkOf: 'ses_old' })
    expect(seen[0]!.forkOf).toBe('ses_old')
    expect(blocked).toEqual({ ok: false, reason: 'opencode ≥1.18.0 is needed', blocked: { kind: 'harness-version', need: '1.18.0', found: '1.17.9' } })
    const plain = await reg.start({ id: 'b', harness: 'opencode', cwd: '/w' })
    expect(plain).toEqual({ ok: false, reason: 'plain refusal' })
  })
})

describe('1.21 — ADAPTER.LIMITES declarations ride the registry; keys and refusals are closed', () => {
  const decl = (h: string): StructuredDeclaration => ({
    assignId: { absent: 'x' }, resume: { absent: 'x' }, model: { absent: 'x' }, effort: { absent: 'x' }, mcp: { absent: 'x' },
    instructions: { channel: 'first-message', reason: 'x' }, live: { absent: 'x' }, permissions: { absent: 'x' }, questions: { absent: 'x' }, cancel: { via: 'x' },
    amend: { queued: { via: 'driver queue' }, running: { absent: `${h}: a concurrent prompt aborts the turn` } },
    cancelReceipt: { via: 'stopReason', confidence: 'inferred', deadlineMs: 10_000 },
    reconcile: { absent: 'no protocol id' },
  })
  const driver: StructuredDriver = { id: 'acp', status: 'ready', harnesses: ['gemini'], note: 't', declares: decl, start: async () => ({ ok: false, reason: 'x' }) }
  test('structuredRegistry.declares hands the new members through untouched', () => {
    const d = structuredRegistry([driver]).declares('gemini')!
    expect(d.amend).toEqual({ queued: { via: 'driver queue' }, running: { absent: 'gemini: a concurrent prompt aborts the turn' } })
    expect(d.cancelReceipt).toEqual({ via: 'stopReason', confidence: 'inferred', deadlineMs: 10_000 })
    expect(d.reconcile).toEqual({ absent: 'no protocol id' })
  })
  test('a 1.20 declaration (no new members) is still a StructuredDeclaration', () => {
    const { amend: _a, cancelReceipt: _c, reconcile: _r, ...old } = decl('gemini')
    const asOld: StructuredDeclaration = old
    expect(asOld.amend).toBeUndefined()
  })
  test('an engine built against 1.20 loads on a 1.21 host; the reverse is refused', () => {
    expect(apiCompatible('1.21.0', '1.20.0')).toBe(true)
    expect(apiCompatible('1.20.0', '1.21.0')).toBe(false)
  })
  test('validIdempotencyKey: charset and length', () => {
    expect(validIdempotencyKey('call1:turn2:3')).toBe(true)
    expect(validIdempotencyKey('a'.repeat(128))).toBe(true)
    expect(validIdempotencyKey('a'.repeat(129))).toBe(false)
    for (const bad of ['', 'has space', 'ação', 'a/b', 5, null, undefined]) expect(validIdempotencyKey(bad)).toBe(false)
  })
  test('the refusal lists are closed and carry no free text', () => {
    expect([...SUBMIT_REFUSED_REASONS]).toEqual(['session-ended', 'queue-full', 'attention-open', 'key-conflict', 'empty'])
    expect([...AMEND_REFUSED_REASONS]).toEqual(['finished', 'unknown-request', 'session-ended', 'key-conflict'])
  })
  test('the receipt shapes type-check (compile-time) and discriminate', () => {
    const r: StructuredCancelReceipt = { state: 'cancelled', requestId: 'r1', at: 't', phase: 'running', confidence: 'exact', scope: 'turn', alsoEnded: ['r2'], effects: 'possible', durable: true }
    const a: StructuredAmendResult = { result: 'appended', requestId: 'r1', carrierRequestId: 'r3', at: 't', reason: 'running, no steer', durable: false }
    const u: StructuredSubmitReceipt = { state: 'in-doubt', requestId: 'r1', at: 't', durable: true }
    expect([r.state, a.result, u.state]).toEqual(['cancelled', 'appended', 'in-doubt'])
  })
})

/**
 * The native sessions as the ENGINE offers them (B4, replayed by ES.6a): the `/api/runtime/sessions`
 * route and the `code` verb, judged the way the public host judges them at load.
 *
 * Q-4 (leader): every B4 resource lives under the ONE reserved prefix `/api/runtime/sessions`, and
 * `RESERVED_PREFIXES` is not widened. The public guard table is the host's own (`routeCapability`),
 * so a route declaring a capability the host does not hold for its prefix fails here as it would be
 * refused at load.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkEngine, ENGINE_API_VERSION, RESERVED_PREFIXES } from '@agentistics/engine-api'
import { routeCapability } from '@agentistics/server/server/capability-guard'
import { readJsonLimited } from '@agentistics/server/server/limits'
import { safeError } from '@agentistics/server/server/errors'
import { createEngine } from './index'
import { installHost, testHost, type HostServices } from './host'
import { admitNativeSession, _resetRuntimeSessionsWebState } from './runtime-sessions-web'

const hosts: HostServices[] = []
function freshHost(over: Partial<HostServices> = {}): HostServices {
  const h = testHost(mkdtempSync(join(tmpdir(), 'engine-native-')), { readJsonLimited, safeError, ...over })
  hosts.push(h)
  return h
}

afterEach(() => {
  _resetRuntimeSessionsWebState()
  installHost(freshHost())
})

describe('the engine offers the native sessions', () => {
  test('the manifest says so, and the public host would load it as it is', async () => {
    const e = await createEngine(freshHost())
    expect(e.manifest.provides.nativeRuntime).toBe(true)
    expect(e.routes.map(r => r.prefix)).toContain('/api/runtime/sessions')
    expect(e.commands.map(c => c.verb)).toContain('code')
    expect(typeof e.codeHost).toBe('function')
    expect(checkEngine(e, ENGINE_API_VERSION, routeCapability)).toEqual([])
  })

  test('Q-4: every route sits under a reserved prefix, and B4\'s top-level ones are gone', async () => {
    const e = await createEngine(freshHost())
    for (const r of e.routes) expect((RESERVED_PREFIXES as readonly string[]).includes(r.prefix)).toBe(true)
    const sessions = e.routes.find(r => r.prefix === '/api/runtime/sessions')!
    for (const path of ['/api/runtime/tools/tx_1/approve', '/api/runtime/runs/run_1/cancel']) {
      const res = await sessions.handle(new Request(`http://localhost${path}`, { method: 'POST' }), new URL(`http://localhost${path}`))
      expect(res).toBeNull()
    }
  })

  test('the route refuses on a central, and with the BETA flag off, in words', async () => {
    const central = await createEngine(freshHost({ isCentral: () => true, flag: () => true }))
    const url = new URL('http://localhost/api/runtime/sessions')
    const r1 = await central.routes.find(r => r.prefix === '/api/runtime/sessions')!.handle(new Request(url), url)
    expect(r1!.status).toBe(403)
    expect(((await r1!.json()) as { code: string }).code).toBe('central')

    const off = await createEngine(freshHost({ flag: () => false }))
    const r2 = await off.routes.find(r => r.prefix === '/api/runtime/sessions')!.handle(new Request(url), url)
    expect(r2!.status).toBe(409)
    expect(((await r2!.json()) as { sentence: string }).sentence).toContain('AGENTISTICS_PROVIDER=1')
  })

  test('with the flag on, the list answers from the HOST\'s data dir', async () => {
    const e = await createEngine(freshHost({ flag: n => n === 'provider' }))
    const url = new URL('http://localhost/api/runtime/sessions')
    const res = await e.routes.find(r => r.prefix === '/api/runtime/sessions')!.handle(new Request(url), url)
    expect(res!.status).toBe(200)
    expect(((await res!.json()) as { sessions: unknown[] }).sessions).toEqual([])
  })

  test('`agentop code` refuses with the flag off, on the host\'s error channel', async () => {
    const e = await createEngine(freshHost({ flag: () => false }))
    const err: string[] = []
    const code = await e.commands.find(c => c.verb === 'code')!.run(['hello'], { out: () => {}, err: l => err.push(l) })
    expect(code).not.toBe(0)
    expect(err.join('\n')).toContain('AGENTISTICS_PROVIDER=1')
  })
})

describe('admitNativeSession — the admission rule over the host\'s budget', () => {
  const b = (max: number, used: number, left: number) => ({ budget: { max, used, left, percent: 0 } })
  test('unmeasured (no budget, or the host\'s all-zero answer) is admitted', () => {
    expect(admitNativeSession(null)).toEqual({ admit: true })
    expect(admitNativeSession(b(0, 0, 0))).toEqual({ admit: true })
  })
  test('room left admits; none left refuses, naming the figures', () => {
    expect(admitNativeSession(b(4, 3, 1))).toEqual({ admit: true })
    const r = admitNativeSession(b(4, 4, 0))
    expect(r.admit).toBe(false)
    if (!r.admit) expect(r.body).toMatchObject({ code: 'memory_budget', refusal: { reason: 'no-room', used: 4, max: 4 } })
  })
})

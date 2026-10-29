/**
 * Adversarial QA for engine-api 1.15 (engine-owned surfaces, sockets and assets).
 *
 * Each test pins a defence that must hold; the closing tests cover session end and engine dispose.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { RESERVED_PREFIXES, surfaceModuleOk, ENGINE_SOCKET_LIMITS, type EngineSocketHandlers } from '@agentistics/engine-api'
import { surfaceModulePathOk } from '../../../web/src/lib/engineSurfaces'
import { assetVerdict, applyAssetVerdict } from './engine-assets'
import { wsInputOriginOk } from '../sessions/input-protocol'
import {
  admit, closeEngineSocket, engineSocketCount, onEngineSocketMessage, openEngineSocket, planEngineUpgrade,
  resetEngineSocketsForTests, sweepEndedSessions, type EngineSocketState,
} from './engine-sockets'
import { engineStatus, reservedPrefixMiss, resetEngineForTests } from './load'
import { inputSessionLive } from '../sessions/input-web'
import { addSession, retireSession } from '../sessions/registry'
import { MANAGED_SESSIONS_FILE } from '../config'
import { applyBaselineHeaders } from '../response-policy'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

afterEach(() => { resetEngineSocketsForTests(); resetEngineForTests() })

describe('module path: every bypass is refused, on the host and in the web', () => {
  const hostile = [
    '//evil.example/a.js',
    '/api/engine/x//evil.example/a.js',
    '/api/engine/x/../provider/a.js',
    '/api/engine/x/./a.js',
    '/api/engine/x/%2e%2e/a.js',
    '/api/engine/x/%2E%2E/a.js',
    '/api/engine/x/..%2fa.js',
    '/api/engine/x/a.js?x=1',
    '/api/engine/x/a.js#f',
    '/api/engine/x\\..\\a.js',
    '/api/engine/x/a\\b.js',
    'https://evil.example/api/engine/x/a.js',
    'http://127.0.0.1:47292/api/engine/x/a.js',
    'data:text/javascript,export function mount(){}',
    'blob:http://localhost/abc',
    'javascript:alert(1)',
    '/api/engine/x/a.js\n',
    '/api/engine/x/a.js\t',
    '/api/engine/x/',
    '/api/engine/x/a.json',
    '/api/engine/xa.js',
    '/api/engine/x/a.js/',
    ' /api/engine/x/a.js',
    '/api/engine/x/' + 'a'.repeat(300) + '.js',
  ]
  for (const p of hostile) {
    it(`refuses ${JSON.stringify(p).slice(0, 60)}`, () => {
      expect(surfaceModuleOk(p)).toBe(false)
      expect(surfaceModulePathOk(p)).toBe(false)
    })
  }
  it('accepts the plain shape', () => {
    expect(surfaceModuleOk('/api/engine/x/demo/mount.mjs')).toBe(true)
    expect(surfaceModulePathOk('/api/engine/x/demo/mount.mjs')).toBe(true)
  })
  it('what passes resolves to itself as a same-origin path', () => {
    for (const p of ['/api/engine/x/a.js', '/api/engine/x/a/b-c_d.mjs', '/api/engine/x/ａ.js']) {
      if (!surfaceModulePathOk(p)) continue
      const u = new URL(p, 'http://127.0.0.1:47292/sessions/abc')
      expect(u.origin).toBe('http://127.0.0.1:47292')
      expect(u.pathname.startsWith('/api/engine/x/')).toBe(true)
    }
  })
})

describe('origin check in front of an engine socket', () => {
  const base = { host: '127.0.0.1:47292', allowlist: ['http://127.0.0.1:47292', 'http://localhost:47292'], dev: false }
  it('refuses a foreign origin, `null`, a different port, and a different scheme/host case', () => {
    expect(wsInputOriginOk({ ...base, origin: 'http://evil.example' })).toBe(false)
    expect(wsInputOriginOk({ ...base, origin: 'null' })).toBe(false)
    expect(wsInputOriginOk({ ...base, origin: 'http://127.0.0.1:9999' })).toBe(false)
    expect(wsInputOriginOk({ ...base, origin: 'http://127.0.0.1:47292.evil.example' })).toBe(false)
    expect(wsInputOriginOk({ ...base, origin: 'HTTP://EVIL.EXAMPLE' })).toBe(false)
  })
  it('INFO: a handshake with NO Origin header is admitted (non-browser client; same rule as the fleet write socket)', () => {
    expect(wsInputOriginOk({ ...base, origin: null })).toBe(true)
  })
  it('a refused origin never reaches the engine (planEngineUpgrade)', () => {
    expect(planEngineUpgrade({ routeCanUpgrade: true, originOk: false, handlers: null, sessionExists: true, admission: { ok: true } }))
      .toEqual({ status: 403, error: 'forbidden_origin' })
  })
})

describe('frame cap', () => {
  it('closes with 1009 on a 64 KiB + 1 frame, and an engine cannot widen it', () => {
    const closed: number[] = []
    const got: unknown[] = []
    const st: EngineSocketState = { route: '/api/engine/x', handlers: { maxFrameBytes: 10 * 1024 * 1024, message: (_s, d) => { got.push(d) } }, entry: null }
    openEngineSocket(st, { send() {}, close(c?: number) { closed.push(c ?? 0) } })
    onEngineSocketMessage(st, 'a'.repeat(ENGINE_SOCKET_LIMITS.maxFrameBytes))
    expect(got.length).toBe(1)
    onEngineSocketMessage(st, 'a'.repeat(ENGINE_SOCKET_LIMITS.maxFrameBytes + 1))
    expect(closed).toEqual([1009])
    expect(got.length).toBe(1)
  })
  it('counts multi-byte text in BYTES, not characters', () => {
    const closed: number[] = []
    const st: EngineSocketState = { route: '/api/engine/x', handlers: { message() {} }, entry: null }
    openEngineSocket(st, { send() {}, close(c?: number) { closed.push(c ?? 0) } })
    onEngineSocketMessage(st, '€'.repeat(Math.ceil(ENGINE_SOCKET_LIMITS.maxFrameBytes / 3) + 1))
    expect(closed).toEqual([1009])
  })
})

/**
 * Reproduces index.ts's handshake ORDER with the real exported functions and a real Bun server:
 * `await route.upgrade(...)`, `await inputSessionExists(...)`, then `admit(...)`, then `server.upgrade`
 * — while the connection is only COUNTED later, in the `open` callback. Concurrent handshakes all read
 * the same count.
 */
describe('connection ceilings under concurrency', () => {
  it('40 concurrent handshakes on one route stay within perRoute (16)', async () => {
    type D = { engineSocket: EngineSocketState }
    const route = '/api/engine/x'
    const handlers: EngineSocketHandlers = { message() {} }
    const server = Bun.serve<D, never>({
      port: 0,
      async fetch(req, srv) {
        // the engine's own upgrade() and the host's registry read are both awaited before admit()
        await new Promise(r => setTimeout(r, 5))
        await new Promise(r => setTimeout(r, 5))
        const refusal = planEngineUpgrade({ routeCanUpgrade: true, originOk: true, handlers, sessionExists: true, admission: admit(route, undefined) })
        if (refusal) return new Response(null, { status: refusal.status })
        const engineSocket: EngineSocketState = { route, handlers, entry: null }
        return srv.upgrade(req, { data: { engineSocket } }) ? undefined : new Response(null, { status: 500 })
      },
      websocket: {
        open(ws) { openEngineSocket(ws.data.engineSocket, ws) },
        message(ws, m) { onEngineSocketMessage(ws.data.engineSocket, m) },
        close(ws, c, r) { closeEngineSocket(ws.data.engineSocket, c, r) },
      },
    })
    const clients: WebSocket[] = []
    try {
      const opened = await Promise.all(Array.from({ length: 40 }, () => new Promise<boolean>(resolve => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}${route}/s`)
        clients.push(ws)
        ws.onopen = () => resolve(true)
        ws.onerror = () => resolve(false)
        ws.onclose = () => resolve(false)
      })))
      const n = opened.filter(Boolean).length
      console.log(`[attack] concurrent handshakes opened: ${n} / 40 (ceiling ${ENGINE_SOCKET_LIMITS.perRoute}); host count ${engineSocketCount()}`)
      expect(engineSocketCount()).toBeLessThanOrEqual(ENGINE_SOCKET_LIMITS.perRoute)
    } finally {
      for (const c of clients) try { c.close() } catch { /* */ }
      server.stop(true)
    }
  })
})

describe('closing', () => {
  it('disposing the engine closes every engine socket (docs: "closed (1001) when the engine is disposed")', async () => {
    // disposeEngine() is the host's one dispose path; with or without an engine it must take the sockets down.
    const src = readFileSync(join(import.meta.dir, 'load.ts'), 'utf8')
    const body = src.slice(src.indexOf('export async function disposeEngine'), src.indexOf('/** Tests only. */'))
    expect(body).toContain('closeAllEngineSockets')
  })

  it('production code calls code calls closeAllEngineSockets or disposeEngine', () => {
    const glob = new Bun.Glob('**/*.ts')
    const root = join(import.meta.dir, '..', '..')
    const callers: string[] = []
    for (const f of glob.scanSync({ cwd: root })) {
      if (f.includes('node_modules') || f.endsWith('.test.ts') || f.includes('.generated.')) continue
      const src = readFileSync(join(root, f), 'utf8').replace(/export (async )?function (closeAllEngineSockets|disposeEngine)\(/g, '')
      if (/\b(closeAllEngineSockets|disposeEngine)\s*\(/.test(src)) callers.push(f)
    }
    console.log(`[attack] production callers of closeAllEngineSockets/disposeEngine: ${JSON.stringify(callers)}`)
    expect(callers.length).toBeGreaterThan(0)
  })

  const realHome = MANAGED_SESSIONS_FILE.startsWith(join(homedir(), '.agentistics')) && !homedir().includes('agentistics-throwaway')
  (realHome ? it.skip : it)('a socket declaring a session is closed (4001) once that session is KILLED (row kept with endedAt)', async () => {
    const id = `qa-${Date.now().toString(36)}`
    await addSession({ id, harness: 'claude', cwd: '/tmp', createdAt: new Date().toISOString() } as never)
    const closed: number[] = []
    const st: EngineSocketState = { route: '/api/engine/x', handlers: { sessionId: id, message() {} }, entry: null }
    expect(await inputSessionExists(id)).toBe(true)
    openEngineSocket(st, { send() {}, close(c?: number) { closed.push(c ?? 0) } })
    await retireSession(id) // what a kill does: the row stays, stamped endedAt
    const n = await sweepEndedSessions(inputSessionLive) // the liveness test index.ts wires
    console.log(`[attack] after kill: live=${await inputSessionLive(id)} swept=${n}`)
    expect(closed).toEqual([4001])
  })

  (realHome ? it.skip : it)('a handshake declaring an ENDED session is refused', async () => {
    const id = `qa-ended-${Date.now().toString(36)}`
    await addSession({ id, harness: 'claude', cwd: '/tmp', createdAt: new Date().toISOString() } as never)
    await retireSession(id)
    const refusal = planEngineUpgrade({
      routeCanUpgrade: true, originOk: true, handlers: { sessionId: id, message() {} },
      sessionExists: await inputSessionLive(id), admission: admit('/api/engine/x', id),
    })
    expect(refusal).not.toBeNull()
  })
})

describe('assets', () => {
  it('wasm is refused whatever its case', () => {
    expect(assetVerdict('/api/engine/x/a.WASM').kind).toBe('refuse')
    expect(assetVerdict('/api/engine/x/d/a.Wasm').kind).toBe('refuse')
  })
  it('a passthrough type still leaves with nosniff and the host CSP (baseline headers), whatever the engine set', () => {
    for (const p of ['/api/engine/x/a.html', '/api/engine/x/a.svg', '/api/engine/x/a', '/api/engine/x/a.wasm/']) {
      const res = applyAssetVerdict(p, new Response('<script>1</script>', {
        headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "script-src * 'unsafe-inline' 'unsafe-eval'", 'X-Content-Type-Options': 'sniff' },
      }))
      const out = applyBaselineHeaders(new Response(res.body, { status: res.status, headers: new Headers(res.headers) }), { tls: false, dev: false, isApi: true, embed: false })
      expect(out.headers.get('X-Content-Type-Options')).toBe('nosniff')
      const csp = out.headers.get('Content-Security-Policy') ?? ''
      expect(csp).not.toContain('unsafe-eval')
      expect(csp).toContain("frame-ancestors 'none'")
    }
  })
})

describe('community build', () => {
  it('a reserved engine prefix answers 404 engine-absent when there is no engine', () => {
    resetEngineForTests()
    for (const path of ['/api/engine/x/', '/api/engine/x/a.js']) {
      const reserved = RESERVED_PREFIXES.find(p => path === p || path.startsWith(p + '/'))
      expect(reserved).toBe('/api/engine/x')
    }
    const miss = reservedPrefixMiss(false, engineStatus())
    expect(miss.status).toBe(404)
    expect(miss.body.error).toBe('engine-absent')
    expect(engineStatus().present).toBe(false)
  })
  it('the server wires the reserved-prefix miss through that helper', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
    expect(src).toContain('reservedPrefixMiss(false, engineStatus())')
  })
})

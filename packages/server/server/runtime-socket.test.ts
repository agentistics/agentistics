import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineRoute } from '@agentistics/engine-api'
import { runtimeSocketPath, shouldBindRuntimeSocket, startRuntimeSocket } from './runtime-socket'

const dirs: string[] = []
const stops: (() => void)[] = []
afterEach(() => { for (const s of stops.splice(0)) s(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const route = (prefix: string, localSocket: boolean, seen: string[] = []): EngineRoute => ({
  prefix, capability: 'localShell', localSocket,
  async handle(_req, url, ctx) { seen.push(`${url.pathname} ${ctx?.transport}`); return new Response(JSON.stringify({ ok: true, transport: ctx?.transport })) },
})

describe('B4.6: the runtime unix socket', () => {
  test('bound only when not a central and some engine route asks for it', () => {
    expect(shouldBindRuntimeSocket({ central: false, routes: [route('/api/runtime/sessions', true)] })).toBe(true)
    expect(shouldBindRuntimeSocket({ central: true, routes: [route('/api/runtime/sessions', true)] })).toBe(false)
    expect(shouldBindRuntimeSocket({ central: false, routes: [route('/api/provider', false)] })).toBe(false)
    expect(shouldBindRuntimeSocket({ central: false, routes: null })).toBe(false)
  })

  test('0600 in a 0700 dir; serves only localSocket routes (transport unix), through the guard; a stale socket is replaced; stop removes it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'rsock-')); dirs.push(dataDir)
    const seen: string[] = []
    let deny = false
    const opts = {
      dataDir,
      routes: () => [route('/api/runtime/sessions', true, seen), route('/api/provider', false, seen)],
      guard: (p: string) => (deny && p.startsWith('/api/runtime') ? new Response('{"error":"capability_disabled"}', { status: 403 }) : null),
    }
    const first = startRuntimeSocket(opts)
    first.stop()
    const sock = startRuntimeSocket(opts) // over whatever the first left
    stops.push(() => sock.stop())
    expect(sock.path).toBe(runtimeSocketPath(dataDir))
    expect(statSync(sock.path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dataDir, 'run')).mode & 0o777).toBe(0o700)
    const call = (p: string) => fetch(`http://localhost${p}`, { unix: sock.path } as RequestInit)
    const ok = await call('/api/runtime/sessions/host')
    expect(await ok.json()).toEqual({ ok: true, transport: 'unix' })
    expect((await call('/api/provider/keys')).status).toBe(404)
    expect((await call('/api/data')).status).toBe(404)
    deny = true
    expect((await call('/api/runtime/sessions')).status).toBe(403)
    expect(seen).toEqual(['/api/runtime/sessions/host unix'])
    sock.stop()
    expect(() => statSync(sock.path)).toThrow()
  })
})

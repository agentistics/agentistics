/**
 * DOCKER.AMBIENTES S2 — the egress proxy over a real unix socket, with an injected resolver and upstream, so the
 * decision is exercised end to end without touching the network: a refused request NEVER reaches the upstream.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { connect, createServer, type Server } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startEgressProxy } from './egress-proxy'

let dir = ''
const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })

async function rig(dns: Record<string, string[]>) {
  dir = mkdtempSync(join(tmpdir(), 'agentistics-s2-egress-'))
  let upstreamHits = 0
  const upstream = createServer(c => { upstreamHits++; c.on('data', d => c.write(`echo:${d}`)) })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
  servers.push(upstream)
  const port = (upstream.address() as any).port
  const journal = join(dir, 'egress.jsonl')
  const proxy = await startEgressProxy({
    socketPath: join(dir, 'egress.sock'), allow: ['registry.npmjs.org'], journal,
    resolve: async h => dns[h] ?? [], hostAddresses: () => ['192.168.0.50', '172.17.0.1'],
    connectTo: () => connect({ host: '127.0.0.1', port }),
  })
  servers.push(proxy)
  const ask = (req: string) => new Promise<string>(resolve => {
    const c = connect({ path: join(dir, 'egress.sock') })
    let out = ''
    c.on('data', d => { out += d; if (out.includes('\r\n\r\n') && out.startsWith('HTTP/1.1 200')) { c.write('PING'); } if (out.includes('echo:PING')) c.end() })
    c.on('close', () => resolve(out))
    c.write(req)
    setTimeout(() => c.destroy(), 1500)
  })
  return { ask, hits: () => upstreamHits, journal: () => readFileSync(journal, 'utf8') }
}

describe('egress proxy (unix socket)', () => {
  test('an allowed CONNECT is tunnelled to the checked address', async () => {
    const r = await rig({ 'registry.npmjs.org': ['104.16.0.35'] })
    const out = await r.ask('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n')
    expect(out).toMatch(/^HTTP\/1.1 200/)
    expect(out).toContain('echo:PING')
    expect(r.hits()).toBe(1)
  })
  const refused: [string, string, Record<string, string[]>][] = [
    ['loopback literal', 'CONNECT 127.0.0.1:443 HTTP/1.1', {}],
    ['the real api port', 'CONNECT registry.npmjs.org:47291 HTTP/1.1', { 'registry.npmjs.org': ['104.16.0.35'] }],
    ['DNS rebinding to 127.0.0.1', 'CONNECT registry.npmjs.org:443 HTTP/1.1', { 'registry.npmjs.org': ['127.0.0.1'] }],
    ['an allowed name resolving to a host interface', 'CONNECT registry.npmjs.org:443 HTTP/1.1', { 'registry.npmjs.org': ['192.168.0.50'] }],
    ['the bridge gateway', 'CONNECT registry.npmjs.org:443 HTTP/1.1', { 'registry.npmjs.org': ['172.17.0.1'] }],
    ['an absolute GET with a forged Host', 'GET http://127.0.0.1:47291/api/health HTTP/1.1', {}],
    ['a WebSocket upgrade to the fleet input', 'GET /api/fleet/input HTTP/1.1', {}],
    ['localhost', 'CONNECT localhost:443 HTTP/1.1', { localhost: ['127.0.0.1'] }],
  ]
  for (const [name, line, dns] of refused) test(`refuses ${name}, and the upstream sees nothing`, async () => {
    const r = await rig(dns)
    const out = await r.ask(`${line}\r\nHost: x\r\nUpgrade: websocket\r\n\r\n`)
    expect(out).toMatch(/^HTTP\/1.1 403/)
    expect(r.hits()).toBe(0)
    expect(r.journal()).toMatch(/"decision":"refuse"/)
  })
})

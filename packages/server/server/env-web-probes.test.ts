import { test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, chmodSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { detectDocker } from './flows/host-ops'
import { envUse, envGrant, envStatus, handleEnvRequest, platformOf, type EnvDeps } from './env-web'
import { routeCapability, capabilityDenied } from './capability-guard'
import { capabilitiesFor } from './exposure'

function deps(): EnvDeps & { saved: Record<string, unknown> } {
  const saved: Record<string, unknown> = {}
  return {
    saved, flag: () => true,
    detect: async () => ({ present: true, running: true, version: '29', kind: 'native', apiVersion: '1.54' }),
    platform: () => ({ os: 'linux', docker: 'available' }), readPrefs: async () => saved,
    writePrefs: async f => { const p = f(saved); if (p) Object.assign(saved, p) },
    verify: async (_id, token) => token === 'ok' ? 'worker' : null,
    roleOf: async () => 'worker', now: () => 0, caller: async () => 'unknown',
  }
}

test('PATH probe: rootless, socket permission denial, malformed API, absent, flag off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-s1-path-'))
  const previous = process.env.PATH
  try {
    const bin = join(dir, 'docker')
    const fake = (server: string, api: string, os: string) => {
      writeFileSync(bin, `#!/bin/sh\ncase "$*" in\n*Client.Version*) echo 29.3.0 ;;\n*Server.APIVersion*) echo '${api}' ;;\n*Server.Version*) ${server} ;;\n*OperatingSystem*) echo '${os}' ;;\nesac\n`)
      chmodSync(bin, 0o755); process.env.PATH = dir
    }
    fake('echo 29.3.0', '1.54', 'Ubuntu rootless')
    const rootless = await detectDocker()
    expect(rootless).toMatchObject({ present: true, running: true, kind: 'native', apiVersion: '1.54' })
    expect(platformOf({ platform: 'linux', isWsl: false }, rootless).docker).toBe('available')
    fake('echo permission-denied >&2; exit 1', '1.54', 'Ubuntu')
    expect(await detectDocker()).toMatchObject({ present: true, running: false, apiVersion: null })
    fake('echo 29.3.0', 'nonsense', 'Ubuntu')
    expect((await detectDocker()).apiVersion).toBeNull()
    mkdirSync(join(dir, 'empty')); process.env.PATH = join(dir, 'empty')
    expect(await detectDocker()).toMatchObject({ present: false, running: false, kind: 'none' })
    const d = deps(); d.flag = () => false
    expect((await envStatus({}, d)).decision).toMatchObject({ backend: 'namespace', reason: 'flag-off', line: '', suggest: null })
    expect(await envUse({ backend: 'docker' }, d)).toEqual({ ok: false, error: 'flag_off' })
    expect(d.saved).toEqual({})
  } finally { process.env.PATH = previous; rmSync(dir, { recursive: true, force: true }) }
})

test('public and default LAN deny every env verb; LAN opt-in preserves existing policy', () => {
  for (const profile of ['public', 'lan'] as const) {
    const caps = capabilitiesFor(profile, { exposure: profile, allowLocalShell: false, tls: false })
    for (const verb of ['status', 'use', 'grant', 'install']) expect(capabilityDenied(routeCapability(`/api/env/${verb}`)!, caps)?.status).toBe(403)
  }
  const optedIn = capabilitiesFor('lan', { exposure: 'lan', allowLocalShell: true, tls: false })
  expect(capabilityDenied('localShell', optedIn)).toBeNull()
})

test('SECURITY expected: an unauthenticated HTTP write must be refused', async () => {
  const d = deps()
  const req = new Request('http://localhost/api/env/use', { method: 'POST', body: JSON.stringify({ backend: 'docker' }) })
  const r = await handleEnvRequest(req, new URL(req.url), d)
  console.log('NO_PROOF_HTTP', JSON.stringify({ status: r?.status, body: r?.body, persisted: d.saved }))
  expect(r!.status).toBeGreaterThanOrEqual(400)
})

test('MCP real stdio: verified worker denied; missing identity key must fail closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-s1-mcp-'))
  const d = deps()
  let received: unknown
  const api = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/api/env/use') {
      received = await req.clone().json()
      const r = await handleEnvRequest(req, url, d)
      return Response.json(r!.body, { status: r!.status })
    }
    return Response.json({ tools: [] })
  } })
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(import.meta.dir, '../../mcp/agentistics-mcp.ts')],
    env: { PATH: process.env.PATH!, HOME: root, AGENTISTICS_DIR: root, AGENTOP_MANAGED_ID: 'worker', AGENTISTICS_API: `http://127.0.0.1:${api.port}` }, stderr: 'pipe' })
  const client = new Client({ name: 'qa-docker-s1', version: '1' })
  try {
    // Generated fixture key only; never any production credential.
    writeFileSync(join(root, 'session-identity.key'), '11'.repeat(32))
    d.verify = async () => 'worker'; d.caller = async () => 'session'
    await client.connect(transport)
    const refused = await client.callTool({ name: 'agentistics_env_use', arguments: { backend: 'docker' } })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused)).toContain('leader_only')
    rmSync(join(root, 'session-identity.key'))
    const missingKey = await client.callTool({ name: 'agentistics_env_use', arguments: { backend: 'docker' } })
    console.log('MCP_MISSING_KEY', JSON.stringify({ received, reply: missingKey, persisted: d.saved }))
    expect(missingKey.isError).toBe(true)
  } finally { await client.close(); api.stop(true); rmSync(root, { recursive: true, force: true }) }
}, 15000)

test('identity: only a socket-proven person (or a verified leader) writes; unproven, session and unknown are refused', async () => {
  const post = (d: EnvDeps, body: unknown, path = '/api/env/use') => {
    const req = new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })
    return handleEnvRequest(req, new URL(req.url), d)
  }
  for (const who of ['unknown', 'session'] as const) {
    const d = deps(); d.caller = async () => who
    expect((await post(d, { backend: 'docker' }))!.status).toBe(403)
    expect((await post(d, {}, '/api/env/grant'))!.status).toBe(403)
    expect(d.saved).toEqual({})
  }
  const none = deps(); delete (none as { caller?: unknown }).caller
  expect((await post(none, { backend: 'docker' }))!.status).toBe(403)
  const person = deps(); person.caller = async () => 'person'
  expect((await post(person, { backend: 'docker' }))!.status).toBe(200)
  expect((await post(person, {}, '/api/env/grant'))!.status).toBe(501)
  const leader = deps(); leader.roleOf = async () => 'leader'
  expect((await post(leader, { backend: 'docker', session: { id: 'L', token: 'ok' } }))!.status).toBe(200)
})

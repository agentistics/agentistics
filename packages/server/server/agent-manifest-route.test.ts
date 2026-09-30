/**
 * agent-manifest-route.test.ts — GET /api/agent/manifest answers from the REAL server (MCP spec
 * P1.3), under the profile it was booted with. Booted on `lan` with no local-shell opt-in, so every
 * host capability is off — the case the manifest exists for: the answer must still come back (the
 * route is host-free), and it must withhold the host tools with a reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import type { AgentManifest } from '@agentistics/core'

const root = mkdtempSync(join(tmpdir(), 'agentistics-agent-manifest-'))
const home = join(root, 'home')
const port = 20000 + Math.floor(Math.random() * 20000)
let server: Subprocess | null = null

beforeAll(async () => {
  mkdirSync(join(home, '.agentistics'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.agentistics', 'preferences.json'), JSON.stringify({ archiveMode: 'off' }))
  server = Bun.spawn([process.execPath, join(import.meta.dir, 'index.ts')], {
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      AGENTISTICS_EXPOSURE: 'lan',
      AGENTISTICS_ALLOW_LOCAL_SHELL: '',
      AGENTISTICS_TEAM_CENTRAL: '',
      SERVE_STATIC: '',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return
    } catch { /* not up yet */ }
    await Bun.sleep(200)
  }
  throw new Error('server did not come up')
}, 40_000)

afterAll(() => {
  server?.kill()
  rmSync(root, { recursive: true, force: true })
})

describe('GET /api/agent/manifest', () => {
  it('answers with every host capability off, and withholds the host tools in words', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/manifest`)
    expect(res.status).toBe(200)
    const m = await res.json() as AgentManifest
    expect(m.version).toBe(1)
    expect(m.profile).toBe('lan')
    expect(m.central).toBe(false)
    expect(Object.values(m.capabilities).every((v) => v === false)).toBe(true)
    expect(m.gates).toEqual({ chat: false, shell: false, editor: false })
    const byName = new Map(m.tools.map((t) => [t.name, t]))
    expect(byName.get('agentistics_tasks')).toMatchObject({ available: false, withheld: { code: 'capability', capability: 'localShell' } })
    expect(byName.get('agentistics_summary')!.available).toBe(true)
    expect(byName.get('agentistics_capabilities')!.available).toBe(true)
  })

  it('refuses a write method', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/manifest`, { method: 'POST' })
    expect(res.status).not.toBe(200)
  })
})

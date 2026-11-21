/**
 * browser-profiles-wiring.test.ts — S12 r2: "Delete profiles" is person-only AS `index.ts` wires it.
 *
 * `browser-lock-route.test.ts` injects a caller into the route, so it passed while `index.ts` never read the
 * caller for this path (QA: no proof → 200 `removed:2`). This boots the REAL `server/index.ts` in a subprocess
 * (isolated HOME) and asks the door itself: with the path dropped from `routeNeedsCaller` the route sees no
 * caller at all and answers `why: 'no-peer'`, which a socket-read verdict never says.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import { routeNeedsCaller } from './browser/personal-doors'

const root = mkdtempSync(join(tmpdir(), 'agentistics-browser-profiles-wiring-'))
const home = join(root, 'home')
const port = 20000 + Math.floor(Math.random() * 20000)
let server: Subprocess | null = null

beforeAll(async () => {
  mkdirSync(join(home, '.agentistics'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.agentistics', 'preferences.json'), JSON.stringify({ archiveMode: 'off' }))
  server = Bun.spawn([process.execPath, join(import.meta.dir, 'index.ts')], {
    env: { ...process.env, HOME: home, AGENTISTICS_ENGINE: '0', AGENTISTICS_EXPOSURE: 'local', SERVE_STATIC: '', PORT: String(port) },
    stdout: 'ignore', stderr: 'pipe',
  })
  // Drained while it runs (a full pipe would stall the server); read only when it fails to come up.
  const stderrText = new Response(server.stderr as ReadableStream).text()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return } catch { /* not up yet */ }
    await Bun.sleep(200)
  }
  server.kill()
  const err = await stderrText
  // A fresh worktree without engine-slot.generated.ts (`bun run stub`) is the usual cause; show it.
  throw new Error(`server did not come up\n${err.slice(-2000)}`)
}, 40_000)

afterAll(() => {
  server?.kill()
  rmSync(root, { recursive: true, force: true })
})

describe('index.ts reads the caller for POST /api/browser/profiles/delete', () => {
  it('the path is in the list of person-only doors, and index.ts uses that list', () => {
    expect(routeNeedsCaller('/api/browser/profiles/delete')).toBe(true)
    expect(routeNeedsCaller('/api/browser/lock')).toBe(true)
    expect(routeNeedsCaller('/api/browser/personal/click')).toBe(true)
    expect(routeNeedsCaller('/api/browser/status')).toBe(false)
    expect(readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')).toContain('routeNeedsCaller(url.pathname)')
  })

  it('the live door identifies the caller from the socket (never the fallback "no-peer"), and a forged session proof does not open it', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/browser/profiles/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: { id: 'agentop-forged0001', token: 'forged' } }),
    })
    const body = (await res.json()) as { why?: string; error?: string }
    // Not the route's own fail-closed fallback: that is what a path missing from the caller list produces.
    expect(body.why).not.toBe('no-peer')
    if (res.status === 403) expect(body.error).toMatch(/session_cannot_unlock|caller_unidentified/)
  })
})

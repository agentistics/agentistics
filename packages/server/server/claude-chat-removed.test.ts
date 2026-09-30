/**
 * claude-chat-removed.test.ts — POST /api/claude-chat no longer exists.
 *
 * It was an older, Claude-only duplicate of /api/chat-tty that no client called once Nay became real
 * sessions, and it spawned `claude` on the host with no capability-guard entry and no chat switch.
 * The fix was to delete it, so this test boots the REAL server in a subprocess — an isolated HOME
 * with the chat switch ON and the `local` profile, the exact conditions under which the old route
 * would have spawned — with a fake `claude` first on PATH that leaves a marker if it is ever run.
 * The route must answer the generic 404, and the marker must never appear.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'

const root = mkdtempSync(join(tmpdir(), 'agentistics-claude-chat-removed-'))
const home = join(root, 'home')
const bin = join(root, 'bin')
const invocations = join(root, 'claude-invocations.log')
const port = 20000 + Math.floor(Math.random() * 20000)
let server: Subprocess | null = null

function claudeRuns(): string[] {
  return existsSync(invocations) ? readFileSync(invocations, 'utf8').split('\n').filter(Boolean) : []
}

beforeAll(async () => {
  mkdirSync(join(home, '.agentistics'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  // Chat ON: the old route's only gate was the absence of one, so this is where it spawned.
  writeFileSync(join(home, '.agentistics', 'preferences.json'), JSON.stringify({ chatEnabled: true, archiveMode: 'off' }))
  mkdirSync(bin, { recursive: true })
  const fake = join(bin, 'claude')
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> '${invocations}'\n`)
  chmodSync(fake, 0o755)

  server = Bun.spawn([process.execPath, join(import.meta.dir, 'index.ts')], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PORT: String(port),
      AGENTISTICS_EXPOSURE: 'local',
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

describe('POST /api/claude-chat', () => {
  it('answers the generic 404 and spawns nothing', async () => {
    // Let the boot-time runs settle so they are not mistaken for the request's.
    await Bun.sleep(1500)
    const before = claudeRuns()
    const res = await fetch(`http://127.0.0.1:${port}/api/claude-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not Found' })
    // Give a spawn that should not exist time to have happened anyway.
    await Bun.sleep(1500)
    const after = claudeRuns()
    expect(after).toEqual(before)
    expect(after.filter(argv => argv.includes('--print'))).toEqual([])
    // Its scratch directory is no longer created at boot either.
    expect(existsSync(join(home, '.agentistics', 'claude-chat'))).toBe(false)
  }, 15_000)
})

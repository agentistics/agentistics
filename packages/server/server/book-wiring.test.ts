/**
 * book-wiring.test.ts — the Livro seam as the REAL server and the REAL bin wire it (LIVRO.SEAMS B4).
 *
 * `book-routes.test.ts` exercises `handleBookRoutes` with deps the test builds itself, so it passes even when
 * `index.ts` never calls it. This file boots `server/index.ts` in a subprocess (isolated HOME, `local`
 * profile, engine switched off so the answer does not depend on this checkout's slot) and spawns
 * `bin/cli.ts book`, so removing either piece of wiring fails here: the routes fall through to the generic
 * 404, and the verb stops answering with the book's sentence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'

const root = mkdtempSync(join(tmpdir(), 'agentistics-book-wiring-'))
const home = join(root, 'home')
const port = 20000 + Math.floor(Math.random() * 20000)
let server: Subprocess | null = null

const env = (): Record<string, string | undefined> => ({
  ...process.env,
  HOME: home,
  AGENTISTICS_ENGINE: '0',
  AGENTISTICS_EXPOSURE: 'local',
  SERVE_STATIC: '',
})

beforeAll(async () => {
  mkdirSync(join(home, '.agentistics'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.agentistics', 'preferences.json'), JSON.stringify({ archiveMode: 'off' }))
  server = Bun.spawn([process.execPath, join(import.meta.dir, 'index.ts')], {
    env: { ...env(), PORT: String(port) },
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

const post = (path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('index.ts routes /api/book/* and /api/flow/op/* through handleBookRoutes', () => {
  it('POST /api/book/takeover answers the explicit 501, never 405 or the generic 404', async () => {
    const res = await post('/api/book/takeover', { taskId: 't', sessionId: 's', hmac: 'h' })
    expect(res.status).toBe(501)
    expect(await res.json()).toEqual({ ok: false, error: 'not-implemented', sentence: 'book takeover is not available yet' })
  })

  it('without a book capability /api/book/* and /api/flow/op/* answer 501 "book not available in this build"', async () => {
    for (const res of [
      await fetch(`http://127.0.0.1:${port}/api/book/page/pg-x?includeBody=true`),
      await post('/api/flow/op/livro-ler', { stdin: '{}' }),
    ]) {
      expect(res.status).toBe(501)
      expect(await res.json()).toEqual({ error: 'book not available in this build', sentence: 'book not available in this build' })
    }
  })

  it('a neighbouring path is not captured by the book routes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/bookshelf`)
    expect(res.status).toBe(404)
  })

  it('no book file was created by the server for any of it', () => {
    expect(existsSync(join(home, '.agentistics', 'flows', 'livro.db'))).toBe(false)
  })
})

describe('bin/cli.ts dispatches `agentop book`', () => {
  const runCli = (args: string[]) => {
    const p = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'bin', 'cli.ts'), ...args], {
      env: env(), stdout: 'pipe', stderr: 'pipe',
    })
    return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}` }
  }

  it('`agentop book` and `agentop book page x` refuse with the book sentence, exit 2', () => {
    for (const args of [['book'], ['book', 'page', 'pg-x', '--body']]) {
      const r = runCli(args)
      expect(r.code).toBe(2)
      expect(r.out).toContain('book not available in this build')
    }
  }, 30_000)
})

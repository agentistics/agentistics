/**
 * SESSAO.AVISO-NA-THREAD r3 — a `notice` thread keeps its kind through the REAL `/api/tasks` (server booted in a child
 * process with its own HOME and data dir): the route accepts it and the store's read path does not rebase it to `topic`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'

const SERVER_INDEX = join(import.meta.dir, '..', 'index.ts')
const EX_TEMPFAIL = 75 // index.ts exits with this when its port is already in use

let root = ''
let base = ''
let proc: Subprocess | undefined

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'notice-thread-'))
  const home = join(root, 'home')
  const dir = join(home, '.agentistics')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(dir, 'preferences.json'), JSON.stringify({ archiveMode: 'off' }))
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const child = Bun.spawn([process.execPath, SERVER_INDEX], {
      env: { ...process.env, HOME: home, AGENTISTICS_DIR: dir, AGENTISTICS_ENGINE: '0', AGENTISTICS_EXPOSURE: 'local', AGENTISTICS_FLOWS: '', SERVE_STATIC: '', PORT: String(port) },
      stdout: 'ignore', stderr: 'ignore',
    })
    proc = child
    base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline && child.exitCode === null) {
      try { if ((await fetch(`${base}/api/health`)).ok) return } catch { /* not up yet */ }
      await Bun.sleep(200)
    }
    if (child.exitCode !== EX_TEMPFAIL) break
  }
  throw new Error('the server did not come up')
}, 60_000)

afterAll(async () => { proc?.kill(); await proc?.exited; rmSync(root, { recursive: true, force: true }) })

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) })
  return await res.json() as Record<string, unknown>
}

describe('kind=notice through /api/tasks', () => {
  test('both doors that open a thread keep it, and reading the task returns it', async () => {
    const created = await post('/api/tasks', { title: 'notice-kind' })
    const id = (created.id ?? (created.task as { id?: string } | undefined)?.id) as string
    expect(typeof id).toBe('string')
    expect(await post(`/api/tasks/${id}/comments`, { author: 'me', body: 'FYI', newThread: { title: 'via comment', kind: 'notice' } })).toMatchObject({ ok: true })
    expect(await post(`/api/tasks/${id}/threads`, { action: 'open', title: 'via open', kind: 'notice' })).toMatchObject({ ok: true })

    const detail = await (await fetch(`${base}/api/tasks/${id}`)).text()
    const kinds = new Map<string, string>()
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return }
      if (!v || typeof v !== 'object') return
      const o = v as Record<string, unknown>
      if (typeof o.title === 'string' && typeof o.kind === 'string') kinds.set(o.title, o.kind)
      Object.values(o).forEach(walk)
    }
    walk(JSON.parse(detail))
    expect(kinds.get('via comment')).toBe('notice')
    expect(kinds.get('via open')).toBe('notice')
  }, 30_000)
})

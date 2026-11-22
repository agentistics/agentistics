/** Live REST regression: contention is an answer, and an accepted concurrent write survives a sweep. */
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gitTestEnv } from '../../../core/src/gitTestEnv'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { createGuardsStore } from './guards-store'
import { lockFile } from '../sessions/file-lock'

test('S2B-8 live comment contention is 409 JSON; no accepted comment is lost racing a sweep', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sweep-r2-rest-'))
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = reservation.port!
  reservation.stop(true)
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../index.ts')], {
    env: { ...gitTestEnv(), HOME: root, AGENTISTICS_DIR: root, PORT: String(port), SERVE_STATIC: '0', AGENTISTICS_TELEMETRY: '0', NODE_ENV: 'test' }, stdout: 'ignore', stderr: 'pipe',
  })
  const errors = new Response(proc.stderr).text()
  const base = `http://127.0.0.1:${port}`
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, type: res.headers.get('content-type'), body: await res.json() as any }
  }
  try {
    let ready = false
    for (let i = 0; i < 400 && !ready; i++) {
      try { ready = (await fetch(`${base}/api/tasks/statuses`)).ok } catch {}
      if (proc.exitCode !== null) throw new Error(await errors)
      if (!ready) await Bun.sleep(50)
    }
    expect(ready).toBe(true)
    const t = (await call('/api/tasks', { title: 'sweep race' })).body.task.id
    expect((await call('/api/tasks/statuses', { label: 'Abandoned', color: '#112233' })).status).toBe(200)
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push((await call(`/api/tasks/${t}/subtasks`, { title: `piece ${i}` })).body.id)
    const now = Date.now(), at = new Date(now).toISOString()
    const g = createGuaranteesStore(join(root, 'guarantees.json'))
    const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
    const facts = (time: number): ActivationFacts => ({ now: new Date(time).toISOString(), build: 'r2', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'], unexplainedWouldRefuse: 0 })
    expect(await g.setState('a', 'shadow', { check, facts: facts(now - 25 * 3600_000) })).toEqual({ ok: true })
    expect(await g.setState('a', 'on', { check, facts: facts(now) })).toEqual({ ok: true })
    const gs = createGuardsStore(join(root, 'guards.json'))
    await gs.write({ ...(await gs.read()), migrations: { a: { version: 1, at } }, checkpoints: Object.fromEntries(ids.map(key => [key, { key, rank: 0, boardStatus: 'in_progress', boardStage: 'running', phase: null, revision: 0, headSha: null, auth: [{ kind: 'grandfathered' as const, at }], by: { kind: 'flow' }, at, transitionId: key }])) })
    // Reads can also acquire the envelope when a legacy vocabulary must be seeded.
    const legacy = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8'))
    const vocabulary = legacy.statuses
    legacy.statuses = []
    writeFileSync(join(root, 'tasks.json'), JSON.stringify(legacy))
    const lock = await lockFile(join(root, 'tasks.json'))
    try {
      const cli = Bun.spawn([process.execPath, join(import.meta.dir, '../../bin/cli.ts'), 'task', 'abandon', t, '--json'], { env: { ...gitTestEnv(), HOME: root, AGENTISTICS_DIR: root }, stdout: 'pipe', stderr: 'pipe' })
      const reader = Bun.spawn([process.execPath, join(import.meta.dir, '../../bin/cli.ts'), 'task', 'ls', '--json'], { env: { ...gitTestEnv(), HOME: root, AGENTISTICS_DIR: root }, stdout: 'pipe', stderr: 'pipe' })
      const [busy, exit, stdout, stderr, readExit, readOut, readErr] = await Promise.all([
        call(`/api/tasks/${t}/comments`, { author: 'probe', body: 'contended' }), cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text(), reader.exited, new Response(reader.stdout).text(), new Response(reader.stderr).text(),
      ])
      expect(busy.status).toBe(409)
      expect(busy.type).toContain('application/json')
      expect(busy.body).toMatchObject({ error: 'guard_busy', code: 'guard_busy' })
      expect(busy.body.sentence).toContain('retry')
      expect(busy.body.sentencePt).toContain('tente de novo')
      expect(exit, stdout + stderr).toBe(2)
      expect(stdout + stderr).toContain('guard_busy')
      expect(stdout + stderr).toContain('retry')
      expect(readExit, readOut + readErr).toBe(2)
      expect(readOut + readErr).toContain('guard_busy')
      expect(readOut + readErr).toContain('retry')
      expect(readOut + readErr).not.toContain('at <anonymous>')
    } finally { await lock.release() }
    const book = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8'))
    book.statuses = vocabulary
    // R3's breaker counts every revert kind. Keep this race below five percent so it actually applies all chunks.
    book.tasks.push(...Array.from({ length: 240 }, (_, i) => ({ id: `quiet-${i}`, title: 'quiet', status: 'in_progress', createdAt: at, updatedAt: at })))
    book.subtasks = book.subtasks.map((s: any) => ({ ...s, status: 'in_review' }))
    writeFileSync(join(root, 'tasks.json'), JSON.stringify(book))
    const pendingTick = call('/api/deliveries/tick', {})
    const writes = await Promise.all(Array.from({ length: 24 }, (_, i) => call(`/api/tasks/${t}/comments`, { author: 'probe', body: `accepted-race-${i}` })))
    await pendingTick
    const saved = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8'))
    let accepted = 0
    for (const [i, r] of writes.entries()) {
      if (r.status === 200) { accepted++; expect(saved.comments.some((c: any) => c.body === `accepted-race-${i}`)).toBe(true) }
      else expect(r.status).toBe(409)
    }
    expect(accepted).toBeGreaterThan(0)
    expect(saved.subtasks.every((s: any) => s.status === 'in_progress')).toBe(true)
    console.log(`S2B-8 REST race: ${accepted}/24 accepted, all persisted`)
  } finally {
    proc.kill(); await proc.exited; await errors.catch(() => '')
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)

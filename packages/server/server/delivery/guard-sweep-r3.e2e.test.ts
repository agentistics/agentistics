/** The live re-QA member moves, through the real REST doors on this checkout. */
import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '../../../core/src/gitTestEnv'
import { createGuaranteesStore, type ActivationFacts } from './activation'
import { createGuardsStore } from './guards-store'
import { createSessionRegistry } from '../sessions/registry'
import { sessionToken } from '../sessions/session-identity'

test('R2-1 REST owner and proven leader member completions survive successive real ticks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sweep-r3-rest-'))
  const key = randomBytes(32)
  writeFileSync(join(root, 'session-identity.key'), key.toString('hex'), { mode: 0o600 })
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = reservation.port!
  reservation.stop(true)
  const base = `http://127.0.0.1:${port}`
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../index.ts')], {
    env: { ...gitTestEnv(), HOME: root, AGENTISTICS_DIR: root, PORT: String(port), SERVE_STATIC: '0', AGENTISTICS_TELEMETRY: '0', NODE_ENV: 'test' }, stdout: 'ignore', stderr: 'pipe',
  })
  const errors = new Response(proc.stderr).text()
  const post = async (path: string, body: unknown, owner = false) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(owner ? { origin: base, 'sec-fetch-site': 'same-origin' } : {}) }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as any }
  }
  try {
    let ready = false
    for (let i = 0; i < 400 && !ready; i++) {
      try { ready = (await fetch(base + '/api/tasks/statuses')).ok } catch {}
      if (proc.exitCode !== null) throw new Error(await errors)
      if (!ready) await Bun.sleep(50)
    }
    expect(ready).toBe(true)
    const task = (await post('/api/tasks', { title: 'legitimate members' })).body.task.id
    const group = (await post(`/api/tasks/${task}/subtasks`, { title: 'group', isGroup: true })).body.id
    const members: string[] = []
    for (let i = 0; i < 3; i++) {
      const id = (await post(`/api/tasks/${task}/subtasks`, { title: `member ${i}` })).body.id
      expect((await post(`/api/tasks/${task}/subtasks`, { id, parentGroupId: group })).status).toBe(200)
      members.push(id)
    }
    const registry = createSessionRegistry(join(root, 'managed-sessions.json'))
    await registry.add({ id: 'r3-leader', harness: 'claude', role: 'leader', taskId: task, cwd: root, createdAt: new Date().toISOString() } as never)
    const now = Date.now(), at = new Date(now).toISOString()
    const check = async () => ({ ok: true as const, via: 'legacy-browser' as const })
    const facts = (n: number): ActivationFacts => ({ now: new Date(n).toISOString(), build: 'r3', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'], unexplainedWouldRefuse: 0 })
    const policy = createGuaranteesStore(join(root, 'guarantees.json'))
    expect(await policy.setState('a', 'shadow', { check, facts: facts(now - 25 * 3600_000) })).toEqual({ ok: true })
    expect(await policy.setState('a', 'on', { check, facts: facts(now) })).toEqual({ ok: true })
    const guards = createGuardsStore(join(root, 'guards.json'))
    await guards.write({ ...(await guards.read()), migrations: { a: { version: 1, at } }, checkpoints: { [group]: { key: group, rank: 0, boardStatus: 'in_progress', boardStage: 'running', phase: null, revision: 0, headSha: null, auth: [{ kind: 'grandfathered', at }], by: { kind: 'flow' }, at, transitionId: group } } })
    expect((await post(`/api/tasks/${task}/subtasks`, { id: members[0], status: 'done' }, true)).status).toBe(200)
    expect((await post(`/api/tasks/${task}/subtasks`, { id: members[1], status: 'done', session: { id: 'r3-leader', token: sessionToken(key, 'r3-leader') } })).status).toBe(200)
    for (let i = 0; i < 3; i++) {
      const tick = await post('/api/deliveries/tick', {})
      expect(tick.status).toBe(200)
      expect(JSON.stringify(tick.body)).not.toContain('sweep-revert')
    }
    const book = JSON.parse(readFileSync(join(root, 'tasks.json'), 'utf8'))
    expect(members.slice(0, 2).map(id => book.subtasks.find((s: any) => s.id === id).status)).toEqual(['done', 'done'])
    expect(book.subtasks.find((s: any) => s.id === members[2]).status).toBe('todo')
    expect((await guards.read()).sweep?.reverts ?? {}).toEqual({})
    console.log('R2-1 live REST: owner and verified leader completions retained across three ticks')
  } finally { proc.kill(); await proc.exited; await errors.catch(() => ''); rmSync(root, { recursive: true, force: true }) }
}, 90_000)

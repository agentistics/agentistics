import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * only a LEADER session is filed on the task itself (a worker needs a subtask).
 *
 * `patchSubtask`/`setSubtaskDone`/`markTask` all call `loadTaskWorld()`, which is hardcoded to the
 * module-level `TASKS_FILE`/`MANAGED_SESSIONS_FILE` in `config.ts` — values computed once at module
 * load from `process.env` (see `config-datadir.test.ts`'s own docstring: they cannot be re-derived
 * by mutating `process.env` inside THIS process, because `config.ts` has almost certainly already
 * been imported by an earlier test file in the same `bun test` run). So each scenario runs in its
 * OWN process, pointed at its own `AGENTISTICS_DIR`, the same shape `registry-concurrency.test.ts`
 * and `config-datadir.test.ts` use.
 */

const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-leader-only-'))
  const script = `
    const cfg = await import(${JSON.stringify(join(SESSIONS_DIR, '..', 'config.ts'))})
    const { createTaskStore } = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-store.ts'))})
    const { createSessionRegistry } = await import(${JSON.stringify(join(SESSIONS_DIR, 'registry.ts'))})
    const web = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-web.ts'))})
    const store = createTaskStore(cfg.TASKS_FILE)
    const registry = createSessionRegistry(cfg.MANAGED_SESSIONS_FILE)
    ${body}
  `
  const proc = Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, AGENTISTICS_DIR: dir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`script failed (${code}): ${err.trim().split('\n').slice(-8).join(' | ')}`)
  }
  const line = out.trim().split('\n').filter(Boolean).at(-1) ?? '{}'
  return JSON.parse(line)
}

const task = (id: string, over = '') => `
  await store.upsertTask({
    id: '${id}', title: '${id}', status: 'todo',
    createdAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:00.000Z',
    ${over}
  })
`
const subtask = (id: string, taskId: string, over = '') => `
  await store.upsertSubtask({
    id: '${id}', taskId: '${taskId}', title: '${id}', status: 'todo', done: false,
    createdAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:00.000Z',
    ${over}
  })
`
const session = (id: string, over = '') => `
  await registry.add({
    id: '${id}', harness: 'claude', cwd: '/tmp/x',
    createdAt: '2026-09-11T10:00:00.000Z',
    ${over}
  })
`

test('a worker is refused on the task itself, with the sentence; a legacy direct filing stays', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${session('legacy', "parentSessionId: 'p', taskId: 't1',")}
    ${session('w1', "parentSessionId: 'p',")}
    const refused = await web.attachSession('t1', 'w1')
    const onSub = await web.attachSession('t1', 'w1', { subtaskId: 's1' })
    const rows = await registry.read()
    console.log(JSON.stringify({ refused, onSub, legacy: rows.find(r => r.id === 'legacy').taskId }))
  `) as { refused: unknown; onSub: unknown; legacy: string }
  expect(out.refused).toEqual({ ok: false, reason: 'leader_only', message: 'only leader sessions are filed on the task itself; file this session on a subtask' })
  expect(out.onSub).toEqual({ ok: true })
  expect(out.legacy).toBe('t1')
})

test('a leader (stored role) and a person session are accepted on the task; promotion keeps the filing', async () => {
  const out = await run(`
    const { writeFile } = await import('node:fs/promises')
    await writeFile(cfg.AGENTISTICS_DATA_DIR + '/session-roles.json', JSON.stringify({ version: 1, migrated: true, roles: { lead: 'leader' } }))
    ${task('t1')}
    ${session('lead', "parentSessionId: 'p',")}
    ${session('person')}
    const a = await web.attachSession('t1', 'lead')
    const b = await web.attachSession('t1', 'person')
    console.log(JSON.stringify({ a, b }))
  `)
  expect(out).toEqual({ a: { ok: true }, b: { ok: true } })
})

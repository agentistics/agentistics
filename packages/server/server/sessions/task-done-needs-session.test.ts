import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `done` requires a session filed under the task/subtask — see
 * docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §A.2/§A.3.
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
  const dir = await mkdtemp(join(tmpdir(), 'agentop-done-needs-session-'))
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

test('setSubtaskDone refuses a subtask with NO session filed under it', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    const result = await web.setSubtaskDone('s1', true)
    const after = await store.read()
    console.log(JSON.stringify({ result, status: after.subtasks[0].status, done: after.subtasks[0].done }))
  `)
  expect(out).toEqual({ result: { ok: false, message: 'done_needs_session' }, status: 'todo', done: false })
})

test('setSubtaskDone succeeds once a session is filed under THAT subtask', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${session('sess1', "taskId: 't1', subtaskId: 's1',")}
    const result = await web.setSubtaskDone('s1', true)
    const after = await store.read()
    console.log(JSON.stringify({ result, status: after.subtasks[0].status, done: after.subtasks[0].done }))
  `)
  expect(out).toEqual({ result: { ok: true }, status: 'done', done: true })
})

test('patchSubtask refuses an unknown subtask id', async () => {
  const out = await run(`
    const result = await web.patchSubtask('nope', { status: 'done' })
    console.log(JSON.stringify({ result }))
  `)
  expect(out).toEqual({ result: { ok: false, message: 'no_such_subtask' } })
})

test('patchSubtask does not re-trigger the check on a patch that is not a move INTO done', async () => {
  // The subtask is already `done`, with no session — seeded directly, bypassing the check, the way
  // a record from before this rule existed would read. Editing its due date must still succeed: the
  // guard is `found.status !== 'done'`, so a patch that is not actually a transition into `done`
  // (this one leaves status alone) must never re-run it.
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1', "status: 'done', done: true,")}
    const result = await web.patchSubtask('s1', { dueDate: '2026-09-20' })
    const after = await store.read()
    console.log(JSON.stringify({ result, dueDate: after.subtasks[0].dueDate }))
  `)
  expect(out).toEqual({ result: { ok: true }, dueDate: '2026-09-20' })
})

test('patchSubtask allows moving to a non-done status with no session at all', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    const result = await web.patchSubtask('s1', { status: 'in_progress' })
    const after = await store.read()
    console.log(JSON.stringify({ result, status: after.subtasks[0].status }))
  `)
  expect(out).toEqual({ result: { ok: true }, status: 'in_progress' })
})

test('markTask refuses `done` on a task with zero sessions anywhere under it — and writes nothing', async () => {
  const out = await run(`
    ${task('t1')}
    const result = await web.markTask('t1', 'done')
    const after = await store.read()
    console.log(JSON.stringify({ result, status: after.tasks[0].status }))
  `)
  expect(out).toEqual({ result: { ok: false, message: 'done_needs_session' }, status: 'todo' })
})

test('markTask allows `done` on a task with a session filed DIRECTLY under it', async () => {
  const out = await run(`
    ${task('t1')}
    ${session('sess1', "taskId: 't1',")}
    const result = await web.markTask('t1', 'done')
    const after = await store.read()
    console.log(JSON.stringify({ ok: result.ok, status: after.tasks[0].status }))
  `)
  expect(out).toEqual({ ok: true, status: 'done' })
})

test('markTask allows `done` when the only session is filed under one of its SUBTASKS — no extra logic needed (§A.3)', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${session('sess1', "taskId: 't1', subtaskId: 's1',")}
    const result = await web.markTask('t1', 'done')
    const after = await store.read()
    console.log(JSON.stringify({ ok: result.ok, status: after.tasks[0].status }))
  `)
  expect(out).toEqual({ ok: true, status: 'done' })
})

test('markTask does not re-trigger the check on an already-done task, even once its sessions are gone', async () => {
  const out = await run(`
    ${task('t1', "status: 'done',")}
    const result = await web.markTask('t1', 'done')
    console.log(JSON.stringify({ ok: result.ok }))
  `)
  expect(out).toEqual({ ok: true })
})

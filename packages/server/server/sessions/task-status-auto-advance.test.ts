import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A subtask (or group member, §F.1) that actually STARTS work nudges its still-unstarted PARENT
 * task forward to `in_progress` — the same one-directional, forward-only rule `statusAfterAttach`
 * already applies when a session is filed directly on a task. See `statusAfterSubtaskProgress` in
 * `task-model.ts` for the pure decision and `patchSubtask` in `task-web.ts` for where it is wired
 * in. Reported directly: "mudei uma subtask pra 'em andamento' e o status da task pai simplesmente
 * continuou em 'a fazer'".
 *
 * Same process-isolation shape as `task-done-needs-session.test.ts` — `loadTaskWorld()` is hardcoded
 * to module-level file paths resolved once from `process.env`, so each scenario runs in its own
 * process pointed at its own `AGENTISTICS_DIR`.
 *
 * `setSubtaskDone` and the MCP tool (`agentistics_task_subtask`) both resolve to the very same
 * `patchSubtask` this file exercises directly — `setSubtaskDone` calls it in-process
 * (`task-web.ts`), and the MCP tool is a thin HTTP client of the identical
 * `POST /api/tasks/:ref/subtasks` route `index.ts` hands to `patchSubtask`/`setSubtaskDone`. There
 * is exactly ONE underlying function; a second suite driving the MCP tool's own code would be
 * exercising the same route body again, not a different code path.
 */

const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-subtask-auto-advance-'))
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
    createdAt: '2026-09-19T10:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
    ${over}
  })
`
const subtask = (id: string, taskId: string, over = '') => `
  await store.upsertSubtask({
    id: '${id}', taskId: '${taskId}', title: '${id}', status: 'todo', done: false,
    createdAt: '2026-09-19T10:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
    ${over}
  })
`
const session = (id: string, over = '') => `
  await registry.add({
    id: '${id}', harness: 'claude', cwd: '/tmp/x',
    createdAt: '2026-09-19T10:00:00.000Z',
    ${over}
  })
`

// --- (a) subtask starts while the task is at a true starting state --------------------------

test('(a) subtask moved to in_progress advances a `todo` parent task to in_progress', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    const result = await web.patchSubtask('s1', { status: 'in_progress' })
    const after = await store.read()
    console.log(JSON.stringify({
      result, subtaskStatus: after.subtasks[0].status, taskStatus: after.tasks[0].status,
    }))
  `)
  expect(out).toEqual({
    result: { ok: true }, subtaskStatus: 'in_progress', taskStatus: 'in_progress',
  })
})

test('(a) subtask moved to in_progress advances a `backlog` parent task to in_progress too', async () => {
  const out = await run(`
    ${task('t1', "status: 'backlog',")}
    ${subtask('s1', 't1')}
    const result = await web.patchSubtask('s1', { status: 'in_progress' })
    const after = await store.read()
    console.log(JSON.stringify({ result, taskStatus: after.tasks[0].status }))
  `)
  expect(out).toEqual({ result: { ok: true }, taskStatus: 'in_progress' })
})

// --- (b) subtask starts while the task is already in_progress: no-op, no error ---------------

test('(b) subtask moved to in_progress on an already-in_progress task is a no-op', async () => {
  const out = await run(`
    ${task('t1', "status: 'in_progress',")}
    ${subtask('s1', 't1')}
    const result = await web.patchSubtask('s1', { status: 'in_progress' })
    const after = await store.read()
    console.log(JSON.stringify({
      result, taskStatus: after.tasks[0].status, taskUpdatedAt: after.tasks[0].updatedAt,
    }))
  `)
  const parsed = out as { result: unknown; taskStatus: string; taskUpdatedAt: string }
  expect(parsed.result).toEqual({ ok: true })
  expect(parsed.taskStatus).toBe('in_progress')
  // No redundant write: the task record is untouched, so its `updatedAt` still reads the seed value.
  expect(parsed.taskUpdatedAt).toBe('2026-09-19T10:00:00.000Z')
})

// --- (c) subtask starts while the task is blocked/in_review/done/abandoned: untouched ---------

for (const parentStatus of ['blocked', 'in_review', 'done', 'abandoned']) {
  test(`(c) subtask moved to in_progress never overwrites a parent task that is already '${parentStatus}'`, async () => {
    const out = await run(`
      ${task('t1', `status: '${parentStatus}',`)}
      ${subtask('s1', 't1')}
      const result = await web.patchSubtask('s1', { status: 'in_progress' })
      const after = await store.read()
      console.log(JSON.stringify({ result, taskStatus: after.tasks[0].status }))
    `)
    expect(out).toEqual({ result: { ok: true }, taskStatus: parentStatus })
  })
}

// --- (d) a subtask moving AWAY from in_progress never reverts the parent ----------------------

test('(d) a subtask moving back to todo never reverts the parent task it had advanced', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    await web.patchSubtask('s1', { status: 'in_progress' })
    const result = await web.patchSubtask('s1', { status: 'todo' })
    const after = await store.read()
    console.log(JSON.stringify({
      result, subtaskStatus: after.subtasks[0].status, taskStatus: after.tasks[0].status,
    }))
  `)
  expect(out).toEqual({
    result: { ok: true }, subtaskStatus: 'todo', taskStatus: 'in_progress',
  })
})

test('(d) a subtask moving from done back to blocked never reverts the parent task', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${session('sess1', "taskId: 't1', subtaskId: 's1',")}
    await web.patchSubtask('s1', { status: 'done' })
    const result = await web.patchSubtask('s1', { status: 'blocked' })
    const after = await store.read()
    console.log(JSON.stringify({
      result, subtaskStatus: after.subtasks[0].status, taskStatus: after.tasks[0].status,
    }))
  `)
  expect(out).toEqual({
    result: { ok: true }, subtaskStatus: 'blocked', taskStatus: 'in_progress',
  })
})

// --- (e) a GROUP MEMBER's status starting also nudges the task forward ------------------------

test('(e) a group member moved to in_progress advances the parent task exactly like an ordinary subtask', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1',")}
    const result = await web.patchSubtask('m1', { status: 'in_progress' })
    const after = await store.read()
    const member = after.subtasks.find(s => s.id === 'm1')
    console.log(JSON.stringify({ result, memberStatus: member.status, taskStatus: after.tasks[0].status }))
  `)
  expect(out).toEqual({
    result: { ok: true }, memberStatus: 'in_progress', taskStatus: 'in_progress',
  })
})

// --- done fast-path: a subtask going straight from todo to done also nudges the parent ---------

test('done-fast-path: a subtask skipping straight from todo to done (done_needs_session satisfied) also advances the parent task', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${session('sess1', "taskId: 't1', subtaskId: 's1',")}
    const result = await web.patchSubtask('s1', { status: 'done' })
    const after = await store.read()
    console.log(JSON.stringify({
      result, subtaskStatus: after.subtasks[0].status, taskStatus: after.tasks[0].status,
    }))
  `)
  expect(out).toEqual({
    result: { ok: true }, subtaskStatus: 'done', taskStatus: 'in_progress',
  })
})

test('(f) setSubtaskDone (the tick fast path) advances the parent task too — same underlying patchSubtask call', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${session('sess1', "taskId: 't1', subtaskId: 's1',")}
    const result = await web.setSubtaskDone('s1', true)
    const after = await store.read()
    console.log(JSON.stringify({
      result, subtaskStatus: after.subtasks[0].status, taskStatus: after.tasks[0].status,
    }))
  `)
  expect(out).toEqual({
    result: { ok: true }, subtaskStatus: 'done', taskStatus: 'in_progress',
  })
})

// --- editing a subtask without touching status must never fire the nudge -----------------------

test('a patch that never touches status does not trigger the nudge, even for a subtask already in_progress', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1', "status: 'in_progress',")}
    const result = await web.patchSubtask('s1', { dueDate: '2026-09-20' })
    const after = await store.read()
    console.log(JSON.stringify({ result, taskStatus: after.tasks[0].status, taskUpdatedAt: after.tasks[0].updatedAt }))
  `)
  expect(out).toEqual({
    result: { ok: true }, taskStatus: 'todo', taskUpdatedAt: '2026-09-19T10:00:00.000Z',
  })
})

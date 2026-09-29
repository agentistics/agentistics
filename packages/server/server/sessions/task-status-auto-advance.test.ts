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

// --- (b) subtask starts while the task is already in_progress: the STATUS is a no-op ----------

test('(b) subtask moved to in_progress on an already-in_progress task leaves the STATUS alone, but still stamps startedAt the first time', async () => {
  const out = await run(`
    ${task('t1', "status: 'in_progress',")}
    ${subtask('s1', 't1')}
    const result = await web.patchSubtask('s1', { status: 'in_progress' })
    const after = await store.read()
    console.log(JSON.stringify({
      result, taskStatus: after.tasks[0].status, taskStartedAt: after.tasks[0].startedAt ?? null,
    }))
  `)
  // The STATUS nudge is a no-op (`statusAfterAttach` only fires out of backlog/todo) — but
  // `startedAt` is a SEPARATE fact, stamped the first time real work is observed anywhere under
  // the task, regardless of whether its status happens to already say `in_progress`. A task that
  // reached `in_progress` some other way (created that way, or moved there by hand) never had this
  // stamped until now, so this write is real and intentional — see `marksStart`'s own note. The
  // stamp is `new Date().toISOString()` at write time, never the seed's fixed `createdAt`, so it
  // is checked for shape/presence rather than for an exact literal.
  const parsed = out as { result: unknown; taskStatus: string; taskStartedAt: string | null }
  expect(parsed.result).toEqual({ ok: true })
  expect(parsed.taskStatus).toBe('in_progress')
  expect(parsed.taskStartedAt).not.toBeNull()
  expect(parsed.taskStartedAt).not.toBe('2026-09-19T10:00:00.000Z')
})

test('(b2) a patch that repeats the status a subtask already had never re-stamps startedAt', async () => {
  const out = await run(`
    ${task('t1', "status: 'in_progress', startedAt: '2026-09-19T10:00:00.000Z',")}
    ${subtask('s1', 't1', "status: 'in_progress', startedAt: '2026-09-19T10:00:00.000Z',")}
    const result = await web.patchSubtask('s1', { status: 'in_progress' })
    const after = await store.read()
    console.log(JSON.stringify({
      result, taskUpdatedAt: after.tasks[0].updatedAt, taskStartedAt: after.tasks[0].startedAt,
    }))
  `)
  expect(out).toEqual({
    result: { ok: true },
    // Untouched: `status` did not actually change (`found.status === status`), so `marksStart`
    // never fires and no write happens at all — the record is not even read back with a new
    // `updatedAt`.
    taskUpdatedAt: '2026-09-19T10:00:00.000Z', taskStartedAt: '2026-09-19T10:00:00.000Z',
  })
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
  // TWO subtasks, deliberately: with only one, `s1` reaching `done` would make it the task's
  // ONLY top-level piece, all of them done — which now auto-delivers the task
  // (`statusAfterAllSubtasksDone`) and is exactly what this test is NOT about. `s2` stays open, so
  // this exercises the plain forward-nudge (`statusAfterSubtaskProgress`) this test was written
  // for; the auto-deliver case has its own coverage in `task-all-subtasks-done.test.ts`.
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${subtask('s2', 't1')}
    ${session('sess1', "taskId: 't1', subtaskId: 's1',")}
    await web.patchSubtask('s1', { status: 'done' })
    const result = await web.patchSubtask('s1', { status: 'blocked' })
    const after = await store.read()
    console.log(JSON.stringify({
      result, subtaskStatus: after.subtasks.find(s => s.id === 's1').status, taskStatus: after.tasks[0].status,
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
  // TWO subtasks — see (d)'s own note just above: with only one, this would auto-DELIVER the task
  // instead of merely advancing it to `in_progress`, which is a different rule with its own tests.
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${subtask('s2', 't1')}
    ${session('sess1', "taskId: 't1', subtaskId: 's1',")}
    const result = await web.patchSubtask('s1', { status: 'done' })
    const after = await store.read()
    console.log(JSON.stringify({
      result, subtaskStatus: after.subtasks.find(s => s.id === 's1').status, taskStatus: after.tasks[0].status,
    }))
  `)
  expect(out).toEqual({
    result: { ok: true }, subtaskStatus: 'done', taskStatus: 'in_progress',
  })
})

test('(f) setSubtaskDone (the tick fast path) advances the parent task too — same underlying patchSubtask call', async () => {
  // TWO subtasks — same reason as the test just above.
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${subtask('s2', 't1')}
    ${session('sess1', "taskId: 't1', subtaskId: 's1',")}
    const result = await web.setSubtaskDone('s1', true)
    const after = await store.read()
    console.log(JSON.stringify({
      result, subtaskStatus: after.subtasks.find(s => s.id === 's1').status, taskStatus: after.tasks[0].status,
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

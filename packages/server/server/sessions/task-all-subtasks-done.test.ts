import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The system-stamped `startedAt`/`deliveredAt` facts on `Task`/`Subtask`, and the auto-deliver
 * rule that fires once every one of a task's TOP-LEVEL subtasks (loose subtasks and groups — a
 * group's own MEMBERS never count separately) reaches `done`. See `task-model.ts`'s `marksStart`
 * and `statusAfterAllSubtasksDone` for the pure decisions, and `patchSubtask`/`markTask` in
 * `task-web.ts` for where they are wired in.
 *
 * Board task t-918cc82233 — a product owner asked for the plan-your-own `startDate`/`dueDate` pair
 * to be replaced by these two OBSERVED facts: "data de início deve ser preenchida automaticamente
 * ... e automaticamente deve preencher a data final quando tudo estiver 100% done".
 *
 * Same out-of-process shape as `task-status-auto-advance.test.ts` — `loadTaskWorld()` is hardcoded
 * to module-level file paths resolved once from `process.env`, so each scenario runs in its own
 * process pointed at its own `AGENTISTICS_DIR`.
 */

const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-all-subtasks-done-'))
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

// --- startedAt: stamped once, on the task's own transition or a subtask's ---------------------

test('a subtask starting stamps the parent task startedAt, once, and a later subtask starting never overwrites it', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${subtask('s2', 't1')}
    await web.patchSubtask('s1', { status: 'in_progress' })
    const mid = await store.read()
    const firstStamp = mid.tasks[0].startedAt
    await web.patchSubtask('s2', { status: 'in_progress' })
    const after = await store.read()
    console.log(JSON.stringify({
      firstStamp, unchanged: after.tasks[0].startedAt === firstStamp,
      s1StartedAt: after.subtasks.find(s => s.id === 's1').startedAt,
      s2StartedAt: after.subtasks.find(s => s.id === 's2').startedAt,
    }))
  `)
  const parsed = out as { firstStamp: string; unchanged: boolean; s1StartedAt: string; s2StartedAt: string }
  expect(typeof parsed.firstStamp).toBe('string')
  expect(parsed.firstStamp.length).toBeGreaterThan(0)
  // The SECOND subtask's own start must not push the task's earliest stamp any later.
  expect(parsed.unchanged).toBe(true)
  // Each subtask ALSO gets its own independent stamp.
  expect(typeof parsed.s1StartedAt).toBe('string')
  expect(typeof parsed.s2StartedAt).toBe('string')
})

test("the task's own direct transition to in_progress stamps startedAt too, with no subtasks involved at all", async () => {
  const out = await run(`
    ${task('t1')}
    const result = await web.markTask('t1', 'in_progress')
    const after = await store.read()
    console.log(JSON.stringify({ ok: result.ok, startedAt: after.tasks[0].startedAt ?? null }))
  `)
  const parsed = out as { ok: boolean; startedAt: string | null }
  expect(parsed.ok).toBe(true)
  expect(parsed.startedAt).not.toBeNull()
})

test('a subtask attached via a directly-filed session (statusAfterAttach) also stamps startedAt', async () => {
  const out = await run(`
    ${task('t1')}
    ${session('sess1')}
    const result = await web.attachSession('t1', 'sess1')
    const after = await store.read()
    console.log(JSON.stringify({ ok: result.ok, status: after.tasks[0].status, startedAt: after.tasks[0].startedAt ?? null }))
  `)
  const parsed = out as { ok: boolean; status: string; startedAt: string | null }
  expect(parsed.ok).toBe(true)
  expect(parsed.status).toBe('in_progress')
  expect(parsed.startedAt).not.toBeNull()
})

// --- deliveredAt: stamped once, and frozen -----------------------------------------------------

test('a subtask reaching done stamps its OWN deliveredAt, once', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${subtask('s2', 't1')}
    ${session('sess1', "taskId: 't1', subtaskId: 's1',")}
    await web.patchSubtask('s1', { status: 'done' })
    const mid = await store.read()
    const firstStamp = mid.subtasks.find(s => s.id === 's1').deliveredAt
    // Leaving and re-entering done must never slide the figure forward.
    await web.patchSubtask('s1', { status: 'todo' })
    await web.patchSubtask('s1', { status: 'done' })
    const after = await store.read()
    const finalStamp = after.subtasks.find(s => s.id === 's1').deliveredAt
    console.log(JSON.stringify({ firstStamp, finalStamp, unchanged: firstStamp === finalStamp }))
  `)
  const parsed = out as { firstStamp: string; finalStamp: string; unchanged: boolean }
  expect(typeof parsed.firstStamp).toBe('string')
  expect(parsed.unchanged).toBe(true)
})

// --- the auto-deliver rule itself ----------------------------------------------------------------

test('ALL top-level subtasks done (a GROUP counted as ONE item, never per-member) auto-delivers the task and stamps deliveredAt', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1',")}
    ${session('sess1', "taskId: 't1', subtaskId: 's1',")}
    ${session('sess2', "taskId: 't1', subtaskId: 'g1',")}
    // s1 done — the group g1 is not, so the task must NOT auto-deliver yet.
    await web.patchSubtask('s1', { status: 'done' })
    const mid = await store.read()
    const midStatus = mid.tasks[0].status
    // The group's MEMBER (m1) is left at 'todo' on purpose: a member is exempt from
    // done_needs_session and NEVER counts as a separate top-level item, so its being
    // undone must not stand in the way of the group itself closing.
    const groupResult = await web.patchSubtask('g1', { status: 'done' })
    const after = await store.read()
    console.log(JSON.stringify({
      midStatus, groupResult,
      taskStatus: after.tasks[0].status,
      deliveredAt: after.tasks[0].deliveredAt ?? null,
      memberStatus: after.subtasks.find(s => s.id === 'm1').status,
    }))
  `)
  const parsed = out as {
    midStatus: string; groupResult: { ok: boolean }; taskStatus: string
    deliveredAt: string | null; memberStatus: string
  }
  expect(parsed.midStatus).not.toBe('done')
  expect(parsed.groupResult.ok).toBe(true)
  expect(parsed.taskStatus).toBe('done')
  expect(parsed.deliveredAt).not.toBeNull()
  // The member was never touched — its own status is irrelevant to the parent closing.
  expect(parsed.memberStatus).toBe('todo')
})

test('a group whose MEMBERS are all done but whose own status is not never auto-delivers the task', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1',")}
    // A member reaches 'done' with NO session at all — exempt from done_needs_session by design.
    const result = await web.patchSubtask('m1', { status: 'done' })
    const after = await store.read()
    console.log(JSON.stringify({
      ok: result.ok, taskStatus: after.tasks[0].status, groupStatus: after.subtasks.find(s => s.id === 'g1').status,
    }))
  `)
  const parsed = out as { ok: boolean; taskStatus: string; groupStatus: string }
  expect(parsed.ok).toBe(true)
  // The GROUP itself (the only top-level item here) is still 'todo' — so the task stays open,
  // proving a member's own completion is never substituted for the group's.
  expect(parsed.groupStatus).toBe('todo')
  expect(parsed.taskStatus).not.toBe('done')
})

test('a task with NO subtasks stamps deliveredAt on the ordinary manual done move', async () => {
  const out = await run(`
    ${task('t1')}
    ${session('sess1', "taskId: 't1',")}
    const result = await web.markTask('t1', 'done')
    const after = await store.read()
    console.log(JSON.stringify({ ok: result.ok, status: after.tasks[0].status, deliveredAt: after.tasks[0].deliveredAt ?? null }))
  `)
  const parsed = out as { ok: boolean; status: string; deliveredAt: string | null }
  expect(parsed.ok).toBe(true)
  expect(parsed.status).toBe('done')
  expect(parsed.deliveredAt).not.toBeNull()
})

test('deliveredAt is frozen: re-marking an already-delivered task done again never slides the figure', async () => {
  const out = await run(`
    ${task('t1')}
    ${session('sess1', "taskId: 't1',")}
    await web.markTask('t1', 'done')
    const mid = await store.read()
    const firstStamp = mid.tasks[0].deliveredAt
    const result = await web.markTask('t1', 'done')
    const after = await store.read()
    console.log(JSON.stringify({ ok: result.ok, unchanged: after.tasks[0].deliveredAt === firstStamp }))
  `)
  const parsed = out as { ok: boolean; unchanged: boolean }
  expect(parsed.ok).toBe(true)
  expect(parsed.unchanged).toBe(true)
})

// --- the auto-path and the manual done-gate can never disagree ---------------------------------

test('the auto-complete path goes through the SAME done_needs_session gate as a manual move, and the two always agree', async () => {
  // A task whose only top-level subtask is DONE, but with NO session anywhere under the task at
  // all, is structurally unreachable through the ordinary product surfaces (`done_needs_session`
  // refuses the subtask's own move to `done` first) — so the auto-path's `markTask` call can never
  // fire against an unpriced task either. This is asserted directly: attempting to reach `done` on
  // the subtask with no session filed is refused with the very same message a manual task-level
  // move would give.
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    const subtaskResult = await web.patchSubtask('s1', { status: 'done' })
    const taskResult = await web.markTask('t1', 'done')
    const after = await store.read()
    console.log(JSON.stringify({
      subtaskResult, taskResult, taskStatus: after.tasks[0].status, subtaskStatus: after.subtasks[0].status,
    }))
  `)
  expect(out).toEqual({
    subtaskResult: { ok: false, message: 'done_needs_session' },
    taskResult: { ok: false, message: 'done_needs_session' },
    taskStatus: 'todo', subtaskStatus: 'todo',
  })
})

test('once a session legitimizes the subtask done move, the auto-path succeeds through the exact same gate a manual move would', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${session('sess1', "taskId: 't1', subtaskId: 's1',")}
    const subtaskResult = await web.patchSubtask('s1', { status: 'done' })
    const after = await store.read()
    console.log(JSON.stringify({ subtaskResult, taskStatus: after.tasks[0].status }))
  `)
  expect(out).toEqual({ subtaskResult: { ok: true }, taskStatus: 'done' })
})

import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The write side of §F's subtask-group HIERARCHY (supersedes §B's shared-bucket model) —
 * docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §F:
 *
 *  - `addSubtask`'s `isGroup` option creates a GROUP.
 *  - `patchSubtask`'s `parentGroupId` joins/leaves one, refusing an invalid reference
 *    (`invalid_group`) rather than silently dropping it.
 *  - `attachSession` (via `task-attach.ts`'s `planAttach`) refuses filing a session on a group
 *    MEMBER (`subtask_in_group`) and succeeds filing on the group itself.
 *
 * Out-of-process for the same reason `task-done-needs-session.test.ts`/`subtask-groupid-patch.test.ts`
 * are: `loadTaskWorld()` reads the module-level `TASKS_FILE`/`MANAGED_SESSIONS_FILE` computed once
 * at `config.ts` load, so each scenario needs its own `AGENTISTICS_DIR` in its own process.
 */

const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-subtask-group-hierarchy-'))
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
    createdAt: '2026-09-17T10:00:00.000Z', updatedAt: '2026-09-17T10:00:00.000Z',
    ${over}
  })
`
const subtask = (id: string, taskId: string, over = '') => `
  await store.upsertSubtask({
    id: '${id}', taskId: '${taskId}', title: '${id}', status: 'todo', done: false,
    createdAt: '2026-09-17T10:00:00.000Z', updatedAt: '2026-09-17T10:00:00.000Z',
    ${over}
  })
`
const session = (id: string, over = '') => `
  await registry.add({
    id: '${id}', harness: 'claude', cwd: '/tmp/x',
    createdAt: '2026-09-17T10:00:00.000Z',
    ${over}
  })
`

test('addSubtask with isGroup:true creates a GROUP', async () => {
  const out = await run(`
    ${task('t1')}
    await web.addSubtask('t1', 'guarda-chuva', { isGroup: true })
    const after = await store.read()
    console.log(JSON.stringify({ isGroup: after.subtasks[0].isGroup ?? false }))
  `)
  expect(out).toEqual({ isGroup: true })
})

test('addSubtask with no option (or isGroup:false) creates an ordinary, loose subtask', async () => {
  const out = await run(`
    ${task('t1')}
    await web.addSubtask('t1', 'peça normal')
    const after = await store.read()
    console.log(JSON.stringify({ hasKey: 'isGroup' in after.subtasks[0] }))
  `)
  expect(out).toEqual({ hasKey: false })
})

test('patchSubtask joins a subtask to an existing group of the SAME task', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1')}
    const result = await web.patchSubtask('m1', { parentGroupId: 'g1' })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 'm1')
    console.log(JSON.stringify({ result, parentGroupId: row.parentGroupId ?? null }))
  `)
  expect(out).toEqual({ result: { ok: true }, parentGroupId: 'g1' })
})

test('patchSubtask refuses `invalid_group` when the id names no subtask', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('m1', 't1')}
    const result = await web.patchSubtask('m1', { parentGroupId: 'gone' })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 'm1')
    console.log(JSON.stringify({ result, parentGroupId: row.parentGroupId ?? null }))
  `)
  expect(out).toEqual({ result: { ok: false, message: 'invalid_group' }, parentGroupId: null })
})

test('patchSubtask refuses `invalid_group` when the target is not actually a group', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${subtask('m1', 't1')}
    const result = await web.patchSubtask('m1', { parentGroupId: 's1' })
    console.log(JSON.stringify({ result }))
  `)
  expect(out).toEqual({ result: { ok: false, message: 'invalid_group' } })
})

test('patchSubtask refuses `invalid_group` when the group belongs to a DIFFERENT task', async () => {
  const out = await run(`
    ${task('t1')}
    ${task('t2')}
    ${subtask('g1', 't2', 'isGroup: true,')}
    ${subtask('m1', 't1')}
    const result = await web.patchSubtask('m1', { parentGroupId: 'g1' })
    console.log(JSON.stringify({ result }))
  `)
  expect(out).toEqual({ result: { ok: false, message: 'invalid_group' } })
})

test('patchSubtask refuses `invalid_group` when the subtask being patched is itself a group', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('g2', 't1', 'isGroup: true,')}
    const result = await web.patchSubtask('g2', { parentGroupId: 'g1' })
    console.log(JSON.stringify({ result }))
  `)
  expect(out).toEqual({ result: { ok: false, message: 'invalid_group' } })
})

/**
 * §F.1: a MEMBER gets no rollup bucket of its own at all (`task-report.ts`'s `subtaskViews`
 * excludes it outright), so a session already filed on the subtask being joined would silently
 * drop out of every visible per-subtask/per-group breakdown the instant it joins, while the
 * task's own total (computed independently, over every row) keeps counting it — the two would
 * then disagree with nothing on screen explaining the gap. `checkParentGroup` refuses the join
 * outright instead (`subtask_has_sessions`).
 */
test('patchSubtask joins a group when the subtask has ZERO sessions filed on it', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1')}
    const result = await web.patchSubtask('m1', { parentGroupId: 'g1' })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 'm1')
    console.log(JSON.stringify({ result, parentGroupId: row.parentGroupId ?? null }))
  `)
  expect(out).toEqual({ result: { ok: true }, parentGroupId: 'g1' })
})

test('patchSubtask REFUSES joining a group when the subtask already has a session filed on it — subtask_has_sessions', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1')}
    ${session('sess1', "taskId: 't1', subtaskId: 'm1',")}
    const result = await web.patchSubtask('m1', { parentGroupId: 'g1' })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 'm1')
    console.log(JSON.stringify({ result, parentGroupId: row.parentGroupId ?? null }))
  `)
  expect(out).toEqual({
    result: { ok: false, message: 'subtask_has_sessions' }, parentGroupId: null,
  })
})

test('an empty string LEAVES the group — the key is gone from the record, not written empty', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1',")}
    const result = await web.patchSubtask('m1', { parentGroupId: '' })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 'm1')
    console.log(JSON.stringify({ result, hasKey: 'parentGroupId' in row }))
  `)
  expect(out).toEqual({ result: { ok: true }, hasKey: false })
})

test('`null` LEAVES the group too', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1',")}
    const result = await web.patchSubtask('m1', { parentGroupId: null })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 'm1')
    console.log(JSON.stringify({ result, hasKey: 'parentGroupId' in row }))
  `)
  expect(out).toEqual({ result: { ok: true }, hasKey: false })
})

test('attachSession REFUSES filing on a group MEMBER — subtask_in_group', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1',")}
    ${session('sess1')}
    const result = await web.attachSession('t1', 'sess1', { subtaskId: 'm1' })
    console.log(JSON.stringify({ result }))
  `)
  expect(out).toEqual({ result: { ok: false, reason: 'subtask_in_group' } })
})

test('attachSession SUCCEEDS filing directly on the GROUP itself, exactly like any other subtask', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1',")}
    ${session('sess1')}
    const result = await web.attachSession('t1', 'sess1', { subtaskId: 'g1' })
    const after = await store.read()
    console.log(JSON.stringify({ result }))
  `)
  expect(out).toEqual({ result: { ok: true } })
})

/**
 * Deleting a GROUP must not permanently orphan its members — they become ordinary loose subtasks
 * again (§F.1: a member without a group is exactly what a loose subtask is), written atomically
 * with the deletion so a crash between the two can never leave a member pointing at an id nothing
 * names. Unlike `attemptViews`'s handling of a dangling `attemptId` (folded into a documented
 * "unattributed" bucket), a dangling `parentGroupId` had NO fallback at all before this fix:
 * `subtaskViews`'s member-exclusion filter would keep excluding the row forever with no UI/API
 * path back.
 */
test('removeSubtask on a GROUP clears parentGroupId on its former members — they become ordinary loose subtasks', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1',")}
    ${subtask('m2', 't1', "parentGroupId: 'g1',")}
    const removed = await web.removeSubtask('g1')
    const after = await store.read()
    const ids = after.subtasks.map(s => s.id).sort()
    const m1 = after.subtasks.find(s => s.id === 'm1')
    const m2 = after.subtasks.find(s => s.id === 'm2')
    console.log(JSON.stringify({
      removed, ids,
      m1HasParentGroupId: 'parentGroupId' in m1,
      m2HasParentGroupId: 'parentGroupId' in m2,
    }))
  `)
  expect(out).toEqual({
    removed: true,
    ids: ['m1', 'm2'], // g1 itself is gone
    m1HasParentGroupId: false,
    m2HasParentGroupId: false,
  })
})

test('removeSubtask on a GROUP leaves an UNRELATED group\'s members alone', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('g2', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1',")}
    ${subtask('m2', 't1', "parentGroupId: 'g2',")}
    await web.removeSubtask('g1')
    const after = await store.read()
    const m2 = after.subtasks.find(s => s.id === 'm2')
    console.log(JSON.stringify({ m2ParentGroupId: m2.parentGroupId ?? null }))
  `)
  expect(out).toEqual({ m2ParentGroupId: 'g2' })
})

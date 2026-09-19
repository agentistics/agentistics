import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The WRITE side of the subtask rollup group — `patchSubtask`'s `groupId`, spec
 * docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §B.5. The READ side (`subtaskViews`
 * bucketing by `groupId ?? id`) is `task-report.test.ts`'s; this file only asserts that the column
 * can be set, joined, left alone and CLEARED.
 *
 * Out-of-process for the same reason `task-done-needs-session.test.ts` is: `loadTaskWorld()` reads
 * the module-level `TASKS_FILE` computed once at `config.ts` load, so each scenario needs its own
 * `AGENTISTICS_DIR` in its own process.
 */

const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-subtask-groupid-'))
  const script = `
    const cfg = await import(${JSON.stringify(join(SESSIONS_DIR, '..', 'config.ts'))})
    const { createTaskStore } = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-store.ts'))})
    const web = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-web.ts'))})
    const store = createTaskStore(cfg.TASKS_FILE)
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

const task = (id: string) => `
  await store.upsertTask({
    id: '${id}', title: '${id}', status: 'todo',
    createdAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:00.000Z',
  })
`
const subtask = (id: string, taskId: string, over = '') => `
  await store.upsertSubtask({
    id: '${id}', taskId: '${taskId}', title: '${id}', status: 'todo', done: false,
    createdAt: '2026-09-11T10:00:00.000Z', updatedAt: '2026-09-11T10:00:00.000Z',
    ${over}
  })
`
const groupOf = (id: string) => `(after.subtasks.find(s => s.id === '${id}').groupId ?? null)`

test('patchSubtask stamps a groupId on a subtask that had none', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    const result = await web.patchSubtask('s1', { groupId: 'g-abc' })
    const after = await store.read()
    console.log(JSON.stringify({ result, groupId: ${groupOf('s1')} }))
  `)
  expect(out).toEqual({ result: { ok: true }, groupId: 'g-abc' })
})

test('two subtasks stamped with the same groupId end up in one group', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${subtask('s2', 't1')}
    await web.patchSubtask('s1', { groupId: 'g-abc' })
    await web.patchSubtask('s2', { groupId: 'g-abc' })
    const after = await store.read()
    console.log(JSON.stringify({ one: ${groupOf('s1')}, two: ${groupOf('s2')} }))
  `)
  expect(out).toEqual({ one: 'g-abc', two: 'g-abc' })
})

test('`null` CLEARS the group — the key is gone from the record, not written as null', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1', "groupId: 'g-abc',")}
    const result = await web.patchSubtask('s1', { groupId: null })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 's1')
    console.log(JSON.stringify({ result, hasKey: 'groupId' in row, groupId: row.groupId ?? null }))
  `)
  expect(out).toEqual({ result: { ok: true }, hasKey: false, groupId: null })
})

test('an empty or whitespace-only string clears too — a blank key would pass `groupId ?? id` and merge unrelated subtasks', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1', "groupId: 'g-abc',")}
    ${subtask('s2', 't1', "groupId: 'g-xyz',")}
    await web.patchSubtask('s1', { groupId: '' })
    await web.patchSubtask('s2', { groupId: '   ' })
    const after = await store.read()
    console.log(JSON.stringify({ one: ${groupOf('s1')}, two: ${groupOf('s2')} }))
  `)
  expect(out).toEqual({ one: null, two: null })
})

test('a groupId is trimmed, so the same group typed with stray spaces is the same bucket', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    ${subtask('s2', 't1')}
    await web.patchSubtask('s1', { groupId: 'g-abc' })
    await web.patchSubtask('s2', { groupId: '  g-abc  ' })
    const after = await store.read()
    console.log(JSON.stringify({ same: ${groupOf('s1')} === ${groupOf('s2')}, key: ${groupOf('s2')} }))
  `)
  expect(out).toEqual({ same: true, key: 'g-abc' })
})

test('a patch that does not mention groupId leaves it alone', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1', "groupId: 'g-abc',")}
    const result = await web.patchSubtask('s1', { assignee: 'alguem' })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 's1')
    console.log(JSON.stringify({ result, groupId: row.groupId ?? null, assignee: row.assignee }))
  `)
  expect(out).toEqual({ result: { ok: true }, groupId: 'g-abc', assignee: 'alguem' })
})

/**
 * The legacy `groupId` (§B) and the current `isGroup`/`parentGroupId` pair (§F) may never both name
 * a group on one record — two independent, unreconciled "which group" answers on one subtask.
 * `patchSubtask` refuses (`group_field_conflict`, 422) rather than letting one silently win.
 */
describe('groupId vs isGroup/parentGroupId — never both on one record (§F, third review round)', () => {
  test('setting groupId on a subtask that is itself a GROUP is refused', async () => {
    const out = await run(`
      ${task('t1')}
      ${subtask('g1', 't1', 'isGroup: true,')}
      const result = await web.patchSubtask('g1', { groupId: 'g-abc' })
      const after = await store.read()
      const row = after.subtasks.find(s => s.id === 'g1')
      console.log(JSON.stringify({ result, groupId: row.groupId ?? null }))
    `)
    expect(out).toEqual({ result: { ok: false, message: 'group_field_conflict' }, groupId: null })
  })

  test('setting groupId on a subtask that is already a group MEMBER is refused', async () => {
    const out = await run(`
      ${task('t1')}
      ${subtask('g1', 't1', 'isGroup: true,')}
      ${subtask('m1', 't1', "parentGroupId: 'g1',")}
      const result = await web.patchSubtask('m1', { groupId: 'g-abc' })
      const after = await store.read()
      const row = after.subtasks.find(s => s.id === 'm1')
      console.log(JSON.stringify({ result, groupId: row.groupId ?? null, parentGroupId: row.parentGroupId ?? null }))
    `)
    expect(out).toEqual({
      result: { ok: false, message: 'group_field_conflict' }, groupId: null, parentGroupId: 'g1',
    })
  })

  test('setting parentGroupId on a subtask that already carries a legacy groupId is refused — even though the target group is otherwise valid', async () => {
    const out = await run(`
      ${task('t1')}
      ${subtask('g1', 't1', 'isGroup: true,')}
      ${subtask('s1', 't1', "groupId: 'g-abc',")}
      const result = await web.patchSubtask('s1', { parentGroupId: 'g1' })
      const after = await store.read()
      const row = after.subtasks.find(s => s.id === 's1')
      console.log(JSON.stringify({ result, groupId: row.groupId ?? null, parentGroupId: row.parentGroupId ?? null }))
    `)
    expect(out).toEqual({
      result: { ok: false, message: 'group_field_conflict' }, groupId: 'g-abc', parentGroupId: null,
    })
  })

  test('control: an old row that already carries a stale groupId is left alone by a patch that never touches either field', async () => {
    const out = await run(`
      ${task('t1')}
      ${subtask('g1', 't1', 'isGroup: true,')}
      const result = await web.patchSubtask('g1', { assignee: 'alguem' })
      const after = await store.read()
      const row = after.subtasks.find(s => s.id === 'g1')
      console.log(JSON.stringify({ result, assignee: row.assignee }))
    `)
    expect(out).toEqual({ result: { ok: true }, assignee: 'alguem' })
  })

  test('control: clearing groupId to null on a group member does not conflict with itself', async () => {
    const out = await run(`
      ${task('t1')}
      ${subtask('g1', 't1', 'isGroup: true,')}
      ${subtask('m1', 't1', "parentGroupId: 'g1', groupId: undefined,")}
      const result = await web.patchSubtask('m1', { groupId: null })
      const after = await store.read()
      const row = after.subtasks.find(s => s.id === 'm1')
      console.log(JSON.stringify({ result, groupId: row.groupId ?? null, parentGroupId: row.parentGroupId ?? null }))
    `)
    expect(out).toEqual({ result: { ok: true }, groupId: null, parentGroupId: 'g1' })
  })
})

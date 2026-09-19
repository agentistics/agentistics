import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The write side of a staged session draft (t-918cc82233) — `Subtask.stagedSession`, set/cleared
 * through `task-web.ts`'s `patchSubtask`:
 *
 *  - a validated draft round-trips through the store exactly (`task-store.ts`'s `sanitizeSubtask`
 *    must carry the field, or a write is silently a no-op on the next read — the same class of bug
 *    the hierarchy fields (`isGroup`/`parentGroupId`) were fixed for);
 *  - SETTING one on a group MEMBER is refused (`subtask_in_group`), reusing the exact refusal
 *    `task-attach.ts` already states for filing a real session there — a draft that could never be
 *    fired on that row is not a draft worth saving;
 *  - CLEARING one (`stagedSession: null`) is never refused this way, even on a member — a stale
 *    draft left over from before a subtask joined a group must still be removable;
 *  - a malformed draft (no prompt) never reaches the store at all.
 *
 * Out-of-process for the same reason `subtask-group-hierarchy.test.ts` is: `loadTaskWorld()` reads
 * the module-level `TASKS_FILE`/`MANAGED_SESSIONS_FILE` computed once at `config.ts` load, so each
 * scenario needs its own `AGENTISTICS_DIR` in its own process.
 */

const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-staged-session-'))
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
    createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-18T10:00:00.000Z',
    ${over}
  })
`
const subtask = (id: string, taskId: string, over = '') => `
  await store.upsertSubtask({
    id: '${id}', taskId: '${taskId}', title: '${id}', status: 'todo', done: false,
    createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-18T10:00:00.000Z',
    ${over}
  })
`

test('patchSubtask SETS a staged session draft and it round-trips through the store exactly', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    const draft = { prompt: 'Fix the flaky test', attachmentIds: ['f1'], harness: 'claude', cwd: '/repo' }
    const result = await web.patchSubtask('s1', { stagedSession: draft })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 's1')
    console.log(JSON.stringify({ result, stagedSession: row.stagedSession ?? null }))
  `)
  expect(out).toEqual({
    result: { ok: true },
    stagedSession: { prompt: 'Fix the flaky test', attachmentIds: ['f1'], harness: 'claude', cwd: '/repo' },
  })
})

test('patchSubtask SETS a bare-prompt draft — everything else is optional', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    const result = await web.patchSubtask('s1', { stagedSession: { prompt: 'do it' } })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 's1')
    console.log(JSON.stringify({ result, stagedSession: row.stagedSession ?? null }))
  `)
  expect(out).toEqual({ result: { ok: true }, stagedSession: { prompt: 'do it' } })
})

test('patchSubtask REFUSES setting a staged session on a group MEMBER — subtask_in_group', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1',")}
    const result = await web.patchSubtask('m1', { stagedSession: { prompt: 'do it' } })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 'm1')
    console.log(JSON.stringify({ result, stagedSession: row.stagedSession ?? null }))
  `)
  expect(out).toEqual({ result: { ok: false, message: 'subtask_in_group' }, stagedSession: null })
})

test('patchSubtask ALLOWS setting a staged session on a GROUP itself — it may hold a session', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    const result = await web.patchSubtask('g1', { stagedSession: { prompt: 'do it' } })
    console.log(JSON.stringify({ result }))
  `)
  expect(out).toEqual({ result: { ok: true } })
})

test('patchSubtask CLEARS a staged session with `stagedSession: null` — the key is gone, not written null', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1', "stagedSession: { prompt: 'do it' },")}
    const result = await web.patchSubtask('s1', { stagedSession: null })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 's1')
    console.log(JSON.stringify({ result, hasKey: 'stagedSession' in row }))
  `)
  expect(out).toEqual({ result: { ok: true }, hasKey: false })
})

test('CLEARING is never refused on a group MEMBER — a stale draft must still be removable', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('g1', 't1', 'isGroup: true,')}
    ${subtask('m1', 't1', "parentGroupId: 'g1', stagedSession: { prompt: 'stale' },")}
    const result = await web.patchSubtask('m1', { stagedSession: null })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 'm1')
    console.log(JSON.stringify({ result, hasKey: 'stagedSession' in row }))
  `)
  expect(out).toEqual({ result: { ok: true }, hasKey: false })
})

test('omitting stagedSession from the patch leaves an existing draft untouched', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1', "stagedSession: { prompt: 'keep me' },")}
    const result = await web.patchSubtask('s1', { title: 'renamed' })
    const after = await store.read()
    const row = after.subtasks.find(s => s.id === 's1')
    console.log(JSON.stringify({ result, stagedSession: row.stagedSession ?? null }))
  `)
  expect(out).toEqual({ result: { ok: true }, stagedSession: { prompt: 'keep me' } })
})

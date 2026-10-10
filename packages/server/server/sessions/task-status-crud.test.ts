import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The status VOCABULARY end to end — `listStatuses` / `createStatus` / `editStatus` /
 * `deleteStatus` in `task-web.ts`, the seed-once migration in `task-source.ts`'s
 * `ensureStatusesSeeded`, and the write-time gate `markTask`/`patchSubtask` apply to
 * `Task.status`/`Subtask.status` now that it is a plain string rather than a closed union.
 *
 * Same process-isolation shape as `task-done-needs-session.test.ts` / `task-status-auto-
 * advance.test.ts` — `loadTaskWorld()` is hardcoded to module-level file paths resolved once from
 * `process.env`, so each scenario runs in its own process pointed at its own `AGENTISTICS_DIR`.
 */

const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-status-crud-'))
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

test('a fresh board seeds the four protected defaults plus in_review, in order', async () => {
  const out = await run(`
    const statuses = await web.listStatuses()
    console.log(JSON.stringify({
      ids: statuses.map(s => s.id),
      allProtected: statuses.every(s => s.protected === true),
    }))
  `)
  expect(out).toEqual({ ids: ['todo', 'in_progress', 'blocked', 'in_review', 'done'], allProtected: false })
})

test('a legacy status actually in use is migrated in as a non-protected entry', async () => {
  const out = await run(`
    ${task('t1', "status: 'backlog',")}
    const statuses = await web.listStatuses()
    console.log(JSON.stringify(statuses.find(s => s.id === 'backlog')))
  `)
  expect(out).toMatchObject({ id: 'backlog', label: 'Backlog', protected: false, usageCount: 1 })
})

test('a legacy status NOT in use anywhere is never seeded', async () => {
  const out = await run(`
    ${task('t1')}
    const statuses = await web.listStatuses()
    console.log(JSON.stringify({ ids: statuses.map(s => s.id) }))
  `)
  const parsed = out as { ids: string[] }
  expect(parsed.ids).not.toContain('abandoned')
  expect(parsed.ids).not.toContain('backlog')
})

test('an existing list lacking in_review gets it ONCE, custom statuses untouched, and a delete sticks', async () => {
  const out = await run(`
    await store.seedStatuses([
      { id: 'todo', label: 'To do', color: '#3b82f6', protected: true, order: 0 },
      { id: 'in_progress', label: 'In progress', color: '#e8703a', protected: true, order: 1 },
      { id: 'blocked', label: 'Blocked', color: '#ef4444', protected: true, order: 2 },
      { id: 'done', label: 'Done', color: '#22c55e', protected: true, order: 3 },
      { id: 'triage', label: 'Triage', color: '#000000', protected: false, order: 4 },
    ])
    const first = (await web.listStatuses()).map(s => s.id)
    await web.deleteStatus('in_review')
    const second = (await web.listStatuses()).map(s => s.id)
    console.log(JSON.stringify({ first, second }))
  `) as { first: string[]; second: string[] }
  expect(out.first).toEqual(['todo', 'in_progress', 'blocked', 'done', 'triage', 'in_review'])
  expect(out.second).toEqual(['todo', 'in_progress', 'blocked', 'done', 'triage'])
})

test('the migration is idempotent: opening the board twice never seeds it twice', async () => {
  const out = await run(`
    ${task('t1', "status: 'backlog',")}
    await web.listStatuses()
    await web.listStatuses()
    const statuses = await web.listStatuses()
    console.log(JSON.stringify({ count: statuses.filter(s => s.id === 'backlog').length }))
  `)
  expect(out).toEqual({ count: 1 })
})

test('createStatus mints a fresh, non-protected entry with an id derived from the label', async () => {
  const out = await run(`
    const created = await web.createStatus({ label: 'Waiting on client', color: '#3b82f6' })
    console.log(JSON.stringify(created))
  `)
  expect(out).toEqual({
    ok: true,
    status: { id: 'waiting_on_client', label: 'Waiting on client', color: '#3b82f6', protected: false, order: 5 },
  })
})

test('createStatus refuses an empty label and a bad colour', async () => {
  const out = await run(`
    const empty = await web.createStatus({ label: '  ', color: '#3b82f6' })
    const badColor = await web.createStatus({ label: 'Triage', color: 'blue' })
    console.log(JSON.stringify({ empty, badColor }))
  `)
  expect(out).toEqual({
    empty: { ok: false, message: 'label_required' },
    badColor: { ok: false, message: 'bad_color' },
  })
})

test('editStatus changes label and colour on a PROTECTED status — only its id is immutable', async () => {
  const out = await run(`
    const result = await web.editStatus('done', { label: 'Shipped', color: '#22c55e' })
    const statuses = await web.listStatuses()
    console.log(JSON.stringify({ result, done: statuses.find(s => s.id === 'done') }))
  `)
  const parsed = out as { result: unknown; done: { id: string; label: string; protected: boolean } }
  expect(parsed.result).toEqual({ ok: true })
  expect(parsed.done).toMatchObject({ id: 'done', label: 'Shipped', protected: true })
})

test('editStatus refuses an unknown id and a bad colour', async () => {
  const out = await run(`
    const missing = await web.editStatus('nope', { label: 'x' })
    const badColor = await web.editStatus('done', { color: 'green' })
    console.log(JSON.stringify({ missing, badColor }))
  `)
  expect(out).toEqual({
    missing: { ok: false, message: 'no_such_status' },
    badColor: { ok: false, message: 'bad_color' },
  })
})

test('deleteStatus refuses every protected status regardless of usage', async () => {
  const out = await run(`
    const results = {}
    for (const id of ['todo', 'in_progress', 'blocked', 'done']) {
      results[id] = await web.deleteStatus(id)
    }
    console.log(JSON.stringify(results))
  `)
  expect(out).toEqual({
    todo: { ok: false, message: 'protected' },
    in_progress: { ok: false, message: 'protected' },
    blocked: { ok: false, message: 'protected' },
    done: { ok: false, message: 'protected' },
  })
})

test('deleteStatus refuses a non-protected status that is still in use, naming the count', async () => {
  const out = await run(`
    ${task('t1', "status: 'backlog',")}
    ${subtask('s1', 't1', "status: 'backlog',")}
    await web.listStatuses() // trigger the seed
    const result = await web.deleteStatus('backlog')
    console.log(JSON.stringify(result))
  `)
  expect(out).toEqual({ ok: false, message: 'in_use', usageCount: 2 })
})

test('deleteStatus allows a non-protected, unused status', async () => {
  const out = await run(`
    const created = await web.createStatus({ label: 'Scratch', color: '#94a3b8' })
    const result = await web.deleteStatus(created.status.id)
    const statuses = await web.listStatuses()
    console.log(JSON.stringify({ result, remaining: statuses.map(s => s.id) }))
  `)
  const parsed = out as { result: unknown; remaining: string[] }
  expect(parsed.result).toEqual({ ok: true })
  expect(parsed.remaining).not.toContain('scratch')
})

test('deleteStatus on an unknown id is 404-shaped, not a silent success', async () => {
  const out = await run(`
    const result = await web.deleteStatus('nope')
    console.log(JSON.stringify(result))
  `)
  expect(out).toEqual({ ok: false, message: 'no_such_status' })
})

// --- write-time validation: Task.status / Subtask.status are a dynamic list now ------------------

test('markTask refuses a status this board does not have', async () => {
  const out = await run(`
    ${task('t1')}
    const result = await web.markTask('t1', 'nonexistent_status')
    console.log(JSON.stringify(result))
  `)
  expect(out).toEqual({ ok: false, message: 'unknown_status' })
})

test('markTask still succeeds for a real, known status (regression: the four protected defaults)', async () => {
  const out = await run(`
    ${task('t1')}
    await registry.add({
      id: 'sess-1', harness: 'claude', cwd: '/tmp/x',
      createdAt: '2026-09-19T10:00:00.000Z', taskId: 't1',
    })
    const result = await web.markTask('t1', 'done')
    console.log(JSON.stringify({ ok: result.ok }))
  `)
  expect(out).toEqual({ ok: true })
})

test('patchSubtask refuses a status this board does not have', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    const result = await web.patchSubtask('s1', { status: 'nonexistent_status' })
    console.log(JSON.stringify(result))
  `)
  expect(out).toEqual({ ok: false, message: 'unknown_status' })
})

test('patchSubtask still succeeds for a real, known status (regression)', async () => {
  const out = await run(`
    ${task('t1')}
    ${subtask('s1', 't1')}
    const result = await web.patchSubtask('s1', { status: 'in_progress' })
    console.log(JSON.stringify(result))
  `)
  expect(out).toEqual({ ok: true })
})

test('a custom status created via createStatus can then be used to mark a task', async () => {
  const out = await run(`
    ${task('t1')}
    const created = await web.createStatus({ label: 'Waiting on client', color: '#3b82f6' })
    const result = await web.markTask('t1', created.status.id)
    const statuses = await web.listStatuses()
    console.log(JSON.stringify({
      ok: result.ok,
      usage: statuses.find(s => s.id === created.status.id).usageCount,
    }))
  `)
  expect(out).toEqual({ ok: true, usage: 1 })
})

import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The task TYPE vocabulary end to end — `listTypes` / `createType` / `editType` / `deleteType`, the
 * seed in `task-source.ts`, the `type` field on `editTask`/`createTask`, and the one-time
 * core-status → type migration. Same process-isolation shape as `task-status-crud.test.ts`.
 */

const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-type-crud-'))
  const script = `
    const cfg = await import(${JSON.stringify(join(SESSIONS_DIR, '..', 'config.ts'))})
    const { createTaskStore } = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-store.ts'))})
    const web = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-web.ts'))})
    const store = createTaskStore(cfg.TASKS_FILE)
    ${body}
  `
  const proc = Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, AGENTISTICS_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`script failed: ${err.trim().split('\n').slice(-8).join(' | ')}`)
  return JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? '{}')
}

const task = (id: string, over = '') => `
  await store.upsertTask({
    id: '${id}', title: '${id}', status: 'todo',
    createdAt: '2026-09-19T10:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z',
    ${over}
  })
`

test('a fresh board seeds exactly CORE', async () => {
  const out = await run(`console.log(JSON.stringify((await web.listTypes()).map(t => [t.id, t.label, t.usageCount])))`)
  expect(out).toEqual([['core', 'CORE', 0]])
})

test('a task whose STATUS is core becomes type=core + in_progress, once', async () => {
  const out = await run(`
    ${task('t1', "status: 'core',")}
    await web.listTypes(); await web.listTypes()
    const w = await store.read()
    console.log(JSON.stringify({ t: w.tasks.map(t => [t.status, t.type]), types: w.types.map(t => t.id) }))
  `)
  expect(out).toEqual({ t: [['in_progress', 'core']], types: ['core'] })
})

test('createType derives the id; refuses an empty label and a bad colour', async () => {
  const out = await run(`
    const ok = await web.createType({ label: 'Deep Work', color: '#3b82f6' })
    const empty = await web.createType({ label: ' ', color: '#3b82f6' })
    const bad = await web.createType({ label: 'X', color: 'blue' })
    console.log(JSON.stringify({ ok, empty, bad }))
  `)
  expect(out).toEqual({
    ok: { ok: true, type: { id: 'deep_work', label: 'Deep Work', color: '#3b82f6', order: 1 } },
    empty: { ok: false, message: 'label_required' },
    bad: { ok: false, message: 'bad_color' },
  })
})

test('editType renames and recolours — CORE included — and refuses unknown ids', async () => {
  const out = await run(`
    const r = await web.editType('core', { label: 'Core work', color: '#22c55e' })
    const missing = await web.editType('nope', { label: 'x' })
    const bad = await web.editType('core', { color: 'green' })
    console.log(JSON.stringify({ r, missing, bad, core: (await web.listTypes())[0] }))
  `)
  expect(out).toMatchObject({
    r: { ok: true }, missing: { ok: false, message: 'no_such_type' }, bad: { ok: false, message: 'bad_color' },
    core: { id: 'core', label: 'Core work', color: '#22c55e' },
  })
})

test('editTask sets, clears and refuses a type; createTask keeps only a known one', async () => {
  const out = await run(`
    ${task('t1')}
    const set = await web.editTask('t1', { type: 'core' })
    const afterSet = (await store.read()).tasks[0].type
    const unknown = await web.editTask('t1', { type: 'ghost' })
    const clear = await web.editTask('t1', { type: '' })
    const afterClear = (await store.read()).tasks[0].type
    const made = await web.createTask({ title: 'new one', type: 'core' })
    const dropped = await web.createTask({ title: 'other', type: 'ghost' })
    console.log(JSON.stringify({ set, afterSet, unknown, clear, afterClear, made: made.type, dropped: dropped.type ?? null }))
  `)
  expect(out).toEqual({
    set: true, afterSet: 'core', unknown: false, clear: true, afterClear: undefined, made: 'core', dropped: null,
  })
})

test('deleteType is refused while a task carries it (422 in_use) and allowed after', async () => {
  const out = await run(`
    ${task('t1', "type: 'core',")}
    await web.listTypes()
    const refused = await web.deleteType('core')
    await web.editTask('t1', { type: '' })
    const allowed = await web.deleteType('core')
    const gone = await web.deleteType('core')
    console.log(JSON.stringify({ refused, allowed, gone, left: (await web.listTypes()).length }))
  `)
  expect(out).toEqual({
    refused: { ok: false, message: 'in_use', usageCount: 1 },
    allowed: { ok: true },
    gone: { ok: false, message: 'no_such_type' },
    left: 0,
  })
})

test('a deleted CORE is not re-seeded on the next open', async () => {
  const out = await run(`
    await web.listTypes()
    await web.deleteType('core')
    console.log(JSON.stringify((await web.listTypes()).length))
  `)
  expect(out).toBe(0)
})

test('priority: a new task is low, a stored none/absent loads as low, a legacy none edit stores low', async () => {
  const out = await run(`
    ${task('old1', "priority: 'none',")}
    ${task('old2')}
    const made = await web.createTask({ title: 'fresh' })
    await web.editTask('old2', { priority: 'high' })
    await web.editTask('old1', { priority: 'none' })
    const w = await store.read()
    console.log(JSON.stringify({ made: made.priority, byId: Object.fromEntries(w.tasks.map(t => [t.id, t.priority])) }))
  `)
  expect(out).toMatchObject({ made: 'low', byId: { old1: 'low', old2: 'high' } })
})

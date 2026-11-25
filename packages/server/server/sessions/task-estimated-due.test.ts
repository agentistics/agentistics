import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCalendar } from '@agentistics/core'
import { estimateUnstartedAtMs } from './task-live'
import { brtDayOf, estimateDueDay, estimatedDueNotice, needsEstimate, planDueBackfill } from './task-estimated-due'

/**
 * CALENDARIO.PRAZO-OBRIGATORIO: a SESSION that files a task/subtask with no due day gets an ESTIMATED one, flagged
 * `dueEstimated`; a typed day wins and clears the flag; a person's own write is never forced; the migration runs once.
 * The write side runs out-of-process (the board file is a module-level constant), like subtask-group-hierarchy.test.ts.
 */
const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-estimated-due-'))
  const script = `
    const cfg = await import(${JSON.stringify(join(SESSIONS_DIR, '..', 'config.ts'))})
    const { createTaskStore } = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-store.ts'))})
    const web = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-web.ts'))})
    const store = createTaskStore(cfg.TASKS_FILE)
    ${body}
  `
  const proc = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, AGENTISTICS_DIR: dir }, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`script failed: ${err.trim().split('\n').slice(-8).join(' | ')}`)
  return JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? '{}')
}

const seedTask = `await store.upsertTask({ id: 't-1', title: 'T', status: 'todo', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' })`
const DAY = /^\d{4}-\d{2}-\d{2}$/

test('estimate is the existing forecast projected on a BRT day, never in the past', () => {
  const now = Date.parse('2026-11-23T15:00:00Z')
  const day = estimateDueDay(now, ms => estimateUnstartedAtMs(ms))
  expect(day).toMatch(DAY)
  expect(day >= brtDayOf(now)).toBe(true)
  expect(needsEstimate({ bySession: true, dueDate: undefined })).toBe(true)
  expect(needsEstimate({ bySession: false, dueDate: undefined })).toBe(false)
  expect(needsEstimate({ bySession: true, dueDate: '2026-12-01' })).toBe(false)
  expect(needsEstimate({ bySession: true, dueDate: undefined, closed: true })).toBe(false)
  expect(estimatedDueNotice('2026-11-24').notice).toContain('prazo estimado: 2026-11-24')
})

test('session creates a subtask without dueDate: estimated + flagged + notice', async () => {
  const r = await run(`${seedTask}
    const made = await web.addSubtaskDetailed('t-1', 'S', { bySession: true })
    const sub = (await store.read()).subtasks.find(s => s.id === made.id)
    console.log(JSON.stringify({ made, sub }))`)
  expect(r.made.dueEstimated).toBe(true)
  expect(r.made.dueDate).toMatch(DAY)
  expect(r.sub.dueEstimated).toBe(true)
  expect(r.sub.dueDate).toBe(r.made.dueDate)
})

test('an explicit dueDate wins and is not flagged', async () => {
  const r = await run(`${seedTask}
    const made = await web.addSubtaskDetailed('t-1', 'S', { bySession: true, dueDate: '2026-12-31' })
    const sub = (await store.read()).subtasks.find(s => s.id === made.id)
    console.log(JSON.stringify({ made, sub }))`)
  expect(r.sub.dueDate).toBe('2026-12-31')
  expect(r.sub.dueEstimated).toBeUndefined()
  expect(r.made.dueEstimated).toBeUndefined()
})

test('a person (no session) is not forced to have a due day', async () => {
  const r = await run(`${seedTask}
    const made = await web.addSubtaskDetailed('t-1', 'S')
    const sub = (await store.read()).subtasks.find(s => s.id === made.id)
    const task = await web.createTask({ title: 'Other' })
    console.log(JSON.stringify({ sub, task }))`)
  expect(r.sub.dueDate).toBeUndefined()
  expect(r.sub.dueEstimated).toBeUndefined()
  expect(r.task.dueDate).toBeUndefined()
})

test('a session creating a task gets an estimate; a later typed dueDate replaces it and clears the flag', async () => {
  const r = await run(`
    const task = await web.createTask({ title: 'Made by session', bySession: true })
    const edited = await web.editTask(task.id, { dueDate: '2027-01-15' })
    const after = (await store.read()).tasks.find(t => t.id === task.id)
    console.log(JSON.stringify({ task, edited, after }))`)
  expect(r.task.dueEstimated).toBe(true)
  expect(r.task.dueDate).toMatch(DAY)
  expect(r.after.dueDate).toBe('2027-01-15')
  expect(r.after.dueEstimated).toBeUndefined()
})

test('a session edit that leaves the subtask with no day estimates; a typed day then clears the flag', async () => {
  // `createTask` loads the board once first, so the one-time migration has run and cannot be what fills the day below.
  const r = await run(`await web.createTask({ title: 'warm-up' })
    ${seedTask}
    await store.upsertSubtask({ id: 's-1', taskId: 't-1', title: 'S', status: 'todo', done: false, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' })
    const a = await web.patchSubtask('s-1', { notes: 'x', bySession: true }, { principal: { kind: 'unattributed' } })
    const mid = (await store.read()).subtasks.find(s => s.id === 's-1')
    const b = await web.patchSubtask('s-1', { dueDate: '2026-12-20', bySession: true }, { principal: { kind: 'unattributed' } })
    const end = (await store.read()).subtasks.find(s => s.id === 's-1')
    console.log(JSON.stringify({ a, mid, b, end }))`)
  expect(r.a.ok).toBe(true)
  expect(r.a.dueEstimated).toBe(true)
  expect(r.a.notice).toContain('informe dueDate')
  expect(r.mid.dueEstimated).toBe(true)
  expect(r.b.dueEstimated).toBeUndefined()
  expect(r.end.dueDate).toBe('2026-12-20')
  expect(r.end.dueEstimated).toBeUndefined()
})

test('migration: open subtasks without a day get an estimate once; done ones and later person-made ones are left alone', async () => {
  const r = await run(`${seedTask}
    const base = { taskId: 't-1', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' }
    await store.upsertSubtask({ ...base, id: 's-open', title: 'open', status: 'todo', done: false })
    await store.upsertSubtask({ ...base, id: 's-done', title: 'done', status: 'done', done: true })
    await store.upsertSubtask({ ...base, id: 's-typed', title: 'typed', status: 'todo', done: false, dueDate: '2026-12-05' })
    await web.loadTaskWorld?.()
    const { loadTaskBoard } = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-source.ts'))})
    await loadTaskBoard()
    const first = (await store.read()).subtasks
    await store.upsertSubtask({ ...base, id: 's-later', title: 'later', status: 'todo', done: false })
    await loadTaskBoard()
    const second = (await store.read()).subtasks
    console.log(JSON.stringify({ first, second }))`)
  const by = (xs: any[], id: string) => xs.find(s => s.id === id)
  expect(by(r.first, 's-open').dueEstimated).toBe(true)
  expect(by(r.first, 's-open').dueDate).toMatch(DAY)
  expect(by(r.first, 's-done').dueDate).toBeUndefined()
  expect(by(r.first, 's-typed').dueDate).toBe('2026-12-05')
  expect(by(r.first, 's-typed').dueEstimated).toBeUndefined()
  expect(by(r.second, 's-later').dueDate).toBeUndefined()
  expect(planDueBackfill([{ id: 'a', done: false, status: 'todo' }, { id: 'b', done: true, status: 'done' }], Date.now(), ms => estimateUnstartedAtMs(ms)).has('a')).toBe(true)
})

test('calendar draws an estimated day as an approximation (low confidence, flagged), a typed one as the owner\'s date', () => {
  const piece = (dueEstimated: boolean) => buildCalendar({
    nowMs: Date.parse('2026-11-24T15:00:00Z'), lives: [], resets: [],
    records: [{ taskId: 't', subtaskId: 's', phase: 'fila' }],
    tasks: [{ id: 't', title: 'T', status: 'in_progress' }],
    subtasks: [{ id: 's', taskId: 't', title: 'S', status: 'todo', dueDate: '2026-11-25', ...(dueEstimated ? { dueEstimated: true } : {}) }],
  } as never).pieces
  // Non-vacuous: exactly one piece must be drawn, or the assertions below would not run at all.
  const [est] = piece(true), [typed] = piece(false)
  expect(piece(true)).toHaveLength(1)
  expect(piece(false)).toHaveLength(1)
  expect(est!.dueEstimated).toBe(true)
  expect(est!.confirmed).toBe(false)
  expect((est!.publishEta as { confidence: string }).confidence).toBe('low')
  expect(typed!.dueEstimated).toBeUndefined()
  expect((typed!.publishEta as { confidence: string }).confidence).not.toBe('low')
})

const closedSeed = (status: string) => `await web.createTask({ title: 'warm-up' })
    await store.upsertTask({ id: 't-c', title: 'C', status: '${status}', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' })
    await store.upsertSubtask({ id: 's-c', taskId: 't-c', title: 'S', status: '${status}', done: ${status === 'done'}, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' })`

for (const status of ['done', 'abandoned']) {
  test(`a session editing only notes/detail of a ${status} task and subtask leaves no day and no flag`, async () => {
    const r = await run(`${closedSeed(status)}
      const report = {}
      await web.editTask('t-c', { detail: 'x', bySession: true }, report)
      const reply = await web.patchSubtask('s-c', { notes: 'x', bySession: true }, { principal: { kind: 'unattributed' } })
      const book = await store.read()
      console.log(JSON.stringify({ report, reply, t: book.tasks.find(t => t.id === 't-c'), s: book.subtasks.find(s => s.id === 's-c') }))`)
    expect(r.report.estimatedDue).toBeUndefined()
    expect(r.reply.dueEstimated).toBeUndefined()
    expect(r.t.dueDate).toBeUndefined()
    expect(r.t.dueEstimated).toBeUndefined()
    expect(r.s.dueDate).toBeUndefined()
    expect(r.s.dueEstimated).toBeUndefined()
  })
}

test('closed means done OR abandoned, one helper shared by the migration and both write paths', async () => {
  const { isClosedStatus } = await import('./task-estimated-due')
  expect(isClosedStatus('done')).toBe(true)
  expect(isClosedStatus('abandoned')).toBe(true)
  expect(isClosedStatus('todo')).toBe(false)
  expect(isClosedStatus('in_progress')).toBe(false)
})

test('the {id, done:false} shortcut (setSubtaskDone) from a session estimates an undated open piece', async () => {
  const r = await run(`await web.createTask({ title: 'warm-up' })
    ${seedTask}
    await store.upsertSubtask({ id: 's-1', taskId: 't-1', title: 'S', status: 'todo', done: false, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' })
    const reply = await web.setSubtaskDone('s-1', false, { principal: { kind: 'session', id: 'x', via: 'token' } }, true)
    const person = await web.setSubtaskDone('s-1', false, { principal: { kind: 'unattributed' } })
    const sub = (await store.read()).subtasks.find(s => s.id === 's-1')
    console.log(JSON.stringify({ reply, person, sub }))`)
  expect(r.reply.ok).toBe(true)
  expect(r.reply.dueEstimated).toBe(true)
  expect(r.reply.notice).toContain('informe dueDate')
  expect(r.sub.dueEstimated).toBe(true)
  expect(r.sub.dueDate).toMatch(DAY)
})

test('the owner UI path of the shortcut is NOT forced to estimate', async () => {
  const r = await run(`await web.createTask({ title: 'warm-up' })
    ${seedTask}
    await store.upsertSubtask({ id: 's-1', taskId: 't-1', title: 'S', status: 'todo', done: false, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' })
    await web.setSubtaskDone('s-1', false, { principal: { kind: 'unattributed' } })
    console.log(JSON.stringify((await store.read()).subtasks.find(s => s.id === 's-1')))`)
  expect(r.dueDate).toBeUndefined()
  expect(r.dueEstimated).toBeUndefined()
})

test('markTask by a session on an undated open task estimates it and reports; closing it or a person does not', async () => {
  const r = await run(`await web.createTask({ title: 'warm-up' })
    ${seedTask}
    await store.upsertTask({ id: 't-2', title: 'P', status: 'todo', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' })
    await store.upsertTask({ id: 't-3', title: 'A', status: 'todo', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' })
    const ctx = { principal: { kind: 'session', id: 'x', via: 'token' } }
    const s = await web.markTask('t-1', 'in_progress', undefined, { guard: ctx, bySession: true })
    const p = await web.markTask('t-2', 'in_progress', undefined, { guard: { principal: { kind: 'unattributed' } } })
    const a = await web.markTask('t-3', 'abandoned', undefined, { guard: ctx, bySession: true })
    const book = await store.read()
    const get = id => book.tasks.find(t => t.id === id)
    console.log(JSON.stringify({ s, p, a, t1: get('t-1'), t2: get('t-2'), t3: get('t-3') }))`)
  expect(r.s.ok).toBe(true)
  expect(r.s.dueEstimated).toBe(true)
  expect(r.t1.dueEstimated).toBe(true)
  expect(r.t1.dueDate).toMatch(DAY)
  expect(r.p.dueEstimated).toBeUndefined()
  expect(r.t2.dueDate).toBeUndefined()
  expect(r.a.dueEstimated).toBeUndefined()
  expect(r.t3.dueDate).toBeUndefined()
})

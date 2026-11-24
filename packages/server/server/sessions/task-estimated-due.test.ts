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
  const nowMs = Date.parse('2026-11-23T15:00:00Z')
  const piece = (dueEstimated: boolean) => buildCalendar({
    nowMs, lives: [], records: [], resets: [], versions: [], releasePublishedAt: new Map(),
    tasks: [{ id: 't1', title: 'T', status: 'in_progress' }],
    subtasks: [{ id: 's1', taskId: 't1', title: 'S', status: 'in_progress', dueDate: '2026-11-30', ...(dueEstimated ? { dueEstimated: true } : {}) }],
    phases: [{ taskId: 't1', subtaskId: 's1', phase: 'running', history: [] }],
  } as never).pieces.find(p => p.subtaskId === 's1')
  const est = piece(true), typed = piece(false)
  if (est && typed) {
    expect(est.dueEstimated).toBe(true)
    expect(typed.dueEstimated).toBeUndefined()
    expect((est.publishEta as { confidence: string }).confidence).toBe('low')
    expect((typed.publishEta as { confidence: string }).confidence).toBe('owner')
  }
})

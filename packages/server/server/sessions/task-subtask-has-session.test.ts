import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subtask, Task } from './task-model'
import { rowsOfTask, subtaskHasSession, subtaskSessionCount, subtaskViews } from './task-report'
import { distinctConversations } from './task-conversations'
import type { ManagedSession } from './types'

/**
 * "Does this subtask have a session?" — the write-side gates (`patchSubtask`'s `subtask_has_sessions`
 * group-join refusal and its `done_needs_session`) must give the SAME answer the board draws.
 *
 * The bug this pins: the gate scanned RAW rows, so an OLD registry row still saying subtask X counted
 * even though the conversation's NEWEST row had moved it to subtask Y — the board showed X with 0
 * sessions while a group join was refused with "detach the session first" and nothing to detach.
 * Measured on board task t-0539886b9c, subtask F5.2.
 *
 * The first half runs the pure helper against the read side's own bucketing (`subtaskViews`), so the
 * two cannot drift. The second half drives the real `patchSubtask` against a real file-backed board
 * and registry, out-of-process for the reason `task-done-needs-session.test.ts` states (`config.ts`
 * resolves its paths once at module load).
 */

// ---- the helper against the read side (pure, in-process) -------------------------------------

const TASK: Task = {
  id: 'T', title: 'T', status: 'todo',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as Task
const sub = (id: string): Subtask => ({
  id, taskId: 'T', title: id, status: 'todo', done: false,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as Subtask)
const row = (id: string, createdAt: string, over: Partial<ManagedSession> = {}): ManagedSession => ({
  id, harness: 'claude', cwd: '/tmp/x', createdAt, ...over,
} as ManagedSession)

/** What the BOARD shows: sessionsUsed per subtask, from the read side's own bucketing. */
function boardCounts(subs: Subtask[], rows: ManagedSession[]): Record<string, number> {
  const mine = distinctConversations(rowsOfTask(TASK, rows))
  const views = subtaskViews(TASK, subs, mine, new Map(), () => 0)
  return Object.fromEntries(subs.map(s => [s.id, views.find(v => v.id === s.id)?.rollup.sessionsUsed ?? 0]))
}

function gateCounts(subs: Subtask[], rows: ManagedSession[]): Record<string, number> {
  return Object.fromEntries(subs.map(s => [s.id, subtaskSessionCount(TASK, s.id, rows)]))
}

const SUBS = [sub('X'), sub('Y'), sub('Z')]

const SHAPES: Record<string, ManagedSession[]> = {
  'moved: old row on X, newest row on Y': [
    row('old', '2026-09-10T10:00:00.000Z', { conversationId: 'C', taskId: 'T', subtaskId: 'X' }),
    row('new', '2026-09-12T10:00:00.000Z', { conversationId: 'C', taskId: 'T', subtaskId: 'Y' }),
  ],
  'moved back to the delivery: newest row has no subtask': [
    row('old', '2026-09-10T10:00:00.000Z', { conversationId: 'C', taskId: 'T', subtaskId: 'X' }),
    row('new', '2026-09-12T10:00:00.000Z', { conversationId: 'C', taskId: 'T' }),
  ],
  'reopen that did not inherit the filing (name only, no id)': [
    row('old', '2026-09-10T10:00:00.000Z', { conversationId: 'C', taskId: 'T', subtaskId: 'X' }),
    row('new', '2026-09-12T10:00:00.000Z', { conversationId: 'C', task: 'some old name' }),
  ],
  'unfiled by a detach (taskId is the empty string)': [
    row('old', '2026-09-10T10:00:00.000Z', { conversationId: 'C', taskId: 'T', subtaskId: 'X' }),
    row('new', '2026-09-12T10:00:00.000Z', { conversationId: 'C', taskId: '' }),
  ],
  'moved to ANOTHER task': [
    row('old', '2026-09-10T10:00:00.000Z', { conversationId: 'C', taskId: 'T', subtaskId: 'X' }),
    row('new', '2026-09-12T10:00:00.000Z', { conversationId: 'C', taskId: 'OTHER', subtaskId: 'Q' }),
  ],
  'a conversation reopened three times on the same subtask': [
    row('r1', '2026-09-10T10:00:00.000Z', { conversationId: 'C', taskId: 'T', subtaskId: 'X' }),
    row('r2', '2026-09-11T10:00:00.000Z', { conversationId: 'C', taskId: 'T', subtaskId: 'X' }),
    row('r3', '2026-09-12T10:00:00.000Z', { conversationId: 'C', taskId: 'T', subtaskId: 'X' }),
  ],
  'rows with no conversation link cannot be deduped': [
    row('a', '2026-09-10T10:00:00.000Z', { taskId: 'T', subtaskId: 'X' }),
    row('b', '2026-09-11T10:00:00.000Z', { taskId: 'T', subtaskId: 'Y' }),
  ],
  'two conversations, one per subtask': [
    row('a', '2026-09-10T10:00:00.000Z', { conversationId: 'C1', taskId: 'T', subtaskId: 'X' }),
    row('b', '2026-09-11T10:00:00.000Z', { conversationId: 'C2', taskId: 'T', subtaskId: 'Y' }),
  ],
}

for (const [name, rows] of Object.entries(SHAPES)) {
  test(`the gate agrees with the board's per-subtask sessionsUsed — ${name}`, () => {
    expect(gateCounts(SUBS, rows)).toEqual(boardCounts(SUBS, rows))
  })
}

test('moved: X has NO session, Y has one', () => {
  const rows = SHAPES['moved: old row on X, newest row on Y']!
  expect(subtaskHasSession(TASK, 'X', rows)).toBe(false)
  expect(subtaskHasSession(TASK, 'Y', rows)).toBe(true)
})

test('a reopen that carries no taskId leaves the conversation where the old row filed it', () => {
  // `conversationOwners` ignores a row with no `taskId` (a reopen does not inherit the filing), so
  // the conversation is still T's; and that newest row names no task of ours, so the OLD row is the
  // one that stands for it inside T — X keeps its session, exactly as the board shows.
  const rows = SHAPES['reopen that did not inherit the filing (name only, no id)']!
  expect(subtaskHasSession(TASK, 'X', rows)).toBe(true)
})

test('an explicit unfile (taskId "") frees the subtask', () => {
  const rows = SHAPES['unfiled by a detach (taskId is the empty string)']!
  expect(subtaskHasSession(TASK, 'X', rows)).toBe(false)
})

test('rows with no conversation link keep counting on the subtask they name', () => {
  const rows = SHAPES['rows with no conversation link cannot be deduped']!
  expect(subtaskHasSession(TASK, 'X', rows)).toBe(true)
  expect(subtaskHasSession(TASK, 'Y', rows)).toBe(true)
  expect(subtaskHasSession(TASK, 'Z', rows)).toBe(false)
})

// ---- the real write path (out-of-process) -----------------------------------------------------

const SESSIONS_DIR = import.meta.dir

async function run(body: string): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-subtask-has-session-'))
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
  return JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? '{}')
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
const group = (id: string, taskId: string) => subtask(id, taskId, 'isGroup: true,')
const session = (id: string, createdAt: string, over = '') => `
  await registry.add({ id: '${id}', harness: 'claude', cwd: '/tmp/x', createdAt: '${createdAt}', ${over} })
`
const historical = (conversationId: string, taskId: string, subtaskId: string, linkedAt: string) => `
  await store.fileHistorical({
    id: 'hist:${conversationId}', conversationId: '${conversationId}', harness: 'claude',
    taskId: '${taskId}', subtaskId: '${subtaskId}', linkedAt: '${linkedAt}',
  })
`

test('REAL CASE: a conversation MOVED from X to Y — X joins a group and can be refused done, Y cannot join', async () => {
  const out = await run(`
    ${task('T')}
    ${group('G', 'T')}
    ${subtask('X', 'T')}
    ${subtask('Y', 'T')}
    ${session('old', '2026-09-10T10:00:00.000Z', "conversationId: 'C', taskId: 'T', subtaskId: 'X',")}
    ${session('new', '2026-09-12T10:00:00.000Z', "conversationId: 'C', taskId: 'T', subtaskId: 'Y',")}
    const xDone = await web.patchSubtask('X', { status: 'done' })
    const xJoin = await web.patchSubtask('X', { parentGroupId: 'G' })
    const yJoin = await web.patchSubtask('Y', { parentGroupId: 'G' })
    const yDone = await web.patchSubtask('Y', { status: 'done' })
    const after = await store.read()
    console.log(JSON.stringify({ xDone, xJoin, yJoin, yDone, xGroup: after.subtasks.find(s => s.id === 'X').parentGroupId ?? null }))
  `)
  // X has no session on the board: a `done` is refused for want of one (not silently allowed on the
  // strength of a row that is only history), and it is FREE to join a group.
  expect(out.xDone).toEqual({ ok: true })
  expect(out.xJoin).toEqual({ ok: true })
  expect(out.xGroup).toBe('G')
  // Y holds the conversation NOW: it cannot join (its session would drop out of every breakdown)...
  expect(out.yJoin).toEqual({ ok: false, message: 'subtask_has_sessions' })
  // ...and may be marked done.
  expect(out.yDone).toEqual({ ok: true })
})

test('a reopen that did not inherit the filing leaves the old row standing — X still has its session', async () => {
  const out = await run(`
    ${task('T')}
    ${group('G', 'T')}
    ${subtask('X', 'T')}
    ${session('old', '2026-09-10T10:00:00.000Z', "conversationId: 'C', taskId: 'T', subtaskId: 'X',")}
    ${session('reopen', '2026-09-12T10:00:00.000Z', "conversationId: 'C', task: 'T',")}
    const xJoin = await web.patchSubtask('X', { parentGroupId: 'G' })
    console.log(JSON.stringify({ xJoin }))
  `)
  expect(out.xJoin).toEqual({ ok: false, message: 'subtask_has_sessions' })
})

test('a conversation UNFILED by a detach frees the subtask its old row still names', async () => {
  const out = await run(`
    ${task('T')}
    ${group('G', 'T')}
    ${subtask('X', 'T')}
    ${session('old', '2026-09-10T10:00:00.000Z', "conversationId: 'C', taskId: 'T', subtaskId: 'X',")}
    ${session('detached', '2026-09-12T10:00:00.000Z', "conversationId: 'C', taskId: '',")}
    const xJoin = await web.patchSubtask('X', { parentGroupId: 'G' })
    console.log(JSON.stringify({ xJoin }))
  `)
  expect(out.xJoin).toEqual({ ok: true })
})

test('a conversation moved to ANOTHER task no longer counts on the subtask it left', async () => {
  const out = await run(`
    ${task('T')}
    ${task('OTHER')}
    ${group('G', 'T')}
    ${subtask('X', 'T')}
    ${subtask('Q', 'OTHER')}
    ${session('old', '2026-09-10T10:00:00.000Z', "conversationId: 'C', taskId: 'T', subtaskId: 'X',")}
    ${session('new', '2026-09-12T10:00:00.000Z', "conversationId: 'C', taskId: 'OTHER', subtaskId: 'Q',")}
    const xJoin = await web.patchSubtask('X', { parentGroupId: 'G' })
    console.log(JSON.stringify({ xJoin }))
  `)
  expect(out.xJoin).toEqual({ ok: true })
})

test('a HISTORICAL link on X counts — and unlocks done', async () => {
  const out = await run(`
    ${task('T')}
    ${group('G', 'T')}
    ${subtask('X', 'T')}
    ${subtask('W', 'T')}
    ${historical('HC', 'T', 'X', '2026-09-12T10:00:00.000Z')}
    const xJoin = await web.patchSubtask('X', { parentGroupId: 'G' })
    const xDone = await web.patchSubtask('X', { status: 'done' })
    const wDone = await web.patchSubtask('W', { status: 'done' })
    console.log(JSON.stringify({ xJoin, xDone, wDone }))
  `)
  expect(out.xJoin).toEqual({ ok: false, message: 'subtask_has_sessions' })
  expect(out.xDone).toEqual({ ok: true })
  expect(out.wDone).toEqual({ ok: true })
})

test('a superseded registry row on X plus a NEWER historical link on Y: X has no session', async () => {
  const out = await run(`
    ${task('T')}
    ${group('G', 'T')}
    ${subtask('X', 'T')}
    ${subtask('Y', 'T')}
    ${session('old', '2026-09-10T10:00:00.000Z', "conversationId: 'C', taskId: 'T', subtaskId: 'X',")}
    ${historical('C', 'T', 'Y', '2026-09-15T10:00:00.000Z')}
    const xJoin = await web.patchSubtask('X', { parentGroupId: 'G' })
    const yJoin = await web.patchSubtask('Y', { parentGroupId: 'G' })
    console.log(JSON.stringify({ xJoin, yJoin }))
  `)
  expect(out.xJoin).toEqual({ ok: true })
  expect(out.yJoin).toEqual({ ok: false, message: 'subtask_has_sessions' })
})

test('rows with NO conversation link keep counting exactly as before', async () => {
  const out = await run(`
    ${task('T')}
    ${group('G', 'T')}
    ${subtask('X', 'T')}
    ${session('a', '2026-09-10T10:00:00.000Z', "taskId: 'T', subtaskId: 'X',")}
    ${session('b', '2026-09-12T10:00:00.000Z', "taskId: 'T', subtaskId: 'X',")}
    const xJoin = await web.patchSubtask('X', { parentGroupId: 'G' })
    const xDone = await web.patchSubtask('X', { status: 'done' })
    console.log(JSON.stringify({ xJoin, xDone }))
  `)
  expect(out.xJoin).toEqual({ ok: false, message: 'subtask_has_sessions' })
  expect(out.xDone).toEqual({ ok: true })
})

test('re-marking done: a subtask whose only row is history reads as sessionless, and markTask on the task is untouched', async () => {
  // X is `done` but its only registry row is a superseded one (the conversation lives on Y now).
  // Unchecking and re-checking X is refused for want of a session — what the board already shows —
  // while the TASK-level gate (`rowsOfTask` is non-empty because of Y's row) is not affected.
  const out = await run(`
    ${task('T')}
    ${subtask('X', 'T', "status: 'done', done: true,")}
    ${subtask('Y', 'T')}
    ${session('old', '2026-09-10T10:00:00.000Z', "conversationId: 'C', taskId: 'T', subtaskId: 'X',")}
    ${session('new', '2026-09-12T10:00:00.000Z', "conversationId: 'C', taskId: 'T', subtaskId: 'Y',")}
    const uncheck = await web.setSubtaskDone('X', false)
    const recheck = await web.setSubtaskDone('X', true)
    const taskDone = await web.markTask('T', 'done')
    console.log(JSON.stringify({ uncheck, recheck, taskDone: taskDone.ok }))
  `)
  expect(out.uncheck).toEqual({ ok: true })
  expect(out.recheck).toEqual({ ok: true })
  expect(out.taskDone).toBe(true)
})

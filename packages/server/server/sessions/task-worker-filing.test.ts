import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filingTargetOf, planWorkerFilingBackfill, reportedByTaskSession, workerFilingTarget } from './task-worker-filing'
import type { BoardRow } from './types'

/**
 * FILIACAO.TOAST — a worker filed on the TASK alone that reports on a subtask is filed on that
 * subtask, so the piece it delivered reaches `done` instead of `done_needs_session`. Measured on the
 * real board 2026-11-15: 10 pieces in review, 4 in CI and 2 in progress had their worker filed on the
 * task only while its verified comments sat on the piece.
 */

const subs = [
  { id: 's1', taskId: 't1' },
  { id: 's2', taskId: 't1' },
  { id: 'g', taskId: 't1' },
  { id: 'm', taskId: 't1', parentGroupId: 'g' },
  { id: 'x', taskId: 't2' },
]
const row = (o: Partial<BoardRow> & { id: string }): BoardRow => ({ harness: 'claude', cwd: '/x', createdAt: '2026-11-01T00:00:00.000Z', ...o } as BoardRow)

test('filingTargetOf: the piece itself, a member resolves to its group, another task is nothing', () => {
  expect(filingTargetOf('t1', 's1', subs)).toBe('s1')
  expect(filingTargetOf('t1', 'm', subs)).toBe('g')
  expect(filingTargetOf('t1', 'x', subs)).toBeNull()
  expect(filingTargetOf('t1', 'nope', subs)).toBeNull()
})

test('workerFilingTarget: only a worker on the same task with no subtask yet', () => {
  const base = { commentTaskId: 't1', commentSubtaskId: 's1', subtasks: subs }
  expect(workerFilingTarget({ ...base, row: { taskId: 't1' }, role: 'worker' })).toBe('s1')
  // a leader comments on every piece it coordinates: never moved
  expect(workerFilingTarget({ ...base, row: { taskId: 't1' }, role: 'leader' })).toBeNull()
  expect(workerFilingTarget({ ...base, row: { taskId: 't1' }, role: undefined })).toBeNull()
  // already on a piece: never moved by a comment elsewhere
  expect(workerFilingTarget({ ...base, row: { taskId: 't1', subtaskId: 's2' }, role: 'worker' })).toBeNull()
  // another task: never touched
  expect(workerFilingTarget({ ...base, row: { taskId: 't2' }, role: 'worker' })).toBeNull()
  expect(workerFilingTarget({ ...base, row: undefined, role: 'worker' })).toBeNull()
  expect(workerFilingTarget({ ...base, commentSubtaskId: undefined, row: { taskId: 't1' }, role: 'worker' })).toBeNull()
})

test('reportedByTaskSession: a verified session OWNED by the task that reported on the piece (or a member of it)', () => {
  const rows = [
    row({ id: 'lead', conversationId: 'c1', taskId: 't1' }),
    row({ id: 'gone', conversationId: 'c9', taskId: '' }), // explicitly unfiled
    row({ id: 'away', conversationId: 'c2', taskId: 't2' }),
  ]
  const owners = new Map([['c1', 't1'], ['c2', 't2']])
  const c = (o: Partial<{ subtaskId: string; role: string; sessionId: string; kind: string | undefined }>) => ({ taskId: 't1', subtaskId: 's1', role: 'session', sessionId: 'lead', kind: 'handback', ...o })
  expect(reportedByTaskSession('t1', 's1', [c({})], rows, owners, subs)).toBe(true)
  expect(reportedByTaskSession('t1', 'g', [c({ subtaskId: 'm' })], rows, owners, subs)).toBe(true)
  expect(reportedByTaskSession('t1', 's1', [c({ role: undefined })], rows, owners, subs)).toBe(false)
  expect(reportedByTaskSession('t1', 's1', [c({ sessionId: 'away' })], rows, owners, subs)).toBe(false)
  expect(reportedByTaskSession('t1', 's1', [c({ sessionId: 'gone' })], rows, owners, subs)).toBe(false)
  expect(reportedByTaskSession('t1', 's1', [c({ sessionId: 'nobody' })], rows, owners, subs)).toBe(false)
  expect(reportedByTaskSession('t1', 's2', [c({})], rows, owners, subs)).toBe(false)
  expect(reportedByTaskSession('t1', 's1', [c({ kind: 'decision' })], rows, owners, subs)).toBe(true)
  expect(reportedByTaskSession('t1', 's1', [c({ kind: 'note' })], rows, owners, subs)).toBe(false)
  expect(reportedByTaskSession('t1', 's1', [c({ kind: undefined })], rows, owners, subs)).toBe(false)
})

test('planWorkerFilingBackfill: files the newest row, skips leaders, reports ambiguity, idempotent', () => {
  const rows = [
    row({ id: 'w1', conversationId: 'c1', taskId: 't1', parentSessionId: 'p' }),
    // a reopen of the same conversation, which did not carry the filing: the newest row is filed
    row({ id: 'w1b', conversationId: 'c1', createdAt: '2026-11-02T00:00:00.000Z' }),
    row({ id: 'lead', conversationId: 'c2', taskId: 't1' }),
    row({ id: 'w3', conversationId: 'c3', taskId: 't1', parentSessionId: 'p' }),
    row({ id: 'w4', conversationId: 'c4', taskId: 't1', subtaskId: 's2', parentSessionId: 'p' }),
  ]
  const comments = [
    { taskId: 't1', subtaskId: 's1', role: 'session', sessionId: 'w1' },
    { taskId: 't1', subtaskId: 's1', role: 'session', sessionId: 'w1' },
    { taskId: 't1', subtaskId: 's1', role: 'session', sessionId: 'lead' },
    { taskId: 't1', subtaskId: 's1', role: 'session', sessionId: 'w3' },
    { taskId: 't1', subtaskId: 'm', role: 'session', sessionId: 'w3' },
    { taskId: 't1', subtaskId: 's1', role: 'session', sessionId: 'w4' },
    { taskId: 't1', subtaskId: 's1', sessionId: 'w1' }, // not a verified session comment
  ]
  const roleOf = (r: BoardRow) => (r.parentSessionId ? 'worker' as const : 'leader' as const)
  const plan = planWorkerFilingBackfill({ rows, comments, subtasks: subs, roleOf })
  expect(plan.file).toEqual([{ sessionId: 'w1b', taskId: 't1', subtaskId: 's1' }])
  expect(plan.ambiguous).toEqual([{ sessionId: 'w3', taskId: 't1', subtaskIds: ['g', 's1'] }])

  // After applying: the newest row now carries the filing, and a second plan is empty.
  const applied = rows.map(r => (r.id === 'w1b' ? { ...r, taskId: 't1', subtaskId: 's1' } : r))
  expect(planWorkerFilingBackfill({ rows: applied, comments, subtasks: subs, roleOf }).file).toEqual([])
})

// ---- end to end, through the real store (one process per scenario: config.ts reads env at load)
const SESSIONS_DIR = import.meta.dir
async function run(body: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-worker-filing-'))
  const script = `
    const cfg = await import(${JSON.stringify(join(SESSIONS_DIR, '..', 'config.ts'))})
    const { createTaskStore } = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-store.ts'))})
    const { createSessionRegistry } = await import(${JSON.stringify(join(SESSIONS_DIR, 'registry.ts'))})
    const web = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-web.ts'))})
    const store = createTaskStore(cfg.TASKS_FILE)
    const registry = createSessionRegistry(cfg.MANAGED_SESSIONS_FILE)
    const at = '2026-11-01T00:00:00.000Z'
    await store.upsertTask({ id: 't1', title: 't1', status: 'in_progress', createdAt: at, updatedAt: at })
    await store.upsertSubtask({ id: 's1', taskId: 't1', title: 's1', status: 'in_review', done: false, createdAt: at, updatedAt: at })
    await store.upsertSubtask({ id: 's2', taskId: 't1', title: 's2', status: 'todo', done: false, createdAt: at, updatedAt: at })
    ${body}
  `
  const proc = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, AGENTISTICS_DIR: dir }, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`script failed: ${err.trim().split('\n').slice(-8).join(' | ')}`)
  return JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? '{}')
}

test('a worker filed on the task that reports on a piece is filed there, and the piece reaches done', async () => {
  const out = await run(`
    await registry.add({ id: 'w1', harness: 'codex', cwd: '/x', createdAt: at, conversationId: 'c1', parentSessionId: 'p', taskId: 't1' })
    const c = await web.addComment('t1', { author: 'codex:qa', body: 'QA PASS', subtaskId: 's1', session: 'w1', kind: 'handback' })
    const rows = await registry.read()
    const done = await web.patchSubtask('s1', { status: 'done' }, { principal: { kind: 'unattributed' } })
    console.log(JSON.stringify({ c: c.ok, sub: rows.find(r => r.id === 'w1').subtaskId, done }))
  `)
  expect(out).toEqual({ c: true, sub: 's1', done: { ok: true } })
})

test('a leader reporting on a piece is NOT moved off the task, and its verified report lets the piece close', async () => {
  const out = await run(`
    const { writeFile } = await import('node:fs/promises')
    await writeFile(cfg.AGENTISTICS_DATA_DIR + '/session-roles.json', JSON.stringify({ version: 1, migrated: true, roles: { lead: 'leader' } }))
    await registry.add({ id: 'lead', harness: 'claude', cwd: '/x', createdAt: at, conversationId: 'c2', taskId: 't1' })
    const refusedBefore = await web.patchSubtask('s2', { status: 'done' }, { principal: { kind: 'unattributed' } })
    await web.addComment('t1', { author: 'claude:lead', body: 'vou ver', subtaskId: 's2', session: 'lead' })
    const refusedAfterNote = await web.patchSubtask('s2', { status: 'done' }, { principal: { kind: 'unattributed' } })
    await web.addComment('t1', { author: 'claude:lead', body: 'covered by s1', subtaskId: 's2', session: 'lead', kind: 'decision' })
    const rows = await registry.read()
    const done = await web.patchSubtask('s2', { status: 'done' }, { principal: { kind: 'unattributed' } })
    console.log(JSON.stringify({ sub: rows.find(r => r.id === 'lead').subtaskId ?? null, refusedBefore, refusedAfterNote, done }))
  `)
  expect(out).toEqual({ sub: null, refusedBefore: { ok: false, message: 'done_needs_session' }, refusedAfterNote: { ok: false, message: 'done_needs_session' }, done: { ok: true } })
})

test('an UNVERIFIED comment, or a session of ANOTHER task, never satisfies the gate', async () => {
  const out = await run(`
    await store.upsertTask({ id: 't2', title: 't2', status: 'todo', createdAt: at, updatedAt: at })
    await registry.add({ id: 'other', harness: 'claude', cwd: '/x', createdAt: at, conversationId: 'c3', taskId: 't2' })
    await web.addComment('t1', { author: 'someone', body: 'done it', subtaskId: 's2' })
    await web.addComment('t1', { author: 'claude:other', body: 'done it', subtaskId: 's2', session: 'other' })
    const done = await web.patchSubtask('s2', { status: 'done' }, { principal: { kind: 'unattributed' } })
    console.log(JSON.stringify({ done }))
  `)
  expect(out).toEqual({ done: { ok: false, message: 'done_needs_session' } })
})

test('the backfill repairs an existing store once and is idempotent', async () => {
  const out = await run(`
    await registry.add({ id: 'w1', harness: 'claude', cwd: '/x', createdAt: at, conversationId: 'c1', parentSessionId: 'p', taskId: 't1' })
    await store.addComment({ id: 'cm1', taskId: 't1', subtaskId: 's1', author: 'claude:worker', body: 'parte 1 pronta', createdAt: at, role: 'session', sessionId: 'w1' })
    const dry = await web.backfillWorkerFiling({ apply: false })
    const before = (await registry.read()).find(r => r.id === 'w1').subtaskId ?? null
    const first = await web.backfillWorkerFiling({ apply: true })
    const second = await web.backfillWorkerFiling({ apply: true })
    const done = await web.patchSubtask('s1', { status: 'done' }, { principal: { kind: 'unattributed' } })
    console.log(JSON.stringify({ dry: dry.planned.length, before, first: first.filed.length, second: second.planned.length, done }))
  `)
  expect(out).toEqual({ dry: 1, before: null, first: 1, second: 0, done: { ok: true } })
})

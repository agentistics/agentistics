import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { attachAfterSpawn, planReopenCwd, planSpawnFiling, planSpawnFilingSafe } from './spawn-filing-io'
import { addSession, readRegistry, removeSession } from './registry'
import { spawnSessionFilingRequest } from './spawn-row'
import { createTaskStore } from './task-store'
import { TASKS_FILE } from '../config'
import { planFleetSpawn } from './fleet-spawn'
import type { ManagedSession } from './types'
import type { Subtask, Task } from './task-model'

// A git hook exports GIT_DIR & co.; a temp repo must not resolve to the hooked one.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_') && k !== 'GIT_TERMINAL_PROMPT') delete process.env[k]

// Pass the environment explicitly: hook variables must not reach fixture git subprocesses.
const gitClean = (args: string[]) => Bun.spawnSync(['git', ...args], { env: gitTestEnv() })
const dirs: string[] = []
const gitDir = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sfio-')))
  dirs.push(d)
  gitClean(['init', '-q', d])
  return d
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const now = '2026-10-16T00:00:00Z'
const T = (id: string, title: string): Task => ({ id, title, status: 'todo', createdAt: now, updatedAt: now })
const S = (id: string, taskId: string, title: string, e: Partial<Subtask> = {}): Subtask =>
  ({ id, taskId, title, done: false, status: 'todo', createdAt: now, updatedAt: now, ...e })
const row = (id: string, cwd: string): ManagedSession => ({ id, harness: 'claude', cwd, createdAt: now })
const book = { tasks: [T('t-1', 'One')], subtasks: [S('s-b', 't-1', 'Blocker'), S('s-1', 't-1', 'Blocked', { blockedBy: ['s-b'] })] }
const inRepo = async (d: string): Promise<{ repo: string; worktree: boolean; missing: boolean }> => ({ repo: 'o/r', worktree: false, missing: !existsSync(d) })
const common = { book, groups: { groups: [] }, repoFacts: inRepo }

describe('planSpawnFiling (IO layer)', () => {
  test('a person in a main checkout with a live session is accepted; a worker is refused', async () => {
    const d = gitDir()
    const o = { ...common, ...spawnSessionFilingRequest({ cwd: d }), rows: [row('a1', d)], liveIds: new Set(['a1']) }
    expect((await planSpawnFiling(o)).ok).toBe(true)
    expect(await planSpawnFiling({ ...o, role: 'worker' })).toMatchObject({ ok: false, code: 'cwd_shared_checkout' })
    expect((await planSpawnFiling({ ...o, role: 'worker', sharedCwd: true })).ok).toBe(true)
  })

  test('single CLI, batch and web workers all refuse the live parent checkout', async () => {
    const d = gitDir()
    const parent = row('parent', d)
    const base = { ...common, rows: [parent], liveIds: new Set([parent.id]) }
    const requests = [
      { role: 'worker' as const, cwd: d, callerSessionId: parent.id }, // CLI start
      { role: 'worker' as const, cwd: d, callerSessionId: parent.id, extraLiveCwds: [] }, // batch, first spec
      spawnSessionFilingRequest({ cwd: d, parentSessionId: parent.id, parentVerified: true }),
    ]
    for (const request of requests) {
      expect(await planSpawnFiling({ ...base, ...request })).toMatchObject({ ok: false, code: 'cwd_shared_checkout' })
      const shared = await planSpawnFiling({ ...base, ...request, sharedCwd: true })
      expect(shared.ok).toBe(true)
      if (shared.ok) expect(shared.warnings).toContain('shared_checkout_override')
    }
  })

  test('reopening a worker uses the shared-checkout rule and excludes only the replaced row', async () => {
    const d = gitDir()
    const entry = { ...row('old', d), parentSessionId: 'parent' }
    const options = { ...common, role: 'worker' as const, rows: [entry, row('other', d)], liveIds: new Set(['old', 'other']) }
    expect(await planReopenCwd(entry, options)).toMatchObject({ ok: false, code: 'cwd_shared_checkout' })
    expect(await planReopenCwd(entry, { ...options, liveIds: new Set(['old']) })).toMatchObject({ ok: true })
    expect(await planReopenCwd(entry, { ...options, role: 'leader' })).toMatchObject({ ok: true })
    expect(await planReopenCwd(entry, { ...options, repoFacts: async () => ({ repo: 'o/r', worktree: true }) })).toMatchObject({ ok: true })
  })

  test('a checkout reached through a symlinked row cwd is still seen as shared', async () => {
    const d = gitDir()
    const link = join(tmpdir(), `sfio-link-${process.pid}`)
    symlinkSync(d, link); dirs.push(link)
    const o = { ...common, cwd: d, role: 'worker' as const, rows: [row('a1', link)], liveIds: new Set(['a1']) }
    expect(await planSpawnFiling(o)).toMatchObject({ ok: false, code: 'cwd_shared_checkout' })
  })

  test('two workers of one batch cannot share a main checkout', async () => {
    const d = gitDir()
    const o = { ...common, cwd: d, role: 'worker' as const, rows: [], liveIds: new Set<string>() }
    expect((await planSpawnFiling(o)).ok).toBe(true)
    expect(await planSpawnFiling({ ...o, extraLiveCwds: [d] })).toMatchObject({ ok: false, code: 'cwd_shared_checkout' })
  })

  test('only workers refuse a blocked subtask before spawn; persons and hand-offs retain the filing', async () => {
    const o = { ...common, taskRef: 't-1', subtaskRef: 's-1', rows: [], liveIds: new Set<string>() }
    expect(await planSpawnFiling(o)).toMatchObject({ ok: true, taskId: 't-1', subtaskId: 's-1' })
    expect(await planSpawnFiling({ ...o, role: 'worker' })).toMatchObject({ ok: false, code: 'subtask_refused' })
    const predecessor = { ...row('previous', process.cwd()), taskId: 't-1', subtaskId: 's-1' }
    expect(await planSpawnFiling({ ...o, ...spawnSessionFilingRequest({ cwd: process.cwd(), parentSessionId: 'previous', handoff: true }), rows: [predecessor] }))
      .toMatchObject({ ok: true, role: 'leader', taskId: 't-1', subtaskId: 's-1' })
  })

  test('a blocked group reached via its member still refuses workers, but accepts a person', async () => {
    const o = { ...common, book: { ...book, subtasks: [...book.subtasks,
      S('s-group', 't-1', 'Group', { isGroup: true, blockedBy: ['s-b'] }),
      S('s-member', 't-1', 'Member', { parentGroupId: 's-group' }),
    ] }, subtaskRef: 's-member', rows: [], liveIds: new Set<string>() }
    expect(await planSpawnFiling(o)).toMatchObject({ ok: true, subtaskId: 's-group' })
    expect(await planSpawnFiling({ ...o, role: 'worker' })).toMatchObject({ ok: false, code: 'subtask_refused' })
  })

  test('spawnSession request: no parent + blocked subtask spawns, then attach reports blocked', async () => {
    const store = createTaskStore(TASKS_FILE)
    const task = T('t-sfio-web', 'Web blocked regression')
    const blocker = S('s-sfio-blocker', task.id, 'Blocker')
    const blocked = S('s-sfio-blocked', task.id, 'Blocked', { blockedBy: [blocker.id] })
    await store.upsertTask(task)
    await store.upsertSubtask(blocker)
    await store.upsertSubtask(blocked)
    const decision = planFleetSpawn({ harness: 'claude', cwd: process.cwd(), taskId: task.id, subtaskId: blocked.id }, [{ id: 'claude', supportsModel: true, efforts: [] }])
    expect(decision.ok).toBe(true)
    if (!decision.ok) throw new Error('unexpected fleet refusal')
    const request = spawnSessionFilingRequest(decision.plan)
    expect(request.role).toBeUndefined()
    const plan = await planSpawnFiling({ ...request, book: { tasks: [task], subtasks: [blocker, blocked] }, groups: { groups: [] }, rows: [], liveIds: new Set<string>(), repoFacts: inRepo })
    expect(plan).toMatchObject({ ok: true, taskId: task.id, subtaskId: blocked.id })
    if (!plan.ok) throw new Error('unexpected filing refusal')
    let spawned = 0
    const backend = { spawn: async () => { spawned++; await addSession(row('sfio-web', plan.cwd)); return { ok: true as const, id: 'sfio-web' } } }
    try {
      const result = await backend.spawn()
      expect(await attachAfterSpawn(plan, result.id)).toEqual({ ok: false, reason: 'blocked' })
      expect(spawned).toBe(1)
      // This is also the refusal the wizard receives when it retries attach to offer resolution.
      const { attachSession } = await import('./task-web')
      expect(await attachSession(task.id, result.id, { subtaskId: blocked.id })).toMatchObject({ ok: false, reason: 'blocked', blockedBy: [blocker.id] })
    } finally { await removeSession('sfio-web') }
  })

  test('a pending task is planned as if it existed; --subtask on it is refused', async () => {
    const base = { ...common, rows: [], liveIds: new Set<string>(), taskRef: 't-new' }
    expect((await planSpawnFiling({ ...base, pendingTask: { id: 't-new', title: 'Brand new' } })).ok).toBe(true)
    expect(await planSpawnFiling({ ...base, pendingTask: { id: 't-new', title: 'Brand new' }, subtaskRef: 'Planner' }))
      .toMatchObject({ ok: false, code: 'no_such_subtask' })
    expect(await planSpawnFiling({ ...base, pendingTask: { id: 't-new', title: 'Brand new' }, cwd: '/does/not/exist/x' }))
      .toMatchObject({ ok: false, code: 'cwd_missing' })
  })

  test('a board that cannot be read is board_unreadable, not cwd_missing', async () => {
    const r = await planSpawnFilingSafe({ ...common, rows: Object.assign([] as ManagedSession[], { map() { throw new Error('registry unreadable') } }) })
    expect(r).toMatchObject({ ok: false, code: 'board_unreadable' })
  })
})

describe('attachAfterSpawn', () => {
  test('a task-level refusal clears task title, taskId and subtaskId', async () => {
    await addSession({ ...row('sfio-stamped', process.cwd()), task: 'Ghost task', taskId: 't-ghost-sfio', subtaskId: 's-ghost-sfio' })
    try {
      const r = await attachAfterSpawn({ taskId: 't-ghost-sfio', subtaskId: 's-ghost-sfio' }, 'sfio-stamped')
      expect(r.ok).toBe(false)
      const row = (await readRegistry()).find(m => m.id === 'sfio-stamped')
      expect(row).toBeDefined()
      expect(row?.subtaskId).toBeUndefined()
      expect(row?.taskId).toBeUndefined()
      expect(row?.task).toBeUndefined()
    } finally { await removeSession('sfio-stamped') }
  })

  test('wrong_delivery clears the refused task filing too', async () => {
    const store = createTaskStore(TASKS_FILE)
    const task = T('t-sfio-delivery', 'Requested delivery')
    const other = T('t-sfio-other-delivery', 'Other delivery')
    const subtask = S('s-sfio-other-delivery', other.id, 'Other subtask')
    await store.upsertTask(task)
    await store.upsertTask(other)
    await store.upsertSubtask(subtask)
    await addSession({ ...row('sfio-wrong-delivery', process.cwd()), task: task.title, taskId: task.id, subtaskId: subtask.id })
    try {
      expect(await attachAfterSpawn({ taskId: task.id, subtaskId: subtask.id }, 'sfio-wrong-delivery'))
        .toEqual({ ok: false, reason: 'wrong_delivery' })
      const stored = (await readRegistry()).find(m => m.id === 'sfio-wrong-delivery')
      expect(stored).toBeDefined()
      expect(stored?.taskId).toBeUndefined()
      expect(stored?.subtaskId).toBeUndefined()
      expect(stored?.task).toBeUndefined()
    } finally { await removeSession('sfio-wrong-delivery') }
  })

})

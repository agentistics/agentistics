import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachAfterSpawn, planSpawnFiling, planSpawnFilingSafe } from './spawn-filing-io'
import { addSession, readRegistry, removeSession } from './registry'
import type { ManagedSession } from './types'
import type { Subtask, Task } from './task-model'

// A git hook exports GIT_DIR & co.; a temp repo must not resolve to the hooked one.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_') && k !== 'GIT_TERMINAL_PROMPT') delete process.env[k]
const dirs: string[] = []
const gitDir = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sfio-')))
  dirs.push(d)
  Bun.spawnSync(['git', 'init', '-q', d])
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
    const o = { ...common, cwd: d, rows: [row('a1', d)], liveIds: new Set(['a1']) }
    expect((await planSpawnFiling(o)).ok).toBe(true)
    expect(await planSpawnFiling({ ...o, role: 'worker' })).toMatchObject({ ok: false, code: 'cwd_shared_checkout' })
    expect((await planSpawnFiling({ ...o, role: 'worker', sharedCwd: true })).ok).toBe(true)
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

  test('a blocked subtask is refused BEFORE a spawn, identically for every site', async () => {
    const r = await planSpawnFiling({ ...common, subtaskRef: 's-1', rows: [], liveIds: new Set<string>() })
    expect(r).toMatchObject({ ok: false, code: 'subtask_refused' })
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
  test('a refused attach is reported and the row does not stay stamped with the subtask', async () => {
    await addSession({ ...row('sfio-stamped', process.cwd()), taskId: 't-ghost-sfio', subtaskId: 's-ghost-sfio' })
    try {
      const r = await attachAfterSpawn({ taskId: 't-ghost-sfio', subtaskId: 's-ghost-sfio' }, 'sfio-stamped')
      expect(r.ok).toBe(false)
      expect((await readRegistry()).find(m => m.id === 'sfio-stamped')?.subtaskId).toBeUndefined()
    } finally { await removeSession('sfio-stamped') }
  })
})

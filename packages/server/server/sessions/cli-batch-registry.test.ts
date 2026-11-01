import { beforeAll, describe, expect, test, beforeEach, afterEach } from 'bun:test'

// Hermetic: a batch run here is the owner's unless a test sets a caller itself (never the runner's own session).
const runnerId = process.env.AGENTOP_MANAGED_ID
beforeEach(() => { delete process.env.AGENTOP_MANAGED_ID })
afterEach(() => { if (runnerId === undefined) delete process.env.AGENTOP_MANAGED_ID; else process.env.AGENTOP_MANAGED_ID = runnerId })
import { batch } from './cli-session'
import { readRegistry } from './registry'
import { createTaskStore } from './task-store'
import { TASKS_FILE } from '../config'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { addSession, removeSession } from './registry'
import { start } from './cli-session'
import type { SessionBackend } from './types'
import { isolateAgentEnv } from './agent-env.testing'

// A spawn door reads AGENTOP_*/AGENTISTICS_* from the shell it runs in (inside a managed session: the caller's identity and the feature
// switches): every test starts from a bare agent environment and gets it back.
isolateAgentEnv()

// A git hook exports GIT_DIR & co.; a temp repo must not resolve to the hooked one.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_') && k !== 'GIT_TERMINAL_PROMPT') delete process.env[k]

// Pass the environment explicitly: hook variables must not reach fixture git subprocesses.
const gitClean = (args: string[]) => Bun.spawnSync(['git', ...args], { env: gitTestEnv() })

describe('batch — the registry row brackets the spawn', () => {
  beforeAll(async () => {
    const store = createTaskStore(TASKS_FILE)
    const now = '2026-10-16T00:00:00Z'
    await store.upsertTask({ id: 't-s4row', title: 'S4 row task', status: 'in_progress', createdAt: now, updatedAt: now })
    await store.upsertSubtask({ id: 's-s4row', taskId: 't-s4row', title: 'S4 row subtask', done: false, status: 'todo', createdAt: now, updatedAt: now })
  })

  test('the row exists BEFORE the pane is spawned, and is removed when the spawn fails', async () => {
    const seen: boolean[] = []
    const backend = {
      id: 'tmux',
      unavailable: async () => undefined,
      spawn: async (req: { id: string }) => {
        seen.push((await readRegistry()).some(m => m.id === req.id))
        throw new Error('pane refused')
      },
      list: async () => [],
      capture: async () => [],
      kill: async () => {},
    } as unknown as SessionBackend
    const before = (await readRegistry()).length
    const log = console.log
    console.log = () => {}
    try {
      const code = await batch({
        kind: 'batch', task: 'registry-order', json: true, force: true,
        specs: [{ harness: 'claude', prompt: 'x', cwd: process.cwd() }],
      } as Parameters<typeof batch>[0], backend)
      expect(code).not.toBe(0)
    } finally {
      console.log = log
    }
    expect(seen).toEqual([true])
    expect((await readRegistry()).length).toBe(before)
  })

  test('a --subtask reaches the ROW (taskId, subtaskId and the real task title), not only the briefing', async () => {
    let row: Awaited<ReturnType<typeof readRegistry>>[number] | undefined
    const backend = {
      id: 'tmux', unavailable: async () => undefined,
      spawn: async (req: { id: string }) => { row = (await readRegistry()).find(m => m.id === req.id); throw new Error('pane refused') },
      list: async () => [], capture: async () => [], kill: async () => {},
    } as unknown as SessionBackend
    const log = console.log
    console.log = () => {}
    try {
      await batch({
        kind: 'batch', task: 'S4 row task', subtask: 'S4 row subtask', json: true, force: true,
        specs: [{ harness: 'claude', prompt: 'x', cwd: process.cwd() }],
      } as Parameters<typeof batch>[0], backend)
    } finally {
      console.log = log
    }
    expect(row).toMatchObject({ taskId: 't-s4row', subtaskId: 's-s4row', task: 'S4 row task' })
  })

  test('an unknown subtask refuses the whole batch before anything is registered', async () => {
    const before = (await readRegistry()).length
    let spawned = 0
    const backend = {
      id: 'tmux', unavailable: async () => undefined,
      spawn: async () => { spawned++ }, list: async () => [], capture: async () => [], kill: async () => {},
    } as unknown as SessionBackend
    const log = console.log
    console.log = () => {}
    let code: number
    try {
      code = await batch({
        kind: 'batch', task: 'S4 row task', subtask: 'no such subtask', json: true, force: true,
        specs: [{ harness: 'claude', prompt: 'x', cwd: process.cwd() }],
      } as Parameters<typeof batch>[0], backend)
    } finally {
      console.log = log
    }
    expect(code).toBe(1)
    expect(spawned).toBe(0)
    expect((await readRegistry()).length).toBe(before)
  })

  const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
    const log = console.log, err = console.error
    console.log = () => {}; console.error = () => {}
    try { return await f() } finally { console.log = log; console.error = err }
  }
  const fake = (spawned: Array<{ id: string }>, live: string[] = []) => ({
    id: 'tmux', unavailable: async () => undefined,
    spawn: async (req: { id: string }) => { spawned.push(req); throw new Error('pane refused') },
    list: async () => live.map(id => ({ id, alive: true })), capture: async () => [], kill: async () => {},
  }) as unknown as SessionBackend

  test('H2: a NEW task title combined with any other refusal creates no task and no attempt', async () => {
    const store = createTaskStore(TASKS_FILE)
    const cases: Array<[string, Partial<Parameters<typeof batch>[0]>, string]> = [
      ['subtask', { subtask: 'Planner' }, process.cwd()],
      ['cwd', {}, '/does/not/exist/sfio'],
      ['folder', {}, process.cwd()],
    ]
    for (const [name, extra, cwd] of cases) {
      const title = `H2 brand new ${name} ${Date.now()}`
      const before = await store.read()
      const spawned: Array<{ id: string }> = []
      const code = await quiet(() => batch({
        kind: 'batch', task: title, json: true, force: true, ...extra,
        specs: [{ harness: 'claude', prompt: 'x', cwd, attempt: 'a1', ...(name === 'folder' ? { folder: 'no-such-folder-sfio' } : {}) }],
      } as Parameters<typeof batch>[0], fake(spawned)))
      const after = await store.read()
      expect(code).toBe(1)
      expect(spawned.length).toBe(0)
      expect(after.tasks.length).toBe(before.tasks.length)
      expect(after.attempts.length).toBe(before.attempts.length)
      expect(after.tasks.some(t => t.title === title)).toBe(false)
    }
  })

  test('H2: a NEW task title with nothing wrong still creates the task and stamps its real id on the row', async () => {
    const title = `H2 ok ${Date.now()}`
    let row: Awaited<ReturnType<typeof readRegistry>>[number] | undefined
    const backend = { ...(fake([])), spawn: async (req: { id: string }) => { row = (await readRegistry()).find(m => m.id === req.id); throw new Error('pane refused') } } as unknown as SessionBackend
    await quiet(() => batch({ kind: 'batch', task: title, json: true, force: true, specs: [{ harness: 'claude', prompt: 'x', cwd: process.cwd(), attempt: 'a1' }] } as Parameters<typeof batch>[0], backend))
    const t = (await createTaskStore(TASKS_FILE).read()).tasks.find(x => x.title === title)
    expect(t).toBeDefined()
    expect(row).toMatchObject({ taskId: t!.id, task: title })
  })

  test('H1: a person (no parent session, no role) starts in a main checkout another session is live in', async () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'h1-')))
    expect(gitClean(['init', '-q', d]).exitCode).toBe(0)
    expect(gitClean(['-C', d, 'remote', 'add', 'origin', 'https://github.com/fixture/spawn-s4.git']).exitCode).toBe(0)
    await addSession({ id: 'h1-live', harness: 'claude', cwd: d, createdAt: '2026-10-16T00:00:00Z' })
    const prev = process.env.AGENTOP_MANAGED_ID
    delete process.env.AGENTOP_MANAGED_ID
    try {
      const a: Array<{ id: string }> = [], b: Array<{ id: string }> = []
      await quiet(() => start({ kind: 'start', harness: 'claude', background: true, prompt: 'x', cwd: d, force: true } as Parameters<typeof start>[0], fake(a, ['h1-live'])))
      await quiet(() => batch({ kind: 'batch', task: 'S4 row task', json: true, force: true, specs: [{ harness: 'claude', prompt: 'x', cwd: d }] } as Parameters<typeof batch>[0], fake(b, ['h1-live'])))
      expect(a.length).toBe(1)
      expect(b.length).toBe(1)
      // Negative controls: the exact same checkout really does refuse workers.
      const workers: Array<{ id: string }> = []
      await quiet(() => start({ kind: 'start', role: 'worker', harness: 'claude', background: true, prompt: 'x', cwd: d, force: true } as Parameters<typeof start>[0], fake(workers, ['h1-live'])))
      process.env.AGENTOP_MANAGED_ID = 'h1-parent'
      await quiet(() => batch({ kind: 'batch', task: 'S4 row task', json: true, force: true, specs: [{ harness: 'claude', prompt: 'x', cwd: d }] } as Parameters<typeof batch>[0], fake(workers, ['h1-live'])))
      expect(workers).toEqual([])
    } finally {
      if (prev !== undefined) process.env.AGENTOP_MANAGED_ID = prev
      else delete process.env.AGENTOP_MANAGED_ID
      await removeSession('h1-live'); rmSync(d, { recursive: true, force: true })
    }
  })

  test('M2: start and batch write the same filing fields on the row for the same inputs', async () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'm2-filing-')))
    const previousCaller = process.env.AGENTOP_MANAGED_ID
    delete process.env.AGENTOP_MANAGED_ID
    try {
      expect(gitClean(['init', '-q', d]).exitCode).toBe(0)
      expect(gitClean(['-C', d, 'remote', 'add', 'origin', 'https://github.com/fixture/m2-filing.git']).exitCode).toBe(0)
      // Filing may bind a task to its repo before the recording backend refuses the process.
      // Keep both the task and checkout private to this parity test.
      const taskId = 't-m2-filing'
      const subtaskId = 's-m2-filing'
      const taskTitle = 'M2 filing parity task'
      const subtaskTitle = 'M2 filing parity subtask'
      const now = '2026-10-16T00:00:00Z'
      const store = createTaskStore(TASKS_FILE)
      await store.upsertTask({ id: taskId, title: taskTitle, status: 'in_progress', createdAt: now, updatedAt: now })
      await store.upsertSubtask({ id: subtaskId, taskId, title: subtaskTitle, done: false, status: 'todo', createdAt: now, updatedAt: now })
      const rows: Array<Record<string, unknown>> = []
      const mk = () => ({ ...(fake([])), spawn: async (req: { id: string }) => { const r = (await readRegistry()).find(m => m.id === req.id); rows.push({ task: r?.task, taskId: r?.taskId, subtaskId: r?.subtaskId }); throw new Error('pane refused') } }) as unknown as SessionBackend
      await quiet(() => start({ kind: 'start', harness: 'claude', background: true, prompt: 'x', cwd: d, force: true, task: taskTitle, subtask: subtaskTitle } as Parameters<typeof start>[0], mk()))
      await quiet(() => batch({ kind: 'batch', task: taskTitle, subtask: subtaskTitle, json: true, force: true, specs: [{ harness: 'claude', prompt: 'x', cwd: d }] } as Parameters<typeof batch>[0], mk()))
      expect(rows.length).toBe(2)
      expect(rows[0]).toEqual(rows[1])
      expect(rows[0]).toMatchObject({ taskId, subtaskId, task: taskTitle })
    } finally {
      if (previousCaller === undefined) delete process.env.AGENTOP_MANAGED_ID
      else process.env.AGENTOP_MANAGED_ID = previousCaller
      rmSync(d, { recursive: true, force: true })
    }
  })
})

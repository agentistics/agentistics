import { describe, expect, test } from 'bun:test'
import { batch } from './cli-session'
import { readRegistry } from './registry'
import { createTaskStore } from './task-store'
import { TASKS_FILE } from '../config'
import type { SessionBackend } from './types'

describe('batch — the registry row brackets the spawn', () => {
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
    const store = createTaskStore(TASKS_FILE)
    const now = '2026-10-16T00:00:00Z'
    await store.upsertTask({ id: 't-s4row', title: 'S4 row task', status: 'in_progress', createdAt: now, updatedAt: now })
    await store.upsertSubtask({ id: 's-s4row', taskId: 't-s4row', title: 'S4 row subtask', done: false, status: 'todo', createdAt: now, updatedAt: now })
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
})

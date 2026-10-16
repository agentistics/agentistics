import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planFiling, type FilingInput, type FilingPlan } from './spawn-filing'
import { filingJson, filingRow } from './spawn-row'
import type { Subtask, Task } from './task-model'

const T = (id: string, title: string): Task => ({ id, title, status: 'todo', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' })
const S = (id: string, taskId: string, title: string, extra: Partial<Subtask> = {}): Subtask =>
  ({ id, taskId, title, done: false, status: 'todo', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra })

const input = (over: Partial<FilingInput>): FilingInput => ({
  role: 'worker', callerCwd: '/w',
  book: {
    tasks: [T('t-1', 'Atomic spawn'), T('t-2', 'Other')],
    subtasks: [S('s-1', 't-1', 'Planner'), S('s-g', 't-1', 'Group', { isGroup: true }), S('s-m', 't-1', 'Member', { parentGroupId: 's-g' })],
  },
  rows: [], groups: { groups: [] },
  repoOf: () => ({ worktree: false }), liveInCwd: () => 0,
  ...over,
})

/** One planner output → one row, whichever of the three spawn sites asks. */
const TABLE: Array<[string, Partial<FilingInput>, { task?: string; taskId?: string; subtaskId?: string }]> = [
  ['task by id', { taskRef: 't-1' }, { task: 'Atomic spawn', taskId: 't-1' }],
  ['task by exact title', { taskRef: 'Atomic spawn' }, { task: 'Atomic spawn', taskId: 't-1' }],
  ['subtask by title', { taskRef: 't-1', subtaskRef: 'Planner' }, { task: 'Atomic spawn', taskId: 't-1', subtaskId: 's-1' }],
  ['subtask alone brings its task', { subtaskRef: 's-1' }, { task: 'Atomic spawn', taskId: 't-1', subtaskId: 's-1' }],
  ['group member is filed on its group', { taskRef: 't-1', subtaskRef: 'Member' }, { task: 'Atomic spawn', taskId: 't-1', subtaskId: 's-g' }],
  ['no filing', {}, {}],
]

describe('one plan, one row', () => {
  for (const [name, over, want] of TABLE) {
    test(name, () => {
      const plan = planFiling(input(over)) as Extract<FilingPlan, { ok: true }>
      expect(plan.ok).toBe(true)
      expect(filingRow(plan)).toEqual(want)
      // identical inputs give identical rows, however many sites ask
      expect(filingRow(planFiling(input(over)) as Extract<FilingPlan, { ok: true }>)).toEqual(filingRow(plan))
    })
  }
  test('a free-text name survives only when nothing is filed on the board', () => {
    const none = planFiling(input({})) as Extract<FilingPlan, { ok: true }>
    expect(filingRow(none, 'wizard name')).toEqual({ task: 'wizard name' })
    const filed = planFiling(input({ taskRef: 't-1' })) as Extract<FilingPlan, { ok: true }>
    expect(filingRow(filed, 'wizard name').task).toBe('Atomic spawn')
  })
  test('--json carries the filing block', () => {
    const plan = planFiling(input({ taskRef: 't-1', subtaskRef: 'Planner', groups: { groups: [{ id: 'f', name: 'Work', sessionKeys: [] }] }, folderRef: 'Work' })) as Extract<FilingPlan, { ok: true }>
    expect(filingJson(plan)).toEqual({
      taskId: 't-1', subtaskId: 's-1', folder: { id: 'f', path: 'Work', source: 'explicit' },
      cwd: '/w', role: 'worker', warnings: [],
    })
  })
})

describe('the three spawn sites share the planner and the row builder', () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf8')
  test('start and batch (cli-session) and spawnSession (cli-start) all plan through spawn-filing-io', () => {
    for (const f of ['sessions/cli-session.ts', 'cli-start.ts']) {
      expect(read(f)).toContain('spawn-filing-io')
    }
  })
  test('start and batch build their row with filingRow', () => {
    const src = read('sessions/cli-session.ts')
    expect([...src.matchAll(/\.\.\.filingRow\(/g)].length).toBe(2)
  })
  test('spawnSession takes the row title from filingRow and files through attachSession', () => {
    const src = read('cli-start.ts')
    expect(src).toContain('filingRow(filing')
    expect(src).toContain('attachSession(taskId')
  })
})

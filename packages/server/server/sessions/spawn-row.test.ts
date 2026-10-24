import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planFiling, type FilingInput, type FilingPlan } from './spawn-filing'
import { filingJson, filingRow, spawnRole, WARNING_TEXT } from './spawn-row'
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
  test('inherited repository mismatch is rendered and retained in JSON filing output', () => {
    const plan = planFiling(input({
      caller: { id: 'parent', harness: 'claude', cwd: '/parent', createdAt: '2026-10-01T00:00:00Z', taskId: 't-1' },
      book: { tasks: [{ ...T('t-1', 'Atomic spawn'), repo: 'agentistics/agentistics' }], subtasks: [] },
      repoOf: () => ({ remote: 'github.com/agentistics/agentistics-engine', worktree: true }),
    }))
    if (!plan.ok) throw new Error(`expected ok, got ${plan.code}`)
    expect(filingRow(plan)).toEqual({ task: 'Atomic spawn', taskId: 't-1' })
    expect(filingJson(plan).warnings).toContain('inherited_task_repo_mismatch')
    expect(WARNING_TEXT.inherited_task_repo_mismatch).toContain('still filed on that task')
  })
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



describe('spawnRole shared by start, batch and spawnSession', () => {
  const cases: Array<[string, Parameters<typeof spawnRole>[0], ReturnType<typeof spawnRole>]> = [
    ['person', {}, undefined],
    ['explicit worker', { explicit: 'worker' }, 'worker'],
    ['parent implies worker', { hasParent: true }, 'worker'],
    ['explicit leader', { explicit: 'leader' }, 'leader'],
    ['leader prefix', { leaderPrefix: true }, 'leader'],
    ['leader prefix beats parent', { leaderPrefix: true, hasParent: true }, 'leader'],
    ['explicit worker beats prefix', { explicit: 'worker', leaderPrefix: true }, 'worker'],
    ['explicit leader beats parent', { explicit: 'leader', hasParent: true }, 'leader'],
    ['handoff', { handoff: true, hasParent: true }, 'leader'],
    ['handoff beats explicit worker', { handoff: true, explicit: 'worker' }, 'leader'],
  ]
  for (const [name, input, role] of cases) test(name, () => expect(spawnRole(input)).toBe(role))
})

describe('ORQ.FORA API filing request', () => {
  test('only a verified parent supplies ordinary worker inheritance', async () => {
    const { spawnSessionFilingRequest } = await import('./spawn-row')
    expect(spawnSessionFilingRequest({ cwd: '/w', parentSessionId: 'parent' }).callerSessionId).toBeUndefined()
    expect(spawnSessionFilingRequest({ cwd: '/w', parentSessionId: 'parent', parentVerified: true }).callerSessionId).toBe('parent')
  })
  test('leader labels and handoff reach the common planner', async () => {
    const { spawnSessionFilingRequest } = await import('./spawn-row')
    expect(spawnSessionFilingRequest({ cwd: '/w', harness: 'codex', label: '[ LEADER ] - Next', parentSessionId: 'parent', parentVerified: true })).toMatchObject({ role: 'leader', callerSessionId: 'parent', harness: 'codex' })
    expect(spawnSessionFilingRequest({ cwd: '/w', parentSessionId: 'parent', handoff: true })).toMatchObject({ role: 'leader', handoffOf: 'parent' })
  })
})

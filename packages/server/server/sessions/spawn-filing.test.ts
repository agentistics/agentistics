import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionUserGroupsValue } from '@agentistics/core'
import { planFiling, type FilingInput, type FilingPlan, type FilingRepo } from './spawn-filing'
import type { ManagedSession } from './types'
import type { Subtask, Task } from './task-model'

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

const T = (id: string, title: string, repo?: string): Task =>
  ({ id, title, status: 'todo', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...(repo ? { repo } : {}) })
const S = (id: string, taskId: string, title: string, extra: Partial<Subtask> = {}): Subtask =>
  ({ id, taskId, title, done: false, status: 'todo', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra })
const R = (id: string, extra: Partial<ManagedSession> = {}): ManagedSession =>
  ({ id, harness: 'claude', cwd: '/w', createdAt: '2026-10-10T00:00:00Z', ...extra })

const REMOTE = 'github.com/agentistics/agentistics'
const ENGINE = 'github.com/agentistics/agentistics-engine'

/** The directory world: a main checkout, a worktree of it, the engine clone, a workspace, a gone dir. */
const DIRS: Record<string, FilingRepo | null> = {
  '/home/u/agentistics': { repo: 'agentistics/agentistics', worktree: false },
  '/home/u/agentistics/.claude/worktrees/x': { repo: 'agentistics/agentistics', worktree: true },
  '/home/u/agentistics-engine': { remote: ENGINE, worktree: false },
  '/home/u/workspace': { worktree: false },
  '/home/u/Agentistics-CASE': { repo: 'Agentistics/Agentistics', worktree: true },
  '/home/u/elsewhere': { repo: 'agentistics/agentistics', worktree: true },
  '/home/u/gitlab': { remote: 'gitlab.com/agentistics/agentistics', worktree: false },
  '/home/u/plain-clone': { repo: 'agentistics', worktree: false },
}
const repoOf = (dir: string): FilingRepo | null => (dir in DIRS ? DIRS[dir]! : null)

const book = {
  tasks: [
    T('t-1', 'Atomic spawn', REMOTE),
    T('t-2', 'Loose task'),
    T('t-3', 'Twin'),
    T('t-4', 'Twin'),
    T('t-5', 'Atomic spawn follow-up'),
  ],
  subtasks: [
    S('s-1', 't-1', 'Planner'),
    S('s-g', 't-1', 'Wiring group', { isGroup: true }),
    S('s-m', 't-1', 'Wire batch', { parentGroupId: 's-g' }),
    S('s-2', 't-2', 'Planner'),
    S('s-o', 't-gone', 'Orphan'),
  ],
}

const base = (over: Partial<FilingInput> = {}): FilingInput => ({
  role: 'worker',
  callerCwd: '/home/u/agentistics/.claude/worktrees/x',
  book,
  rows: [],
  groups: { groups: [] },
  repoOf,
  liveInCwd: () => 0,
  ...over,
})

const ok = (p: FilingPlan) => {
  if (!p.ok) throw new Error(`expected ok, got ${p.code}: ${p.detail}`)
  return p
}
const refused = (p: FilingPlan) => {
  if (p.ok) throw new Error('expected a refusal')
  return p
}

// ── purity ─────────────────────────────────────────────────────────────────────────────────────

describe('purity', () => {
  test('spawn-filing and finished-folder import no IO', () => {
    for (const f of ['spawn-filing.ts', 'finished-folder.ts']) {
      const src = readFileSync(join(import.meta.dir, f), 'utf8')
      const imports = [...src.matchAll(/^import\s+(type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm)]
      for (const [, isType, mod] of imports) {
        if (isType) continue
        expect(['@agentistics/core', './finished-folder']).toContain(mod!)
      }
      expect(src).not.toMatch(/\bnode:|\bBun\.|process\./)
      expect(src).not.toMatch(/\brequire\s*\(|\bimport\s*\(|^export\s[^;\n]*\sfrom\s/m)
    }
  })
})

// ── task / subtask resolution (rule 1) ─────────────────────────────────────────────────────────

describe('task and subtask references', () => {
  test('a task resolves by id and by exact title, and the row gets its REAL title', () => {
    expect(ok(planFiling(base({ taskRef: 't-1' })))).toMatchObject({ taskId: 't-1', taskTitle: 'Atomic spawn' })
    expect(ok(planFiling(base({ taskRef: '  Atomic spawn ' })))).toMatchObject({ taskId: 't-1', taskTitle: 'Atomic spawn' })
  })
  test('no_such_task names the closest titles, never keeps the text as a name', () => {
    const p = refused(planFiling(base({ taskRef: 'atomic' })))
    expect(p.code).toBe('no_such_task')
    expect(p.candidates).toEqual(['Atomic spawn (t-1)', 'Atomic spawn follow-up (t-5)'])
  })
  test('no_such_task with no close title has no candidates', () => {
    expect(refused(planFiling(base({ taskRef: 'zzz' })))).toMatchObject({ code: 'no_such_task', candidates: [] })
  })
  test('two tasks with the same exact title are ambiguous', () => {
    const p = refused(planFiling(base({ taskRef: 'Twin' })))
    expect(p.code).toBe('ambiguous_task')
    expect(p.candidates).toEqual(['Twin (t-3)', 'Twin (t-4)'])
  })
  test('a subtask must belong to the given task', () => {
    expect(ok(planFiling(base({ taskRef: 't-1', subtaskRef: 'Planner' })))).toMatchObject({ taskId: 't-1', subtaskId: 's-1' })
    const p = refused(planFiling(base({ taskRef: 't-1', subtaskRef: 's-2' })))
    expect(p.code).toBe('no_such_subtask')
    expect(p.candidates).toEqual(['Planner (s-1)', 'Wiring group (s-g)', 'Wire batch (s-m)'])
  })
  test('two subtasks of one task with the same title are ambiguous', () => {
    const twin = { tasks: book.tasks, subtasks: [...book.subtasks, S('s-1b', 't-1', 'Planner')] }
    const p = refused(planFiling(base({ book: twin, taskRef: 't-1', subtaskRef: 'Planner' })))
    expect(p).toMatchObject({ code: 'ambiguous_subtask', candidates: ['Planner (s-1)', 'Planner (s-1b)'] })
  })
  test('a member whose group is not on the board is filed on itself (planAttach then decides)', () => {
    const lone = { tasks: book.tasks, subtasks: [S('s-x', 't-1', 'Stray', { parentGroupId: 's-none' })] }
    const p = ok(planFiling(base({ book: lone, taskRef: 't-1', subtaskRef: 's-x' })))
    expect(p.subtaskId).toBe('s-x')
    expect(p.memberOf).toBeUndefined()
  })
  test('a subtask without a task resolves board-wide and brings its task', () => {
    expect(ok(planFiling(base({ subtaskRef: 's-2' })))).toMatchObject({ taskId: 't-2', subtaskId: 's-2', taskTitle: 'Loose task' })
  })
  test('a board-wide subtask title on two tasks is ambiguous', () => {
    const p = refused(planFiling(base({ subtaskRef: 'Planner' })))
    expect(p.code).toBe('ambiguous_subtask')
    expect(p.candidates).toEqual(['Planner (s-1)', 'Planner (s-2)'])
  })
  test('an unknown board-wide subtask is refused', () => {
    expect(refused(planFiling(base({ subtaskRef: 'nope' }))).code).toBe('no_such_subtask')
  })
  test('a subtask whose task is gone is subtask_needs_task', () => {
    expect(refused(planFiling(base({ subtaskRef: 's-o' }))).code).toBe('subtask_needs_task')
  })
  test('a group MEMBER is filed on its group, and the redirect is stated', () => {
    const p = ok(planFiling(base({ taskRef: 't-1', subtaskRef: 'Wire batch' })))
    expect(p.subtaskId).toBe('s-g')
    expect(p.memberOf).toEqual({ member: 's-m', group: 's-g' })
    expect(p.warnings).toContain('subtask_member_filed_on_group')
  })
  test('a group or loose subtask is filed on itself', () => {
    expect(ok(planFiling(base({ taskRef: 't-1', subtaskRef: 's-g' }))).subtaskId).toBe('s-g')
    expect(ok(planFiling(base({ taskRef: 't-1', subtaskRef: 's-g' }))).memberOf).toBeUndefined()
  })
  test('no task at all is a plain, unfiled spawn', () => {
    const p = ok(planFiling(base({ callerCwd: '/home/u/workspace' })))
    expect(p.taskId).toBeUndefined()
    expect(p.subtaskId).toBeUndefined()
  })
  test('blank references are treated as absent', () => {
    expect(ok(planFiling(base({ taskRef: '  ', subtaskRef: '' }))).taskId).toBeUndefined()
  })
})

// ── cwd (rule 3) ───────────────────────────────────────────────────────────────────────────────

describe('cwd', () => {
  test('explicit cwd in the task repo is accepted (a worktree shares the remote)', () => {
    const p = ok(planFiling(base({ taskRef: 't-1', cwd: '/home/u/agentistics/.claude/worktrees/x', callerCwd: '/home/u/workspace' })))
    expect(p).toMatchObject({ cwd: '/home/u/agentistics/.claude/worktrees/x', cwdSource: 'explicit' })
  })
  test('the caller cwd is used when it belongs to the task repo', () => {
    expect(ok(planFiling(base({ taskRef: 't-1' })))).toMatchObject({ cwd: '/home/u/agentistics/.claude/worktrees/x', cwdSource: 'caller' })
  })
  test('repo match ignores the host and the case', () => {
    expect(ok(planFiling(base({ taskRef: 't-1', cwd: '/home/u/Agentistics-CASE' }))).cwdSource).toBe('explicit')
  })
  test('explicit cwd in another repo is cwd_wrong_repo, with candidates of the right remote', () => {
    const rows = [
      R('a', { cwd: '/home/u/agentistics/.claude/worktrees/x' }),
      R('b', { cwd: '/home/u/agentistics-engine' }),
      R('c', { cwd: '/home/u/agentistics/.claude/worktrees/x' }),
      R('d', { cwd: '/home/u/elsewhere', repo: { repo: 'agentistics/agentistics', worktree: true } }),
    ]
    const p = refused(planFiling(base({ taskRef: 't-1', cwd: '/home/u/agentistics-engine', rows })))
    expect(p.code).toBe('cwd_wrong_repo')
    expect(p.candidates).toEqual(['/home/u/agentistics/.claude/worktrees/x', '/home/u/elsewhere'])
  })
  test('candidates also come from the injected checkout list, deduplicated', () => {
    const p = refused(planFiling(base({
      taskRef: 't-1', cwd: '/home/u/workspace',
      checkoutsOf: key => key === 'agentistics/agentistics' ? ['/home/u/agentistics', '/home/u/agentistics'] : [],
    })))
    expect(p).toMatchObject({ code: 'cwd_wrong_repo', candidates: ['/home/u/agentistics'] })
  })
  test('no cwd and a caller outside the task repo is cwd_needed', () => {
    const p = refused(planFiling(base({ taskRef: 't-1', callerCwd: '/home/u/workspace' })))
    expect(p.code).toBe('cwd_needed')
  })
  test('a directory that does not exist is cwd_missing', () => {
    expect(refused(planFiling(base({ cwd: '/gone' }))).code).toBe('cwd_missing')
    expect(refused(planFiling(base({ taskRef: 't-1', cwd: '/gone' }))).code).toBe('cwd_missing')
    expect(refused(planFiling(base({ callerCwd: '/gone' }))).code).toBe('cwd_missing')
  })
  test('a repo fact that says missing is cwd_missing', () => {
    expect(refused(planFiling(base({ cwd: '/m', repoOf: () => ({ worktree: false, missing: true }) }))).code).toBe('cwd_missing')
  })
  test('a task with no repo accepts any existing directory', () => {
    expect(ok(planFiling(base({ taskRef: 't-2', cwd: '/home/u/workspace' })))).toMatchObject({ cwd: '/home/u/workspace' })
  })
})

// ── shared checkout (rule 4) ───────────────────────────────────────────────────────────────────

describe('shared checkout', () => {
  const live = (d: string) => (d === '/home/u/agentistics' ? 1 : 0)
  test('a worker in a MAIN checkout with a live session there is refused', () => {
    const p = refused(planFiling(base({ cwd: '/home/u/agentistics', liveInCwd: live })))
    expect(p.code).toBe('cwd_shared_checkout')
    expect(p.detail).toContain('git worktree add')
  })
  test('the same main checkout with nobody live is fine', () => {
    expect(ok(planFiling(base({ cwd: '/home/u/agentistics' }))).cwd).toBe('/home/u/agentistics')
  })
  test('a worktree is never a shared checkout', () => {
    expect(ok(planFiling(base({ liveInCwd: () => 3 }))).cwdSource).toBe('caller')
  })
  test('a directory outside any repo is never a shared checkout', () => {
    expect(ok(planFiling(base({ cwd: '/home/u/workspace', liveInCwd: () => 3 }))).cwd).toBe('/home/u/workspace')
  })
  test('sharedCwd overrides the refusal and says so', () => {
    const p = ok(planFiling(base({ cwd: '/home/u/agentistics', liveInCwd: live, sharedCwd: true })))
    expect(p.warnings).toContain('shared_checkout_override')
  })
})

// ── leaders (rule 6 / exemptions) ──────────────────────────────────────────────────────────────

describe('leaders', () => {
  test('a leader is exempt from the repo check', () => {
    const p = ok(planFiling(base({ role: 'leader', taskRef: 't-1', callerCwd: '/home/u/workspace' })))
    expect(p).toMatchObject({ role: 'leader', cwd: '/home/u/workspace', cwdSource: 'caller', taskId: 't-1' })
  })
  test('a leader is exempt from the shared-checkout check', () => {
    expect(ok(planFiling(base({ role: 'leader', cwd: '/home/u/agentistics', liveInCwd: () => 2 }))).warnings).not.toContain('shared_checkout_override')
  })
  test('a leader still needs an existing directory', () => {
    expect(refused(planFiling(base({ role: 'leader', cwd: '/gone' }))).code).toBe('cwd_missing')
  })
})

// ── folder (rule 5) ────────────────────────────────────────────────────────────────────────────

describe('folder', () => {
  const groups: SessionUserGroupsValue = {
    groups: [
      { id: 'top', name: 'Motor', sessionKeys: [] },
      { id: 'run', name: 'Em andamento', sessionKeys: ['conv-old', 'sub-recent'], parentId: 'top' },
      { id: 'fin', name: 'Finalizadas', sessionKeys: ['task-newest'], parentId: 'top' },
      { id: 'other', name: 'Other', sessionKeys: ['task-mid', 'caller'] },
    ],
  }
  const rows = [
    R('old', { conversationId: 'conv-old', taskId: 't-1', subtaskId: 's-1', createdAt: '2026-10-01T00:00:00Z' }),
    R('sub-recent', { taskId: 't-1', subtaskId: 's-1', createdAt: '2026-10-05T00:00:00Z' }),
    R('task-mid', { taskId: 't-1', createdAt: '2026-10-08T00:00:00Z' }),
    R('task-newest', { taskId: 't-1', createdAt: '2026-10-09T00:00:00Z' }),
    R('unfiled', { taskId: '', createdAt: '2026-10-12T00:00:00Z' }),
    R('caller', { taskId: 't-1', createdAt: '2026-09-01T00:00:00Z' }),
  ]
  test('explicit wins and is resolved by name or path', () => {
    expect(ok(planFiling(base({ folderRef: 'Motor/Em andamento', groups, rows, taskRef: 't-1' })))).toMatchObject({ folderId: 'run', folderSource: 'explicit' })
    expect(ok(planFiling(base({ folderRef: 'other', groups })))).toMatchObject({ folderId: 'other', folderSource: 'explicit' })
  })
  test('an unknown or ambiguous explicit folder is refused', () => {
    expect(refused(planFiling(base({ folderRef: 'Nope', groups }))).code).toBe('no_such_folder')
    const twin = { groups: [{ id: 'a', name: 'X', sessionKeys: [] }, { id: 'b', name: 'X', sessionKeys: [] }] }
    const p = refused(planFiling(base({ folderRef: 'X', groups: twin })))
    expect(p.code).toBe('ambiguous_folder')
    expect(p.candidates).toEqual(['X (a)', 'X (b)'])
  })
  test('task: the newest session of the same SUBTASK wins over the task', () => {
    expect(ok(planFiling(base({ taskRef: 't-1', subtaskRef: 's-1', groups, rows })))).toMatchObject({ folderId: 'run', folderSource: 'task' })
  })
  test('task: else the newest session of the task, skipping finished folders', () => {
    // task-newest is in Finalizadas → skipped; task-mid is in Other.
    expect(ok(planFiling(base({ taskRef: 't-1', groups, rows })))).toMatchObject({ folderId: 'other', folderSource: 'task' })
  })
  test('task: a member subtask is matched through its group', () => {
    const r = [R('m', { taskId: 't-1', subtaskId: 's-g' })]
    const g = { groups: [{ id: 'gg', name: 'Wiring', sessionKeys: ['m'] }] }
    expect(ok(planFiling(base({ taskRef: 't-1', subtaskRef: 's-m', groups: g, rows: r })))).toMatchObject({ folderId: 'gg', folderSource: 'task' })
  })
  test('parent: the caller\'s folder when the caller is filed on the same task', () => {
    const g = { groups: [{ id: 'p', name: 'Lead', sessionKeys: ['caller'] }] }
    const caller = R('caller', { taskId: 't-1' })
    expect(ok(planFiling(base({ taskRef: 't-1', groups: g, rows: [caller], caller })))).toMatchObject({ folderId: 'p', folderSource: 'parent' })
    // no other filed session in a folder → parent
    const caller2 = R('lead', { taskId: 't-1' })
    const g2 = { groups: [{ id: 'p', name: 'Lead', sessionKeys: ['lead'] }] }
    expect(ok(planFiling(base({ taskRef: 't-1', groups: g2, rows: [], caller: caller2 })))).toMatchObject({ folderId: 'p', folderSource: 'parent' })
  })
  test('parent: inherited across tasks, but not from a finished folder', () => {
    const g = { groups: [{ id: 'p', name: 'Lead', sessionKeys: ['lead'] }, { id: 'f', name: 'Finished', sessionKeys: ['lead2'] }] }
    const p1 = ok(planFiling(base({ taskRef: 't-1', groups: g, caller: R('lead', { taskId: 't-2' }) })))
    expect(p1).toMatchObject({ folderId: 'p', folderSource: 'parent' })
    expect(p1.warnings).not.toContain('no_folder')
    expect(ok(planFiling(base({ taskRef: 't-1', groups: g, caller: R('lead2', { taskId: 't-1' }) }))).folderSource).toBe('none')
  })
  test('no task and no explicit folder inherits the parent folder', () => {
    expect(ok(planFiling(base({ groups, rows, caller: R('caller') })))).toMatchObject({ folderId: 'other', folderSource: 'parent' })
  })
  test('no task, explicit folder or parent folder → none', () => {
    expect(ok(planFiling(base({ groups, rows, caller: R('folderless-parent') })))).toMatchObject({ folderSource: 'none' })
  })
})

// ── hand-off ───────────────────────────────────────────────────────────────────────────────────

describe('hand-off', () => {
  const pred = R('pred', { conversationId: 'cp', cwd: '/home/u/workspace', taskId: 't-1', subtaskId: 's-1', leader: true })
  const groups = { groups: [{ id: 'lead', name: 'Lideres', sessionKeys: ['cp'] }, { id: 'w', name: 'Workers', sessionKeys: ['x'] }] }
  test('copies the predecessor cwd, filing and folder, and is always a leader', () => {
    const p = ok(planFiling(base({ role: 'worker', handoffOf: pred, groups, rows: [R('x', { taskId: 't-1', subtaskId: 's-1', createdAt: '2026-12-01T00:00:00Z' })] })))
    expect(p).toMatchObject({
      role: 'leader', cwd: '/home/u/workspace', cwdSource: 'predecessor',
      taskId: 't-1', subtaskId: 's-1', taskTitle: 'Atomic spawn', folderId: 'lead', folderSource: 'predecessor',
    })
  })
  test('a harness SWITCH inherits the same filing but keeps the role it was given (none stays none)', () => {
    for (const role of ['worker', undefined] as const) {
      const p = ok(planFiling(base({ role, handoffOf: pred, handoffKeepsRole: true, groups })))
      expect(p).toMatchObject({ cwd: '/home/u/workspace', taskId: 't-1', subtaskId: 's-1', folderId: 'lead' })
      expect(p.role).toBe(role)
    }
  })
  test('explicit references and folder still win', () => {
    const p = ok(planFiling(base({ handoffOf: pred, groups, taskRef: 't-2', folderRef: 'Workers', cwd: '/home/u/agentistics' })))
    expect(p).toMatchObject({ taskId: 't-2', folderId: 'w', folderSource: 'explicit', cwd: '/home/u/agentistics', cwdSource: 'explicit' })
  })
  test('a predecessor filed on a task that is gone is refused', () => {
    expect(refused(planFiling(base({ handoffOf: R('p', { cwd: '/home/u/workspace', taskId: 't-gone' }) }))).code).toBe('no_such_task')
  })
  test('a predecessor whose cwd is gone is refused', () => {
    expect(refused(planFiling(base({ handoffOf: R('p', { cwd: '/gone' }) }))).code).toBe('cwd_missing')
  })
  test('a predecessor in no folder yields the task-derived folder or none', () => {
    const p = ok(planFiling(base({ handoffOf: R('p', { cwd: '/home/u/workspace' }) })))
    expect(p).toMatchObject({ role: 'leader', folderSource: 'none' })
    expect(p.taskId).toBeUndefined()
  })
})

// ── S2 QA follow-ups (M1, M2, L1–L6) ────────────────────────────────────────────────────────────

describe('hand-off inheritance (M1, M2)', () => {
  const pred = (extra: Partial<ManagedSession>) => R('pred', { cwd: '/home/u/workspace', ...extra })

  test('M1: --subtask alone inherits the predecessor task, so a title on several tasks is not ambiguous', () => {
    const p = ok(planFiling(base({ handoffOf: pred({ taskId: 't-2' }), subtaskRef: 'Planner' })))
    expect(p).toMatchObject({ taskId: 't-2', subtaskId: 's-2' })
  })
  test('M1: a subtask the inherited task lacks is no_such_subtask, listing that task\'s subtasks', () => {
    const p = refused(planFiling(base({ handoffOf: pred({ taskId: 't-2' }), subtaskRef: 'Wire batch' })))
    expect(p.code).toBe('no_such_subtask')
    expect(p.candidates).toEqual(['Planner (s-2)'])
  })
  test('M1: when the inherited task is gone the named subtask resolves board-wide', () => {
    expect(ok(planFiling(base({ handoffOf: pred({ taskId: 't-gone' }), subtaskRef: 's-1' })))).toMatchObject({ taskId: 't-1', subtaskId: 's-1' })
  })
  test('M2: a gone inherited TASK says it came from the predecessor', () => {
    const p = refused(planFiling(base({ handoffOf: pred({ taskId: 't-gone' }) })))
    expect(p.code).toBe('no_such_task')
    expect(p.detail).toContain('inherited from the predecessor pred')
  })
  test('M2: a gone inherited SUBTASK says it came from the predecessor', () => {
    const p = refused(planFiling(base({ handoffOf: pred({ taskId: 't-1', subtaskId: 's-gone' }) })))
    expect(p.code).toBe('no_such_subtask')
    expect(p.detail).toContain('inherited from the predecessor pred')
  })
  test('M2: an EXPLICIT ref that is gone does not claim to be inherited', () => {
    const p = refused(planFiling(base({ handoffOf: pred({}), taskRef: 't-nope' })))
    expect(p.detail).not.toContain('inherited')
  })
})

describe('repository comparison (L1, L2)', () => {
  test('L1: when both sides carry a host, a different host is a different repository', () => {
    expect(refused(planFiling(base({ taskRef: 't-1', cwd: '/home/u/gitlab' }))).code).toBe('cwd_wrong_repo')
  })
  test('L2: a clone with no remote is accepted by its folder name', () => {
    expect(ok(planFiling(base({ taskRef: 't-1', cwd: '/home/u/plain-clone' }))).cwdSource).toBe('explicit')
  })
})

describe('SPAWN.REPO — short board repository names', () => {
  const shortBook = { tasks: [T('t-short', 'Workspace', 'agentistics/agentistics-workspace')], subtasks: [] }
  test('short task repo matches a full checkout remote', () => {
    const p = ok(planFiling(base({
      book: shortBook, taskRef: 't-short', cwd: '/home/u/workspace',
      repoOf: () => ({ remote: 'github.com/agentistics/agentistics-workspace', worktree: true }),
    })))
    expect(p).toMatchObject({ taskId: 't-short', cwd: '/home/u/workspace' })
    expect(p.warnings).not.toContain('inherited_task_repo_mismatch')
  })
  test('short task repo refuses a different checkout remote', () => {
    const p = refused(planFiling(base({
      book: shortBook, taskRef: 't-short', cwd: '/home/u/agentistics-engine',
    })))
    expect(p.code).toBe('cwd_wrong_repo')
  })
  test('short task repo accepts another organization with the same repository name after transfer', () => {
    expect(ok(planFiling(base({
      book: shortBook, taskRef: 't-short',
      repoOf: () => ({ remote: 'github.com/other/agentistics-workspace', worktree: true }),
    }))).taskId).toBe('t-short')
  })
  for (const repo of [REMOTE, 'https://github.com/agentistics/agentistics.git', 'git@github.com:agentistics/agentistics', 'ssh://git@github.com/agentistics/agentistics.git']) {
    test(`task remote retains host comparison: ${repo}`, () => {
      const remoteBook = { tasks: [T('t-remote', 'Remote', repo)], subtasks: [] }
      expect(ok(planFiling(base({ book: remoteBook, taskRef: 't-remote', repoOf: () => ({ remote: REMOTE, worktree: true }) }))).taskId).toBe('t-remote')
      expect(refused(planFiling(base({ book: remoteBook, taskRef: 't-remote', cwd: '/home/u/gitlab' }))).code).toBe('cwd_wrong_repo')
    })
  }
})

describe('SPAWN.TRANSFER — repository owner transfer', () => {
  for (const repo of ['blpsoares/agentistics', 'github.com/blpsoares/agentistics', 'https://github.com/blpsoares/agentistics.git', 'git@github.com:blpsoares/agentistics.git']) {
    const transferredBook = { tasks: [T('t-transfer', 'Transferred repo', repo)], subtasks: [] }
    test(`old task owner accepts the current checkout: ${repo}`, () => {
      const p = ok(planFiling(base({
        book: transferredBook, taskRef: 't-transfer',
        repoOf: () => ({ remote: REMOTE, worktree: true }),
      })))
      expect(p.taskId).toBe('t-transfer')
      expect(p.warnings).not.toContain('inherited_task_repo_mismatch')
    })
    test(`old task owner accepts short checkout facts: ${repo}`, () => {
      expect(ok(planFiling(base({ book: transferredBook, taskRef: 't-transfer' }))).taskId).toBe('t-transfer')
    })
    test(`old task owner refuses a different repository name: ${repo}`, () => {
      expect(refused(planFiling(base({
        book: transferredBook, taskRef: 't-transfer', cwd: '/home/u/agentistics-engine',
      }))).code).toBe('cwd_wrong_repo')
    })
    test(`old task owner lists transferred checkouts as candidates: ${repo}`, () => {
      const checkout = '/home/u/agentistics/.claude/worktrees/x'
      const p = refused(planFiling(base({
        book: transferredBook, taskRef: 't-transfer', cwd: '/home/u/workspace',
        rows: [R('transferred', { cwd: checkout }), R('other', { cwd: '/home/u/agentistics-engine' })],
        repoOf: dir => dir === checkout ? { remote: REMOTE, worktree: true } : repoOf(dir),
      })))
      expect(p).toMatchObject({ code: 'cwd_wrong_repo', candidates: [checkout] })
    })
  }
  test('different hosts stay different even when the owner also changed', () => {
    const transferredBook = { tasks: [T('t-transfer', 'Transferred repo', 'github.com/blpsoares/agentistics')], subtasks: [] }
    expect(refused(planFiling(base({
      book: transferredBook, taskRef: 't-transfer', cwd: '/home/u/gitlab',
    }))).code).toBe('cwd_wrong_repo')
  })
})

describe('SPAWN.REPO — inherited task repository policy', () => {
  const caller = R('leader', { taskId: 't-1', cwd: '/home/u/workspace' })
  test('inherited task and explicit cwd in another repo stay filed with a warning', () => {
    const p = ok(planFiling(base({ caller, cwd: '/home/u/agentistics-engine' })))
    expect(p).toMatchObject({ taskId: 't-1', taskTitle: 'Atomic spawn', cwd: '/home/u/agentistics-engine', cwdSource: 'explicit' })
    expect(p.warnings).toContain('inherited_task_repo_mismatch')
  })
  test('inherited task and caller cwd outside a repo stay filed with a warning', () => {
    const p = ok(planFiling(base({ caller, callerCwd: '/home/u/workspace' })))
    expect(p).toMatchObject({ taskId: 't-1', cwdSource: 'caller' })
    expect(p.warnings).toContain('inherited_task_repo_mismatch')
  })
  test('inherited task in the same repo adds no mismatch warning', () => {
    expect(ok(planFiling(base({ caller }))).warnings).not.toContain('inherited_task_repo_mismatch')
  })
  test('explicit task still refuses another repo even when the caller has that task', () => {
    expect(refused(planFiling(base({ caller, taskRef: 't-1', cwd: '/home/u/agentistics-engine' }))).code).toBe('cwd_wrong_repo')
    expect(refused(planFiling(base({ caller, taskRef: 't-1', callerCwd: '/home/u/workspace' }))).code).toBe('cwd_needed')
  })
  test('inherited task mismatch does not bypass the missing directory guard', () => {
    expect(refused(planFiling(base({ caller, cwd: '/gone' }))).code).toBe('cwd_missing')
  })
  test('inherited task mismatch preserves shared checkout refusal and override warning', () => {
    const input = base({ caller, cwd: '/home/u/agentistics-engine', liveInCwd: () => 1 })
    expect(refused(planFiling(input)).code).toBe('cwd_shared_checkout')
    const p = ok(planFiling({ ...input, sharedCwd: true }))
    expect(p.taskId).toBe('t-1')
    expect(p.warnings).toContain('inherited_task_repo_mismatch')
    expect(p.warnings).toContain('shared_checkout_override')
  })
  test('a handoff still inherits its predecessor task across repositories', () => {
    const p = ok(planFiling(base({ handoffOf: caller })))
    expect(p).toMatchObject({ taskId: 't-1', cwd: '/home/u/workspace', role: 'leader' })
  })
  test('a subtask resolved outside a missing inherited task keeps its repository check', () => {
    expect(refused(planFiling(base({
      caller: R('leader', { taskId: 't-gone' }), subtaskRef: 's-1', cwd: '/home/u/agentistics-engine',
    }))).code).toBe('cwd_wrong_repo')
  })
})

describe('checkout candidates (L3)', () => {
  test('trailing slashes collapse, vanished directories drop out, newest first', () => {
    const rows = [
      R('old', { cwd: '/home/u/agentistics/.claude/worktrees/x/', createdAt: '2026-10-01T00:00:00Z' }),
      R('gone', { cwd: '/home/u/deleted', createdAt: '2026-10-09T00:00:00Z', repo: { repo: 'agentistics/agentistics', worktree: true } }),
      R('new', { cwd: '/home/u/elsewhere', createdAt: '2026-10-08T00:00:00Z' }),
    ]
    const p = refused(planFiling(base({ taskRef: 't-1', cwd: '/home/u/workspace', rows })))
    expect(p.candidates).toEqual(['/home/u/elsewhere', '/home/u/agentistics/.claude/worktrees/x'])
  })
})

describe('shared checkout probe (L4)', () => {
  test('a new worker counts its caller as another live session', () => {
    const seen: Array<string | undefined> = []
    const p = planFiling(base({
      callerCwd: '/home/u/agentistics', caller: R('me'),
      liveInCwd: (_d, ex) => { seen.push(ex); return ex === 'me' ? 0 : 1 },
    }))
    expect(refused(p).code).toBe('cwd_shared_checkout')
    expect(seen).toEqual([undefined])
  })
})

describe('small guards (L5, L6)', () => {
  test('L5: an empty title is never a candidate', () => {
    const p = refused(planFiling(base({ book: { tasks: [T('t-e', ''), T('t-1', 'Atomic spawn')], subtasks: [] }, taskRef: 'Atomic' })))
    expect(p.candidates).toEqual(['Atomic spawn (t-1)'])
  })
  test('L6: folder recency compares parsed dates, not strings', () => {
    const groups = { groups: [{ id: 'a', name: 'A', sessionKeys: ['k1'] }, { id: 'b', name: 'B', sessionKeys: ['k2'] }] }
    const rows = [
      R('r1', { taskId: 't-1', conversationId: 'k1', createdAt: '2026-10-10T12:00:05+00:00' }),
      R('r2', { taskId: 't-1', conversationId: 'k2', createdAt: '2026-10-10T12:00:01Z' }),
    ]
    expect(ok(planFiling(base({ taskRef: 't-1', groups, rows }))).folderId).toBe('a')
  })
})

describe('a spawn with no parent and no role is a PERSON, not a worker (H1)', () => {
  const live = (): number => 1
  const base = { repoOf, liveInCwd: live, callerCwd: '/home/u/agentistics', book, rows: [], groups: { groups: [] } } satisfies FilingInput
  test('a person in a main checkout with a live session is accepted', () => {
    const p = planFiling({ ...base })
    expect(p.ok).toBe(true)
    if (p.ok) expect(p.role).toBeUndefined()
  })
  test('the same spawn as a worker is refused', () => {
    const p = planFiling({ ...base, role: 'worker' })
    expect(p).toMatchObject({ ok: false, code: 'cwd_shared_checkout' })
  })
  test('a person picking a task of another repository is not sent to a worktree', () => {
    const p = planFiling({ ...base, callerCwd: '/home/u/workspace', taskRef: 't-1' })
    expect(p.ok).toBe(true)
  })
  test('refusal texts carry no CLI-only wording without naming it as the CLI', () => {
    const p = planFiling({ ...base, role: 'worker' })
    if (!p.ok) expect(p.detail).toContain('(CLI: --shared-cwd)')
  })
})

describe('ORQ.FORA — verified parent continuation', () => {
  const caller = R('parent', { taskId: 't-1', subtaskId: 's-1', cwd: '/home/u/agentistics/.claude/worktrees/x' })
  test('worker inherits task without inheriting the leader subtask', () => {
    expect(ok(planFiling(base({ caller })))).toMatchObject({ taskId: 't-1' })
    expect(ok(planFiling(base({ caller }))).subtaskId).toBeUndefined()
  })
  test('the parent folder wins over a newer unrelated front on the task', () => {
    const plan = ok(planFiling(base({ caller, rows: [R('recent', { taskId: 't-1' })], groups: { groups: [
      { id: 'parent-folder', name: 'Workers', sessionKeys: ['parent'] },
      { id: 'recent-folder', name: 'Other front', sessionKeys: ['recent'] },
    ] } })))
    expect(plan).toMatchObject({ folderId: 'parent-folder', folderSource: 'parent' })
  })
  test('explicit task, subtask and folder override inheritance', () => {
    expect(ok(planFiling(base({ caller, taskRef: 't-2', subtaskRef: 's-2', folderRef: 'f', groups: { groups: [{ id: 'f', name: 'Chosen', sessionKeys: [] }] } })))).toMatchObject({ taskId: 't-2', subtaskId: 's-2', folderId: 'f' })
  })
  test('same-task leader intent refuses with the exact successor command', () => {
    const plan = planFiling(base({ caller, callerRole: 'leader', role: 'leader', harness: 'codex' }))
    expect(plan).toMatchObject({ ok: false, code: 'handoff_required' })
    if (!plan.ok) expect(plan.detail).toContain('agentop session codex --handoff')
  })
  test('a leader can start a leader for a different task/front', () => {
    expect(ok(planFiling(base({ caller, callerRole: 'leader', role: 'leader', taskRef: 't-2' })))).toMatchObject({ taskId: 't-2', role: 'leader' })
  })
  test('explicit handoff preserves the same task and subtask', () => {
    expect(ok(planFiling(base({ caller, callerRole: 'leader', handoffOf: caller })))).toMatchObject({ taskId: 't-1', subtaskId: 's-1', role: 'leader' })
  })
})

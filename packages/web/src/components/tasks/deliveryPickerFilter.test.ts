import { describe, expect, it } from 'bun:test'
import {
  ALL, filterRowsByHarness, filterRowsByRepo, harnessFilterOptions, harnessTabLabel,
  repoFilterOptions, repoTabLabel,
} from './deliveryPickerFilter'
import type { AttemptRollup, TaskListRow } from '../../lib/tasks'

const emptyRollup: AttemptRollup = {
  sessionsUsed: 0, sessionsLinked: 0, provenance: {} as AttemptRollup['provenance'],
  rounds: null, activeMinutes: null, tokens: null, costUSD: null,
  costMeasuredSessions: 0, costEstimatedSessions: 0, credits: null, mixedCurrency: false,
}

function row(over: Partial<TaskListRow> & { task: TaskListRow['task'] }): TaskListRow {
  return {
    attempts: 0,
    rollup: emptyRollup,
    counts: { comments: 0, subtasks: 0, subtasksDone: 0, files: 0 },
    harnesses: [],
    repos: [],
    ...over,
  }
}

function task(id: string, title: string): TaskListRow['task'] {
  return { id, title } as TaskListRow['task']
}

describe('repoFilterOptions', () => {
  it('collects the distinct repos across every row, `\'\'` sorted last', () => {
    const rows = [
      row({ task: task('1', 'A'), repos: ['github.com/o/b'] }),
      row({ task: task('2', 'B'), repos: ['github.com/o/a', ''] }),
    ]
    expect(repoFilterOptions(rows)).toEqual(['github.com/o/a', 'github.com/o/b', ''])
  })

  it('a task touching several repos contributes each of them', () => {
    const rows = [row({ task: task('1', 'A'), repos: ['r1', 'r2'] })]
    expect(repoFilterOptions(rows)).toEqual(['r1', 'r2'])
  })

  it('no rows yields no options', () => {
    expect(repoFilterOptions([])).toEqual([])
  })
})

describe('harnessFilterOptions', () => {
  it('collects the distinct harnesses, alphabetically', () => {
    const rows = [
      row({ task: task('1', 'A'), harnesses: ['codex'] }),
      row({ task: task('2', 'B'), harnesses: ['claude', 'codex'] }),
    ]
    expect(harnessFilterOptions(rows)).toEqual(['claude', 'codex'])
  })
})

describe('repoTabLabel', () => {
  it('ALL reads as "All"/"Todos"', () => {
    expect(repoTabLabel(ALL, false)).toBe('All')
    expect(repoTabLabel(ALL, true)).toBe('Todos')
  })

  it('the empty bucket reads as "No repo"/"Sem repo"', () => {
    expect(repoTabLabel('', false)).toBe('No repo')
    expect(repoTabLabel('', true)).toBe('Sem repo')
  })

  it('a real remote is shortened (host dropped)', () => {
    expect(repoTabLabel('github.com/org/repo', false)).toBe('org/repo')
  })
})

describe('harnessTabLabel', () => {
  it('delegates to the given label function for a real harness', () => {
    expect(harnessTabLabel('claude', false, () => 'Claude Code')).toBe('Claude Code')
  })

  it('ALL never reaches the label function', () => {
    expect(harnessTabLabel(ALL, false, () => { throw new Error('should not be called') })).toBe('All')
  })
})

describe('filterRowsByRepo', () => {
  const rows = [
    row({ task: task('1', 'A'), repos: ['r1'] }),
    row({ task: task('2', 'B'), repos: ['r2'] }),
    row({ task: task('3', 'C'), repos: ['r1', 'r2'] }),
  ]

  it('ALL passes every row through', () => {
    expect(filterRowsByRepo(rows, ALL)).toEqual(rows)
  })

  it('a real repo narrows to rows that touched it — a multi-repo task counts on both sides', () => {
    expect(filterRowsByRepo(rows, 'r1').map(r => r.task.id)).toEqual(['1', '3'])
    expect(filterRowsByRepo(rows, 'r2').map(r => r.task.id)).toEqual(['2', '3'])
  })
})

describe('filterRowsByHarness', () => {
  const rows = [
    row({ task: task('1', 'A'), harnesses: ['claude'] }),
    row({ task: task('2', 'B'), harnesses: ['codex'] }),
    row({ task: task('3', 'C'), harnesses: ['claude', 'codex'] }),
  ]

  it('ALL passes every row through', () => {
    expect(filterRowsByHarness(rows, ALL)).toEqual(rows)
  })

  it('a real harness narrows to rows that ran on it', () => {
    expect(filterRowsByHarness(rows, 'claude').map(r => r.task.id)).toEqual(['1', '3'])
  })
})

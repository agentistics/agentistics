import { describe, expect, test } from 'bun:test'
import { countPerKind, projectKind } from './projectKind'

describe('countPerKind', () => {
  const rows = [
    { source: 'repo' }, { source: 'repo' }, { source: 'repo' },
    { source: 'history' },
    { source: 'folder' }, { source: 'folder' },
  ]

  test('counts what MATCHED, which is not what a capped list holds', () => {
    // THE REPORTED CASE: the wizard's tabs read `Repositories 12 · Projects 12 · Folders 12` on a
    // machine with far more of each — they were counting the rows the per-kind CAP had returned.
    // A cap presented as a count is a number that can never be anything but 12.
    expect(countPerKind(rows, projectKind)).toEqual({ repo: 3, worktree: 0, project: 1, folder: 2 })
  })

  test('a kind with nothing matching counts zero, not absent', () => {
    expect(countPerKind([{ source: 'folder' }], projectKind).repo).toBe(0)
  })

  test('an empty search counts zero of everything', () => {
    expect(countPerKind([], projectKind)).toEqual({ repo: 0, worktree: 0, project: 0, folder: 0 })
  })
})

describe('projectKind — worktree outranks everything, including a recorded remote', () => {
  test('a linked worktree is its own kind, never "repo"', () => {
    expect(projectKind({ source: 'repo', worktree: true })).toBe('worktree')
    expect(projectKind({ source: 'folder', worktree: true })).toBe('worktree')
  })

  test('THE REPORTED BUG: a worktree carrying the main checkout\'s own remote is still a worktree', () => {
    // The screenshot: a session recorded in a git worktree inherits the shared repo's remote, and
    // a bare `remote !== ''` check alone reads that as "this is a repository" — the worktree then
    // shows under Repositories wearing the main checkout's own `org/repo` label.
    expect(projectKind({ source: 'history', remote: 'github.com/o/r', worktree: true })).toBe('worktree')
  })

  test('with no worktree flag, behaviour is unchanged from before', () => {
    expect(projectKind({ source: 'history', remote: 'github.com/o/r' })).toBe('repo')
    expect(projectKind({ source: 'repo' })).toBe('repo')
    expect(projectKind({ source: 'history' })).toBe('project')
    expect(projectKind({ source: 'folder' })).toBe('folder')
  })

  test('an explicit worktree: false is the same as no flag at all', () => {
    expect(projectKind({ source: 'history', remote: 'github.com/o/r', worktree: false })).toBe('repo')
  })
})


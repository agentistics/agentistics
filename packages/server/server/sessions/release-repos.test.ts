import { describe, expect, test } from 'bun:test'
import { candidateDirs, dirsForShas, dirsOfRow, knownRepos, MAX_DIRS_PER_SHA } from './release-repos'

describe('release-repos (which clones a commit is asked in)', () => {
  test('a row names its main checkout first, then its cwd; relative and empty paths are dropped', () => {
    expect(dirsOfRow({ cwd: '/w/wt', repo: { rootPath: '/w/main' } })).toEqual(['/w/main', '/w/wt'])
    expect(dirsOfRow({ cwd: 'rel', repo: { rootPath: '' } })).toEqual([])
  })

  test('the subtask’s own sessions come before the rest of the task, then the task repository, then the known ones', () => {
    const dirs = candidateDirs({
      subtaskId: 's2',
      taskRows: [{ cwd: '/a', subtaskId: 's1' }, { cwd: '/b', subtaskId: 's2' }, { cwd: '/c' }],
      taskRepo: 'github.com/o/r',
      byRemote: new Map([['github.com/o/r', ['/r1']]]),
      fallback: ['/k1', '/a'],
    })
    expect(dirs).toEqual(['/b', '/a', '/c', '/r1', '/k1'])
  })

  test('the list is bounded', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ cwd: `/d${i}` }))
    expect(candidateDirs({ subtaskId: null, taskRows: many, byRemote: new Map(), fallback: [] })).toHaveLength(MAX_DIRS_PER_SHA)
  })

  test('known repositories are ranked by use and grouped by remote; sessions without a remote are not repositories', () => {
    const k = knownRepos([
      { project_path: '/p/x', git_remote: 'h/o/x' }, { project_path: '/p/x', git_remote: 'h/o/x' },
      { project_path: '/p/y', git_remote: 'h/o/y' },
      { project_path: '/p/none' },
    ])
    expect(k.ranked).toEqual(['/p/x', '/p/y'])
    expect(k.byRemote.get('h/o/x')).toEqual(['/p/x'])
  })

  test('per commit: the pieces that named it, then the known repositories', () => {
    const f = dirsForShas({
      pieces: new Map([['aaaaaaa', [{ taskId: 't1', subtaskId: null }]]]),
      rowsOf: id => id === 't1' ? [{ cwd: '/work/t1' }] : [],
      metas: [{ project_path: '/known', git_remote: 'h/o/k' }],
    })
    expect(f('aaaaaaa')).toEqual(['/work/t1', '/known'])
    expect(f('unknown')).toEqual(['/known'])
  })
})

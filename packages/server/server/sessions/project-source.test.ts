import { describe, expect, it, test } from 'bun:test'
import { defaultProjectParent } from '@agentistics/core'
import { filterCandidatesByDisk, isExcludedProjectPath, isHabitCandidate, missingFromIndex } from './project-source'
import { searchCandidates, type ProjectCandidate } from './project-search'

const disks = [
  { path: '/', label: '/', isInstallDisk: true, kind: 'root' as const },
  { path: '/mnt/d', label: 'D:', isInstallDisk: false, kind: 'drive' as const, letter: 'D' },
]
const candidates = [{ path: '/home/me/repo' }, { path: '/mnt/d/code/app' }, { path: '/mnt/d/other' }]

describe('project disk filtering', () => {
  it('filters to the requested disk', () => {
    expect(filterCandidatesByDisk(candidates, disks, '/mnt/d').candidates.map(c => c.path))
      .toEqual(['/mnt/d/code/app', '/mnt/d/other'])
  })

  it('defaults an absent or unknown disk to the install disk', () => {
    expect(filterCandidatesByDisk(candidates, disks).candidates.map(c => c.path)).toEqual(['/home/me/repo'])
    expect(filterCandidatesByDisk(candidates, disks, '/mnt/missing').candidates.map(c => c.path)).toEqual(['/home/me/repo'])
  })

  it('uses all disks only for the explicit all value', () => {
    const result = filterCandidatesByDisk(candidates, disks, 'all')
    expect(result.candidates).toEqual(candidates)
    // `all` is an explicit filter, not an unknown disk that the client should replace with install.
    expect(result.selectedDisk).toBeUndefined()
  })

  it('never exposes the bare home directory or temporary trees', () => {
    expect(isExcludedProjectPath('/home/me', '/home/me', '/tmp')).toBe(true)
    expect(isExcludedProjectPath('/tmp/ctxlive/work', '/home/me', '/tmp')).toBe(true)
    expect(isExcludedProjectPath('/home/me/project', '/home/me', '/tmp')).toBe(false)
  })
})

it('newProjectParent existence is read every time, never off the guess (withExistence)', async () => {
  const { withExistence } = await import('./project-source')
  let there = false
  const isDir = async () => there
  expect(await withExistence('/h/projetos', isDir)).toEqual({ path: '/h/projetos', exists: false })
  there = true
  expect(await withExistence('/h/projetos', isDir)).toEqual({ path: '/h/projetos', exists: true })
})

describe('folders created outside agentop', () => {
  const c = (path: string, source: ProjectCandidate['source'] = 'folder', remote = ''): ProjectCandidate =>
    ({ path, name: path.split('/').pop()!, remote, lastSeenMs: 0, sessions: 0, source })

  test('missingFromIndex returns only paths the index lacks', () => {
    const known = [c('/Users/a/code/web')]
    const fresh = [c('/Users/a/code/web'), c('/Users/a/upx-workspace')]
    expect(missingFromIndex(known, fresh).map(x => x.path)).toEqual(['/Users/a/upx-workspace'])
  })

  test('a name fragment finds the new folder by substring', () => {
    const hits = searchCandidates([c('/Users/a/upx-workspace')], 'workspace')
    expect(hits).toHaveLength(1)
  })

  test('a scratch history folder is not a habit; a repository checkout is', () => {
    expect(isHabitCandidate(c('/Users/a/Documents/Codex/2026-10-29', 'history'))).toBe(false)
    expect(isHabitCandidate(c('/Users/a/code/web', 'repo'))).toBe(true)
    expect(isHabitCandidate({ ...c('/Users/a/code/wt', 'repo'), worktree: true })).toBe(false)
  })

  test('the default parent ignores many sessions in a dated Codex folder', () => {
    const history = Array.from({ length: 6 }, (_, i) => c(`/Users/a/Documents/Codex/2026-10-${20 + i}`, 'history'))
    const repos = [c('/Users/a/code/x', 'repo'), c('/Users/a/code/y', 'repo')]
    const habit = [...history, ...repos].filter(isHabitCandidate).map(x => x.path)
    expect(defaultProjectParent('/Users/a', habit, false).path).toBe('/Users/a/code')
    expect(defaultProjectParent('/Users/a', [], false).path).toBe('/Users/a/projects')
  })
})

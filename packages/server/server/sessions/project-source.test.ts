import { describe, expect, it } from 'bun:test'
import { filterCandidatesByDisk, isExcludedProjectPath } from './project-source'

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
    expect(filterCandidatesByDisk(candidates, disks, 'all').candidates).toEqual(candidates)
  })

  it('never exposes the bare home directory or temporary trees', () => {
    expect(isExcludedProjectPath('/home/me', '/home/me', '/tmp')).toBe(true)
    expect(isExcludedProjectPath('/tmp/ctxlive/work', '/home/me', '/tmp')).toBe(true)
    expect(isExcludedProjectPath('/home/me/project', '/home/me', '/tmp')).toBe(false)
  })
})

import { describe, expect, test } from 'bun:test'
import type { ProjectOption } from './types'
import { wizardPlaces } from './wizard-places'

const o = (p: Partial<ProjectOption> & Pick<ProjectOption, 'path' | 'source'>): ProjectOption => ({ label: p.path.split('/').pop()!, detail: p.path, ...p })

describe('wizardPlaces (NW-04)', () => {
  test('a folder merely found on disk is not offered; a found repository is', () => {
    const out = wizardPlaces([
      o({ path: '/h/.cache', source: 'folder' }),
      o({ path: '/h/src/app', source: 'repo', git: true }),
    ])
    expect(out.map(p => p.path)).toEqual(['/h/src/app'])
  })

  test('where you stand and where sessions ran stay, git or not', () => {
    const out = wizardPlaces([o({ path: '/h/notes', source: 'cwd' }), o({ path: '/h/old', source: 'history' })])
    expect(out.map(p => p.path)).toEqual(['/h/notes', '/h/old'])
    expect(out.every(p => p.repo === undefined)).toBe(true)
  })

  test('a git checkout without a remote is named after its folder, so it earns a worktree row', () => {
    const [ws] = wizardPlaces([o({ path: '/h/ws', source: 'cwd', git: true })])
    expect(ws!.repo).toBe('ws')
  })

  test('a remote short name is kept as it came', () => {
    const [r] = wizardPlaces([o({ path: '/h/a', source: 'history', git: true, repo: 'org/a' })])
    expect(r!.repo).toBe('org/a')
  })
})

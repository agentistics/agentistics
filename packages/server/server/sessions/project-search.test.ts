import { describe, expect, it } from 'bun:test'
import { projectKind } from '@agentistics/core'
import {
  buildCandidates, candidatePath, matchScore, mergeWalkedAndHistory, searchCandidates,
  withFixedCandidates, type ProjectCandidate,
} from './project-search'

const cand = (over: Partial<ProjectCandidate> = {}): ProjectCandidate => ({
  path: '/repo/agentistics',
  name: 'agentistics',
  remote: '',
  lastSeenMs: 0,
  sessions: 1,
  source: 'history',
  ...over,
})

describe('buildCandidates', () => {
  it('folds many sessions of one directory into a single candidate', () => {
    const out = buildCandidates([
      { project_path: '/repo/a', start_time: '2026-08-01T10:00:00Z' },
      { project_path: '/repo/a', start_time: '2026-08-13T10:00:00Z' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.sessions).toBe(2)
    expect(out[0]!.lastSeenMs).toBe(Date.parse('2026-08-13T10:00:00Z'))
  })

  it('offers a worktree as its own place to start, not folded into the project', () => {
    // A session starts in a PATH, and two worktrees of one repo are two different places to work.
    const out = buildCandidates([
      { project_path: '/repo/a', current_cwd: '/repo/a/.claude/worktrees/x' },
    ])
    expect(out.map(c => c.path).sort()).toEqual(['/repo/a', '/repo/a/.claude/worktrees/x'])
  })

  it('normalises the remote and never lets a later blank one erase it', () => {
    // An empty remote is "this session did not record it", never evidence that there is none.
    const out = buildCandidates([
      { project_path: '/repo/a', git_remote: 'git@github.com:org/repo.git' },
      { project_path: '/repo/a' },
    ])
    expect(out[0]!.remote).toBe('github.com/org/repo')
  })

  it('survives a session with no usable timestamp', () => {
    const out = buildCandidates([{ project_path: '/repo/a', start_time: '' }])
    expect(out[0]!.lastSeenMs).toBe(0)
  })
})

describe('matchScore', () => {
  const c = cand({ name: 'agentistics', path: '/home/dev/agentistics', remote: 'github.com/org/opvibes' })

  it('ranks a name prefix above a name substring above a path hit', () => {
    expect(matchScore(c, 'agen')).toBe(2)
    expect(matchScore(cand({ name: 'my-agentistics' }), 'agen')).toBe(1)
    expect(matchScore(c, 'home/dev')).toBe(0)
  })

  it('matches the repository, so a repo name finds every worktree of it', () => {
    expect(matchScore(c, 'opvibes')).toBe(1)
  })

  it('refuses a query that matches nothing', () => {
    expect(matchScore(c, 'zzzz')).toBe(-1)
  })

  it('is not a character-skipping fuzzy match', () => {
    // `a…s` matching anything with those letters in order would return most of a hundred
    // directories, and a list that always has results is a list that never answers.
    expect(matchScore(cand({ name: 'agentistics', path: '/x/agentistics', remote: '' }), 'ais')).toBe(-1)
  })

  it('matches everything on an empty query, so the list opens on recency', () => {
    expect(matchScore(c, '')).toBe(0)
    expect(matchScore(c, '   ')).toBe(0)
  })
})

describe('searchCandidates', () => {
  const list = [
    cand({ path: '/old', name: 'old-thing', lastSeenMs: 1 }),
    cand({ path: '/new', name: 'new-thing', lastSeenMs: 100 }),
    cand({ path: '/here', name: 'here', lastSeenMs: 0, source: 'cwd' }),
  ]

  it('opens on recency when nothing is typed', () => {
    const out = searchCandidates(list, '')
    // The current directory first, then the rest newest-first.
    expect(out.map(c => c.path)).toEqual(['/here', '/new', '/old'])
  })

  it('keeps the current directory on top even against fresher history', () => {
    // It is where the user is standing. No amount of history should push it below last week.
    expect(searchCandidates(list, 'h')[0]!.path).toBe('/here')
  })

  it('drops what does not match', () => {
    expect(searchCandidates(list, 'old').map(c => c.path)).toEqual(['/old'])
  })

  it('breaks a tie on session count, then on name', () => {
    const tied = [
      cand({ path: '/b', name: 'b', lastSeenMs: 5, sessions: 1 }),
      cand({ path: '/a', name: 'a', lastSeenMs: 5, sessions: 9 }),
    ]
    expect(searchCandidates(tied, '').map(c => c.path)).toEqual(['/a', '/b'])
  })

  it('honours the limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => cand({ path: `/p${i}`, name: `p${i}` }))
    expect(searchCandidates(many, '', 5)).toHaveLength(5)
  })
})

describe('withFixedCandidates', () => {
  it('never shows the same place twice', () => {
    const merged = withFixedCandidates(
      [cand({ path: '/here', name: 'here', sessions: 7, remote: 'github.com/o/r' })],
      [cand({ path: '/here', name: 'here', source: 'cwd', sessions: 1, remote: '' })],
    )
    expect(merged).toHaveLength(1)
    // It says WHY it is here, while keeping what history knows about it.
    expect(merged[0]).toMatchObject({ source: 'cwd', sessions: 7, remote: 'github.com/o/r' })
  })

  it('adds a typed path history has never seen', () => {
    const merged = withFixedCandidates([], [cand({ path: '/fresh/clone', source: 'typed' })])
    expect(merged.map(c => c.source)).toEqual(['typed'])
  })
})

describe('mergeWalkedAndHistory — the walk\'s worktree flag must survive being replaced by history', () => {
  it('THE REPORTED BUG: a history entry with a remote must not erase a walked worktree flag', () => {
    // The walk found `.git` as a FILE here — a linked worktree — and knows nothing about its
    // remote. A session recorded in that same directory carries the shared repository's own
    // remote. Losing `worktree` on the merge is exactly what made the worktree read as `repo`.
    const walked = [cand({ path: '/repo/a/.claude/worktrees/x', source: 'repo', worktree: true, remote: '' })]
    const history = [cand({ path: '/repo/a/.claude/worktrees/x', source: 'history', worktree: undefined, remote: 'github.com/org/repo' })]
    const merged = mergeWalkedAndHistory(walked, history)
    expect(merged).toHaveLength(1)
    // History's remote and source win (it is the richer record) — but the worktree flag the walk
    // already measured for free must not be thrown away.
    expect(merged[0]).toMatchObject({ source: 'history', remote: 'github.com/org/repo', worktree: true })
    expect(projectKind({ source: merged[0]!.source, remote: merged[0]!.remote, worktree: merged[0]!.worktree }))
      .toBe('worktree')
  })

  it('a plain repository (not a worktree) merges exactly as before', () => {
    const walked = [cand({ path: '/repo/a', source: 'repo', worktree: false, remote: '' })]
    const history = [cand({ path: '/repo/a', source: 'history', worktree: undefined, remote: 'github.com/org/repo' })]
    expect(mergeWalkedAndHistory(walked, history)[0]).toMatchObject({ worktree: false })
  })

  it('a history path the walk never visited is left unresolved, for the caller to measure', () => {
    const history = [cand({ path: '/outside/the/walk', worktree: undefined })]
    expect(mergeWalkedAndHistory([], history)[0]!.worktree).toBeUndefined()
  })

  it('a walked path with no history entry keeps its own flag untouched', () => {
    const walked = [cand({ path: '/only/walked', source: 'folder', worktree: false })]
    expect(mergeWalkedAndHistory(walked, [])[0]).toMatchObject({ worktree: false })
  })
})

describe('candidatePath', () => {
  const HOME = '/home/dev'
  const at = (path: string) => cand({ path, name: path.split('/').pop() ?? path })

  it('shortens the home directory to a tilde', () => {
    expect(candidatePath(at('/home/dev/agentistics'), HOME)).toBe('~/agentistics')
  })

  it('leaves a path outside home alone', () => {
    expect(candidatePath(at('/opt/work'), HOME)).toBe('/opt/work')
  })

  it('elides the MIDDLE, so two same-named directories stay distinguishable', () => {
    // Cutting the head collapsed these two into one string on a real machine, re-creating the very
    // ambiguity the path is displayed to remove.
    const a = candidatePath(at('/home/dev/aipe-blpsoares/embark-me/packages/portifolio'), HOME, 30)
    const b = candidatePath(at('/home/dev/embark-me/packages/portifolio'), HOME, 30)
    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(30)
    expect(b.length).toBeLessThanOrEqual(30)
  })

  it('always keeps the final segment, which is the directory being offered', () => {
    const out = candidatePath(at('/home/dev/a/b/c/d/e/f/g/the-project'), HOME, 24)
    expect(out.endsWith('the-project')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(24)
  })

  it('never exceeds the width it was given, at any width', () => {
    for (let w = 6; w <= 60; w++) {
      const out = candidatePath(at('/home/dev/one/two/three/four/five/six/seven'), HOME, w)
      expect(out.length).toBeLessThanOrEqual(Math.max(w, 'seven'.length + 4))
    }
  })
})

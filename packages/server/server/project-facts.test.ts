import { test, expect } from 'bun:test'
import { planProjectFacts, applyProjectFacts } from './project-facts'

const S = (p: Partial<{ project_path: string; start_time: string; git_remote: string; harness: string }>) => ({
  project_path: '', start_time: '', harness: 'claude', ...p,
}) as never

test('plans one entry per distinct path, whatever harness put it there', () => {
  const plan = planProjectFacts([
    S({ project_path: '/a', start_time: '2026-01-02', harness: 'codex' }),
    S({ project_path: '/a', start_time: '2026-01-01', harness: 'claude' }),
    S({ project_path: '/b', start_time: '2026-02-01', harness: 'gemini' }),
  ], [])
  expect(plan).toEqual([
    { path: '/a', earliest: '2026-01-01' },
    { path: '/b', earliest: '2026-02-01' },
  ])
})

test('a path only ever visited by a non-Claude harness is still planned — the whole point', () => {
  const plan = planProjectFacts([S({ project_path: '/only-codex', start_time: '2026-03-01', harness: 'codex' })], [])
  expect(plan.map(p => p.path)).toEqual(['/only-codex'])
})

test('deduplicates Windows and WSL spellings of a project', () => {
  const plan = planProjectFacts([
    S({ project_path: String.raw`D:\code\repo`, start_time: '2026-03-02' }),
    S({ project_path: '/mnt/d/code/repo', start_time: '2026-03-01' }),
  ], [])
  expect(plan).toEqual([{ path: '/mnt/d/code/repo', earliest: '2026-03-01' }])
})

test('projects with no sessions are planned too, with no window', () => {
  const plan = planProjectFacts([], [{ path: '/empty' }])
  expect(plan).toEqual([{ path: '/empty', earliest: '' }])
})

test('sessions with no path are ignored, and a path is planned once', () => {
  const plan = planProjectFacts([
    S({ project_path: '', start_time: '2026-01-01' }),
    S({ project_path: '/a', start_time: '2026-01-05' }),
    S({ project_path: '/a', start_time: '2026-01-09' }),
  ], [{ path: '/a' }])
  expect(plan).toEqual([{ path: '/a', earliest: '2026-01-05' }])
})

test('stamps the resolved remote onto every session at that path', () => {
  const sessions = [
    { project_path: '/a', git_remote: undefined },
    { project_path: '/a', git_remote: undefined },
    { project_path: '/b', git_remote: undefined },
  ] as never as { project_path: string; git_remote?: string }[]
  const projects = [{ path: '/a' }, { path: '/b' }] as never as { path: string; gitRemote?: string }[]
  applyProjectFacts(new Map([['/a', { remote: 'github.com/org/a' }]]), sessions, projects)
  expect(sessions.map(s => s.git_remote)).toEqual(['github.com/org/a', 'github.com/org/a', undefined])
  expect(projects[0]!.gitRemote).toBe('github.com/org/a')
  expect(projects[1]!.gitRemote).toBeUndefined()
})

test('NEVER overwrites a remote that is already set — CI ingest stamps it authoritatively', () => {
  const sessions = [{ project_path: '/a', git_remote: 'github.com/org/from-ci' }] as never as
    { project_path: string; git_remote?: string }[]
  applyProjectFacts(new Map([['/a', { remote: 'github.com/org/local-guess' }]]), sessions, [])
  expect(sessions[0]!.git_remote).toBe('github.com/org/from-ci')
})

test('an empty resolved remote clears nothing — a path that is not a repo leaves data alone', () => {
  const sessions = [{ project_path: '/a', git_remote: 'github.com/org/a' }] as never as
    { project_path: string; git_remote?: string }[]
  const projects = [{ path: '/a', gitRemote: 'github.com/org/a' }] as never as
    { path: string; gitRemote?: string }[]
  applyProjectFacts(new Map([['/a', { remote: '' }]]), sessions, projects)
  expect(sessions[0]!.git_remote).toBe('github.com/org/a')
  expect(projects[0]!.gitRemote).toBe('github.com/org/a')
})

test('git stats land on the project, and never replace stats already computed', () => {
  const projects = [
    { path: '/a' },
    { path: '/b', git_stats: { commits: 9 } },
  ] as never as { path: string; git_stats?: { commits: number } }[]
  applyProjectFacts(new Map([
    ['/a', { remote: '', stats: { commits: 3 } }],
    ['/b', { remote: '', stats: { commits: 1 } }],
  ]) as never, [], projects)
  expect(projects[0]!.git_stats).toEqual({ commits: 3 })
  expect(projects[1]!.git_stats).toEqual({ commits: 9 })
})

test('a path the Claude walk already resolved is not read again', () => {
  const plan = planProjectFacts(
    [S({ project_path: '/done', start_time: '2026-01-01' }), S({ project_path: '/new', start_time: '2026-01-02' })],
    [],
    new Set(['/done']),
  )
  expect(plan.map(p => p.path)).toEqual(['/new'])
})

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool } from '../gate.ts'
import { memoryContent, recordingEvents, scriptedPolicy } from '../testing.ts'
import {
  GIT_LOG_HARD_CAP,
  createGitLogTool,
  parseGitLogInput,
  parseLogOutput,
  type GitLogResult,
} from './log.ts'
import { defaultGitSpawner, type GitSpawner } from './spawn.ts'
import { gitAdd, gitCommit, makeTestRepo, writeRepoFile, type TestRepo } from './test-repo.ts'

const SEP = '\u001f'

describe('parseLogOutput — pure', () => {
  test('one commit', () => {
    const text = `abc123${SEP}Ana <ana@x.com>${SEP}2026-09-20T10:00:00-03:00${SEP}fix: the thing\n`
    const commits = parseLogOutput(text)
    expect(commits).toEqual([
      { hash: 'abc123', author: 'Ana <ana@x.com>', date: '2026-09-20T10:00:00-03:00', subject: 'fix: the thing' },
    ])
  })

  test('several commits, tformat: never drops the oldest (no trailing newline requirement)', () => {
    const text = [
      `a1${SEP}A${SEP}d1${SEP}first`,
      `a2${SEP}A${SEP}d2${SEP}second`,
    ].join('\n')
    const commits = parseLogOutput(text)
    expect(commits.map(c => c.hash)).toEqual(['a1', 'a2'])
  })

  test('a subject containing the field separator by accident still parses (rest rejoined)', () => {
    const text = `a1${SEP}A${SEP}d1${SEP}sub${SEP}ject`
    const commits = parseLogOutput(text)
    expect(commits[0]?.subject).toBe(`sub${SEP}ject`)
  })

  test('empty input yields no commits', () => {
    expect(parseLogOutput('')).toEqual([])
  })
})

describe('parseGitLogInput — pure', () => {
  test('accepts empty input', () => {
    expect(parseGitLogInput(undefined)).toEqual({})
  })
  test('accepts a positive integer maxCount', () => {
    expect(parseGitLogInput({ maxCount: 5 })).toEqual({ maxCount: 5 })
  })
  test('refuses zero, negative, and non-integer maxCount', () => {
    expect(parseGitLogInput({ maxCount: 0 })).toMatch(/positive integer/)
    expect(parseGitLogInput({ maxCount: -1 })).toMatch(/positive integer/)
    expect(parseGitLogInput({ maxCount: 1.5 })).toMatch(/positive integer/)
  })
  test('refuses an option-shaped rev', () => {
    expect(parseGitLogInput({ rev: '--all' })).toMatch(/not a valid revision/)
  })
})

describe('git.log through the gate', () => {
  let repo: TestRepo | undefined
  afterEach(async () => {
    await repo?.cleanup()
    repo = undefined
  })

  const scope = (cwd: string) => ({ workspaceRoot: cwd, cwd, signal: new AbortController().signal })

  test('denied: git never runs', async () => {
    let calls = 0
    const spy: GitSpawner = async (argv, opts) => {
      calls++
      return defaultGitSpawner(argv, opts)
    }
    const tool = createGitLogTool({ spawn: spy })
    const r = await runTool(tool, {}, scope('/tmp'), { policy: scriptedPolicy('deny'), events: recordingEvents(), content: memoryContent() })
    expect(r.status).toBe('denied')
    expect(calls).toBe(0)
  })

  test('allowed: lists commits, hash/author/date/subject, no body', async () => {
    repo = await makeTestRepo()
    await writeRepoFile(repo, 'a.ts', 'v1')
    await gitAdd(repo, 'a.ts')
    await gitCommit(repo, 'feat: add a.ts\n\nA multi-line body that must never appear.')

    const tool = createGitLogTool()
    const r = await runTool(tool, {}, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    expect(r.status).toBe('completed')
    const result = r.outcome.result as GitLogResult
    expect(result.commits.length).toBeGreaterThanOrEqual(2) // the init commit + this one
    const top = result.commits[0]
    expect(top?.subject).toBe('feat: add a.ts')
    expect(top?.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(top?.author).toContain('<t@t>')
    for (const c of result.commits) expect(c.subject).not.toContain('multi-line body')
  })

  test('maxCount is respected, clamped to the hard cap, and states when there may be more', async () => {
    repo = await makeTestRepo()
    await writeRepoFile(repo, 'a.ts', 'v1')
    await gitAdd(repo, 'a.ts')
    await gitCommit(repo, 'second commit') // repo now has 2 commits total

    const tool = createGitLogTool()
    const r1 = await runTool(tool, { maxCount: 1 }, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    const result1 = r1.outcome.result as GitLogResult
    expect(result1.commits).toHaveLength(1)
    expect(result1.truncated).toBe(true) // asked for 1 of 2 — there may be more

    const r2 = await runTool(tool, { maxCount: GIT_LOG_HARD_CAP + 1000 }, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    expect((r2.outcome.result as GitLogResult).effectiveMaxCount).toBe(GIT_LOG_HARD_CAP)
  })

  test('an option-shaped rev never reaches the policy', async () => {
    const tool = createGitLogTool()
    const policy = scriptedPolicy('allow')
    const r = await runTool(tool, { rev: '--upload-pack=evil' }, scope('/tmp'), { policy, events: recordingEvents(), content: memoryContent() })
    expect(r.outcome.error?.class).toBe('invalid-input')
    expect(policy.seen).toHaveLength(0)
  })

  test('not a repository -> not-found', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentistics-git-tool-noninit-'))
    try {
      const tool = createGitLogTool()
      const r = await runTool(tool, {}, scope(cwd), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
      expect(r.status).toBe('failed')
      expect(r.outcome.error?.class).toBe('not-found')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('git missing -> unavailable', async () => {
    const throwing: GitSpawner = async () => {
      throw new Error('spawn git ENOENT')
    }
    const tool = createGitLogTool({ spawn: throwing })
    const r = await runTool(tool, {}, scope('/tmp'), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    expect(r.outcome.error?.class).toBe('unavailable')
  })
})

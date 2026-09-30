import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool } from '../gate.ts'
import { memoryContent, recordingEvents, scriptedPolicy } from '../testing.ts'
import { createGitStatusTool, parseGitStatusInput, parseStatusPorcelainV2 } from './status.ts'
import { defaultGitSpawner, type GitSpawner } from './spawn.ts'
import { gitAdd, gitConfig, makeTestRepo, writeRepoFile, type TestRepo } from './test-repo.ts'

describe('parseStatusPorcelainV2 — pure parser', () => {
  test('branch, ahead/behind, staged/unstaged/untracked buckets', () => {
    const out = [
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaa bbb staged-only.ts',
      '1 .M N... 100644 100644 100644 aaa bbb unstaged-only.ts',
      '1 MM N... 100644 100644 100644 aaa bbb both.ts',
      '? new-file.ts',
    ].join('\n')
    const r = parseStatusPorcelainV2(out)
    expect(r.branch).toBe('main')
    expect(r.detached).toBe(false)
    expect(r.upstream).toBe('origin/main')
    expect(r.ahead).toBe(2)
    expect(r.behind).toBe(1)
    expect(r.staged.count).toBe(2)
    expect(r.staged.paths).toEqual(['staged-only.ts', 'both.ts'])
    expect(r.unstaged.count).toBe(2)
    expect(r.unstaged.paths).toEqual(['unstaged-only.ts', 'both.ts'])
    expect(r.untracked.count).toBe(1)
    expect(r.untracked.paths).toEqual(['new-file.ts'])
  })

  test('detached HEAD', () => {
    const out = ['# branch.oid abc123', '# branch.head (detached)'].join('\n')
    const r = parseStatusPorcelainV2(out)
    expect(r.detached).toBe(true)
    expect(r.branch).toBeNull()
  })

  test('a path containing a space is not truncated', () => {
    const out = '1 M. N... 100644 100644 100644 aaa bbb my file with spaces.ts'
    const r = parseStatusPorcelainV2(out)
    expect(r.staged.paths).toEqual(['my file with spaces.ts'])
  })

  test('rename entry reports only the new path', () => {
    const out = '2 R. N... 100644 100644 100644 aaa bbb R100 new-name.ts\told-name.ts'
    const r = parseStatusPorcelainV2(out)
    expect(r.staged.paths).toEqual(['new-name.ts'])
  })

  test('unmerged entry counts as both staged and unstaged', () => {
    const out = 'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.ts'
    const r = parseStatusPorcelainV2(out)
    expect(r.staged.paths).toEqual(['conflicted.ts'])
    expect(r.unstaged.paths).toEqual(['conflicted.ts'])
  })

  test('bounds paths per bucket and reports pathsTruncated', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `? untracked-${i}.ts`)
    const r = parseStatusPorcelainV2(lines.join('\n'), 2)
    expect(r.untracked.count).toBe(5)
    expect(r.untracked.paths).toHaveLength(2)
    expect(r.pathsTruncated).toBe(true)
  })
})

describe('parseGitStatusInput — pure', () => {
  test('accepts empty/absent input', () => {
    expect(parseGitStatusInput(undefined)).toEqual({})
    expect(parseGitStatusInput({})).toEqual({})
  })
  test('accepts a repo string', () => {
    expect(parseGitStatusInput({ repo: '/tmp/x' })).toEqual({ repo: '/tmp/x' })
  })
  test('refuses a non-string repo', () => {
    expect(parseGitStatusInput({ repo: 1 })).toMatch(/must be a string/)
  })
  test('refuses an unknown field', () => {
    expect(parseGitStatusInput({ nope: 1 })).toMatch(/Unknown field/)
  })
})

describe('git.status through the gate', () => {
  let repo: TestRepo | undefined
  afterEach(async () => {
    await repo?.cleanup()
    repo = undefined
  })

  const scope = (cwd: string) => ({ workspaceRoot: cwd, cwd, signal: new AbortController().signal })

  test('denied: git never runs, the model gets the policy sentence, no repo data leaks', async () => {
    let calls = 0
    const spy: GitSpawner = async (argv, opts) => {
      calls++
      return defaultGitSpawner(argv, opts)
    }
    const tool = createGitStatusTool({ spawn: spy })
    const events = recordingEvents()
    const r = await runTool(tool, {}, scope('/tmp'), { policy: scriptedPolicy('deny'), events, content: memoryContent() })
    expect(r.status).toBe('denied')
    expect(calls).toBe(0)
    expect(r.outcome.modelText).toBe('Refused by the test policy.')
    expect(r.outcome.result).toBeUndefined()
  })

  test('allowed: reports the real branch and a clean tree', async () => {
    repo = await makeTestRepo()
    const tool = createGitStatusTool()
    const r = await runTool(tool, {}, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    expect(r.status).toBe('completed')
    expect(r.outcome.ok).toBe(true)
    const result = r.outcome.result as ReturnType<typeof parseStatusPorcelainV2>
    expect(result.branch).toBe('main')
    expect(result.staged.count).toBe(0)
    expect(result.unstaged.count).toBe(0)
    expect(result.untracked.count).toBe(0)
  })

  test('allowed: reports untracked and staged files', async () => {
    repo = await makeTestRepo()
    await writeRepoFile(repo, 'untracked.ts', 'x')
    await writeRepoFile(repo, 'staged.ts', 'x')
    await gitAdd(repo, 'staged.ts')
    const tool = createGitStatusTool()
    const r = await runTool(tool, {}, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    const result = r.outcome.result as ReturnType<typeof parseStatusPorcelainV2>
    expect(result.untracked.paths).toContain('untracked.ts')
    expect(result.staged.paths).toContain('staged.ts')
  })

  test('not a repository -> not-found', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentistics-git-tool-noninit-'))
    try {
      const tool = createGitStatusTool()
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
    const tool = createGitStatusTool({ spawn: throwing })
    const r = await runTool(tool, {}, scope('/tmp'), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    expect(r.status).toBe('failed')
    expect(r.outcome.error?.class).toBe('unavailable')
  })

  test('subjects carry a git-read action naming the resolved repo and verb', async () => {
    repo = await makeTestRepo()
    const policy = scriptedPolicy('allow')
    const tool = createGitStatusTool()
    await runTool(tool, {}, scope(repo.dir), { policy, events: recordingEvents(), content: memoryContent() })
    expect(policy.seen).toHaveLength(1)
    expect(policy.seen[0]?.subjects).toEqual([{ action: 'git-read', repo: repo.dir, verb: 'status' }])
  })

  test('a config making core.fsmonitor a real script never runs it (see hostile-repo.test.ts for the full check)', async () => {
    repo = await makeTestRepo()
    await gitConfig(repo, 'core.fsmonitor', 'true')
    const tool = createGitStatusTool()
    const r = await runTool(tool, {}, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    expect(r.status).toBe('completed')
  })
})

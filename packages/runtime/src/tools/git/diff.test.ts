import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool } from '../gate.ts'
import { memoryContent, recordingEvents, scriptedPolicy } from '../testing.ts'
import { createGitDiffTool, parseDiffStat, parseGitDiffInput, type GitDiffResult } from './diff.ts'
import { defaultGitSpawner, type GitSpawner } from './spawn.ts'
import { gitAdd, gitCommit, makeTestRepo, writeRepoFile, type TestRepo } from './test-repo.ts'

describe('parseDiffStat — pure parser', () => {
  test('one file, insertions and deletions', () => {
    const out = [' src/a.ts | 4 ++--', ' 1 file changed, 2 insertions(+), 2 deletions(-)', ''].join('\n')
    const r = parseDiffStat(out)
    expect(r.files).toEqual(['src/a.ts'])
    expect(r.filesChanged).toBe(1)
    expect(r.linesAdded).toBe(2)
    expect(r.linesRemoved).toBe(2)
  })

  test('several files, insertions only', () => {
    const out = [' a.ts | 2 ++', ' b.ts | 1 +', ' 2 files changed, 3 insertions(+)', ''].join('\n')
    const r = parseDiffStat(out)
    expect(r.files).toEqual(['a.ts', 'b.ts'])
    expect(r.filesChanged).toBe(2)
    expect(r.linesAdded).toBe(3)
    expect(r.linesRemoved).toBe(0)
  })

  test('binary file change reports Bin, not a line count', () => {
    const out = [' image.png | Bin 10 -> 20 bytes', ' 1 file changed, 0 insertions(+), 0 deletions(-)', ''].join('\n')
    const r = parseDiffStat(out)
    expect(r.files).toEqual(['image.png'])
  })

  test('no changes', () => {
    const r = parseDiffStat('')
    expect(r.filesChanged).toBe(0)
    expect(r.files).toEqual([])
  })
})

describe('parseGitDiffInput — pure', () => {
  test('accepts empty input and the full option set', () => {
    expect(parseGitDiffInput(undefined)).toEqual({})
    expect(parseGitDiffInput({ repo: '/r', staged: true, rev: 'HEAD~2', paths: ['a.ts'] })).toEqual({
      repo: '/r', staged: true, rev: 'HEAD~2', paths: ['a.ts'],
    })
  })
  test('refuses a non-boolean staged', () => {
    expect(parseGitDiffInput({ staged: 'yes' })).toMatch(/must be a boolean/)
  })
  test('refuses an empty-string path', () => {
    expect(parseGitDiffInput({ paths: [''] })).toMatch(/non-empty strings/)
  })

  describe('option-injection: rev is refused before it can be read as a flag', () => {
    for (const bad of ['--output=/tmp/x', '-x', '--upload-pack=evil', ' HEAD', 'HEAD;rm -rf /', '--']) {
      test(JSON.stringify(bad), () => {
        expect(parseGitDiffInput({ rev: bad })).toMatch(/not a valid revision/)
      })
    }
    for (const good of ['HEAD', 'HEAD~2', 'origin/main', 'v1.2.3', 'refs/heads/main', '@{upstream}', 'abc1234']) {
      test(`accepts ${JSON.stringify(good)}`, () => {
        expect(parseGitDiffInput({ rev: good })).toEqual({ rev: good })
      })
    }
  })
})

describe('git.diff through the gate', () => {
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
    const tool = createGitDiffTool({ spawn: spy })
    const r = await runTool(tool, {}, scope('/tmp'), { policy: scriptedPolicy('deny'), events: recordingEvents(), content: memoryContent() })
    expect(r.status).toBe('denied')
    expect(calls).toBe(0)
  })

  test('an option-shaped rev never reaches the policy — refused at parse time', async () => {
    const tool = createGitDiffTool()
    const policy = scriptedPolicy('allow')
    const r = await runTool(tool, { rev: '--output=/tmp/pwned' }, scope('/tmp'), {
      policy, events: recordingEvents(), content: memoryContent(),
    })
    expect(r.outcome.error?.class).toBe('invalid-input')
    expect(policy.seen).toHaveLength(0)
  })

  test('allowed: unstaged change reports a stat and a patch', async () => {
    repo = await makeTestRepo()
    await writeRepoFile(repo, 'a.ts', 'line1\nline2\n')
    await gitAdd(repo, 'a.ts')
    await gitCommit(repo, 'add a.ts')
    await writeRepoFile(repo, 'a.ts', 'line1\nline2 changed\n')

    const tool = createGitDiffTool()
    const r = await runTool(tool, {}, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    expect(r.status).toBe('completed')
    const result = r.outcome.result as GitDiffResult
    expect(result.filesChanged).toBe(1)
    expect(result.files).toEqual(['a.ts'])
    expect(result.diff).toContain('line2 changed')
    expect(result.stat).toContain('a.ts')
    expect(result.diffTruncated).toBe(false)
  })

  test('staged: true diffs the index against HEAD', async () => {
    repo = await makeTestRepo()
    await writeRepoFile(repo, 'a.ts', 'v1\n')
    await gitAdd(repo, 'a.ts')
    await gitCommit(repo, 'add a.ts')
    await writeRepoFile(repo, 'a.ts', 'v2\n')
    await gitAdd(repo, 'a.ts') // staged, not committed

    const tool = createGitDiffTool()
    const staged = await runTool(tool, { staged: true }, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    const unstaged = await runTool(tool, {}, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })

    expect((staged.outcome.result as GitDiffResult).filesChanged).toBe(1)
    expect((unstaged.outcome.result as GitDiffResult).filesChanged).toBe(0) // nothing unstaged left
  })

  test('a large diff is truncated and states its original size', async () => {
    repo = await makeTestRepo()
    const big = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n') + '\n'
    await writeRepoFile(repo, 'big.ts', big)
    await gitAdd(repo, 'big.ts')
    await gitCommit(repo, 'add big.ts')
    await writeRepoFile(repo, 'big.ts', big.replace(/line \d+/g, m => `${m} x`))

    const tool = createGitDiffTool()
    const r = await runTool(tool, {}, scope(repo.dir), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    const result = r.outcome.result as GitDiffResult
    expect(result.diffTruncated).toBe(true)
    expect(result.diffOriginalBytes).toBeGreaterThan(result.diff.length)
    expect(result.statTruncated).toBe(false) // the --stat summary stays intact regardless
  })

  test('not a repository -> not-found', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agentistics-git-tool-noninit-'))
    try {
      const tool = createGitDiffTool()
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
    const tool = createGitDiffTool({ spawn: throwing })
    const r = await runTool(tool, {}, scope('/tmp'), { policy: scriptedPolicy('allow'), events: recordingEvents(), content: memoryContent() })
    expect(r.status).toBe('failed')
    expect(r.outcome.error?.class).toBe('unavailable')
  })
})

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool } from '../gate.ts'
import { memoryContent, recordingEvents, scriptedPolicy } from '../testing.ts'
import type { FsGrepResult } from './grep.ts'
import { createFsTools } from './index.ts'
import { gitTestEnv } from '../../../test/git-test-env.ts'

async function tempDir(prefix = 'agentistics-fs-grep-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: gitTestEnv() })
}

function scope(dir: string) {
  return { workspaceRoot: dir, cwd: dir, signal: new AbortController().signal }
}

const deps = () => ({ events: recordingEvents(), content: memoryContent() })

describe('fs.grep', () => {
  test('denied: no matches returned, the model gets the refusal sentence', async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, 'a.txt'), 'hello world')
      const { grep } = createFsTools()
      const r = await runTool(grep, { pattern: 'hello' }, scope(dir), { policy: scriptedPolicy('deny'), ...deps() })
      expect(r.status).toBe('denied')
      expect(r.outcome.modelText).toBe('Refused by the test policy.')
      expect(r.outcome.result).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('allowed: returns matches, and the policy saw exactly one subject — a read of the root', async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, 'a.txt'), 'hello world\nsecond line\nhello again')
      const { grep } = createFsTools()
      const policy = scriptedPolicy('allow')
      const r = await runTool(grep, { pattern: 'hello' }, scope(dir), { policy, ...deps() })
      expect(r.status).toBe('completed')
      const result = r.outcome.result as FsGrepResult
      expect(result.matches.map(m => m.line)).toEqual([1, 3])
      expect(result.matches[0]?.path).toBe('a.txt')

      const root = await realpath(dir)
      expect(policy.seen).toHaveLength(1)
      expect(policy.seen[0]?.subjects).toEqual([{ action: 'read', path: root }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('caseInsensitive and context lines', async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, 'a.txt'), 'one\nNEEDLE\nthree')
      const { grep } = createFsTools()
      const r = await runTool(
        grep,
        { pattern: 'needle', caseInsensitive: true, contextLines: 1 },
        scope(dir),
        { policy: scriptedPolicy('allow'), ...deps() }
      )
      const result = r.outcome.result as FsGrepResult
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]?.before).toEqual(['one'])
      expect(result.matches[0]?.after).toEqual(['three'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('truncation states the true totals — matching keeps counting past maxMatches', async () => {
    const dir = await tempDir()
    try {
      const lines = Array.from({ length: 10 }, (_, i) => `match ${i}`).join('\n')
      await writeFile(join(dir, 'a.txt'), lines)
      const { grep } = createFsTools({ grepMaxMatchesDefault: 3 })
      const r = await runTool(grep, { pattern: 'match' }, scope(dir), { policy: scriptedPolicy('allow'), ...deps() })
      const result = r.outcome.result as FsGrepResult
      expect(result.matchesShown).toBe(3)
      expect(result.matchesTotal).toBe(10)
      expect(result.matchesTotalExact).toBe(true)
      expect(result.truncated).toBe(true)
      expect(r.outcome.modelText).toContain('3 of 10')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('binary files are skipped and counted, never scanned for matches', async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, 'text.txt'), 'needle here')
      await writeFile(join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]))
      const { grep } = createFsTools()
      const r = await runTool(grep, { pattern: 'needle' }, scope(dir), { policy: scriptedPolicy('allow'), ...deps() })
      const result = r.outcome.result as FsGrepResult
      expect(result.filesSkippedBinary).toBe(1)
      expect(result.matches.map(m => m.path)).toEqual(['text.txt'])
      expect(r.outcome.modelText).toContain('1 binary file(s) skipped')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('files over the size cap are skipped and counted', async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, 'big.txt'), 'needle '.repeat(100))
      await writeFile(join(dir, 'small.txt'), 'needle')
      const { grep } = createFsTools({ grepMaxFileBytes: 10 })
      const r = await runTool(grep, { pattern: 'needle' }, scope(dir), { policy: scriptedPolicy('allow'), ...deps() })
      const result = r.outcome.result as FsGrepResult
      expect(result.filesSkippedTooLarge).toBe(1)
      expect(result.matches.map(m => m.path)).toEqual(['small.txt'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('an invalid regex is refused as invalid-input and never reaches the policy', async () => {
    const dir = await tempDir()
    try {
      const { grep } = createFsTools()
      const policy = scriptedPolicy('allow')
      const r = await runTool(grep, { pattern: '(unclosed' }, scope(dir), { policy, ...deps() })
      expect(r.outcome.ok).toBe(false)
      expect(r.outcome.error?.class).toBe('invalid-input')
      expect(policy.seen).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a long line is truncated with a marker before both matching and display', async () => {
    const dir = await tempDir()
    try {
      const long = `needle ${'x'.repeat(1000)}`
      await writeFile(join(dir, 'a.txt'), long)
      const { grep } = createFsTools({ grepMaxLineLength: 50 })
      const r = await runTool(grep, { pattern: 'needle' }, scope(dir), { policy: scriptedPolicy('allow'), ...deps() })
      const result = r.outcome.result as FsGrepResult
      expect(result.matches).toHaveLength(1)
      const text = result.matches[0]?.text ?? ''
      expect(text.length).toBeLessThanOrEqual(100)
      expect(text).toContain('truncated')
      expect(text.startsWith('needle')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a gitignored file is absent from the results inside a repo', async () => {
    const dir = await tempDir()
    try {
      git(dir, ['init', '-q'])
      await writeFile(join(dir, '.gitignore'), 'ignored.txt\n')
      await writeFile(join(dir, 'ignored.txt'), 'needle')
      await writeFile(join(dir, 'kept.txt'), 'needle')
      git(dir, ['add', '.gitignore', 'kept.txt'])
      const { grep } = createFsTools()
      const r = await runTool(grep, { pattern: 'needle' }, scope(dir), { policy: scriptedPolicy('allow'), ...deps() })
      const result = r.outcome.result as FsGrepResult
      expect(result.gitignoreAware).toBe(true)
      expect(result.matches.map(m => m.path)).toEqual(['kept.txt'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a symlinked directory escaping root is not followed or searched', async () => {
    const dir = await tempDir()
    const outside = await tempDir('agentistics-fs-grep-outside-')
    try {
      await writeFile(join(outside, 'secret.txt'), 'needle')
      await symlink(outside, join(dir, 'escape'), 'dir')
      await writeFile(join(dir, 'inside.txt'), 'needle')
      const { grep } = createFsTools()
      const r = await runTool(grep, { pattern: 'needle' }, scope(dir), { policy: scriptedPolicy('allow'), ...deps() })
      const result = r.outcome.result as FsGrepResult
      expect(result.matches.map(m => m.path)).toEqual(['inside.txt'])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('a root that does not exist is refused as not-found', async () => {
    const dir = await tempDir()
    try {
      const { grep } = createFsTools()
      const r = await runTool(grep, { pattern: 'x', root: join(dir, 'nope') }, scope(dir), {
        policy: scriptedPolicy('allow'),
        ...deps(),
      })
      expect(r.outcome.ok).toBe(false)
      expect(r.outcome.error?.class).toBe('not-found')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a glob filter restricts the searched candidate set', async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, 'a.ts'), 'needle')
      await writeFile(join(dir, 'a.md'), 'needle')
      const { grep } = createFsTools()
      const r = await runTool(grep, { pattern: 'needle', glob: '*.ts' }, scope(dir), {
        policy: scriptedPolicy('allow'),
        ...deps(),
      })
      const result = r.outcome.result as FsGrepResult
      expect(result.matches.map(m => m.path)).toEqual(['a.ts'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

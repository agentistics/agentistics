import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTool } from '../gate.ts'
import { memoryContent, recordingEvents, scriptedPolicy } from '../testing.ts'
import type { FsGlobResult } from './glob.ts'
import { createFsTools } from './index.ts'
import { gitTestEnv } from '../../../test/git-test-env.ts'

async function tempDir(prefix = 'agentistics-fs-glob-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: gitTestEnv() })
}

function scope(dir: string) {
  return { workspaceRoot: dir, cwd: dir, signal: new AbortController().signal }
}

const deps = () => ({ events: recordingEvents(), content: memoryContent() })

describe('fs.glob', () => {
  test('denied: no matches returned, the model gets the refusal sentence', async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, 'a.ts'), '1')
      const { glob } = createFsTools()
      const r = await runTool(glob, { pattern: '*.ts' }, scope(dir), { policy: scriptedPolicy('deny'), ...deps() })
      expect(r.status).toBe('denied')
      expect(r.outcome.ok).toBe(false)
      expect(r.outcome.modelText).toBe('Refused by the test policy.')
      expect(r.outcome.result).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('allowed: returns matches, and the policy saw exactly one subject — a read of the root', async () => {
    const dir = await tempDir()
    try {
      await mkdir(join(dir, 'src'), { recursive: true })
      await writeFile(join(dir, 'src', 'a.ts'), '1')
      await writeFile(join(dir, 'README.md'), '1')
      const { glob } = createFsTools()
      const policy = scriptedPolicy('allow')
      const r = await runTool(glob, { pattern: '**/*.ts' }, scope(dir), { policy, ...deps() })
      expect(r.status).toBe('completed')
      const result = r.outcome.result as FsGlobResult
      expect(result.matches).toEqual(['src/a.ts'])

      const root = await realpath(dir)
      expect(policy.seen).toHaveLength(1)
      expect(policy.seen[0]?.subjects).toEqual([{ action: 'read', path: root }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('truncation states the true totals', async () => {
    const dir = await tempDir()
    try {
      for (let i = 0; i < 5; i++) await writeFile(join(dir, `f${i}.txt`), 'x')
      const { glob } = createFsTools()
      const r = await runTool(glob, { pattern: '*.txt', maxResults: 2 }, scope(dir), {
        policy: scriptedPolicy('allow'),
        ...deps(),
      })
      const result = r.outcome.result as FsGlobResult
      expect(result.shown).toBe(2)
      expect(result.totalMatched).toBe(5)
      expect(result.truncated).toBe(true)
      expect(r.outcome.modelText).toContain('2 of 5')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('maxResults is clamped to the hard cap', async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, 'a.txt'), 'x')
      const { glob } = createFsTools({ globMaxResultsHardCap: 1 })
      const r = await runTool(glob, { pattern: '*.txt', maxResults: 999 }, scope(dir), {
        policy: scriptedPolicy('allow'),
        ...deps(),
      })
      const result = r.outcome.result as FsGlobResult
      expect(result.shown).toBeLessThanOrEqual(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a gitignored file is absent from the results inside a repo', async () => {
    const dir = await tempDir()
    try {
      git(dir, ['init', '-q'])
      await writeFile(join(dir, '.gitignore'), 'ignored.md\n')
      await writeFile(join(dir, 'ignored.md'), 'x')
      await writeFile(join(dir, 'kept.md'), 'y')
      git(dir, ['add', '.gitignore', 'kept.md'])
      const { glob } = createFsTools()
      const r = await runTool(glob, { pattern: '*.md' }, scope(dir), { policy: scriptedPolicy('allow'), ...deps() })
      const result = r.outcome.result as FsGlobResult
      expect(result.gitignoreAware).toBe(true)
      expect(result.matches).toEqual(['kept.md'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a symlinked directory escaping root is not followed or returned', async () => {
    const dir = await tempDir()
    const outside = await tempDir('agentistics-fs-glob-outside-')
    try {
      await writeFile(join(outside, 'secret.ts'), 'x')
      await symlink(outside, join(dir, 'escape'), 'dir')
      await writeFile(join(dir, 'inside.ts'), 'y')
      const { glob } = createFsTools()
      const r = await runTool(glob, { pattern: '**/*.ts' }, scope(dir), {
        policy: scriptedPolicy('allow'),
        ...deps(),
      })
      const result = r.outcome.result as FsGlobResult
      expect(result.matches).toEqual(['inside.ts'])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('a root that does not exist is refused as not-found', async () => {
    const dir = await tempDir()
    try {
      const { glob } = createFsTools()
      const r = await runTool(glob, { pattern: '*', root: join(dir, 'nope') }, scope(dir), {
        policy: scriptedPolicy('allow'),
        ...deps(),
      })
      expect(r.outcome.ok).toBe(false)
      expect(r.outcome.error?.class).toBe('not-found')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('an invalid input never reaches the policy', async () => {
    const dir = await tempDir()
    try {
      const { glob } = createFsTools()
      const policy = scriptedPolicy('allow')
      const r = await runTool(glob, { maxResults: 'nope' }, scope(dir), { policy, ...deps() })
      expect(r.outcome.error?.class).toBe('invalid-input')
      expect(policy.seen).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

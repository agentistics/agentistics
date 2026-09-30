import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listCandidates } from './candidates.ts'
import { gitTestEnv } from '../../../test/git-test-env.ts'

async function tempDir(prefix = 'agentistics-fs-cand-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: gitTestEnv() })
}

describe('listCandidates', () => {
  test('outside a git repository: walks the tree, skips .git and node_modules, and says it is not gitignore-aware', async () => {
    const dir = await tempDir()
    try {
      await mkdir(join(dir, 'node_modules', 'x'), { recursive: true })
      await writeFile(join(dir, 'node_modules', 'x', 'ignored.js'), '1')
      await mkdir(join(dir, '.git'), { recursive: true })
      await writeFile(join(dir, '.git', 'ignored'), '1')
      await mkdir(join(dir, 'src'), { recursive: true })
      await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1')
      await writeFile(join(dir, 'README.md'), '# hi')

      const result = await listCandidates(dir)
      expect(result.gitignoreAware).toBe(false)
      expect(result.files).toEqual(['README.md', 'src/a.ts'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('inside a git repository: tracked + untracked files listed, .gitignore honoured', async () => {
    const dir = await tempDir()
    try {
      git(dir, ['init', '-q'])
      await writeFile(join(dir, '.gitignore'), 'ignored.txt\n')
      await writeFile(join(dir, 'tracked.txt'), 'a')
      await writeFile(join(dir, 'untracked.txt'), 'b')
      await writeFile(join(dir, 'ignored.txt'), 'c')
      git(dir, ['add', '.gitignore', 'tracked.txt'])

      const result = await listCandidates(dir)
      expect(result.gitignoreAware).toBe(true)
      expect(result.files).toEqual(['.gitignore', 'tracked.txt', 'untracked.txt'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a symlinked directory pointing outside root is not followed, and its files are not returned', async () => {
    const dir = await tempDir()
    const outside = await tempDir('agentistics-fs-cand-outside-')
    try {
      await writeFile(join(outside, 'secret.txt'), 'nope')
      await symlink(outside, join(dir, 'escape'), 'dir')
      await writeFile(join(dir, 'inside.txt'), 'yes')

      const result = await listCandidates(dir)
      expect(result.files).toEqual(['inside.txt'])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('a symlinked file pointing outside root is not returned', async () => {
    const dir = await tempDir()
    const outside = await tempDir('agentistics-fs-cand-outside-')
    try {
      const secretPath = join(outside, 'secret.txt')
      await writeFile(secretPath, 'nope')
      await symlink(secretPath, join(dir, 'link.txt'))
      await writeFile(join(dir, 'inside.txt'), 'yes')

      const result = await listCandidates(dir)
      expect(result.files).toEqual(['inside.txt'])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('a symlinked directory pointing OUTSIDE root, inside a git repo, is still excluded even if git-tracked', async () => {
    const dir = await tempDir()
    const outside = await tempDir('agentistics-fs-cand-outside-')
    try {
      git(dir, ['init', '-q'])
      await writeFile(join(outside, 'secret.txt'), 'nope')
      await symlink(outside, join(dir, 'escape'), 'dir')
      await writeFile(join(dir, 'inside.txt'), 'yes')
      // `git add -A` stages the symlink itself as a tracked path named "escape".
      git(dir, ['add', '-A'])

      const result = await listCandidates(dir)
      expect(result.gitignoreAware).toBe(true)
      expect(result.files).toEqual(['inside.txt'])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, open, readFile, readlink, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { __setClaudeTrustFsForTest, ensureClaudeProjectTrusted } from './claude-trust'

describe('ensureClaudeProjectTrusted', () => {
  test('writes the trust entry for a managed account root and cwd', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const cwd = join(root, 'worktree')

    try {
      await ensureClaudeProjectTrusted(root, cwd)

      const config = JSON.parse(await readFile(join(root, '.claude.json'), 'utf8'))
      expect(config.projects[cwd].hasTrustDialogAccepted).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves existing account data and file mode', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const cwd = join(root, 'worktree')
    const original = { oauthAccount: { email: 'account@example.invalid', organizationUuid: 'org-1' }, projects: {} }
    try {
      await writeFile(join(root, '.claude.json'), `${JSON.stringify(original)}\n`, { mode: 0o640 })
      await chmod(join(root, '.claude.json'), 0o640)
      await ensureClaudeProjectTrusted(root, cwd)

      const config = JSON.parse(await readFile(join(root, '.claude.json'), 'utf8'))
      expect(config.oauthAccount).toEqual(original.oauthAccount)
      expect(config.projects[cwd].hasTrustDialogAccepted).toBe(true)
      expect((await stat(join(root, '.claude.json'))).mode & 0o777).toBe(0o640)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('leaves a corrupt config untouched and does not fail the spawn preparation', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const corrupt = '{"oauthAccount":'
    try {
      await writeFile(file, corrupt)
      await expect(ensureClaudeProjectTrusted(root, join(root, 'worktree'))).resolves.toBeUndefined()
      expect(await readFile(file, 'utf8')).toBe(corrupt)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('serializes concurrent roots and keeps every trust entry', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    try {
      await Promise.all(Array.from({ length: 20 }, (_, i) => ensureClaudeProjectTrusted(root, join(root, `worktree-${i}`))))
      const config = JSON.parse(await readFile(join(root, '.claude.json'), 'utf8'))
      expect(Object.keys(config.projects)).toHaveLength(20)
      expect(Object.values(config.projects).every(project => (
        typeof project === 'object' && project !== null
        && (project as { hasTrustDialogAccepted?: boolean }).hasTrustDialogAccepted === true
      ))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('writes through a symlink without replacing it', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const target = join(root, 'real.json')
    const link = join(root, '.claude.json')
    const cwd = join(root, 'worktree')
    try {
      await writeFile(target, '{}\n')
      await symlink(target, link)
      await ensureClaudeProjectTrusted(root, cwd)
      expect(await readlink(link)).toBe(target)
      const config = JSON.parse(await readFile(target, 'utf8'))
      expect(config.projects[cwd].hasTrustDialogAccepted).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not remove another process lock after a non-contention open error', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const lock = `${file}.lock`
    try {
      await writeFile(lock, 'held')
      __setClaudeTrustFsForTest({
        open: async (...args) => {
          if (args[0] === lock) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' })
          return open(...args)
        },
      })
      await expect(ensureClaudeProjectTrusted(root, join(root, 'worktree'))).resolves.toBeUndefined()
      expect(await readFile(lock, 'utf8')).toBe('held')
    } finally {
      __setClaudeTrustFsForTest(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reclaims stale locks by renaming them before retrying', async () => {
    const root = await mkdtemp('/tmp/agentop-claude-trust-')
    const file = join(root, '.claude.json')
    const lock = `${file}.lock`
    try {
      await writeFile(lock, 'stale')
      const old = new Date(Date.now() - 60_000)
      await utimes(lock, old, old)
      await ensureClaudeProjectTrusted(root, join(root, 'worktree'))
      expect(await readFile(join(root, '.claude.json'), 'utf8')).toContain('hasTrustDialogAccepted')
      await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      __setClaudeTrustFsForTest(null)
      await rm(root, { recursive: true, force: true })
    }
  })
})

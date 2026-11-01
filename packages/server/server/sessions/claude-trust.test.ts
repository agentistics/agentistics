import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureClaudeProjectTrusted } from './claude-trust'

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
})

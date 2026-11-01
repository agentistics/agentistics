import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
})

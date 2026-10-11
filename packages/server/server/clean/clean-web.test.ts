import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processIn } from './clean-web'

const fixtures: string[] = []
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }) })

describe('clean process safety guard', () => {
  test('skips a worktree while a child process has its cwd inside it', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'clean-process-'))
    fixtures.push(fixture)
    mkdirSync(join(fixture, 'worktree'))
    const child = Bun.spawn(['sleep', '5'], { cwd: join(fixture, 'worktree') })
    try {
      expect(await processIn(join(fixture, 'worktree'))).toBe(true)
    } finally {
      child.kill()
      await child.exited
    }
  })
})

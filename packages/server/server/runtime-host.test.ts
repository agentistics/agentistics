/**
 * runtime-host.test.ts — the host seam's floor: every credential file the backup plan knows about is
 * refused by a native session's policy, and a relocated data dir is passed on.
 */
import { describe, expect, test } from 'bun:test'
import { globMatches } from '@agentistics/runtime'
import { omittedSecrets } from './backup/backup-plan'
import { hostPolicy, hostProtectedPaths, protectedPathsFromSecrets } from './runtime-host'

const env = { home: '/home/u', workspaceRoot: '/home/u/work/repo' }
const floored = (globs: readonly string[], path: string) => globs.some(g => globMatches(g, path, env))

describe('protectedPathsFromSecrets', () => {
  const globs = hostProtectedPaths()

  test('every non-agentistics secret row lands on the floor', () => {
    const rows = omittedSecrets().filter(r => !r.pattern.startsWith('.agentistics'))
    expect(rows.length).toBeGreaterThan(5)
    for (const r of rows) {
      const p = r.pattern.split('#')[0]!
      // A `contains` rule with no directory is checked where it actually lives: under a harness home.
      const sample = r.match === 'contains' && !p.includes('/') ? `/home/u/.claude/sessions/1${p}` : `/home/u/${p}`
      expect({ row: r.pattern, floored: floored(globs, sample) }).toEqual({ row: r.pattern, floored: true })
    }
  })

  test('the named harness credential files, spelled out', () => {
    for (const p of ['.claude/.credentials.json', '.codex/auth.json', '.gemini/oauth_creds.json', '.kimi-code/config.toml']) {
      expect(floored(globs, `/home/u/${p}`)).toBe(true)
    }
    expect(floored(globs, '/home/u/.copilot/tokens/abc')).toBe(true)
  })

  test('a workspace file that merely contains `.key` is NOT floored', () => {
    expect(floored(globs, '/home/u/work/repo/src/hotkey.keymap.ts')).toBe(false)
    expect(floored(globs, '/home/u/work/repo/README.md')).toBe(false)
  })

  test('only secret rows count, and the output is sorted and deduplicated', () => {
    const out = protectedPathsFromSecrets([
      { pattern: '.x/a', match: 'prefix', reason: 'regenerable', why: '' },
      { pattern: '.y/b', match: 'prefix', reason: 'secret', why: '' },
      { pattern: '.y/b', match: 'prefix', reason: 'secret', why: '' },
    ])
    expect(out).toEqual(['~/.y/b', '~/.y/b*', '~/.y/b*/**'])
  })
})

describe('hostPolicy', () => {
  test('a relocated data dir is floored; the default location still is', async () => {
    const p = hostPolicy({ home: '/home/u', dataDir: '/srv/agt', defaultDataDir: '/home/u/.agentistics', protectedPaths: [] })
    const ask = (path: string) => p.evaluate({
      call: { toolExecutionId: 'tx_1', toolName: 'file.read' }, kind: 'file' as const, permission: 'auto' as const,
      subjects: [{ action: 'read' as const, path }], workspaceRoot: '/home/u/work/repo',
    })
    expect((await ask('/srv/agt/provider-keys/anthropic.json')).decision).toBe('deny')
    expect((await ask('/home/u/.agentistics/provider-keys/anthropic.json')).decision).toBe('deny')
    expect((await ask('/home/u/work/repo/README.md')).decision).toBe('allow')
  })
})
